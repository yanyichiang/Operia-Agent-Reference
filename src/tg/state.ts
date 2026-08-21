import { nowIso } from "../utils/time";
import { adaptiveQuietDelayMsForTimestamps } from "./scheduling";

export { adaptiveQuietDelayMsForTimestamps } from "./scheduling";

export interface TgInboxRow {
  id: number;
  message_id: number | null;
  update_id: number | null;
  text: string;
  kind: "text" | "voice" | "audio" | "image" | "sticker" | "reaction";
  payload_json: string;
  attempts: number;
  created_at: string;
}

export async function insertInbox(
  db: D1Database,
  input: { chatId: string; messageId?: number; updateId?: number; text: string; kind?: TgInboxRow["kind"]; payload?: Record<string, unknown>;
    heartbeatActivity?: { eventKey: string; kind: "natural_text" | "natural_voice"; occurredAt?: string } }
): Promise<void> {
  // OR IGNORE: Telegram redelivers the same update after any non-2xx webhook
  // answer; the (chat_id, message_id) unique index makes the retry a no-op.
  const now = nowIso();
  const statements = [db.prepare("INSERT OR IGNORE INTO tg_inbox (chat_id, message_id, update_id, text, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(input.chatId, input.messageId ?? null, input.updateId ?? null, input.text, input.kind ?? "text", JSON.stringify(input.payload ?? {}), now)];
  if (input.heartbeatActivity) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO tg_heartbeat_activity_outbox
      (event_key,chat_id,kind,occurred_at,status,attempts,created_at,updated_at) VALUES (?,?,?,?,'pending',0,?,?)`)
      .bind(input.heartbeatActivity.eventKey, input.chatId, input.heartbeatActivity.kind, input.heartbeatActivity.occurredAt ?? now, now, now));
  }
  await db.batch(statements);
}

export async function insertHeartbeatActivity(
  db: D1Database,
  input: { eventKey: string; chatId: string; kind: "natural_text" | "natural_voice"; occurredAt?: string },
): Promise<void> {
  const now = nowIso();
  await db.prepare(`INSERT OR IGNORE INTO tg_heartbeat_activity_outbox
    (event_key,chat_id,kind,occurred_at,status,attempts,created_at,updated_at) VALUES (?,?,?,?,'pending',0,?,?)`)
    .bind(input.eventKey, input.chatId, input.kind, input.occurredAt ?? now, now, now).run();
}

/**
 * Atomically claim every unprocessed message for this chat. A single UPDATE …
 * RETURNING keeps concurrent queue deliveries from double-processing: the
 * first consumer takes the whole batch, later ones get an empty set.
 */
export async function claimInbox(db: D1Database, chatId: string, claimToken: string, leaseSeconds: number): Promise<TgInboxRow[]> {
  const leaseUntil = new Date(Date.now() + Math.max(30, leaseSeconds) * 1000).toISOString();
  const result = await db
    .prepare(`UPDATE tg_inbox SET processed=1,attempts=attempts+1,claim_token=?,claim_lease_until=?,handed_off_at=NULL
      WHERE chat_id=? AND processed=0
      RETURNING id,message_id,update_id,text,kind,payload_json,attempts,created_at`)
    .bind(claimToken, leaseUntil, chatId)
    .all<TgInboxRow>();
  return (result.results ?? []).sort((a, b) => a.id - b.id);
}

export async function hasPendingInbox(db: D1Database, chatId: string): Promise<boolean> {
  return Boolean(await db.prepare("SELECT 1 AS pending FROM tg_inbox WHERE chat_id=? AND processed=0 LIMIT 1")
    .bind(chatId).first<{ pending: number }>());
}

export async function getInboxAdaptiveQuietDelayMs(
  db: D1Database,
  chatId: string,
  quietMs: number,
  maxWindowMs: number,
  nowMs = Date.now(),
): Promise<number> {
  const row = await db.prepare(
    `SELECT MIN(created_at) AS oldest_created_at,MAX(created_at) AS latest_created_at
      FROM tg_inbox WHERE chat_id=? AND processed=0`
  ).bind(chatId).first<{ oldest_created_at: string | null; latest_created_at: string | null }>();
  if (!row?.oldest_created_at || !row.latest_created_at) return 0;
  return adaptiveQuietDelayMsForTimestamps(row.oldest_created_at,row.latest_created_at,quietMs,maxWindowMs,nowMs);
}

/** Roll back a failed claim so the queue retry sees the messages again. */
export async function unclaimInbox(db: D1Database, ids: number[], claimToken: string): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await db
    .prepare(`UPDATE tg_inbox SET processed=0,claim_token=NULL,claim_lease_until=NULL,handed_off_at=NULL
      WHERE claim_token=? AND id IN (${placeholders})`)
    .bind(claimToken,...ids)
    .run();
}

/** The inference run is now the recovery anchor for these claimed rows. */
export async function markInboxHandedOff(db: D1Database, ids: number[], claimToken: string): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await db.prepare(`UPDATE tg_inbox SET handed_off_at=?,claim_lease_until=NULL
    WHERE claim_token=? AND id IN (${placeholders})`)
    .bind(nowIso(), claimToken, ...ids).run();
}

/** Recover only claims that crashed before a durable inference run existed. */
export async function recoverExpiredInboxClaims(db: D1Database): Promise<number> {
  const result = await db.prepare(`UPDATE tg_inbox SET processed=0,claim_token=NULL,claim_lease_until=NULL
    WHERE processed=1 AND handed_off_at IS NULL AND claim_lease_until IS NOT NULL AND claim_lease_until < ?`)
    .bind(nowIso()).run();
  return result.meta.changes ?? 0;
}

export async function markInboxError(db: D1Database, id: number, error: string): Promise<void> {
  await db.prepare("UPDATE tg_inbox SET last_error = ? WHERE id = ?").bind(error.slice(0, 300), id).run();
}
