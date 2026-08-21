import {
  readPublicationDeliveryEvidenceHead,
  readPublicationOutcome,
  recordPublicationDeliveryEvidence,
  sealPublicationSequence,
  stagePublication,
} from "./repository";
import { projectPublicationOutcome } from "./projector";
import type {
  NormalizedDeliveryEvidenceClass,
  PublicationConsumerDisposition,
  PublicationConsumptionContext,
  PublicationOutcome,
  PublicationState,
  StagePublicationInput,
} from "./types";

export type ShadowLegacyPath =
  | "ordinary_delivery_batch"
  | "paragraph_prefix_final"
  | "continuation_final"
  | "deliver_durable_final"
  | "tool_command_direct_append";

export type ShadowLegacyState =
  | "delivered"
  | "delivered_partial"
  | "delivery_unknown"
  | "excluded";

export type ShadowDivergenceCode =
  | "NONE"
  | "LEGACY_ATTENTION_COLLAPSE_REJECTED"
  | "LEGACY_PARTIAL_POLICY"
  | "LEGACY_CANONICAL_TEXT_MISMATCH"
  | "LEGACY_DIRECT_APPEND_BYPASS"
  | "LEGACY_EVIDENCE_INCOMPLETE"
  | "LEGACY_STATE_MISMATCH"
  | "LEGACY_CONSUMPTION_PLAN_MISMATCH"
  | "SHADOW_ADAPTER_EVIDENCE_INCOMPLETE"
  | "SHADOW_REQUIRED_SEQUENCE_OPEN"
  | "SHADOW_TEXT_PROJECTION_UNREPRESENTABLE"
  | "SHADOW_PROJECTION_ERROR"
  | "SHADOW_ADAPTER_UNREPRESENTABLE";

export type ShadowOpenSequenceDivergenceCode = Extract<ShadowDivergenceCode,
  | "LEGACY_DIRECT_APPEND_BYPASS"
  | "LEGACY_EVIDENCE_INCOMPLETE"
  | "SHADOW_ADAPTER_EVIDENCE_INCOMPLETE"
  | "SHADOW_REQUIRED_SEQUENCE_OPEN"
  | "SHADOW_TEXT_PROJECTION_UNREPRESENTABLE"
  | "SHADOW_ADAPTER_UNREPRESENTABLE">;

/**
 * Sequence closure is a durable adapter fact, not an inference made by the
 * shadow projector. A closed signal must identify the durable legacy fact
 * proving that no later required delivery item can join this publication.
 */
export type ShadowSequenceClosure =
  | { kind:"open"; divergenceCode:ShadowOpenSequenceDivergenceCode }
  | { kind:"closed"; evidenceRef:string; observedAt:string };

export type ShadowLegacyProjection = {
  state: ShadowLegacyState | null;
  conversationDisposition: PublicationConsumerDisposition | null;
  memoryDisposition: PublicationConsumerDisposition | null;
  visibleText: string | null;
};

export type ShadowNormalizedEvidence = {
  deliveryItemId: string;
  evidenceRef: string | null;
  evidenceClass: NormalizedDeliveryEvidenceClass;
  observedAt: string;
};

export type ShadowProjectionInput = {
  stage: StagePublicationInput;
  evidence: ShadowNormalizedEvidence[];
  consumptionContext: PublicationConsumptionContext;
  legacyPath: ShadowLegacyPath;
  legacy: ShadowLegacyProjection;
  observedAt: string;
  sequenceClosure: ShadowSequenceClosure;
  comparisonEvidenceRefs?: string[];
  forcedDivergenceCode?: ShadowDivergenceCode;
};

export type ShadowComparison = {
  comparisonIdempotencyKey: string;
  publicationId: string;
  inferenceRunId: string;
  legacyPath: ShadowLegacyPath;
  legacyState: ShadowLegacyState | null;
  shadowState: PublicationState | null;
  legacyConversationDisposition: PublicationConsumerDisposition | null;
  shadowConversationDisposition: PublicationConsumerDisposition | null;
  legacyMemoryDisposition: PublicationConsumerDisposition | null;
  shadowMemoryDisposition: PublicationConsumerDisposition | null;
  divergenceCode: ShadowDivergenceCode;
  evidenceRefs: string[];
  legacyTextSha256: string | null;
  legacyTextLength: number | null;
  shadowConfirmedTextSha256: string | null;
  shadowConfirmedTextLength: number | null;
  shadowCanonicalTextSha256: string | null;
  shadowCanonicalTextLength: number | null;
  observedAt: string;
  revision: number;
};

