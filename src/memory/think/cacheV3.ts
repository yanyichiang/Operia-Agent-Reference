import { pruneMessages, type ModelMessage, type SystemModelMessage, type ToolSet } from "ai";

export type CacheV3Env = {
  ANTHROPIC_CACHE_ENABLED?: string;
  MEMORY_THINK_CACHE_V3_MODE?: string;
  MEMORY_THINK_CACHE_V3_TTL?: string;
  MEMORY_THINK_CACHE_V3_COHORT_PERCENT?: string;
  MEMORY_THINK_CONTEXT_EDIT_ENABLED?: string;
  MEMORY_THINK_CONTEXT_EDIT_TRIGGER_INPUT_TOKENS?: string;
  MEMORY_THINK_CONTEXT_EDIT_KEEP_TOOL_USES?: string;
  MEMORY_THINK_CONTEXT_EDIT_CLEAR_AT_LEAST_TOKENS?: string;
  MEMORY_THINK_LOCAL_PRUNE_ENABLED?: string;
  MEMORY_THINK_LOCAL_PRUNE_TRIGGER_INPUT_TOKENS?: string;
};

export type CacheV3Mode = "explicit_v2" | "automatic_v3";
export type CacheV3Strategy = CacheV3Mode | "anchored_v3";

const CACHE_BREAKPOINT_LIMIT = 4;
const DEFAULT_CONTEXT_EDIT_EXCLUSIONS = [
  "approval_probe",
  "tool_action",
  "execute_codemode",
  "begin_final_response",
] as const;

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export async function selectCacheV3Mode(env: CacheV3Env, ownerId: string): Promise<CacheV3Mode> {
  if (env.ANTHROPIC_CACHE_ENABLED === "false" || env.MEMORY_THINK_CACHE_V3_MODE !== "automatic_v3") {
    return "explicit_v2";
  }
  const percent = boundedInteger(env.MEMORY_THINK_CACHE_V3_COHORT_PERCENT, 0, 0, 100);
  if (percent === 100) return "automatic_v3";
  if (percent === 0) return "explicit_v2";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cache-v3:${ownerId}`)));
  const bucket = (((digest[0] ?? 0) << 8) | (digest[1] ?? 0)) % 100;
  return bucket < percent ? "automatic_v3" : "explicit_v2";
}

export function configuredCacheV3Strategy(env: CacheV3Env): CacheV3Strategy {
  if (env.MEMORY_THINK_CACHE_V3_MODE === "anchored_v3") return "anchored_v3";
  if (env.MEMORY_THINK_CACHE_V3_MODE === "automatic_v3") return "automatic_v3";
  return "explicit_v2";
}

function withoutAnthropicCacheControl(providerOptions: unknown): unknown {
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) return providerOptions;
  const root = { ...(providerOptions as Record<string, unknown>) };
  const anthropic = root.anthropic;
  if (!anthropic || typeof anthropic !== "object" || Array.isArray(anthropic)) return root;
  const nextAnthropic = { ...(anthropic as Record<string, unknown>) };
  delete nextAnthropic.cacheControl;
  delete nextAnthropic.cache_control;
  if (Object.keys(nextAnthropic).length === 0) delete root.anthropic;
  else root.anthropic = nextAnthropic;
  return Object.keys(root).length === 0 ? undefined : root;
}

function stripCacheControlFromValue<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!("providerOptions" in record) && !("provider_options" in record) && !("cache_control" in record)) return value;
  const clone: Record<string, unknown> = { ...record };
  if ("providerOptions" in clone) clone.providerOptions = withoutAnthropicCacheControl(clone.providerOptions);
  if ("provider_options" in clone) clone.provider_options = withoutAnthropicCacheControl(clone.provider_options);
  delete clone.cache_control;
  if (clone.providerOptions === undefined) delete clone.providerOptions;
  if (clone.provider_options === undefined) delete clone.provider_options;
  return clone as T;
}

export function stripExplicitCacheFromInstructions(instructions: SystemModelMessage[]): SystemModelMessage[] {
  return instructions.map((message) => stripCacheControlFromValue(message));
}

export function stripExplicitCacheFromMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    const clean = stripCacheControlFromValue(message);
    if (typeof clean.content === "string") return clean;
    return { ...clean, content: clean.content.map((part) => stripCacheControlFromValue(part)) } as ModelMessage;
  });
}

export function stripExplicitCacheFromTools(tools: ToolSet): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => [
    name,
    stripCacheControlFromValue(definition),
  ])) as ToolSet;
}

function directCacheMarkerTtl(value: unknown): "5m" | "1h" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const direct = record.cache_control;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return (direct as Record<string, unknown>).ttl === "1h" ? "1h" : "5m";
  }
  const providerOptions = record.providerOptions ?? record.provider_options;
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) return null;
  const anthropic = (providerOptions as Record<string, unknown>).anthropic;
  if (!anthropic || typeof anthropic !== "object" || Array.isArray(anthropic)) return null;
  const options = anthropic as Record<string, unknown>;
  const cacheControl = options.cacheControl ?? options.cache_control;
  if (!cacheControl || typeof cacheControl !== "object" || Array.isArray(cacheControl)) return null;
  return (cacheControl as Record<string, unknown>).ttl === "1h" ? "1h" : "5m";
}

function hasDirectCacheMarker(value: unknown): boolean {
  return directCacheMarkerTtl(value) !== null;
}

function countMessageMarkers(messages: ReadonlyArray<SystemModelMessage | ModelMessage>): number {
  let count = 0;
  for (const message of messages) {
    if (hasDirectCacheMarker(message)) count += 1;
    if (typeof message.content === "string") continue;
    for (const part of message.content) if (hasDirectCacheMarker(part)) count += 1;
  }
  return count;
}

function orderedMessageMarkerTtls(
  messages: ReadonlyArray<SystemModelMessage | ModelMessage>,
): Array<"5m" | "1h"> {
  const ttls: Array<"5m" | "1h"> = [];
  for (const message of messages) {
    const messageTtl = directCacheMarkerTtl(message);
    if (messageTtl) ttls.push(messageTtl);
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      const partTtl = directCacheMarkerTtl(part);
      if (partTtl) ttls.push(partTtl);
    }
  }
  return ttls;
}

function assertCacheTtlOrder(ttls: ReadonlyArray<"5m" | "1h">): void {
  let sawShortTtl = false;
  for (const ttl of ttls) {
    if (ttl === "5m") sawShortTtl = true;
    else if (sawShortTtl) throw new Error("operia_cache_ttl_order_invalid");
  }
}

export function assertCacheBreakpointBudget(input: {
  instructions: SystemModelMessage[];
  messages: ModelMessage[];
  tools: ToolSet;
  automatic: boolean;
  automaticTtl?: "5m" | "1h";
}): number {
  const explicit = countMessageMarkers(input.instructions) + countMessageMarkers(input.messages)
    + Object.values(input.tools).reduce((sum, definition) => sum + (hasDirectCacheMarker(definition) ? 1 : 0), 0);
  const total = explicit + (input.automatic ? 1 : 0);
  if (total > CACHE_BREAKPOINT_LIMIT) throw new Error("operia_cache_breakpoint_budget_exceeded");
  const orderedTtls = [
    ...Object.values(input.tools).flatMap((definition) => {
      const ttl = directCacheMarkerTtl(definition);
      return ttl ? [ttl] : [];
    }),
    ...orderedMessageMarkerTtls(input.instructions),
    ...orderedMessageMarkerTtls(input.messages),
    ...(input.automatic ? [input.automaticTtl ?? "5m" as const] : []),
  ];
  assertCacheTtlOrder(orderedTtls);
  return total;
}

export async function prepareCacheV3Input(env: CacheV3Env, ownerId: string, input: {
  instructions: SystemModelMessage[];
  messages: ModelMessage[];
  tools: ToolSet;
}): Promise<{
  strategy: CacheV3Strategy;
  mode: CacheV3Mode;
  instructions: SystemModelMessage[];
  messages: ModelMessage[];
  tools: ToolSet;
  automatic: boolean;
  breakpoints: number;
}> {
  const strategy = configuredCacheV3Strategy(env);
  const cacheEnabled = env.ANTHROPIC_CACHE_ENABLED !== "false";
  const mode = await selectCacheV3Mode(env, ownerId);

  let instructions = input.instructions;
  let messages = input.messages;
  let tools = input.tools;
  let automatic = mode === "automatic_v3";

  if (!cacheEnabled) {
    instructions = stripExplicitCacheFromInstructions(instructions);
    messages = stripExplicitCacheFromMessages(messages);
    tools = stripExplicitCacheFromTools(tools);
    automatic = false;
  } else if (strategy === "automatic_v3" && automatic) {
    // Retain the old pure-automatic experiment for an explicit rollback/research
    // cohort. It is not the production V3 strategy because a moving tail can
    // repeatedly create a new full-prefix cache entry.
    instructions = stripExplicitCacheFromInstructions(instructions);
    messages = stripExplicitCacheFromMessages(messages);
    tools = stripExplicitCacheFromTools(tools);
  } else if (strategy === "anchored_v3") {
    // Anthropic prefix order is tools -> system -> messages. The assembler's
    // stable system anchor therefore already covers the tool definitions. Keep
    // the system and canonical-history tail markers, but remove the
    // redundant tool-definition marker to preserve one cache slot.
    tools = stripExplicitCacheFromTools(tools);
  }

  const breakpoints = assertCacheBreakpointBudget({
    instructions,
    messages,
    tools,
    automatic,
    automaticTtl: env.MEMORY_THINK_CACHE_V3_TTL === "5m" ? "5m" : "1h",
  });
  if (cacheEnabled && strategy === "anchored_v3") {
    const instructionMarkers = countMessageMarkers(instructions);
    const messageMarkers = countMessageMarkers(messages);
    const toolMarkers = Object.values(tools)
      .reduce((sum, definition) => sum + (hasDirectCacheMarker(definition) ? 1 : 0), 0);
    if (instructionMarkers !== 1) throw new Error("operia_cache_anchored_system_marker_invalid");
    if (messageMarkers > 2) throw new Error("operia_cache_anchored_history_markers_invalid");
    if (toolMarkers !== 0) throw new Error("operia_cache_anchored_tool_marker_present");
  }

  return { strategy, mode, instructions, messages, tools, automatic, breakpoints };
}

export function cacheV3ProviderOptions(env: CacheV3Env, input: {
  mode: CacheV3Mode;
  contextEditEligible: boolean;
}): Record<string, unknown> | undefined {
  const anthropic: Record<string, unknown> = {};
  if (input.mode === "automatic_v3") {
    anthropic.cacheControl = {
      type: "ephemeral",
      ttl: env.MEMORY_THINK_CACHE_V3_TTL === "5m" ? "5m" : "1h",
    };
  }
  if (input.contextEditEligible && enabled(env.MEMORY_THINK_CONTEXT_EDIT_ENABLED)) {
    anthropic.contextManagement = {
      edits: [{
        type: "clear_tool_uses_20250919",
        trigger: {
          type: "input_tokens",
          value: boundedInteger(env.MEMORY_THINK_CONTEXT_EDIT_TRIGGER_INPUT_TOKENS, 32_000, 8_000, 200_000),
        },
        keep: {
          type: "tool_uses",
          value: boundedInteger(env.MEMORY_THINK_CONTEXT_EDIT_KEEP_TOOL_USES, 3, 1, 20),
        },
        clearAtLeast: {
          type: "input_tokens",
          value: boundedInteger(env.MEMORY_THINK_CONTEXT_EDIT_CLEAR_AT_LEAST_TOKENS, 8_000, 1_000, 100_000),
        },
        clearToolInputs: true,
        excludeTools: [...DEFAULT_CONTEXT_EDIT_EXCLUSIONS],
      }],
    };
  }
  return Object.keys(anthropic).length > 0 ? { anthropic } : undefined;
}

function unsettledPair(messages: ModelMessage[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  const approvalRequests = new Set<string>();
  const approvalResponses = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.add(part.toolCallId);
      else if (part.type === "tool-result") results.add(part.toolCallId);
      else if (part.type === "tool-approval-request") approvalRequests.add(part.approvalId);
      else if (part.type === "tool-approval-response") approvalResponses.add(part.approvalId);
    }
  }
  return [...calls].some((id) => !results.has(id)) || [...approvalRequests].some((id) => !approvalResponses.has(id));
}

export function maybePruneCacheV3Messages(env: CacheV3Env, input: {
  messages: ModelMessage[];
  previousInputTokens: number;
  eligible: boolean;
}): { messages: ModelMessage[]; applied: boolean; reason: string } {
  if (!input.eligible || !enabled(env.MEMORY_THINK_LOCAL_PRUNE_ENABLED)) {
    return { messages: input.messages, applied: false, reason: "disabled" };
  }
  const trigger = boundedInteger(env.MEMORY_THINK_LOCAL_PRUNE_TRIGGER_INPUT_TOKENS, 64_000, 16_000, 400_000);
  if (input.previousInputTokens < trigger) return { messages: input.messages, applied: false, reason: "below_threshold" };
  if (unsettledPair(input.messages)) return { messages: input.messages, applied: false, reason: "active_pair" };
  return {
    messages: pruneMessages({
      messages: input.messages,
      reasoning: "none",
      toolCalls: "before-last-4-messages",
      emptyMessages: "remove",
    }),
    applied: true,
    reason: "emergency_threshold",
  };
}

export function contextEditExclusions(): readonly string[] {
  return DEFAULT_CONTEXT_EDIT_EXCLUSIONS;
}
