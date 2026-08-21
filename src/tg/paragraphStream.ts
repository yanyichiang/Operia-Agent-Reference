import type { Env, TgParagraphStreamItem } from "../types";
import { nowIso } from "../utils/time";
import { deliverTgOutbox } from "./outbox";
import { stageParagraphPublicationDelivery } from "./publicationDeliveryAdapter";
import { resolveTgPublicationDeliveryRoute } from "./publicationSource";
import { splitIntoBubbles } from "./telegram";

export type TgParagraphStreamMessage = {
  type: "tg_paragraph_stream";
  batchKey: string;
  chatId: string;
  generation: string;
  seq: number;
  startIndex: number;
  bubbles?: string[];
  items?: TgParagraphStreamItem[];
};

export type TgParagraphStreamDrainResult =
  | { kind: "drained"; consumedCount: number }
  | { kind: "waiting"; consumedCount: number };

export type TgParagraphFinalReconcile =
  | { kind: "ready"; consumedPrefixCount: number; remainingBubbles: string[]; hadAttention: boolean }
  | { kind: "waiting"; consumedPrefixCount: number }
  | { kind: "attention_required"; consumedPrefixCount: number; error: string };

type ParagraphBatchRow = {
  id: number;
  batch_key: string;
  chat_id: string;
  generation: string | null;
  state: string;
  final_closed: number;
  next_send_index: number;
  lease_token: string | null;
  lease_until: string | null;
  delivery_seq: number | null;
  created_at: string;
};

type ParagraphItemRow = {
  bubble_index: number;
  item_kind: "text" | "tool";
  canonical_bubble_index: number | null;
  text: string;
  text_hash: string;
  payload_json: string | null;
  outbox_id: string;
  status: string | null;
  lease_until: string | null;
  last_error: string | null;
};

const MAX_ITEMS_PER_ENVELOPE = 16;
const PARAGRAPH_LEASE_MS = 45_000;
const PARAGRAPH_DRAIN_BUDGET_MS = 20_000;
// Keep the non-idempotent send below the 30-second outbox lease, but do not
// manufacture an unknown outcome during an ordinary Telegram latency tail.
const PARAGRAPH_SEND_TIMEOUT_MS = 15_000;
// Final reconcile must finish whatever the live stream left behind, and a
// long generation can stage hundreds of paragraphs, so the budget scales
// with the unsent tail instead of a fixed four items. The per-item
// allowance matches the observed ~2s Telegram send rate; the ceiling keeps
// one invocation bounded and the inference retry loop resumes the rest.
const FINAL_RECONCILE_MIN_ITEMS = 4;
const FINAL_RECONCILE_MAX_ITEMS = 32;
const FINAL_RECONCILE_BASE_BUDGET_MS = 5_000;
const FINAL_RECONCILE_PER_ITEM_BUDGET_MS = 2_000;
const FINAL_RECONCILE_MAX_BUDGET_MS = 55_000;

type TgParagraphStageEnv = Pick<Env, "DB">;

function finalReconcileBudget(pendingCount: number): { maxItems: number; budgetMs: number } {
  const pending = Math.max(0, Math.floor(pendingCount));
  return {
    maxItems: Math.min(FINAL_RECONCILE_MAX_ITEMS, Math.max(FINAL_RECONCILE_MIN_ITEMS, pending)),
    budgetMs: Math.min(FINAL_RECONCILE_MAX_BUDGET_MS,
      FINAL_RECONCILE_BASE_BUDGET_MS + pending * FINAL_RECONCILE_PER_ITEM_BUDGET_MS),
  };
}

