import type { Env, TgDraftPreviewQueueMessage } from "../types";
import { requireBotToken } from "./telegram";

const MAX_DRAFT_CHARS = 4096;
const FINAL_CLOSE_SEQ = 2_147_483_647;
const MAX_DRAIN_SNAPSHOTS = 32;
const DRAFT_REQUEST_TIMEOUT_MS = 2_000;
const DRAFT_LEASE_ABORT_GRACE_MS = 250;
const FINAL_BARRIER_MAX_WAIT_MS = 2_500;
const FINAL_BARRIER_POLL_MS = 25;
const TG_API_BASE = "https://api.telegram.org";
const draftFetch = fetch;
const GENERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPEN_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const CLOSED_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

type DraftRow = {
  generation: string;
  chat_id: string;
  draft_id: number;
  desired_seq: number;
  desired_order: number;
  delivered_seq: number;
  closed: number;
  pending_text: string | null;
  final_closed: number;
};

function enabled(env: Env): boolean {
  return env.TG_DRAFT_PREVIEW_ENABLED?.trim().toLowerCase() === "true";
}

function strictPrivateChatId(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value) return null;
  return parsed;
}

function validMessage(message: TgDraftPreviewQueueMessage): boolean {
  return /^[a-f0-9]{64}$/.test(message.batchKey)
    && GENERATION_RE.test(message.generation)
    && Number.isSafeInteger(message.seq) && message.seq > 0 && message.seq < FINAL_CLOSE_SEQ
    && (message.phase === "snapshot" || message.phase === "close")
    && (message.phase === "snapshot"
      ? typeof message.text === "string"
      : message.text === undefined);
}

function stableDraftId(batchKey: string, generation: string): number {
  let hash = 2_166_136_261;
  for (const character of `${batchKey}:${generation}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return ((hash >>> 0) % 2_147_483_646) + 1;
}

function boundedDraftText(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trimEnd();
  return normalized.length <= MAX_DRAFT_CHARS ? normalized : `…${normalized.slice(-(MAX_DRAFT_CHARS - 1))}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve,ms));
}

