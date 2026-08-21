import type { Env } from "../types";
import { sha256Hex } from "../utils/hash";
import { indexPendingEpisodic } from "./episodic";

const BACKFILL_RUN_ID = "legacy_chat-import-history-v1";
const SOURCE_BATCH_SIZE = 25;
const SOURCE_BATCHES_PER_CYCLE = 16;
const INDEX_BATCHES_PER_CYCLE = 8;
const LEASE_MILLISECONDS = 120_000;
const EXACT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

type BackfillStatus = "running" | "indexing" | "completed" | "attention" | "error";

type BackfillRunRow = {
  status: BackfillStatus;
  source_complete: number;
  cursor_source_order: number | null;
  cursor_message_id: string | null;
  source_messages_scanned: number;
  user_messages_inserted: number;
  assistant_messages_inserted: number;
  existing_messages: number;
  attention_items: number;
  first_source_at: string | null;
  last_source_at: string | null;
};

type SourceRow = {
  message_id: string;
  import_conversation_id: string;
  source_order: number;
  canonical_role: "owner" | "assistant";
  private_normalized_text: string;
  content_sha256: string;
  occurred_at_utc: string;
  time_precision: string;
  conversation_started_at_utc: string | null;
  conversation_ended_at_utc: string | null;
};

type PreparedSource = SourceRow & {
  canonicalConversationId: string;
  canonicalMessageId: string;
  canonicalRole: "user" | "assistant";
  canonicalCreatedAt: string | null;
  conversationCreatedAt: string;
  conversationUpdatedAt: string;
  errorCode: string | null;
};

type ProjectionStatus = {
  total_refs: number;
  missing_projection: number;
  pending: number;
  ready: number;
  failed: number;
};

export type LegacyChatArchiveMemoryBackfillResult = {
  ran: boolean;
  status: BackfillStatus | "disabled" | "busy";
  sourceComplete: boolean;
  sourceMessagesScanned: number;
  userMessagesInserted: number;
  assistantMessagesInserted: number;
  existingMessages: number;
  attentionItems: number;
  projection: ProjectionStatus;
  indexedThisCycle: number;
};

