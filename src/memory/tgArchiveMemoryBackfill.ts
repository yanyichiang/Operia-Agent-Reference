import { getOrCreateConversation } from "../db/conversations";
import type { Env, OpenAIChatResponse } from "../types";
import { thinkSystemNotice } from "../tg/thinkApprovalPresentation";
import { sha256Hex } from "../utils/hash";
import { indexPendingEpisodic } from "./episodic";

const BACKFILL_RUN_ID = "tg-owner-private-history-v1";
const SOURCE_BATCH_SIZE = 25;
const SOURCE_BATCHES_PER_CYCLE = 4;
const INDEX_BATCHES_PER_CYCLE = 2;
const LEASE_MILLISECONDS = 120_000;

type BackfillRunRow = {
  status: "running" | "indexing" | "completed" | "attention" | "error";
  source_complete: number;
  cursor_created_at: string | null;
  cursor_batch_key: string | null;
  source_runs_scanned: number;
  user_messages_inserted: number;
  assistant_messages_inserted: number;
  existing_messages: number;
  partial_items: number;
  first_source_at: string | null;
  last_source_at: string | null;
};

type SourceRow = {
  batch_key: string;
  user_text: string;
  final_package_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  user_occurred_at: string | null;
};

type ProjectionStatus = {
  total_refs: number;
  missing_projection: number;
  pending: number;
  ready: number;
  failed: number;
};

export type TgArchiveMemoryBackfillResult = {
  ran: boolean;
  status: BackfillRunRow["status"] | "disabled" | "busy";
  sourceComplete: boolean;
  sourceRunsScanned: number;
  userMessagesInserted: number;
  assistantMessagesInserted: number;
  existingMessages: number;
  partialItems: number;
  projection: ProjectionStatus;
  indexedThisCycle: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedIso(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  throw new Error("tg_archive_backfill_timestamp_invalid");
}

function normalizeContent(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function assistantTextFromResponse(response: OpenAIChatResponse): string {
  if (thinkSystemNotice(response)) return "";
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (content == null) return "";
  return JSON.stringify(content).trim();
}

function parseAssistantText(encoded: string): { text: string; errorCode: string | null } {
  try {
    const decoded: unknown = JSON.parse(encoded);
    if (!isRecord(decoded) || !isRecord(decoded.response)) {
      return { text: "", errorCode: "invalid_final_package" };
    }
    return { text: assistantTextFromResponse(decoded.response as OpenAIChatResponse), errorCode: null };
  } catch {
    return { text: "", errorCode: "invalid_final_package" };
  }
}

async function messageIds(conversationId: string, namespace: string, batchKey: string): Promise<{
  userId: string;
  assistantId: string;
  userIdempotencyHash: string;
  assistantIdempotencyHash: string;
}> {
  const idempotencyKey = `tg:${batchKey}`;
  const [userIdempotencyHash, assistantIdempotencyHash] = await Promise.all([
    sha256Hex(`${conversationId}:${namespace}:user:${idempotencyKey}`),
    sha256Hex(`${conversationId}:${namespace}:assistant-final:${idempotencyKey}`),
  ]);
  return {
    userId: `msg_${userIdempotencyHash.slice(0, 32)}`,
    assistantId: `msg_${assistantIdempotencyHash.slice(0, 32)}`,
    userIdempotencyHash,
    assistantIdempotencyHash,
  };
}

async function ensureRun(db: D1Database, namespace: string, now: string): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO tg_archive_memory_backfill_runs(
    id,namespace,status,started_at,updated_at
  ) VALUES(?,?,'running',?,?)`).bind(BACKFILL_RUN_ID, namespace, now, now).run();
}

async function readRun(db: D1Database): Promise<BackfillRunRow> {
  const row = await db.prepare(`SELECT status,source_complete,cursor_created_at,cursor_batch_key,
    source_runs_scanned,user_messages_inserted,assistant_messages_inserted,existing_messages,
    partial_items,first_source_at,last_source_at
    FROM tg_archive_memory_backfill_runs WHERE id=?`).bind(BACKFILL_RUN_ID).first<BackfillRunRow>();
  if (!row) throw new Error("tg_archive_backfill_run_missing");
  return row;
}

async function claimRun(db: D1Database, leaseToken: string, now: string, leaseUntil: string): Promise<boolean> {
  const row = await db.prepare(`UPDATE tg_archive_memory_backfill_runs
    SET lease_token=?,lease_until=?,status=CASE WHEN status='error' THEN 'running' ELSE status END,updated_at=?
    WHERE id=? AND status NOT IN ('completed','attention')
      AND (lease_until IS NULL OR julianday(lease_until)<=julianday(?))
    RETURNING id`).bind(leaseToken, leaseUntil, now, BACKFILL_RUN_ID, now).first<{ id: string }>();
  return Boolean(row);
}

async function sourceRows(
  db: D1Database,
  ownerId: string,
  cursorCreatedAt: string | null,
  cursorBatchKey: string | null,
): Promise<SourceRow[]> {
  const rows = await db.prepare(`SELECT r.batch_key,r.user_text,r.final_package_json,r.created_at,
      r.updated_at,r.completed_at,
      COALESCE((SELECT MIN(inbox.created_at)
        FROM json_each(r.inbox_ids_json) source_ids
        JOIN tg_inbox inbox ON inbox.id=CAST(source_ids.value AS INTEGER)),r.created_at) AS user_occurred_at
    FROM tg_chat_inference_runs r
    WHERE r.chat_id=? AND r.status='completed' AND r.final_package_json IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM tg_agent_rooms room WHERE room.chat_id=r.chat_id)
      AND NOT EXISTS(SELECT 1 FROM tg_archive_memory_backfill_items item WHERE item.source_batch_key=r.batch_key)
      AND (? IS NULL OR julianday(r.created_at)>julianday(?)
        OR (julianday(r.created_at)=julianday(?) AND r.batch_key>?))
    ORDER BY julianday(r.created_at) ASC,r.batch_key ASC LIMIT ?`)
    .bind(ownerId, cursorCreatedAt, cursorCreatedAt, cursorCreatedAt, cursorBatchKey ?? "", SOURCE_BATCH_SIZE)
    .all<SourceRow>();
  return rows.results ?? [];
}

async function existingMessageIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT id FROM messages WHERE id IN (${placeholders})`)
    .bind(...ids).all<{ id: string }>();
  return new Set((rows.results ?? []).map((row) => row.id));
}

