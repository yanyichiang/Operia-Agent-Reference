export const AGENT_HOOK_EVENTS = [
  "before_plan",
  "before_tool",
  "before_browser_action",
  "after_tool",
  "on_error",
  "on_approval",
  "on_heartbeat",
  "before_companion_pulse",
  "after_companion_pulse",
] as const;

export type AgentHookEvent = (typeof AGENT_HOOK_EVENTS)[number];
export type AgentHookMode = "advisory" | "gate";
export type AgentHookFailurePolicy = "fail-open" | "fail-closed";
export type HookJsonPrimitive = string | number | boolean | null;
export type HookJsonValue = HookJsonPrimitive | HookJsonValue[] | { [key: string]: HookJsonValue };

export type AgentHookScope = {
  ownerId: string;
  serviceId: string;
};

export type AgentHookFilter = Readonly<Record<string, HookJsonPrimitive | ReadonlyArray<HookJsonPrimitive>>>;

export type AgentHookWebhook = {
  url: string;
  secret: string;
};

export type AgentHookDefinition = {
  id: string;
  scope: AgentHookScope;
  event: AgentHookEvent;
  filter?: AgentHookFilter;
  mode: AgentHookMode;
  failurePolicy?: AgentHookFailurePolicy;
  enabled?: boolean;
  handler?: string;
  webhook?: AgentHookWebhook;
};

export type RegisteredAgentHookDefinition = Omit<AgentHookDefinition, "failurePolicy" | "enabled"> & {
  failurePolicy: AgentHookFailurePolicy;
  enabled: boolean;
};

export type AgentHookHandlerDecision = {
  allow?: boolean;
  reason?: string;
};

export type AgentHookContext = AgentHookScope & {
  hookId: string;
  event: AgentHookEvent;
  mode: AgentHookMode;
  timestamp: string;
  payload: HookJsonValue;
};

export type AgentHookHandler = (
  context: Readonly<AgentHookContext>,
) => AgentHookHandlerDecision | void | Promise<AgentHookHandlerDecision | void>;

export type AgentHookOutcome = {
  hookId: string;
  mode: AgentHookMode;
  failurePolicy: AgentHookFailurePolicy;
  status: "allowed" | "denied" | "advisory" | "failed-open" | "failed-closed";
  reasons: string[];
};

export type AgentHookDispatchResult = {
  enabled: boolean;
  allowed: boolean;
  payload: SanitizedHookPayload;
  outcomes: AgentHookOutcome[];
};

export type SanitizedHookPayload = {
  value: HookJsonValue;
  body: string;
  bytes: number;
  sourceBytes: number;
  redacted: boolean;
  truncated: boolean;
};

export type AgentHookRegistryOptions = {
  enabled?: boolean;
  definitions?: ReadonlyArray<AgentHookDefinition>;
  handlers?: AgentHookHandlerRegistry;
  fetcher?: typeof fetch;
  now?: () => Date;
  maxPayloadDepth?: number;
  maxPayloadBytes?: number;
};

export const DEFAULT_HOOK_PAYLOAD_MAX_DEPTH = 8;
export const DEFAULT_HOOK_PAYLOAD_MAX_BYTES = 16 * 1024;
export const HOOK_WEBHOOK_TIMEOUT_MS = 3_000;
export const HOOK_WEBHOOK_RESPONSE_MAX_BYTES = 4 * 1024;

const SECRET_LIKE_KEY = /(authorization|bearer|token|secret|password|passwd|cookie|api[_-]?key|apikey|credential|private[_-]?key|session|authreference)/i;
const EVENT_SET = new Set<string>(AGENT_HOOK_EVENTS);
const DEFINITION_KEYS = new Set(["id", "scope", "event", "filter", "mode", "failurePolicy", "enabled", "handler", "webhook"]);
const SCOPE_KEYS = new Set(["ownerId", "serviceId"]);
const WEBHOOK_KEYS = new Set(["url", "secret"]);
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/;
const MIN_PAYLOAD_BYTES = 96;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PAYLOAD_DEPTH = 32;

