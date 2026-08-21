import type { TokenUsage } from "../types";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

export async function saveUsageLog(
  db: D1Database,
  input: {
    messageId: string | null;
    namespace: string;
    provider: string;
    model: string;
    usage?: TokenUsage;
    cacheMode?: string | null;
    cacheTtl?: string | null;
    clientSystemHash?: string | null;
    cacheAnchorBlock?: string | null;
    requestKind?: string | null;
    correlationId?: string | null;
    ttftMs?: number | null;
    totalMs?: number | null;
    idempotencyKey?: string | null;
  }
): Promise<void> {
  const usage = input.usage || {};
  await db
    .prepare(
      `INSERT INTO usage_logs (
        id, message_id, namespace, provider, model, input_tokens,
        output_tokens, cache_read_tokens, cache_creation_tokens, cache_mode,
        cache_ttl, client_system_hash, cache_anchor_block, service_tier, ttft_ms,
        total_ms, request_kind, correlation_id, raw_usage_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`
    )
    .bind(
      input.idempotencyKey?.trim() || newId("usage"),
      input.messageId,
      input.namespace,
      input.provider,
      input.model,
      usage.prompt_tokens ?? usage.input_tokens ?? null,
      usage.completion_tokens ?? usage.output_tokens ?? null,
      usage.cache_read_input_tokens ?? null,
      usage.cache_creation_input_tokens ?? null,
      input.cacheMode ?? null,
      input.cacheTtl ?? null,
      input.clientSystemHash ?? null,
      input.cacheAnchorBlock ?? null,
      typeof usage.service_tier === "string" ? usage.service_tier : null,
      input.ttftMs ?? null,
      input.totalMs ?? null,
      input.requestKind?.trim() || "unclassified",
      input.correlationId?.trim() || null,
      JSON.stringify(usage),
      nowIso()
    )
    .run();
}
