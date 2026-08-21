import { buildStableMemoryPack } from "../memory/stablePack";
import type { AssembledPrompt } from "../assembler/types";
import {
  assembledToAnthropicMessages,
  assembledToAnthropicSystem,
  applyMessageCacheBreakpoints,
  openAIToolsToAnthropic,
  openAIToolChoiceToAnthropic,
  isForcedToolChoice,
  anthropicToolUseBlocksToOpenAI,
  safeParseJSON,
  stableStringify,
  type AnthropicMessageWireMapping,
  type AnthropicTextBlock,
  type AnthropicWireMessage,
  type AnthropicTool,
  type AnthropicToolChoice,
  type AnthropicToolUseBlock,
  type AnthropicContentBlock,
} from "../assembler/toAnthropic";
import type { Env, OpenAIChatMessage, OpenAIChatRequest, OpenAIChatResponse, TokenUsage } from "../types";
import type { BootPackage } from "../memory/v2/recall";
import { formatBootStable } from "../assembler/types";
import { normalizeAiGatewayBaseUrl } from "./openaiAdapter";
import type { ExactMemoryDispatchGuard } from "../memory/vnext/recallRuntime";

// ---------------------------------------------------------------------------
// Anthropic wire types (request-level)
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
  thinking?: {
    type: "enabled" | "adaptive";
    budget_tokens?: number;
    display?: "summarized" | "omitted";
  };
  output_config?: { effort: "low" | "medium" | "high" | "max" };
  system: AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: { user_id: string };
}

