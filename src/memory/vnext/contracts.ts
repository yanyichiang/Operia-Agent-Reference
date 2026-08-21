export const PROPOSAL_STATES = [
  "PROPOSED",
  "VALIDATED",
  "QUARANTINED",
  "REJECTED",
  "DEFERRED_COMPARISON",
  "AUTO_COMMIT_READY",
  "OWNER_REVIEW",
  "COMMITTED",
  "STALE_CAS",
  "SUPERSEDED",
] as const;

export type ProposalState = (typeof PROPOSAL_STATES)[number];
export type ProposalProjectionState = ProposalState | "UNINITIALIZED";

export type ProtectedImpact =
  | "SELF_IDENTITY"
  | "OWNER_IDENTITY"
  | "RELATIONSHIP_DEFINITION"
  | "TRUST_BOUNDARY"
  | "PERMISSION"
  | "CONSTITUTION"
  | "EVIDENCE_BASIS_OF_PROTECTED_STATE";

export type ProposalProducerKind =
  | "model"
  | "migration"
  | "owner_structured_action"
  | "deterministic_rule";

export type ProposalProducerMetadata = {
  kind: ProposalProducerKind;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  schemaVersion: string;
  reasoningConfig: Record<string, unknown> | null;
  inputHash: string | null;
  outputHash: string | null;
  failureCode: string | null;
};

export type AssertionKind =
  | "state"
  | "event"
  | "preference"
  | "intention"
  | "commitment"
  | "belief"
  | "evaluation";

export type ClaimScope = {
  key: string;
  validFromUtc: string | null;
  validToUtc: string | null;
  temporalPrecision: "exact" | "day" | "month" | "year" | "bounded" | "unknown";
  contextRefs: string[];
};

export type ClaimQualifiers = {
  certainty: "asserted" | "uncertain" | "conditional";
  negated: boolean;
  attributes: Record<string, string | number | boolean | null>;
};

export type ClaimAtomV2 = {
  claimAtomId: string;
  claimGroupId: string;
  subjectRef: "owner" | "operia" | "relationship" | "world" | "third_party";
  assertionKind: AssertionKind;
  predicateId: string;
  objectRef: string | null;
  canonicalValue: unknown;
  scope: ClaimScope;
  qualifiers: ClaimQualifiers;
  evidenceUnitIds: string[];
  predicateRegistryVersion: string;
  normalizationVersion: string;
};

export type ClaimGroup = {
  claimGroupId: string;
  canonicalEventId: string;
  contentRevision: number;
  claimAtomIds: string[];
  groupContextHash: string;
  normalizationVersion: string;
};

export type EvidenceUnitKind =
  | "atomic_span"
  | "composite_confirmation"
  | "scoped_tool_observation";

export type ElicitationOrigin =
  | "OWNER_ROOTED"
  | "NEUTRAL_RESTATEMENT"
  | "ASSISTANT_NOVEL"
  | "TOOL_ROOTED"
  | "NOT_APPLICABLE";

export type AtomicSpanEvidence = {
  kind: "atomic_span";
  evidenceUnitId: string;
  canonicalEventId: string;
  conversationId: string;
  contentRevision: number;
  byteStart: number;
  byteEnd: number;
  spanHash: string;
  episodeId: string;
  rootLineageId: string;
  elicitationOrigin: ElicitationOrigin;
};

export type CompositeConfirmationEvidence = {
  kind: "composite_confirmation";
  evidenceUnitId: string;
  questionEvidenceUnitId: string;
  answerEvidenceUnitId: string;
  conversationId: string;
  episodeId: string;
  rootLineageId: string;
  elicitationOrigin: Exclude<ElicitationOrigin, "NOT_APPLICABLE" | "TOOL_ROOTED">;
  strongOwnerAuthority: boolean;
  authorityRuleCodes: string[];
};

export type ScopedToolObservationEvidence = {
  kind: "scoped_tool_observation";
  evidenceUnitId: string;
  toolResultEvidenceUnitId: string;
  authorityAttestationEvidenceUnitId: string;
  conversationId: string;
  episodeId: string;
  rootLineageId: string;
  toolId: string;
  observationScope: string;
};

export type EvidenceUnit =
  | AtomicSpanEvidence
  | CompositeConfirmationEvidence
  | ScopedToolObservationEvidence;

export type ClaimAtom = {
  subject: "owner" | "operia" | "relationship" | "world" | "third_party";
  predicate: string;
  scope: string;
  valueJson: unknown;
};

export type FactProposalPayload = {
  kind: "fact";
  claimAtom: ClaimAtom;
};

export type SubjectProposalPayload = {
  kind: "subject";
  subject: "self" | "owner" | "relationship";
  operations: Array<{
    operation: "add" | "replace" | "retire";
    claimKey: string;
    value: string | null;
  }>;
};

export type RelationshipMomentPayload = {
  kind: "relationship_moment";
  summary: string;
};

