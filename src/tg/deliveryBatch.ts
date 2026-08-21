import { nowIso } from "../utils/time";

export type TgDeliveryBatch = {
  id: number;
  batch_key: string;
  chat_id: string;
  outbox_ids_json: string;
  voice_once_outbox_id: string | null;
  status: string;
  next_index: number;
  had_attention: number;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
  delivery_seq: number | null;
};

const DELIVERY_COLUMNS = `id,batch_key,chat_id,outbox_ids_json,voice_once_outbox_id,status,
  next_index,had_attention,lease_until,created_at,updated_at,delivery_seq`;

export async function persistTgDeliveryBatch(db: D1Database, input: {
  batchKey: string;
  chatId: string;
  deliverySeq: number | null;
  outboxIds: string[];
  voiceOnceOutboxId?: string;
  hadAttention?: boolean;
}): Promise<void> {
  const now = nowIso();
  if (!Number.isSafeInteger(input.deliverySeq) || Number(input.deliverySeq) <= 0) {
    throw new Error("tg_delivery_seq_missing");
  }
  await db.prepare(`INSERT INTO tg_chat_delivery_batches
    (batch_key,chat_id,outbox_ids_json,voice_once_outbox_id,status,had_attention,created_at,updated_at,delivery_seq)
    VALUES(?,?,?,?,'pending',?,?,?,?) ON CONFLICT(batch_key) DO NOTHING`)
    .bind(input.batchKey,input.chatId,JSON.stringify(input.outboxIds),input.voiceOnceOutboxId ?? null,
      input.hadAttention ? 1 : 0,now,now,input.deliverySeq).run();
}

export async function getTgDeliveryBatch(db: D1Database, batchKey: string): Promise<TgDeliveryBatch | null> {
  return db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM tg_chat_delivery_batches WHERE batch_key=?`)
    .bind(batchKey).first<TgDeliveryBatch>();
}

export async function claimTgDeliveryBatch(
  db: D1Database,
  batchKey: string,
  leaseSeconds = 45,
  unifiedOrderEnabled = false,
): Promise<TgDeliveryBatch | null> {
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + Math.max(30,leaseSeconds) * 1000).toISOString();
  return db.prepare(`UPDATE tg_chat_delivery_batches SET status='active',lease_until=?,updated_at=?
    WHERE batch_key=?
      AND (status='pending' OR (status='active' AND (lease_until IS NULL OR lease_until < ?)))
      AND NOT EXISTS (
        SELECT 1 FROM tg_chat_delivery_batches older
        WHERE older.chat_id=(SELECT chat_id FROM tg_chat_delivery_batches WHERE batch_key=?)
          AND older.delivery_seq < (SELECT delivery_seq FROM tg_chat_delivery_batches WHERE batch_key=?)
          AND older.status IN ('pending','active')
      )
      AND (?=0 OR NOT EXISTS (
        SELECT 1 FROM tg_paragraph_stream_batches older
        WHERE older.chat_id=(SELECT chat_id FROM tg_chat_delivery_batches WHERE batch_key=?)
          AND older.delivery_seq < (SELECT delivery_seq FROM tg_chat_delivery_batches WHERE batch_key=?)
          AND older.state IN ('open','closing')
      ))
    RETURNING ${DELIVERY_COLUMNS}`)
    .bind(leaseUntil,now,batchKey,now,batchKey,batchKey,unifiedOrderEnabled?1:0,batchKey,batchKey)
    .first<TgDeliveryBatch>();
}

export async function deferTgDeliveryBatch(
  db: D1Database,
  batchKey: string,
  expectedIndex: number,
  expectedLeaseUntil: string,
): Promise<boolean> {
  const deferred = await db.prepare(`UPDATE tg_chat_delivery_batches SET status='pending',lease_until=NULL,updated_at=?
    WHERE batch_key=? AND status='active' AND next_index=? AND lease_until=? RETURNING batch_key`)
    .bind(nowIso(),batchKey,expectedIndex,expectedLeaseUntil).first<{batch_key:string}>();
  return Boolean(deferred);
}

export async function advanceTgDeliveryBatch(
  db: D1Database,
  batchKey: string,
  expectedIndex: number,
  hadAttention: boolean,
  expectedLeaseUntil: string,
): Promise<boolean> {
  const advanced = await db.prepare(`UPDATE tg_chat_delivery_batches SET next_index=next_index+1,
    had_attention=CASE WHEN had_attention=1 OR ?=1 THEN 1 ELSE 0 END,updated_at=?
    WHERE batch_key=? AND status='active' AND next_index=? AND lease_until=? RETURNING batch_key`)
    .bind(hadAttention ? 1 : 0,nowIso(),batchKey,expectedIndex,expectedLeaseUntil).first<{batch_key:string}>();
  return Boolean(advanced);
}

export async function completeTgDeliveryBatch(
  db: D1Database,
  batchKey: string,
  attentionRequired: boolean,
  expectedIndex: number,
  expectedLeaseUntil: string,
): Promise<boolean> {
  const now = nowIso();
  const completed = await db.prepare(`UPDATE tg_chat_delivery_batches SET status=?,lease_until=NULL,updated_at=?,completed_at=?
    WHERE batch_key=? AND status='active' AND next_index=? AND lease_until=? RETURNING batch_key`)
    .bind(attentionRequired ? "attention_required" : "completed",now,now,batchKey,expectedIndex,expectedLeaseUntil)
    .first<{batch_key:string}>();
  return Boolean(completed);
}

export async function dueTgDeliveryBatchKeys(db: D1Database, limit = 20): Promise<string[]> {
  const rows = await db.prepare(`SELECT batch_key FROM tg_chat_delivery_batches
    WHERE status='pending' OR (status='active' AND (lease_until IS NULL OR lease_until < ?))
    ORDER BY delivery_seq,id LIMIT ?`).bind(nowIso(),limit).all<{batch_key:string}>();
  return (rows.results ?? []).map((row) => row.batch_key);
}
