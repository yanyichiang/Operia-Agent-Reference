import { canonicalJson } from "../import/hashes";
import type { Env } from "../../types";
import type { ClaimAtomV2 } from "./contracts";
import { memoryArtifactHash } from "./integrity";
import {
  inferencePolicyForDimension,
  ownerDimensionFamily,
  type ConflictSafeDimension,
} from "./ownerCognitiveModel";

export const MEMORY_NIGHT_REVIEW_POLICY_VERSION = "memory-night-review-court-v2.0.0";
export const MEMORY_NIGHT_REVIEW_PROMPT_VERSION = "memory-night-review-blind-profile-v2.0.0";
export const MEMORY_NIGHT_REVIEW_SCHEMA_VERSION = "memory-night-review-verdict-v2.0.0";

export type NightReviewRelation =
  | "DUPLICATE"
  | "REINFORCE"
  | "COEXISTS"
  | "STATE_CHANGE"
  | "RETROACTIVE_CORRECTION"
  | "SCOPE_CLARIFICATION"
  | "EPISTEMIC_RETRACTION"
  | "KEEP_DISPUTED"
  | "DEFER";

export type OwnerDimensionPatch = {
  dimensionKey: string;
  operation: "PROPOSE_ADD" | "PROPOSE_REVISE" | "PROPOSE_DISPUTE";
  valueJson: unknown;
  assertionMode: "explicit" | "observed_pattern" | "inferred_hypothesis";
  basisEvidenceUnitIds: string[];
};

export type NightReviewVerdict = {
  caseId: string;
  relation: NightReviewRelation;
  direction: "A_TO_B" | "B_TO_A" | "SYMMETRIC" | "NOT_APPLICABLE";
  basisEvidenceUnitIds: string[];
  reliedDimensionRevisionIds: string[];
  profileInfluence: "NONE" | "LANGUAGE_DISAMBIGUATION" | "SCOPE_DISAMBIGUATION" | "TIE_BREAK_ONLY";
  proposedDimensionPatches: OwnerDimensionPatch[];
  uncertaintyCodes: string[];
  reasonCode: string;
};

const NIGHT_REVIEW_RELATIONS: readonly NightReviewRelation[] = [
  "DUPLICATE","REINFORCE","COEXISTS","STATE_CHANGE","RETROACTIVE_CORRECTION",
  "SCOPE_CLARIFICATION","EPISTEMIC_RETRACTION","KEEP_DISPUTED","DEFER",
];
const NIGHT_REVIEW_DIRECTIONS = ["A_TO_B","B_TO_A","SYMMETRIC","NOT_APPLICABLE"] as const;
const NIGHT_REVIEW_PROFILE_INFLUENCE = [
  "NONE","LANGUAGE_DISAMBIGUATION","SCOPE_DISAMBIGUATION","TIE_BREAK_ONLY",
] as const;

export const NIGHT_REVIEW_VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    caseId: { type: "string", minLength: 3, maxLength: 160 },
    relation: { type: "string", enum: NIGHT_REVIEW_RELATIONS },
    direction: { type: "string", enum: NIGHT_REVIEW_DIRECTIONS },
    basisEvidenceUnitIds: {
      type: "array", maxItems: 32, items: { type: "string", minLength: 3, maxLength: 160 },
    },
    reliedDimensionRevisionIds: {
      type: "array", maxItems: 32, items: { type: "string", minLength: 3, maxLength: 160 },
    },
    profileInfluence: { type: "string", enum: NIGHT_REVIEW_PROFILE_INFLUENCE },
    proposedDimensionPatches: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          dimensionKey: { type: "string", minLength: 3, maxLength: 160 },
          operation: { type: "string", enum: ["PROPOSE_ADD","PROPOSE_REVISE","PROPOSE_DISPUTE"] },
          valueJson: {},
          assertionMode: { type: "string", enum: ["explicit","observed_pattern","inferred_hypothesis"] },
          basisEvidenceUnitIds: {
            type: "array", maxItems: 32, items: { type: "string", minLength: 3, maxLength: 160 },
          },
        },
        required: ["dimensionKey","operation","valueJson","assertionMode","basisEvidenceUnitIds"],
      },
    },
    uncertaintyCodes: {
      type: "array", maxItems: 24, items: { type: "string", minLength: 2, maxLength: 96 },
    },
    reasonCode: { type: "string", minLength: 2, maxLength: 160 },
  },
  required: [
    "caseId","relation","direction","basisEvidenceUnitIds","reliedDimensionRevisionIds",
    "profileInfluence","proposedDimensionPatches","uncertaintyCodes","reasonCode",
  ],
} as const;

