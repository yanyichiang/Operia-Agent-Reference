import { canonicalJson } from "./hashes";
import type {
  CanonicalImportedMessage,
  ConversationArchiveV1,
  ConversationImportBatchBinding,
  ConversationImportBatchRecord,
  PreparedConversationImportChunk,
} from "./types";

export interface BeginConversationImportBatch {
  record: ConversationImportBatchRecord;
  speakerMap: Record<string, string>;
  timezone: string | null;
  now: string;
}

export interface ConversationImportChunkResult {
  insertedMessages: number;
  reusedMessages: number;
  nextCursor: number;
}

export interface PreparedConversationImportChunkReceipt {
  fromCursor: number;
  toCursor: number;
  chunkHash: string;
}

export class ConversationImportLedgerConflictError extends Error {
  constructor(readonly code: "idempotency_conflict" | "cursor_conflict" | "terminal_state_conflict") {
    super(code);
  }
}

export interface ClaimConversationImportAlias {
  namespace: string;
  idempotencyKeyHash: string;
  requestHash: string;
  batchId: string;
  now: string;
}

export interface ConversationImportLedger {
  findByIdempotency(namespace: string, idempotencyKeyHash: string): Promise<ConversationImportBatchRecord | null>;
  findByReplay(namespace: string, blobSha256: string, adapterId: string, adapterVersion: string): Promise<ConversationImportBatchRecord | null>;
  findByBatchId(namespace: string, batchId: string): Promise<ConversationImportBatchRecord | null>;
  beginBatch(input: BeginConversationImportBatch): Promise<void>;
  claimIdempotencyAlias(input: ClaimConversationImportAlias): Promise<ConversationImportBatchRecord>;
  writeChunk(batch: ConversationImportBatchRecord, archive: ConversationArchiveV1, fromCursor: number, toCursor: number, now: string): Promise<ConversationImportChunkResult>;
  writePreparedChunk(batch: ConversationImportBatchRecord, chunk: PreparedConversationImportChunk, now: string): Promise<ConversationImportChunkResult>;
  getPreparedChunkReceipt(batchId: string, toCursor: number): Promise<PreparedConversationImportChunkReceipt | null>;
  preparedArchiveComplete(batchId: string): Promise<boolean>;
  markArchived(batchId: string, finalCursor: number, now: string): Promise<boolean>;
  markPartial(batchId: string, cursor: number, errorCode: string, now: string): Promise<boolean>;
  recordAttention(code: string, countMetadata: Record<string, number | string>, now: string, batchId?: string): Promise<void>;
}

type BatchRow = {
  id: string;
  namespace: string;
  adapter_id: string;
  adapter_version: string;
  blob_sha256: string;
  canonical_sha256: string;
  preview_digest: string;
  raw_object_ref: string;
  speaker_map_json: string;
  timezone_map_json: string;
  status: ConversationImportBatchRecord["status"];
  current_cursor: number;
  message_count: number;
  conversation_count: number;
  warning_count: number;
  quarantine_count: number;
  error_code: string | null;
  input_hash: string;
  job_key: string;
  alias_key_hash?: string;
};

function decodeBindingJson(value: string): { hash: string } {
  const parsed = JSON.parse(value) as { hash?: unknown };
  if (typeof parsed.hash !== "string") throw new Error("conversation_import_binding_corrupt");
  return { hash: parsed.hash };
}

function decodeRawByteCount(value: string): number | undefined {
  const parsed = JSON.parse(value) as { raw_byte_count?: unknown };
  return Number.isSafeInteger(parsed.raw_byte_count) && Number(parsed.raw_byte_count) >= 0 ? Number(parsed.raw_byte_count) : undefined;
}

function rowToRecord(row: BatchRow): ConversationImportBatchRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    blobSha256: row.blob_sha256,
    canonicalSha256: row.canonical_sha256,
    previewDigest: row.preview_digest,
    rawObjectRef: row.raw_object_ref,
    rawByteCount: decodeRawByteCount(row.timezone_map_json),
    speakerMapHash: decodeBindingJson(row.speaker_map_json).hash,
    timezoneMapHash: decodeBindingJson(row.timezone_map_json).hash,
    requestHash: row.input_hash,
    idempotencyKeyHash: row.alias_key_hash || row.job_key.replace(/^conversation-import:/, ""),
    status: row.status,
    currentCursor: row.current_cursor,
    messageCount: row.message_count,
    conversationCount: row.conversation_count,
    warningCount: row.warning_count,
    quarantineCount: row.quarantine_count,
    errorCode: row.error_code,
  };
}

