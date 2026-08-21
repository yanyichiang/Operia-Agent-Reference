import { canonicalJson } from "../import/hashes";
import type {
  AssertionKind,
  ClaimAtomV2,
  ClaimGroup,
  ClaimQualifiers,
  ClaimScope,
} from "./contracts";
import { memoryArtifactHash } from "./integrity";
import {
  MEMORY_PREDICATE_REGISTRY_VERSION,
  validateClaimAtomAgainstPredicate,
} from "./predicateRegistry";

export const MEMORY_CLAIM_NORMALIZATION_VERSION = "memory-claim-normalization-v2.0.0";

const stableKeyPattern = /^[a-z][a-z0-9_.:-]{2,127}$/;
const objectRefPattern = /^[a-z0-9][a-z0-9_.:-]{0,159}$/;

export type ClaimAtomDraft = {
  subjectRef: ClaimAtomV2["subjectRef"];
  assertionKind: AssertionKind;
  predicateId: string;
  objectRef: string | null;
  canonicalValue: unknown;
  scope: ClaimScope;
  qualifiers: ClaimQualifiers;
  evidenceUnitIds: string[];
};

function canonicalUtcOrNull(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("memory_claim_scope_time_invalid");
  return new Date(parsed).toISOString();
}

function normalizeScope(scope: ClaimScope): ClaimScope {
  const key = scope.key.trim().toLowerCase();
  if (!stableKeyPattern.test(key)) throw new Error("memory_claim_scope_key_invalid");
  const validFromUtc = canonicalUtcOrNull(scope.validFromUtc);
  const validToUtc = canonicalUtcOrNull(scope.validToUtc);
  if (validFromUtc && validToUtc && validFromUtc >= validToUtc) {
    throw new Error("memory_claim_scope_range_invalid");
  }
  const contextRefs = [...new Set(scope.contextRefs.map((value) => value.trim()).filter(Boolean))].sort();
  if (contextRefs.length > 16 || contextRefs.some((value) => value.length > 160)) {
    throw new Error("memory_claim_scope_context_invalid");
  }
  return {
    key,
    validFromUtc,
    validToUtc,
    temporalPrecision: scope.temporalPrecision,
    contextRefs,
  };
}

function normalizeQualifiers(qualifiers: ClaimQualifiers): ClaimQualifiers {
  const attributes = Object.fromEntries(Object.entries(qualifiers.attributes)
    .map(([key,value]) => [key.trim().toLowerCase(),value] as const)
    .sort(([left],[right]) => left.localeCompare(right)));
  if (Object.keys(attributes).some((key) => !stableKeyPattern.test(key))) {
    throw new Error("memory_claim_qualifier_key_invalid");
  }
  if (Object.keys(attributes).length > 24) throw new Error("memory_claim_qualifier_limit");
  return {
    certainty: qualifiers.certainty,
    negated: qualifiers.negated,
    attributes,
  };
}

function normalizeDraft(draft: ClaimAtomDraft): ClaimAtomDraft {
  const predicateId = draft.predicateId.trim().toLowerCase();
  if (!stableKeyPattern.test(predicateId)) throw new Error("memory_claim_predicate_invalid");
  const objectRef = draft.objectRef === null ? null : draft.objectRef.trim().toLowerCase();
  if (objectRef !== null && !objectRefPattern.test(objectRef)) throw new Error("memory_claim_object_ref_invalid");
  canonicalJson(draft.canonicalValue);
  const evidenceUnitIds = [...new Set(draft.evidenceUnitIds.map((value) => value.trim()).filter(Boolean))].sort();
  if (evidenceUnitIds.length === 0 || evidenceUnitIds.length > 16) {
    throw new Error("memory_claim_evidence_units_invalid");
  }
  return {
    ...draft,
    predicateId,
    objectRef,
    scope: normalizeScope(draft.scope),
    qualifiers: normalizeQualifiers(draft.qualifiers),
    evidenceUnitIds,
  };
}