interface AnthropicResponse {
  id?: string;
  model?: string;
  role?: string;
  content?: Array<{
    type?: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  stop_reason?: string | null;
  usage?: TokenUsage;
}

export type AnthropicTransport = "default" | "unified-probe" | "gateway";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentToText(content: OpenAIChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}

function stripAnthropicProviderPrefix(model: string): string {
  return model.replace(/^anthropic\//i, "");
}

function normalizeAnthropicModelAlias(model: string): string {
  return model.replace(/^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)(.*)$/i, "claude-$1-$2-$3$4");
}

function parseCustomProviderModel(model: string): { slug: string; model: string } | null {
  const match = model.match(/^custom-([a-z0-9-]+)\/(.+)$/i);
  if (!match) return null;
  return { slug: match[1], model: match[2] };
}

export function stripAnthropicModelPrefix(model: string): string {
  return normalizeAnthropicModelAlias(parseCustomProviderModel(model)?.model || stripAnthropicProviderPrefix(model));
}

function getCustomAnthropicMessagesPath(env: Env): string {
  return (env.CUSTOM_ANTHROPIC_MESSAGES_PATH || "messages").replace(/^\/+/, "");
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

type CacheTier = "stable" | "conversation";

function normalizeCacheTtl(value: string | undefined): "5m" | "1h" {
  return value === "1h" ? "1h" : "5m";
}

export function getAnthropicCacheTtls(env: Env): { stable: "5m" | "1h"; conversation: "5m" | "1h" } {
  const legacy = normalizeCacheTtl(env.ANTHROPIC_CACHE_TTL);
  const configured = {
    stable: env.ANTHROPIC_CACHE_STABLE_TTL ? normalizeCacheTtl(env.ANTHROPIC_CACHE_STABLE_TTL) : legacy,
    conversation: env.ANTHROPIC_CACHE_CONVERSATION_TTL
      ? normalizeCacheTtl(env.ANTHROPIC_CACHE_CONVERSATION_TTL)
      : legacy,
  };
  if (configured.stable === "5m" && configured.conversation === "1h") {
    throw new Error("invalid_anthropic_cache_ttl_order");
  }
  return configured;
}

export function getAnthropicCacheTtlMode(env: Env): string {
  const ttl = getAnthropicCacheTtls(env);
  return ttl.stable === ttl.conversation ? ttl.stable : `stable:${ttl.stable},conversation:${ttl.conversation}`;
}

function buildCacheControl(env: Env, tier: CacheTier = "conversation"): { type: "ephemeral"; ttl?: "5m" | "1h" } | undefined {
  if (env.ANTHROPIC_CACHE_ENABLED === "false") return undefined;
  const ttl = getAnthropicCacheTtls(env)[tier];
  return ttl === "1h" ? { type: "ephemeral", ttl } : { type: "ephemeral" };
}

export function getAnthropicCacheMode(env: Env): string | null {
  if (env.ANTHROPIC_CACHE_ENABLED === "false") return null;
  const parts = ["anthropic", "explicit"];
  const ttl = getAnthropicCacheTtls(env);
  if (ttl.stable !== ttl.conversation) parts.push("mixed_ttl");
  // auto (top-level) is now off by default
  if (env.ANTHROPIC_AUTO_CACHE_ENABLED === "true") parts.push("auto");
  return parts.join("_");
}

/**
 * Apply explicit cache breakpoints from the assembler to system blocks
 * and wire messages.
 *
 * System breakpoint (history_read_anchor) is already applied by the
 * assembler via SystemBlock.cache_control. This function handles
 * message-level breakpoints (forward_write_anchor).
 */
function applyExplicitCacheBreakpoints(
  systemBlocks: AnthropicTextBlock[],
  wireMessages: AnthropicWireMessage[],
  indexMap: Map<number, AnthropicMessageWireMapping>,
  assembled: AssembledPrompt,
  env: Env
): void {
  const stableCacheControl = buildCacheControl(env, "stable");
  const conversationCacheControl = buildCacheControl(env, "conversation");
  if (!stableCacheControl || !conversationCacheControl) {
    // Cache disabled: strip all cache_control
    for (const b of systemBlocks) delete b.cache_control;
    return;
  }

  // Normalize TTL on system blocks that already have cache_control from assembler
  for (const b of systemBlocks) {
    if (b.cache_control) {
      b.cache_control = stableCacheControl;
    }
  }

  // Apply message-level breakpoints using the original→wire index mapping
  applyMessageCacheBreakpoints(wireMessages, assembled.meta.cache_breakpoints, indexMap, conversationCacheControl);
}

// ---------------------------------------------------------------------------
// Rolling cache (legacy, opt-in via ANTHROPIC_ROLLING_CACHE_ENABLED=true)
// ---------------------------------------------------------------------------

function getRollingCacheWindowSize(env: Env): number {
  const value = Number(env.ANTHROPIC_ROLLING_CACHE_WINDOW_SIZE || 20);
  if (!Number.isFinite(value)) return 20;
  return Math.max(Math.floor(value), 1);
}

function applyRollingMessageCache(messages: AnthropicWireMessage[], env: Env, systemBlocks?: AnthropicTextBlock[]): void {
  const cacheControl = buildCacheControl(env, "conversation");
  if (!cacheControl) return;
  if (env.ANTHROPIC_ROLLING_CACHE_ENABLED !== "true") return; // default off now

  const systemCacheCount = systemBlocks?.filter((block) => block.cache_control).length ?? 0;
  const maxMessageMarkers = Math.max(1, 4 - systemCacheCount);
  const userIndices: number[] = [];

  const isFullWindow = messages.length >= getRollingCacheWindowSize(env);
  const start = isFullWindow ? 0 : Math.max(0, messages.length - 1);
  for (let i = start; i < messages.length; i += 1) {
    if (messages[i].role === "user" && messages[i].content.length > 0) {
      userIndices.push(i);
    }
  }
  if (userIndices.length === 0) return;

  const last = userIndices[userIndices.length - 1];
  const lastBlock = messages[last].content[messages[last].content.length - 1];
  if (lastBlock.type === "text") lastBlock.cache_control = cacheControl;

  const remaining = Math.min(userIndices.length - 1, maxMessageMarkers - 1);
  for (let marker = 0; marker < remaining; marker += 1) {
    const idx = userIndices[Math.floor(marker * (userIndices.length - 1) / remaining)];
    const block = messages[idx].content[messages[idx].content.length - 1];
    if (block.type === "text") block.cache_control = cacheControl;
  }
}

// ---------------------------------------------------------------------------
// Thinking config (unchanged)
// ---------------------------------------------------------------------------

function getMaxTokens(req: OpenAIChatRequest): number {
  const value = typeof req.max_tokens === "number" ? req.max_tokens : 1024;
  return Math.max(Math.floor(value), 1);
}

function clampThinkingBudget(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return null;
  return Math.min(Math.max(Math.floor(numeric), 1024), 32000);
}

function getEnvThinkingBudget(env: Env): number {
  const value = clampThinkingBudget(env.ANTHROPIC_THINKING_BUDGET);
  return value ?? 1024;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disabled", "none"].includes(normalized)) return false;
  return null;
}

function budgetFromReasoningEffort(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["none", "off", "disabled", "disable"].includes(normalized)) return 0;
  if (["minimal", "low"].includes(normalized)) return 1024;
  if (["medium", "auto"].includes(normalized)) return 2048;
  if (normalized === "high") return 4096;
  if (["xhigh", "extra_high"].includes(normalized)) return 8192;
  return null;
}

function readThinkingDirective(source: Record<string, unknown>): { enabled?: boolean; adaptive?: boolean; budget?: number } {
  const enableThinking = parseBooleanLike(source.enable_thinking);
  if (enableThinking !== null) {
    return {
      enabled: enableThinking,
      budget: clampThinkingBudget(source.thinking_budget ?? source.reasoning_budget ?? source.budget_tokens) ?? undefined,
    };
  }

  const thinking = source.thinking;
  if (parseBooleanLike(thinking) !== null) {
    const enabled = parseBooleanLike(thinking);
    return {
      enabled: enabled ?? undefined,
      budget: clampThinkingBudget(source.thinking_budget ?? source.reasoning_budget ?? source.budget_tokens) ?? undefined,
    };
  }

  if (isRecord(thinking)) {
    const type = typeof thinking.type === "string" ? thinking.type.trim().toLowerCase() : "";
    if (["disabled", "off", "none"].includes(type)) return { enabled: false };
    if (type === "adaptive") return { enabled: true, adaptive: true };
    const budget = clampThinkingBudget(thinking.budget_tokens ?? thinking.budget ?? source.thinking_budget);
    if (type === "enabled" || budget) return { enabled: true, budget: budget ?? undefined };
  }

  const reasoning = source.reasoning;
  if (parseBooleanLike(reasoning) !== null) {
    const enabled = parseBooleanLike(reasoning);
    return {
      enabled: enabled ?? undefined,
      budget: clampThinkingBudget(source.reasoning_budget ?? source.budget_tokens) ?? undefined,
    };
  }

  if (isRecord(reasoning)) {
    const enabled = parseBooleanLike(reasoning.enabled);
    if (enabled === false) return { enabled: false };
    const budget =
      clampThinkingBudget(reasoning.budget_tokens ?? reasoning.budget ?? source.reasoning_budget) ??
      budgetFromReasoningEffort(reasoning.effort);
    if (enabled === true || (budget && budget > 0)) return { enabled: true, budget: budget ?? undefined };
  }

  const budget = clampThinkingBudget(source.thinking_budget ?? source.reasoning_budget ?? source.budget_tokens);
  if (budget) return { enabled: true, budget };

  return {};
}

function getRequestThinkingDirective(req: OpenAIChatRequest): { enabled?: boolean; adaptive?: boolean; budget?: number } {
  for (const source of [req, isRecord(req.extra_body) ? req.extra_body : null, isRecord(req.extraBody) ? req.extraBody : null]) {
    if (!source) continue;
    const directive = readThinkingDirective(source);
    if (directive.enabled !== undefined || directive.adaptive !== undefined || directive.budget !== undefined) return directive;
  }
  return {};
}

function buildThinkingConfig(env: Env, req: OpenAIChatRequest): AnthropicRequest["thinking"] | undefined {
  const requestDirective = getRequestThinkingDirective(req);
  if (requestDirective.enabled === false) return undefined;

  if (requestDirective.adaptive) {
    return { type: "adaptive", display: "summarized" };
  }

  if (requestDirective.enabled === true || requestDirective.budget) {
    return {
      type: "enabled",
      budget_tokens: requestDirective.budget ?? getEnvThinkingBudget(env),
      display: "summarized",
    };
  }

  if (env.ANTHROPIC_THINKING_ENABLED !== "true") return undefined;
  return {
    type: "enabled",
    budget_tokens: getEnvThinkingBudget(env),
    display: "summarized",
  };
}

function getAnthropicMaxTokens(
  req: OpenAIChatRequest,
  env: Env,
  thinking: AnthropicRequest["thinking"] | undefined
): number {
  const maxTokens = getMaxTokens(req);
  if (!thinking?.budget_tokens) return maxTokens;
  return Math.max(maxTokens, thinking.budget_tokens + Math.min(Math.max(maxTokens, 256), 4096));
}

function getAnthropicEffort(req: OpenAIChatRequest): AnthropicRequest["output_config"] | undefined {
  const sources = [req, isRecord(req.extra_body) ? req.extra_body : null, isRecord(req.extraBody) ? req.extraBody : null];
  for (const source of sources) {
    if (!source) continue;
    const direct = source.reasoning_effort;
    const output = isRecord(source.output_config) ? source.output_config.effort : undefined;
    const value = typeof output === "string" ? output : typeof direct === "string" ? direct : "";
    if (["low", "medium", "high", "max"].includes(value)) return { effort: value as "low" | "medium" | "high" | "max" };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Message conversion (OpenAI → Anthropic wire)
// ---------------------------------------------------------------------------

function extractSystemBlocks(messages: OpenAIChatMessage[]): AnthropicTextBlock[] {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => contentToText(message.content).trim())
    .filter(Boolean)
    .map((text) => ({ type: "text" as const, text }));
}

function convertMessages(messages: OpenAIChatMessage[]): AnthropicWireMessage[] {
  const result: AnthropicWireMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    // OpenAI tool result message → Anthropic user message with tool_result block
    if (message.role === "tool") {
      const toolUseId = message.tool_call_id ?? "unknown";
      const text = typeof message.content === "string" ? message.content : contentToText(message.content);
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: text,
      };

      const previous = result[result.length - 1];
      if (previous?.role === "user") {
        previous.content.push(block);
      } else {
        result.push({ role: "user", content: [block] });
      }
      continue;
    }

    // assistant with tool_calls → Anthropic assistant message with tool_use blocks
    if (message.role === "assistant" && message.tool_calls != null) {
      const blocks: AnthropicContentBlock[] = [];
      const text = contentToText(message.content);
      if (text) blocks.push({ type: "text", text });

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const tc of toolCalls) {
        const call = tc as { id?: string; function?: { name?: string; arguments?: string } };
        blocks.push({
          type: "tool_use",
          id: call.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: call.function?.name ?? "",
          input: safeParseJSON(call.function?.arguments),
        });
      }

      if (blocks.length > 0) {
        result.push({ role: "assistant", content: blocks });
      }
      continue;
    }

