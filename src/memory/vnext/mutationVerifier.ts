import type { MutationRelation } from "./contracts";
import { canonicalJson } from "../import/hashes";
import { memoryArtifactHash } from "./integrity";
import type { ClaimPairComparison, MutationDirection } from "./mutationRelations";

export const MEMORY_MUTATION_VERIFIER_VERSION = "memory-mutation-verifier-v2.0.0";

export type MutationSemanticSignal =
  | "NONE"
  | "EXPLICIT_LATER_STATE"
  | "EXPLICIT_PRIOR_ERROR"
  | "EXPLICIT_SCOPE_CORRECTION"
  | "EXPLICIT_CERTAINTY_WITHDRAWAL"
  | "EXPLICIT_MATERIAL_CONTRADICTION";

export type ModelMutationProposal = {
  relation: MutationRelation;
  direction: MutationDirection;
  basisEvidenceUnitIds: string[];
  semanticSignal: MutationSemanticSignal;
  reasonCode: string;
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  inputHash: string;
  outputHash: string;
};

export type HarnessMutationSignals = {
  verifiedRelation: Exclude<MutationRelation,"DUPLICATE" | "REINFORCE" | "COEXISTS" | "DEFERRED_COMPARISON"> | null;
  verifiedDirection: MutationDirection;
  verifiedSemanticSignal: MutationSemanticSignal;
  verifiedBasisEvidenceUnitIds: string[];
  bothClaimsHaveSufficientPositiveSupport: boolean;
  materialScopeOverlap: boolean;
  protectedImpact: boolean;
};

export type VerifiedMutationVerdict = {
  verdictId: string;
  pairKey: string;
  relation: MutationRelation;
  direction: MutationDirection;
  modelProposalAccepted: boolean;
  basisEvidenceUnitIds: string[];
  ruleCodes: string[];
  protectedImpact: boolean;
  policyVersion: string;
};

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function requiredSignal(relation: MutationRelation): MutationSemanticSignal | null {
  if (relation === "STATE_CHANGE") return "EXPLICIT_LATER_STATE";
  if (relation === "RETROACTIVE_CORRECTION") return "EXPLICIT_PRIOR_ERROR";
  if (relation === "SCOPE_CLARIFICATION") return "EXPLICIT_SCOPE_CORRECTION";
  if (relation === "EPISTEMIC_RETRACTION") return "EXPLICIT_CERTAINTY_WITHDRAWAL";
  if (relation === "DISPUTE") return "EXPLICIT_MATERIAL_CONTRADICTION";
  return null;
}

