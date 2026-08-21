import { canonicalJson, domainSeparatedHash, sha256Hex } from "./hashes";
import type {
  CandidateExtractionResult,
  DerivationDeletePreview,
  DerivationImpactInput,
  DerivationImpactItem,
  DerivationSourceMessage,
  ImportVectorManifest,
  ImportVectorStore,
  SummaryBounds,
  SummaryIdentityContext,
  SummaryProjection,
  ValidatedCandidateExtraction,
} from "./derivationTypes";
import { CONVERSATION_IMPORT_EMBEDDING_DIMENSIONS } from "./derivationTypes";

const encoder = new TextEncoder();

function positiveBound(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid_${name}`);
  return value;
}

export async function buildSummaryProjection(
  messages: readonly DerivationSourceMessage[],
  bounds: SummaryBounds,
  identity: SummaryIdentityContext,
): Promise<SummaryProjection> {
  const maxMessages = positiveBound(bounds.maxMessages, "max_messages");
  const maxInputBytes = positiveBound(bounds.maxInputBytes, "max_input_bytes");
  positiveBound(bounds.maxOutputBytes, "max_output_bytes");
  const conversationIds = new Set(messages.map((message) => message.conversationId));
  if (conversationIds.size > 1) throw new Error("cross_conversation_summary_input");
  const eligible = [...messages]
    .filter((message) => message.active
      && message.quarantineStatus === "none"
      && (message.canonicalRole === "owner" || message.canonicalRole === "assistant")
      && message.normalizedText.trim().length > 0)
    .sort((left, right) => left.sourceOrder - right.sourceOrder || left.id.localeCompare(right.id));
  const selected: DerivationSourceMessage[] = [];
  let inputByteCount = 0;
  for (const message of eligible) {
    if (selected.length >= maxMessages) break;
    const byteCount = encoder.encode(message.normalizedText).byteLength;
    if (inputByteCount + byteCount > maxInputBytes) break;
    selected.push(message);
    inputByteCount += byteCount;
  }
  const messageIdentity = selected.map((message) => ({
    id: message.id,
    content_sha256: message.contentSha256,
    occurred_at_utc: message.occurredAtUtc,
    role: message.canonicalRole,
  }));
  return {
    messageIds: selected.map((message) => message.id),
    messages: selected.map((message) => ({ role: message.canonicalRole as "owner" | "assistant", content: message.normalizedText })),
    inputByteCount,
    omittedMessageCount: eligible.length - selected.length,
    inputHash: await domainSeparatedHash("operia/conversation-import/summary-input/v1", [[...conversationIds], messageIdentity, bounds, {
      prompt_policy_version: identity.promptPolicyVersion,
      summarizer_version: identity.summarizerVersion,
      summarizer_model: identity.summarizerModel,
    }]),
  };
}

export function assertBoundedSummaryOutput(output: string, bounds: SummaryBounds): void {
  if (encoder.encode(output).byteLength > positiveBound(bounds.maxOutputBytes, "max_output_bytes")) {
    throw new Error("summary_output_limit_exceeded");
  }
}

function unitInterval(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`invalid_candidate_${name}`);
  return value;
}

const MAX_CANDIDATE_SOURCE_COUNT = 128;
const MAX_CANDIDATE_TYPE_BYTES = 80;
const MAX_CANDIDATE_FACT_KEY_BYTES = 256;

export async function validateCandidateExtraction(
  result: CandidateExtractionResult,
  input: { summaryInputHash: string; extractorVersion: string; policyVersion: string; maxContentBytes: number },
): Promise<ValidatedCandidateExtraction> {
  const content = result.content.trim();
  if (!content || encoder.encode(content).byteLength > positiveBound(input.maxContentBytes, "candidate_content_bytes")) {
    throw new Error("invalid_candidate_content");
  }
  unitInterval(result.confidence, "confidence");
  unitInterval(result.importance, "importance");
  if (!result.type.trim() || encoder.encode(result.type).byteLength > MAX_CANDIDATE_TYPE_BYTES) {
    throw new Error("invalid_candidate_type");
  }
  if (result.factKey !== null && (!result.factKey.trim()
    || encoder.encode(result.factKey).byteLength > MAX_CANDIDATE_FACT_KEY_BYTES)) {
    throw new Error("invalid_candidate_fact_key");
  }
  if (!(["ordinary", "persona", "identity", "sensitive", "conflict"] as string[]).includes(result.policyClass)) {
    throw new Error("invalid_candidate_policy_class");
  }
  const contentHash = await sha256Hex(content);
  const sourceMessageIds = [...new Set(result.sourceMessageIds)].sort();
  if (sourceMessageIds.length === 0 || sourceMessageIds.length > MAX_CANDIDATE_SOURCE_COUNT) {
    throw new Error("invalid_candidate_sources");
  }
  if (result.policyClass === "conflict" && !result.conflictTargetMemoryId) throw new Error("invalid_candidate_conflict_target");
  if (result.policyClass !== "conflict" && result.conflictTargetMemoryId) throw new Error("invalid_candidate_conflict_target");
  const inputHash = await domainSeparatedHash("operia/conversation-import/candidate/v1", [{
    summary_input_hash: input.summaryInputHash,
    content_hash: contentHash,
    fact_key: result.factKey,
    source_message_ids: sourceMessageIds,
    policy_class: result.policyClass,
    conflict_target_memory_id: result.conflictTargetMemoryId,
    extractor_version: input.extractorVersion,
    policy_version: input.policyVersion,
  }]);
  return { ...result, content, sourceMessageIds, reviewRequired: true, contentHash, inputHash };
}

function manifestsEqual(left: ImportVectorManifest | undefined, right: ImportVectorManifest): boolean {
  return Boolean(left && canonicalJson(left) === canonicalJson(right));
}

export async function ensureMockImportVector(
  store: ImportVectorStore,
  manifest: ImportVectorManifest,
  vector: number[],
): Promise<"written" | "reused"> {
  if (manifest.dimensions !== CONVERSATION_IMPORT_EMBEDDING_DIMENSIONS
    || vector.length !== CONVERSATION_IMPORT_EMBEDDING_DIMENSIONS
    || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("embedding_dimensions_invalid");
  }
  const inspection = await store.inspect(manifest.vectorId);
  if (inspection.status === "matched") {
    if (!manifestsEqual(inspection.manifest, manifest)) throw new Error("vector_manifest_mismatch");
    return "reused";
  }
  if (inspection.status === "mismatch") throw new Error("vector_manifest_mismatch");
  if (inspection.status === "unknown") throw new Error("vector_inspect_unknown");
  try {
    await store.put(manifest, vector);
  } catch {
    const unknownAfterPut = await store.inspect(manifest.vectorId);
    if (unknownAfterPut.status === "matched" && manifestsEqual(unknownAfterPut.manifest, manifest)) return "written";
    if (unknownAfterPut.status === "mismatch") throw new Error("vector_manifest_mismatch");
    if (unknownAfterPut.status === "unknown") throw new Error("vector_inspect_unknown");
    throw new Error("vector_write_failed");
  }
  const after = await store.inspect(manifest.vectorId);
  if (after.status !== "matched" || !manifestsEqual(after.manifest, manifest)) throw new Error("vector_write_unverified");
  return "written";
}

export async function deleteMockImportVector(store: ImportVectorStore, manifest: ImportVectorManifest): Promise<"deleted" | "missing"> {
  const inspection = await store.inspect(manifest.vectorId);
  if (inspection.status === "missing") return "missing";
  if (inspection.status === "unknown") throw new Error("vector_inspect_unknown");
  if (inspection.status === "mismatch" || !manifestsEqual(inspection.manifest, manifest)) throw new Error("vector_manifest_mismatch");
  try {
    await store.delete(manifest.vectorId);
  } catch {
    const unknownAfterDelete = await store.inspect(manifest.vectorId);
    if (unknownAfterDelete.status === "missing") return "deleted";
    if (unknownAfterDelete.status === "unknown") throw new Error("vector_inspect_unknown");
    throw new Error("vector_delete_failed");
  }
  const after = await store.inspect(manifest.vectorId);
  if (after.status !== "missing") throw new Error("vector_delete_unverified");
  return "deleted";
}

function classifyImpact(input: DerivationImpactInput): Pick<DerivationImpactItem, "classification" | "action"> {
  if (!Number.isInteger(input.activeBatchProvenanceCount) || !Number.isInteger(input.deletingBatchProvenanceCount)
    || input.activeBatchProvenanceCount <= 0 || input.deletingBatchProvenanceCount <= 0
    || input.deletingBatchProvenanceCount > input.activeBatchProvenanceCount) {
    return { classification: "attention", action: "attention" };
  }
  const isMemory = input.refKind === "memory";
  if (isMemory && (!input.currentContentHash || !input.promotionContentHash)) {
    return { classification: "attention", action: "retain" };
  }
  const ownerEdited = isMemory && input.currentContentHash !== input.promotionContentHash;
  if (ownerEdited) return { classification: "owner_edited", action: "retain" };
  if (input.activeBatchProvenanceCount > input.deletingBatchProvenanceCount) {
    return { classification: "shared", action: input.refKind === "batch_link" ? "unlink" : "recompute" };
  }
  if (input.refKind === "batch_link") return { classification: "exclusive", action: "unlink" };
  if (input.refKind === "conversation" || input.refKind === "message" || input.refKind === "summary" || input.refKind === "candidate") {
    return { classification: "exclusive", action: "tombstone" };
  }
  return { classification: "exclusive", action: "delete" };
}

export async function previewDerivationDelete(input: {
  namespace: string;
  batchId: string;
  batchRevision: number;
  graphRevision: number;
  policyVersion: string;
  impacts: readonly DerivationImpactInput[];
}): Promise<DerivationDeletePreview> {
  const graphRevision = input.graphRevision ?? 0;
  const items: DerivationImpactItem[] = [];
  for (const impact of [...input.impacts].sort((left, right) => `${left.refKind}:${left.refId}`.localeCompare(`${right.refKind}:${right.refId}`))) {
    const classified = classifyImpact(impact);
    items.push({
      ...impact,
      ...classified,
      inputHash: await domainSeparatedHash("operia/conversation-import/delete-item/v1", [impact, classified, input.policyVersion]),
    });
  }
  const counts: Record<string, number> = {};
  for (const item of items) {
    for (const key of [`classification:${item.classification}`, `action:${item.action}`]) counts[key] = (counts[key] || 0) + 1;
  }
  const previewDigest = await domainSeparatedHash("operia/conversation-import/delete-preview/v1", [{
    namespace: input.namespace,
    batch_id: input.batchId,
    batch_revision: input.batchRevision,
    graph_revision: graphRevision,
    policy_version: input.policyVersion,
    items: items.map(({ refKind, refId, classification, action, inputHash }) => ({ refKind, refId, classification, action, inputHash })),
  }]);
  return {
    schemaVersion: "conversation-import-delete-preview/v1",
    namespace: input.namespace,
    batchId: input.batchId,
    batchRevision: input.batchRevision,
    graphRevision,
    policyVersion: input.policyVersion,
    items,
    counts,
    previewDigest,
    sideEffects: { d1Writes: 0, vectorWrites: 0, modelFetches: 0 },
  };
}