    // regular user or assistant message
    const role = message.role === "assistant" ? "assistant" : "user";
    const text = contentToText(message.content);
    if (!text) continue;

    const previous = result[result.length - 1];
    if (previous?.role === role) {
      previous.content.push({ type: "text", text });
      continue;
    }

    result.push({
      role,
      content: [{ type: "text", text }],
    });
  }

  if (result.length === 0) {
    result.push({ role: "user", content: [{ type: "text", text: "" }] });
  }

  return result;
}

// ---------------------------------------------------------------------------
// URL + headers
// ---------------------------------------------------------------------------

export function getAnthropicNativeUrl(env: Pick<Env, "AI_GATEWAY_BASE_URL">): string {
  return `${normalizeAiGatewayBaseUrl(env)}/anthropic/v1/messages`;
}

export function getAnthropicUrlForModel(env: Env, targetModel: string): string {
  const customProvider = parseCustomProviderModel(targetModel);
  if (!customProvider) return getAnthropicNativeUrl(env);
  return `${normalizeAiGatewayBaseUrl(env)}/custom-${customProvider.slug}/${getCustomAnthropicMessagesPath(env)}`;
}

export function buildAnthropicHeaders(
  env: Pick<Env, "CF_AIG_TOKEN">,
  targetModel = "",
): Headers {
  const component = /(?:^|\/)claude-opus-/i.test(targetModel) ? "opus" : "anthropic_aux";
  const headers = new Headers({
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "cf-aig-skip-cache": "true",
    "cf-aig-metadata": JSON.stringify({ operia_component: component }),
  });

  if (env.CF_AIG_TOKEN) {
    headers.set("cf-aig-authorization", `Bearer ${env.CF_AIG_TOKEN}`);
  }

  return headers;
}

