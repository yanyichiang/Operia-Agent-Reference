export const CONVERSATION_IMPORT_EMBEDDING_DIMENSIONS = 768 as const;

export type ImportPolicyClass = "ordinary" | "persona" | "identity" | "sensitive" | "conflict";
export type ImportReviewDecision = "approve" | "merge" | "supersede" | "discard";
export type DerivationImpactClassification = "exclusive" | "shared" | "owner_edited" | "attention";

export interface DerivationSourceMessage {
  id: string;
  conversationId: string;
  contentSha256: string;
  occurredAtUtc: string | null;
  canonicalRole: "owner" | "assistant" | "other" | "system" | "tool" | "unknown";
  normalizedText: string;
  active: boolean;
  quarantineStatus: "none" | "excluded" | "quarantined";
  sourceOrder: number;
}

export interface SummaryBounds {
  maxMessages: number;
  maxInputBytes: number;
  maxOutputBytes: number;
}

export interface SummaryIdentityContext {
  promptPolicyVersion: string;
  summarizerVersion: string;
  summarizerModel: string;
}

export interface SummaryProjection {
  messageIds: string[];
  messages: Array<{ role: "owner" | "assistant"; content: string }>;
  inputByteCount: number;
  omittedMessageCount: number;
  inputHash: string;
}

export interface CandidateExtractionResult {
  content: string;
  type: string;
  factKey: string | null;
  confidence: number;
  importance: number;
  sourceMessageIds: string[];
  policyClass: ImportPolicyClass;
  conflictTargetMemoryId: string | null;
}

export interface ValidatedCandidateExtraction extends CandidateExtractionResult {
  reviewRequired: true;
  contentHash: string;
  inputHash: string;
}

export interface ImportVectorManifest {
  namespace: string;
  vectorId: string;
  refKind: "summary" | "memory";
  refId: string;
  inputHash: string;
  model: string;
  dimensions: typeof CONVERSATION_IMPORT_EMBEDDING_DIMENSIONS;
}

export interface ImportVectorStore {
  inspect(vectorId: string): Promise<{ status: "missing" | "matched" | "mismatch" | "unknown"; manifest?: ImportVectorManifest }>;
  put(manifest: ImportVectorManifest, vector: number[]): Promise<void>;
  delete(vectorId: string): Promise<void>;
}

export interface DerivationImpactInput {
  refKind: "batch_link" | "conversation" | "message" | "summary" | "candidate" | "memory" | "vector";
  refId: string;
  activeBatchProvenanceCount: number;
  deletingBatchProvenanceCount: number;
  currentContentHash?: string | null;
  promotionContentHash?: string | null;
}

export interface DerivationImpactItem extends DerivationImpactInput {
  classification: DerivationImpactClassification;
  action: "unlink" | "tombstone" | "delete" | "recompute" | "retain" | "attention";
  inputHash: string;
}

export interface DerivationDeletePreview {
  schemaVersion: "conversation-import-delete-preview/v1";
  namespace: string;
  batchId: string;
  batchRevision: number;
  graphRevision: number;
  policyVersion: string;
  items: DerivationImpactItem[];
  counts: Record<string, number>;
  previewDigest: string;
  sideEffects: { d1Writes: 0; vectorWrites: 0; modelFetches: 0 };
}

export interface DurableDerivationImpactItem {
  runId: string;
  runKind: "delete" | "recompute";
  sourceOrder: number;
  refKind: DerivationImpactItem["refKind"];
  refId: string;
  classification: DerivationImpactItem["classification"];
  action: DerivationImpactItem["action"];
  inputHash: string;
  status: "pending" | "started" | "retry" | "attention";
  generation: number;
  actionKey: string;
  executionLeaseId: string | null;
  leaseExpiresAt: string | null;
}

export interface LocalDerivationActionExecutor {
  inspect(item: DurableDerivationImpactItem): Promise<"not_started" | "completed" | "unknown">;
  apply(item: DurableDerivationImpactItem): Promise<void>;
}
