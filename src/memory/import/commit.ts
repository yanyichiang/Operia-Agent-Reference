import { normalizeLegacyChatChatsV1, previewLegacyChatChatsV1 } from "./adapters/legacyChatChatsV1";
import type { ConversationImportRawArchiveStore, RawArchiveInspection, RawArchiveManifest } from "./archiveStore";
import { domainSeparatedHash } from "./hashes";
import type { ConversationImportLedger } from "./ledger";
import { ConversationImportLedgerConflictError, sameBatchBinding } from "./ledger";
import type {
  ConversationImportBatchBinding,
  ConversationImportBatchRecord,
  ConversationImportCommitResult,
  ConversationImportNormalizeOptions,
} from "./types";

export class ConversationImportCommitError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code);
  }
}

export interface CommitConversationImportRequest {
  bytes: Uint8Array;
  namespace: string;
  previewDigest: string;
  idempotencyKey: string;
  options: Omit<ConversationImportNormalizeOptions, "namespace">;
}

export interface CommitConversationImportDependencies {
  ledger: ConversationImportLedger;
  rawArchive: ConversationImportRawArchiveStore;
  now?: () => string;
  chunkSize?: number;
}

async function inspectArchive(
  store: ConversationImportRawArchiveStore,
  opaqueRef: string,
  manifest: RawArchiveManifest,
): Promise<RawArchiveInspection | { status: "unknown" }> {
  try {
    return await store.inspect(opaqueRef, manifest);
  } catch {
    return { status: "unknown" };
  }
}

async function markArchiveAttention(
  dependencies: CommitConversationImportDependencies,
  batch: ConversationImportBatchRecord,
  code: string,
  now: string,
): Promise<void> {
  const objectRefHash = await domainSeparatedHash("operia-import-private-object-ref-v1", [batch.rawObjectRef]);
  await dependencies.ledger.markPartial(batch.id, batch.currentCursor, code, now).catch(() => false);
  await dependencies.ledger.recordAttention(code, { object_ref_hash: objectRefHash, objects: 1 }, now, batch.id).catch(() => undefined);
}

async function ensureRawArchive(
  request: CommitConversationImportRequest,
  batch: ConversationImportBatchRecord,
  dependencies: CommitConversationImportDependencies,
  now: string,
): Promise<void> {
  const manifest: RawArchiveManifest = {
    blobSha256: batch.blobSha256,
    byteCount: request.bytes.byteLength,
    adapterId: batch.adapterId,
    adapterVersion: batch.adapterVersion,
    storageVersion: "private-r2/v1",
  };
  let inspection = await inspectArchive(dependencies.rawArchive, batch.rawObjectRef, manifest);
  if (inspection.status === "matched") return;
  if (inspection.status === "mismatch" || inspection.status === "unknown") {
    const code = inspection.status === "mismatch" ? "raw_archive_manifest_mismatch" : "raw_archive_inspect_unknown";
    await markArchiveAttention(dependencies, batch, code, now);
    throw new ConversationImportCommitError(code, 500);
  }
  try {
    await dependencies.rawArchive.put(batch.rawObjectRef, request.bytes, manifest);
    inspection = await inspectArchive(dependencies.rawArchive, batch.rawObjectRef, manifest);
  } catch {
    inspection = await inspectArchive(dependencies.rawArchive, batch.rawObjectRef, manifest);
  }
  if (inspection.status === "matched") return;
  const code = inspection.status === "mismatch"
    ? "raw_archive_manifest_mismatch"
    : inspection.status === "unknown" ? "raw_archive_inspect_unknown" : "raw_archive_put_failed";
  await markArchiveAttention(dependencies, batch, code, now);
  throw new ConversationImportCommitError(code, 500);
}

