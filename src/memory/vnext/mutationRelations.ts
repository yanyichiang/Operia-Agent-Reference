import { canonicalJson } from "../import/hashes";
import type { ClaimAtomV2, MutationRelation } from "./contracts";
import { deterministicCompatibility } from "./predicateRegistry";

export const MEMORY_MUTATION_RELATION_POLICY_VERSION = "memory-mutation-relation-v2.0.0";

export type MutationDirection = "A_TO_B" | "B_TO_A" | "SYMMETRIC" | "NOT_APPLICABLE";

export type ClaimEvidenceIdentity = {
  rootLineageIds: string[];
  elicitationEpisodeIds: string[];
};

export type OrderedClaimPair = {
  pairKey: string;
  claimA: ClaimAtomV2;
  claimB: ClaimAtomV2;
  evidenceA: ClaimEvidenceIdentity;
  evidenceB: ClaimEvidenceIdentity;
};

export type ClaimPairComparison = {
  pair: OrderedClaimPair;
  relation: MutationRelation | null;
  direction: MutationDirection;
  terminal: boolean;
  ruleCodes: string[];
  policyVersion: string;
};

function normalizeIdentity(identity: ClaimEvidenceIdentity): ClaimEvidenceIdentity {
  return {
    rootLineageIds: [...new Set(identity.rootLineageIds.map((value) => value.trim()).filter(Boolean))].sort(),
    elicitationEpisodeIds: [...new Set(identity.elicitationEpisodeIds.map((value) => value.trim()).filter(Boolean))].sort(),
  };
}

function identitiesOverlap(left: ClaimEvidenceIdentity, right: ClaimEvidenceIdentity): boolean {
  const roots = new Set(left.rootLineageIds);
  if (right.rootLineageIds.some((value) => roots.has(value))) return true;
  const episodes = new Set(left.elicitationEpisodeIds);
  return right.elicitationEpisodeIds.some((value) => episodes.has(value));
}

export function buildOrderedClaimPair(input: {
  left: ClaimAtomV2;
  right: ClaimAtomV2;
  leftEvidence: ClaimEvidenceIdentity;
  rightEvidence: ClaimEvidenceIdentity;
}): OrderedClaimPair {
  if (input.left.claimAtomId === input.right.claimAtomId) {
    throw new Error("memory_claim_pair_distinct_instances_required");
  }
  const leftFirst = input.left.claimAtomId.localeCompare(input.right.claimAtomId) < 0;
  const claimA = leftFirst ? input.left : input.right;
  const claimB = leftFirst ? input.right : input.left;
  const evidenceA = normalizeIdentity(leftFirst ? input.leftEvidence : input.rightEvidence);
  const evidenceB = normalizeIdentity(leftFirst ? input.rightEvidence : input.leftEvidence);
  return {
    pairKey: `${claimA.claimAtomId}:${claimB.claimAtomId}`,
    claimA,
    claimB,
    evidenceA,
    evidenceB,
  };
}

function canonicalSemanticsEqual(left: ClaimAtomV2, right: ClaimAtomV2): boolean {
  return left.subjectRef === right.subjectRef
    && left.assertionKind === right.assertionKind
    && left.predicateId === right.predicateId
    && left.objectRef === right.objectRef
    && canonicalJson(left.canonicalValue) === canonicalJson(right.canonicalValue)
    && canonicalJson(left.scope) === canonicalJson(right.scope)
    && canonicalJson(left.qualifiers) === canonicalJson(right.qualifiers);
}

export function compareClaimPair(input: {
  left: ClaimAtomV2;
  right: ClaimAtomV2;
  leftEvidence: ClaimEvidenceIdentity;
  rightEvidence: ClaimEvidenceIdentity;
}): ClaimPairComparison {
  const pair = buildOrderedClaimPair(input);
  if (canonicalSemanticsEqual(pair.claimA,pair.claimB)) {
    const duplicate = identitiesOverlap(pair.evidenceA,pair.evidenceB);
    return {
      pair,
      relation: duplicate ? "DUPLICATE" : "REINFORCE",
      direction: "SYMMETRIC",
      terminal: true,
      ruleCodes: [duplicate ? "SAME_SEMANTICS_SHARED_LINEAGE" : "SAME_SEMANTICS_INDEPENDENT_LINEAGE"],
      policyVersion: MEMORY_MUTATION_RELATION_POLICY_VERSION,
    };
  }
  const deterministic = deterministicCompatibility(pair.claimA,pair.claimB);
  if (deterministic.relation !== null) {
    const direction: MutationDirection = deterministic.direction === "SYMMETRIC"
      ? "SYMMETRIC"
      : deterministic.direction === "LEFT_TO_RIGHT"
        ? "A_TO_B"
        : deterministic.direction === "RIGHT_TO_LEFT"
          ? "B_TO_A"
          : "NOT_APPLICABLE";
    return {
      pair,
      relation: deterministic.relation,
      direction,
      terminal: true,
      ruleCodes: deterministic.ruleCodes,
      policyVersion: MEMORY_MUTATION_RELATION_POLICY_VERSION,
    };
  }
  return {
    pair,
    relation: null,
    direction: "NOT_APPLICABLE",
    terminal: false,
    ruleCodes: ["BOUNDED_SEMANTIC_REVIEW_REQUIRED"],
    policyVersion: MEMORY_MUTATION_RELATION_POLICY_VERSION,
  };
}

export function inverseMutationDirection(direction: MutationDirection): MutationDirection {
  if (direction === "A_TO_B") return "B_TO_A";
  if (direction === "B_TO_A") return "A_TO_B";
  return direction;
}

export function projectDirectionToCaller(
  pair: OrderedClaimPair,
  callerLeftClaimAtomId: string,
  direction: MutationDirection,
): MutationDirection {
  if (direction === "SYMMETRIC" || direction === "NOT_APPLICABLE") return direction;
  return callerLeftClaimAtomId === pair.claimA.claimAtomId ? direction : inverseMutationDirection(direction);
}