function boundedString(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === "string"
    && value.trim().length >= minLength
    && value.trim().length <= maxLength;
}

function isBoundedStringArray(
  value: unknown,
  maxItems: number,
  minItemLength: number,
  maxItemLength: number,
): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => boundedString(item,minItemLength,maxItemLength));
}

export function parseNightReviewVerdict(raw: unknown): NightReviewVerdict {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("memory_night_review_verdict_object_required");
  const value = raw as Record<string,unknown>;
  const allowedKeys = new Set((NIGHT_REVIEW_VERDICT_JSON_SCHEMA.required as readonly string[]));
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("memory_night_review_verdict_extra_field");
  if (!boundedString(value.caseId,3,160)) throw new Error("memory_night_review_verdict_case_required");
  if (typeof value.relation !== "string" || !NIGHT_REVIEW_RELATIONS.includes(value.relation as NightReviewRelation)) {
    throw new Error("memory_night_review_verdict_relation_invalid");
  }
  if (typeof value.direction !== "string" || !(NIGHT_REVIEW_DIRECTIONS as readonly string[]).includes(value.direction)) {
    throw new Error("memory_night_review_verdict_direction_invalid");
  }
  if (!isBoundedStringArray(value.basisEvidenceUnitIds,32,3,160)
    || !isBoundedStringArray(value.reliedDimensionRevisionIds,32,3,160)
    || !isBoundedStringArray(value.uncertaintyCodes,24,2,96)) {
    throw new Error("memory_night_review_verdict_refs_invalid");
  }
  if (typeof value.profileInfluence !== "string"
    || !(NIGHT_REVIEW_PROFILE_INFLUENCE as readonly string[]).includes(value.profileInfluence)) {
    throw new Error("memory_night_review_verdict_profile_influence_invalid");
  }
  if (!boundedString(value.reasonCode,2,160)) {
    throw new Error("memory_night_review_verdict_reason_required");
  }
  if (!Array.isArray(value.proposedDimensionPatches) || value.proposedDimensionPatches.length > 12) {
    throw new Error("memory_night_review_dimension_patches_invalid");
  }
  const proposedDimensionPatches = value.proposedDimensionPatches.map((item): OwnerDimensionPatch => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("memory_night_review_dimension_patch_invalid");
    const patch = item as Record<string,unknown>;
    if (Object.keys(patch).some((key) => !["dimensionKey","operation","valueJson","assertionMode","basisEvidenceUnitIds"].includes(key))) {
      throw new Error("memory_night_review_dimension_patch_extra_field");
    }
    if (!boundedString(patch.dimensionKey,3,160)) throw new Error("memory_night_review_dimension_key_required");
    if (patch.operation !== "PROPOSE_ADD" && patch.operation !== "PROPOSE_REVISE" && patch.operation !== "PROPOSE_DISPUTE") {
      throw new Error("memory_night_review_dimension_operation_invalid");
    }
    if (patch.assertionMode !== "explicit" && patch.assertionMode !== "observed_pattern" && patch.assertionMode !== "inferred_hypothesis") {
      throw new Error("memory_night_review_dimension_assertion_mode_invalid");
    }
    if (!Object.prototype.hasOwnProperty.call(patch,"valueJson")) {
      throw new Error("memory_night_review_dimension_value_required");
    }
    try {
      canonicalJson(patch.valueJson);
    } catch {
      throw new Error("memory_night_review_dimension_value_invalid");
    }
    if (!isBoundedStringArray(patch.basisEvidenceUnitIds,32,3,160)) {
      throw new Error("memory_night_review_dimension_basis_invalid");
    }
    return {
      dimensionKey: patch.dimensionKey.trim(),operation: patch.operation,valueJson: patch.valueJson,
      assertionMode: patch.assertionMode,basisEvidenceUnitIds: sortedUnique(patch.basisEvidenceUnitIds),
    };
  });
  return {
    caseId: value.caseId.trim(),relation: value.relation as NightReviewRelation,
    direction: value.direction as NightReviewVerdict["direction"],
    basisEvidenceUnitIds: sortedUnique(value.basisEvidenceUnitIds),
    reliedDimensionRevisionIds: sortedUnique(value.reliedDimensionRevisionIds),
    profileInfluence: value.profileInfluence as NightReviewVerdict["profileInfluence"],
    proposedDimensionPatches,uncertaintyCodes: sortedUnique(value.uncertaintyCodes),
    reasonCode: value.reasonCode.trim(),
  };
}