export async function materializeClaimGroup(input: {
  canonicalEventId: string;
  contentRevision: number;
  drafts: ClaimAtomDraft[];
  predicateRegistryVersion?: string;
  normalizationVersion?: string;
}): Promise<{ group: ClaimGroup; atoms: ClaimAtomV2[] }> {
  if (!input.canonicalEventId.trim()) throw new Error("memory_claim_group_event_required");
  if (!Number.isSafeInteger(input.contentRevision) || input.contentRevision < 1) {
    throw new Error("memory_claim_group_content_revision_invalid");
  }
  if (input.drafts.length === 0 || input.drafts.length > 16) throw new Error("memory_claim_group_size_invalid");
  const predicateRegistryVersion = input.predicateRegistryVersion ?? MEMORY_PREDICATE_REGISTRY_VERSION;
  const normalizationVersion = input.normalizationVersion ?? MEMORY_CLAIM_NORMALIZATION_VERSION;
  const normalized = input.drafts.map(normalizeDraft);
  const groupContextHash = await memoryArtifactHash("memory-claim-group-context-v2", {
    canonicalEventId: input.canonicalEventId,
    contentRevision: input.contentRevision,
    normalized,
    predicateRegistryVersion,
    normalizationVersion,
  });
  const claimGroupId = `cg_${groupContextHash.slice(0,32)}`;
  const atoms: ClaimAtomV2[] = [];
  for (const draft of normalized) {
    const atomCore = {
      claimGroupId,
      subjectRef: draft.subjectRef,
      assertionKind: draft.assertionKind,
      predicateId: draft.predicateId,
      objectRef: draft.objectRef,
      canonicalValue: draft.canonicalValue,
      scope: draft.scope,
      qualifiers: draft.qualifiers,
      evidenceUnitIds: draft.evidenceUnitIds,
      predicateRegistryVersion,
      normalizationVersion,
    };
    const atomHash = await memoryArtifactHash("memory-claim-atom-v2",atomCore);
    const atom: ClaimAtomV2 = { claimAtomId: `ca_${atomHash.slice(0,32)}`,...atomCore };
    const validation = validateClaimAtomAgainstPredicate(atom);
    if (!validation.valid) throw new Error(`memory_claim_predicate_contract_invalid:${validation.ruleCodes.join(",")}`);
    atoms.push(atom);
  }
  if (new Set(atoms.map((atom) => atom.claimAtomId)).size !== atoms.length) {
    throw new Error("memory_claim_group_duplicate_atom");
  }
  return {
    group: {
      claimGroupId,
      canonicalEventId: input.canonicalEventId,
      contentRevision: input.contentRevision,
      claimAtomIds: atoms.map((atom) => atom.claimAtomId),
      groupContextHash,
      normalizationVersion,
    },
    atoms,
  };
}

export async function relateRenormalizedAtom(input: {
  oldAtom: ClaimAtomV2;
  newAtom: ClaimAtomV2;
  reasonCode: string;
}): Promise<{
  relationId: string;
  fromClaimAtomId: string;
  toClaimAtomId: string;
  relation: "RENORMALIZES";
  reasonCode: string;
}> {
  if (input.oldAtom.claimAtomId === input.newAtom.claimAtomId) {
    throw new Error("memory_claim_renormalization_identity_unchanged");
  }
  if (input.oldAtom.normalizationVersion === input.newAtom.normalizationVersion
    && input.oldAtom.predicateRegistryVersion === input.newAtom.predicateRegistryVersion) {
    throw new Error("memory_claim_renormalization_version_unchanged");
  }
  const reasonCode = input.reasonCode.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,95}$/.test(reasonCode)) throw new Error("memory_claim_renormalization_reason_invalid");
  const relationHash = await memoryArtifactHash("memory-claim-atom-renormalization-v2", {
    fromClaimAtomId: input.oldAtom.claimAtomId,
    toClaimAtomId: input.newAtom.claimAtomId,
    reasonCode,
  });
  return {
    relationId: `car_${relationHash.slice(0,32)}`,
    fromClaimAtomId: input.oldAtom.claimAtomId,
    toClaimAtomId: input.newAtom.claimAtomId,
    relation: "RENORMALIZES",
    reasonCode,
  };
}

export function materializeLegacyClaimView(atom: ClaimAtomV2): {
  subject: ClaimAtomV2["subjectRef"];
  predicate: string;
  scope: string;
  valueJson: unknown;
} {
  return {
    subject: atom.subjectRef,
    predicate: atom.predicateId,
    scope: atom.scope.key,
    valueJson: atom.canonicalValue,
  };
}
