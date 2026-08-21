import type { ConversationImportStreamingRawArchiveStore, RawArchiveInspection, RawArchiveManifest } from "./archiveStore";
import { canonicalJson, domainSeparatedHash, sha256Hex } from "./hashes";
import type { ConversationImportLedger } from "./ledger";
import { ConversationImportLedgerConflictError, sameBatchBinding } from "./ledger";
import {
  CONVERSATION_IMPORT_MAX_BYTES,
  CONVERSATION_IMPORT_MAX_CONVERSATIONS,
  CONVERSATION_IMPORT_MAX_MESSAGES,
  CONVERSATION_IMPORT_MAX_MESSAGE_CHARS,
} from "./limits";
import type {
  CanonicalImportedMessage,
  ConversationImportBatchBinding,
  ConversationImportBatchRecord,
  PreparedConversationImportChunk,
  PreparedConversationImportManifest,
} from "./types";

export const PREPARED_IMPORT_MAX_CHUNK_BYTES = 1024 * 1024;
export const PREPARED_IMPORT_MAX_CHUNK_MESSAGES = 50;

export class PreparedConversationImportError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}

export interface PreparedConversationImportDependencies {
  ledger: ConversationImportLedger;
  rawArchive: ConversationImportStreamingRawArchiveStore;
  now?: () => string;
}

export interface PreparedConversationImportBeginResult {
  batchId: string;
  status: ConversationImportBatchRecord["status"];
  currentCursor: number;
  messageCount: number;
  conversationCount: number;
  replayed: boolean;
}

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^(?:cib|cic|cim)_[a-f0-9]{28,32}$/;
const ROLES = new Set(["owner", "assistant", "other", "system", "tool", "unknown"]);
const CONTENT_TYPES = new Set(["text", "markdown", "code", "attachment_reference", "mixed", "unsupported"]);
const TIME_PRECISIONS = new Set(["instant", "date", "sequence", "unknown"]);
const QUARANTINE = new Set(["none", "excluded", "quarantined"]);

function boundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function assertManifestShape(manifest: PreparedConversationImportManifest): void {
  if (manifest.schemaVersion !== "conversation-import-prepared/v1"
    || manifest.adapterId !== "legacy_chat_chats_v1" || manifest.adapterVersion !== "1.0.0"
    || !HASH.test(manifest.blobSha256) || !HASH.test(manifest.canonicalSha256) || !HASH.test(manifest.previewDigest)
    || !HASH.test(manifest.speakerMapHash) || !HASH.test(manifest.timezoneMapHash)
    || manifest.timezone !== "<YOUR_TIMEZONE>"
    || !boundedInteger(manifest.byteCount, CONVERSATION_IMPORT_MAX_BYTES) || manifest.byteCount === 0
    || !boundedInteger(manifest.messageCount, CONVERSATION_IMPORT_MAX_MESSAGES)
    || !boundedInteger(manifest.conversationCount, CONVERSATION_IMPORT_MAX_CONVERSATIONS)
    || !boundedInteger(manifest.warningCount, CONVERSATION_IMPORT_MAX_MESSAGES)
    || !boundedInteger(manifest.quarantineCount, CONVERSATION_IMPORT_MAX_MESSAGES)) {
    throw new PreparedConversationImportError("invalid_prepared_manifest", 422);
  }
  const entries = Object.entries(manifest.speakerMap);
  if (entries.length !== 2 || manifest.speakerMap.user !== "owner" || manifest.speakerMap.assistant !== "assistant"
    || entries.some(([key, role]) => !key || !ROLES.has(role))) {
    throw new PreparedConversationImportError("owner_mapping_mismatch", 422);
  }
}

function samePreparedManifest(batch: ConversationImportBatchRecord, manifest: PreparedConversationImportManifest): boolean {
  return batch.rawByteCount === manifest.byteCount
    && batch.messageCount === manifest.messageCount
    && batch.conversationCount === manifest.conversationCount
    && batch.warningCount === manifest.warningCount
    && batch.quarantineCount === manifest.quarantineCount;
}