export type BlindReviewPacket = {
  packetId: string;
  caseId: string;
  snapshotId: string;
  claimA: ClaimAtomV2;
  claimB: ClaimAtomV2;
  evidenceBundles: unknown[];
  predicateDefinition: unknown;
  deterministicPreclassification: unknown;
  allowedDecisions: NightReviewRelation[];
  packetHash: string;
  containsOwnerModel: false;
};

export type ProfileReviewPacket = {
  packetId: string;
  caseId: string;
  blindPacketHash: string;
  conflictSafeDimensions: ConflictSafeDimension[];
  includedDimensionRevisionIds: string[];
  scrubbedDimensionRevisionIds: string[];
  packetHash: string;
  conflictSafe: true;
};

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function nightReviewModelConfig(env: Pick<Env,
  "MEMORY_NIGHT_REVIEW_PROVIDER" | "MEMORY_NIGHT_REVIEW_MODEL" | "MEMORY_NIGHT_REVIEW_REASONING_EFFORT"
  | "MEMORY_NIGHT_REVIEW_PROMPT_VERSION" | "MEMORY_NIGHT_REVIEW_SCHEMA_VERSION"
>): {
  provider: string;
  model: string;
  reasoningConfig: { effort: "medium" | "high" | "max"; temperature: 0 };
  promptVersion: string;
  schemaVersion: string;
} {
  const model = env.MEMORY_NIGHT_REVIEW_MODEL?.trim() || "anthropic/claude-opus-4.6";
  const separator = model.indexOf("/");
  const modelProvider = separator > 0 ? model.slice(0,separator) : "anthropic";
  const provider = env.MEMORY_NIGHT_REVIEW_PROVIDER?.trim() || modelProvider;
  if (provider !== modelProvider) throw new Error("memory_night_review_provider_model_mismatch");
  const effort = env.MEMORY_NIGHT_REVIEW_REASONING_EFFORT?.trim();
  if (effort && effort !== "medium" && effort !== "high" && effort !== "max") {
    throw new Error("memory_night_review_reasoning_effort_invalid");
  }
  const reasoningEffort: "medium" | "high" | "max" = effort === "medium" || effort === "max" ? effort : "high";
  if (env.MEMORY_NIGHT_REVIEW_PROMPT_VERSION
    && env.MEMORY_NIGHT_REVIEW_PROMPT_VERSION !== MEMORY_NIGHT_REVIEW_PROMPT_VERSION) {
    throw new Error("memory_night_review_prompt_version_mismatch");
  }
  if (env.MEMORY_NIGHT_REVIEW_SCHEMA_VERSION
    && env.MEMORY_NIGHT_REVIEW_SCHEMA_VERSION !== MEMORY_NIGHT_REVIEW_SCHEMA_VERSION) {
    throw new Error("memory_night_review_schema_version_mismatch");
  }
  return {
    provider,
    model,reasoningConfig: { effort: reasoningEffort,temperature: 0 },
    promptVersion: MEMORY_NIGHT_REVIEW_PROMPT_VERSION,schemaVersion: MEMORY_NIGHT_REVIEW_SCHEMA_VERSION,
  };
}

export async function buildBlindReviewPacket(input: {
  caseId: string;
  snapshotId: string;
  claimA: ClaimAtomV2;
  claimB: ClaimAtomV2;
  evidenceBundles: unknown[];
  predicateDefinition: unknown;
  deterministicPreclassification: unknown;
  allowedDecisions: NightReviewRelation[];
}): Promise<BlindReviewPacket> {
  if (input.claimA.claimAtomId === input.claimB.claimAtomId) throw new Error("memory_night_review_distinct_claims_required");
  if (input.evidenceBundles.length === 0) throw new Error("memory_night_review_evidence_required");
  const core = {
    caseId: input.caseId,snapshotId: input.snapshotId,claimA: input.claimA,claimB: input.claimB,
    evidenceBundles: input.evidenceBundles,predicateDefinition: input.predicateDefinition,
    deterministicPreclassification: input.deterministicPreclassification,
    allowedDecisions: sortedUnique(input.allowedDecisions) as NightReviewRelation[],containsOwnerModel: false as const,
  };
  const packetHash = await memoryArtifactHash("memory-night-review-blind-packet-v2",core);
  return { packetId: `nrbp_${packetHash.slice(0,32)}`,...core,packetHash };
}

