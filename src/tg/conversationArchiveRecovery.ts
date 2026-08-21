import type { ConversationState } from "../memory/conversationState";

function validIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function conversationArchiveWatermark(state: ConversationState): string | null {
  const covered = validIso(state.summaryEnvelope?.coversThroughUtc);
  const recent = state.recent.flatMap((turn) => {
    const timestamp = turn.version === 2 ? validIso(turn.occurredAtUtc) : null;
    return timestamp ? [timestamp] : [];
  });
  const canonical = [...(covered ? [covered] : []),...recent]
    .sort((left,right) => Date.parse(left)-Date.parse(right)).at(-1);
  // updatedAt is a storage mutation clock and can jump during a summary fold,
  // so it is safe only for legacy states without canonical event timestamps.
  return canonical ?? validIso(state.updatedAt);
}

export async function dueTgConversationArchiveBatchKeys(
  db: D1Database,
  limit = 20,
): Promise<string[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await db.prepare(`SELECT r.batch_key FROM tg_chat_inference_runs r
    LEFT JOIN conversation_turn_events e ON e.event_id=('batch:' || r.batch_key)
    WHERE r.status IN ('completed','attention_required')
      AND (r.final_package_json IS NOT NULL OR r.status='attention_required') AND COALESCE(e.applied,0)<>1
      AND julianday(r.updated_at)>=julianday('now','-15 minutes')
    ORDER BY julianday(r.created_at) ASC,r.batch_key ASC LIMIT ?`).bind(boundedLimit).all<{batch_key:string}>();
  return (rows.results ?? []).map((row) => row.batch_key);
}

export type PendingConversationArchiveRow = {
  batch_key: string;
  user_text: string;
  final_package_json: string | null;
  status: string;
  created_at: string;
};

/**
 * Project only the fresh, not-yet-archived suffix after Memory's durable
 * conversation watermark. Rows older than the watermark are legacy recovery
 * debt, not a valid suffix: appending them after newer state reorders the
 * provider prompt and destroys Anthropic's rolling prefix cache.
 */
export async function pendingTgConversationArchiveRows(
  db: D1Database,
  chatId: string,
  afterIso: string | null | undefined,
  limit = 6,
): Promise<PendingConversationArchiveRow[]> {
  const boundedLimit = Math.max(1, Math.min(24, Math.floor(limit)));
  const watermark = afterIso?.trim() || null;
  const rows = await db.prepare(`SELECT r.batch_key,r.user_text,r.final_package_json,r.status,r.created_at
    FROM tg_chat_inference_runs r
    LEFT JOIN conversation_turn_events e ON e.event_id=('batch:' || r.batch_key)
    WHERE r.chat_id=? AND r.status IN ('delivery_pending','completed','attention_required')
      AND (r.final_package_json IS NOT NULL OR r.status='attention_required') AND COALESCE(e.applied,0)=0
      AND julianday(r.updated_at)>=julianday('now','-15 minutes')
      AND (? IS NULL OR julianday(r.created_at)>julianday(?))
    ORDER BY julianday(r.created_at) ASC,r.batch_key ASC LIMIT ?`)
    .bind(chatId,watermark,watermark,boundedLimit).all<PendingConversationArchiveRow>();
  return rows.results ?? [];
}
