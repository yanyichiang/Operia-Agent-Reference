import type {
  AtomicSpanEvidence,
  CompositeConfirmationEvidence,
  ElicitationOrigin,
  EvidenceUnit,
  ScopedToolObservationEvidence,
} from "./contracts";
import {
  memoryArtifactHash,
  utf16IndexToUtf8Offset,
  utf8ByteLength,
  utf8Slice,
  utf8SpanHash,
} from "./integrity";

export const MEMORY_EVIDENCE_UNIT_POLICY_VERSION = "memory-evidence-unit-v2.0.0";
export const MEMORY_EVIDENCE_LINEAGE_VERSION = "memory-root-lineage-v2";

const SHORT_WHOLE_MESSAGE_MAX_BYTES = 384;

export type AtomicSpanInput = {
  canonicalEventId: string;
  conversationId: string;
  contentRevision: number;
  content: string;
  episodeId: string;
  quote?: string;
  allowWholeMessage?: boolean;
  elicitationOrigin?: ElicitationOrigin;
};

function exactUniqueQuoteSpan(content: string, quote: string): { byteStart: number; byteEnd: number } {
  const first = content.indexOf(quote);
  if (first < 0) throw new Error("memory_evidence_quote_not_found");
  if (content.indexOf(quote,first + quote.length) >= 0) throw new Error("memory_evidence_quote_ambiguous");
  return {
    byteStart: utf16IndexToUtf8Offset(content,first),
    byteEnd: utf16IndexToUtf8Offset(content,first + quote.length),
  };
}

export async function buildAtomicSpanEvidence(input: AtomicSpanInput): Promise<AtomicSpanEvidence> {
  if (!input.canonicalEventId.trim() || !input.conversationId.trim() || !input.episodeId.trim()) {
    throw new Error("memory_evidence_identity_required");
  }
  if (!Number.isSafeInteger(input.contentRevision) || input.contentRevision < 1) {
    throw new Error("memory_evidence_content_revision_invalid");
  }
  if (!input.content.trim()) throw new Error("memory_evidence_content_required");
  let byteStart: number;
  let byteEnd: number;
  const quote = input.quote;
  if (quote?.trim()) {
    ({ byteStart,byteEnd } = exactUniqueQuoteSpan(input.content,quote));
  } else {
    if (!input.allowWholeMessage || utf8ByteLength(input.content) > SHORT_WHOLE_MESSAGE_MAX_BYTES) {
      throw new Error("memory_evidence_precise_quote_required");
    }
    byteStart = 0;
    byteEnd = utf8ByteLength(input.content);
  }
  const spanHash = await utf8SpanHash({
    canonicalEventId: input.canonicalEventId,
    contentRevision: input.contentRevision,
    content: input.content,
    byteStart,
    byteEnd,
  });
  const rootLineageHash = await memoryArtifactHash("memory-root-lineage-v2", {
    canonicalEventId: input.canonicalEventId,
    contentRevision: input.contentRevision,
    lineageVersion: MEMORY_EVIDENCE_LINEAGE_VERSION,
  });
  const identity = {
    canonicalEventId: input.canonicalEventId,
    contentRevision: input.contentRevision,
    byteStart,
    byteEnd,
    spanHash,
    episodeId: input.episodeId,
  };
  const evidenceUnitHash = await memoryArtifactHash("memory-atomic-span-evidence-v2",identity);
  return {
    kind: "atomic_span",
    evidenceUnitId: `eu_${evidenceUnitHash.slice(0,32)}`,
    canonicalEventId: input.canonicalEventId,
    conversationId: input.conversationId,
    contentRevision: input.contentRevision,
    byteStart,
    byteEnd,
    spanHash,
    episodeId: input.episodeId,
    rootLineageId: `lin_${rootLineageHash.slice(0,32)}`,
    elicitationOrigin: input.elicitationOrigin ?? "NOT_APPLICABLE",
  };
}

export async function verifyAtomicSpanEvidence(
  evidence: AtomicSpanEvidence,
  canonicalContent: string,
): Promise<string> {
  const expected = await utf8SpanHash({
    canonicalEventId: evidence.canonicalEventId,
    contentRevision: evidence.contentRevision,
    content: canonicalContent,
    byteStart: evidence.byteStart,
    byteEnd: evidence.byteEnd,
  });
  if (expected !== evidence.spanHash) throw new Error("memory_evidence_span_hash_mismatch");
  return utf8Slice(canonicalContent,evidence.byteStart,evidence.byteEnd);
}