export async function buildProfileReviewPacket(input: {
  caseId: string;
  blindPacketHash: string;
  includedDimensions: ConflictSafeDimension[];
  scrubbedDimensionRevisionIds: string[];
}): Promise<ProfileReviewPacket> {
  const includedDimensionRevisionIds = input.includedDimensions.map((dimension) => dimension.dimensionRevisionId).sort();
  const scrubbedDimensionRevisionIds = sortedUnique(input.scrubbedDimensionRevisionIds);
  if (includedDimensionRevisionIds.some((id) => scrubbedDimensionRevisionIds.includes(id))) {
    throw new Error("memory_night_review_scrub_overlap");
  }
  const core = {
    caseId: input.caseId,blindPacketHash: input.blindPacketHash,
    conflictSafeDimensions: [...input.includedDimensions].sort((left,right) => left.dimensionRevisionId.localeCompare(right.dimensionRevisionId)),
    includedDimensionRevisionIds,scrubbedDimensionRevisionIds,conflictSafe: true as const,
  };
  const packetHash = await memoryArtifactHash("memory-night-review-profile-packet-v2",core);
  return { packetId: `nrpp_${packetHash.slice(0,32)}`,...core,packetHash };
}

export type NightReviewHarnessDecision = {
  caseId: string;
  finalRelation: NightReviewRelation;
  finalDirection: NightReviewVerdict["direction"];
  acceptedPass: "BLIND" | "PROFILE" | "NONE";
  basisEvidenceUnitIds: string[];
  reliedDimensionRevisionIds: string[];
  proposedDimensionPatches: OwnerDimensionPatch[];
  autoCommitOrdinaryMutation: boolean;
  ownerReviewRequired: boolean;
  ruleCodes: string[];
  policyVersion: string;
};

function validateVerdict(input: {
  verdict: NightReviewVerdict;
  caseId: string;
  allowedDecisions: NightReviewRelation[];
  caseEvidenceUnitIds: Set<string>;
  includedDimensionRevisionIds: Set<string>;
  scrubbedDimensionRevisionIds: Set<string>;
  pass: "BLIND" | "PROFILE";
}): string[] {
  const errors: string[] = [];
  const verdict = input.verdict;
  if (verdict.caseId !== input.caseId) errors.push("CASE_ID_MISMATCH");
  if (!input.allowedDecisions.includes(verdict.relation)) errors.push("RELATION_NOT_ALLOWED");
  const symmetric = ["DUPLICATE","REINFORCE","COEXISTS","KEEP_DISPUTED"].includes(verdict.relation);
  const directional = [
    "STATE_CHANGE","RETROACTIVE_CORRECTION","SCOPE_CLARIFICATION","EPISTEMIC_RETRACTION",
  ].includes(verdict.relation);
  if (symmetric && verdict.direction !== "SYMMETRIC") errors.push("SYMMETRIC_RELATION_DIRECTION_INVALID");
  if (directional && verdict.direction !== "A_TO_B" && verdict.direction !== "B_TO_A") {
    errors.push("DIRECTIONAL_RELATION_DIRECTION_INVALID");
  }
  if (verdict.relation === "DEFER" && verdict.direction !== "NOT_APPLICABLE") {
    errors.push("DEFER_DIRECTION_INVALID");
  }
  if (verdict.basisEvidenceUnitIds.length === 0 && verdict.relation !== "DEFER") errors.push("BASIS_EVIDENCE_REQUIRED");
  if (verdict.basisEvidenceUnitIds.some((id) => !input.caseEvidenceUnitIds.has(id))) errors.push("BASIS_EVIDENCE_OUTSIDE_CASE");
  if (input.pass === "BLIND" && (verdict.reliedDimensionRevisionIds.length > 0 || verdict.profileInfluence !== "NONE")) {
    errors.push("BLIND_PASS_PROFILE_DEPENDENCY_FORBIDDEN");
  }
  if (input.pass === "PROFILE"
    && ((verdict.reliedDimensionRevisionIds.length === 0) !== (verdict.profileInfluence === "NONE"))) {
    errors.push("PROFILE_INFLUENCE_LINEAGE_MISMATCH");
  }
  if (verdict.reliedDimensionRevisionIds.some((id) => !input.includedDimensionRevisionIds.has(id))) {
    errors.push("PROFILE_RELIES_ON_NON_INCLUDED_DIMENSION");
  }
  if (verdict.reliedDimensionRevisionIds.some((id) => input.scrubbedDimensionRevisionIds.has(id))) {
    errors.push("PROFILE_RELIES_ON_SCRUBBED_DIMENSION");
  }
  for (const patch of verdict.proposedDimensionPatches) {
    const family = ownerDimensionFamily(patch.dimensionKey);
    const inferencePolicy = inferencePolicyForDimension(patch.dimensionKey);
    if (!family || inferencePolicy === "never_infer") {
      errors.push("PROTECTED_OR_PERMISSION_DIMENSION_PATCH_FORBIDDEN");
    }
    if (inferencePolicy === "explicit_only" && patch.assertionMode !== "explicit") {
      errors.push("EXPLICIT_ONLY_DIMENSION_PATCH_INFERRED");
    }
    if (patch.basisEvidenceUnitIds.length === 0) errors.push("DIMENSION_PATCH_BASIS_REQUIRED");
    if (patch.basisEvidenceUnitIds.some((id) => !input.caseEvidenceUnitIds.has(id))) {
      errors.push("DIMENSION_PATCH_BASIS_OUTSIDE_CASE");
    }
  }
  return [...new Set(errors)].sort();
}