function validKey(value: string): boolean {
  return /^[a-zA-Z0-9:_-]{8,180}$/.test(value);
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function displayToolName(toolName: string): string {
  const labels: Record<string,string> = {
    system_status:"系统状态",
    tool_search:"查找工具",
    tool_describe:"查看工具说明",
    tool_execute:"执行只读工具",
    execute_codemode:"Code Mode",
    tool_action:"受控工具操作",
    approval_probe:"审批检查",
    subject_self_core_propose:"Self Core 提案",
    skill_search:"查找 Skill",
    skill_activate:"启用 Skill",
    code_inspect:"检查代码",
    code_list:"列出代码文件",
    code_search:"搜索代码",
    code_read:"读取代码",
  };
  return labels[toolName] ?? toolName.replace(/[_-]+/g," ").trim().slice(0,120);
}

export function tgToolStepPayload(toolName: string): Record<string,unknown> {
  const displayName = escapeTelegramHtml(displayToolName(toolName));
  return {
    text:`<blockquote expandable><b>🔧 工具步骤</b>\n${displayName}\n参数、结果与内部推理不会在这里展开。</blockquote>`,
    parse_mode:"HTML",
  };
}

function normalizedItems(message: TgParagraphStreamMessage): TgParagraphStreamItem[] {
  if (message.items && message.bubbles) throw new Error("tg_paragraph_envelope_ambiguous");
  if (message.items) return message.items;
  return (message.bubbles ?? []).map((text,offset) => ({
    kind:"text" as const,
    text,
    canonicalIndex:message.startIndex+offset,
  }));
}

async function canonicalTextHash(text: string, canonicalIndex: number): Promise<string> {
  return sha256(JSON.stringify({ kind:"text",text,canonicalIndex,payload:null }));
}

async function validateCanonicalTextItems(
  items: ParagraphItemRow[],
  canonicalBubbles: string[],
): Promise<{ valid: true; textCount: number } | { valid: false }> {
  let textCount = 0;
  for (let streamIndex = 0; streamIndex < items.length; streamIndex += 1) {
    const item = items[streamIndex];
    if (!item || item.bubble_index !== streamIndex) return { valid:false };
    if (item.item_kind === "tool") continue;
    const canonicalIndex = item.canonical_bubble_index ?? item.bubble_index;
    const canonical = canonicalBubbles[textCount];
    if (canonicalIndex !== textCount || canonical === undefined || item.text !== canonical) {
      return { valid:false };
    }
    const [currentHash,legacyHash] = await Promise.all([
      canonicalTextHash(canonical,canonicalIndex),
      sha256(canonical),
    ]);
    if (item.text_hash !== currentHash && item.text_hash !== legacyHash) return { valid:false };
    textCount += 1;
  }
  return { valid:true,textCount };
}

async function readBatch(db: D1Database, batchKey: string): Promise<ParagraphBatchRow | null> {
  return db.prepare(`SELECT id,batch_key,chat_id,generation,state,final_closed,next_send_index,
    lease_token,lease_until,delivery_seq,created_at FROM tg_paragraph_stream_batches WHERE batch_key=?`)
    .bind(batchKey).first<ParagraphBatchRow>();
}

async function requireCompatibleOpenBatch(env: TgParagraphStageEnv, message: TgParagraphStreamMessage): Promise<ParagraphBatchRow> {
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO tg_paragraph_stream_batches
    (batch_key,chat_id,generation,state,final_closed,next_send_index,last_sequence,created_at,updated_at,delivery_seq)
    SELECT ?,?,?,'open',0,0,?,?,?,r.delivery_seq FROM tg_chat_inference_runs r
      WHERE r.batch_key=? AND r.chat_id=? AND r.delivery_seq IS NOT NULL
    ON CONFLICT(batch_key) DO NOTHING`)
    .bind(message.batchKey,message.chatId,message.generation,message.seq,now,now,message.batchKey,message.chatId).run();
  const row = await readBatch(env.DB, message.batchKey);
  if (!row) throw new Error("tg_paragraph_batch_missing");
  if (row.final_closed === 1 || !["open", "closing"].includes(row.state)) {
    return row;
  }
  if (row.chat_id !== message.chatId || row.generation !== message.generation) {
    await markAttention(env.DB, message.batchKey, "paragraph_generation_or_chat_conflict", "conflict");
    throw new Error("tg_paragraph_generation_or_chat_conflict");
  }
  return row;
}

async function markAttention(
  db: D1Database,
  batchKey: string,
  error: string,
  state: "attention_required" | "conflict" = "attention_required",
): Promise<void> {
  await db.prepare(`UPDATE tg_paragraph_stream_batches SET state=?,last_error=?,
    lease_token=NULL,lease_until=NULL,updated_at=? WHERE batch_key=?`)
    .bind(state, error, nowIso(), batchKey).run();
}

async function stageItems(env: TgParagraphStageEnv, message: TgParagraphStreamMessage): Promise<"staged" | "closed"> {
  const items = normalizedItems(message);
  const staged = await Promise.all(items.map(async (item, offset) => {
    const bubbleIndex = message.startIndex + offset;
    const payload = item.kind === "tool" ? tgToolStepPayload(item.toolName) : null;
    const text = item.kind === "tool"
      ? `🔧 工具步骤\n${displayToolName(item.toolName)}`
      : item.text;
    const textHash = item.kind === "text"
      ? await canonicalTextHash(text,item.canonicalIndex)
      : await sha256(JSON.stringify({kind:item.kind,text,canonicalIndex:null,payload}));
    const outboxId = `tg-paragraph:${(await sha256(`${message.batchKey}:${bubbleIndex}`)).slice(0, 40)}`;
    return {
      bubbleIndex,
      itemKind:item.kind,
      canonicalBubbleIndex:item.kind === "text" ? item.canonicalIndex : null,
      text,
      textHash,
      payloadJson:payload ? JSON.stringify(payload) : null,
      outboxId,
    };
  }));
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const item of staged) {
    statements.push(env.DB.prepare(`INSERT INTO tg_paragraph_stream_items
      (batch_key,bubble_index,generation,item_kind,canonical_bubble_index,text,text_hash,payload_json,outbox_id,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM tg_paragraph_stream_batches
        WHERE batch_key=? AND generation=? AND final_closed=0 AND state IN ('open','closing')
      ) ON CONFLICT(batch_key,bubble_index) DO NOTHING`)
      .bind(message.batchKey,item.bubbleIndex,message.generation,item.itemKind,item.canonicalBubbleIndex,
        item.text,item.textHash,item.payloadJson,item.outboxId,now,
        message.batchKey, message.generation));
  }
  statements.push(env.DB.prepare(`UPDATE tg_paragraph_stream_batches
    SET last_sequence=MAX(last_sequence,?),updated_at=? WHERE batch_key=? AND generation=?
      AND final_closed=0 AND state IN ('open','closing')`)
    .bind(message.seq, now, message.batchKey, message.generation));
  await env.DB.batch(statements);

  const rows = await env.DB.prepare(`SELECT bubble_index,item_kind,canonical_bubble_index,text,text_hash,payload_json,outbox_id
    FROM tg_paragraph_stream_items WHERE batch_key=? AND bubble_index>=? AND bubble_index<?
    ORDER BY bubble_index`)
    .bind(message.batchKey, message.startIndex, message.startIndex + items.length)
    .all<Pick<ParagraphItemRow,"bubble_index"|"item_kind"|"canonical_bubble_index"|"text"|"text_hash"|"payload_json"|"outbox_id">>();
  if ((rows.results?.length ?? 0) !== staged.length) {
    const current = await readBatch(env.DB, message.batchKey);
    if (current?.final_closed === 1 || current?.state === "closed") return "closed";
    await markAttention(env.DB, message.batchKey, "paragraph_stage_gap", "conflict");
    throw new Error("tg_paragraph_stage_gap");
  }
  for (let offset = 0; offset < staged.length; offset += 1) {
    const expected = staged[offset];
    const actual = rows.results?.[offset];
    if (!expected || !actual || actual.bubble_index !== expected.bubbleIndex || actual.text !== expected.text
      || actual.item_kind !== expected.itemKind
      || actual.canonical_bubble_index !== expected.canonicalBubbleIndex
      || actual.text_hash !== expected.textHash || actual.payload_json !== expected.payloadJson
      || actual.outbox_id !== expected.outboxId) {
      await markAttention(env.DB, message.batchKey, "paragraph_stage_conflict", "conflict");
      throw new Error("tg_paragraph_stage_conflict");
    }
  }
  return "staged";
}

async function materializeParagraphOutbox(
  env: Env,
  batch: ParagraphBatchRow,
  item: Pick<ParagraphItemRow,"bubble_index"|"item_kind"|"canonical_bubble_index"|"text"|"payload_json"|"outbox_id">,
): Promise<void> {
  const source = item.bubble_index === 0
    ? await env.DB.prepare(`SELECT reply_to_message_id FROM tg_chat_inference_runs
        WHERE batch_key=? AND chat_id=?`).bind(batch.batch_key, batch.chat_id)
        .first<{ reply_to_message_id: number | null }>()
    : null;
  const basePayload = item.payload_json
    ? JSON.parse(item.payload_json) as Record<string,unknown>
    : { text:item.text };
  const payload = item.bubble_index === 0 && Number.isInteger(source?.reply_to_message_id)
    ? { ...basePayload,reply_parameters:{ message_id:source?.reply_to_message_id,allow_sending_without_reply:true } }
    : basePayload;
  const route = await resolveTgPublicationDeliveryRoute(env.DB,batch.batch_key);
  const outboxId = await stageParagraphPublicationDelivery(env,{
    batchKey:batch.batch_key,
    chatId:batch.chat_id,
    publicationCreatedAt:batch.created_at,
    bubbleIndex:item.bubble_index,
    text:item.text,
    outboxId:item.outbox_id,
    payload,
    presentationKind:item.item_kind === "tool" ? "tool_status" : "assistant_text",
    ...(item.item_kind === "text" && item.canonical_bubble_index !== null
      ? { canonicalBubbleIndex:item.canonical_bubble_index } : {}),
    publicationAuthority:route.authorityMode,
  });
  if (outboxId !== item.outbox_id) throw new Error("tg_paragraph_outbox_identity_conflict");
}

function assertValidEnvelope(message: TgParagraphStreamMessage): void {
  const items = normalizedItems(message);
  if (!validKey(message.batchKey) || !validKey(message.generation) || !message.chatId.trim()
    || !Number.isSafeInteger(message.seq) || message.seq < 1
    || !Number.isSafeInteger(message.startIndex) || message.startIndex < 0
    || items.length < 1 || items.length > MAX_ITEMS_PER_ENVELOPE
    || items.some((item) => item.kind === "text"
      ? !item.text.trim() || item.text.length > 4096
        || !Number.isSafeInteger(item.canonicalIndex) || item.canonicalIndex < 0
      : !/^[a-zA-Z0-9:_./-]{1,180}$/.test(item.toolName))) {
    throw new Error("tg_paragraph_envelope_invalid");
  }
}

/**
 * Durably stage a completed paragraph before Memory releases the canonical
 * response. TG_QUEUE remains only a wake-up path; the final TG handler can
 * drain these rows itself if the Queue consumer has not run yet.
 */
export async function stageTgParagraphStream(
  env: TgParagraphStageEnv,
  message: TgParagraphStreamMessage,
): Promise<"staged" | "closed"> {
  assertValidEnvelope(message);
  const batch = await requireCompatibleOpenBatch(env, message);
  if (batch.final_closed === 1 || !["open", "closing"].includes(batch.state)) return "closed";
  return stageItems(env, message);
}

async function sealTerminalParagraphBlockers(db: D1Database, batchKey: string, now: string): Promise<void> {
  // A terminal inference can no longer produce a canonical final. Seal any
  // stale older stream before enforcing same-chat FIFO so one abandoned
  // generation cannot block every later reply forever. Active leases remain
  // untouched; their owner or a later retry resolves them after expiry.
  await db.prepare(`UPDATE tg_paragraph_stream_batches SET state='attention_required',final_closed=1,
    lease_token=NULL,lease_until=NULL,last_error=COALESCE(last_error,'terminal_inference_paragraph_sealed'),updated_at=?
    WHERE state IN ('open','closing') AND (lease_until IS NULL OR lease_until<?)
      AND EXISTS (
        SELECT 1 FROM tg_paragraph_stream_batches current
        WHERE current.batch_key=? AND current.chat_id=tg_paragraph_stream_batches.chat_id
          AND tg_paragraph_stream_batches.delivery_seq<current.delivery_seq
      )
      AND EXISTS (
        SELECT 1 FROM tg_chat_inference_runs terminal
        WHERE terminal.batch_key=tg_paragraph_stream_batches.batch_key
          AND terminal.status IN ('completed','attention_required','failed')
      )`)
    .bind(now,now,batchKey).run();
}

// Same-chat FIFO: a newer paragraph batch waits for older open stream
// batches and (under unified order) older live delivery batches. A delivery
// batch whose inference run already terminalized is a dead tail — its own
// recovery lane resolves it — so it must not pin every later turn's stream.
async function acquireBatchLease(db: D1Database, batchKey: string, unifiedOrderEnabled: boolean): Promise<string | null> {
  const token = crypto.randomUUID();
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + PARAGRAPH_LEASE_MS).toISOString();
  const row = await db.prepare(`UPDATE tg_paragraph_stream_batches SET lease_token=?,lease_until=?,updated_at=?
    WHERE batch_key=? AND state IN ('open','closing')
      AND (lease_until IS NULL OR lease_until<?)
      AND NOT EXISTS (
        SELECT 1 FROM tg_paragraph_stream_batches older
        WHERE older.chat_id=tg_paragraph_stream_batches.chat_id
          AND older.delivery_seq<tg_paragraph_stream_batches.delivery_seq
          AND older.state IN ('open','closing')
      )
      AND (?=0 OR NOT EXISTS (
        SELECT 1 FROM tg_chat_delivery_batches older
        WHERE older.chat_id=tg_paragraph_stream_batches.chat_id
          AND older.delivery_seq<tg_paragraph_stream_batches.delivery_seq
          AND older.status IN ('pending','active')
          AND NOT EXISTS (
            SELECT 1 FROM tg_chat_inference_runs stale
            WHERE stale.batch_key=older.batch_key
              AND stale.status IN ('attention_required','failed')
          )
      ))
    RETURNING batch_key`).bind(token, leaseUntil, now, batchKey, now,unifiedOrderEnabled?1:0).first<{ batch_key: string }>();
  return row ? token : null;
}

async function releaseBatchLease(db: D1Database, batchKey: string, token: string): Promise<void> {
  await db.prepare(`UPDATE tg_paragraph_stream_batches SET lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE batch_key=? AND lease_token=?`).bind(nowIso(), batchKey, token).run();
}

export async function drainTgParagraphStream(
  env: Env,
  batchKey: string,
  maxItems = MAX_ITEMS_PER_ENVELOPE,
  absoluteDeadlineMs = Date.now() + PARAGRAPH_DRAIN_BUDGET_MS,
  requestTimeoutMs = PARAGRAPH_SEND_TIMEOUT_MS,
): Promise<TgParagraphStreamDrainResult> {
  const boundedMaxItems = Math.max(1, Math.min(MAX_ITEMS_PER_ENVELOPE, Math.floor(maxItems)));
  if (Date.now() >= absoluteDeadlineMs) return { kind: "waiting", consumedCount: 0 };
  let token = await acquireBatchLease(env.DB,batchKey,env.TG_UNIFIED_DELIVERY_ORDER_ENABLED === "true");
  if (!token) {
    // FIFO-blocked: seal abandoned older generations (terminal inference,
    // stale open batch) and retry once, so a dead predecessor cannot hold
    // back this turn's live stream until its own final close runs. The
    // healthy path pays no extra write.
    await sealTerminalParagraphBlockers(env.DB, batchKey, nowIso());
    token = await acquireBatchLease(env.DB,batchKey,env.TG_UNIFIED_DELIVERY_ORDER_ENABLED === "true");
  }
  if (!token) return { kind: "waiting", consumedCount: 0 };
  let consumedCount = 0;
  try {
    for (let count = 0; count < boundedMaxItems; count += 1) {
      if (Date.now() >= absoluteDeadlineMs) return { kind: "waiting", consumedCount };
      const batch = await readBatch(env.DB, batchKey);
      if (!batch || batch.lease_token !== token) return { kind: "waiting", consumedCount };
      const item = await env.DB.prepare(`SELECT i.bubble_index,i.item_kind,i.canonical_bubble_index,
        i.text,i.payload_json,i.outbox_id,o.status,o.lease_until,o.last_error
        FROM tg_paragraph_stream_items i LEFT JOIN tg_agent_outbox o ON o.id=i.outbox_id
        WHERE i.batch_key=? AND i.bubble_index=?`)
        .bind(batchKey, batch.next_send_index)
        .first<Pick<ParagraphItemRow,"bubble_index"|"item_kind"|"canonical_bubble_index"|"text"|"payload_json"|"outbox_id"|"status"|"lease_until"|"last_error">>();
      if (!item) return { kind: "drained", consumedCount };
      if (!item.status) await materializeParagraphOutbox(env, batch, item);
      const status = await deliverTgOutbox(env, item.outbox_id, undefined, { requestTimeoutMs });
      if (status !== "sent" && status !== "attention_required") {
        return { kind: "waiting", consumedCount };
      }
      const attentionRequired = status === "attention_required";
      const advanced = await env.DB.prepare(`UPDATE tg_paragraph_stream_batches
        SET next_send_index=next_send_index+1,
          last_error=CASE WHEN ?=1 THEN COALESCE(last_error,'paragraph_delivery_attention_required') ELSE last_error END,
          updated_at=?
        WHERE batch_key=? AND lease_token=? AND next_send_index=? RETURNING next_send_index`)
        .bind(attentionRequired ? 1 : 0,nowIso(),batchKey,token,batch.next_send_index)
        .first<{ next_send_index: number }>();
      if (!advanced) return { kind: "waiting", consumedCount };
      // An unknown non-idempotent send is terminal for this exact intent, but
      // it must not strand later distinct bubbles that have never been tried.
      consumedCount += 1;
    }
    return { kind: "waiting", consumedCount };
  } finally {
    await releaseBatchLease(env.DB, batchKey, token);
  }
}

export async function handleTgParagraphStream(
  env: Env,
  message: TgParagraphStreamMessage,
): Promise<TgParagraphStreamDrainResult> {
  if (await stageTgParagraphStream(env, message) === "closed") return { kind: "drained", consumedCount: 0 };
  return drainTgParagraphStream(env, message.batchKey);
}

async function readItems(db: D1Database, batchKey: string): Promise<ParagraphItemRow[]> {
  const result = await db.prepare(`SELECT i.bubble_index,i.item_kind,i.canonical_bubble_index,
    i.text,i.text_hash,i.payload_json,i.outbox_id,
    o.status,o.lease_until,o.last_error FROM tg_paragraph_stream_items i
    LEFT JOIN tg_agent_outbox o ON o.id=i.outbox_id WHERE i.batch_key=? ORDER BY i.bubble_index`)
    .bind(batchKey).all<ParagraphItemRow>();
  return result.results ?? [];
}

async function discardUnpublishedSpeculativePrefix(
  env: Env,
  batchKey: string,
): Promise<"discarded" | "waiting" | "unsafe"> {
  const token = await acquireBatchLease(env.DB,batchKey,env.TG_UNIFIED_DELIVERY_ORDER_ENABLED === "true");
  if (!token) return "waiting";
  try {
    const batch = await readBatch(env.DB, batchKey);
    const items = await readItems(env.DB, batchKey);
    if (!batch || batch.lease_token !== token || !["open", "closing"].includes(batch.state)
      || batch.final_closed !== 0 || batch.next_send_index !== 0
      || items.some((item) => item.status !== null)) return "unsafe";
    const existingOutbox = await env.DB.prepare(`SELECT 1 AS found FROM tg_agent_outbox
      WHERE delivery_batch_key=? LIMIT 1`).bind(`paragraph:${batchKey}`).first<{ found: number }>();
    if (existingOutbox) return "unsafe";

    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM tg_paragraph_stream_items WHERE batch_key=?
        AND EXISTS (SELECT 1 FROM tg_paragraph_stream_batches
          WHERE batch_key=? AND lease_token=? AND state IN ('open','closing')
            AND final_closed=0 AND next_send_index=0)
        AND NOT EXISTS (SELECT 1 FROM tg_agent_outbox WHERE delivery_batch_key=?)`)
        .bind(batchKey, batchKey, token, `paragraph:${batchKey}`),
      env.DB.prepare(`UPDATE tg_paragraph_stream_batches SET state='closed',final_closed=1,
        lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=?
        WHERE batch_key=? AND lease_token=? AND state IN ('open','closing')
          AND final_closed=0 AND next_send_index=0
          AND NOT EXISTS (SELECT 1 FROM tg_paragraph_stream_items WHERE batch_key=?)
          AND NOT EXISTS (SELECT 1 FROM tg_agent_outbox WHERE delivery_batch_key=?)`)
        .bind(now, batchKey, token, batchKey, `paragraph:${batchKey}`),
    ]);
    const closed = await readBatch(env.DB, batchKey);
    const remaining = await readItems(env.DB, batchKey);
    return closed?.state === "closed" && closed.final_closed === 1
      && closed.next_send_index === 0 && remaining.length === 0 ? "discarded" : "unsafe";
  } finally {
    await releaseBatchLease(env.DB, batchKey, token);
  }
}