export class AgentHookHandlerRegistry {
  private readonly handlers = new Map<string, AgentHookHandler>();

  constructor() {
    this.handlers.set("builtin:noop", () => undefined);
    this.handlers.set("builtin:allow", () => ({ allow: true }));
    this.handlers.set("builtin:deny", () => ({ allow: false, reason: "denied_by_builtin" }));
  }

  register(id: string, handler: AgentHookHandler, replace = false): void {
    assertIdentifier(id, "invalid_hook_handler_id");
    if (typeof handler !== "function") throw new Error("invalid_hook_handler");
    if (!replace && this.handlers.has(id)) throw new Error("hook_handler_already_registered");
    this.handlers.set(id, handler);
  }

  get(id: string): AgentHookHandler | undefined {
    return this.handlers.get(id);
  }

  has(id: string): boolean {
    return this.handlers.has(id);
  }
}

export class AgentHookRegistry {
  private readonly definitions = new Map<string, RegisteredAgentHookDefinition>();
  private readonly handlers: AgentHookHandlerRegistry;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly maxPayloadDepth: number;
  private readonly maxPayloadBytes: number;
  private globallyEnabled: boolean;

  constructor(options: AgentHookRegistryOptions = {}) {
    this.globallyEnabled = options.enabled === true;
    this.handlers = options.handlers ?? new AgentHookHandlerRegistry();
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.maxPayloadDepth = clampInteger(options.maxPayloadDepth, DEFAULT_HOOK_PAYLOAD_MAX_DEPTH, 1, MAX_PAYLOAD_DEPTH);
    this.maxPayloadBytes = clampInteger(options.maxPayloadBytes, DEFAULT_HOOK_PAYLOAD_MAX_BYTES, MIN_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES);
    for (const definition of options.definitions ?? []) this.register(definition);
  }

  setEnabled(enabled: boolean): void {
    this.globallyEnabled = enabled === true;
  }

  isEnabled(): boolean {
    return this.globallyEnabled;
  }

  register(definition: AgentHookDefinition): RegisteredAgentHookDefinition {
    const normalized = normalizeAgentHookDefinition(definition);
    if (this.definitions.has(normalized.id)) throw new Error("hook_already_registered");
    this.definitions.set(normalized.id, normalized);
    return normalized;
  }

  replace(definition: AgentHookDefinition): RegisteredAgentHookDefinition {
    const normalized = normalizeAgentHookDefinition(definition);
    this.definitions.set(normalized.id, normalized);
    return normalized;
  }

  remove(id: string): boolean {
    return this.definitions.delete(id);
  }

  registerHandler(id: string, handler: AgentHookHandler, replace = false): void {
    this.handlers.register(id, handler, replace);
  }

  async dispatch(input: AgentHookScope & { event: AgentHookEvent; payload: unknown }): Promise<AgentHookDispatchResult> {
    assertHookEvent(input.event);
    const ownerId = normalizeScopePart(input.ownerId, "hook_owner_required");
    const serviceId = normalizeScopePart(input.serviceId, "hook_service_required");
    const payload = sanitizeHookPayload(input.payload, {
      maxDepth: this.maxPayloadDepth,
      maxBytes: this.maxPayloadBytes,
    });
    if (!this.globallyEnabled) return { enabled: false, allowed: true, payload, outcomes: [] };

    const timestamp = validNow(this.now()).toISOString();
    const outcomes: AgentHookOutcome[] = [];
    let allowed = true;
    for (const definition of this.definitions.values()) {
      if (!definition.enabled || definition.event !== input.event) continue;
      if (!matchesAgentHookScope(definition.scope, { ownerId, serviceId })) continue;
      if (!matchesAgentHookFilter(definition.filter, payload.value)) continue;
      const outcome = await this.execute(definition, { ownerId, serviceId, timestamp, payload: payload.value });
      outcomes.push(outcome);
      if (outcome.status === "denied" || outcome.status === "failed-closed") allowed = false;
    }
    return { enabled: true, allowed, payload, outcomes };
  }