export function adjudicateNightReview(input: {
  caseId: string;
  allowedDecisions: NightReviewRelation[];
  caseEvidenceUnitIds: string[];
  blindVerdict: NightReviewVerdict;
  profileVerdict: NightReviewVerdict | null;
  includedDimensionRevisionIds: string[];
  scrubbedDimensionRevisionIds: string[];
  protectedImpact: boolean;
}): NightReviewHarnessDecision {
  const evidence = new Set(sortedUnique(input.caseEvidenceUnitIds));
  const included = new Set(sortedUnique(input.includedDimensionRevisionIds));
  const scrubbed = new Set(sortedUnique(input.scrubbedDimensionRevisionIds));
  const blindErrors = validateVerdict({
    verdict: input.blindVerdict,caseId: input.caseId,allowedDecisions: input.allowedDecisions,
    caseEvidenceUnitIds: evidence,includedDimensionRevisionIds: new Set(),scrubbedDimensionRevisionIds: scrubbed,pass: "BLIND",
  });
  if (blindErrors.length > 0) return {
    caseId: input.caseId,finalRelation: "DEFER",finalDirection: "NOT_APPLICABLE",acceptedPass: "NONE",
    basisEvidenceUnitIds: [],reliedDimensionRevisionIds: [],proposedDimensionPatches: [],
    autoCommitOrdinaryMutation: false,ownerReviewRequired: input.protectedImpact,
    ruleCodes: ["BLIND_VERDICT_INVALID",...blindErrors].sort(),policyVersion: MEMORY_NIGHT_REVIEW_POLICY_VERSION,
  };
  const blindClear = input.blindVerdict.relation !== "DEFER" && input.blindVerdict.uncertaintyCodes.length === 0;
  if (blindClear) {
    return {
      caseId: input.caseId,finalRelation: input.blindVerdict.relation,finalDirection: input.blindVerdict.direction,
      acceptedPass: "BLIND",basisEvidenceUnitIds: sortedUnique(input.blindVerdict.basisEvidenceUnitIds),
      reliedDimensionRevisionIds: [],proposedDimensionPatches: input.blindVerdict.proposedDimensionPatches,
      autoCommitOrdinaryMutation: !input.protectedImpact && !["DEFER","KEEP_DISPUTED"].includes(input.blindVerdict.relation),
      ownerReviewRequired: input.protectedImpact,
      ruleCodes: ["BLIND_CLEAR_PROFILE_CANNOT_OVERRIDE"],policyVersion: MEMORY_NIGHT_REVIEW_POLICY_VERSION,
    };
  }
  if (!input.profileVerdict) return {
    caseId: input.caseId,finalRelation: "DEFER",finalDirection: "NOT_APPLICABLE",acceptedPass: "NONE",
    basisEvidenceUnitIds: [],reliedDimensionRevisionIds: [],proposedDimensionPatches: [],
    autoCommitOrdinaryMutation: false,ownerReviewRequired: input.protectedImpact,
    ruleCodes: ["PROFILE_VERDICT_ABSENT"],policyVersion: MEMORY_NIGHT_REVIEW_POLICY_VERSION,
  };
  const profileErrors = validateVerdict({
    verdict: input.profileVerdict,caseId: input.caseId,allowedDecisions: input.allowedDecisions,
    caseEvidenceUnitIds: evidence,includedDimensionRevisionIds: included,scrubbedDimensionRevisionIds: scrubbed,pass: "PROFILE",
  });
  if (profileErrors.length > 0) return {
    caseId: input.caseId,finalRelation: "DEFER",finalDirection: "NOT_APPLICABLE",acceptedPass: "NONE",
    basisEvidenceUnitIds: [],reliedDimensionRevisionIds: [],proposedDimensionPatches: [],
    autoCommitOrdinaryMutation: false,ownerReviewRequired: input.protectedImpact,
    ruleCodes: ["PROFILE_VERDICT_INVALID",...profileErrors].sort(),policyVersion: MEMORY_NIGHT_REVIEW_POLICY_VERSION,
  };
  if (input.blindVerdict.relation !== "DEFER"
    && (input.blindVerdict.relation !== input.profileVerdict.relation
      || input.blindVerdict.direction !== input.profileVerdict.direction)) {
    return {
      caseId: input.caseId,finalRelation: "DEFER",finalDirection: "NOT_APPLICABLE",acceptedPass: "NONE",
      basisEvidenceUnitIds: [],reliedDimensionRevisionIds: [],proposedDimensionPatches: [],
      autoCommitOrdinaryMutation: false,ownerReviewRequired: input.protectedImpact,
      ruleCodes: ["BLIND_PROFILE_CONFLICT_DEFER"],policyVersion: MEMORY_NIGHT_REVIEW_POLICY_VERSION,
    };
  }
  return {
    caseId: input.caseId,finalRelation: input.profileVerdict.relation,finalDirection: input.profileVerdict.direction,
    acceptedPass: "PROFILE",basisEvidenceUnitIds: sortedUnique(input.profileVerdict.basisEvidenceUnitIds),
    reliedDimensionRevisionIds: sortedUnique(input.profileVerdict.reliedDimensionRevisionIds),
    proposedDimensionPatches: input.profileVerdict.proposedDimensionPatches,
    autoCommitOrdinaryMutation: !input.protectedImpact && !["DEFER","KEEP_DISPUTED"].includes(input.profileVerdict.relation),
    ownerReviewRequired: input.protectedImpact,
    ruleCodes: ["PROFILE_ASSISTANCE_CONFLICT_SAFE"],policyVersion: MEMORY_NIGHT_REVIEW_POLICY_VERSION,
  };
}