export async function commitConversationImport(
  request: CommitConversationImportRequest,
  dependencies: CommitConversationImportDependencies,
): Promise<ConversationImportCommitResult> {
  if (!request.namespace || request.namespace.length > 120) throw new ConversationImportCommitError("invalid_namespace", 422);
  if (request.idempotencyKey.length < 8 || request.idempotencyKey.length > 200) throw new ConversationImportCommitError("idempotency_key_required", 428);
  const preview = await previewLegacyChatChatsV1(request.bytes, request.options);
  if (preview.validation !== "valid") throw new ConversationImportCommitError("confirmed_mapping_required", 422);
  if (preview.previewDigest !== request.previewDigest) throw new ConversationImportCommitError("preview_digest_mismatch", 409);
  const normalizeOptions: ConversationImportNormalizeOptions = { ...request.options, namespace: request.namespace };
  const archive = await normalizeLegacyChatChatsV1(request.bytes, normalizeOptions);
  const speakerMapHash = await domainSeparatedHash("operia-import-speaker-map-v1", [request.options.speakerMap || null]);
  const timezoneMapHash = await domainSeparatedHash("operia-import-timezone-map-v1", [request.options.timezone || null]);
  const idempotencyKeyHash = await domainSeparatedHash("operia-import-idempotency-v1", [request.idempotencyKey]);
  const requestHash = await domainSeparatedHash("operia-import-commit-v1", [
    request.namespace,
    preview.adapter.id,
    preview.adapter.version,
    preview.export.blobSha256,
    archive.export.canonicalSha256,
    preview.previewDigest,
    speakerMapHash,
    timezoneMapHash,
  ]);
  const binding: ConversationImportBatchBinding = {
    namespace: request.namespace,
    adapterId: preview.adapter.id,
    adapterVersion: preview.adapter.version,
    blobSha256: preview.export.blobSha256,
    canonicalSha256: archive.export.canonicalSha256,
    previewDigest: preview.previewDigest,
    speakerMapHash,
    timezoneMapHash,
    requestHash,
    idempotencyKeyHash,
  };
  const now = dependencies.now || (() => new Date().toISOString());
  let batch = await dependencies.ledger.findByIdempotency(request.namespace, idempotencyKeyHash);
  if (batch && !sameBatchBinding(batch, binding)) throw new ConversationImportCommitError("idempotency_conflict", 409);
  if (!batch) {
    batch = await dependencies.ledger.findByReplay(request.namespace, preview.export.blobSha256, preview.adapter.id, preview.adapter.version);
    if (batch && !sameBatchBinding(batch, binding)) throw new ConversationImportCommitError("replay_binding_mismatch", 409);
    if (batch) {
      try {
        batch = await dependencies.ledger.claimIdempotencyAlias({
          namespace: request.namespace,
          idempotencyKeyHash,
          requestHash,
          batchId: batch.id,
          now: now(),
        });
      } catch (error) {
        if (error instanceof ConversationImportLedgerConflictError && error.code === "idempotency_conflict") {
          throw new ConversationImportCommitError("idempotency_conflict", 409);
        }
        throw error;
      }
    }
  }
  if (!batch) {
    const batchId = `cib_${requestHash.slice(0, 32)}`;
    const objectSuffix = await domainSeparatedHash("operia-import-raw-object-v1", [request.namespace, requestHash, preview.export.blobSha256]);
    const rawObjectRef = `raw/v1/${batchId}/${objectSuffix.slice(0, 40)}.bin`;
    batch = {
      ...binding,
      id: batchId,
      rawObjectRef,
      rawByteCount: request.bytes.byteLength,
      status: "creating",
      currentCursor: 0,
      messageCount: archive.conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0),
      conversationCount: archive.conversations.length,
      warningCount: archive.warnings.reduce((sum, warning) => sum + warning.count, 0),
      quarantineCount: archive.quarantine.reduce((sum, item) => sum + item.count, 0),
      errorCode: null,
    };
    try {
      await dependencies.ledger.beginBatch({
        record: batch,
        speakerMap: request.options.speakerMap || {},
        timezone: request.options.timezone || null,
        now: now(),
      });
    } catch (error) {
      const existing = await dependencies.ledger.findByIdempotency(request.namespace, idempotencyKeyHash).catch(() => null);
      if (existing && !sameBatchBinding(existing, binding)) throw new ConversationImportCommitError("idempotency_conflict", 409);
      if (!existing) {
        if (error instanceof ConversationImportLedgerConflictError) throw new ConversationImportCommitError(error.code, 409);
        throw new ConversationImportCommitError("ledger_begin_failed", 500);
      }
      batch = existing;
    }
  }
  await ensureRawArchive(request, batch, dependencies, now());
  if (batch.status === "archived") return resultFromBatch(batch, true, batch.currentCursor, 0, batch.messageCount);

  const resumedFromCursor = batch.currentCursor;
  const chunkSize = Math.min(Math.max(Math.floor(dependencies.chunkSize || 50), 1), 200);
  let cursor = batch.currentCursor;
  let insertedMessages = 0;
  let reusedMessages = 0;
  try {
    while (cursor < batch.messageCount) {
      const toCursor = Math.min(cursor + chunkSize, batch.messageCount);
      const chunk = await dependencies.ledger.writeChunk(batch, archive, cursor, toCursor, now());
      cursor = chunk.nextCursor;
      insertedMessages += chunk.insertedMessages;
      reusedMessages += chunk.reusedMessages;
      batch.currentCursor = cursor;
    }
    const archived = await dependencies.ledger.markArchived(batch.id, cursor, now());
    if (!archived) throw new ConversationImportLedgerConflictError("terminal_state_conflict");
  } catch (error) {
    await dependencies.ledger.markPartial(batch.id, cursor, "normalize_chunk_failed", now()).catch(() => undefined);
    if (error instanceof ConversationImportLedgerConflictError) throw new ConversationImportCommitError(error.code, 409);
    throw new ConversationImportCommitError("normalize_chunk_failed", 500);
  }
  batch.status = "archived";
  return resultFromBatch(batch, resumedFromCursor > 0, resumedFromCursor, insertedMessages, reusedMessages);
}

function resultFromBatch(
  batch: ConversationImportBatchRecord,
  replayed: boolean,
  resumedFromCursor: number,
  insertedMessages: number,
  reusedMessages: number,
): ConversationImportCommitResult {
  return {
    batchId: batch.id,
    status: "archived",
    replayed,
    resumedFromCursor,
    insertedMessages,
    reusedMessages,
    conversationCount: batch.conversationCount,
    messageCount: batch.messageCount,
    rawObjectStored: true,
  };
}