export async function closeTgParagraphStreamForFinal(
  env: Env,
  input: { batchKey: string; chatId: string; canonicalText: string },
): Promise<TgParagraphFinalReconcile> {
  const canonicalBubbles = splitIntoBubbles(input.canonicalText);
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO tg_paragraph_stream_batches
    (batch_key,chat_id,generation,state,final_closed,next_send_index,last_sequence,created_at,updated_at,delivery_seq)
    SELECT ?,?,NULL,'closed',1,0,0,?,?,r.delivery_seq FROM tg_chat_inference_runs r
      WHERE r.batch_key=? AND r.chat_id=? AND r.delivery_seq IS NOT NULL
    ON CONFLICT(batch_key) DO UPDATE SET
      state=CASE WHEN tg_paragraph_stream_batches.state='open' THEN 'closing'
        ELSE tg_paragraph_stream_batches.state END,
      updated_at=excluded.updated_at`)
    .bind(input.batchKey,input.chatId,now,now,input.batchKey,input.chatId).run();
  await sealTerminalParagraphBlockers(env.DB,input.batchKey,now);
  const batch = await readBatch(env.DB, input.batchKey);
  if (!batch) return { kind:"attention_required",consumedPrefixCount:0,error:"paragraph_final_tombstone_missing" };
  if (batch.chat_id !== input.chatId) {
    await markAttention(env.DB, input.batchKey, "paragraph_final_chat_conflict", "conflict");
    return { kind: "attention_required", consumedPrefixCount: 0, error: "paragraph_final_chat_conflict" };
  }
  if (batch.state === "attention_required" || batch.state === "conflict") {
    return { kind:"attention_required",consumedPrefixCount:0,
      error:batch.state === "conflict" ? "paragraph_final_conflict" : "paragraph_delivery_attention_required" };
  }
  if (batch.state === "closed") {
    const closedItems = await readItems(env.DB, input.batchKey);
    const validation = await validateCanonicalTextItems(closedItems,canonicalBubbles);
    if (!validation.valid) {
      await markAttention(env.DB, input.batchKey, "paragraph_final_prefix_conflict", "conflict");
      return { kind: "attention_required", consumedPrefixCount: 0, error: "paragraph_final_prefix_conflict" };
    }
    if (batch.next_send_index > closedItems.length) {
      await markAttention(env.DB, input.batchKey, "paragraph_final_prefix_conflict", "conflict");
      return { kind: "attention_required", consumedPrefixCount: 0, error: "paragraph_final_prefix_conflict" };
    }
    const deliveredItems = closedItems.slice(0,batch.next_send_index);
    const consumedPrefixCount = deliveredItems.filter((item) => item.item_kind === "text").length;
    return { kind:"ready",consumedPrefixCount,
      remainingBubbles:canonicalBubbles.slice(consumedPrefixCount),
      hadAttention:deliveredItems.some((item) => item.status === "attention_required") };
  }
  const stagedBeforeDrain = await readItems(env.DB, input.batchKey);
  const stagedValidation = await validateCanonicalTextItems(stagedBeforeDrain,canonicalBubbles);
  if (!stagedValidation.valid) {
    const discard = await discardUnpublishedSpeculativePrefix(env, input.batchKey);
    if (discard === "waiting") return { kind: "waiting", consumedPrefixCount: 0 };
    if (discard === "discarded") {
      return { kind: "ready", consumedPrefixCount: 0, remainingBubbles: canonicalBubbles, hadAttention: false };
    }
    await markAttention(env.DB, input.batchKey, "paragraph_final_prefix_conflict", "conflict");
    return { kind: "attention_required", consumedPrefixCount: 0, error: "paragraph_final_prefix_conflict" };
  }
  const reconcileBudget = finalReconcileBudget(stagedBeforeDrain.length - batch.next_send_index);
  const reconcileDeadline = Date.now() + reconcileBudget.budgetMs;
  let drainedThisReconcile = 0;
  let drain: TgParagraphStreamDrainResult = { kind: "drained", consumedCount: 0 };
  do {
    const remainingBudget = reconcileBudget.maxItems - drainedThisReconcile;
    drain = await drainTgParagraphStream(env, input.batchKey, remainingBudget, reconcileDeadline);
    drainedThisReconcile += drain.consumedCount;
    if (drain.kind === "drained" || drain.consumedCount === 0) break;
  } while (drainedThisReconcile < reconcileBudget.maxItems && Date.now() < reconcileDeadline);
  const items = await readItems(env.DB, input.batchKey);
  const validation = await validateCanonicalTextItems(items,canonicalBubbles);
  if (!validation.valid) {
    await markAttention(env.DB, input.batchKey, "paragraph_final_prefix_conflict", "conflict");
    return { kind: "attention_required", consumedPrefixCount: 0, error: "paragraph_final_prefix_conflict" };
  }
  let consumedPrefixCount = 0;
  let hadAttention = false;
  for (const item of items) {
    if (item.status === "sent" || item.status === "attention_required") {
      hadAttention ||= item.status === "attention_required";
      if (item.item_kind === "text") consumedPrefixCount += 1;
      continue;
    }
    return { kind: "waiting", consumedPrefixCount };
  }
  await env.DB.prepare(`UPDATE tg_paragraph_stream_batches SET state='closed',final_closed=1,
    lease_token=NULL,lease_until=NULL,updated_at=? WHERE batch_key=? AND state='closing'`)
    .bind(nowIso(), input.batchKey).run();
  return { kind: "ready", consumedPrefixCount,
    remainingBubbles: canonicalBubbles.slice(consumedPrefixCount), hadAttention };
}

/**
 * A terminal system notice is not the canonical continuation of paragraphs
 * emitted before an SDK Action paused for approval. Drain that already-staged
 * prefix, seal it, and deliver the notice as a new deterministic bubble rather
 * than comparing unrelated text and manufacturing a prefix conflict.
 */
export async function closeTgParagraphStreamForSystemNotice(
  env: Env,
  input: { batchKey: string; chatId: string; notice: string },
): Promise<TgParagraphFinalReconcile> {
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO tg_paragraph_stream_batches
    (batch_key,chat_id,generation,state,final_closed,next_send_index,last_sequence,created_at,updated_at,delivery_seq)
    SELECT ?,?,NULL,'closed',1,0,0,?,?,r.delivery_seq FROM tg_chat_inference_runs r
      WHERE r.batch_key=? AND r.chat_id=? AND r.delivery_seq IS NOT NULL
    ON CONFLICT(batch_key) DO UPDATE SET
      state=CASE WHEN tg_paragraph_stream_batches.state='open' THEN 'closing'
        ELSE tg_paragraph_stream_batches.state END,
      updated_at=excluded.updated_at`)
    .bind(input.batchKey,input.chatId,now,now,input.batchKey,input.chatId).run();
  await sealTerminalParagraphBlockers(env.DB,input.batchKey,now);
  let batch = await readBatch(env.DB,input.batchKey);
  if (!batch) return { kind:"attention_required",consumedPrefixCount:0,error:"paragraph_notice_tombstone_missing" };
  if (batch.chat_id !== input.chatId) {
    await markAttention(env.DB,input.batchKey,"paragraph_notice_chat_conflict","conflict");
    return { kind:"attention_required",consumedPrefixCount:0,error:"paragraph_notice_chat_conflict" };
  }
  if (batch.state === "attention_required" || batch.state === "conflict") {
    return { kind:"attention_required",consumedPrefixCount:batch.next_send_index,
      error:batch.state === "conflict" ? "paragraph_notice_conflict" : "paragraph_delivery_attention_required" };
  }
  if (batch.state !== "closed") {
    const staged = await readItems(env.DB,input.batchKey);
    const budget = finalReconcileBudget(staged.length - batch.next_send_index);
    await drainTgParagraphStream(env,input.batchKey,budget.maxItems,Date.now()+budget.budgetMs);
    batch = await readBatch(env.DB,input.batchKey);
    if (!batch) return { kind:"attention_required",consumedPrefixCount:0,error:"paragraph_notice_batch_missing" };
  }
  const items = await readItems(env.DB,input.batchKey);
  let consumedPrefixCount = 0;
  let hadAttention = false;
  for (const item of items) {
    if (item.status !== "sent" && item.status !== "attention_required") {
      return { kind:"waiting",consumedPrefixCount };
    }
    hadAttention ||= item.status === "attention_required";
    if (item.item_kind === "text") consumedPrefixCount += 1;
  }
  await env.DB.prepare(`UPDATE tg_paragraph_stream_batches SET state='closed',final_closed=1,
    next_send_index=?,lease_token=NULL,lease_until=NULL,
    last_error=CASE WHEN ?=1 THEN COALESCE(last_error,'paragraph_delivery_attention_required') ELSE NULL END,
    updated_at=?
    WHERE batch_key=? AND chat_id=? AND state IN ('open','closing','closed')`)
    .bind(items.length,hadAttention?1:0,nowIso(),input.batchKey,input.chatId).run();
  return { kind:"ready",consumedPrefixCount,remainingBubbles:[input.notice],hadAttention };
}
