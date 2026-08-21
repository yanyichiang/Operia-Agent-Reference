import { canonicalJson } from "../import/hashes";
import type { AssertionKind, ClaimAtomV2, MutationRelation, ProtectedImpact } from "./contracts";
import { memoryArtifactHash } from "./integrity";

export const MEMORY_PREDICATE_REGISTRY_VERSION = "memory-predicate-registry-v2.0.0";

export type PredicateDefinition = {
  predicateId: string;
  assertionKinds: AssertionKind[];
  cardinality: "single" | "set_member" | "ordered_set" | "scalar" | "event";
  objectInClaimKey: boolean;
  defaultConflictPolicy:
    | "compare_single_value"
    | "coexist_by_object"
    | "coexist_by_time"
    | "append_event"
    | "defer";
  protectedImpactRules: ProtectedImpact[];
  schemaVersion: string;
};

const definitions: readonly PredicateDefinition[] = [
  {
    predicateId: "communication.answer_style",
    assertionKinds: ["preference"],
    cardinality: "single",
    objectInClaimKey: false,
    defaultConflictPolicy: "compare_single_value",
    protectedImpactRules: [],
    schemaVersion: "1",
  },
  {
    predicateId: "owner.education.major",
    assertionKinds: ["state"],
    cardinality: "single",
    objectInClaimKey: false,
    defaultConflictPolicy: "compare_single_value",
    protectedImpactRules: [],
    schemaVersion: "1",
  },
  {
    predicateId: "owner.location.home",
    assertionKinds: ["state"],
    cardinality: "single",
    objectInClaimKey: false,
    defaultConflictPolicy: "coexist_by_time",
    protectedImpactRules: [],
    schemaVersion: "1",
  },
  {
    predicateId: "owner.preference.beverage",
    assertionKinds: ["preference"],
    cardinality: "set_member",
    objectInClaimKey: true,
    defaultConflictPolicy: "coexist_by_object",
    protectedImpactRules: [],
    schemaVersion: "1",
  },
  {
    predicateId: "preference.drink",
    assertionKinds: ["preference"],
    cardinality: "set_member",
    objectInClaimKey: true,
    defaultConflictPolicy: "coexist_by_object",
    protectedImpactRules: [],
    schemaVersion: "1",
  },
  {
    predicateId: "owner.project.current",
    assertionKinds: ["state", "intention"],
    cardinality: "set_member",
    objectInClaimKey: true,
    defaultConflictPolicy: "coexist_by_object",
    protectedImpactRules: [],
    schemaVersion: "1",
  },
  {
    predicateId: "owner.goal",
    assertionKinds: ["intention"],
    cardinality: "set_member",
    objectInClaimKey: true,
    defaultConflictPolicy: "coexist_by_object",
    protectedImpactRules: [],
    schemaVersion: "1",
  },
  {
    predicateId: "owner.commitment",
    assertionKinds: ["commitment"],
    cardinality: "event",
    objectInClaimKey: true,
    defaultConflictPolicy: "append_event",
    protectedImpactRules: [],
    schemaVersion: "1",
  },
  {
    predicateId: "owner.belief",
    assertionKinds: ["belief"],
    cardinality: "set_member",
    objectInClaimKey: true,
    defaultConflictPolicy: "defer",
    protectedImpactRules: [],
    schemaVersion: "1",
  },
  {
    predicateId: "owner.evaluation",
    assertionKinds: ["evaluation"],
    cardinality: "set_member",
    objectInClaimKey: true,
    defaultConflictPolicy: "defer",
    protectedImpactRules: [],
    schemaVersion: "1",
  },
  {
    predicateId: "owner.identity",
    assertionKinds: ["state"],
    cardinality: "single",
    objectInClaimKey: false,
    defaultConflictPolicy: "defer",
    protectedImpactRules: ["OWNER_IDENTITY"],
    schemaVersion: "1",
  },
  {
    predicateId: "relationship.definition",
    assertionKinds: ["state"],
    cardinality: "single",
    objectInClaimKey: false,
    defaultConflictPolicy: "defer",
    protectedImpactRules: ["RELATIONSHIP_DEFINITION"],
    schemaVersion: "1",
  },
  {
    predicateId: "owner.permission",
    assertionKinds: ["state", "commitment"],
    cardinality: "set_member",
    objectInClaimKey: true,
    defaultConflictPolicy: "defer",
    protectedImpactRules: ["PERMISSION"],
    schemaVersion: "1",
  },
];

const registry = new Map(definitions.map((definition) => [definition.predicateId, Object.freeze({
  ...definition,
  assertionKinds: Object.freeze([...definition.assertionKinds]),
  protectedImpactRules: Object.freeze([...definition.protectedImpactRules]),
}) as PredicateDefinition]));

export function listPredicateDefinitions(): PredicateDefinition[] {
  return [...registry.values()].map((definition) => ({
    ...definition,
    assertionKinds: [...definition.assertionKinds],
    protectedImpactRules: [...definition.protectedImpactRules],
  }));
}

export function getPredicateDefinition(
  predicateId: string,
  registryVersion: string = MEMORY_PREDICATE_REGISTRY_VERSION,
): PredicateDefinition | null {
  if (registryVersion !== MEMORY_PREDICATE_REGISTRY_VERSION) return null;
  const definition = registry.get(predicateId);
  return definition ? {
    ...definition,
    assertionKinds: [...definition.assertionKinds],
    protectedImpactRules: [...definition.protectedImpactRules],
  } : null;
}