const BATCH_SELECT = `SELECT b.id,b.namespace,b.adapter_id,b.adapter_version,b.blob_sha256,b.canonical_sha256,
  b.preview_digest,b.raw_object_ref,b.speaker_map_json,b.timezone_map_json,b.status,b.current_cursor,
  b.message_count,b.conversation_count,b.warning_count,b.quarantine_count,b.error_code,j.input_hash,j.job_key
  FROM conversation_import_batches b JOIN conversation_import_jobs j ON j.batch_id=b.id AND j.kind='normalize'`;

function flattenMessages(archive: ConversationArchiveV1): Array<{ message: CanonicalImportedMessage; conversation: ConversationArchiveV1["conversations"][number] }> {
  return archive.conversations.flatMap((conversation) => conversation.messages.map((message) => ({ message, conversation })));
}

function resultChanges(result: D1Result | undefined): number {
  return Number((result?.meta as { changes?: number } | undefined)?.changes || 0);
}

export class D1ConversationImportLedger implements ConversationImportLedger {
  constructor(private readonly db: D1Database) {}

  async findByIdempotency(namespace: string, idempotencyKeyHash: string): Promise<ConversationImportBatchRecord | null> {
    const row = await this.db.prepare(`${BATCH_SELECT}
      JOIN conversation_import_idempotency_aliases a ON a.batch_id=b.id
      WHERE a.namespace=? AND a.idempotency_key_hash=? LIMIT 1`)
      .bind(namespace, idempotencyKeyHash).first<BatchRow>();
    if (row) row.alias_key_hash = idempotencyKeyHash;
    return row ? rowToRecord(row) : null;
  }

  async findByReplay(namespace: string, blobSha256: string, adapterId: string, adapterVersion: string): Promise<ConversationImportBatchRecord | null> {
    const row = await this.db.prepare(`${BATCH_SELECT} WHERE b.namespace=? AND b.blob_sha256=? AND b.adapter_id=? AND b.adapter_version=? LIMIT 1`)
      .bind(namespace, blobSha256, adapterId, adapterVersion).first<BatchRow>();
    return row ? rowToRecord(row) : null;
  }

  async findByBatchId(namespace: string, batchId: string): Promise<ConversationImportBatchRecord | null> {
    const row = await this.db.prepare(`${BATCH_SELECT} WHERE b.namespace=? AND b.id=? LIMIT 1`)
      .bind(namespace, batchId).first<BatchRow>();
    return row ? rowToRecord(row) : null;
  }