export async function verifyMutationProposal(input: {
  comparison: ClaimPairComparison;
  proposal: ModelMutationProposal | null;
  harness: HarnessMutationSignals;
}): Promise<VerifiedMutationVerdict> {
  const allEvidence = new Set([
    ...input.comparison.pair.claimA.evidenceUnitIds,
    ...input.comparison.pair.claimB.evidenceUnitIds,
  ]);
  const deterministicRelation = input.comparison.relation;
  let relation: MutationRelation;
  let direction: MutationDirection;
  let accepted = false;
  const ruleCodes: string[] = [];
  let basisEvidenceUnitIds: string[] = [];

  if (input.harness.protectedImpact) {
    relation = "DEFERRED_COMPARISON";
    direction = "NOT_APPLICABLE";
    ruleCodes.push("PROTECTED_IMPACT_OWNER_REVIEW_REQUIRED");
  } else if (input.comparison.terminal && deterministicRelation !== null) {
    relation = deterministicRelation;
    direction = input.comparison.direction;
    ruleCodes.push(...input.comparison.ruleCodes,"DETERMINISTIC_RELATION_APPLIED");
  } else if (!input.proposal) {
    relation = "DEFERRED_COMPARISON";
    direction = "NOT_APPLICABLE";
    ruleCodes.push("MODEL_RELATION_PROPOSAL_ABSENT");
  } else {
    basisEvidenceUnitIds = sortedUnique(input.proposal.basisEvidenceUnitIds);
    const harnessBasis = sortedUnique(input.harness.verifiedBasisEvidenceUnitIds);
    const basisValid = basisEvidenceUnitIds.length > 0
      && basisEvidenceUnitIds.every((id) => allEvidence.has(id))
      && basisEvidenceUnitIds.every((id) => harnessBasis.includes(id));
    const signal = requiredSignal(input.proposal.relation);
    const relationVerified = input.harness.verifiedRelation === input.proposal.relation;
    const directionVerified = input.harness.verifiedDirection === input.proposal.direction;
    const signalVerified = signal !== null
      && input.proposal.semanticSignal === signal
      && input.harness.verifiedSemanticSignal === signal;
    const overlapValid = input.proposal.relation === "SCOPE_CLARIFICATION" || input.harness.materialScopeOverlap;
    const disputeSupportValid = input.proposal.relation !== "DISPUTE"
      || input.harness.bothClaimsHaveSufficientPositiveSupport;
    if (basisValid && relationVerified && directionVerified && signalVerified && overlapValid && disputeSupportValid) {
      relation = input.proposal.relation;
      direction = input.proposal.direction;
      accepted = true;
      ruleCodes.push("MODEL_PROPOSAL_HARNESS_VERIFIED");
    } else {
      relation = "DEFERRED_COMPARISON";
      direction = "NOT_APPLICABLE";
      if (!basisValid) ruleCodes.push("BASIS_EVIDENCE_NOT_VERIFIED");
      if (!relationVerified) ruleCodes.push("RELATION_NOT_VERIFIED");
      if (!directionVerified) ruleCodes.push("DIRECTION_NOT_VERIFIED");
      if (!signalVerified) ruleCodes.push("SEMANTIC_SIGNAL_NOT_VERIFIED");
      if (!overlapValid) ruleCodes.push("MATERIAL_SCOPE_OVERLAP_NOT_VERIFIED");
      if (!disputeSupportValid) ruleCodes.push("DISPUTE_POSITIVE_SUPPORT_INSUFFICIENT");
    }
  }
  const verdictCore = {
    pairKey: input.comparison.pair.pairKey,
    relation,
    direction,
    modelProposalAccepted: accepted,
    basisEvidenceUnitIds,
    ruleCodes: [...new Set(ruleCodes)].sort(),
    protectedImpact: input.harness.protectedImpact,
    policyVersion: MEMORY_MUTATION_VERIFIER_VERSION,
  };
  const hash = await memoryArtifactHash("memory-mutation-verdict-v2",verdictCore);
  return { verdictId: `mv_${hash.slice(0,32)}`,...verdictCore };
}