async function bindingFor(
  namespace: string,
  idempotencyKey: string,
  manifest: PreparedConversationImportManifest,
): Promise<ConversationImportBatchBinding> {
  assertManifestShape(manifest);
  const speakerMapHash = await domainSeparatedHash("operia-import-speaker-map-v1", [manifest.speakerMap]);
  const timezoneMapHash = await domainSeparatedHash("operia-import-timezone-map-v1", [manifest.timezone]);
  if (speakerMapHash !== manifest.speakerMapHash || timezoneMapHash !== manifest.timezoneMapHash) {
    throw new PreparedConversationImportError("prepared_mapping_hash_mismatch", 409);
  }
  const idempotencyKeyHash = await domainSeparatedHash("operia-import-idempotency-v1", [idempotencyKey]);
  const requestHash = await domainSeparatedHash("operia-import-commit-v1", [
    namespace, manifest.adapterId, manifest.adapterVersion, manifest.blobSha256, manifest.canonicalSha256,
    manifest.previewDigest, speakerMapHash, timezoneMapHash,
  ]);
  return {
    namespace,
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    blobSha256: manifest.blobSha256,
    canonicalSha256: manifest.canonicalSha256,
    previewDigest: manifest.previewDigest,
    speakerMapHash,
    timezoneMapHash,
    requestHash,
    idempotencyKeyHash,
  };
}

export async function beginPreparedConversationImport(
  namespace: string,
  idempotencyKey: string,
  manifest: PreparedConversationImportManifest,
  dependencies: PreparedConversationImportDependencies,
): Promise<PreparedConversationImportBeginResult> {
  if (!namespace || namespace.length > 120) throw new PreparedConversationImportError("invalid_namespace", 422);
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) throw new PreparedConversationImportError("idempotency_key_required", 428);
  const binding = await bindingFor(namespace, idempotencyKey, manifest);
  const now = dependencies.now || (() => new Date().toISOString());
  let replayed = false;
  let batch = await dependencies.ledger.findByIdempotency(namespace, binding.idempotencyKeyHash);
  if (batch && (!sameBatchBinding(batch, binding) || !samePreparedManifest(batch, manifest))) {
    throw new PreparedConversationImportError("idempotency_conflict", 409);
  }
  if (!batch) {
    batch = await dependencies.ledger.findByReplay(namespace, manifest.blobSha256, manifest.adapterId, manifest.adapterVersion);
    if (batch && (!sameBatchBinding(batch, binding) || !samePreparedManifest(batch, manifest))) {
      throw new PreparedConversationImportError("replay_binding_mismatch", 409);
    }
    if (batch) {
      replayed = true;
      try {
        batch = await dependencies.ledger.claimIdempotencyAlias({
          namespace, idempotencyKeyHash: binding.idempotencyKeyHash, requestHash: binding.requestHash, batchId: batch.id, now: now(),
        });
      } catch (error) {
        if (error instanceof ConversationImportLedgerConflictError) throw new PreparedConversationImportError(error.code, 409);
        throw error;
      }
    }
  }
  if (!batch) {
    const id = `cib_${binding.requestHash.slice(0, 32)}`;
    const objectSuffix = await domainSeparatedHash("operia-import-raw-object-v1", [namespace, binding.requestHash, manifest.blobSha256]);
    batch = {
      ...binding,
      id,
      rawObjectRef: `raw/v1/${id}/${objectSuffix.slice(0, 40)}.bin`,
      rawByteCount: manifest.byteCount,
      status: "creating",
      currentCursor: 0,
      messageCount: manifest.messageCount,
      conversationCount: manifest.conversationCount,
      warningCount: manifest.warningCount,
      quarantineCount: manifest.quarantineCount,
      errorCode: null,
    };
    try {
      await dependencies.ledger.beginBatch({ record: batch, speakerMap: manifest.speakerMap, timezone: manifest.timezone, now: now() });
    } catch (error) {
      const existing = await dependencies.ledger.findByIdempotency(namespace, binding.idempotencyKeyHash).catch(() => null);
      if (!existing || !sameBatchBinding(existing, binding) || !samePreparedManifest(existing, manifest)) {
        if (error instanceof ConversationImportLedgerConflictError) throw new PreparedConversationImportError(error.code, 409);
        throw new PreparedConversationImportError("ledger_begin_failed", 500);
      }
      batch = existing;
      replayed = true;
    }
  }
  return {
    batchId: batch.id,
    status: batch.status,
    currentCursor: batch.currentCursor,
    messageCount: batch.messageCount,
    conversationCount: batch.conversationCount,
    replayed,
  };
}

function rawManifest(batch: ConversationImportBatchRecord): RawArchiveManifest {
  if (!batch.rawByteCount || batch.rawByteCount > CONVERSATION_IMPORT_MAX_BYTES) {
    throw new PreparedConversationImportError("raw_byte_count_missing", 500);
  }
  return {
    blobSha256: batch.blobSha256,
    byteCount: batch.rawByteCount,
    adapterId: batch.adapterId,
    adapterVersion: batch.adapterVersion,
    storageVersion: "private-r2/v1",
  };
}

