import { canonicalJson } from "../import/hashes";
import { memoryArtifactHash } from "./integrity";

export const MEMORY_OWNER_MODEL_POLICY_VERSION = "memory-owner-cognitive-model-v2.0.0";

export type OwnerDimensionFamily =
  | "identity_and_life_context"
  | "preference_and_taste"
  | "values_and_boundaries"
  | "reasoning_and_epistemic_style"
  | "decision_and_risk_style"
  | "communication_and_interaction"
  | "work_and_execution_style"
  | "learning_and_expertise"
  | "projects_and_goals"
  | "routine_and_environment"
  | "relationships_and_social"
  | "self_evaluation_and_trajectory";

export type OwnerDimensionInferencePolicy = "allow_pattern" | "explicit_only" | "never_infer";

export type OwnerDimensionRevision = {
  dimensionRevisionId: string;
  dimensionKey: string;
  revision: number;
  valueJson: unknown;
  assertionMode: "explicit" | "observed_pattern" | "inferred_hypothesis";
  epistemicStatus: "known" | "believed" | "disputed";
  stability: "episodic" | "recurrent" | "stable" | "trajectory";
  validFromUtc: string | null;
  validToUtc: string | null;
  supportGroupIds: string[];
  contradictionEdgeIds: string[];
  alternativeRevisionIds: string[];
  derivedFromDimensionRevisionIds: string[];
  rootLineageIds: string[];
  lineageClosureHash: string;
  txnFromSeq: number;
  txnToSeq: number | null;
  inferencePolicy: OwnerDimensionInferencePolicy;
  policyVersion: string;
  producerProvider: string | null;
  producerModel: string | null;
};

const families: readonly OwnerDimensionFamily[] = [
  "identity_and_life_context","preference_and_taste","values_and_boundaries",
  "reasoning_and_epistemic_style","decision_and_risk_style","communication_and_interaction",
  "work_and_execution_style","learning_and_expertise","projects_and_goals",
  "routine_and_environment","relationships_and_social","self_evaluation_and_trajectory",
];
const familySet = new Set<string>(families);

export function listOwnerDimensionFamilies(): OwnerDimensionFamily[] {
  return [...families];
}

export function ownerDimensionFamily(dimensionKey: string): OwnerDimensionFamily | null {
  const family = dimensionKey.split(".",1)[0];
  return familySet.has(family) ? family as OwnerDimensionFamily : null;
}