  private async execute(
    definition: RegisteredAgentHookDefinition,
    input: AgentHookScope & { timestamp: string; payload: HookJsonValue },
  ): Promise<AgentHookOutcome> {
    const context: AgentHookContext = {
      ...input,
      hookId: definition.id,
      event: definition.event,
      mode: definition.mode,
    };
    const reasons: string[] = [];
    let denied = false;
    let failed = false;

    if (definition.handler) {
      const handler = this.handlers.get(definition.handler);
      if (!handler) {
        failed = true;
        reasons.push("handler_not_registered");
      } else {
        try {
          const decision = normalizeHandlerDecision(await handler(context));
          if (decision.reason) reasons.push(decision.reason);
          if (decision.allow === false) denied = true;
        } catch {
          failed = true;
          reasons.push("handler_failed");
        }
      }
    }

    if (definition.webhook) {
      try {
        const decision = await dispatchSignedHookWebhook(definition.webhook, context, this.fetcher);
        if (decision.reason) reasons.push(decision.reason);
        if (decision.allow === false) denied = true;
      } catch {
        failed = true;
        reasons.push("webhook_failed");
      }
    }

    if (failed && definition.failurePolicy === "fail-closed") {
      return { hookId: definition.id, mode: definition.mode, failurePolicy: definition.failurePolicy, status: "failed-closed", reasons };
    }
    if (definition.mode === "gate" && denied) {
      return { hookId: definition.id, mode: definition.mode, failurePolicy: definition.failurePolicy, status: "denied", reasons };
    }
    if (failed) {
      return { hookId: definition.id, mode: definition.mode, failurePolicy: definition.failurePolicy, status: "failed-open", reasons };
    }
    return {
      hookId: definition.id,
      mode: definition.mode,
      failurePolicy: definition.failurePolicy,
      status: definition.mode === "advisory" ? "advisory" : "allowed",
      reasons,
    };
  }
}

export function defaultAgentHookFailurePolicy(event: AgentHookEvent, mode: AgentHookMode): AgentHookFailurePolicy {
  assertHookEvent(event);
  if (mode !== "advisory" && mode !== "gate") throw new Error("invalid_hook_mode");
  return mode === "gate" && (event === "before_tool" || event === "before_browser_action" || event === "before_companion_pulse")
    ? "fail-closed"
    : "fail-open";
}

export function normalizeAgentHookDefinition(input: unknown): RegisteredAgentHookDefinition {
  if (!isRecord(input)) throw new Error("invalid_hook_definition");
  assertOnlyKeys(input, DEFINITION_KEYS, "unsupported_hook_definition_field");
  assertIdentifier(input.id, "invalid_hook_id");
  assertHookEvent(input.event);
  if (input.mode !== "advisory" && input.mode !== "gate") throw new Error("invalid_hook_mode");
  if (!isRecord(input.scope)) throw new Error("invalid_hook_scope");
  assertOnlyKeys(input.scope, SCOPE_KEYS, "unsupported_hook_scope_field");
  const scope = {
    ownerId: normalizeScopePart(input.scope.ownerId, "hook_owner_required"),
    serviceId: normalizeScopePart(input.scope.serviceId, "hook_service_required"),
  };
  const filter = normalizeFilter(input.filter);
  const handler = input.handler === undefined ? undefined : normalizeHandlerId(input.handler);
  const webhook = input.webhook === undefined ? undefined : normalizeWebhook(input.webhook);
  if (!handler && !webhook) throw new Error("hook_target_required");
  if (input.failurePolicy !== undefined && input.failurePolicy !== "fail-open" && input.failurePolicy !== "fail-closed") {
    throw new Error("invalid_hook_failure_policy");
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("invalid_hook_enabled");
  const failurePolicy: AgentHookFailurePolicy = input.failurePolicy === "fail-open" || input.failurePolicy === "fail-closed"
    ? input.failurePolicy
    : defaultAgentHookFailurePolicy(input.event, input.mode);

  return {
    id: input.id,
    scope,
    event: input.event,
    filter,
    mode: input.mode,
    failurePolicy,
    enabled: input.enabled === true,
    handler,
    webhook,
  };
}

export function matchesAgentHookScope(expected: AgentHookScope, actual: AgentHookScope): boolean {
  return scopePartMatches(expected.ownerId, actual.ownerId) && scopePartMatches(expected.serviceId, actual.serviceId);
}

export function matchesAgentHookFilter(filter: AgentHookFilter | undefined, payload: HookJsonValue): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  return Object.entries(filter).every(([path, expected]) => {
    const actual = valueAtPath(payload, path);
    return Array.isArray(expected)
      ? expected.some((candidate) => Object.is(candidate, actual))
      : Object.is(expected, actual);
  });
}

