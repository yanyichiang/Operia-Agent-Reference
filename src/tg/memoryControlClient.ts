import type { Env } from "../types";

export type TgMemoryControlValue = {
  key: string;
  effectiveValue: unknown;
  effectiveSource: string;
  revision: number;
  globalRevision: number;
  overrideRevision: number;
  overrideValue?: unknown;
  canReset: boolean;
  runtimeStatus?: string;
};

export type TgMemoryControlSnapshot = {
  registryVersion: string;
  ownerDomain: string;
  ownerVersion: string;
  values: TgMemoryControlValue[];
  request: { model: string; thinking: Record<string, unknown> | null; effort: string; temperature: number | null };
  observedAt: string;
};

export type TgMemoryCacheHealth = {
  status: "ready" | "unavailable";
  ownerDomain: "memory.example.com";
  observedAt: string;
  windowHours: number;
  totalRequests: number;
  cacheHitRequests: number;
  coldStartRequests: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  promptTokens: number;
  cacheHitRequestRate: number;
  cacheReadShare: number;
  policy: {
    promptCacheMode: string | null;
    stableTtl: string | null;
    conversationTtl: string | null;
    evaluationWindow: string | null;
  };
  fingerprints: Array<{ hash: string; requests: number; cacheReadTokens: number }>;
  recent: Array<{
    createdAt: string;
    model: string;
    requestKind: string | null;
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    prefixHash: string | null;
    cacheAnchorBlock: string | null;
  }>;
};

function authHeaders(env: Env): Record<string, string> {
  const bearer = env.MEMORY_CONTROL_SERVICE_BEARER?.trim();
  if (!bearer) throw new Error("memory_control_auth_missing");
  return {
    authorization: `Bearer ${bearer}`,
    "x-operia-source-domain": "tgbot.example.com",
    "x-operia-service-id": env.TG_AGENT_SERVICE_ID?.trim() || "telegram-agent",
  };
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  if (!env.MEMORY_SERVICE) throw new Error("memory_service_missing");
  const response = await env.MEMORY_SERVICE.fetch(`https://<MEMORY_SERVICE>.internal${path}`, {
    ...init,
    headers: { ...authHeaders(env), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string> || {}) },
  });
  const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) throw new Error(`memory_control_http_${response.status}:${String(payload.error || "unknown")}`);
  return payload;
}

export async function getTgMemoryControls(env: Env, chatId: string): Promise<TgMemoryControlSnapshot> {
  return call(env, `/service/control/effective?channel=telegram&chat_id=${encodeURIComponent(chatId)}`) as Promise<TgMemoryControlSnapshot>;
}

export type TgWorkersAiModel = {
  id: string;
  name: string;
  task: string;
  description: string;
  properties: string[];
};

export async function searchTgWorkersAiModels(env: Env, query = ""): Promise<{ models: TgWorkersAiModel[]; observedAt: string }> {
  const payload = await call(env, `/service/control/models?search=${encodeURIComponent(query.slice(0, 100))}`);
  return payload as { models: TgWorkersAiModel[]; observedAt: string };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function getTgMemoryCacheHealth(env: Env, hours = 24): Promise<TgMemoryCacheHealth> {
  const windowHours = Math.min(168, Math.max(1, Math.floor(hours)));
  const payload = await call(env, `/service/control/cache-health?hours=${windowHours}`);
  const policy = object(payload.policy);
  const fingerprints = Array.isArray(payload.by_client_system_hash) ? payload.by_client_system_hash : [];
  const recent = Array.isArray(payload.recent) ? payload.recent : [];
  return {
    status: "ready",
    ownerDomain: "memory.example.com",
    observedAt: new Date().toISOString(),
    windowHours,
    totalRequests: finiteNumber(payload.total_requests),
    cacheHitRequests: finiteNumber(payload.cache_hit_requests),
    coldStartRequests: finiteNumber(payload.cold_start_requests),
    cacheCreationTokens: finiteNumber(payload.cache_creation_total_tokens),
    cacheReadTokens: finiteNumber(payload.cache_read_total_tokens),
    inputTokens: finiteNumber(payload.input_total_tokens),
    promptTokens: finiteNumber(payload.prompt_token_total),
    cacheHitRequestRate: finiteNumber(payload.cache_hit_request_rate),
    cacheReadShare: finiteNumber(payload.cache_read_share),
    policy: {
      promptCacheMode: typeof policy.prompt_cache_mode === "string" ? policy.prompt_cache_mode : null,
      stableTtl: typeof policy.stable_ttl === "string" ? policy.stable_ttl : null,
      conversationTtl: typeof policy.conversation_ttl === "string" ? policy.conversation_ttl : null,
      evaluationWindow: typeof policy.evaluation_window === "string" ? policy.evaluation_window : null,
    },
    fingerprints: fingerprints.flatMap((entry) => {
      const row = object(entry);
      return typeof row.client_system_hash === "string" ? [{
        hash: row.client_system_hash.slice(0, 16),
        requests: finiteNumber(row.requests),
        cacheReadTokens: finiteNumber(row.cache_read_tokens),
      }] : [];
    }),
    recent: recent.map((entry) => {
      const row = object(entry);
      return {
        createdAt: typeof row.created_at === "string" ? row.created_at : "",
        model: typeof row.model === "string" ? row.model : "unknown",
        requestKind: typeof row.request_kind === "string" ? row.request_kind : null,
        inputTokens: finiteNumber(row.input_tokens),
        cacheReadTokens: finiteNumber(row.cache_read_tokens),
        cacheCreationTokens: finiteNumber(row.cache_creation_tokens),
        prefixHash: typeof row.client_system_hash === "string" ? row.client_system_hash.slice(0, 16) : null,
        cacheAnchorBlock: typeof row.cache_anchor_block === "string" ? row.cache_anchor_block : null,
      };
    }),
  };
}

function value(snapshot: TgMemoryControlSnapshot, key: string): TgMemoryControlValue {
  const found = snapshot.values.find((item) => item.key === key);
  if (!found) throw new Error(`memory_control_value_missing:${key}`);
  return found;
}

export async function setTgMemoryControl(env: Env, chatId: string, key: string, nextValue: unknown): Promise<TgMemoryControlSnapshot> {
  const current = await getTgMemoryControls(env, chatId);
  const entry = value(current, key);
  const payload = await call(env, `/service/control/overrides/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "if-match": `"${entry.overrideRevision}"`, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ scope: { type: "chat", channel: "telegram", chatId }, value: nextValue }),
  });
  return (payload.snapshot || payload) as TgMemoryControlSnapshot;
}

export async function resetTgMemoryControl(env: Env, chatId: string, key: string): Promise<TgMemoryControlSnapshot> {
  const current = await getTgMemoryControls(env, chatId);
  const entry = value(current, key);
  if (!entry.canReset) return current;
  const payload = await call(env, `/service/control/overrides/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { "if-match": `"${entry.overrideRevision}"`, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ scope: { type: "chat", channel: "telegram", chatId } }),
  });
  return (payload.snapshot || payload) as TgMemoryControlSnapshot;
}