async function applySourceBatch(
  env: Env,
  namespace: string,
  conversationId: string,
  rows: SourceRow[],
  now: string,
): Promise<{ users: number; assistants: number; existing: number; partial: number }> {
  const prepared = await Promise.all(rows.map(async (row) => {
    const ids = await messageIds(conversationId, namespace, row.batch_key);
    const assistant = parseAssistantText(row.final_package_json);
    const userText = row.user_text;
    const userValid = normalizeContent(userText).length > 0;
    const userAt = normalizedIso(row.user_occurred_at, row.created_at);
    const assistantAt = normalizedIso(row.completed_at, row.updated_at, row.created_at);
    const errorCode = userValid ? assistant.errorCode : "empty_user_text";
    const assistantText = userValid ? assistant.text : "";
    const outcome = errorCode ? "partial" : assistantText ? "applied" : "user_only";
    return { row, ids, userText, userValid, userAt, assistantAt, assistantText, errorCode, outcome };
  }));
  const expectedIds = prepared.flatMap((item) => [
    ...(item.userValid ? [item.ids.userId] : []),
    ...(item.assistantText ? [item.ids.assistantId] : []),
  ]);
  const existing = await existingMessageIds(env.DB, expectedIds);
  let insertedUsers = 0;
  let insertedAssistants = 0;
  let existingCount = 0;
  let partialCount = 0;
  const statements: D1PreparedStatement[] = [];

  for (const item of prepared) {
    if (item.userValid) {
      const contentHash = await sha256Hex(`${conversationId}:user:${normalizeContent(item.userText)}`);
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO messages(
        id,conversation_id,namespace,role,content,source,client_message_hash,stream,created_at
      ) VALUES(?,?,?,'user',?,'telegram',?,0,?)`).bind(
        item.ids.userId, conversationId, namespace, item.userText, contentHash, item.userAt,
      ));
      if (existing.has(item.ids.userId)) existingCount += 1;
      else insertedUsers += 1;
    }
    if (item.assistantText) {
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO messages(
        id,conversation_id,namespace,role,content,source,client_message_hash,stream,finish_reason,created_at
      ) VALUES(?,?,?,'assistant',?,'telegram',?,0,'stop',?)`).bind(
        item.ids.assistantId, conversationId, namespace, item.assistantText,
        item.ids.assistantIdempotencyHash, item.assistantAt,
      ));
      if (existing.has(item.ids.assistantId)) existingCount += 1;
      else insertedAssistants += 1;
    }
    if (item.outcome === "partial") partialCount += 1;
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO tg_archive_memory_backfill_items(
      source_batch_key,run_id,namespace,source_created_at,user_message_id,assistant_message_id,
      outcome,error_code,processed_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      item.row.batch_key, BACKFILL_RUN_ID, namespace, item.row.created_at,
      item.userValid ? item.ids.userId : null, item.assistantText ? item.ids.assistantId : null,
      item.outcome, item.errorCode, now,
    ));
  }

  const last = rows.at(-1)!;
  statements.push(env.DB.prepare(`UPDATE tg_archive_memory_backfill_runs SET
    cursor_created_at=?,cursor_batch_key=?,source_runs_scanned=source_runs_scanned+?,
    user_messages_inserted=user_messages_inserted+?,assistant_messages_inserted=assistant_messages_inserted+?,
    existing_messages=existing_messages+?,partial_items=partial_items+?,
    first_source_at=COALESCE(first_source_at,?),last_source_at=?,updated_at=?
    WHERE id=?`).bind(
    last.created_at, last.batch_key, rows.length, insertedUsers, insertedAssistants,
    existingCount, partialCount, rows[0].created_at, last.created_at, now, BACKFILL_RUN_ID,
  ));
  await env.DB.batch(statements);
  return { users: insertedUsers, assistants: insertedAssistants, existing: existingCount, partial: partialCount };
}