  async beginBatch(input: BeginConversationImportBatch): Promise<void> {
    const { record, now } = input;
    const speakerJson = canonicalJson({ hash: record.speakerMapHash, map: input.speakerMap });
    const timezoneJson = canonicalJson({
      hash: record.timezoneMapHash,
      ...(record.rawByteCount === undefined ? {} : { raw_byte_count: record.rawByteCount }),
      timezone: input.timezone,
    });
    await this.db.batch([
      this.db.prepare(`INSERT INTO conversation_import_batches
        (id,namespace,source_app,adapter_id,adapter_version,blob_sha256,canonical_sha256,preview_digest,raw_object_ref,
         speaker_map_json,timezone_map_json,status,conversation_count,message_count,warning_count,quarantine_count,current_cursor,
         created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(record.id, record.namespace, "legacy_chat", record.adapterId, record.adapterVersion, record.blobSha256,
          record.canonicalSha256, record.previewDigest, record.rawObjectRef, speakerJson, timezoneJson, "creating",
          record.conversationCount, record.messageCount, record.warningCount, record.quarantineCount, 0, now, now),
      this.db.prepare(`INSERT INTO conversation_import_jobs
        (id,namespace,batch_id,kind,job_key,status,cursor,attempt,input_hash,version,processed_count,error_count,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(`cij_${record.id}`, record.namespace, record.id, "normalize", `conversation-import:${record.idempotencyKeyHash}`,
          "running", 0, 1, record.requestHash, record.adapterVersion, 0, 0, now, now),
      this.db.prepare(`INSERT INTO conversation_import_idempotency_aliases
        (namespace,idempotency_key_hash,request_hash,batch_id,created_at) VALUES(?,?,?,?,?)`)
        .bind(record.namespace, record.idempotencyKeyHash, record.requestHash, record.id, now),
    ]);
  }

  async claimIdempotencyAlias(input: ClaimConversationImportAlias): Promise<ConversationImportBatchRecord> {
    await this.db.prepare(`INSERT OR IGNORE INTO conversation_import_idempotency_aliases
      (namespace,idempotency_key_hash,request_hash,batch_id,created_at) VALUES(?,?,?,?,?)`)
      .bind(input.namespace, input.idempotencyKeyHash, input.requestHash, input.batchId, input.now).run();
    const alias = await this.db.prepare(`SELECT request_hash,batch_id FROM conversation_import_idempotency_aliases
      WHERE namespace=? AND idempotency_key_hash=? LIMIT 1`)
      .bind(input.namespace, input.idempotencyKeyHash).first<{ request_hash: string; batch_id: string }>();
    if (!alias || alias.request_hash !== input.requestHash || alias.batch_id !== input.batchId) {
      throw new ConversationImportLedgerConflictError("idempotency_conflict");
    }
    const batch = await this.findByIdempotency(input.namespace, input.idempotencyKeyHash);
    if (!batch) throw new Error("conversation_import_alias_batch_missing");
    return batch;
  }

  async writeChunk(batch: ConversationImportBatchRecord, archive: ConversationArchiveV1, fromCursor: number, toCursor: number, now: string): Promise<ConversationImportChunkResult> {
    const allMessages = flattenMessages(archive);
    const slice = allMessages.slice(fromCursor, toCursor);
    const conversations = [...new Map(slice.map(({ conversation }) => [conversation.id, conversation])).values()];
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`UPDATE conversation_import_batches
        SET current_cursor=?,status='creating',error_code=NULL,updated_at=?,revision=revision+1
        WHERE id=? AND current_cursor=? AND status IN ('creating','partial')`)
        .bind(toCursor, now, batch.id, fromCursor),
    ];
    for (const conversation of conversations) {
      statements.push(this.db.prepare(`INSERT OR IGNORE INTO conversation_import_conversations
        (id,namespace,conversation_fingerprint,source_locator_hash,private_title,selected_branch_hash,original_time_precision,message_count,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(conversation.id, batch.namespace, conversation.conversationFingerprint, conversation.sourceLocatorHash,
          conversation.privateTitle, conversation.selectedBranchHash, "instant", conversation.messages.length, "active", now, now));
      statements.push(this.db.prepare(`INSERT OR IGNORE INTO conversation_import_batch_conversations
        (batch_id,conversation_id,source_order,inclusion_status) VALUES(?,?,?,?)`)
        .bind(batch.id, conversation.id, conversation.sourceOrder, "included"));
    }
    for (const { message, conversation } of slice) {
      statements.push(this.db.prepare(`INSERT OR IGNORE INTO conversation_import_messages
        (id,namespace,conversation_id,message_fingerprint,source_locator_hash,parent_locator_hash,sequence,participant_key,canonical_role,
         original_timestamp,source_timezone,resolved_timezone,occurred_at_utc,time_precision,content_type,private_normalized_text,content_sha256,
         quarantine_status,quarantine_code,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(message.id, batch.namespace, conversation.id, message.messageFingerprint, message.sourceLocatorHash, message.parentLocatorHash,
          message.sequence, message.participantKey, message.canonicalRole, message.originalTimestamp, message.sourceTimezone,
          message.resolvedTimezone, message.occurredAtUtc, message.timePrecision, message.contentType, message.normalizedText,
          message.contentSha256, message.quarantineStatus, message.quarantineCode, now));
      statements.push(this.db.prepare(`INSERT OR IGNORE INTO conversation_import_batch_messages
        (batch_id,message_id,source_order,active) VALUES(?,?,?,?)`)
        .bind(batch.id, message.id, message.sourceOrder, message.active ? 1 : 0));
    }
    statements.push(this.db.prepare(`UPDATE conversation_import_jobs
      SET cursor=MAX(cursor,?),processed_count=MAX(processed_count,?),status='running',error_code=NULL,updated_at=?
      WHERE batch_id=? AND kind='normalize' AND status IN ('running','retry') AND EXISTS (
        SELECT 1 FROM conversation_import_batches WHERE id=? AND current_cursor=? AND status='creating'
      )`)
      .bind(toCursor, toCursor, now, batch.id, batch.id, toCursor));
    statements.push(this.db.prepare(`INSERT OR IGNORE INTO conversation_import_events
      (id,actor_kind,actor_hash,action,batch_id,job_id,status,count_metadata_json,idempotency_key_hash,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM conversation_import_batches WHERE id=? AND current_cursor=? AND status='creating'
      )`)
      .bind(`cie_${batch.id}_${toCursor}`, "system", "conversation-import", "normalize_chunk", batch.id,
        `cij_${batch.id}`, "committed", canonicalJson({ from_cursor: fromCursor, messages: slice.length, to_cursor: toCursor }),
        batch.idempotencyKeyHash, now, batch.id, toCursor));
    const results = await this.db.batch(statements);
    if (resultChanges(results[0]) !== 1) throw new ConversationImportLedgerConflictError("cursor_conflict");
    let insertedMessages = 0;
    const conversationStatementCount = 1 + conversations.length * 2;
    for (let index = 0; index < slice.length; index += 1) {
      const result = results[conversationStatementCount + index * 2];
      if (resultChanges(result) > 0) insertedMessages += 1;
    }
    return { insertedMessages, reusedMessages: slice.length - insertedMessages, nextCursor: toCursor };
  }


  async writePreparedChunk(batch: ConversationImportBatchRecord, chunk: PreparedConversationImportChunk, now: string): Promise<ConversationImportChunkResult> {
    const slice = chunk.conversations.flatMap((conversation) => conversation.messages.map((message) => ({ message, conversation })));
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM conversation_import_batches
        WHERE id=? AND namespace=? AND current_cursor=? AND message_count>=? AND status IN ('creating','partial')
      ) THEN 1 ELSE abs(-9223372036854775808) END AS prepared_cursor_fence`)
        .bind(batch.id, batch.namespace, chunk.fromCursor, chunk.toCursor),
      this.db.prepare(`UPDATE conversation_import_batches
        SET current_cursor=?,status='creating',error_code=NULL,updated_at=?,revision=revision+1
        WHERE id=? AND namespace=? AND current_cursor=? AND status IN ('creating','partial')`)
        .bind(chunk.toCursor, now, batch.id, batch.namespace, chunk.fromCursor),
    ];
    for (const conversation of chunk.conversations) {
      statements.push(this.db.prepare(`INSERT OR IGNORE INTO conversation_import_conversations
        (id,namespace,conversation_fingerprint,source_locator_hash,private_title,selected_branch_hash,original_time_precision,message_count,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(conversation.id, batch.namespace, conversation.conversationFingerprint, conversation.sourceLocatorHash,
          conversation.privateTitle, conversation.selectedBranchHash, "instant", conversation.messageCount, "active", now, now));
      statements.push(this.db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM conversation_import_conversations WHERE id=? AND namespace=? AND conversation_fingerprint=?
          AND source_locator_hash=? AND private_title IS ? AND selected_branch_hash=? AND message_count=? AND status='active'
      ) THEN 1 ELSE abs(-9223372036854775808) END AS prepared_conversation_fence`)
        .bind(conversation.id, batch.namespace, conversation.conversationFingerprint, conversation.sourceLocatorHash,
          conversation.privateTitle, conversation.selectedBranchHash, conversation.messageCount));
      statements.push(this.db.prepare(`INSERT OR IGNORE INTO conversation_import_batch_conversations
        (batch_id,conversation_id,source_order,inclusion_status) VALUES(?,?,?,?)`)
        .bind(batch.id, conversation.id, conversation.sourceOrder, "included"));
      statements.push(this.db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM conversation_import_batch_conversations WHERE batch_id=? AND conversation_id=? AND source_order=? AND inclusion_status='included'
      ) THEN 1 ELSE abs(-9223372036854775808) END AS prepared_batch_conversation_fence`)
        .bind(batch.id, conversation.id, conversation.sourceOrder));
    }
    for (const { message, conversation } of slice) {
      statements.push(this.db.prepare(`INSERT OR IGNORE INTO conversation_import_messages
        (id,namespace,conversation_id,message_fingerprint,source_locator_hash,parent_locator_hash,sequence,participant_key,canonical_role,
         original_timestamp,source_timezone,resolved_timezone,occurred_at_utc,time_precision,content_type,private_normalized_text,content_sha256,
         quarantine_status,quarantine_code,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(message.id, batch.namespace, conversation.id, message.messageFingerprint, message.sourceLocatorHash, message.parentLocatorHash,
          message.sequence, message.participantKey, message.canonicalRole, message.originalTimestamp, message.sourceTimezone,
          message.resolvedTimezone, message.occurredAtUtc, message.timePrecision, message.contentType, message.normalizedText,
          message.contentSha256, message.quarantineStatus, message.quarantineCode, now));
      statements.push(this.db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM conversation_import_messages WHERE id=? AND namespace=? AND conversation_id=? AND message_fingerprint=?
          AND source_locator_hash=? AND parent_locator_hash IS ? AND sequence=? AND participant_key=? AND canonical_role=?
          AND original_timestamp IS ? AND source_timezone IS ? AND resolved_timezone IS ? AND occurred_at_utc IS ?
          AND time_precision=? AND content_type=? AND private_normalized_text IS ? AND content_sha256=?
          AND quarantine_status=? AND quarantine_code IS ?
      ) THEN 1 ELSE abs(-9223372036854775808) END AS prepared_message_fence`)
        .bind(message.id, batch.namespace, conversation.id, message.messageFingerprint, message.sourceLocatorHash, message.parentLocatorHash,
          message.sequence, message.participantKey, message.canonicalRole, message.originalTimestamp, message.sourceTimezone,
          message.resolvedTimezone, message.occurredAtUtc, message.timePrecision, message.contentType, message.normalizedText,
          message.contentSha256, message.quarantineStatus, message.quarantineCode));
      statements.push(this.db.prepare(`INSERT OR IGNORE INTO conversation_import_batch_messages
        (batch_id,message_id,source_order,active) VALUES(?,?,?,?)`)
        .bind(batch.id, message.id, message.sourceOrder, message.active ? 1 : 0));
      statements.push(this.db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM conversation_import_batch_messages WHERE batch_id=? AND message_id=? AND source_order=? AND active=?
      ) THEN 1 ELSE abs(-9223372036854775808) END AS prepared_batch_message_fence`)
        .bind(batch.id, message.id, message.sourceOrder, message.active ? 1 : 0));
    }
    statements.push(this.db.prepare(`UPDATE conversation_import_jobs
      SET cursor=MAX(cursor,?),processed_count=MAX(processed_count,?),status='running',error_code=NULL,updated_at=?
      WHERE batch_id=? AND kind='normalize' AND status IN ('running','retry') AND EXISTS (
        SELECT 1 FROM conversation_import_batches WHERE id=? AND namespace=? AND current_cursor=? AND status='creating'
      )`).bind(chunk.toCursor, chunk.toCursor, now, batch.id, batch.id, batch.namespace, chunk.toCursor));
    statements.push(this.db.prepare(`INSERT OR IGNORE INTO conversation_import_events
      (id,actor_kind,actor_hash,action,batch_id,job_id,status,count_metadata_json,idempotency_key_hash,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM conversation_import_batches WHERE id=? AND namespace=? AND current_cursor=? AND status='creating'
      )`).bind(`cie_${batch.id}_${chunk.toCursor}`, "service", "conversation-import-privileged", "normalize_chunk", batch.id,
        `cij_${batch.id}`, "committed", canonicalJson({ chunk_hash: chunk.chunkHash, from_cursor: chunk.fromCursor, messages: slice.length, to_cursor: chunk.toCursor }),
        batch.idempotencyKeyHash, now, batch.id, batch.namespace, chunk.toCursor));
    try {
      const results = await this.db.batch(statements);
      if (resultChanges(results[1]) !== 1) throw new ConversationImportLedgerConflictError("cursor_conflict");
      const conversationStatements = chunk.conversations.length * 4;
      const firstMessageStatement = 2 + conversationStatements;
      let insertedMessages = 0;
      for (let index = 0; index < slice.length; index += 1) {
        if (resultChanges(results[firstMessageStatement + index * 4]) > 0) insertedMessages += 1;
      }
      return { insertedMessages, reusedMessages: slice.length - insertedMessages, nextCursor: chunk.toCursor };
    } catch (error) {
      if (error instanceof ConversationImportLedgerConflictError) throw error;
      throw new ConversationImportLedgerConflictError("cursor_conflict");
    }
  }


  async getPreparedChunkReceipt(batchId: string, toCursor: number): Promise<PreparedConversationImportChunkReceipt | null> {
    const row = await this.db.prepare(`SELECT count_metadata_json FROM conversation_import_events
      WHERE id=? AND batch_id=? AND action='normalize_chunk' AND status='committed' LIMIT 1`)
      .bind(`cie_${batchId}_${toCursor}`, batchId).first<{ count_metadata_json: string }>();
    if (!row) return null;
    const parsed = JSON.parse(row.count_metadata_json) as Record<string, unknown>;
    if (!Number.isInteger(parsed.from_cursor) || !Number.isInteger(parsed.to_cursor) || typeof parsed.chunk_hash !== "string") return null;
    return { fromCursor: Number(parsed.from_cursor), toCursor: Number(parsed.to_cursor), chunkHash: parsed.chunk_hash };
  }

  async preparedArchiveComplete(batchId: string): Promise<boolean> {
    const row = await this.db.prepare(`SELECT CASE WHEN b.current_cursor=b.message_count
        AND (SELECT COUNT(*) FROM conversation_import_batch_messages bm WHERE bm.batch_id=b.id)=b.message_count
        AND (SELECT COUNT(*) FROM conversation_import_batch_conversations bc WHERE bc.batch_id=b.id)=b.conversation_count
      THEN 1 ELSE 0 END AS complete
      FROM conversation_import_batches b WHERE b.id=? LIMIT 1`).bind(batchId).first<{ complete: number }>();
    return row?.complete === 1;
  }

  async markArchived(batchId: string, finalCursor: number, now: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`UPDATE conversation_import_batches
        SET status='archived',error_code=NULL,completed_at=?,updated_at=?,revision=revision+1
        WHERE id=? AND current_cursor=? AND message_count=? AND status IN ('creating','partial')`)
        .bind(now, now, batchId, finalCursor, finalCursor),
      this.db.prepare(`UPDATE conversation_import_jobs SET status='ready',cursor=MAX(cursor,?),processed_count=MAX(processed_count,?),error_code=NULL,updated_at=?
        WHERE batch_id=? AND kind='normalize' AND EXISTS (
          SELECT 1 FROM conversation_import_batches WHERE id=? AND status='archived' AND current_cursor=?
        )`)
        .bind(finalCursor, finalCursor, now, batchId, batchId, finalCursor),
    ]);
    if (resultChanges(results[0]) === 1) return true;
    const row = await this.db.prepare("SELECT status,current_cursor FROM conversation_import_batches WHERE id=?")
      .bind(batchId).first<{ status: string; current_cursor: number }>();
    return row?.status === "archived" && row.current_cursor === finalCursor;
  }

  async markPartial(batchId: string, cursor: number, errorCode: string, now: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`UPDATE conversation_import_batches
        SET status='partial',error_code=?,updated_at=?,revision=revision+1
        WHERE id=? AND current_cursor>=? AND status IN ('creating','partial')`)
        .bind(errorCode, now, batchId, cursor),
      this.db.prepare(`UPDATE conversation_import_jobs SET status='retry',cursor=MAX(cursor,?),error_count=error_count+1,error_code=?,updated_at=?
        WHERE batch_id=? AND kind='normalize' AND EXISTS (
          SELECT 1 FROM conversation_import_batches WHERE id=? AND status='partial' AND current_cursor>=?
        )`)
        .bind(cursor, errorCode, now, batchId, batchId, cursor),
    ]);
    return resultChanges(results[0]) === 1;
  }

  async recordAttention(code: string, countMetadata: Record<string, number | string>, now: string, batchId?: string): Promise<void> {
    await this.db.prepare(`INSERT INTO conversation_import_events
      (id,actor_kind,actor_hash,action,batch_id,status,count_metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(`cie_${crypto.randomUUID()}`, "system", "conversation-import", code, batchId || null, "attention", canonicalJson(countMetadata), now).run();
  }
}

export function sameBatchBinding(left: ConversationImportBatchRecord, right: ConversationImportBatchBinding): boolean {
  return left.namespace === right.namespace
    && left.adapterId === right.adapterId
    && left.adapterVersion === right.adapterVersion
    && left.blobSha256 === right.blobSha256
    && left.canonicalSha256 === right.canonicalSha256
    && left.previewDigest === right.previewDigest
    && left.speakerMapHash === right.speakerMapHash
    && left.timezoneMapHash === right.timezoneMapHash
    && left.requestHash === right.requestHash;
}