export type PointProposalPayload = {
  kind: "point";
  topicKey: string;
  stanceAtom: string;
  applicabilityScope: string;
  rationaleAtoms: string[];
  triggerRefs: string[];
  injectedAncestorRefs: string[];
  sourceInfluence:
    | "UNPROMPTED"
    | "OWNER_ELICITED"
    | "MEMORY_ELICITED"
    | "ROLEPLAY"
    | "POLICY_ELICITED"
    | "TASK_ELICITED";
};

export type DeletionIntentPayload = {
  kind: "deletion_intent";
  targetRefs: string[];
  requestedAction: "FORGET_HIDE" | "PURGE_NOW";
};

export type MemoryProposalPayload =
  | FactProposalPayload
  | SubjectProposalPayload
  | RelationshipMomentPayload
  | PointProposalPayload
  | DeletionIntentPayload;

export type MemoryProposal = {
  proposalId: string;
  logicalProposalKey: string;
  proposalRevision: number;
  producer: ProposalProducerKind;
  producerMetadata: ProposalProducerMetadata;
  extractorRunId: string | null;
  payload: MemoryProposalPayload;
  evidenceInterpretationIds: string[];
  protectedImpacts: ProtectedImpact[];
  expectedHeadRevisions: Record<string, number>;
  projectedState: ProposalProjectionState;
  stateVersion: number;
  schemaVersion: string;
  createdAtUtc: string;
};

export type ProposalStateEvent = {
  eventId: string;
  proposalId: string;
  proposalRevision: number;
  fromState: ProposalProjectionState;
  toState: ProposalState;
  causeRef: string;
  expectedStateVersion: number;
  resultingStateVersion: number;
  createdAtUtc: string;
};

export type OwnerReviewDecision = {
  decisionId: string;
  proposalId: string;
  proposalRevision: number;
  action: "APPROVE" | "EDIT_AND_APPROVE" | "REJECT" | "LATER";
  editedProposalId: string | null;
  expectedHeadRevisions: Record<string, number>;
  ownerActorId: string;
  authContextHash: string;
  decisionTokenHash: string;
  decisionTokenExpiresAtUtc: string;
  decidedAtUtc: string;
};

export type MutationDecision = {
  decisionId: string;
  proposalId: string;
  proposalRevision: number;
  candidateSetArtifactId: string | null;
  action:
    | "DUPLICATE"
    | "REINFORCE"
    | "ADD"
    | "COEXISTS"
    | "STATE_CHANGE"
    | "RETROACTIVE_CORRECTION"
    | "SCOPE_CLARIFICATION"
    | "EPISTEMIC_RETRACTION"
    | "DISPUTE"
    | "PROTECTED_REVIEW"
    | "DEFERRED_COMPARISON"
    | "REJECT";
  expectedHeadRevisions: Record<string, number>;
  observedHeadRevisions: Record<string, number>;
  ruleCodes: string[];
  semanticEffectKey: string;
  commitStatus: "NOT_READY" | "READY" | "COMMITTED" | "STALE_CAS" | "REJECTED";
  committedRevisionIds: string[];
  policyVersion: string;
  createdAtUtc: string;
};

export type CanonicalEvidenceRef = {
  evidenceRefId: string;
  eventId: string;
  conversationId: string;
  actorId: string;
  actorClass: "owner" | "operia" | "trusted_tool" | "system" | "unknown";
  eventRole: "user_message" | "assistant_message" | "tool_result" | "imported_event";
  toolId: string | null;
  replyToEventId: string | null;
  occurredAtUtc: string;
  evidenceTimePrecision: "exact" | "day" | "month" | "year" | "bounded" | "unknown";
  contentRevision: number;
  contentRef: string;
  byteStart: number | null;
  byteEnd: number | null;
  spanRef: string | null;
  sensitivity: "normal" | "secret";
  evidenceUnitKind?: EvidenceUnitKind;
  spanHash?: string | null;
  episodeId?: string | null;
  rootLineageId?: string | null;
  elicitationOrigin?: ElicitationOrigin;
  compositeStrongOwnerAuthority?: boolean;
};

export type MutationRelation =
  | "DUPLICATE"
  | "REINFORCE"
  | "COEXISTS"
  | "STATE_CHANGE"
  | "RETROACTIVE_CORRECTION"
  | "SCOPE_CLARIFICATION"
  | "EPISTEMIC_RETRACTION"
  | "DISPUTE"
  | "DEFERRED_COMPARISON";

export type DynamicRecallNeed = "BYPASS" | "OPTIONAL" | "REQUIRED";

export type EvidenceRelation = "SUPPORTS" | "CONTRADICTS" | "CONFIRMS" | "QUALIFIES";

export type EvidenceInterpretation = {
  interpretationId: string;
  proposalId: string;
  evidenceRefId: string;
  proposedSubject: "owner" | "operia" | "relationship" | "world" | "third_party";
  referencedSubjectId: string | null;
  proposedSourceMode:
    | "direct_statement"
    | "reply_confirmation"
    | "observation"
    | "quotation"
    | "hypothetical"
    | "roleplay"
    | "sarcasm_ambiguous"
    | "import";
  validatedAuthority: "owner" | "operia" | "trusted_tool" | "third_party" | "none";
  evidenceRelation: EvidenceRelation;
  validationRuleCodes: string[];
  validatorVersion: string;
};

