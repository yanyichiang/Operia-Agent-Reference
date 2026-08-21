import { getMessagesByIds } from "../../db/messages";
import type { Env, MessageRecord } from "../../types";
import { canonicalJson } from "../import/hashes";
import type {
  AssertionKind,
  CanonicalEvidenceRef,
  ClaimQualifiers,
  ClaimScope,
  ClaimAtomV2,
  ClaimGroup,
  AtomicSpanEvidence,
  CompositeConfirmationEvidence,
  ElicitationOrigin,
  EvidenceInterpretation,
  FactRevision,
} from "./contracts";
import { materializeClaimGroup } from "./claimAtoms";
import {
  buildAtomicSpanEvidence,
  buildCompositeConfirmationEvidence,
  MEMORY_EVIDENCE_LINEAGE_VERSION,
  MEMORY_EVIDENCE_UNIT_POLICY_VERSION,
  verifyAtomicSpanEvidence,
} from "./evidenceUnits";
import {
  MEMORY_VNEXT_EXTRACTOR_SCHEMA_VERSION,
  MEMORY_VNEXT_GATE_B_POLICY_VERSION,
  classifyProposal,
  evaluateProposalAuthority,
  materializeShadowProposals,
  parseStructuredExtractorOutput,
  type StructuredExtractorProposal,
} from "./gateBContracts";
import { memoryArtifactHash } from "./integrity";
import { validateClaimAtomAgainstPredicate } from "./predicateRegistry";
import { buildLocalSecretRedactedViews } from "./secretViews";

export const MEMORY_VNEXT_ORDINARY_WRITER_VERSION = "memory-vnext-ordinary-fact-writer-c1";
const DEFAULT_DRAIN_LIMIT = 24;
const MAX_DRAIN_LIMIT = 100;

export type OrdinaryJudgeEvidenceProposal = {
  localEvidenceKey?: string;
  messageId: string;
  quote?: string;
  proposedSubject: "owner" | "operia" | "relationship" | "world" | "third_party";
  proposedSourceMode:
    | "direct_statement"
    | "reply_confirmation"
    | "observation"
    | "quotation"
    | "hypothetical"
    | "roleplay"
    | "sarcasm_ambiguous"
    | "import";
  evidenceRelation: "SUPPORTS" | "CONTRADICTS" | "CONFIRMS" | "QUALIFIES";
  questionMessageId?: string | null;
  questionQuote?: string | null;
  elicitationOrigin?: ElicitationOrigin;
  singleProposition?: boolean | null;
  neutralQuestion?: boolean | null;
  explicitAnswer?: boolean | null;
};

export type OrdinaryJudgeClaimAtomProposal = {
  localClaimKey: string;
  subjectRef: "owner" | "operia" | "relationship" | "world" | "third_party";
  assertionKind: AssertionKind;
  predicateId: string;
  objectRef: string | null;
  canonicalValue: unknown;
  scope: ClaimScope;
  qualifiers: ClaimQualifiers;
  evidence: OrdinaryJudgeEvidenceProposal[];
};

export type OrdinaryJudgeClaim = {
  schemaVersion?: "memory-ordinary-judge-claim-v2";
  claimGroupLocalKey?: string;
  primaryMessageId?: string;
  atoms?: OrdinaryJudgeClaimAtomProposal[];
  uncertaintyCodes?: string[];
  // Compatibility projection used only by the existing Gate B / legacy
  // FactRevision bridge while ClaimAtom v2 remains a dual-write shadow.
  subject: "owner" | "operia" | "relationship" | "world" | "third_party";
  predicate: string;
  scope: string;
  evidence: OrdinaryJudgeEvidenceProposal[];
};

export function isOrdinaryJudgeClaimV2(
  claim: OrdinaryJudgeClaim,
): claim is OrdinaryJudgeClaim & {
  schemaVersion: "memory-ordinary-judge-claim-v2";
  claimGroupLocalKey: string;
  primaryMessageId: string;
  atoms: OrdinaryJudgeClaimAtomProposal[];
  uncertaintyCodes: string[];
} {
  return claim.schemaVersion === "memory-ordinary-judge-claim-v2"
    && typeof claim.claimGroupLocalKey === "string"
    && typeof claim.primaryMessageId === "string"
    && Array.isArray(claim.atoms)
    && claim.atoms.length > 0
    && Array.isArray(claim.uncertaintyCodes);
}

export type EnqueueOrdinaryFactWriteInput = {
  namespace: string;
  judgeRunId: string;
  candidateId: string;
  legacyMemoryId: string;
  legacyOutcome: "approved" | "merged";
  claim: OrdinaryJudgeClaim | null;
  sourceMessageIds: string[];
  judgeModel: string;
  judgePolicyVersion: string;
  createdAtUtc: string;
  origin?: "live_judge" | "recovered_claim" | "legacy_backfill";
  learnedAtUtc?: string;
  claimCapturedAtUtc?: string;
  backfillRunId?: string | null;
};

type PendingWriteInputRow = {
  input_id: string;
  namespace: string;
  judge_run_id: string;
  candidate_id: string;
  legacy_memory_id: string;
  legacy_outcome: "approved" | "merged";
  claim_json: string;
  source_message_ids_json: string;
  judge_model: string;
  judge_policy_version: string;
  judge_output_hash: string;
  created_at: string;
};

type CandidateRow = {
  content: string;
};

type HeadRevisionRow = {
  fact_revision_id: string;
  revision: number;
  value_json: string;
  epistemic_status: FactRevision["epistemicStatus"];
  lifecycle_status: FactRevision["lifecycleStatus"];
};

type WriteOriginRow = {
  learned_at_utc: string;
  claim_captured_at_utc: string;
};

export type OrdinaryFactWriterResult = {
  inputId: string;
  status:
    | "COMMITTED"
    | "DUPLICATE"
    | "DEFERRED_COMPARISON"
    | "OWNER_REVIEW"
    | "REJECTED_INVALID_CLAIM"
    | "REJECTED_SECRET"
    | "REJECTED_AUTHORITY"
    | "REJECTED_PROTECTED"
    | "REJECTED_MISSING_SOURCE"
    | "STALE_CAS";
  action:
    | "ADD"
    | "REINFORCE"
    | "DUPLICATE"
    | "COEXISTS"
    | "STATE_CHANGE"
    | "RETROACTIVE_CORRECTION"
    | "SCOPE_CLARIFICATION"
    | "EPISTEMIC_RETRACTION"
    | "DISPUTE"
    | "DEFERRED_COMPARISON"
    | "REJECT";
  factRevisionId: string | null;
  txnSeq: number | null;
};

function flag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function evidenceActor(message: MessageRecord): Pick<CanonicalEvidenceRef, "actorId" | "actorClass" | "eventRole" | "toolId"> {
  if (message.role === "user") {
    return { actorId: "owner", actorClass: "owner", eventRole: "user_message", toolId: null };
  }
  if (message.role === "assistant") {
    return { actorId: "operia", actorClass: "operia", eventRole: "assistant_message", toolId: null };
  }
  if (message.role === "tool") {
    return { actorId: "untrusted_tool_event", actorClass: "unknown", eventRole: "tool_result", toolId: null };
  }
  return { actorId: "system", actorClass: "system", eventRole: "imported_event", toolId: null };
}

async function legacyEvidenceRef(message: MessageRecord): Promise<CanonicalEvidenceRef> {
  const actor = evidenceActor(message);
  const redacted = buildLocalSecretRedactedViews(message.content);
  const refHash = await memoryArtifactHash("memory-canonical-evidence-ref", {
    eventId: message.id,
    contentRevision: 1,
  });
  return {
    evidenceRefId: `er_${refHash.slice(0, 32)}`,
    eventId: message.id,
    conversationId: message.conversation_id,
    ...actor,
    replyToEventId: null,
    occurredAtUtc: message.created_at,
    evidenceTimePrecision: "exact",
    contentRevision: 1,
    contentRef: message.id,
    byteStart: null,
    byteEnd: null,
    spanRef: null,
    sensitivity: redacted.secretSpans.length > 0 ? "secret" : "normal",
  };
}

type EvidenceStructuralEdgeArtifact = {
  structuralEdgeId: string;
  fromEvidenceRefId: string;
  toEvidenceRefId: string;
  edgeKind: "REPLY_TO" | "QUESTION_ANSWER" | "TOOL_CALL_RESULT" | "ATOMIC_SIBLING" | "MINIMAL_EXCHANGE";
  edgeOrdinal: number;
};