// ---------------------------------------------------------------------------
// buildAnthropicNativeRequest — legacy path (no assembler)
// ---------------------------------------------------------------------------

export async function buildAnthropicNativeRequest(
  req: OpenAIChatRequest,
  input: {
    env: Env;
    targetModel: string;
    namespace: string;
    boot: BootPackage | null;
    recallHits: Array<{ type: string; content: string; score: number }>;
  }
): Promise<AnthropicRequest> {
  let thinking = buildThinkingConfig(input.env, req);
  const tools = openAIToolsToAnthropic(req.tools);
  const toolChoice = openAIToolChoiceToAnthropic(req.tool_choice);
  if (thinking && isForcedToolChoice(req.tool_choice)) {
    thinking = undefined;
  }

  const stableText = input.boot
    ? formatBootStable(input.boot)
    : await buildStableMemoryPack(input.env, input.namespace);
  const stableBlock: AnthropicTextBlock = {
    type: "text",
    text: stableText || "固定长期记忆：暂无。",
  };

  if (input.env.ANTHROPIC_CACHE_STABLE_SYSTEM !== "false") {
    stableBlock.cache_control = buildCacheControl(input.env, "stable");
  }

  const system: AnthropicTextBlock[] = [
    ...extractSystemBlocks(req.messages),
    {
      type: "text",
      text: [
        "以下长期记忆来自代理层。",
        "你可以自然使用它们，但不要提到记忆系统、数据库、RAG、代理层。",
        "如果记忆与当前用户消息无关，不要强行提起。",
      ].join("\n"),
    },
    stableBlock,
  ];

  const messages = convertMessages(req.messages);
  // Legacy path: rolling cache disabled by default
  if (input.env.ANTHROPIC_ROLLING_CACHE_ENABLED === "true") {
    applyRollingMessageCache(messages, input.env, system);
  }

  return {
    model: stripAnthropicModelPrefix(input.targetModel),
    max_tokens: getAnthropicMaxTokens(req, input.env, thinking),
    // No top-level cache_control by default
    ...(input.env.ANTHROPIC_AUTO_CACHE_ENABLED === "true"
      ? { cache_control: buildCacheControl(input.env, "conversation") }
      : {}),
    temperature: thinking ? undefined : typeof req.temperature === "number" ? req.temperature : undefined,
    output_config: getAnthropicEffort(req),
    stream: Boolean(req.stream),
    thinking,
    system,
    messages,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(input.env.ANTHROPIC_CACHE_USER_ID ? { metadata: { user_id: input.env.ANTHROPIC_CACHE_USER_ID } } : {}),
  };
}