export type EvidenceSupportGroup = {
  supportGroupId: string;
  mode: "ALL_REQUIRED" | "ANY_SUFFICIENT";
  interpretationIds: string[];
  groupHash: string;
};

export type FactRevision = {
  factRevisionId: string;
  factKey: string;
  revision: number;
  epistemicStatus: "known" | "believed" | "disputed";
  lifecycleStatus: "current" | "historical" | "superseded" | "retracted" | "deleted";
  validFromUtc: string | null;
  validToUtc: string | null;
  validStartKind: "KNOWN" | "UNBOUNDED" | "UNKNOWN";
  validEndKind: "KNOWN" | "OPEN_ENDED" | "UNKNOWN";
  validTimePrecision: "exact" | "day" | "month" | "year" | "bounded" | "unknown";
  validTimeBasis: "owner_explicit" | "tool_observed" | "event_time" | "inferred" | "unknown";
  txnFromSeq: number;
  txnToSeq: number | null;
};

export type FactRevisionEvidence = {
  factRevisionId: string;
  interpretationId: string;
  lineageId: string;
  supportGroupId: string | null;
  relation: EvidenceRelation;
  edgeTxnFromSeq: number;
  edgeTxnToSeq: number | null;
};

const ALLOWED_TRANSITIONS: Readonly<Record<ProposalProjectionState, readonly ProposalState[]>> = {
  UNINITIALIZED: ["PROPOSED"],
  PROPOSED: ["VALIDATED", "QUARANTINED", "REJECTED"],
  VALIDATED: ["DEFERRED_COMPARISON", "AUTO_COMMIT_READY", "OWNER_REVIEW", "REJECTED"],
  QUARANTINED: ["VALIDATED", "REJECTED"],
  REJECTED: [],
  DEFERRED_COMPARISON: ["VALIDATED", "REJECTED"],
  AUTO_COMMIT_READY: ["COMMITTED", "STALE_CAS"],
  OWNER_REVIEW: ["AUTO_COMMIT_READY", "REJECTED", "SUPERSEDED"],
  COMMITTED: [],
  STALE_CAS: ["VALIDATED", "REJECTED"],
  SUPERSEDED: [],
};

export function assertProposalStateEvent(
  current: { state: ProposalProjectionState; version: number },
  event: ProposalStateEvent,
): void {
  if (event.fromState !== current.state) throw new Error("proposal_state_from_mismatch");
  if (event.expectedStateVersion !== current.version) throw new Error("proposal_state_version_mismatch");
  if (event.resultingStateVersion !== current.version + 1) throw new Error("proposal_state_result_version_invalid");
  if (!ALLOWED_TRANSITIONS[current.state].includes(event.toState)) throw new Error("proposal_state_transition_forbidden");
}

export function projectProposalState(events: readonly ProposalStateEvent[]): {
  state: ProposalProjectionState;
  version: number;
} {
  let current: { state: ProposalProjectionState; version: number } = { state: "UNINITIALIZED", version: 0 };
  for (const event of events) {
    assertProposalStateEvent(current, event);
    current = { state: event.toState, version: event.resultingStateVersion };
  }
  return current;
}

export function validateOwnerReviewDecision(
  decision: OwnerReviewDecision,
  proposal: Pick<MemoryProposal, "proposalId" | "proposalRevision" | "projectedState">,
): void {
  if (proposal.projectedState !== "OWNER_REVIEW") throw new Error("owner_review_proposal_state_invalid");
  if (decision.proposalId !== proposal.proposalId || decision.proposalRevision !== proposal.proposalRevision) {
    throw new Error("owner_review_proposal_revision_mismatch");
  }
  if (!decision.ownerActorId.trim()) throw new Error("owner_review_actor_required");
  if (!/^[a-f0-9]{64}$/.test(decision.authContextHash)) throw new Error("owner_review_auth_context_hash_invalid");
  if (!/^[a-f0-9]{64}$/.test(decision.decisionTokenHash)) throw new Error("owner_review_token_hash_invalid");
  if (!(Date.parse(decision.decisionTokenExpiresAtUtc) > Date.parse(decision.decidedAtUtc))) {
    throw new Error("owner_review_token_expired");
  }
  const edited = decision.action === "EDIT_AND_APPROVE";
  if (edited !== Boolean(decision.editedProposalId)) throw new Error("owner_review_edited_proposal_invalid");
  for (const revision of Object.values(decision.expectedHeadRevisions)) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("owner_review_expected_revision_invalid");
  }
}

export function isSupportGroupSatisfied(
  group: EvidenceSupportGroup,
  activeInterpretationIds: ReadonlySet<string>,
): boolean {
  if (group.interpretationIds.length === 0) return false;
  if (group.mode === "ALL_REQUIRED") {
    return group.interpretationIds.every((id) => activeInterpretationIds.has(id));
  }
  return group.interpretationIds.some((id) => activeInterpretationIds.has(id));
}