type V2ClaimArtifacts = {
  evidenceRefs: CanonicalEvidenceRef[];
  atomicUnits: AtomicSpanEvidence[];
  compositeUnits: CompositeConfirmationEvidence[];
  structuralEdges: EvidenceStructuralEdgeArtifact[];
  evidenceRefIdByLocalKey: Map<string,string>;
  claimGroup: ClaimGroup;
  claimAtoms: ClaimAtomV2[];
};

function modelProvider(model: string): string {
  const normalized = model.trim();
  const separator = normalized.indexOf("/");
  return (separator > 0 ? normalized.slice(0,separator) : normalized) || "unknown";
}

function explicitShortConfirmation(content: string): boolean {
  const normalized = content.normalize("NFKC").trim().toLowerCase().replace(/[。.!！?？]+$/g,"");
  return new Set(["对","对的","是","是的","没错","嗯","嗯嗯","yes","correct","right"]).has(normalized);
}

function structurallySingleQuestion(content: string): boolean {
  const normalized = content.normalize("NFKC").trim();
  if (!normalized) return false;
  const clauses = normalized.split(/[，,；;。.!！?？]+/).map((value) => value.trim()).filter(Boolean);
  if (clauses.length !== 1) return false;
  return !/(以及|并且|同时|还是|或者|又.{0,12}又)/u.test(normalized);
}

function structurallyNeutralQuestion(content: string): boolean {
  const normalized = content.normalize("NFKC").trim();
  return !/(难道|显然|当然|你肯定|你一定|不是吗|对吧.{0,2}对吧)/u.test(normalized);
}

async function isStrictlyAdjacent(
  db: D1Database,
  namespace: string,
  question: MessageRecord,
  answer: MessageRecord,
): Promise<boolean> {
  if (question.conversation_id !== answer.conversation_id) return false;
  if (Date.parse(question.created_at) > Date.parse(answer.created_at)) return false;
  const prior = await db.prepare(`SELECT id FROM messages
    WHERE namespace=? AND conversation_id=? AND role IN ('user','assistant')
      AND publication_state IN ('source_received','delivered')
      AND (created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC,id DESC LIMIT 1`).bind(
      namespace,answer.conversation_id,answer.created_at,answer.created_at,answer.id,
    ).first<{ id: string }>();
  return prior?.id === question.id;
}

async function canonicalEvidenceRefFromAtomic(input: {
  message: MessageRecord;
  atomic: AtomicSpanEvidence;
  replyToEventId: string | null;
  evidenceUnitKind?: CanonicalEvidenceRef["evidenceUnitKind"];
  rootLineageId?: string;
  elicitationOrigin?: ElicitationOrigin;
  compositeStrongOwnerAuthority?: boolean;
}): Promise<CanonicalEvidenceRef> {
  const actor = evidenceActor(input.message);
  const redacted = buildLocalSecretRedactedViews(input.message.content);
  await verifyAtomicSpanEvidence(input.atomic,input.message.content);
  return {
    evidenceRefId: input.atomic.evidenceUnitId,
    eventId: input.message.id,
    conversationId: input.message.conversation_id,
    ...actor,
    replyToEventId: input.replyToEventId,
    occurredAtUtc: input.message.created_at,
    evidenceTimePrecision: "exact",
    contentRevision: input.atomic.contentRevision,
    contentRef: input.message.id,
    byteStart: input.atomic.byteStart,
    byteEnd: input.atomic.byteEnd,
    spanRef: `span:${input.atomic.spanHash}`,
    sensitivity: redacted.secretSpans.length > 0 ? "secret" : "normal",
    evidenceUnitKind: input.evidenceUnitKind ?? "atomic_span",
    spanHash: input.atomic.spanHash,
    episodeId: input.atomic.episodeId,
    rootLineageId: input.rootLineageId ?? input.atomic.rootLineageId,
    elicitationOrigin: input.elicitationOrigin ?? input.atomic.elicitationOrigin,
    compositeStrongOwnerAuthority: input.compositeStrongOwnerAuthority,
  };
}

async function materializeV2ClaimArtifacts(
  db: D1Database,
  row: PendingWriteInputRow,
  claim: OrdinaryJudgeClaim & {
    schemaVersion: "memory-ordinary-judge-claim-v2";
    claimGroupLocalKey: string;
    primaryMessageId: string;
    atoms: OrdinaryJudgeClaimAtomProposal[];
    uncertaintyCodes: string[];
  },
  messageById: ReadonlyMap<string,MessageRecord>,
): Promise<V2ClaimArtifacts> {
  const primary = messageById.get(claim.primaryMessageId);
  if (!primary) throw new Error("memory_claim_group_primary_event_missing");
  const conversationIds = new Set(claim.atoms.flatMap((atom) => atom.evidence.flatMap((evidence) => [
    messageById.get(evidence.messageId)?.conversation_id,
    evidence.questionMessageId ? messageById.get(evidence.questionMessageId)?.conversation_id : undefined,
  ])).filter((value): value is string => Boolean(value)));
  if (conversationIds.size !== 1 || !conversationIds.has(primary.conversation_id)) {
    throw new Error("memory_claim_group_conversation_mismatch");
  }
  const episodeHash = await memoryArtifactHash("memory-evidence-episode-v2", {
    namespace: row.namespace,
    conversationId: primary.conversation_id,
    sourceEventIds: [...messageById.keys()].sort(),
  });
  const episodeId = `ep_${episodeHash.slice(0,32)}`;
  const atomicById = new Map<string,AtomicSpanEvidence>();
  const refById = new Map<string,CanonicalEvidenceRef>();
  const compositeById = new Map<string,CompositeConfirmationEvidence>();
  const evidenceRefIdByLocalKey = new Map<string,string>();
  const evidenceUnitIdsByClaimKey = new Map<string,string[]>();
  const structuralEdges: EvidenceStructuralEdgeArtifact[] = [];

  const addAtomic = async (
    message: MessageRecord,
    quote: string,
    elicitationOrigin: ElicitationOrigin,
  ): Promise<AtomicSpanEvidence> => {
    const atomic = await buildAtomicSpanEvidence({
      canonicalEventId: message.id,
      conversationId: message.conversation_id,
      contentRevision: 1,
      content: message.content,
      episodeId,
      quote,
      elicitationOrigin,
    });
    atomicById.set(atomic.evidenceUnitId,atomic);
    return atomic;
  };

  for (const atom of claim.atoms) {
    const claimEvidenceUnitIds: string[] = [];
    for (const proposed of atom.evidence) {
      const message = messageById.get(proposed.messageId);
      if (!message || !proposed.quote || !proposed.localEvidenceKey) {
        throw new Error("memory_claim_evidence_span_proposal_missing");
      }
      let elicitationOrigin = proposed.elicitationOrigin ?? (message.role === "user" ? "OWNER_ROOTED" : "NOT_APPLICABLE");
      const answerAtomic = await addAtomic(message,proposed.quote,elicitationOrigin);
      let gateBRef: CanonicalEvidenceRef;
      let claimEvidenceUnitId = answerAtomic.evidenceUnitId;
      if (proposed.proposedSourceMode === "reply_confirmation") {
        const question = proposed.questionMessageId ? messageById.get(proposed.questionMessageId) : undefined;
        if (!question || !proposed.questionQuote) throw new Error("memory_confirmation_question_missing");
        const questionAtomic = await addAtomic(question,proposed.questionQuote,"NOT_APPLICABLE");
        const independentOwnerRoot = atom.evidence.some((candidate) => candidate !== proposed
          && candidate.proposedSourceMode === "direct_statement"
          && messageById.get(candidate.messageId)?.role === "user");
        elicitationOrigin = question.role === "assistant"
          ? independentOwnerRoot ? "NEUTRAL_RESTATEMENT" : "ASSISTANT_NOVEL"
          : "OWNER_ROOTED";
        const composite = await buildCompositeConfirmationEvidence({
          question: questionAtomic,
          answer: { ...answerAtomic,elicitationOrigin },
          elicitationOrigin: elicitationOrigin as Exclude<ElicitationOrigin,"NOT_APPLICABLE" | "TOOL_ROOTED">,
          explicitReplyTo: false,
          strictlyAdjacent: await isStrictlyAdjacent(db,row.namespace,question,message),
          singleProposition: proposed.singleProposition === true && structurallySingleQuestion(proposed.questionQuote),
          neutralQuestion: proposed.neutralQuestion === true && structurallyNeutralQuestion(proposed.questionQuote),
          explicitAnswer: proposed.explicitAnswer === true && explicitShortConfirmation(proposed.quote),
          nonAssertiveMode: false,
        });
        compositeById.set(composite.evidenceUnitId,composite);
        claimEvidenceUnitId = composite.evidenceUnitId;
        gateBRef = await canonicalEvidenceRefFromAtomic({
          message,
          atomic: answerAtomic,
          replyToEventId: question.id,
          evidenceUnitKind: "composite_confirmation",
          rootLineageId: composite.rootLineageId,
          elicitationOrigin: composite.elicitationOrigin,
          compositeStrongOwnerAuthority: composite.strongOwnerAuthority,
        });
        const edgeHash = await memoryArtifactHash("memory-evidence-structural-edge-v2", {
          fromEvidenceRefId: answerAtomic.evidenceUnitId,
          toEvidenceRefId: questionAtomic.evidenceUnitId,
          edgeKind: "QUESTION_ANSWER",
        });
        structuralEdges.push({
          structuralEdgeId: `ese_${edgeHash.slice(0,32)}`,
          fromEvidenceRefId: answerAtomic.evidenceUnitId,
          toEvidenceRefId: questionAtomic.evidenceUnitId,
          edgeKind: "QUESTION_ANSWER",
          edgeOrdinal: structuralEdges.length,
        });
        if (!refById.has(questionAtomic.evidenceUnitId)) {
          refById.set(questionAtomic.evidenceUnitId,await canonicalEvidenceRefFromAtomic({
            message: question,
            atomic: questionAtomic,
            replyToEventId: null,
          }));
        }
      } else {
        gateBRef = await canonicalEvidenceRefFromAtomic({ message,atomic: answerAtomic,replyToEventId: null });
      }
      const priorRef = refById.get(gateBRef.evidenceRefId);
      if (priorRef && priorRef.spanHash !== gateBRef.spanHash) throw new Error("memory_evidence_unit_identity_collision");
      refById.set(gateBRef.evidenceRefId,gateBRef);
      if (evidenceRefIdByLocalKey.has(proposed.localEvidenceKey)) {
        throw new Error("memory_claim_local_evidence_key_duplicate");
      }
      evidenceRefIdByLocalKey.set(proposed.localEvidenceKey,gateBRef.evidenceRefId);
      claimEvidenceUnitIds.push(claimEvidenceUnitId);
    }
    evidenceUnitIdsByClaimKey.set(atom.localClaimKey,[...new Set(claimEvidenceUnitIds)].sort());
  }
  const materialized = await materializeClaimGroup({
    canonicalEventId: primary.id,
    contentRevision: 1,
    drafts: claim.atoms.map((atom) => ({
      subjectRef: atom.subjectRef,
      assertionKind: atom.assertionKind,
      predicateId: atom.predicateId,
      objectRef: atom.objectRef,
      canonicalValue: atom.canonicalValue,
      scope: atom.scope,
      qualifiers: atom.qualifiers,
      evidenceUnitIds: evidenceUnitIdsByClaimKey.get(atom.localClaimKey) ?? [],
    })),
  });
  return {
    evidenceRefs: [...refById.values()].sort((left,right) => left.evidenceRefId.localeCompare(right.evidenceRefId)),
    atomicUnits: [...atomicById.values()].sort((left,right) => left.evidenceUnitId.localeCompare(right.evidenceUnitId)),
    compositeUnits: [...compositeById.values()].sort((left,right) => left.evidenceUnitId.localeCompare(right.evidenceUnitId)),
    structuralEdges: structuralEdges.sort((left,right) => left.structuralEdgeId.localeCompare(right.structuralEdgeId)),
    evidenceRefIdByLocalKey,
    claimGroup: materialized.group,
    claimAtoms: materialized.atoms,
  };
}