async function inspectRaw(
  store: ConversationImportStreamingRawArchiveStore,
  batch: ConversationImportBatchRecord,
): Promise<RawArchiveInspection | { status: "unknown" }> {
  try { return await store.inspect(batch.rawObjectRef, rawManifest(batch)); } catch { return { status: "unknown" }; }
}

async function attention(dependencies: PreparedConversationImportDependencies, batch: ConversationImportBatchRecord, code: string): Promise<void> {
  const refHash = await domainSeparatedHash("operia-import-private-object-ref-v1", [batch.rawObjectRef]);
  await dependencies.ledger.recordAttention(code, { object_ref_hash: refHash, objects: 1 }, (dependencies.now || (() => new Date().toISOString()))(), batch.id)
    .catch(() => undefined);
}

export async function putPreparedConversationImportRaw(
  namespace: string,
  batchId: string,
  declaredByteCount: number,
  stream: ReadableStream<Uint8Array> | null,
  dependencies: PreparedConversationImportDependencies,
): Promise<{ batchId: string; rawObjectStored: true; replayed: boolean }> {
  const batch = await dependencies.ledger.findByBatchId(namespace, batchId);
  if (!batch) throw new PreparedConversationImportError("batch_not_found", 404);
  if (declaredByteCount !== batch.rawByteCount || !stream) throw new PreparedConversationImportError("raw_content_length_mismatch", 422);
  let inspection = await inspectRaw(dependencies.rawArchive, batch);
  if (inspection.status === "matched") {
    await stream.cancel("raw_archive_already_stored").catch(() => undefined);
    return { batchId, rawObjectStored: true, replayed: true };
  }
  if (inspection.status !== "missing") {
    const code = inspection.status === "mismatch" ? "raw_archive_manifest_mismatch" : "raw_archive_inspect_unknown";
    await attention(dependencies, batch, code);
    throw new PreparedConversationImportError(code, 500);
  }
  try {
    await dependencies.rawArchive.putStream(batch.rawObjectRef, stream, rawManifest(batch));
  } catch {
    inspection = await inspectRaw(dependencies.rawArchive, batch);
    if (inspection.status === "matched") return { batchId, rawObjectStored: true, replayed: false };
    const code = inspection.status === "mismatch" ? "raw_archive_manifest_mismatch"
      : inspection.status === "unknown" ? "raw_archive_inspect_unknown" : "raw_archive_put_failed";
    await attention(dependencies, batch, code);
    throw new PreparedConversationImportError(code, 500);
  }
  inspection = await inspectRaw(dependencies.rawArchive, batch);
  if (inspection.status !== "matched") {
    const code = inspection.status === "mismatch" ? "raw_archive_manifest_mismatch"
      : inspection.status === "unknown" ? "raw_archive_inspect_unknown" : "raw_archive_put_failed";
    await attention(dependencies, batch, code);
    throw new PreparedConversationImportError(code, 500);
  }
  return { batchId, rawObjectStored: true, replayed: false };
}

function validNullableString(value: unknown, maximum: number): boolean {
  return value === null || typeof value === "string" && value.length <= maximum;
}

async function validateMessage(namespace: string, conversationFingerprint: string, message: CanonicalImportedMessage): Promise<void> {
  if (!SAFE_ID.test(message.id) || !HASH.test(message.messageFingerprint) || !HASH.test(message.sourceLocatorHash)
    || !validNullableString(message.parentLocatorHash, 64) || message.parentLocatorHash !== null && !HASH.test(message.parentLocatorHash)
    || !boundedInteger(message.sequence, CONVERSATION_IMPORT_MAX_MESSAGES)
    || !boundedInteger(message.sourceOrder, CONVERSATION_IMPORT_MAX_MESSAGES)
    || typeof message.active !== "boolean" || !message.participantKey || message.participantKey.length > 120
    || !ROLES.has(message.canonicalRole) || !validNullableString(message.originalTimestamp, 120)
    || !validNullableString(message.sourceTimezone, 120) || !validNullableString(message.resolvedTimezone, 120)
    || !validNullableString(message.occurredAtUtc, 120) || !TIME_PRECISIONS.has(message.timePrecision)
    || !CONTENT_TYPES.has(message.contentType) || typeof message.normalizedText !== "string"
    || message.normalizedText.length > CONVERSATION_IMPORT_MAX_MESSAGE_CHARS || !HASH.test(message.contentSha256)
    || !QUARANTINE.has(message.quarantineStatus) || !validNullableString(message.quarantineCode, 120)) {
    throw new PreparedConversationImportError("invalid_canonical_message", 422);
  }
  const contentSha256 = await sha256Hex(message.normalizedText);
  const fingerprint = await domainSeparatedHash("operia-import-message-v1", [
    namespace, "legacy_chat", conversationFingerprint, message.sourceLocatorHash, message.canonicalRole,
    message.originalTimestamp, message.occurredAtUtc, message.contentType, contentSha256,
  ]);
  if (contentSha256 !== message.contentSha256 || fingerprint !== message.messageFingerprint
    || message.id !== `cim_${fingerprint.slice(0, 28)}`) {
    throw new PreparedConversationImportError("canonical_message_hash_mismatch", 409);
  }
}