type HashedText = { sha256: string | null; length: number | null };

async function hashText(value: string | null): Promise<HashedText> {
  if (value === null) return { sha256:null,length:null };
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256",bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2,"0")).join("");
  return { sha256,length:bytes.byteLength };
}

async function comparisonIdentitySuffix(input: Omit<ShadowComparison,"comparisonIdempotencyKey">): Promise<string> {
  const identity = JSON.stringify({
    publicationId:input.publicationId,
    inferenceRunId:input.inferenceRunId,
    legacyPath:input.legacyPath,
    legacyState:input.legacyState,
    shadowState:input.shadowState,
    legacyConversationDisposition:input.legacyConversationDisposition,
    shadowConversationDisposition:input.shadowConversationDisposition,
    legacyMemoryDisposition:input.legacyMemoryDisposition,
    shadowMemoryDisposition:input.shadowMemoryDisposition,
    divergenceCode:input.divergenceCode,
    evidenceRefs:input.evidenceRefs,
    legacyTextSha256:input.legacyTextSha256,
    legacyTextLength:input.legacyTextLength,
    shadowConfirmedTextSha256:input.shadowConfirmedTextSha256,
    shadowConfirmedTextLength:input.shadowConfirmedTextLength,
    shadowCanonicalTextSha256:input.shadowCanonicalTextSha256,
    shadowCanonicalTextLength:input.shadowCanonicalTextLength,
    observedAt:input.observedAt,
    revision:input.revision,
  });
  return (await hashText(identity)).sha256!.slice(0,24);
}

function expectedShadowState(legacy: ShadowLegacyProjection): PublicationState | null {
  if (legacy.state === "delivered" || legacy.state === "delivered_partial") return "delivered";
  if (legacy.state === "delivery_unknown") return "unknown";
  // Legacy `excluded` conflates a delivery fact with consumer policy. A
  // delivered non-assistant notice correctly remains delivered/exclude in the
  // Gate-A vocabulary, so it is compared through the consumption plan below.
  return null;
}

function sameHash(left: HashedText, right: HashedText): boolean {
  return left.sha256 === right.sha256 && left.length === right.length;
}

function divergenceCode(
  input: ShadowProjectionInput,
  outcome: PublicationOutcome | null,
  legacyText: HashedText,
  shadowCanonicalText: HashedText,
): ShadowDivergenceCode {
  if (input.forcedDivergenceCode) return input.forcedDivergenceCode;
  if (!outcome) return "LEGACY_EVIDENCE_INCOMPLETE";
  if (input.legacy.state === "delivery_unknown" && outcome.state === "rejected") {
    return "LEGACY_ATTENTION_COLLAPSE_REJECTED";
  }
  if (input.legacy.state === "delivered_partial") return "LEGACY_PARTIAL_POLICY";
  const expectedState = expectedShadowState(input.legacy);
  if (expectedState !== null && expectedState !== outcome.state) return "LEGACY_STATE_MISMATCH";
  if (input.legacy.conversationDisposition !== outcome.consumptionPlan.conversation.disposition
    || input.legacy.memoryDisposition !== outcome.consumptionPlan.memory.disposition) {
    return "LEGACY_CONSUMPTION_PLAN_MISMATCH";
  }
  if (!sameHash(legacyText,shadowCanonicalText)) return "LEGACY_CANONICAL_TEXT_MISMATCH";
  return "NONE";
}