// ---------------------------------------------------------------------------
// buildAnthropicRequestFromAssembled — v4 assembler path
// ---------------------------------------------------------------------------
// Cache strategy — 4 explicit breakpoints (Anthropic prompt caching)
//
// Anthropic caches the full prefix: tools → system → messages.
// Up to 4 explicit cache_control breakpoints. Each looks back up to
// 20 content blocks for a previous cache entry.
//
//   1. tools (last tool): cache_control on the last tool definition.
//      Tool definitions must be stable (no dates, no timestamps).
//   2. system (persona_pinned): cache_control on persona_pinned block.
//      This is the most stable content. boot_stable (glossary, digest)
//      is OUTSIDE the cache prefix — it changes daily.
//   3. bridge (message): retained for legacy/non-Think native consumers.
//      Anchored Think filters this marker in buildAssembledThinkInput().
//   4. tail (message): last stable block before dynamic content.
//      Default mode A: last block of the message before current_user.
//      Opt-in mode B: first text block of current_user.
//
// Per-turn dynamic content (turn_context blocks) lives in the message stream
// immediately before current_user — after all breakpoints, never cached.
//
// Top-level cache_control (automatic) is NEVER set.
// Rolling cache is OFF by default (opt-in via env).
// ---------------------------------------------------------------------------

/**
 * Apply cache_control to the last tool definition if tools are present.
 * Returns the tools array with cache_control on the last tool, or
 * undefined if no tools.
 */