export async function validatePreparedConversationImportChunk(
  namespace: string,
  batch: ConversationImportBatchRecord,
  chunk: PreparedConversationImportChunk,
): Promise<void> {
  if (chunk.schemaVersion !== "conversation-import-canonical-chunk/v1" || !HASH.test(chunk.chunkHash)
    || !Number.isSafeInteger(chunk.fromCursor) || !Number.isSafeInteger(chunk.toCursor)
    || chunk.fromCursor < 0 || chunk.toCursor <= chunk.fromCursor || chunk.toCursor > batch.messageCount
    || !Array.isArray(chunk.conversations) || chunk.conversations.length < 1
    || chunk.conversations.length > PREPARED_IMPORT_MAX_CHUNK_MESSAGES) {
    throw new PreparedConversationImportError("invalid_canonical_chunk", 422);
  }
  const messages = chunk.conversations.flatMap((conversation) => conversation.messages);
  if (messages.length !== chunk.toCursor - chunk.fromCursor || messages.length > PREPARED_IMPORT_MAX_CHUNK_MESSAGES) {
    throw new PreparedConversationImportError("canonical_chunk_count_mismatch", 409);
  }
  for (const conversation of chunk.conversations) {
    if (!SAFE_ID.test(conversation.id) || !HASH.test(conversation.conversationFingerprint)
      || !HASH.test(conversation.sourceLocatorHash) || !HASH.test(conversation.selectedBranchHash)
      || !boundedInteger(conversation.sourceOrder, CONVERSATION_IMPORT_MAX_CONVERSATIONS)
      || !boundedInteger(conversation.messageCount, CONVERSATION_IMPORT_MAX_MESSAGES)
      || !validNullableString(conversation.privateTitle, CONVERSATION_IMPORT_MAX_MESSAGE_CHARS)
      || !Array.isArray(conversation.messages) || conversation.messages.length < 1) {
      throw new PreparedConversationImportError("invalid_canonical_conversation", 422);
    }
    const fingerprint = await domainSeparatedHash("operia-import-conversation-v1", [namespace, "legacy_chat", conversation.sourceLocatorHash]);
    if (fingerprint !== conversation.conversationFingerprint || conversation.id !== `cic_${fingerprint.slice(0, 28)}`) {
      throw new PreparedConversationImportError("canonical_conversation_hash_mismatch", 409);
    }
    for (const message of conversation.messages) await validateMessage(namespace, fingerprint, message);
  }
  const computedChunkHash = await domainSeparatedHash("operia-import-canonical-chunk-v1", [
    chunk.fromCursor, chunk.toCursor, chunk.conversations,
  ]);
  if (computedChunkHash !== chunk.chunkHash) throw new PreparedConversationImportError("canonical_chunk_hash_mismatch", 409);
}