export function inferencePolicyForDimension(dimensionKey: string): OwnerDimensionInferencePolicy {
  const normalized = dimensionKey.normalize("NFKC").toLowerCase();
  if (/(?:permission|authorization|credential|secret|password|diagnosis|psychiatric_diagnosis|protected_identity)/.test(normalized)) {
    return "never_infer";
  }
  if (/(?:health|medical|psychological|sexuality|religion|ethnicity|political|biometric|precise_location)/.test(normalized)) {
    return "explicit_only";
  }
  const family = ownerDimensionFamily(normalized);
  if (family === "values_and_boundaries" || family === "relationships_and_social") return "explicit_only";
  return "allow_pattern";
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export async function materializeOwnerDimensionRevision(input: {
  dimensionKey: string;
  revision: number;
  valueJson: unknown;
  assertionMode: OwnerDimensionRevision["assertionMode"];
  epistemicStatus: OwnerDimensionRevision["epistemicStatus"];
  stability: OwnerDimensionRevision["stability"];
  validFromUtc: string | null;
  validToUtc: string | null;
  supportGroupIds: string[];
  contradictionEdgeIds?: string[];
  alternativeRevisionIds?: string[];
  derivedFromDimensionRevisionIds?: string[];
  rootLineageIds: string[];
  txnFromSeq: number;
  txnToSeq?: number | null;
  producerProvider?: string | null;
  producerModel?: string | null;
}): Promise<OwnerDimensionRevision> {
  const dimensionKey = input.dimensionKey.normalize("NFKC").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(dimensionKey) || !ownerDimensionFamily(dimensionKey)) {
    throw new Error("memory_owner_dimension_key_unregistered");
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("memory_owner_dimension_revision_invalid");
  if (!Number.isSafeInteger(input.txnFromSeq) || input.txnFromSeq < 1) throw new Error("memory_owner_dimension_txn_invalid");
  const inferencePolicy = inferencePolicyForDimension(dimensionKey);
  if (inferencePolicy === "never_infer") throw new Error("memory_owner_dimension_forbidden");
  if (inferencePolicy === "explicit_only" && input.assertionMode !== "explicit") {
    throw new Error("memory_owner_dimension_explicit_only");
  }
  if (input.assertionMode !== "explicit" && input.epistemicStatus === "known") {
    throw new Error("memory_owner_dimension_derived_cannot_be_known");
  }
  if (input.validFromUtc && input.validToUtc && Date.parse(input.validFromUtc) >= Date.parse(input.validToUtc)) {
    throw new Error("memory_owner_dimension_valid_time_invalid");
  }
  const supportGroupIds = sortedUnique(input.supportGroupIds);
  const rootLineageIds = sortedUnique(input.rootLineageIds);
  if (supportGroupIds.length === 0 || rootLineageIds.length === 0) {
    throw new Error("memory_owner_dimension_support_required");
  }
  const contradictionEdgeIds = sortedUnique(input.contradictionEdgeIds ?? []);
  const alternativeRevisionIds = sortedUnique(input.alternativeRevisionIds ?? []);
  const derivedFromDimensionRevisionIds = sortedUnique(input.derivedFromDimensionRevisionIds ?? []);
  const lineageClosureHash = await memoryArtifactHash("memory-owner-dimension-lineage-closure-v2", {
    rootLineageIds,derivedFromDimensionRevisionIds,
  });
  const core = {
    dimensionKey,revision: input.revision,valueJson: input.valueJson,assertionMode: input.assertionMode,
    epistemicStatus: input.epistemicStatus,stability: input.stability,validFromUtc: input.validFromUtc,
    validToUtc: input.validToUtc,supportGroupIds,contradictionEdgeIds,alternativeRevisionIds,
    derivedFromDimensionRevisionIds,rootLineageIds,lineageClosureHash,txnFromSeq: input.txnFromSeq,
    txnToSeq: input.txnToSeq ?? null,inferencePolicy,policyVersion: MEMORY_OWNER_MODEL_POLICY_VERSION,
    producerProvider: input.producerProvider ?? null,producerModel: input.producerModel ?? null,
  };
  const hash = await memoryArtifactHash("memory-owner-dimension-revision-v2",core);
  return { dimensionRevisionId: `odr_${hash.slice(0,32)}`,...core };
}

export type ConflictSafeDimension = {
  dimensionRevisionId: string;
  dimensionKey: string;
  predicateFamily: string;
  predicateFamilies?: string[];
  rootLineageIds: string[];
  derivedFromDimensionRevisionIds: string[];
  sensitiveOrProtectedMirror: boolean;
  valueJson: unknown;
  assertionMode: OwnerDimensionRevision["assertionMode"];
  epistemicStatus: OwnerDimensionRevision["epistemicStatus"];
};

export async function persistOwnerDimensionRevision(input: {
  db: D1Database;
  revision: OwnerDimensionRevision;
  factSupport: Array<{
    factRevisionId: string;
    supportGroupId: string | null;
    supportRole: "SUPPORT" | "CONTRADICTION" | "QUALIFICATION";
    rootLineageId: string;
  }>;
  createdAtUtc: string;
}): Promise<void> {
  const familyKey = ownerDimensionFamily(input.revision.dimensionKey);
  if (!familyKey) throw new Error("memory_owner_dimension_key_unregistered");
  if (input.factSupport.length === 0) throw new Error("memory_owner_dimension_fact_support_required");
  const supportGroups = new Set(input.revision.supportGroupIds);
  for (const link of input.factSupport) {
    if (link.supportRole === "SUPPORT" && (!link.supportGroupId || !supportGroups.has(link.supportGroupId))) {
      throw new Error("memory_owner_dimension_support_group_mismatch");
    }
    if (link.supportRole !== "SUPPORT" && link.supportGroupId !== null) {
      throw new Error("memory_owner_dimension_negative_support_group_forbidden");
    }
    if (!input.revision.rootLineageIds.includes(link.rootLineageId)) {
      throw new Error("memory_owner_dimension_root_lineage_mismatch");
    }
  }
  const statements: D1PreparedStatement[] = [input.db.prepare(`INSERT INTO memory_owner_dimension_revisions(
    dimension_revision_id,dimension_key,family_key,revision,value_json,assertion_mode,epistemic_status,
    stability,valid_from_utc,valid_to_utc,support_group_ids_json,contradiction_edge_ids_json,
    alternative_revision_ids_json,derived_from_dimension_revision_ids_json,root_lineage_ids_json,
    lineage_closure_hash,txn_from_seq,txn_to_seq,close_reason,inference_policy,policy_version,
    producer_provider,producer_model,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?)`).bind(
    input.revision.dimensionRevisionId,input.revision.dimensionKey,familyKey,input.revision.revision,
    canonicalJson(input.revision.valueJson),input.revision.assertionMode,input.revision.epistemicStatus,
    input.revision.stability,input.revision.validFromUtc,input.revision.validToUtc,
    canonicalJson(input.revision.supportGroupIds),canonicalJson(input.revision.contradictionEdgeIds),
    canonicalJson(input.revision.alternativeRevisionIds),canonicalJson(input.revision.derivedFromDimensionRevisionIds),
    canonicalJson(input.revision.rootLineageIds),input.revision.lineageClosureHash,input.revision.txnFromSeq,
    input.revision.inferencePolicy,input.revision.policyVersion,input.revision.producerProvider,
    input.revision.producerModel,input.createdAtUtc,
  )];
  for (const link of input.factSupport) {
    statements.push(input.db.prepare(`INSERT INTO memory_owner_dimension_fact_support(
      dimension_revision_id,fact_revision_id,support_group_id,support_role,root_lineage_id,created_at
    ) VALUES(?,?,?,?,?,?)`).bind(
      input.revision.dimensionRevisionId,link.factRevisionId,link.supportGroupId,link.supportRole,
      link.rootLineageId,input.createdAtUtc,
    ));
    const dependencyHash = await memoryArtifactHash("memory-owner-dimension-fact-dependency-v2", {
      factRevisionId: link.factRevisionId,dimensionRevisionId: input.revision.dimensionRevisionId,
      supportRole: link.supportRole,rootLineageId: link.rootLineageId,
    });
    statements.push(input.db.prepare(`INSERT INTO memory_lineage_dependency_edges(
      dependency_edge_id,from_node_kind,from_node_id,to_node_kind,to_node_id,
      txn_from_seq,txn_to_seq,close_reason,policy_version,created_at
    ) VALUES(?,'fact_revision',?,'owner_dimension_revision',?,?,NULL,NULL,?,?)`).bind(
      `lde_${dependencyHash.slice(0,32)}`,link.factRevisionId,input.revision.dimensionRevisionId,
      input.revision.txnFromSeq,input.revision.policyVersion,input.createdAtUtc,
    ));
  }
  for (const parentId of input.revision.derivedFromDimensionRevisionIds) {
    const dependencyHash = await memoryArtifactHash("memory-owner-dimension-derived-dependency-v2", {
      parentId,dimensionRevisionId: input.revision.dimensionRevisionId,
    });
    statements.push(input.db.prepare(`INSERT INTO memory_lineage_dependency_edges(
      dependency_edge_id,from_node_kind,from_node_id,to_node_kind,to_node_id,
      txn_from_seq,txn_to_seq,close_reason,policy_version,created_at
    ) VALUES(?,'owner_dimension_revision',?,'owner_dimension_revision',?,?,NULL,NULL,?,?)`).bind(
      `lde_${dependencyHash.slice(0,32)}`,parentId,input.revision.dimensionRevisionId,
      input.revision.txnFromSeq,input.revision.policyVersion,input.createdAtUtc,
    ));
  }
  await input.db.batch(statements);
}

export function scrubOwnerContext(input: {
  dimensions: ConflictSafeDimension[];
  caseRootLineageIds: string[];
  casePredicateFamily: string;
}): {
  included: ConflictSafeDimension[];
  scrubbed: Array<{ dimensionRevisionId: string; reasonCodes: string[] }>;
} {
  const roots = new Set(sortedUnique(input.caseRootLineageIds));
  const byId = new Map(input.dimensions.map((dimension) => [dimension.dimensionRevisionId,dimension]));
  if (byId.size !== input.dimensions.length) throw new Error("memory_owner_dimension_duplicate");
  const scrubbed = new Map<string,Set<string>>();
  const add = (id: string,reason: string) => {
    const reasons = scrubbed.get(id) ?? new Set<string>();
    reasons.add(reason);
    scrubbed.set(id,reasons);
  };
  for (const dimension of input.dimensions) {
    if (dimension.rootLineageIds.some((root) => roots.has(root))) add(dimension.dimensionRevisionId,"CASE_ROOT_LINEAGE_OVERLAP");
    const predicateFamilies = new Set([dimension.predicateFamily,...(dimension.predicateFamilies ?? [])]);
    if (predicateFamilies.has(input.casePredicateFamily)) add(dimension.dimensionRevisionId,"SAME_PREDICATE_FAMILY");
    if (dimension.sensitiveOrProtectedMirror) add(dimension.dimensionRevisionId,"SENSITIVE_OR_PROTECTED_MIRROR");
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const dimension of input.dimensions) {
      if (scrubbed.has(dimension.dimensionRevisionId)) continue;
      if (dimension.derivedFromDimensionRevisionIds.some((parent) => scrubbed.has(parent))) {
        add(dimension.dimensionRevisionId,"DESCENDANT_OF_SCRUBBED_DIMENSION");
        changed = true;
      }
    }
  }
  return {
    included: input.dimensions.filter((dimension) => !scrubbed.has(dimension.dimensionRevisionId))
      .sort((left,right) => left.dimensionRevisionId.localeCompare(right.dimensionRevisionId)),
    scrubbed: [...scrubbed.entries()].map(([dimensionRevisionId,reasons]) => ({
      dimensionRevisionId,reasonCodes: [...reasons].sort(),
    })).sort((left,right) => left.dimensionRevisionId.localeCompare(right.dimensionRevisionId)),
  };
}