async function projectionStatus(db: D1Database): Promise<ProjectionStatus> {
  const row = await db.prepare(`WITH refs(message_id) AS (
      SELECT user_message_id FROM tg_archive_memory_backfill_items
        WHERE run_id=? AND user_message_id IS NOT NULL
      UNION ALL
      SELECT assistant_message_id FROM tg_archive_memory_backfill_items
        WHERE run_id=? AND assistant_message_id IS NOT NULL
    )
    SELECT COUNT(*) AS total_refs,
      SUM(CASE WHEN p.id IS NULL THEN 1 ELSE 0 END) AS missing_projection,
      SUM(CASE WHEN p.vector_status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN p.vector_status='ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN p.vector_status='failed' THEN 1 ELSE 0 END) AS failed
    FROM refs LEFT JOIN episodic_projections p ON p.canonical_message_id=refs.message_id`)
    .bind(BACKFILL_RUN_ID, BACKFILL_RUN_ID).first<ProjectionStatus>();
  return {
    total_refs: row?.total_refs ?? 0,
    missing_projection: row?.missing_projection ?? 0,
    pending: row?.pending ?? 0,
    ready: row?.ready ?? 0,
    failed: row?.failed ?? 0,
  };
}

function resultFor(run: BackfillRunRow, projection: ProjectionStatus, ran: boolean, indexedThisCycle: number): TgArchiveMemoryBackfillResult {
  return {
    ran,
    status: run.status,
    sourceComplete: run.source_complete === 1,
    sourceRunsScanned: run.source_runs_scanned,
    userMessagesInserted: run.user_messages_inserted,
    assistantMessagesInserted: run.assistant_messages_inserted,
    existingMessages: run.existing_messages,
    partialItems: run.partial_items,
    projection,
    indexedThisCycle,
  };
}

export async function runTgArchiveMemoryBackfillCycle(env: Env, namespace = "default"): Promise<TgArchiveMemoryBackfillResult> {
  const emptyProjection: ProjectionStatus = { total_refs: 0, missing_projection: 0, pending: 0, ready: 0, failed: 0 };
  if (env.WORKER_ROLE !== "tgbot" || env.TG_ARCHIVE_MEMORY_BACKFILL_ENABLED !== "true") {
    return { ran: false, status: "disabled", sourceComplete: false, sourceRunsScanned: 0,
      userMessagesInserted: 0, assistantMessagesInserted: 0, existingMessages: 0, partialItems: 0,
      projection: emptyProjection, indexedThisCycle: 0 };
  }
  const ownerId = env.TG_AGENT_OWNER_ID?.trim();
  if (!ownerId) throw new Error("tg_archive_backfill_owner_missing");
  const now = new Date().toISOString();
  await ensureRun(env.DB, namespace, now);
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
    const conversation = await getOrCreateConversation(env.DB, { namespace });
    let run = await readRun(env.DB);
    let sourceComplete = run.source_complete === 1;
    for (let batch = 0; batch < SOURCE_BATCHES_PER_CYCLE && !sourceComplete; batch += 1) {
      const rows = await sourceRows(env.DB, ownerId, run.cursor_created_at, run.cursor_batch_key);
      if (rows.length === 0) {
        sourceComplete = true;
        await env.DB.prepare(`UPDATE tg_archive_memory_backfill_runs
          SET source_complete=1,status='indexing',updated_at=? WHERE id=? AND lease_token=?`)
          .bind(new Date().toISOString(), BACKFILL_RUN_ID, leaseToken).run();
        break;
      }
      await applySourceBatch(env, namespace, conversation.id, rows, new Date().toISOString());
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
    const status: BackfillRunRow["status"] = sourceComplete && indexComplete
      ? run.partial_items > 0 ? "attention" : "completed"
      : sourceComplete ? "indexing" : "running";
    const finishedAt = status === "completed" || status === "attention" ? new Date().toISOString() : null;
    await env.DB.prepare(`UPDATE tg_archive_memory_backfill_runs SET status=?,lease_token=NULL,lease_until=NULL,
      last_error_code=NULL,updated_at=?,completed_at=? WHERE id=? AND lease_token=?`)
      .bind(status, new Date().toISOString(), finishedAt, BACKFILL_RUN_ID, leaseToken).run();
    return resultFor(await readRun(env.DB), projection, true, indexedThisCycle);
  } catch {
    await env.DB.prepare(`UPDATE tg_archive_memory_backfill_runs SET status='error',lease_token=NULL,lease_until=NULL,
      last_error_code='cycle_failed',updated_at=? WHERE id=? AND lease_token=?`)
      .bind(new Date().toISOString(), BACKFILL_RUN_ID, leaseToken).run();
    console.error("tg_archive_memory_backfill_failed", { code: "cycle_failed" });
    return resultFor(await readRun(env.DB), await projectionStatus(env.DB), true, 0);
  }
}