function comparisonBindings(comparison: ShadowComparison): unknown[] {
  return [
    comparison.comparisonIdempotencyKey,
    comparison.publicationId,
    comparison.inferenceRunId,
    comparison.legacyPath,
    comparison.legacyState,
    comparison.shadowState,
    comparison.legacyConversationDisposition,
    comparison.shadowConversationDisposition,
    comparison.legacyMemoryDisposition,
    comparison.shadowMemoryDisposition,
    comparison.divergenceCode,
    JSON.stringify(comparison.evidenceRefs),
    comparison.legacyTextSha256,
    comparison.legacyTextLength,
    comparison.shadowConfirmedTextSha256,
    comparison.shadowConfirmedTextLength,
    comparison.shadowCanonicalTextSha256,
    comparison.shadowCanonicalTextLength,
    comparison.observedAt,
    comparison.revision,
    comparison.observedAt,
  ];
}

export async function persistShadowComparison(
  db: D1Database,
  comparison: ShadowComparison,
): Promise<{ comparison: ShadowComparison; replayed: boolean }> {
  const inserted = await db.prepare(`INSERT INTO publication_shadow_comparisons(
      comparison_idempotency_key,publication_id,inference_run_id,legacy_path,legacy_state,shadow_state,
      legacy_conversation_disposition,shadow_conversation_disposition,
      legacy_memory_disposition,shadow_memory_disposition,divergence_code,evidence_refs_json,
      legacy_text_sha256,legacy_text_length,shadow_confirmed_text_sha256,shadow_confirmed_text_length,
      shadow_canonical_text_sha256,shadow_canonical_text_length,observed_at,revision,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(comparison_idempotency_key) DO NOTHING
    RETURNING comparison_idempotency_key`)
    .bind(...comparisonBindings(comparison)).first<{comparison_idempotency_key:string}>();
  return { comparison,replayed:!inserted };
}

async function buildComparison(
  input: ShadowProjectionInput,
  outcome: PublicationOutcome | null,
  forcedDivergenceCode = input.forcedDivergenceCode,
): Promise<ShadowComparison> {
  const legacyText = await hashText(input.legacy.visibleText);
  const shadowConfirmedText = await hashText(outcome?.confirmedVisibleText ?? null);
  const shadowCanonicalText = await hashText(outcome?.canonicalVisibleText ?? null);
  const revision = outcome?.revision ?? 0;
  const code = forcedDivergenceCode ?? divergenceCode(input,outcome,legacyText,shadowCanonicalText);
  const evidenceRefs = [...new Set([
    ...(input.comparisonEvidenceRefs ?? []),
    ...input.evidence.flatMap((item) => item.evidenceRef ? [item.evidenceRef] : []),
    ...(input.sequenceClosure.kind === "closed" ? [input.sequenceClosure.evidenceRef] : []),
  ])].sort();
  const comparisonWithoutIdentity: Omit<ShadowComparison,"comparisonIdempotencyKey"> = {
    publicationId:input.stage.publicationId,
    inferenceRunId:input.stage.inferenceRunId,
    legacyPath:input.legacyPath,
    legacyState:input.legacy.state,
    shadowState:outcome?.state ?? null,
    legacyConversationDisposition:input.legacy.conversationDisposition,
    shadowConversationDisposition:outcome?.consumptionPlan.conversation.disposition ?? null,
    legacyMemoryDisposition:input.legacy.memoryDisposition,
    shadowMemoryDisposition:outcome?.consumptionPlan.memory.disposition ?? null,
    divergenceCode:code,
    evidenceRefs,
    legacyTextSha256:legacyText.sha256,
    legacyTextLength:legacyText.length,
    shadowConfirmedTextSha256:shadowConfirmedText.sha256,
    shadowConfirmedTextLength:shadowConfirmedText.length,
    shadowCanonicalTextSha256:shadowCanonicalText.sha256,
    shadowCanonicalTextLength:shadowCanonicalText.length,
    observedAt:input.observedAt,
    revision,
  };
  return {
    comparisonIdempotencyKey:`publication-shadow:${input.stage.publicationId}:${input.legacyPath}:r${revision}:${code}:${await comparisonIdentitySuffix(comparisonWithoutIdentity)}`,
    ...comparisonWithoutIdentity,
  };
}

