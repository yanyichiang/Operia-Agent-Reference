import type { ConversationImportRawArchiveStore, RawArchiveInspection, RawArchiveManifest } from "./archiveStore";
import type { BeginConversationImportBatch, ClaimConversationImportAlias, ConversationImportChunkResult, ConversationImportLedger, PreparedConversationImportChunkReceipt } from "./ledger";
import { ConversationImportLedgerConflictError } from "./ledger";
import type { ConversationArchiveV1, ConversationImportBatchRecord, PreparedConversationImportChunk } from "./types";

export class InMemoryConversationImportRawArchiveStore implements ConversationImportRawArchiveStore {
  readonly objects = new Map<string, { bytes: Uint8Array; manifest: RawArchiveManifest }>();
  putCalls = 0;
  inspectCalls = 0;
  deleteCalls = 0;
  failPutBeforePersist = false;
  failPutAfterPersist = false;
  inspectUnknown = false;
  failDelete = false;

  async put(opaqueRef: string, bytes: Uint8Array, manifest: RawArchiveManifest): Promise<void> {
    this.putCalls += 1;
    if (this.failPutBeforePersist) throw new Error("synthetic_r2_put_failure_before_persist");
    this.objects.set(opaqueRef, { bytes: bytes.slice(), manifest: { ...manifest } });
    if (this.failPutAfterPersist) throw new Error("synthetic_r2_put_failure_after_persist");
  }

  async inspect(opaqueRef: string, expected: RawArchiveManifest): Promise<RawArchiveInspection> {
    this.inspectCalls += 1;
    if (this.inspectUnknown) throw new Error("synthetic_r2_inspect_unknown");
    const object = this.objects.get(opaqueRef);
    if (!object) return { status: "missing" };
    return { status: JSON.stringify(object.manifest) === JSON.stringify(expected) ? "matched" : "mismatch" };
  }

  async delete(opaqueRef: string): Promise<void> {
    this.deleteCalls += 1;
    if (this.failDelete) throw new Error("synthetic_r2_delete_failure");
    this.objects.delete(opaqueRef);
  }
}

export class InMemoryConversationImportLedger implements ConversationImportLedger {
  readonly batches = new Map<string, ConversationImportBatchRecord>();
  readonly idempotency = new Map<string, { batchId: string; requestHash: string }>();
  readonly replay = new Map<string, string>();
  readonly canonicalMessages = new Set<string>();
  readonly batchMessages = new Map<string, Set<string>>();
  readonly batchConversations = new Map<string, Set<string>>();
  readonly attention: Array<{ code: string; batchId?: string; metadata: Record<string, number | string> }> = [];
  readonly chunkEvents: Array<{ batchId: string; fromCursor: number; toCursor: number; messageCount: number }> = [];
  readonly preparedReceipts = new Map<string, PreparedConversationImportChunkReceipt>();
  beginCalls = 0;
  chunkCalls = 0;
  deleteCalls = 0;
  failBegin = false;
  failChunkBeforePersistAtCall = 0;
  failChunkAfterPersistAtCall = 0;
  failAttention = false;

  private idempotencyKey(namespace: string, hash: string): string { return `${namespace}:${hash}`; }
  private replayKey(namespace: string, blob: string, adapterId: string, adapterVersion: string): string {
    return `${namespace}:${blob}:${adapterId}:${adapterVersion}`;
  }

  async findByIdempotency(namespace: string, idempotencyKeyHash: string): Promise<ConversationImportBatchRecord | null> {
    const alias = this.idempotency.get(this.idempotencyKey(namespace, idempotencyKeyHash));
    return alias ? { ...this.batches.get(alias.batchId)!, idempotencyKeyHash } : null;
  }

  async findByReplay(namespace: string, blobSha256: string, adapterId: string, adapterVersion: string): Promise<ConversationImportBatchRecord | null> {
    const id = this.replay.get(this.replayKey(namespace, blobSha256, adapterId, adapterVersion));
    return id ? { ...this.batches.get(id)! } : null;
  }

  async findByBatchId(namespace: string, batchId: string): Promise<ConversationImportBatchRecord | null> {
    const batch = this.batches.get(batchId);
    return batch?.namespace === namespace ? { ...batch } : null;
  }

  async beginBatch(input: BeginConversationImportBatch): Promise<void> {
    this.beginCalls += 1;
    if (this.failBegin) throw new Error("synthetic_d1_begin_failure");
    const record = { ...input.record };
    const aliasKey = this.idempotencyKey(record.namespace, record.idempotencyKeyHash);
    if (this.idempotency.has(aliasKey) || this.batches.has(record.id)) throw new ConversationImportLedgerConflictError("idempotency_conflict");
    this.batches.set(record.id, record);
    this.idempotency.set(aliasKey, { batchId: record.id, requestHash: record.requestHash });
    this.replay.set(this.replayKey(record.namespace, record.blobSha256, record.adapterId, record.adapterVersion), record.id);
    this.batchMessages.set(record.id, new Set());
    this.batchConversations.set(record.id, new Set());
  }