function applyToolsCacheBreakpoint(
  tools: AnthropicTool[] | undefined,
  env: Env
): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  if (env.ANTHROPIC_CACHE_ENABLED === "false") return tools;
  // Don't cache tools if they contain volatile content (date patterns)
  const cc = buildCacheControl(env, "stable");
  if (!cc) return tools;

  // Tag the last tool with cache_control
  const result = tools.map((t, i) => {
    if (i === tools.length - 1) {
      return { ...t, cache_control: cc };
    }
    return t;
  });
  return result;
}

export function buildAnthropicRequestFromAssembled(
  req: OpenAIChatRequest,
  targetModel: string,
  assembled: AssembledPrompt,
  env: Env
): AnthropicRequest {
  let thinking = buildThinkingConfig(env, req);
  const tools = openAIToolsToAnthropic(req.tools);
  const toolChoice = openAIToolChoiceToAnthropic(req.tool_choice);
  // Tool priority: disable thinking when forced tool_choice is present.
  if (thinking && isForcedToolChoice(req.tool_choice)) {
    thinking = undefined;
  }

  const system = assembledToAnthropicSystem(assembled.system_blocks);
  const { wire: messages, indexMap } = assembledToAnthropicMessages(assembled.messages);

  // Apply explicit cache breakpoints (system + message level).
  // turn_context blocks are already in assembled.messages before current_user.
  applyExplicitCacheBreakpoints(system, messages, indexMap, assembled, env);

  // Stable tools JSON: keys sorted, so Anthropic's cache sees identical bytes
  const stableToolsJson = tools
    ? (JSON.parse(stableStringify(tools)) as AnthropicTool[])
    : undefined;

  // Breakpoint 1: tools — cache on last tool if definitions are stable
  const cachedTools = applyToolsCacheBreakpoint(stableToolsJson, env);

  return {
    model: stripAnthropicModelPrefix(targetModel),
    max_tokens: getAnthropicMaxTokens(req, env, thinking),
    // Top-level cache_control is NEVER set (was competing with explicit breakpoints)
    temperature: thinking ? undefined : typeof req.temperature === "number" ? req.temperature : undefined,
    output_config: getAnthropicEffort(req),
    stream: Boolean(req.stream),
    thinking,
    system,
    messages,
    ...(cachedTools ? { tools: cachedTools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(env.ANTHROPIC_CACHE_USER_ID ? { metadata: { user_id: env.ANTHROPIC_CACHE_USER_ID } } : {}),
  };
}

// ---------------------------------------------------------------------------
// HTTP call + response parsing
// ---------------------------------------------------------------------------

function stripBindingUnsupportedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBindingUnsupportedFields);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "cache_control" || child === undefined) continue;
    const normalizedChild = stripBindingUnsupportedFields(child);
    if (normalizedChild !== undefined) result[key] = normalizedChild;
  }
  return result;
}