export async function buildOrdinaryFactWriteInput(
  input: EnqueueOrdinaryFactWriteInput,
): Promise<{ inputId: string; judgeInputHash: string; judgeOutputHash: string; claimJson: string; sourceMessageIdsJson: string }> {
  const sourceMessageIds = [...new Set(input.sourceMessageIds.map((id) => id.trim()).filter(Boolean))].sort();
  const claimJson = canonicalJson(input.claim);
  const judgeInputHash = await memoryArtifactHash("memory-ordinary-judge-input", {
    namespace: input.namespace,
    candidateId: input.candidateId,
    sourceMessageIds,
    model: input.judgeModel,
    policyVersion: input.judgePolicyVersion,
  });
  const judgeOutputHash = await memoryArtifactHash("memory-ordinary-judge-output", {
    claim: input.claim,
    sourceMessageIds,
    model: input.judgeModel,
    policyVersion: input.judgePolicyVersion,
  });
  const inputHash = await memoryArtifactHash("memory-ordinary-write-input", {
    namespace: input.namespace,
    candidateId: input.candidateId,
    legacyMemoryId: input.legacyMemoryId,
    legacyOutcome: input.legacyOutcome,
    judgeOutputHash,
  });
  return {
    inputId: `ofwi_${inputHash.slice(0, 32)}`,
    judgeInputHash,
    judgeOutputHash,
    claimJson,
    sourceMessageIdsJson: canonicalJson(sourceMessageIds),
  };
}

export async function enqueueOrdinaryFactWrite(
  db: D1Database,
  input: EnqueueOrdinaryFactWriteInput,
): Promise<string> {
  const artifact = await buildOrdinaryFactWriteInput(input);
  const origin = input.origin ?? "live_judge";
  const learnedAtUtc = input.learnedAtUtc ?? input.createdAtUtc;
  const claimCapturedAtUtc = input.claimCapturedAtUtc ?? input.createdAtUtc;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO memory_ordinary_fact_write_inputs(
      input_id,namespace,judge_run_id,candidate_id,legacy_memory_id,legacy_outcome,claim_json,
      source_message_ids_json,judge_model,judge_policy_version,judge_output_hash,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      artifact.inputId,input.namespace,input.judgeRunId,input.candidateId,input.legacyMemoryId,input.legacyOutcome,
      artifact.claimJson,artifact.sourceMessageIdsJson,input.judgeModel,input.judgePolicyVersion,artifact.judgeOutputHash,
      claimCapturedAtUtc,
    ),
    db.prepare(`INSERT OR IGNORE INTO memory_ordinary_fact_write_origins(
      input_id,origin,learned_at_utc,claim_captured_at_utc,backfill_run_id,created_at
    ) VALUES(?,?,?,?,?,?)`).bind(
      artifact.inputId,origin,learnedAtUtc,claimCapturedAtUtc,input.backfillRunId ?? null,claimCapturedAtUtc,
    ),
  ]);
  return artifact.inputId;
}