async function sendDraftRequest(
  env: Env,
  payload: { chat_id: number; draft_id: number; text: string },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("tg_draft_preview_timeout"),DRAFT_REQUEST_TIMEOUT_MS);
  try {
    const token = requireBotToken(env);
    return await draftFetch(`${TG_API_BASE}/bot${token}/sendMessageDraft`,{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify(payload),
      signal:controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function openBatch(
  env: Env,
  batchKey: string,
  chatId: string,
  now: string,
): Promise<boolean> {
  const accepted = await env.DB.prepare(`INSERT INTO tg_draft_preview_batches
    (batch_key,chat_id,final_closed,updated_at) VALUES (?,?,0,?)
    ON CONFLICT(batch_key) DO UPDATE SET updated_at=excluded.updated_at
    WHERE tg_draft_preview_batches.final_closed=0
      AND tg_draft_preview_batches.chat_id=excluded.chat_id
    RETURNING batch_key`)
    .bind(batchKey,chatId,now).first<{ batch_key: string }>();
  return Boolean(accepted);
}

async function closeGeneration(
  env: Env,
  message: TgDraftPreviewQueueMessage,
  chatId: string,
  draftId: number,
  now: string,
): Promise<void> {
  await env.DB.prepare(`INSERT INTO tg_draft_previews
    (batch_key,generation,chat_id,draft_id,desired_seq,desired_order,delivered_seq,closed,pending_text,last_text_hash,updated_at)
    VALUES (?,?,?,?,?,0,0,1,NULL,NULL,?)
    ON CONFLICT(batch_key,generation) DO UPDATE SET
      desired_seq=CASE WHEN excluded.desired_seq > tg_draft_previews.desired_seq
        THEN excluded.desired_seq ELSE tg_draft_previews.desired_seq END,
      closed=1,pending_text=NULL,updated_at=excluded.updated_at`)
    .bind(message.batchKey,message.generation,chatId,draftId,message.seq,now).run();
}

async function allocateDesiredOrder(env: Env, batchKey: string, now: string): Promise<number | null> {
  const row = await env.DB.prepare(`UPDATE tg_draft_preview_batches
    SET next_order=next_order+1,updated_at=?
    WHERE batch_key=? AND final_closed=0
    RETURNING next_order`)
    .bind(now,batchKey).first<{ next_order: number }>();
  return row && Number.isSafeInteger(row.next_order) && row.next_order > 0 ? row.next_order : null;
}

async function recordDesiredSnapshot(
  env: Env,
  message: TgDraftPreviewQueueMessage,
  chatId: string,
  draftId: number,
  desiredOrder: number,
  text: string,
  now: string,
): Promise<boolean> {
  const accepted = await env.DB.prepare(`INSERT INTO tg_draft_previews
    (batch_key,generation,chat_id,draft_id,desired_seq,desired_order,delivered_seq,closed,pending_text,last_text_hash,updated_at)
    VALUES (?,?,?,?,?,?,0,0,?,?,?)
    ON CONFLICT(batch_key,generation) DO UPDATE SET
      desired_seq=excluded.desired_seq,desired_order=excluded.desired_order,pending_text=excluded.pending_text,
      last_text_hash=excluded.last_text_hash,updated_at=excluded.updated_at
    WHERE tg_draft_previews.closed=0
      AND tg_draft_previews.desired_seq < excluded.desired_seq
    RETURNING batch_key`)
    .bind(message.batchKey,message.generation,chatId,draftId,message.seq,desiredOrder,text,await sha256Hex(text),now)
    .first<{ batch_key: string }>();
  return Boolean(accepted);
}

async function acquireDrainLease(
  env: Env,
  batchKey: string,
  leaseToken: string,
  now: string,
): Promise<boolean> {
  // A batch lease is deliberately never stolen. If an invocation dies with an
  // unknown Telegram outcome, that batch stops previewing instead of risking a
  // second overlapping request. The canonical final remains independent.
  const leaseDeadline = new Date(Date.now()+DRAFT_REQUEST_TIMEOUT_MS+DRAFT_LEASE_ABORT_GRACE_MS).toISOString();
  const acquired = await env.DB.prepare(`UPDATE tg_draft_preview_batches
    SET lease_token=?,lease_deadline=?,updated_at=?
    WHERE batch_key=? AND final_closed=0 AND lease_token IS NULL
      AND EXISTS (
        SELECT 1 FROM tg_draft_previews p
        WHERE p.batch_key=tg_draft_preview_batches.batch_key
          AND p.closed=0 AND p.delivered_seq < p.desired_seq
      )
    RETURNING batch_key`)
    .bind(leaseToken,leaseDeadline,now,batchKey).first<{ batch_key: string }>();
  return Boolean(acquired);
}

async function readDrainRow(
  env: Env,
  batchKey: string,
  leaseToken: string,
): Promise<DraftRow | null> {
  return env.DB.prepare(`SELECT p.generation,p.chat_id,p.draft_id,p.desired_seq,p.desired_order,p.delivered_seq,
      p.closed,p.pending_text,b.final_closed
    FROM tg_draft_previews p
    JOIN tg_draft_preview_batches b ON b.batch_key=p.batch_key
    WHERE p.batch_key=? AND b.lease_token=? AND p.closed=0
      AND p.delivered_seq < p.desired_seq
    ORDER BY p.desired_order DESC LIMIT 1`)
    .bind(batchKey,leaseToken).first<DraftRow>();
}

async function renewDrainLeaseForRequest(
  env: Env,
  batchKey: string,
  leaseToken: string,
): Promise<boolean> {
  const nowMs = Date.now();
  const renewed = await env.DB.prepare(`UPDATE tg_draft_preview_batches
    SET lease_deadline=?,updated_at=?
    WHERE batch_key=? AND lease_token=? AND final_closed=0
    RETURNING batch_key`)
    .bind(
      new Date(nowMs+DRAFT_REQUEST_TIMEOUT_MS+DRAFT_LEASE_ABORT_GRACE_MS).toISOString(),
      new Date(nowMs).toISOString(),
      batchKey,
      leaseToken,
    ).first<{ batch_key: string }>();
  return Boolean(renewed);
}

async function markSnapshotAttempted(
  env: Env,
  batchKey: string,
  leaseToken: string,
  desiredOrder: number,
  now: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE tg_draft_previews SET
      delivered_seq=desired_seq,pending_text=NULL,
      updated_at=?
    WHERE batch_key=? AND desired_order <= ?
      AND EXISTS (
        SELECT 1 FROM tg_draft_preview_batches b
        WHERE b.batch_key=tg_draft_previews.batch_key AND b.lease_token=?
      )`)
    .bind(now,batchKey,desiredOrder,leaseToken).run();
}

async function releaseDrainLease(
  env: Env,
  batchKey: string,
  leaseToken: string,
  now: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE tg_draft_preview_batches
    SET lease_token=NULL,lease_deadline=NULL,updated_at=?
    WHERE batch_key=? AND lease_token=?`)
    .bind(now,batchKey,leaseToken).run();
}

async function drainSnapshots(
  env: Env,
  batchKey: string,
): Promise<void> {
  const leaseToken = crypto.randomUUID();
  if (!await acquireDrainLease(env,batchKey,leaseToken,new Date().toISOString())) return;
  try {
    for (let drained = 0; drained < MAX_DRAIN_SNAPSHOTS; drained += 1) {
      const row = await readDrainRow(env,batchKey,leaseToken);
      if (!row || row.closed === 1 || row.final_closed === 1
        || row.delivered_seq >= row.desired_seq || row.pending_text == null) return;
      const chatId = strictPrivateChatId(row.chat_id);
      if (chatId == null || !Number.isSafeInteger(row.draft_id) || row.draft_id <= 0) return;
      // Close may tombstone the batch after the row read. Renewing with
      // final_closed=0 is the last atomic gate before opening the network call.
      if (!await renewDrainLeaseForRequest(env,batchKey,leaseToken)) return;
      try {
        const response = await sendDraftRequest(env,{
          chat_id:chatId,
          draft_id:row.draft_id,
          text:row.pending_text,
        });
        if (!response.ok) {
          console.warn("tg_draft_preview_rejected",{ status:response.status,batch_key:batchKey.slice(0,12) });
        }
      } catch (error) {
        // Preview delivery is at-most-once. Treat a transport exception as an
        // unknown completed attempt and never feed it into Queue retry.
        console.warn("tg_draft_preview_unknown",{ code:String(error).slice(0,120),batch_key:batchKey.slice(0,12) });
      }
      await markSnapshotAttempted(env,batchKey,leaseToken,row.desired_order,new Date().toISOString());
    }
  } finally {
    await releaseDrainLease(env,batchKey,leaseToken,new Date().toISOString());
  }
}

export async function handleTgDraftPreview(env: Env, message: TgDraftPreviewQueueMessage): Promise<void> {
  if (!enabled(env) || !validMessage(message)) return;
  const ownerChatId = strictPrivateChatId(env.TG_AGENT_OWNER_ID?.trim());
  const run = await env.DB.prepare("SELECT chat_id FROM tg_chat_inference_runs WHERE batch_key=?")
    .bind(message.batchKey).first<{ chat_id: string }>();
  const runChatId = strictPrivateChatId(run?.chat_id);
  if (ownerChatId == null || runChatId == null || runChatId !== ownerChatId) return;

  const now = new Date().toISOString();
  if (!await openBatch(env,message.batchKey,String(runChatId),now)) return;
  const draftId = stableDraftId(message.batchKey,message.generation);
  if (message.phase === "close") {
    await closeGeneration(env,message,String(runChatId),draftId,now);
    return;
  }

  const text = boundedDraftText(message.text ?? "");
  const desiredOrder = await allocateDesiredOrder(env,message.batchKey,now);
  if (desiredOrder == null
    || !await recordDesiredSnapshot(env,message,String(runChatId),draftId,desiredOrder,text,now)) return;
  await drainSnapshots(env,message.batchKey);
}

export async function cleanupTgDraftPreviewRetention(
  env: Pick<Env, "DB">,
  nowMs = Date.now(),
): Promise<void> {
  const openCutoff = new Date(nowMs - OPEN_RETENTION_MS).toISOString();
  const closedCutoff = new Date(nowMs - CLOSED_RETENTION_MS).toISOString();
  await env.DB.prepare(`DELETE FROM tg_draft_previews
    WHERE (closed=0 AND updated_at < ?) OR (closed=1 AND updated_at < ?)`)
    .bind(openCutoff,closedCutoff).run();
  await env.DB.prepare(`DELETE FROM tg_draft_preview_batches
    WHERE updated_at < ? AND NOT EXISTS (
      SELECT 1 FROM tg_draft_previews p WHERE p.batch_key=tg_draft_preview_batches.batch_key
    )`).bind(closedCutoff).run();
}

async function waitForFinalDraftBarrier(
  env: Pick<Env, "DB">,
  batchKey: string,
  startedAtMs: number,
): Promise<{ drained: boolean; waitedMs: number }> {
  const hardDeadlineMs = startedAtMs+FINAL_BARRIER_MAX_WAIT_MS;
  while (true) {
    const row = await env.DB.prepare(`SELECT lease_token,lease_deadline
      FROM tg_draft_preview_batches WHERE batch_key=?`)
      .bind(batchKey).first<{ lease_token: string | null; lease_deadline: string | null }>();
    if (!row?.lease_token) return {drained:true,waitedMs:Date.now()-startedAtMs};
    const nowMs = Date.now();
    const leaseDeadlineMs = row.lease_deadline ? Date.parse(row.lease_deadline) : Number.NaN;
    if (Number.isFinite(leaseDeadlineMs) && nowMs >= leaseDeadlineMs) {
      // The draft fetch has a real AbortSignal deadline 250ms earlier. Clearing
      // here cannot race a still-live request; it only recovers a release write
      // lost after the aborted/completed fetch settled.
      await env.DB.prepare(`UPDATE tg_draft_preview_batches
        SET lease_token=NULL,lease_deadline=NULL,updated_at=?
        WHERE batch_key=? AND lease_token=? AND lease_deadline=?`)
        .bind(new Date(nowMs).toISOString(),batchKey,row.lease_token,row.lease_deadline).run();
      continue;
    }
    if (nowMs >= hardDeadlineMs) {
      // Defensive bound for malformed legacy rows without a deadline. Current
      // producers always set a deadline earlier than this hard ceiling.
      return {drained:false,waitedMs:nowMs-startedAtMs};
    }
    const nextWakeMs = Number.isFinite(leaseDeadlineMs)
      ? Math.min(FINAL_BARRIER_POLL_MS,Math.max(1,leaseDeadlineMs-nowMs))
      : FINAL_BARRIER_POLL_MS;
    await delay(nextWakeMs);
  }
}

export async function closeTgDraftPreviewForFinal(
  env: Env,
  batchKey: string,
  chatId: string,
): Promise<{ drained: boolean; waitedMs: number }> {
  const startedAtMs = Date.now();
  if (!/^[a-f0-9]{64}$/.test(batchKey)) return {drained:true,waitedMs:0};
  const numericChatId = strictPrivateChatId(chatId);
  if (numericChatId == null) return {drained:true,waitedMs:0};
  const canonicalChatId = String(numericChatId);
  const now = new Date().toISOString();
  // Do not gate final tombstones on TG_DRAFT_PREVIEW_ENABLED. During a
  // staggered rollout the producer and consumer flags can disagree; the final
  // must still close snapshots that arrive after the flags converge.
  const closed = await env.DB.prepare(`INSERT INTO tg_draft_preview_batches
    (batch_key,chat_id,final_closed,next_order,lease_token,lease_deadline,updated_at) VALUES (?,?,1,0,NULL,NULL,?)
    ON CONFLICT(batch_key) DO UPDATE SET final_closed=1,updated_at=excluded.updated_at
    WHERE tg_draft_preview_batches.chat_id=excluded.chat_id
    RETURNING batch_key`)
    .bind(batchKey,canonicalChatId,now).first<{ batch_key: string }>();
  if (!closed) return {drained:true,waitedMs:Date.now()-startedAtMs};
  await env.DB.prepare(`UPDATE tg_draft_previews
    SET desired_seq=?,closed=1,pending_text=NULL,updated_at=?
    WHERE batch_key=?`)
    .bind(FINAL_CLOSE_SEQ,now,batchKey).run();
  const barrier = await waitForFinalDraftBarrier(env,batchKey,startedAtMs);
  try {
    await cleanupTgDraftPreviewRetention(env);
  } catch (error) {
    console.warn("tg_draft_preview_retention_degraded",{ code:String(error).slice(0,120) });
  }
  return barrier;
}