  async claimIdempotencyAlias(input: ClaimConversationImportAlias): Promise<ConversationImportBatchRecord> {
    const key = this.idempotencyKey(input.namespace, input.idempotencyKeyHash);
    const existing = this.idempotency.get(key);
    if (existing && (existing.batchId !== input.batchId || existing.requestHash !== input.requestHash)) {
      throw new ConversationImportLedgerConflictError("idempotency_conflict");
    }
    if (!existing) this.idempotency.set(key, { batchId: input.batchId, requestHash: input.requestHash });
    const batch = this.batches.get(input.batchId);
    if (!batch) throw new Error("conversation_import_alias_batch_missing");
    return { ...batch, idempotencyKeyHash: input.idempotencyKeyHash };
  }

  async writeChunk(batch: ConversationImportBatchRecord, archive: ConversationArchiveV1, fromCursor: number, toCursor: number, _now: string): Promise<ConversationImportChunkResult> {
    this.chunkCalls += 1;
    const stored = this.batches.get(batch.id)!;
    if ((stored.status !== "creating" && stored.status !== "partial") || stored.currentCursor !== fromCursor) {
      throw new ConversationImportLedgerConflictError("cursor_conflict");
    }
    if (this.failChunkBeforePersistAtCall === this.chunkCalls) throw new Error("synthetic_chunk_failure_before_persist");
    const messages = archive.conversations.flatMap((conversation) => conversation.messages).slice(fromCursor, toCursor);
    const links = this.batchMessages.get(batch.id)!;
    let insertedMessages = 0;
    let reusedMessages = 0;
    for (const message of messages) {
      if (this.canonicalMessages.has(message.messageFingerprint)) reusedMessages += 1;
      else {
        this.canonicalMessages.add(message.messageFingerprint);
        insertedMessages += 1;
      }
      links.add(message.messageFingerprint);
    }
    stored.currentCursor = toCursor;
    stored.status = "creating";
    this.chunkEvents.push({ batchId: batch.id, fromCursor, toCursor, messageCount: messages.length });
    if (this.failChunkAfterPersistAtCall === this.chunkCalls) throw new Error("synthetic_chunk_failure_after_persist");
    return { insertedMessages, reusedMessages, nextCursor: toCursor };
  }

  async writePreparedChunk(batch: ConversationImportBatchRecord, chunk: PreparedConversationImportChunk, now: string): Promise<ConversationImportChunkResult> {
    this.chunkCalls += 1;
    const stored = this.batches.get(batch.id)!;
    if ((stored.status !== "creating" && stored.status !== "partial") || stored.currentCursor !== chunk.fromCursor) {
      throw new ConversationImportLedgerConflictError("cursor_conflict");
    }
    if (this.failChunkBeforePersistAtCall === this.chunkCalls) throw new Error("synthetic_chunk_failure_before_persist");
    const messages = chunk.conversations.flatMap((conversation) => conversation.messages);
    const conversations = this.batchConversations.get(batch.id)!;
    for (const conversation of chunk.conversations) conversations.add(conversation.id);
    const links = this.batchMessages.get(batch.id)!;
    let insertedMessages = 0;
    for (const message of messages) {
      if (!this.canonicalMessages.has(message.messageFingerprint)) {
        this.canonicalMessages.add(message.messageFingerprint);
        insertedMessages += 1;
      }
      links.add(message.messageFingerprint);
    }
    stored.currentCursor = chunk.toCursor;
    stored.status = "creating";
    this.preparedReceipts.set(`${batch.id}:${chunk.toCursor}`, {
      fromCursor: chunk.fromCursor, toCursor: chunk.toCursor, chunkHash: chunk.chunkHash,
    });
    this.chunkEvents.push({ batchId: batch.id, fromCursor: chunk.fromCursor, toCursor: chunk.toCursor, messageCount: messages.length });
    if (this.failChunkAfterPersistAtCall === this.chunkCalls) throw new Error("synthetic_chunk_failure_after_persist");
    return { insertedMessages, reusedMessages: messages.length - insertedMessages, nextCursor: chunk.toCursor };
  }

  async getPreparedChunkReceipt(batchId: string, toCursor: number): Promise<PreparedConversationImportChunkReceipt | null> {
    return this.preparedReceipts.get(`${batchId}:${toCursor}`) || null;
  }

  async preparedArchiveComplete(batchId: string): Promise<boolean> {
    const batch = this.batches.get(batchId);
    return Boolean(batch && batch.currentCursor === batch.messageCount
      && this.batchMessages.get(batchId)?.size === batch.messageCount
      && this.batchConversations.get(batchId)?.size === batch.conversationCount);
  }

  async markArchived(batchId: string, finalCursor: number, _now: string): Promise<boolean> {
    const stored = this.batches.get(batchId)!;
    if (stored.status === "archived") return stored.currentCursor === finalCursor;
    if ((stored.status !== "creating" && stored.status !== "partial") || stored.currentCursor !== finalCursor || stored.messageCount !== finalCursor) return false;
    stored.status = "archived";
    stored.currentCursor = finalCursor;
    stored.errorCode = null;
    return true;
  }

  async markPartial(batchId: string, cursor: number, errorCode: string, _now: string): Promise<boolean> {
    const stored = this.batches.get(batchId);
    if (!stored || (stored.status !== "creating" && stored.status !== "partial") || stored.currentCursor < cursor) return false;
    stored.status = "partial";
    stored.errorCode = errorCode;
    return true;
  }

  async recordAttention(code: string, countMetadata: Record<string, number | string>, _now: string, batchId?: string): Promise<void> {
    if (this.failAttention) throw new Error("synthetic_attention_failure");
    this.attention.push({ code, batchId, metadata: { ...countMetadata } });
  }
}