export async function buildCompositeConfirmationEvidence(input: {
  question: AtomicSpanEvidence;
  answer: AtomicSpanEvidence;
  elicitationOrigin: Exclude<ElicitationOrigin, "NOT_APPLICABLE" | "TOOL_ROOTED">;
  explicitReplyTo: boolean;
  strictlyAdjacent: boolean;
  singleProposition: boolean;
  neutralQuestion: boolean;
  explicitAnswer: boolean;
  nonAssertiveMode: boolean;
}): Promise<CompositeConfirmationEvidence> {
  if (input.question.conversationId !== input.answer.conversationId) {
    throw new Error("memory_confirmation_conversation_mismatch");
  }
  if (input.question.episodeId !== input.answer.episodeId) {
    throw new Error("memory_confirmation_episode_mismatch");
  }
  const ruleCodes: string[] = [];
  if (!(input.explicitReplyTo || input.strictlyAdjacent)) ruleCodes.push("CONFIRMATION_NOT_STRUCTURALLY_BOUND");
  if (!input.singleProposition) ruleCodes.push("CONFIRMATION_COMPOUND_PROPOSITION");
  if (!input.neutralQuestion) ruleCodes.push("CONFIRMATION_QUESTION_NOT_NEUTRAL");
  if (!input.explicitAnswer) ruleCodes.push("CONFIRMATION_ANSWER_AMBIGUOUS");
  if (input.nonAssertiveMode) ruleCodes.push("NON_ASSERTIVE_SOURCE_MODE");
  if (input.elicitationOrigin === "ASSISTANT_NOVEL") ruleCodes.push("ASSISTANT_NOVEL_PROPOSITION_NOT_OWNER_KNOWN");
  const strongOwnerAuthority = ruleCodes.length === 0;
  if (strongOwnerAuthority) ruleCodes.push("OWNER_COMPOSITE_CONFIRMATION_AUTHORITY");
  const evidenceHash = await memoryArtifactHash("memory-composite-confirmation-v2", {
    questionEvidenceUnitId: input.question.evidenceUnitId,
    answerEvidenceUnitId: input.answer.evidenceUnitId,
    episodeId: input.answer.episodeId,
    elicitationOrigin: input.elicitationOrigin,
    strongOwnerAuthority,
    ruleCodes: [...ruleCodes].sort(),
  });
  return {
    kind: "composite_confirmation",
    evidenceUnitId: `eu_${evidenceHash.slice(0,32)}`,
    questionEvidenceUnitId: input.question.evidenceUnitId,
    answerEvidenceUnitId: input.answer.evidenceUnitId,
    conversationId: input.answer.conversationId,
    episodeId: input.answer.episodeId,
    rootLineageId: input.answer.rootLineageId,
    elicitationOrigin: input.elicitationOrigin,
    strongOwnerAuthority,
    authorityRuleCodes: [...ruleCodes].sort(),
  };
}

export async function buildScopedToolObservationEvidence(input: {
  toolResult: AtomicSpanEvidence;
  authorityAttestation: AtomicSpanEvidence;
  toolId: string;
  observationScope: string;
}): Promise<ScopedToolObservationEvidence> {
  if (input.toolResult.conversationId !== input.authorityAttestation.conversationId) {
    throw new Error("memory_tool_observation_conversation_mismatch");
  }
  if (input.toolResult.episodeId !== input.authorityAttestation.episodeId) {
    throw new Error("memory_tool_observation_episode_mismatch");
  }
  if (!input.toolId.trim() || !input.observationScope.trim()) {
    throw new Error("memory_tool_observation_scope_required");
  }
  const rootLineageHash = await memoryArtifactHash("memory-tool-observation-lineage-v2", {
    toolResultRootLineageId: input.toolResult.rootLineageId,
    authorityRootLineageId: input.authorityAttestation.rootLineageId,
    episodeId: input.toolResult.episodeId,
    toolId: input.toolId,
  });
  const evidenceHash = await memoryArtifactHash("memory-scoped-tool-observation-v2", {
    toolResultEvidenceUnitId: input.toolResult.evidenceUnitId,
    authorityAttestationEvidenceUnitId: input.authorityAttestation.evidenceUnitId,
    toolId: input.toolId,
    observationScope: input.observationScope,
  });
  return {
    kind: "scoped_tool_observation",
    evidenceUnitId: `eu_${evidenceHash.slice(0,32)}`,
    toolResultEvidenceUnitId: input.toolResult.evidenceUnitId,
    authorityAttestationEvidenceUnitId: input.authorityAttestation.evidenceUnitId,
    conversationId: input.toolResult.conversationId,
    episodeId: input.toolResult.episodeId,
    rootLineageId: `lin_${rootLineageHash.slice(0,32)}`,
    toolId: input.toolId,
    observationScope: input.observationScope,
  };
}

export function evidenceUnitMemberIds(unit: EvidenceUnit): string[] {
  if (unit.kind === "atomic_span") return [unit.evidenceUnitId];
  if (unit.kind === "composite_confirmation") {
    return [unit.questionEvidenceUnitId,unit.answerEvidenceUnitId];
  }
  return [unit.toolResultEvidenceUnitId,unit.authorityAttestationEvidenceUnitId];
}