export function sanitizeHookPayload(
  value: unknown,
  options: { maxDepth?: number; maxBytes?: number } = {},
): SanitizedHookPayload {
  const maxDepth = clampInteger(options.maxDepth, DEFAULT_HOOK_PAYLOAD_MAX_DEPTH, 1, MAX_PAYLOAD_DEPTH);
  const maxBytes = clampInteger(options.maxBytes, DEFAULT_HOOK_PAYLOAD_MAX_BYTES, MIN_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES);
  const state = { redacted: false, truncated: false, seen: new WeakSet<object>() };
  const sanitized = sanitizeValue(value, 0, maxDepth, state);
  const sourceBody = stableHookJsonStringify(sanitized);
  const sourceBytes = utf8Bytes(sourceBody);
  if (sourceBytes <= maxBytes) {
    return { value: sanitized, body: sourceBody, bytes: sourceBytes, sourceBytes, redacted: state.redacted, truncated: state.truncated };
  }

  const limited: HookJsonValue = { originalBytes: sourceBytes, reason: "payload_byte_limit", truncated: true };
  const body = stableHookJsonStringify(limited);
  return { value: limited, body, bytes: utf8Bytes(body), sourceBytes, redacted: state.redacted, truncated: true };
}

export function stableHookJsonStringify(value: HookJsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableHookJsonStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableHookJsonStringify(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return typeof serialized === "string" ? serialized : "null";
}

export async function signHookWebhook(secret: string, timestamp: string, body: string): Promise<string> {
  if (!secret) throw new Error("hook_webhook_secret_required");
  if (!timestamp) throw new Error("hook_webhook_timestamp_required");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function dispatchSignedHookWebhook(
  webhook: AgentHookWebhook,
  context: AgentHookContext,
  fetcher: typeof fetch = fetch,
): Promise<AgentHookHandlerDecision> {
  const normalized = normalizeWebhook(webhook);
  const body = stableHookJsonStringify({
    event: context.event,
    hookId: context.hookId,
    mode: context.mode,
    ownerId: context.ownerId,
    payload: context.payload,
    serviceId: context.serviceId,
    timestamp: context.timestamp,
  });
  const signature = await signHookWebhook(normalized.secret, context.timestamp, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("hook_webhook_timeout"), HOOK_WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetcher(normalized.url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-operia-hook-event": context.event,
        "x-operia-hook-signature": `sha256=${signature}`,
        "x-operia-hook-timestamp": context.timestamp,
      },
      body,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("hook_webhook_non_success");
    const responseBody = await response.text();
    if (!responseBody.trim()) return { allow: true };
    if (utf8Bytes(responseBody) > HOOK_WEBHOOK_RESPONSE_MAX_BYTES) throw new Error("hook_webhook_response_too_large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      throw new Error("invalid_hook_webhook_response");
    }
    return normalizeHandlerDecision(parsed);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeHandlerDecision(value: unknown): AgentHookHandlerDecision {
  if (value === undefined || value === null) return { allow: true };
  if (!isRecord(value)) throw new Error("invalid_hook_decision");
  if (value.allow !== undefined && typeof value.allow !== "boolean") throw new Error("invalid_hook_decision");
  if (value.reason !== undefined && typeof value.reason !== "string") throw new Error("invalid_hook_decision");
  const allow = typeof value.allow === "boolean" ? value.allow : true;
  return {
    allow,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 256) : undefined,
  };
}

function sanitizeValue(value: unknown, depth: number, maxDepth: number, state: { redacted: boolean; truncated: boolean; seen: WeakSet<object> }): HookJsonValue {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return null;
  if (depth >= maxDepth) {
    state.truncated = true;
    return "[MAX_DEPTH]";
  }
  if (state.seen.has(value)) {
    state.truncated = true;
    return "[CIRCULAR]";
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => sanitizeValue(item, depth + 1, maxDepth, state));
    state.seen.delete(value);
    return output;
  }
  const output: Record<string, HookJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_LIKE_KEY.test(key)) {
      output[key] = "[REDACTED]";
      state.redacted = true;
    } else {
      output[key] = sanitizeValue(item, depth + 1, maxDepth, state);
    }
  }
  state.seen.delete(value);
  return output;
}