export function normalizeLegacyChatOccurredAt(value: string, precision: string): string | null {
  if (precision !== "instant" || !EXACT_INSTANT.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function optionalInstant(value: string | null, fallback: string): string {
  if (!value || !EXACT_INSTANT.test(value)) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

async function canonicalIds(batchId: string, source: SourceRow): Promise<{
  conversationId: string;
  messageId: string;
}> {
  const [conversationHash, messageHash] = await Promise.all([
    sha256Hex(`legacy_chat-import-v1\u0000${batchId}\u0000${source.import_conversation_id}`),
    sha256Hex(`legacy_chat-import-v1\u0000${batchId}\u0000${source.message_id}`),
  ]);
  return {
    conversationId: `conv_${conversationHash.slice(0, 32)}`,
    messageId: `msg_${messageHash.slice(0, 32)}`,
  };
}

async function ensureRun(db: D1Database, namespace: string, batchId: string, now: string): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO legacyChatArchiveMemoryBackfill_runs(
    id,import_batch_id,namespace,status,started_at,updated_at
  ) VALUES(?,?,?,'running',?,?)`).bind(BACKFILL_RUN_ID, batchId, namespace, now, now).run();
}

async function readRun(db: D1Database): Promise<BackfillRunRow> {
  const row = await db.prepare(`SELECT status,source_complete,cursor_source_order,cursor_message_id,
    source_messages_scanned,user_messages_inserted,assistant_messages_inserted,existing_messages,
    attention_items,first_source_at,last_source_at
    FROM legacyChatArchiveMemoryBackfill_runs WHERE id=?`).bind(BACKFILL_RUN_ID).first<BackfillRunRow>();
  if (!row) throw new Error("legacy_chat_archive_backfill_run_missing");
  return row;
}

async function claimRun(db: D1Database, leaseToken: string, now: string, leaseUntil: string): Promise<boolean> {
  const row = await db.prepare(`UPDATE legacyChatArchiveMemoryBackfill_runs
    SET lease_token=?,lease_until=?,status=CASE WHEN status='error' THEN 'running' ELSE status END,updated_at=?
    WHERE id=? AND status NOT IN ('completed','attention')
      AND (lease_until IS NULL OR julianday(lease_until)<=julianday(?))
    RETURNING id`).bind(leaseToken, leaseUntil, now, BACKFILL_RUN_ID, now).first<{ id: string }>();
  return Boolean(row);
}

async function sourceRows(
  db: D1Database,
  batchId: string,
  cursorSourceOrder: number | null,
  cursorMessageId: string | null,
): Promise<SourceRow[]> {
  const rows = await db.prepare(`SELECT m.id AS message_id,m.conversation_id AS import_conversation_id,
      bm.source_order,m.canonical_role,m.private_normalized_text,m.content_sha256,m.occurred_at_utc,
      m.time_precision,c.started_at_utc AS conversation_started_at_utc,
      c.ended_at_utc AS conversation_ended_at_utc
    FROM conversation_import_messages m
    JOIN conversation_import_batch_messages bm ON bm.message_id=m.id AND bm.batch_id=? AND bm.active=1
    JOIN conversation_import_batch_conversations bc ON bc.batch_id=bm.batch_id
      AND bc.conversation_id=m.conversation_id AND bc.inclusion_status='included'
    JOIN conversation_import_conversations c ON c.id=m.conversation_id AND c.status='active'
    WHERE m.quarantine_status='none' AND m.canonical_role IN ('owner','assistant')
      AND m.content_type IN ('text','markdown','code','mixed')
      AND m.private_normalized_text IS NOT NULL AND trim(m.private_normalized_text)!=''
      AND NOT EXISTS(SELECT 1 FROM legacyChatArchiveMemoryBackfill_items item
        WHERE item.source_message_id=m.id)
      AND (? IS NULL OR bm.source_order>? OR (bm.source_order=? AND m.id>?))
    ORDER BY bm.source_order ASC,m.id ASC LIMIT ?`)
    .bind(batchId, cursorSourceOrder, cursorSourceOrder, cursorSourceOrder, cursorMessageId ?? "", SOURCE_BATCH_SIZE)
    .all<SourceRow>();
  return rows.results ?? [];
}

async function existingMessageIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT id FROM messages WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string }>();
  return new Set((rows.results ?? []).map((row) => row.id));
}

async function prepareSource(batchId: string, rows: SourceRow[]): Promise<PreparedSource[]> {
  return Promise.all(rows.map(async (row) => {
    const ids = await canonicalIds(batchId, row);
    const canonicalCreatedAt = normalizeLegacyChatOccurredAt(row.occurred_at_utc, row.time_precision);
    const fallback = canonicalCreatedAt ?? "1970-01-01T00:00:00.000Z";
    return {
      ...row,
      canonicalConversationId: ids.conversationId,
      canonicalMessageId: ids.messageId,
      canonicalRole: row.canonical_role === "owner" ? "user" : "assistant",
      canonicalCreatedAt,
      conversationCreatedAt: optionalInstant(row.conversation_started_at_utc, fallback),
      conversationUpdatedAt: optionalInstant(row.conversation_ended_at_utc, fallback),
      errorCode: canonicalCreatedAt ? null : "source_time_invalid",
    };
  }));
}

async function applySourceBatch(
  env: Env,
  namespace: string,
  batchId: string,
  rows: SourceRow[],
  now: string,
): Promise<void> {
  const prepared = await prepareSource(batchId, rows);
  const valid = prepared.filter((item) => !item.errorCode && item.canonicalCreatedAt);
  const existing = await existingMessageIds(env.DB, valid.map((item) => item.canonicalMessageId));
  const statements: D1PreparedStatement[] = [];
  const conversations = new Map<string, PreparedSource>();
  for (const item of valid) if (!conversations.has(item.canonicalConversationId)) conversations.set(item.canonicalConversationId, item);
  for (const item of conversations.values()) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO conversations(id,namespace,title,created_at,updated_at)
      VALUES(?,?,NULL,?,?)`).bind(
      item.canonicalConversationId, namespace, item.conversationCreatedAt, item.conversationUpdatedAt,
    ));
  }

  let users = 0;
  let assistants = 0;
  let existingCount = 0;
  let attention = 0;
  for (const item of prepared) {
    const exists = existing.has(item.canonicalMessageId);
    if (item.errorCode || !item.canonicalCreatedAt) {
      attention += 1;
    } else {
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO messages(
        id,conversation_id,namespace,role,content,source,client_message_hash,stream,finish_reason,created_at
      ) VALUES(?,?,?,?,?,'legacy_chat_import',?,0,?,?)`).bind(
        item.canonicalMessageId, item.canonicalConversationId, namespace, item.canonicalRole,
        item.private_normalized_text, item.content_sha256, item.canonicalRole === "assistant" ? "stop" : null,
        item.canonicalCreatedAt,
      ));
      if (exists) existingCount += 1;
      else if (item.canonicalRole === "user") users += 1;
      else assistants += 1;
    }
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO legacyChatArchiveMemoryBackfill_items(
      source_message_id,run_id,import_batch_id,source_conversation_id,canonical_conversation_id,
      canonical_message_id,source_order,canonical_role,source_occurred_at_utc,source_time_precision,
      canonical_created_at,outcome,error_code,processed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      item.message_id, BACKFILL_RUN_ID, batchId, item.import_conversation_id, item.canonicalConversationId,
      item.errorCode ? null : item.canonicalMessageId, item.source_order, item.canonicalRole,
      item.occurred_at_utc, item.time_precision, item.canonicalCreatedAt,
      item.errorCode ? "attention" : exists ? "existing" : "applied", item.errorCode, now,
    ));
  }

  const last = rows.at(-1)!;
  const validTimes = prepared
    .flatMap((item) => item.canonicalCreatedAt ? [item.canonicalCreatedAt] : [])
    .sort();
  statements.push(env.DB.prepare(`UPDATE legacyChatArchiveMemoryBackfill_runs SET
    cursor_source_order=?,cursor_message_id=?,source_messages_scanned=source_messages_scanned+?,
    user_messages_inserted=user_messages_inserted+?,assistant_messages_inserted=assistant_messages_inserted+?,
    existing_messages=existing_messages+?,attention_items=attention_items+?,
    first_source_at=CASE
      WHEN ? IS NULL THEN first_source_at
      WHEN first_source_at IS NULL OR ?<first_source_at THEN ?
      ELSE first_source_at END,
    last_source_at=CASE
      WHEN ? IS NULL THEN last_source_at
      WHEN last_source_at IS NULL OR ?>last_source_at THEN ?
      ELSE last_source_at END,
    updated_at=?
    WHERE id=?`).bind(
    last.source_order, last.message_id, rows.length, users, assistants, existingCount, attention,
    validTimes.at(0) ?? null, validTimes.at(0) ?? null, validTimes.at(0) ?? null,
    validTimes.at(-1) ?? null, validTimes.at(-1) ?? null, validTimes.at(-1) ?? null,
    now, BACKFILL_RUN_ID,
  ));
  await env.DB.batch(statements);
}

async function projectionStatus(db: D1Database): Promise<ProjectionStatus> {
  const row = await db.prepare(`WITH refs(message_id) AS (
      SELECT canonical_message_id FROM legacyChatArchiveMemoryBackfill_items
      WHERE run_id=? AND canonical_message_id IS NOT NULL
    )
    SELECT COUNT(*) AS total_refs,
      SUM(CASE WHEN p.id IS NULL THEN 1 ELSE 0 END) AS missing_projection,
      SUM(CASE WHEN p.vector_status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN p.vector_status='ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN p.vector_status='failed' THEN 1 ELSE 0 END) AS failed
    FROM refs LEFT JOIN episodic_projections p ON p.canonical_message_id=refs.message_id`)
    .bind(BACKFILL_RUN_ID).first<ProjectionStatus>();
  return {
    total_refs: row?.total_refs ?? 0,
    missing_projection: row?.missing_projection ?? 0,
    pending: row?.pending ?? 0,
    ready: row?.ready ?? 0,
    failed: row?.failed ?? 0,
  };
}

function resultFor(
  run: BackfillRunRow,
  projection: ProjectionStatus,
  ran: boolean,
  indexedThisCycle: number,
): LegacyChatArchiveMemoryBackfillResult {
  return {
    ran,
    status: run.status,
    sourceComplete: run.source_complete === 1,
    sourceMessagesScanned: run.source_messages_scanned,
    userMessagesInserted: run.user_messages_inserted,
    assistantMessagesInserted: run.assistant_messages_inserted,
    existingMessages: run.existing_messages,
    attentionItems: run.attention_items,
    projection,
    indexedThisCycle,
  };
}

export async function runLegacyChatArchiveMemoryBackfillCycle(
  env: Env,
  namespace = "default",
): Promise<LegacyChatArchiveMemoryBackfillResult> {
  const emptyProjection: ProjectionStatus = { total_refs: 0, missing_projection: 0, pending: 0, ready: 0, failed: 0 };
  if (env.WORKER_ROLE !== "tgbot" || env.LEGACY_CHAT_ARCHIVE_MEMORY_BACKFILL_ENABLED !== "true") {
    return { ran: false, status: "disabled", sourceComplete: false, sourceMessagesScanned: 0,
      userMessagesInserted: 0, assistantMessagesInserted: 0, existingMessages: 0, attentionItems: 0,
      projection: emptyProjection, indexedThisCycle: 0 };
  }
  const batchId = env.LEGACY_CHAT_ARCHIVE_MEMORY_BACKFILL_BATCH_ID?.trim();
  if (!batchId) throw new Error("legacy_chat_archive_backfill_batch_missing");
  const now = new Date().toISOString();
  await ensureRun(env.DB, namespace, batchId, now);
  const initial = await readRun(env.DB);
  if (initial.status === "completed" || initial.status === "attention") {
    return resultFor(initial, await projectionStatus(env.DB), false, 0);
  }
  const leaseToken = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + LEASE_MILLISECONDS).toISOString();
  if (!await claimRun(env.DB, leaseToken, now, leaseUntil)) {
    return { ...resultFor(await readRun(env.DB), await projectionStatus(env.DB), false, 0), status: "busy" };
  }

  try {
    let run = await readRun(env.DB);
    let sourceComplete = run.source_complete === 1;
    for (let batch = 0; batch < SOURCE_BATCHES_PER_CYCLE && !sourceComplete; batch += 1) {
      const rows = await sourceRows(env.DB, batchId, run.cursor_source_order, run.cursor_message_id);
      if (rows.length === 0) {
        sourceComplete = true;
        await env.DB.prepare(`UPDATE legacyChatArchiveMemoryBackfill_runs
          SET source_complete=1,status='indexing',updated_at=? WHERE id=? AND lease_token=?`)
          .bind(new Date().toISOString(), BACKFILL_RUN_ID, leaseToken).run();
        break;
      }
      await applySourceBatch(env, namespace, batchId, rows, new Date().toISOString());
      run = await readRun(env.DB);
    }

    let indexedThisCycle = 0;
    for (let batch = 0; batch < INDEX_BATCHES_PER_CYCLE; batch += 1) {
      const indexed = await indexPendingEpisodic(env, { namespace, limit: 50, includeFailed: true });
      indexedThisCycle += indexed.indexed;
      if (indexed.selected === 0 || indexed.indexed === 0) break;
    }
    const projection = await projectionStatus(env.DB);
    run = await readRun(env.DB);
    sourceComplete = run.source_complete === 1;
    const indexComplete = projection.missing_projection === 0 && projection.pending === 0 && projection.failed === 0;
    const status: BackfillStatus = sourceComplete && indexComplete
      ? run.attention_items > 0 ? "attention" : "completed"
      : sourceComplete ? "indexing" : "running";
    const finishedAt = status === "completed" || status === "attention" ? new Date().toISOString() : null;
    await env.DB.prepare(`UPDATE legacyChatArchiveMemoryBackfill_runs SET
      status=?,lease_token=NULL,lease_until=NULL,last_error_code=NULL,updated_at=?,completed_at=?
      WHERE id=? AND lease_token=?`).bind(
      status, new Date().toISOString(), finishedAt, BACKFILL_RUN_ID, leaseToken,
    ).run();
    return resultFor(await readRun(env.DB), projection, true, indexedThisCycle);
  } catch {
    await env.DB.prepare(`UPDATE legacyChatArchiveMemoryBackfill_runs SET
      status='error',lease_token=NULL,lease_until=NULL,last_error_code='cycle_failed',updated_at=?
      WHERE id=? AND lease_token=?`).bind(new Date().toISOString(), BACKFILL_RUN_ID, leaseToken).run();
    console.error("legacyChatArchiveMemoryBackfill_failed", { code: "cycle_failed" });
    return resultFor(await readRun(env.DB), await projectionStatus(env.DB), true, 0);
  }
}