export async function captureAndEnqueueOrdinaryFactWrite(
  db: D1Database,
  input: EnqueueOrdinaryFactWriteInput,
): Promise<string> {
  const artifact = await buildOrdinaryFactWriteInput(input);
  const origin = input.origin ?? "live_judge";
  const learnedAtUtc = input.learnedAtUtc ?? input.createdAtUtc;
  const claimCapturedAtUtc = input.claimCapturedAtUtc ?? input.createdAtUtc;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO memory_candidate_judge_vnext_claims(
      candidate_id,judge_run_id,namespace,claim_json,source_message_ids_json,judge_model,
      judge_policy_version,judge_output_hash,created_at,judge_provider,prompt_version,schema_version,
      reasoning_config_json,input_hash,failure_code
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      input.candidateId,input.judgeRunId,input.namespace,artifact.claimJson,artifact.sourceMessageIdsJson,
      input.judgeModel,input.judgePolicyVersion,artifact.judgeOutputHash,claimCapturedAtUtc,
      modelProvider(input.judgeModel),input.judgePolicyVersion,
      input.claim?.schemaVersion ?? "memory-ordinary-judge-claim-v1",
      canonicalJson({ effort: "medium",temperature: 0 }),artifact.judgeInputHash,null,
    ),
    db.prepare(`INSERT OR IGNORE INTO memory_ordinary_fact_write_inputs(
      input_id,namespace,judge_run_id,candidate_id,legacy_memory_id,legacy_outcome,claim_json,
      source_message_ids_json,judge_model,judge_policy_version,judge_output_hash,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      artifact.inputId,input.namespace,input.judgeRunId,input.candidateId,input.legacyMemoryId,input.legacyOutcome,
      artifact.claimJson,artifact.sourceMessageIdsJson,input.judgeModel,input.judgePolicyVersion,artifact.judgeOutputHash,
      claimCapturedAtUtc,
    ),
    db.prepare(`INSERT OR IGNORE INTO memory_ordinary_fact_write_origins(
      input_id,origin,learned_at_utc,claim_captured_at_utc,backfill_run_id,created_at
    ) VALUES(?,?,?,?,?,?)`).bind(
      artifact.inputId,origin,learnedAtUtc,claimCapturedAtUtc,input.backfillRunId ?? null,claimCapturedAtUtc,
    ),
  ]);
  return artifact.inputId;
}

export async function captureOrdinaryJudgeClaim(
  db: D1Database,
  input: Omit<EnqueueOrdinaryFactWriteInput, "legacyMemoryId" | "legacyOutcome">,
): Promise<void> {
  const sourceMessageIds = [...new Set(input.sourceMessageIds.map((id) => id.trim()).filter(Boolean))].sort();
  const judgeInputHash = await memoryArtifactHash("memory-ordinary-judge-input", {
    namespace: input.namespace,
    candidateId: input.candidateId,
    sourceMessageIds,
    model: input.judgeModel,
    policyVersion: input.judgePolicyVersion,
  });
  const judgeOutputHash = await memoryArtifactHash("memory-ordinary-judge-output", {
    claim: input.claim,
    sourceMessageIds,
    model: input.judgeModel,
    policyVersion: input.judgePolicyVersion,
  });
  await db.prepare(`INSERT OR IGNORE INTO memory_candidate_judge_vnext_claims(
    candidate_id,judge_run_id,namespace,claim_json,source_message_ids_json,judge_model,
    judge_policy_version,judge_output_hash,created_at,judge_provider,prompt_version,schema_version,
    reasoning_config_json,input_hash,failure_code
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    input.candidateId,input.judgeRunId,input.namespace,canonicalJson(input.claim),canonicalJson(sourceMessageIds),
    input.judgeModel,input.judgePolicyVersion,judgeOutputHash,input.createdAtUtc,
    modelProvider(input.judgeModel),input.judgePolicyVersion,
    input.claim?.schemaVersion ?? "memory-ordinary-judge-claim-v1",
    canonicalJson({ effort: "medium",temperature: 0 }),judgeInputHash,null,
  ).run();
}

async function repairMissingWriteInputs(db: D1Database, namespace: string, limit: number): Promise<number> {
  const result = await db.prepare(`SELECT c.candidate_id,c.judge_run_id,c.namespace,c.claim_json,c.source_message_ids_json,
      c.judge_model,c.judge_policy_version,c.created_at,m.status,m.target_memory_id
    FROM memory_candidate_judge_vnext_claims c
    JOIN memory_candidates m ON m.id=c.candidate_id AND m.namespace=c.namespace
    LEFT JOIN memory_ordinary_fact_write_inputs i ON i.candidate_id=c.candidate_id
    WHERE c.namespace=? AND i.input_id IS NULL AND m.status IN ('approved','merged') AND m.target_memory_id IS NOT NULL
    ORDER BY c.created_at,c.candidate_id LIMIT ?`).bind(namespace,limit).all<Record<string, unknown>>();
  let repaired = 0;
  for (const row of result.results ?? []) {
    let claim: OrdinaryJudgeClaim | null = null;
    try {
      claim = JSON.parse(String(row.claim_json)) as OrdinaryJudgeClaim | null;
    } catch {
      claim = null;
    }
    await enqueueOrdinaryFactWrite(db, {
      namespace: String(row.namespace),
      judgeRunId: String(row.judge_run_id),
      candidateId: String(row.candidate_id),
      legacyMemoryId: String(row.target_memory_id),
      legacyOutcome: row.status === "merged" ? "merged" : "approved",
      claim,
      sourceMessageIds: parseStringArray(String(row.source_message_ids_json)),
      judgeModel: String(row.judge_model),
      judgePolicyVersion: String(row.judge_policy_version),
      createdAtUtc: String(row.created_at),
      origin: "recovered_claim",
      learnedAtUtc: String(row.created_at),
      claimCapturedAtUtc: String(row.created_at),
    });
    repaired += 1;
  }
  return repaired;
}

async function insertRejectedReceipt(
  db: D1Database,
  row: PendingWriteInputRow,
  status: Exclude<OrdinaryFactWriterResult["status"], "COMMITTED" | "DUPLICATE">,
  ruleCodes: string[],
): Promise<OrdinaryFactWriterResult> {
  const semanticEffectKey = await memoryArtifactHash("memory-ordinary-rejected-effect", {
    inputId: row.input_id,
    status,
  });
  const commitHash = await memoryArtifactHash("memory-ordinary-commit-receipt", {
    inputId: row.input_id,
    action: "REJECT",
    status,
    semanticEffectKey,
    ruleCodes: [...new Set(ruleCodes)].sort(),
  });
  await db.prepare(`INSERT OR IGNORE INTO memory_ordinary_fact_commit_receipts(
    receipt_id,input_id,action,status,expected_head_revision,observed_head_revision,
    semantic_effect_key,rule_codes_json,commit_hash,created_at
  ) VALUES(?,?,'REJECT',?,0,0,?,?,?,?)`).bind(
    `ofwr_${commitHash.slice(0, 32)}`,row.input_id,status,semanticEffectKey,
    canonicalJson([...new Set(ruleCodes)].sort()),commitHash,new Date().toISOString(),
  ).run();
  return { inputId: row.input_id, status, action: "REJECT", factRevisionId: null, txnSeq: null };
}

function structuredProposal(
  row: PendingWriteInputRow,
  claim: OrdinaryJudgeClaim,
  candidateContent: string,
  evidenceRefIdByLookupKey: ReadonlyMap<string,string>,
): StructuredExtractorProposal {
  return {
    localProposalKey: `judge.${row.candidate_id.toLowerCase().replace(/[^a-z0-9_.:-]+/g, ".").replace(/^[^a-z]+/, "c.").slice(0, 80)}`,
    payload: {
      kind: "fact",
      claimAtom: {
        subject: claim.subject,
        predicate: claim.predicate,
        scope: claim.scope,
        valueJson: isOrdinaryJudgeClaimV2(claim)
          ? JSON.parse(canonicalJson(claim.atoms[0].canonicalValue))
          : candidateContent,
      },
    },
    evidence: claim.evidence.map((item) => ({
      evidenceRefId: evidenceRefIdByLookupKey.get(item.localEvidenceKey ?? item.messageId) ?? `missing:${item.messageId}`,
      proposedSubject: item.proposedSubject,
      referencedSubjectId: null,
      proposedSourceMode: item.proposedSourceMode,
      evidenceRelation: item.evidenceRelation,
    })),
  };
}

function latestObservedAt(
  interpretations: readonly EvidenceInterpretation[],
  messageByEvidenceRefId: ReadonlyMap<string, MessageRecord>,
): string {
  const values = interpretations
    .map((item) => messageByEvidenceRefId.get(item.evidenceRefId)?.created_at ?? "")
    .filter(Boolean);
  values.sort((left,right) => {
    const leftMs = Date.parse(left);
    const rightMs = Date.parse(right);
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs - rightMs;
    return left.localeCompare(right);
  });
  const latest = values.at(-1);
  if (!latest) return new Date().toISOString();
  const parsed = Date.parse(latest);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : latest;
}

async function insertDuplicateReceipt(
  db: D1Database,
  row: PendingWriteInputRow,
  proposalId: string,
  factKey: string,
  factRevisionId: string,
): Promise<OrdinaryFactWriterResult> {
  const semanticEffectKey = await memoryArtifactHash("memory-ordinary-duplicate-effect", {
    inputId: row.input_id,
    proposalId,
    factRevisionId,
  });
  const commitHash = await memoryArtifactHash("memory-ordinary-commit-receipt", {
    inputId: row.input_id,
    action: "DUPLICATE",
    status: "DUPLICATE",
    semanticEffectKey,
  });
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO memory_ordinary_fact_commit_receipts(
      receipt_id,input_id,proposal_id,action,status,fact_key,fact_revision_id,
      expected_head_revision,observed_head_revision,semantic_effect_key,rule_codes_json,commit_hash,created_at
    ) VALUES(?,?,?,'DUPLICATE','DUPLICATE',?,?,0,0,?,'["SEMANTIC_EFFECT_ALREADY_COMMITTED"]',?,?)`).bind(
      `ofwr_${commitHash.slice(0, 32)}`,row.input_id,proposalId,factKey,factRevisionId,semanticEffectKey,commitHash,new Date().toISOString(),
    ),
    db.prepare(`INSERT OR IGNORE INTO memory_fact_legacy_refs(
      legacy_memory_id,namespace,fact_revision_id,input_id,created_at
    ) VALUES(?,?,?,?,?)`).bind(row.legacy_memory_id,row.namespace,factRevisionId,row.input_id,new Date().toISOString()),
  ]);
  return { inputId: row.input_id, status: "DUPLICATE", action: "DUPLICATE", factRevisionId, txnSeq: null };
}

async function processPendingWrite(env: Env, row: PendingWriteInputRow): Promise<OrdinaryFactWriterResult> {
  const db = env.DB;
  const origin = await db.prepare(`SELECT learned_at_utc,claim_captured_at_utc
    FROM memory_ordinary_fact_write_origins WHERE input_id=?`).bind(row.input_id).first<WriteOriginRow>();
  const learnedAtUtc = origin?.learned_at_utc ?? row.created_at;
  const claimCapturedAtUtc = origin?.claim_captured_at_utc ?? row.created_at;
  const candidate = await db.prepare("SELECT content FROM memory_candidates WHERE namespace=? AND id=?")
    .bind(row.namespace,row.candidate_id).first<CandidateRow>();
  if (!candidate) return insertRejectedReceipt(db,row,"REJECTED_MISSING_SOURCE",["CANDIDATE_SOURCE_MISSING"]);

  let claim: OrdinaryJudgeClaim;
  try {
    const parsed = JSON.parse(row.claim_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("claim_missing");
    claim = parsed as OrdinaryJudgeClaim;
  } catch {
    return insertRejectedReceipt(db,row,"REJECTED_INVALID_CLAIM",["MODEL_CLAIM_INVALID"]);
  }

  const candidateView = buildLocalSecretRedactedViews(candidate.content);
  if (candidateView.secretSpans.length > 0) {
    return insertRejectedReceipt(db,row,"REJECTED_SECRET",["CANDIDATE_SECRET_MATERIAL"]);
  }

  const evidenceUnitV2Enabled = flag(env.MEMORY_EVIDENCE_UNIT_V2_WRITE_ENABLED);
  const claimAtomV2Enabled = flag(env.MEMORY_CLAIM_ATOM_V2_WRITE_ENABLED);
  if (claimAtomV2Enabled && !evidenceUnitV2Enabled) {
    throw new Error("memory_claim_atom_v2_requires_evidence_unit_v2");
  }
  if (evidenceUnitV2Enabled && !isOrdinaryJudgeClaimV2(claim)) {
    return insertRejectedReceipt(db,row,"REJECTED_INVALID_CLAIM",["CLAIM_ATOM_V2_REQUIRED"]);
  }

  const allClaimEvidence = isOrdinaryJudgeClaimV2(claim)
    ? claim.atoms.flatMap((atom) => atom.evidence)
    : claim.evidence;
  const sourceIds = parseStringArray(row.source_message_ids_json);
  const sourceAllowlist = new Set(sourceIds);
  const requiredEvidenceEventIds = new Set(allClaimEvidence.flatMap((item) => [
    item.messageId,
    ...(item.questionMessageId ? [item.questionMessageId] : []),
  ]));
  if (isOrdinaryJudgeClaimV2(claim)) requiredEvidenceEventIds.add(claim.primaryMessageId);
  if (allClaimEvidence.length === 0
    || [...requiredEvidenceEventIds].some((id) => !sourceAllowlist.has(id))) {
    return insertRejectedReceipt(db,row,"REJECTED_INVALID_CLAIM",["EVIDENCE_NOT_ALLOWLISTED"]);
  }
  const messages = await getMessagesByIds(db, { namespace: row.namespace, ids: sourceIds });
  const messageById = new Map(messages.map((message) => [message.id,message]));
  if ([...requiredEvidenceEventIds].some((id) => !messageById.has(id))) {
    return insertRejectedReceipt(db,row,"REJECTED_MISSING_SOURCE",["CANONICAL_EVIDENCE_MISSING"]);
  }
  let v2Artifacts: V2ClaimArtifacts | null = null;
  let evidenceRefs: CanonicalEvidenceRef[];
  let evidenceRefIdByLookupKey: Map<string,string>;
  try {
    if (evidenceUnitV2Enabled && isOrdinaryJudgeClaimV2(claim)) {
      v2Artifacts = await materializeV2ClaimArtifacts(db,row,claim,messageById);
      evidenceRefs = v2Artifacts.evidenceRefs;
      evidenceRefIdByLookupKey = v2Artifacts.evidenceRefIdByLocalKey;
    } else {
      evidenceRefs = await Promise.all([...new Set(claim.evidence.map((item) => item.messageId))]
        .map((id) => legacyEvidenceRef(messageById.get(id)!)));
      evidenceRefIdByLookupKey = new Map(evidenceRefs.map((ref) => [ref.eventId,ref.evidenceRefId]));
    }
  } catch (error) {
    return insertRejectedReceipt(db,row,"REJECTED_INVALID_CLAIM",[
      error instanceof Error ? error.message.toUpperCase().replace(/[^A-Z0-9_:-]+/g,"_").slice(0,96) : "EVIDENCE_UNIT_V2_INVALID",
    ]);
  }
  if (evidenceRefs.some((item) => item.sensitivity === "secret")) {
    return insertRejectedReceipt(db,row,"REJECTED_SECRET",["EVIDENCE_SECRET_MATERIAL"]);
  }
  const evidenceById = new Map(evidenceRefs.map((ref) => [ref.evidenceRefId,ref]));
  let output;
  try {
    output = parseStructuredExtractorOutput({
      schemaVersion: MEMORY_VNEXT_EXTRACTOR_SCHEMA_VERSION,
      proposals: [structuredProposal(row,claim,candidate.content,evidenceRefIdByLookupKey)],
    });
  } catch {
    return insertRejectedReceipt(db,row,"REJECTED_INVALID_CLAIM",["FACT_PROPOSAL_SCHEMA_INVALID"]);
  }
  const materialized = await materializeShadowProposals({
    extractorRunId: row.judge_run_id,
    output,
    evidenceById,
    allowedEvidenceRefIds: new Set(evidenceById.keys()),
    producerMetadata: {
      provider: modelProvider(row.judge_model),
      model: row.judge_model,
      promptVersion: row.judge_policy_version,
      schemaVersion: isOrdinaryJudgeClaimV2(claim) ? claim.schemaVersion : MEMORY_VNEXT_EXTRACTOR_SCHEMA_VERSION,
      reasoningConfig: { effort: "medium",temperature: 0 },
      inputHash: row.input_id,
      outputHash: row.judge_output_hash,
      failureCode: null,
    },
    createdAtUtc: claimCapturedAtUtc,
  });
  const item = materialized[0];
  if (!item || item.proposal.payload.kind !== "fact") {
    return insertRejectedReceipt(db,row,"REJECTED_INVALID_CLAIM",["FACT_PROPOSAL_REQUIRED"]);
  }
  const classification = classifyProposal(item.proposal.payload);
  if (classification.classification !== "ordinary" || classification.protectedImpacts.length > 0) {
    return insertRejectedReceipt(db,row,"REJECTED_PROTECTED",[
      ...classification.ruleCodes,
      "PROTECTED_OWNER_CONFIRMATION_REQUIRED",
    ]);
  }
  const authority = evaluateProposalAuthority(item.proposal,item.interpretations);
  if (!authority.eligible) {
    return insertRejectedReceipt(db,row,"REJECTED_AUTHORITY",authority.ruleCodes);
  }

  const claimAtom = item.proposal.payload.claimAtom;
  const primaryV2Atom = v2Artifacts?.claimAtoms[0] ?? null;
  const predicateValidation = primaryV2Atom ? validateClaimAtomAgainstPredicate(primaryV2Atom) : null;
  const factKeyInput: Record<string,unknown> = {
    namespace: row.namespace,
    subject: claimAtom.subject,
    predicate: claimAtom.predicate,
    scope: claimAtom.scope,
  };
  if (predicateValidation?.definition?.objectInClaimKey) {
    factKeyInput.objectRef = primaryV2Atom?.objectRef ?? null;
  }
  const factKeyHash = await memoryArtifactHash("memory-fact-key",factKeyInput);
  const factKey = `fk_${factKeyHash}`;
  const contentHash = await memoryArtifactHash("memory-fact-content", claimAtom.valueJson);
  const semanticEffectKey = await memoryArtifactHash("memory-ordinary-semantic-effect", {
    logicalProposalKey: item.proposal.logicalProposalKey,
    factKey,
    contentHash,
  });
  const priorEffect = await db.prepare(`SELECT proposal_id,fact_revision_id
    FROM memory_ordinary_fact_commit_receipts WHERE semantic_effect_key=? AND status='COMMITTED' LIMIT 1`)
    .bind(semanticEffectKey).first<{ proposal_id: string; fact_revision_id: string }>();
  if (priorEffect) {
    return insertDuplicateReceipt(db,row,priorEffect.proposal_id,factKey,priorEffect.fact_revision_id);
  }

  const head = await db.prepare(`SELECT fact_revision_id,revision,value_json,epistemic_status,lifecycle_status
    FROM memory_fact_revisions WHERE fact_key=? ORDER BY revision DESC LIMIT 1`)
    .bind(factKey).first<HeadRevisionRow>();
  const expectedHeadRevision = Number(head?.revision ?? 0);
  const sameValue = head ? head.value_json === canonicalJson(claimAtom.valueJson) : false;
  const acceptedInterpretations = item.interpretations
    .filter((interpretation) => authority.acceptedInterpretationIds.includes(interpretation.interpretationId))
    .sort((left,right) => left.interpretationId.localeCompare(right.interpretationId));
  const positiveInterpretations = acceptedInterpretations
    .filter((interpretation) => authority.positiveSupportInterpretationIds.includes(interpretation.interpretationId));
  const automaticFactWriteAllowed = positiveInterpretations.length > 0
    && (!predicateValidation || (predicateValidation.known && predicateValidation.valid));
  // Recency neutrality: a different value is never evidence of a state
  // transition. Persist the proposal/evidence below, but do not increment the
  // transaction clock or mutate the current FactRevision without a separately
  // verified mutation relation.
  const action: "ADD" | "REINFORCE" | "DEFERRED_COMPARISON" = !automaticFactWriteAllowed
    ? "DEFERRED_COMPARISON"
    : !head
      ? "ADD"
      : sameValue
        ? "REINFORCE"
        : "DEFERRED_COMPARISON";
  const factRevisionId: string | null = action === "DEFERRED_COMPARISON"
    ? null
    : action === "REINFORCE"
      ? head!.fact_revision_id
      : `fr_${(await memoryArtifactHash("memory-fact-revision", {
      factKey,
      revision: expectedHeadRevision + 1,
      contentHash,
      proposalId: item.proposal.proposalId,
    })).slice(0, 32)}`;
  const supportGroupHash = await memoryArtifactHash("memory-evidence-support-group", {
    mode: "ANY_SUFFICIENT",
    interpretationIds: positiveInterpretations.map((interpretation) => interpretation.interpretationId),
  });
  const supportGroupId = positiveInterpretations.length > 0 ? `esg_${supportGroupHash.slice(0, 32)}` : null;
  const now = new Date().toISOString();
  const epistemicStatus: FactRevision["epistemicStatus"] = claimAtom.subject === "third_party" ? "believed" : "known";
  const observedAtUtc = latestObservedAt(acceptedInterpretations,new Map(
    evidenceRefs.map((ref) => [ref.evidenceRefId,messageById.get(ref.eventId)!]),
  ));
  const proposal = {
    ...item.proposal,
    expectedHeadRevisions: { [factKey]: expectedHeadRevision },
  };
  const commitHash = await memoryArtifactHash("memory-ordinary-commit-receipt", {
    inputId: row.input_id,
    proposalId: proposal.proposalId,
    action,
    factKey,
    factRevisionId,
    predecessorRevisionId: null,
    expectedHeadRevision,
    semanticEffectKey,
    acceptedInterpretationIds: acceptedInterpretations.map((interpretation) => interpretation.interpretationId),
  });
  const receiptId = `ofwr_${commitHash.slice(0, 32)}`;
  const deferRuleCodes = [
    "RECENCY_NEUTRALITY",
    ...(positiveInterpretations.length === 0 ? ["POSITIVE_SUPPORT_INSUFFICIENT"] : []),
    ...(predicateValidation && !predicateValidation.known ? ["PREDICATE_UNKNOWN_DEFER"] : []),
    ...(predicateValidation && !predicateValidation.valid ? predicateValidation.ruleCodes : []),
    ...(head && !sameValue ? ["TEXT_DIFFERENCE_NOT_MUTATION_AUTHORITY"] : []),
  ];
  const statements: D1PreparedStatement[] = action === "DEFERRED_COMPARISON"
    ? [db.prepare(`INSERT INTO memory_ordinary_fact_commit_receipts(
        receipt_id,input_id,proposal_id,action,status,fact_key,fact_revision_id,predecessor_revision_id,
        expected_head_revision,observed_head_revision,txn_seq,semantic_effect_key,rule_codes_json,commit_hash,created_at
      ) VALUES(?,?,?,'DEFERRED_COMPARISON','DEFERRED_COMPARISON',?,NULL,NULL,?,?,NULL,?,?,?,?)`).bind(
        receiptId,row.input_id,proposal.proposalId,factKey,expectedHeadRevision,expectedHeadRevision,
        semanticEffectKey,canonicalJson([...new Set(deferRuleCodes)].sort()),commitHash,now,
      )]
    : [
      db.prepare("UPDATE memory_txn_clock SET last_seq=last_seq+1 WHERE singleton=1"),
      db.prepare(`INSERT INTO memory_ordinary_fact_commit_receipts(
        receipt_id,input_id,proposal_id,action,status,fact_key,fact_revision_id,predecessor_revision_id,
        expected_head_revision,observed_head_revision,txn_seq,semantic_effect_key,rule_codes_json,commit_hash,created_at
      ) VALUES(?,?,?,?, 'COMMITTED',?,?,NULL,?,?,(SELECT last_seq FROM memory_txn_clock WHERE singleton=1),?,?,?,?)`).bind(
        receiptId,row.input_id,proposal.proposalId,action,factKey,factRevisionId,
        expectedHeadRevision,expectedHeadRevision,semanticEffectKey,
        canonicalJson(["AUTHORITY_ESTABLISHED","HARNESS_OWNED_COMMIT",action]),commitHash,now,
      ),
    ];

  for (const ref of evidenceRefs) {
    const message = messageById.get(ref.eventId)!;
    const views = buildLocalSecretRedactedViews(message.content);
    const scanHash = await memoryArtifactHash("memory-normal-secret-scan-artifact", {
      eventId: message.id,
      contentRevision: 1,
      indexEligibleText: views.indexEligibleText,
    });
    const scanArtifactId = `scan_${scanHash.slice(0, 32)}`;
    const viewHash = await memoryArtifactHash("memory-index-eligible-view", views.indexEligibleText);
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO memory_secret_scan_artifacts(
        artifact_id,canonical_event_id,canonical_locator_ref,scanner_version,extractor_view_hash,index_view_hash,
        classification,secret_span_count,created_at
      ) VALUES(?,?,?,?,?,?,'normal',0,?)`).bind(
        scanArtifactId,message.id,`message:${message.id}:r1`,"memory-secret-local-v1",
        await memoryArtifactHash("memory-extractor-view", views.extractorView),viewHash,now,
      ),
      db.prepare(`INSERT OR IGNORE INTO memory_index_eligible_views(
        canonical_event_id,scan_artifact_id,index_eligible_text,index_view_hash,created_at
      ) VALUES(?,?,?,?,?)`).bind(message.id,scanArtifactId,views.indexEligibleText,viewHash,now),
      db.prepare(`INSERT OR IGNORE INTO memory_evidence_refs(
        evidence_ref_id,canonical_event_id,conversation_id,actor_id,actor_class,event_role,tool_id,reply_to_event_id,
        occurred_at_utc,evidence_time_precision,content_revision,content_ref,byte_start,byte_end,span_ref,
        sensitivity,byte_span_version,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        ref.evidenceRefId,ref.eventId,ref.conversationId,ref.actorId,ref.actorClass,ref.eventRole,ref.toolId,
        ref.replyToEventId,ref.occurredAtUtc,ref.evidenceTimePrecision,ref.contentRevision,ref.contentRef,
        ref.byteStart,ref.byteEnd,ref.spanRef,ref.sensitivity,"utf8-half-open-v1",now,
      ),
    );
    if (v2Artifacts) {
      const atomic = v2Artifacts.atomicUnits.find((unit) => unit.evidenceUnitId === ref.evidenceRefId);
      if (!atomic || !ref.spanHash || !ref.episodeId || !ref.rootLineageId) {
        throw new Error("memory_evidence_unit_v2_persistence_metadata_missing");
      }
      statements.push(db.prepare(`INSERT OR IGNORE INTO memory_evidence_ref_v2_metadata(
        evidence_ref_id,evidence_unit_kind,span_hash,episode_id,root_lineage_id,lineage_version,
        elicitation_origin,authority_policy_version,structural_binding_hash,
        composite_strong_owner_authority,created_at
      ) VALUES(?,'atomic_span',?,?,?,?,?,?,?,?,?)`).bind(
        ref.evidenceRefId,ref.spanHash,ref.episodeId,ref.rootLineageId,MEMORY_EVIDENCE_LINEAGE_VERSION,
        ref.elicitationOrigin ?? "NOT_APPLICABLE",MEMORY_EVIDENCE_UNIT_POLICY_VERSION,null,
        ref.compositeStrongOwnerAuthority === undefined ? null : ref.compositeStrongOwnerAuthority ? 1 : 0,now,
      ));
    }
  }

  if (v2Artifacts) {
    for (const composite of v2Artifacts.compositeUnits) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO memory_composite_confirmation_units(
        evidence_unit_id,question_evidence_ref_id,answer_evidence_ref_id,conversation_id,episode_id,
        root_lineage_id,elicitation_origin,strong_owner_authority,authority_rule_codes_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
        composite.evidenceUnitId,composite.questionEvidenceUnitId,composite.answerEvidenceUnitId,
        composite.conversationId,composite.episodeId,composite.rootLineageId,composite.elicitationOrigin,
        composite.strongOwnerAuthority ? 1 : 0,canonicalJson(composite.authorityRuleCodes),now,
      ));
    }
    for (const edge of v2Artifacts.structuralEdges) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO memory_evidence_structural_edges(
        structural_edge_id,from_evidence_ref_id,to_evidence_ref_id,edge_kind,edge_ordinal,policy_version,created_at
      ) VALUES(?,?,?,?,?,?,?)`).bind(
        edge.structuralEdgeId,edge.fromEvidenceRefId,edge.toEvidenceRefId,edge.edgeKind,edge.edgeOrdinal,
        MEMORY_EVIDENCE_UNIT_POLICY_VERSION,now,
      ));
    }
  }

  const legacyProducerClass = proposal.producer === "model"
    ? "deepseek"
    : proposal.producer === "deterministic_rule"
      ? "migration"
      : proposal.producer;
  statements.push(db.prepare(`INSERT INTO memory_proposals(
    proposal_id,logical_proposal_key,proposal_revision,legacy_producer_class,producer_kind,producer_provider,producer_model,
    prompt_version,reasoning_config_json,input_hash,output_hash,failure_code,extractor_run_id,proposal_kind,payload_json,
    evidence_interpretation_ids_json,protected_impacts_json,expected_head_revisions_json,schema_version,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    proposal.proposalId,proposal.logicalProposalKey,proposal.proposalRevision,legacyProducerClass,proposal.producer,
    proposal.producerMetadata.provider,proposal.producerMetadata.model,proposal.producerMetadata.promptVersion,
    proposal.producerMetadata.reasoningConfig ? canonicalJson(proposal.producerMetadata.reasoningConfig) : null,
    proposal.producerMetadata.inputHash,proposal.producerMetadata.outputHash,proposal.producerMetadata.failureCode,
    proposal.extractorRunId,proposal.payload.kind,canonicalJson(proposal.payload),canonicalJson(proposal.evidenceInterpretationIds),
    canonicalJson(proposal.protectedImpacts),canonicalJson(proposal.expectedHeadRevisions),proposal.schemaVersion,proposal.createdAtUtc,
  ));
  if (claimAtomV2Enabled && v2Artifacts) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO memory_claim_groups(
      claim_group_id,canonical_event_id,content_revision,group_context_hash,normalization_version,created_at
    ) VALUES(?,?,?,?,?,?)`).bind(
      v2Artifacts.claimGroup.claimGroupId,v2Artifacts.claimGroup.canonicalEventId,
      v2Artifacts.claimGroup.contentRevision,v2Artifacts.claimGroup.groupContextHash,
      v2Artifacts.claimGroup.normalizationVersion,now,
    ));
    for (const [index,atom] of v2Artifacts.claimAtoms.entries()) {
      const atomHash = await memoryArtifactHash("memory-claim-atom-v2-persistence", {
        claimAtomId: atom.claimAtomId,
        claimGroupId: atom.claimGroupId,
        subjectRef: atom.subjectRef,
        assertionKind: atom.assertionKind,
        predicateId: atom.predicateId,
        objectRef: atom.objectRef,
        canonicalValue: atom.canonicalValue,
        scope: atom.scope,
        qualifiers: atom.qualifiers,
        evidenceUnitIds: atom.evidenceUnitIds,
        predicateRegistryVersion: atom.predicateRegistryVersion,
        normalizationVersion: atom.normalizationVersion,
      });
      statements.push(
        db.prepare(`INSERT OR IGNORE INTO memory_claim_atoms(
          claim_atom_id,claim_group_id,subject_ref,assertion_kind,predicate_id,object_ref,canonical_value_json,
          scope_json,qualifiers_json,evidence_unit_ids_json,predicate_registry_version,normalization_version,
          atom_hash,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          atom.claimAtomId,atom.claimGroupId,atom.subjectRef,atom.assertionKind,atom.predicateId,atom.objectRef,
          canonicalJson(atom.canonicalValue),canonicalJson(atom.scope),canonicalJson(atom.qualifiers),
          canonicalJson(atom.evidenceUnitIds),atom.predicateRegistryVersion,atom.normalizationVersion,atomHash,now,
        ),
        db.prepare(`INSERT OR IGNORE INTO memory_proposal_claim_atoms(
          proposal_id,proposal_revision,claim_atom_id,ordinal,created_at
        ) VALUES(?,?,?,?,?)`).bind(proposal.proposalId,proposal.proposalRevision,atom.claimAtomId,index,now),
      );
      atom.evidenceUnitIds.forEach((evidenceUnitId,evidenceIndex) => statements.push(
        db.prepare(`INSERT OR IGNORE INTO memory_claim_atom_evidence(
          claim_atom_id,evidence_unit_id,ordinal,created_at
        ) VALUES(?,?,?,?)`).bind(atom.claimAtomId,evidenceUnitId,evidenceIndex,now),
      ));
    }
  }
  for (const interpretation of item.interpretations) {
    statements.push(db.prepare(`INSERT INTO memory_evidence_interpretations(
      interpretation_id,proposal_id,evidence_ref_id,proposed_subject,referenced_subject_id,proposed_source_mode,
      validated_authority,evidence_relation,validation_rule_codes_json,validator_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(
      interpretation.interpretationId,interpretation.proposalId,interpretation.evidenceRefId,
      interpretation.proposedSubject,interpretation.referencedSubjectId,interpretation.proposedSourceMode,
      interpretation.validatedAuthority,interpretation.evidenceRelation,
      canonicalJson(interpretation.validationRuleCodes),interpretation.validatorVersion,now,
    ));
  }
  const classificationHash = await memoryArtifactHash("memory-proposal-classification", {
    proposalId: proposal.proposalId,
    proposalRevision: proposal.proposalRevision,
    classification,
  });
  statements.push(
    db.prepare(`INSERT INTO memory_proposal_classifications(
      classification_id,proposal_id,proposal_revision,classification,protected_impacts_json,rule_codes_json,
      classifier_version,classification_hash,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      `pc_${classificationHash.slice(0, 32)}`,proposal.proposalId,proposal.proposalRevision,classification.classification,
      canonicalJson(classification.protectedImpacts),canonicalJson(classification.ruleCodes),
      MEMORY_VNEXT_GATE_B_POLICY_VERSION,classificationHash,now,
    ),
  );
  if (supportGroupId) {
    statements.push(db.prepare(`INSERT INTO memory_evidence_support_groups(
      support_group_id,mode,group_hash,created_at
    ) VALUES(?,'ANY_SUFFICIENT',?,?)`).bind(supportGroupId,supportGroupHash,now));
    positiveInterpretations.forEach((interpretation,index) => statements.push(
      db.prepare(`INSERT INTO memory_evidence_support_group_members(
        support_group_id,interpretation_id,ordinal
      ) VALUES(?,?,?)`).bind(supportGroupId,interpretation.interpretationId,index),
    ));
  }
  if (v2Artifacts && supportGroupId) {
    const acceptedRefs = positiveInterpretations.map((interpretation) => evidenceById.get(interpretation.evidenceRefId)!);
    const rootLineageSetHash = await memoryArtifactHash("memory-support-root-lineage-set-v2",[
      ...new Set(acceptedRefs.map((ref) => ref.rootLineageId).filter((value): value is string => Boolean(value))),
    ].sort());
    const episodeSetHash = await memoryArtifactHash("memory-support-episode-set-v2",[
      ...new Set(acceptedRefs.map((ref) => ref.episodeId).filter((value): value is string => Boolean(value))),
    ].sort());
    statements.push(db.prepare(`INSERT OR IGNORE INTO memory_evidence_support_group_v2_metadata(
      support_group_id,root_lineage_set_hash,elicitation_episode_set_hash,positive_support_member_count,
      contradiction_member_count,qualification_member_count,policy_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).bind(
      supportGroupId,rootLineageSetHash,episodeSetHash,
      positiveInterpretations.length,0,0,
      MEMORY_EVIDENCE_UNIT_POLICY_VERSION,now,
    ));
  }
  const proposalStates: readonly (readonly [string,string,string])[] = action === "DEFERRED_COMPARISON"
    ? [
      ["UNINITIALIZED","PROPOSED","ordinary_writer_capture"],
      ["PROPOSED","VALIDATED","ordinary_writer_authority"],
      ["VALIDATED","DEFERRED_COMPARISON",receiptId],
    ]
    : [
      ["UNINITIALIZED","PROPOSED","ordinary_writer_capture"],
      ["PROPOSED","VALIDATED","ordinary_writer_authority"],
      ["VALIDATED","AUTO_COMMIT_READY","ordinary_writer_policy"],
      ["AUTO_COMMIT_READY","COMMITTED",receiptId],
    ];
  proposalStates.forEach(([fromState,toState,causeRef],index) => statements.push(
    db.prepare(`INSERT INTO memory_proposal_state_events(
      event_id,proposal_id,proposal_revision,from_state,to_state,cause_ref,
      expected_state_version,resulting_state_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      `pse_${proposal.proposalId.slice(3)}_${index + 1}`,proposal.proposalId,proposal.proposalRevision,
      fromState,toState,causeRef,index,index + 1,now,
    ),
  ));
  if (action === "ADD") {
    statements.push(
      db.prepare(`INSERT INTO memory_fact_revisions(
        fact_revision_id,fact_key,revision,subject,predicate,scope,value_json,epistemic_status,lifecycle_status,
        valid_from_utc,valid_to_utc,valid_start_kind,valid_end_kind,valid_time_precision,valid_time_basis,
        txn_from_seq,txn_to_seq,content_ref,created_at
      ) VALUES(?,?,?,?,?,?,?,?, 'current',NULL,NULL,'UNKNOWN','OPEN_ENDED','unknown','unknown',
        (SELECT last_seq FROM memory_txn_clock WHERE singleton=1),NULL,?,?)`).bind(
        factRevisionId!,factKey,expectedHeadRevision + 1,claimAtom.subject,claimAtom.predicate,claimAtom.scope,
        canonicalJson(claimAtom.valueJson),epistemicStatus,evidenceRefs[0].eventId,now,
      ),
      db.prepare(`INSERT INTO memory_fact_revision_metadata(
        fact_revision_id,namespace,observed_at_utc,learned_at_utc,protected_impacts_json,content_hash,created_at
      ) VALUES(?,?,?,?,?,?,?)`).bind(
        factRevisionId!,row.namespace,observedAtUtc,learnedAtUtc,"[]",contentHash,now,
      ),
    );
  }
  if (action !== "DEFERRED_COMPARISON") for (const interpretation of acceptedInterpretations) {
    const evidenceRef = evidenceById.get(interpretation.evidenceRefId)!;
    const lineageId = evidenceRef.rootLineageId ?? `lin_${(await memoryArtifactHash("memory-evidence-lineage", {
      canonicalEventId: evidenceRef.eventId,
      contentRevision: evidenceRef.contentRevision,
    })).slice(0,32)}`;
    statements.push(db.prepare(`INSERT OR IGNORE INTO memory_fact_revision_evidence(
      fact_revision_id,interpretation_id,lineage_id,support_group_id,relation,edge_txn_from_seq,edge_txn_to_seq
    ) VALUES(?,?,?,?,?,(SELECT last_seq FROM memory_txn_clock WHERE singleton=1),NULL)`).bind(
      factRevisionId!,interpretation.interpretationId,lineageId,
      ["SUPPORTS","CONFIRMS"].includes(interpretation.evidenceRelation) ? supportGroupId : null,
      interpretation.evidenceRelation,
    ));
  }
  if (action !== "DEFERRED_COMPARISON") {
    if (claimAtomV2Enabled && primaryV2Atom) {
      const compatibilityHash = await memoryArtifactHash("memory-fact-claim-compatibility-v2", {
        factRevisionId,
        claimAtomId: primaryV2Atom.claimAtomId,
        factKey,
        canonicalValue: primaryV2Atom.canonicalValue,
      });
      statements.push(db.prepare(`INSERT OR IGNORE INTO memory_fact_revision_claim_atoms(
        fact_revision_id,claim_atom_id,compatibility_hash,created_at
      ) VALUES(?,?,?,?)`).bind(factRevisionId!,primaryV2Atom.claimAtomId,compatibilityHash,now));
    }
    statements.push(db.prepare(`INSERT INTO memory_fact_legacy_refs(
      legacy_memory_id,namespace,fact_revision_id,input_id,created_at
    ) VALUES(?,?,?,?,?)`).bind(row.legacy_memory_id,row.namespace,factRevisionId!,row.input_id,now));
  }

  await db.batch(statements);
  const receipt = await db.prepare(`SELECT status,txn_seq FROM memory_ordinary_fact_commit_receipts WHERE input_id=?`)
    .bind(row.input_id).first<{ status: OrdinaryFactWriterResult["status"]; txn_seq: number | null }>();
  if (!receipt) throw new Error("memory_ordinary_fact_commit_receipt_missing");
  if (action === "DEFERRED_COMPARISON") {
    return { inputId: row.input_id, status: "DEFERRED_COMPARISON", action, factRevisionId: null, txnSeq: null };
  }
  return { inputId: row.input_id, status: "COMMITTED", action, factRevisionId, txnSeq: Number(receipt.txn_seq) };
}

export async function drainOrdinaryFactWrites(
  env: Env,
  namespace: string,
  options: { limit?: number } = {},
): Promise<{
  ran: boolean;
  processed: number;
  committed: number;
  deferred: number;
  rejected: number;
  duplicate: number;
  failed: number;
}> {
  if (!flag(env.MEMORY_VNEXT_ORDINARY_FACT_WRITE_ENABLED)) {
    return { ran: false, processed: 0, committed: 0, deferred: 0, rejected: 0, duplicate: 0, failed: 0 };
  }
  if (flag(env.MEMORY_CLAIM_ATOM_V2_WRITE_ENABLED) && !flag(env.MEMORY_EVIDENCE_UNIT_V2_WRITE_ENABLED)) {
    throw new Error("memory_claim_atom_v2_requires_evidence_unit_v2");
  }
  const requested = options.limit ?? DEFAULT_DRAIN_LIMIT;
  const limit = Math.min(Math.max(Math.floor(Number(requested) || DEFAULT_DRAIN_LIMIT),1),MAX_DRAIN_LIMIT);
  await repairMissingWriteInputs(env.DB,namespace,limit);
  const result = await env.DB.prepare(`SELECT * FROM memory_ordinary_fact_write_pending_v
    WHERE namespace=? ORDER BY created_at,input_id LIMIT ?`).bind(namespace,limit).all<PendingWriteInputRow>();
  const rows = result.results ?? [];
  let committed = 0;
  let deferred = 0;
  let rejected = 0;
  let duplicate = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const outcome = await processPendingWrite(env,row);
      if (outcome.status === "COMMITTED") committed += 1;
      else if (outcome.status === "DUPLICATE") duplicate += 1;
      else if (outcome.status === "DEFERRED_COMPARISON" || outcome.status === "OWNER_REVIEW") deferred += 1;
      else rejected += 1;
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0,160) : "ordinary_fact_write_failed";
      if (code.includes("memory_ordinary_fact_commit_stale_cas")) {
        try {
          await insertRejectedReceipt(env.DB,row,"STALE_CAS",["REJUDGE_REQUIRED_AFTER_CAS"]);
          rejected += 1;
          continue;
        } catch (receiptError) {
          console.error("memory ordinary fact writer: stale CAS receipt failed", {
            input_id: row.input_id,
            code: receiptError instanceof Error ? receiptError.message.slice(0,160) : "stale_cas_receipt_failed",
          });
        }
      }
      failed += 1;
      console.error("memory ordinary fact writer: input failed", {
        input_id: row.input_id,
        candidate_id: row.candidate_id,
        code,
      });
    }
  }
  return { ran: true, processed: rows.length, committed, deferred, rejected, duplicate, failed };
}