export type OwnerModelSnapshot = {
  snapshotId: string;
  snapshotOrdinal: number;
  baseTxnSeq: number;
  priorSnapshotId: string | null;
  dimensionRevisionIds: string[];
  snapshotHash: string;
  policyVersion: string;
};

export async function buildOwnerModelSnapshot(input: {
  snapshotOrdinal: number;
  baseTxnSeq: number;
  priorSnapshotId: string | null;
  dimensions: OwnerDimensionRevision[];
}): Promise<OwnerModelSnapshot> {
  if (!Number.isSafeInteger(input.snapshotOrdinal) || input.snapshotOrdinal < 1) throw new Error("memory_owner_snapshot_ordinal_invalid");
  if (!Number.isSafeInteger(input.baseTxnSeq) || input.baseTxnSeq < 0) throw new Error("memory_owner_snapshot_txn_invalid");
  const dimensionRevisionIds = input.dimensions
    .filter((dimension) => dimension.txnFromSeq <= input.baseTxnSeq
      && (dimension.txnToSeq === null || dimension.txnToSeq > input.baseTxnSeq))
    .map((dimension) => dimension.dimensionRevisionId).sort();
  const core = {
    snapshotOrdinal: input.snapshotOrdinal,baseTxnSeq: input.baseTxnSeq,
    priorSnapshotId: input.priorSnapshotId,dimensionRevisionIds,policyVersion: MEMORY_OWNER_MODEL_POLICY_VERSION,
  };
  const snapshotHash = await memoryArtifactHash("memory-owner-model-snapshot-v2",core);
  return { snapshotId: `ocms_${snapshotHash.slice(0,32)}`,...core,snapshotHash };
}