function normalizeFilter(value: unknown): AgentHookFilter | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("invalid_hook_filter");
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error("hook_filter_too_large");
  const filter: Record<string, HookJsonPrimitive | ReadonlyArray<HookJsonPrimitive>> = {};
  for (const [path, expected] of entries) {
    if (!validFilterPath(path)) throw new Error("invalid_hook_filter_path");
    if (Array.isArray(expected)) {
      if (expected.length === 0 || expected.length > 32 || !expected.every(isJsonPrimitive)) throw new Error("invalid_hook_filter_value");
      filter[path] = [...expected];
    } else {
      if (!isJsonPrimitive(expected)) throw new Error("invalid_hook_filter_value");
      filter[path] = expected;
    }
  }
  return filter;
}

function normalizeWebhook(value: unknown): AgentHookWebhook {
  if (!isRecord(value)) throw new Error("invalid_hook_webhook");
  assertOnlyKeys(value, WEBHOOK_KEYS, "unsupported_hook_webhook_field");
  if (typeof value.url !== "string" || typeof value.secret !== "string" || !value.secret) throw new Error("invalid_hook_webhook");
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("invalid_hook_webhook_url");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" || url.username || url.password || url.port || value.url.length > 2048 ||
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
    hostname.endsWith(".internal") || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(":")
  ) throw new Error("invalid_hook_webhook_url");
  return { url: url.toString(), secret: value.secret };
}

function normalizeHandlerId(value: unknown): string {
  assertIdentifier(value, "invalid_hook_handler_id");
  return value;
}

function valueAtPath(value: HookJsonValue, path: string): HookJsonValue | undefined {
  let current: HookJsonValue | undefined = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else {
      current = Object.prototype.hasOwnProperty.call(current, segment) ? current[segment] : undefined;
    }
  }
  return current;
}

function scopePartMatches(expected: string, actual: string): boolean {
  return expected === "*" || expected === actual;
}

function validFilterPath(path: string): boolean {
  if (!path || path.length > 256) return false;
  return path.split(".").every((part) => /^(?:[a-zA-Z_][a-zA-Z0-9_-]*|\d+)$/.test(part) && part !== "__proto__" && part !== "prototype" && part !== "constructor");
}

function normalizeScopePart(value: unknown, error: string): string {
  if (typeof value !== "string") throw new Error(error);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(error);
  return normalized;
}

function assertIdentifier(value: unknown, error: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(error);
}

function assertHookEvent(value: unknown): asserts value is AgentHookEvent {
  if (typeof value !== "string" || !EVENT_SET.has(value)) throw new Error("invalid_hook_event");
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, error: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonPrimitive(value: unknown): value is HookJsonPrimitive {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value as number)));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("invalid_hook_clock");
  return value;
}