export async function persistNightReviewVerdict(input: {
  db: D1Database;
  packetId: string;
  pass: "BLIND" | "PROFILE";
  verdict: NightReviewVerdict;
  modelConfig: ReturnType<typeof nightReviewModelConfig>;
  inputHash: string;
  outputHash: string;
  createdAtUtc: string;
}): Promise<string> {
  const hash = await memoryArtifactHash("memory-night-review-verdict-artifact-v2", {
    packetId: input.packetId,pass: input.pass,verdict: input.verdict,modelConfig: input.modelConfig,
    inputHash: input.inputHash,outputHash: input.outputHash,
  });
  const verdictId = `nrv_${hash.slice(0,32)}`;
  await input.db.prepare(`INSERT OR IGNORE INTO memory_night_review_verdicts(
    verdict_id,case_id,packet_id,pass,relation,direction,basis_evidence_unit_ids_json,
    relied_dimension_revision_ids_json,profile_influence,proposed_dimension_patches_json,
    uncertainty_codes_json,reason_code,model_provider,model_model,prompt_version,schema_version,
    reasoning_config_json,input_hash,output_hash,policy_version,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    verdictId,input.verdict.caseId,input.packetId,input.pass,input.verdict.relation,input.verdict.direction,
    canonicalJson(input.verdict.basisEvidenceUnitIds),canonicalJson(input.verdict.reliedDimensionRevisionIds),
    input.verdict.profileInfluence,canonicalJson(input.verdict.proposedDimensionPatches),
    canonicalJson(input.verdict.uncertaintyCodes),input.verdict.reasonCode,input.modelConfig.provider,input.modelConfig.model,
    input.modelConfig.promptVersion,input.modelConfig.schemaVersion,canonicalJson(input.modelConfig.reasoningConfig),
    input.inputHash,input.outputHash,MEMORY_NIGHT_REVIEW_POLICY_VERSION,input.createdAtUtc,
  ).run();
  const stored = await input.db.prepare(`SELECT verdict_id,input_hash,output_hash FROM memory_night_review_verdicts
    WHERE case_id=? AND pass=?`).bind(input.verdict.caseId,input.pass)
    .first<{ verdict_id: string; input_hash: string; output_hash: string }>();
  if (!stored || stored.verdict_id !== verdictId || stored.input_hash !== input.inputHash || stored.output_hash !== input.outputHash) {
    throw new Error("memory_night_review_verdict_identity_mismatch");
  }
  return verdictId;
}

export async function persistNightReviewCasePackets(input: {
  db: D1Database;
  caseKind: "CLAIM_PAIR" | "DISPUTE" | "DEFERRED_COMPARISON" | "DIMENSION_CANDIDATE";
  blindPacket: BlindReviewPacket;
  profilePacket: ProfileReviewPacket;
  caseRootLineageIds: string[];
  predicateFamily: string;
  protectedImpact: boolean;
  openedTxnSeq: number;
  priority: number;
  disputeId?: string | null;
  scrubbedDimensions: Array<{ dimensionRevisionId: string; reasonCodes: string[] }>;
  createdAtUtc: string;
}): Promise<{ scrubArtifactId: string }> {
  if (input.blindPacket.caseId !== input.profilePacket.caseId
    || input.blindPacket.packetHash !== input.profilePacket.blindPacketHash) {
    throw new Error("memory_night_review_packet_chain_mismatch");
  }
  if (!Number.isSafeInteger(input.openedTxnSeq) || input.openedTxnSeq < 0) throw new Error("memory_night_review_opened_txn_invalid");
  const scrubCore = {
    caseId: input.blindPacket.caseId,snapshotId: input.blindPacket.snapshotId,
    caseRootLineageIds: sortedUnique(input.caseRootLineageIds),
    includedDimensionRevisionIds: input.profilePacket.includedDimensionRevisionIds,
    scrubbedDimensions: [...input.scrubbedDimensions].sort((left,right) => left.dimensionRevisionId.localeCompare(right.dimensionRevisionId)),
    policyVersion: MEMORY_NIGHT_REVIEW_POLICY_VERSION,
  };
  const scrubHash = await memoryArtifactHash("memory-night-review-scrub-artifact-v2",scrubCore);
  const scrubArtifactId = `nrsa_${scrubHash.slice(0,32)}`;
  const statements: D1PreparedStatement[] = [
    input.db.prepare(`INSERT OR IGNORE INTO memory_night_review_cases(
      case_id,case_kind,claim_a_id,claim_b_id,dispute_id,snapshot_id,opened_txn_seq,
      case_root_lineage_ids_json,predicate_family,protected_impact,priority,policy_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      input.blindPacket.caseId,input.caseKind,input.blindPacket.claimA.claimAtomId,input.blindPacket.claimB.claimAtomId,
      input.disputeId ?? null,input.blindPacket.snapshotId,input.openedTxnSeq,canonicalJson(scrubCore.caseRootLineageIds),
      input.predicateFamily,input.protectedImpact ? 1 : 0,input.priority,MEMORY_NIGHT_REVIEW_POLICY_VERSION,input.createdAtUtc,
    ),
    input.db.prepare(`INSERT OR IGNORE INTO memory_night_review_blind_packets(
      packet_id,case_id,snapshot_id,packet_json,allowed_decisions_json,contains_owner_model,packet_hash,created_at
    ) VALUES(?,?,?,?,?,0,?,?)`).bind(
      input.blindPacket.packetId,input.blindPacket.caseId,input.blindPacket.snapshotId,
      canonicalJson(input.blindPacket),canonicalJson(input.blindPacket.allowedDecisions),
      input.blindPacket.packetHash,input.createdAtUtc,
    ),
    input.db.prepare(`INSERT OR IGNORE INTO memory_night_review_scrub_artifacts(
      scrub_artifact_id,case_id,snapshot_id,case_root_lineage_ids_json,
      included_dimension_revision_ids_json,scrubbed_dimensions_json,scrub_hash,policy_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      scrubArtifactId,input.blindPacket.caseId,input.blindPacket.snapshotId,
      canonicalJson(scrubCore.caseRootLineageIds),canonicalJson(scrubCore.includedDimensionRevisionIds),
      canonicalJson(scrubCore.scrubbedDimensions),scrubHash,MEMORY_NIGHT_REVIEW_POLICY_VERSION,input.createdAtUtc,
    ),
    input.db.prepare(`INSERT OR IGNORE INTO memory_night_review_profile_packets(
      packet_id,case_id,blind_packet_hash,scrub_artifact_id,conflict_safe_context_json,
      included_dimension_revision_ids_json,scrubbed_dimension_revision_ids_json,conflict_safe,packet_hash,created_at
    ) VALUES(?,?,?,?,?,?,?,1,?,?)`).bind(
      input.profilePacket.packetId,input.profilePacket.caseId,input.profilePacket.blindPacketHash,scrubArtifactId,
      canonicalJson(input.profilePacket.conflictSafeDimensions),
      canonicalJson(input.profilePacket.includedDimensionRevisionIds),
      canonicalJson(input.profilePacket.scrubbedDimensionRevisionIds),input.profilePacket.packetHash,input.createdAtUtc,
    ),
  ];
  await input.db.batch(statements);
  const stored = await input.db.prepare(`SELECT c.snapshot_id,b.packet_hash,s.scrub_hash,p.packet_hash AS profile_packet_hash
    FROM memory_night_review_cases c
    JOIN memory_night_review_blind_packets b ON b.case_id=c.case_id
    JOIN memory_night_review_scrub_artifacts s ON s.case_id=c.case_id
    JOIN memory_night_review_profile_packets p ON p.case_id=c.case_id
    WHERE c.case_id=?`).bind(input.blindPacket.caseId).first<{
      snapshot_id: string; packet_hash: string; scrub_hash: string; profile_packet_hash: string;
    }>();
  if (!stored || stored.snapshot_id !== input.blindPacket.snapshotId || stored.packet_hash !== input.blindPacket.packetHash
    || stored.scrub_hash !== scrubHash || stored.profile_packet_hash !== input.profilePacket.packetHash) {
    throw new Error("memory_night_review_case_packet_identity_mismatch");
  }
  return { scrubArtifactId };
}

export async function persistNightReviewHarnessDecision(input: {
  db: D1Database;
  decision: NightReviewHarnessDecision;
  blindVerdictId: string;
  profileVerdictId: string | null;
  committedMutationCaseId?: string | null;
  createdAtUtc: string;
}): Promise<string> {
  const core = {
    decision: input.decision,blindVerdictId: input.blindVerdictId,
    profileVerdictId: input.profileVerdictId,committedMutationCaseId: input.committedMutationCaseId ?? null,
  };
  const decisionHash = await memoryArtifactHash("memory-night-review-harness-decision-v2",core);
  const decisionId = `nrhd_${decisionHash.slice(0,32)}`;
  await input.db.prepare(`INSERT OR IGNORE INTO memory_night_review_harness_decisions(
    decision_id,case_id,blind_verdict_id,profile_verdict_id,final_relation,final_direction,
    accepted_pass,basis_evidence_unit_ids_json,relied_dimension_revision_ids_json,
    proposed_dimension_patches_json,auto_commit_ordinary_mutation,owner_review_required,
    committed_mutation_case_id,rule_codes_json,decision_hash,policy_version,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    decisionId,input.decision.caseId,input.blindVerdictId,input.profileVerdictId,input.decision.finalRelation,
    input.decision.finalDirection,input.decision.acceptedPass,canonicalJson(input.decision.basisEvidenceUnitIds),
    canonicalJson(input.decision.reliedDimensionRevisionIds),canonicalJson(input.decision.proposedDimensionPatches),
    input.decision.autoCommitOrdinaryMutation ? 1 : 0,input.decision.ownerReviewRequired ? 1 : 0,
    input.committedMutationCaseId ?? null,canonicalJson(input.decision.ruleCodes),decisionHash,
    input.decision.policyVersion,input.createdAtUtc,
  ).run();
  const stored = await input.db.prepare(`SELECT decision_id,decision_hash FROM memory_night_review_harness_decisions
    WHERE case_id=?`).bind(input.decision.caseId).first<{ decision_id: string; decision_hash: string }>();
  if (!stored || stored.decision_id !== decisionId || stored.decision_hash !== decisionHash) {
    throw new Error("memory_night_review_harness_decision_identity_mismatch");
  }
  return decisionId;
}