export async function persistOwnerModelSnapshot(input: {
  db: D1Database;
  snapshot: OwnerModelSnapshot;
  createdAtUtc: string;
}): Promise<void> {
  const statements: D1PreparedStatement[] = [input.db.prepare(`INSERT INTO memory_owner_model_snapshots(
    snapshot_id,snapshot_ordinal,base_txn_seq,prior_snapshot_id,status,snapshot_hash,policy_version,created_at
  ) VALUES(?,?,?,?,'FROZEN',?,?,?)`).bind(
    input.snapshot.snapshotId,input.snapshot.snapshotOrdinal,input.snapshot.baseTxnSeq,input.snapshot.priorSnapshotId,
    input.snapshot.snapshotHash,input.snapshot.policyVersion,input.createdAtUtc,
  )];
  input.snapshot.dimensionRevisionIds.forEach((dimensionRevisionId,index) => statements.push(
    input.db.prepare(`INSERT INTO memory_owner_model_snapshot_members(
      snapshot_id,dimension_revision_id,ordinal,member_role,created_at
    ) VALUES(?,?,?,'active',?)`).bind(input.snapshot.snapshotId,dimensionRevisionId,index,input.createdAtUtc),
  ));
  await input.db.batch(statements);
}

export async function buildOwnerPortraitRender(input: {
  snapshotId: string;
  purpose: string;
  budgetTokens: number;
  content: string;
}): Promise<{
  renderId: string;
  snapshotId: string;
  purpose: string;
  budgetTokens: number;
  content: string;
  contentHash: string;
  evidenceEligible: false;
}> {
  if (!input.purpose.trim()) throw new Error("memory_owner_portrait_purpose_required");
  if (!Number.isSafeInteger(input.budgetTokens) || input.budgetTokens < 1) throw new Error("memory_owner_portrait_budget_invalid");
  const content = input.content.trim();
  if (!content) throw new Error("memory_owner_portrait_content_required");
  const contentHash = await memoryArtifactHash("memory-owner-portrait-content-v2",content);
  const hash = await memoryArtifactHash("memory-owner-portrait-render-v2", {
    snapshotId: input.snapshotId,purpose: input.purpose,budgetTokens: input.budgetTokens,contentHash,
  });
  return {
    renderId: `ocmr_${hash.slice(0,32)}`,snapshotId: input.snapshotId,purpose: input.purpose,
    budgetTokens: input.budgetTokens,content,contentHash,evidenceEligible: false,
  };
}

export async function persistOwnerPortraitRender(input: {
  db: D1Database;
  render: Awaited<ReturnType<typeof buildOwnerPortraitRender>>;
  createdAtUtc: string;
}): Promise<void> {
  if (input.render.evidenceEligible !== false) throw new Error("memory_owner_portrait_evidence_forbidden");
  await input.db.prepare(`INSERT INTO memory_owner_portrait_renders(
    render_id,snapshot_id,purpose,budget_tokens,content,content_hash,source_type,evidence_eligible,created_at
  ) VALUES(?,?,?,?,?,?,'interpretation_only',0,?)`).bind(
    input.render.renderId,input.render.snapshotId,input.render.purpose,input.render.budgetTokens,
    input.render.content,input.render.contentHash,input.createdAtUtc,
  ).run();
}

export function serializeConflictSafeOwnerContext(dimensions: ConflictSafeDimension[]): string {
  return canonicalJson(dimensions.map((dimension) => ({
    dimensionRevisionId: dimension.dimensionRevisionId,dimensionKey: dimension.dimensionKey,
    valueJson: dimension.valueJson,assertionMode: dimension.assertionMode,epistemicStatus: dimension.epistemicStatus,
  })));
}