export async function writePreparedConversationImportChunk(
  namespace: string,
  batchId: string,
  chunk: PreparedConversationImportChunk,
  dependencies: PreparedConversationImportDependencies,
): Promise<{ batchId: string; nextCursor: number; insertedMessages: number; reusedMessages: number; replayed: boolean }> {
  const batch = await dependencies.ledger.findByBatchId(namespace, batchId);
  if (!batch) throw new PreparedConversationImportError("batch_not_found", 404);
  await validatePreparedConversationImportChunk(namespace, batch, chunk);
  const receipt = await dependencies.ledger.getPreparedChunkReceipt(batchId, chunk.toCursor).catch(() => {
    throw new PreparedConversationImportError("canonical_chunk_inspect_unknown", 500);
  });
  if (receipt) {
    if (receipt.fromCursor !== chunk.fromCursor || receipt.toCursor !== chunk.toCursor || receipt.chunkHash !== chunk.chunkHash) {
      await dependencies.ledger.recordAttention("canonical_chunk_receipt_mismatch", { from_cursor: chunk.fromCursor, to_cursor: chunk.toCursor },
        (dependencies.now || (() => new Date().toISOString()))(), batch.id).catch(() => undefined);
      throw new PreparedConversationImportError("canonical_chunk_receipt_mismatch", 409);
    }
    return { batchId, nextCursor: chunk.toCursor, insertedMessages: 0, reusedMessages: chunk.toCursor - chunk.fromCursor, replayed: true };
  }
  if (batch.status === "archived") throw new PreparedConversationImportError("terminal_state_conflict", 409);
  if (batch.currentCursor !== chunk.fromCursor) throw new PreparedConversationImportError("cursor_conflict", 409);
  try {
    const result = await dependencies.ledger.writePreparedChunk(batch, chunk, (dependencies.now || (() => new Date().toISOString()))());
    return { batchId, ...result, replayed: false };
  } catch (error) {
    const recovered = await dependencies.ledger.getPreparedChunkReceipt(batchId, chunk.toCursor).catch(() => null);
    if (recovered && recovered.fromCursor === chunk.fromCursor && recovered.toCursor === chunk.toCursor && recovered.chunkHash === chunk.chunkHash) {
      return { batchId, nextCursor: chunk.toCursor, insertedMessages: 0, reusedMessages: chunk.toCursor - chunk.fromCursor, replayed: true };
    }
    if (error instanceof ConversationImportLedgerConflictError) throw new PreparedConversationImportError(error.code, 409);
    throw new PreparedConversationImportError("canonical_chunk_failed", 500);
  }
}

export async function inspectPreparedConversationImport(
  namespace: string,
  batchId: string,
  dependencies: PreparedConversationImportDependencies,
): Promise<{ batchId: string; status: ConversationImportBatchRecord["status"]; currentCursor: number; messageCount: number; rawState: string; errorCode: string | null }> {
  const batch = await dependencies.ledger.findByBatchId(namespace, batchId);
  if (!batch) throw new PreparedConversationImportError("batch_not_found", 404);
  const raw = await inspectRaw(dependencies.rawArchive, batch);
  return { batchId, status: batch.status, currentCursor: batch.currentCursor, messageCount: batch.messageCount, rawState: raw.status, errorCode: batch.errorCode };
}

export async function finalizePreparedConversationImport(
  namespace: string,
  batchId: string,
  dependencies: PreparedConversationImportDependencies,
): Promise<{ batchId: string; status: "archived"; currentCursor: number; rawObjectStored: true; replayed: boolean }> {
  const batch = await dependencies.ledger.findByBatchId(namespace, batchId);
  if (!batch) throw new PreparedConversationImportError("batch_not_found", 404);
  const raw = await inspectRaw(dependencies.rawArchive, batch);
  if (raw.status !== "matched") {
    const code = raw.status === "mismatch" ? "raw_archive_manifest_mismatch"
      : raw.status === "unknown" ? "raw_archive_inspect_unknown" : "raw_archive_missing";
    await attention(dependencies, batch, code);
    throw new PreparedConversationImportError(code, 409);
  }
  if (batch.currentCursor !== batch.messageCount) throw new PreparedConversationImportError("canonical_archive_incomplete", 409);
  const complete = await dependencies.ledger.preparedArchiveComplete(batch.id).catch(() => {
    throw new PreparedConversationImportError("canonical_archive_inspect_unknown", 500);
  });
  if (!complete) throw new PreparedConversationImportError("canonical_archive_incomplete", 409);
  if (batch.status === "archived") return { batchId, status: "archived", currentCursor: batch.currentCursor, rawObjectStored: true, replayed: true };
  const archived = await dependencies.ledger.markArchived(batch.id, batch.currentCursor, (dependencies.now || (() => new Date().toISOString()))());
  if (!archived) throw new PreparedConversationImportError("terminal_state_conflict", 409);
  return { batchId, status: "archived", currentCursor: batch.currentCursor, rawObjectStored: true, replayed: false };
}

export async function buildPreparedConversationImportChunkHash(chunk: Omit<PreparedConversationImportChunk, "chunkHash">): Promise<string> {
  return domainSeparatedHash("operia-import-canonical-chunk-v1", [chunk.fromCursor, chunk.toCursor, chunk.conversations]);
}

export function preparedManifestLogSafe(manifest: PreparedConversationImportManifest): string {
  return canonicalJson({
    adapter: `${manifest.adapterId}@${manifest.adapterVersion}`,
    byte_count: manifest.byteCount,
    conversation_count: manifest.conversationCount,
    message_count: manifest.messageCount,
    quarantine_count: manifest.quarantineCount,
    warning_count: manifest.warningCount,
  });
}