async function stageAndRecordEvidence(db: D1Database, input: ShadowProjectionInput): Promise<void> {
  if (input.stage.batches.length === 0 && input.stage.items.length === 0) return;
  if (input.stage.batches.length === 0 || input.stage.items.length === 0) {
    throw new Error("shadow_publication_stage_incomplete");
  }
  await stagePublication(db,input.stage);
  for (const evidence of input.evidence) {
    if (evidence.evidenceClass === "pending") continue;
    if (!evidence.evidenceRef) throw new Error("shadow_delivery_evidence_ref_missing");
    const head = await readPublicationDeliveryEvidenceHead(db,evidence.deliveryItemId);
    if (head?.evidenceRef === evidence.evidenceRef
      && head.evidenceClass === evidence.evidenceClass) continue;
    await recordPublicationDeliveryEvidence(db,{
      publicationId:input.stage.publicationId,
      deliveryItemId:evidence.deliveryItemId,
      evidenceRef:evidence.evidenceRef,
      evidenceClass:evidence.evidenceClass,
      expectedEvidenceRevision:head?.evidenceRevision ?? 0,
      observedAt:evidence.observedAt,
    });
  }
}

export async function projectPublicationShadow(
  db: D1Database,
  input: ShadowProjectionInput,
): Promise<
  | { kind:"open"; outcome:null; comparison:ShadowComparison; replayed:boolean; sequenceSealed:false }
  | { kind:"projected"; outcome:PublicationOutcome; comparison:ShadowComparison; replayed:boolean; sequenceSealed:boolean }
> {
  await stageAndRecordEvidence(db,input);
  if (input.sequenceClosure.kind === "open") {
    const comparison = await buildComparison(input,null,input.sequenceClosure.divergenceCode);
    const comparisonWrite = await persistShadowComparison(db,comparison);
    return {
      kind:"open",outcome:null,comparison,replayed:comparisonWrite.replayed,sequenceSealed:false,
    };
  }
  if (!input.sequenceClosure.evidenceRef.trim()) {
    throw new Error("shadow_sequence_closure_evidence_ref_missing");
  }
  const seal = await sealPublicationSequence(
    db,input.stage.publicationId,input.sequenceClosure.observedAt,
  );
  const projected = await projectPublicationOutcome(db,{
    publicationId:input.stage.publicationId,
    consumptionContext:input.consumptionContext,
    observedAt:input.observedAt,
  });
  if (projected.kind === "not_ready") throw new Error(`shadow_publication_${projected.reasonCode}`);
  const comparison = await buildComparison(input,projected.outcome);
  const comparisonWrite = await persistShadowComparison(db,comparison);
  return {
    kind:"projected",
    outcome:projected.outcome,
    comparison,
    replayed:(projected.kind === "noop" || projected.replayed) && comparisonWrite.replayed,
    sequenceSealed:seal.changed,
  };
}

/**
 * Gate C native mode owns all Gate-A delivery facts. Shadow may still compare
 * the legacy result, but it is limited to reading the already-projected
 * outcome and appending metadata-only comparison telemetry.
 */
export async function comparePublicationShadowReadOnly(
  db: D1Database,
  input: ShadowProjectionInput,
): Promise<{ outcome:PublicationOutcome | null; comparison:ShadowComparison; replayed:boolean }> {
  const outcome = await readPublicationOutcome(db,input.stage.publicationId);
  const comparison = await buildComparison(input,outcome);
  const persisted = await persistShadowComparison(db,comparison);
  return {outcome,comparison,replayed:persisted.replayed};
}

export async function recordShadowProjectionDiagnostic(
  db: D1Database,
  input: Pick<ShadowProjectionInput,"stage"|"legacyPath"|"legacy"|"observedAt"> & {
    evidenceRefs: string[];
    divergenceCode: "SHADOW_PROJECTION_ERROR" | "SHADOW_ADAPTER_UNREPRESENTABLE";
  },
): Promise<ShadowComparison> {
  const projectionInput: ShadowProjectionInput = {
    ...input,
    evidence:[],
    comparisonEvidenceRefs:input.evidenceRefs,
    consumptionContext:{generationCompleteness:null},
    sequenceClosure:{kind:"open",divergenceCode:"SHADOW_ADAPTER_UNREPRESENTABLE"},
  };
  const comparison = await buildComparison(projectionInput,null,input.divergenceCode);
  await persistShadowComparison(db,comparison);
  return comparison;
}