export async function commitVerifiedMutation(input: {
  db: D1Database;
  verdict: VerifiedMutationVerdict;
  claimAId: string;
  claimBId: string;
  expectedHeadRevisions: Record<string,number>;
  observedHeadRevisions: Record<string,number>;
  deterministicRelation?: MutationRelation | null;
  modelProposal: ModelMutationProposal | null;
  dispute?: {
    overlapScope: Record<string,unknown>;
    overlapValidTime: Record<string,unknown> | "unknown";
    cause: "value_conflict" | "scope_ambiguity" | "time_ambiguity";
  };
  createdAtUtc: string;
}): Promise<{ caseId: string; relationId: string | null; disputeId: string | null }> {
  const expected = Object.entries(input.expectedHeadRevisions).sort();
  const observed = Object.entries(input.observedHeadRevisions).sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) throw new Error("memory_mutation_commit_stale_cas");
  const [claimAId,claimBId] = [input.claimAId,input.claimBId].sort();
  if (`${claimAId}:${claimBId}` !== input.verdict.pairKey) throw new Error("memory_mutation_pair_identity_mismatch");
  const caseStatus = input.verdict.relation === "DEFERRED_COMPARISON"
    ? input.verdict.protectedImpact ? "OWNER_REVIEW" : "DEFERRED"
    : "VERIFIED";
  const statements: D1PreparedStatement[] = [input.db.prepare(`INSERT INTO memory_claim_mutation_cases(
    case_id,pair_key,claim_a_id,claim_b_id,deterministic_relation,harness_relation,direction,
    model_proposal_json,model_provider,model_model,prompt_version,schema_version,input_hash,output_hash,
    basis_evidence_unit_ids_json,expected_head_revisions_json,observed_head_revisions_json,
    rule_codes_json,status,policy_version,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    input.verdict.verdictId,input.verdict.pairKey,claimAId,claimBId,input.deterministicRelation ?? null,input.verdict.relation,
    input.verdict.direction,input.modelProposal ? JSON.stringify(input.modelProposal) : null,
    input.modelProposal?.provider ?? null,input.modelProposal?.model ?? null,input.modelProposal?.promptVersion ?? null,
    input.modelProposal?.schemaVersion ?? null,input.modelProposal?.inputHash ?? null,input.modelProposal?.outputHash ?? null,
    canonicalJson(input.verdict.basisEvidenceUnitIds),canonicalJson(input.expectedHeadRevisions),
    canonicalJson(input.observedHeadRevisions),canonicalJson(input.verdict.ruleCodes),caseStatus,
    input.verdict.policyVersion,input.createdAtUtc,
  )];
  let relationId: string | null = null;
  let disputeId: string | null = null;
  if (input.verdict.relation !== "DEFERRED_COMPARISON") {
    if (input.verdict.direction === "NOT_APPLICABLE") throw new Error("memory_mutation_relation_direction_required");
    const relationHash = await memoryArtifactHash("memory-claim-mutation-relation-v2", {
      caseId: input.verdict.verdictId,
      pairKey: input.verdict.pairKey,
      relation: input.verdict.relation,
      direction: input.verdict.direction,
    });
    relationId = `cmr_${relationHash.slice(0,32)}`;
    const fromClaimId = input.verdict.direction === "B_TO_A" ? claimBId : claimAId;
    const toClaimId = input.verdict.direction === "B_TO_A" ? claimAId : claimBId;
    statements.push(input.db.prepare(`INSERT INTO memory_claim_mutation_relations(
      relation_id,case_id,pair_key,from_claim_atom_id,to_claim_atom_id,relation,direction,policy_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      relationId,input.verdict.verdictId,input.verdict.pairKey,fromClaimId,toClaimId,
      input.verdict.relation,input.verdict.direction,input.verdict.policyVersion,input.createdAtUtc,
    ));
    if (input.verdict.relation === "DISPUTE") {
      if (!input.dispute) throw new Error("memory_mutation_dispute_context_required");
      const disputeHash = await memoryArtifactHash("memory-claim-dispute-set-v2", {
        pairKey: input.verdict.pairKey,
        overlapScope: input.dispute.overlapScope,
        overlapValidTime: input.dispute.overlapValidTime,
        cause: input.dispute.cause,
      });
      disputeId = `cds_${disputeHash.slice(0,32)}`;
      statements.push(
        input.db.prepare(`INSERT INTO memory_claim_dispute_sets(
          dispute_id,overlap_scope_json,overlap_valid_time_json,cause,policy_version,created_at
        ) VALUES(?,?,?,?,?,?)`).bind(
          disputeId,canonicalJson(input.dispute.overlapScope),canonicalJson(input.dispute.overlapValidTime),
          input.dispute.cause,input.verdict.policyVersion,input.createdAtUtc,
        ),
        input.db.prepare(`INSERT INTO memory_claim_dispute_members(
          dispute_id,claim_atom_id,ordinal,created_at
        ) VALUES(?,?,0,?)`).bind(disputeId,claimAId,input.createdAtUtc),
        input.db.prepare(`INSERT INTO memory_claim_dispute_members(
          dispute_id,claim_atom_id,ordinal,created_at
        ) VALUES(?,?,1,?)`).bind(disputeId,claimBId,input.createdAtUtc),
        input.db.prepare(`INSERT INTO memory_claim_dispute_state_events(
          event_id,dispute_id,from_status,to_status,expected_state_version,resulting_state_version,
          resolution_relation_id,reason_code,created_at
        ) VALUES(?,?,NULL,'open',0,1,NULL,'MATERIAL_CONTRADICTION_VERIFIED',?)`).bind(
          `cdse_${disputeHash.slice(0,32)}`,disputeId,input.createdAtUtc,
        ),
      );
    }
  }
  await input.db.batch(statements);
  return { caseId: input.verdict.verdictId,relationId,disputeId };
}