function buildAnthropicAiBindingInput(body: AnthropicRequest): Record<string, unknown> {
  const normalized = stripBindingUnsupportedFields(body) as Record<string, unknown>;
  delete normalized.model;

  if (Array.isArray(normalized.system)) {
    normalized.system = normalized.system
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
          return (block as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  if (Array.isArray(normalized.messages)) {
    normalized.messages = normalized.messages.map((message) => {
      if (!message || typeof message !== "object") return message;
      const record = message as Record<string, unknown>;
      if (!Array.isArray(record.content)) return record;
      const blocks = record.content as Array<Record<string, unknown>>;
      if (!blocks.every((block) => block?.type === "text" && typeof block.text === "string")) {
        return record;
      }
      return { ...record, content: blocks.map((block) => block.text as string).join("") };
    });
  }

  return normalized;
}

function describeAnthropicBindingInput(input: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  return {
    keys: Object.keys(input).sort(),
    systemType: typeof input.system,
    systemLength: typeof input.system === "string" ? input.system.length : null,
    messageCount: messages.length,
    messages: messages.map((message) => {
      const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
      const content = record.content;
      return {
        role: record.role,
        keys: Object.keys(record).sort(),
        contentType: Array.isArray(content) ? "array" : typeof content,
        blockTypes: Array.isArray(content)
          ? content.map((block) => block && typeof block === "object" ? (block as { type?: unknown }).type : typeof block)
          : [],
      };
    }),
    toolCount: Array.isArray(input.tools) ? input.tools.length : 0,
  };
}

export async function callAnthropicNative(
  env: Env,
  body: AnthropicRequest,
  targetModel?: string,
  transport: AnthropicTransport = "default",
  memoryDispatchGuard?: ExactMemoryDispatchGuard,
  signal?: AbortSignal,
): Promise<Response> {
  const resolvedModel = targetModel || body.model;
  if (transport === "default" && env.ANTHROPIC_TRANSPORT_DEFAULT === "gateway") {
    transport = "gateway";
  }
  if (transport === "unified-probe") {
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN || !resolvedModel.startsWith("anthropic/")) {
      return new Response(JSON.stringify({ error: { message: "unified probe unavailable", type: "transport_error" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    const bindingInput = buildAnthropicAiBindingInput(body);
    const outbound = { model: resolvedModel, ...bindingInput, cache_control: { type: "ephemeral" } };
    await memoryDispatchGuard?.verify(outbound,"anthropic_unified_probe");
    return fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(outbound),
        signal,
      }
    );
  }
  if (
    transport !== "gateway" &&
    resolvedModel.startsWith("anthropic/") &&
    env.CLOUDFLARE_ACCOUNT_ID &&
    env.CLOUDFLARE_API_TOKEN
  ) {
    const bindingInput = buildAnthropicAiBindingInput(body);
    const outbound = { model: resolvedModel, ...bindingInput };
    await memoryDispatchGuard?.verify(outbound,"anthropic_cloudflare_binding_http");
    return fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(outbound),
        signal,
      }
    );
  }

  if (transport !== "gateway" && env.AI && resolvedModel.startsWith("anthropic/")) {
    const bindingInput = buildAnthropicAiBindingInput(body);
    await memoryDispatchGuard?.verify(bindingInput,"anthropic_workers_ai_binding");
    try {
      const result = await env.AI.run(resolvedModel as never, bindingInput as never, signal ? { signal } : undefined);
      if (body.stream) {
        return new Response(result as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const inputShape = describeAnthropicBindingInput(buildAnthropicAiBindingInput(body));
      console.error("anthropic AI binding rejected input", {
        error: message,
        input: inputShape,
      });
      return new Response(JSON.stringify({ error: { message, type: "ai_binding_error" } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  }

  await memoryDispatchGuard?.verify(body,"anthropic_direct_or_gateway_http");
  return fetch(getAnthropicUrlForModel(env, resolvedModel), {
    method: "POST",
    headers: buildAnthropicHeaders(env, resolvedModel),
    body: JSON.stringify(body),
    signal,
  });
}

export function parseAnthropicNonStream(response: AnthropicResponse): {
  openai: OpenAIChatResponse;
  content: string;
  finishReason: string | null;
  usage?: TokenUsage;
} {
  const content = (response.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("");
  const reasoningContent = (response.content ?? [])
    .filter((block) => block.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking!)
    .join("");

  // Collect tool_use blocks and convert to OpenAI tool_calls
  const toolUseBlocks: AnthropicToolUseBlock[] = (response.content ?? [])
    .filter(
      (block): block is AnthropicToolUseBlock =>
        block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string"
    )
    .map((block) => ({
      type: "tool_use" as const,
      id: block.id!,
      name: block.name!,
      input: block.input ?? {},
    }));

  const toolCalls = anthropicToolUseBlocksToOpenAI(toolUseBlocks);
  const usage = normalizeAnthropicUsage(response.usage);

  const message = {
    role: "assistant" as const,
    content: toolCalls.length > 0 ? content || null : content,
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  const mappedFinishReason = mapAnthropicToOpenAIFinishReason(response.stop_reason);

  return {
    content,
    finishReason: mappedFinishReason,
    usage,
    openai: {
      id: response.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: mappedFinishReason,
        },
      ],
      usage,
    },
  };
}

function mapAnthropicToOpenAIFinishReason(stopReason: string | null | undefined): string | null {
  if (!stopReason) return null;
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    default:
      return stopReason;
  }
}

export function normalizeAnthropicUsage(usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;

  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;

  return {
    ...usage,
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens:
      typeof input === "number" && typeof output === "number" ? input + output : usage.total_tokens,
  };
}