export function validateClaimAtomAgainstPredicate(atom: ClaimAtomV2): {
  known: boolean;
  valid: boolean;
  definition: PredicateDefinition | null;
  ruleCodes: string[];
} {
  const definition = getPredicateDefinition(atom.predicateId,atom.predicateRegistryVersion);
  if (!definition) {
    return { known: false, valid: true, definition: null, ruleCodes: ["PREDICATE_UNKNOWN_DEFER"] };
  }
  const ruleCodes: string[] = [];
  if (!definition.assertionKinds.includes(atom.assertionKind)) ruleCodes.push("ASSERTION_KIND_NOT_ALLOWED");
  if (definition.objectInClaimKey && !atom.objectRef?.trim()) ruleCodes.push("PREDICATE_OBJECT_REQUIRED");
  if (!definition.objectInClaimKey && atom.objectRef !== null) ruleCodes.push("PREDICATE_OBJECT_FORBIDDEN");
  return {
    known: true,
    valid: ruleCodes.length === 0,
    definition,
    ruleCodes: ruleCodes.length === 0 ? ["PREDICATE_REGISTERED"] : ruleCodes,
  };
}

export async function buildClaimKey(atom: ClaimAtomV2): Promise<string> {
  const validation = validateClaimAtomAgainstPredicate(atom);
  const keyHash = await memoryArtifactHash("memory-claim-key-v2", {
    subjectRef: atom.subjectRef,
    predicateId: atom.predicateId,
    objectRef: validation.definition?.objectInClaimKey ? atom.objectRef : null,
    scopeKey: atom.scope.key,
    registryVersion: atom.predicateRegistryVersion,
  });
  return `ck_${keyHash}`;
}

function temporalRangesDisjoint(left: ClaimAtomV2, right: ClaimAtomV2): boolean {
  const leftFrom = left.scope.validFromUtc ? Date.parse(left.scope.validFromUtc) : Number.NEGATIVE_INFINITY;
  const leftTo = left.scope.validToUtc ? Date.parse(left.scope.validToUtc) : Number.POSITIVE_INFINITY;
  const rightFrom = right.scope.validFromUtc ? Date.parse(right.scope.validFromUtc) : Number.NEGATIVE_INFINITY;
  const rightTo = right.scope.validToUtc ? Date.parse(right.scope.validToUtc) : Number.POSITIVE_INFINITY;
  if ([leftFrom,leftTo,rightFrom,rightTo].some((value) => Number.isNaN(value))) return false;
  return leftTo <= rightFrom || rightTo <= leftFrom;
}

export function deterministicCompatibility(left: ClaimAtomV2, right: ClaimAtomV2): {
  relation: MutationRelation | null;
  direction: "SYMMETRIC" | "LEFT_TO_RIGHT" | "RIGHT_TO_LEFT" | "NOT_APPLICABLE";
  ruleCodes: string[];
} {
  if (left.claimAtomId === right.claimAtomId) {
    return { relation: "DUPLICATE", direction: "SYMMETRIC", ruleCodes: ["IDENTICAL_CLAIM_ATOM"] };
  }
  if (left.subjectRef !== right.subjectRef || left.predicateId !== right.predicateId || left.scope.key !== right.scope.key) {
    return { relation: "COEXISTS", direction: "SYMMETRIC", ruleCodes: ["CLAIM_KEY_NON_OVERLAP"] };
  }
  const leftValidation = validateClaimAtomAgainstPredicate(left);
  const rightValidation = validateClaimAtomAgainstPredicate(right);
  if (!leftValidation.valid || !rightValidation.valid) {
    return { relation: "DEFERRED_COMPARISON", direction: "NOT_APPLICABLE", ruleCodes: [
      ...leftValidation.ruleCodes,
      ...rightValidation.ruleCodes,
    ].sort() };
  }
  if (!leftValidation.definition || !rightValidation.definition) {
    return { relation: "DEFERRED_COMPARISON", direction: "NOT_APPLICABLE", ruleCodes: ["PREDICATE_UNKNOWN_DEFER"] };
  }
  if (left.objectRef !== right.objectRef && leftValidation.definition.defaultConflictPolicy === "coexist_by_object") {
    return { relation: "COEXISTS", direction: "SYMMETRIC", ruleCodes: ["DISTINCT_SET_MEMBER_OBJECT"] };
  }
  if (temporalRangesDisjoint(left,right)) {
    return { relation: "COEXISTS", direction: "SYMMETRIC", ruleCodes: ["VALID_TIME_NON_OVERLAP"] };
  }
  if (canonicalJson(left.canonicalValue) === canonicalJson(right.canonicalValue)
    && canonicalJson(left.qualifiers) === canonicalJson(right.qualifiers)) {
    return { relation: "REINFORCE", direction: "SYMMETRIC", ruleCodes: ["CANONICAL_SEMANTICS_EQUAL"] };
  }
  if (leftValidation.definition.defaultConflictPolicy === "append_event") {
    return { relation: "COEXISTS", direction: "SYMMETRIC", ruleCodes: ["APPEND_EVENT_POLICY"] };
  }
  return { relation: null, direction: "NOT_APPLICABLE", ruleCodes: ["SEMANTIC_RELATION_REVIEW_REQUIRED"] };
}
