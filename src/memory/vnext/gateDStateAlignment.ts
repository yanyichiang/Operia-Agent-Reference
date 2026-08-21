import { memoryArtifactHash } from "./integrity";
import {
  revisionContainsTime,
  revisionOverlapsInterval,
  type FactRevisionRelation,
  type IntrinsicRevisionSnapshotMember,
  type StatefulFactRevision,
} from "./gateCIntrinsicState";

export const MEMORY_VNEXT_GATE_D_EXPANSION_VERSION = "memory-revision-expansion-d1";
export const MEMORY_VNEXT_GATE_D_PROJECTION_VERSION = "memory-query-state-projection-d1";
export const MEMORY_VNEXT_DEFAULT_REVISION_HOP_LIMIT = 2;
export const MEMORY_VNEXT_DEFAULT_REVISION_CANDIDATE_CAP = 16;

export const MEMORY_STATE_ALIGNMENT_FLAG_NAMES = {
  projectionShadow: "memory_state_projection_shadow",
  revisionExpansionShadow: "memory_revision_expansion_shadow",
  statePacketShadow: "memory_state_packet_shadow",
  statePacketInject: "memory_state_packet_inject",
} as const;

export type RequestedStateView = "current" | "historical" | "change" | "unspecified";

export type TemporalTarget = {
  requestedStateView: RequestedStateView;
  referenceTimeUtc: string;
  ownerTimeZone: string;
  targetValidFromUtc: string | null;
  targetValidToUtc: string | null;
  targetTimePrecision: "exact" | "day" | "month" | "year" | "bounded" | "unknown";
  basis: "query_explicit" | "relative_time_resolved" | "current_request_time" | "unspecified";
};

export type StateAlignmentCandidate = {
  candidateRef: string;
  revision: StatefulFactRevision;
  intrinsicSnapshotMember: IntrinsicRevisionSnapshotMember;
  namespace: string;
  authorityBoundary: string;
  protectedVisibility: string;
  sensitivity: "normal" | "secret";
  purged: boolean;
};

export type RevisionExpansionArtifact = {
  artifactId: string;
  runId: string;
  queryPlanHash: string;
  txnSnapshotSeq: number;
  requestedStateView: RequestedStateView;
  seedCandidateRefs: string[];
  traversedRelations: Array<{
    relationId: string;
    relation: FactRevisionRelation["relation"];
    fromRevisionId: string;
    toRevisionId: string;
    direction: "forward" | "backward";
    rootSeedRef: string;
    ruleCode: string;
  }>;
  addedCandidates: Array<{
    candidateRef: string;
    sourceRevision: number;
    rootSeedRef: string;
    relationId: string;
    expansionReason:
      | "active_successor"
      | "historical_predecessor"
      | "transition_endpoint"
      | "scope_exception"
      | "merge_split_peer"
      | "material_contradiction";
    deterministicFloor: boolean;
  }>;
  omittedCandidates: Array<{
    candidateRef: string;
    reason:
      | "hop_limit"
      | "candidate_cap"
      | "scope_mismatch"
      | "time_mismatch"
      | "source_missing"
      | "privacy_boundary"
      | "deleted_or_purged";
  }>;
  hopLimit: number;
  candidateCap: number;
  completeness:
    | "complete_within_policy"
    | "truncated_by_hop_limit"
    | "truncated_by_candidate_cap"
    | "source_incomplete";
  expansionVersion: string;
  artifactHash: string;
  createdAtUtc: string;
};

export type QueryStateProjection = {
  projectionId: string;
  runId: string;
  queryPlanHash: string;
  txnSnapshotSeq: number;
  candidateRef: string;
  sourceRevision: number;
  claimAtomId: string | null;
  requestedStateView: RequestedStateView;
  intrinsicLifecycleStatus: StatefulFactRevision["lifecycleStatus"];
  intrinsicEpistemicStatus: StatefulFactRevision["epistemicStatus"];
  queryRole: "primary" | "contrast" | "trajectory" | "context" | "exclude";
  evidencePolarity: "supports" | "contradicts" | "qualifies" | "neutral";
  validTimeFit: "exact_match" | "overlap" | "mismatch" | "unknown" | "not_applicable";
  roleBasisRevisionIds: string[];
  roleBasisRelationIds: string[];
  ruleCodes: string[];
  projectionVersion: string;
  artifactHash: string;
  createdAtUtc: string;
};

type ExpansionEdge =
  | {
    kind: "relation";
    relation: FactRevisionRelation;
    direction: "forward" | "backward";
    neighborRef: string;
  }
  | {
    kind: "contradiction";
    contradictionId: string;
    direction: "forward" | "backward";
    neighborRef: string;
  };

export function buildTemporalTarget(input: {
  temporalIntent: RequestedStateView;
  referenceTimeUtc: string;
  ownerTimeZone: string;
  targetValidFromUtc?: string | null;
  targetValidToUtc?: string | null;
  targetTimePrecision?: TemporalTarget["targetTimePrecision"];
  basis?: TemporalTarget["basis"];
}): TemporalTarget {
  if (!Number.isFinite(Date.parse(input.referenceTimeUtc))) throw new Error("memory_temporal_reference_invalid");
  if (!input.ownerTimeZone.trim()) throw new Error("memory_owner_timezone_required");
  const targetValidFromUtc = input.targetValidFromUtc ?? null;
  const targetValidToUtc = input.targetValidToUtc ?? null;
  if ((targetValidFromUtc === null) !== (targetValidToUtc === null)) {
    throw new Error("memory_temporal_target_half_interval_forbidden");
  }
  if (targetValidFromUtc !== null && (
    !Number.isFinite(Date.parse(targetValidFromUtc))
    || !Number.isFinite(Date.parse(targetValidToUtc ?? ""))
    || Date.parse(targetValidFromUtc) >= Date.parse(targetValidToUtc ?? "")
  )) throw new Error("memory_temporal_target_interval_invalid");
  if (input.temporalIntent === "historical" && targetValidFromUtc === null) {
    return {
      requestedStateView: "historical",
      referenceTimeUtc: input.referenceTimeUtc,
      ownerTimeZone: input.ownerTimeZone,
      targetValidFromUtc: null,
      targetValidToUtc: null,
      targetTimePrecision: "unknown",
      basis: "unspecified",
    };
  }
  return {
    requestedStateView: input.temporalIntent,
    referenceTimeUtc: input.referenceTimeUtc,
    ownerTimeZone: input.ownerTimeZone,
    targetValidFromUtc,
    targetValidToUtc,
    targetTimePrecision: input.targetTimePrecision ?? (targetValidFromUtc === null ? "unknown" : "bounded"),
    basis: input.basis ?? (input.temporalIntent === "current" ? "current_request_time" : "unspecified"),
  };
}

function expansionDirections(view: RequestedStateView): ReadonlySet<"forward" | "backward"> {
  if (view === "current" || view === "unspecified") return new Set(["forward"]);
  return new Set(["forward", "backward"]);
}

function candidateVisibleAtSnapshot(candidate: StateAlignmentCandidate, txnSnapshotSeq: number): boolean {
  return candidate.revision.txnFromSeq <= txnSnapshotSeq
    && (candidate.revision.txnToSeq === null || txnSnapshotSeq < candidate.revision.txnToSeq);
}

function boundaryReason(root: StateAlignmentCandidate, candidate: StateAlignmentCandidate, txnSnapshotSeq: number): RevisionExpansionArtifact["omittedCandidates"][number]["reason"] | null {
  if (!candidateVisibleAtSnapshot(candidate, txnSnapshotSeq)) return "time_mismatch";
  if (candidate.purged || candidate.revision.lifecycleStatus === "deleted") return "deleted_or_purged";
  if (
    candidate.sensitivity === "secret"
    || candidate.namespace !== root.namespace
    || candidate.authorityBoundary !== root.authorityBoundary
    || candidate.protectedVisibility !== root.protectedVisibility
  ) return "privacy_boundary";
  if (
    candidate.revision.claimAtom.subject !== root.revision.claimAtom.subject
    || candidate.revision.claimAtom.predicate !== root.revision.claimAtom.predicate
  ) return "scope_mismatch";
  return null;
}

function expansionReason(
  view: RequestedStateView,
  direction: "forward" | "backward",
  relation: FactRevisionRelation["relation"],
): RevisionExpansionArtifact["addedCandidates"][number]["expansionReason"] {
  if (relation === "SCOPE_CLARIFICATION") return "scope_exception";
  if (relation === "MERGES" || relation === "SPLITS") return "merge_split_peer";
  if (view === "change") return "transition_endpoint";
  return direction === "forward" ? "active_successor" : "historical_predecessor";
}

export async function buildRevisionExpansionArtifact(input: {
  runId: string;
  queryPlanHash: string;
  txnSnapshotSeq: number;
  temporalTarget: TemporalTarget;
  seedCandidateRefs: readonly string[];
  candidates: readonly StateAlignmentCandidate[];
  relations: readonly FactRevisionRelation[];
  materialContradictions?: readonly {
    contradictionId: string;
    leftRevisionId: string;
    rightRevisionId: string;
  }[];
  hopLimit?: number;
  candidateCap?: number;
  createdAtUtc: string;
}): Promise<RevisionExpansionArtifact> {
  const hopLimit = input.hopLimit ?? MEMORY_VNEXT_DEFAULT_REVISION_HOP_LIMIT;
  const candidateCap = input.candidateCap ?? MEMORY_VNEXT_DEFAULT_REVISION_CANDIDATE_CAP;
  if (!Number.isSafeInteger(hopLimit) || hopLimit < 0 || hopLimit > 8) throw new Error("memory_revision_hop_limit_invalid");
  if (!Number.isSafeInteger(candidateCap) || candidateCap < 1 || candidateCap > 128) throw new Error("memory_revision_candidate_cap_invalid");
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.candidateRef, candidate]));
  const activeRelations = input.relations
    .filter((relation) => relation.txnFromSeq <= input.txnSnapshotSeq && (relation.txnToSeq === null || input.txnSnapshotSeq < relation.txnToSeq))
    .sort((left, right) => left.relationId.localeCompare(right.relationId));
  const seedCandidateRefs = [...new Set(input.seedCandidateRefs)].sort();
  const traversedRelations: RevisionExpansionArtifact["traversedRelations"] = [];
  const addedCandidates: RevisionExpansionArtifact["addedCandidates"] = [];
  const omittedCandidates: RevisionExpansionArtifact["omittedCandidates"] = [];
  const directions = expansionDirections(input.temporalTarget.requestedStateView);

  for (const rootSeedRef of seedCandidateRefs) {
    const root = candidateById.get(rootSeedRef);
    if (!root) {
      omittedCandidates.push({ candidateRef: rootSeedRef, reason: "source_missing" });
      continue;
    }
    if (!candidateVisibleAtSnapshot(root, input.txnSnapshotSeq)) {
      omittedCandidates.push({ candidateRef: rootSeedRef, reason: "time_mismatch" });
      continue;
    }
    const visited = new Set([rootSeedRef]);
    const queue: Array<{ candidateRef: string; hop: number }> = [{ candidateRef: rootSeedRef, hop: 0 }];
    let addedForRoot = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      const relationEdges: ExpansionEdge[] = activeRelations.flatMap((relation): ExpansionEdge[] => {
        const matches: Array<{ direction: "forward" | "backward"; neighborRef: string }> = [];
        if (directions.has("forward") && relation.fromRevisionId === current.candidateRef) {
          matches.push({ direction: "forward", neighborRef: relation.toRevisionId });
        }
        if (directions.has("backward") && relation.toRevisionId === current.candidateRef) {
          matches.push({ direction: "backward", neighborRef: relation.fromRevisionId });
        }
        return matches.map((match) => ({ kind: "relation" as const, relation, ...match }));
      });
      const contradictionEdges: ExpansionEdge[] = [];
      for (const contradiction of input.materialContradictions ?? []) {
        if (contradiction.leftRevisionId === current.candidateRef) {
          contradictionEdges.push({ kind: "contradiction", contradictionId: contradiction.contradictionId, neighborRef: contradiction.rightRevisionId, direction: "forward" });
        }
        if (contradiction.rightRevisionId === current.candidateRef) {
          contradictionEdges.push({ kind: "contradiction", contradictionId: contradiction.contradictionId, neighborRef: contradiction.leftRevisionId, direction: "backward" });
        }
      }
      const edges = [...relationEdges, ...contradictionEdges].sort((left, right) => {
        const leftId = left.kind === "relation" ? left.relation.relationId : left.contradictionId;
        const rightId = right.kind === "relation" ? right.relation.relationId : right.contradictionId;
        return leftId.localeCompare(rightId) || left.neighborRef.localeCompare(right.neighborRef);
      });
      for (const edge of edges) {
        if (visited.has(edge.neighborRef)) continue;
        if (current.hop >= hopLimit) {
          omittedCandidates.push({ candidateRef: edge.neighborRef, reason: "hop_limit" });
          continue;
        }
        const candidate = candidateById.get(edge.neighborRef);
        if (!candidate) {
          omittedCandidates.push({ candidateRef: edge.neighborRef, reason: "source_missing" });
          continue;
        }
        const blocked = boundaryReason(root, candidate, input.txnSnapshotSeq);
        if (blocked) {
          omittedCandidates.push({ candidateRef: edge.neighborRef, reason: blocked });
          continue;
        }
        if (addedForRoot >= candidateCap) {
          omittedCandidates.push({ candidateRef: edge.neighborRef, reason: "candidate_cap" });
          continue;
        }
        visited.add(edge.neighborRef);
        addedForRoot += 1;
        if (edge.kind === "relation") {
          traversedRelations.push({
            relationId: edge.relation.relationId,
            relation: edge.relation.relation,
            fromRevisionId: edge.relation.fromRevisionId,
            toRevisionId: edge.relation.toRevisionId,
            direction: edge.direction,
            rootSeedRef,
            ruleCode: `STRONG_${edge.relation.relation}`,
          });
        }
        addedCandidates.push({
          candidateRef: candidate.candidateRef,
          sourceRevision: candidate.revision.revision,
          rootSeedRef,
          relationId: edge.kind === "relation" ? edge.relation.relationId : edge.contradictionId,
          expansionReason: edge.kind === "relation"
            ? expansionReason(input.temporalTarget.requestedStateView, edge.direction, edge.relation.relation)
            : "material_contradiction",
          deterministicFloor: true,
        });
        queue.push({ candidateRef: candidate.candidateRef, hop: current.hop + 1 });
      }
    }
  }
  const uniqueOmissions = [...new Map(
    omittedCandidates.map((item) => [`${item.candidateRef}:${item.reason}`, item]),
  ).values()].sort((left, right) => left.candidateRef.localeCompare(right.candidateRef) || left.reason.localeCompare(right.reason));
  const completeness: RevisionExpansionArtifact["completeness"] = uniqueOmissions.some((item) => item.reason === "source_missing")
    ? "source_incomplete"
    : uniqueOmissions.some((item) => item.reason === "candidate_cap")
      ? "truncated_by_candidate_cap"
      : uniqueOmissions.some((item) => item.reason === "hop_limit")
        ? "truncated_by_hop_limit"
        : "complete_within_policy";
  const body = {
    runId: input.runId,
    queryPlanHash: input.queryPlanHash,
    txnSnapshotSeq: input.txnSnapshotSeq,
    requestedStateView: input.temporalTarget.requestedStateView,
    seedCandidateRefs,
    traversedRelations,
    addedCandidates,
    omittedCandidates: uniqueOmissions,
    hopLimit,
    candidateCap,
    completeness,
    expansionVersion: MEMORY_VNEXT_GATE_D_EXPANSION_VERSION,
  };
  const artifactHash = await memoryArtifactHash("memory-revision-expansion", body);
  return {
    artifactId: `expansion_${artifactHash.slice(0, 32)}`,
    ...body,
    artifactHash,
    createdAtUtc: input.createdAtUtc,
  };
}

function validTimeFit(
  revision: StatefulFactRevision,
  target: TemporalTarget,
): QueryStateProjection["validTimeFit"] {
  if (target.requestedStateView === "change") return "not_applicable";
  if (target.requestedStateView === "historical") {
    const overlap = revisionOverlapsInterval(revision, target.targetValidFromUtc, target.targetValidToUtc);
    if (overlap === null) return "unknown";
    if (!overlap) return "mismatch";
    return revision.validFromUtc === target.targetValidFromUtc && revision.validToUtc === target.targetValidToUtc
      ? "exact_match"
      : "overlap";
  }
  const contains = revisionContainsTime(revision, target.referenceTimeUtc);
  return contains === null ? "unknown" : contains ? "exact_match" : "mismatch";
}

function projectionRole(input: {
  candidate: StateAlignmentCandidate;
  temporalTarget: TemporalTarget;
  validTimeFit: QueryStateProjection["validTimeFit"];
  seedCandidateRefs: ReadonlySet<string>;
  relationIds: readonly string[];
}): { queryRole: QueryStateProjection["queryRole"]; ruleCodes: string[] } {
  const revision = input.candidate.revision;
  const sufficient = input.candidate.intrinsicSnapshotMember.supportCoverage.sufficient;
  if (input.candidate.purged || revision.lifecycleStatus === "deleted" || revision.lifecycleStatus === "retracted") {
    return { queryRole: "exclude", ruleCodes: [input.candidate.purged ? "SOURCE_PURGED" : "INTRINSICALLY_INACTIVE"] };
  }
  if (!sufficient) return { queryRole: "exclude", ruleCodes: ["EVIDENCE_COVERAGE_INSUFFICIENT"] };
  if (input.temporalTarget.requestedStateView === "current") {
    if (revision.lifecycleStatus === "current" && input.validTimeFit !== "mismatch") {
      return { queryRole: "primary", ruleCodes: ["CURRENT_ACTIVE_MATCH"] };
    }
    if (revision.lifecycleStatus === "historical" || revision.lifecycleStatus === "superseded") {
      return { queryRole: input.relationIds.length > 0 ? "trajectory" : "contrast", ruleCodes: ["CURRENT_HISTORICAL_CONTRAST"] };
    }
    return { queryRole: "exclude", ruleCodes: ["CURRENT_VIEW_MISMATCH"] };
  }
  if (input.temporalTarget.requestedStateView === "historical") {
    if (input.validTimeFit === "exact_match" || input.validTimeFit === "overlap") {
      return { queryRole: "primary", ruleCodes: ["HISTORICAL_TARGET_MATCH"] };
    }
    if (revision.lifecycleStatus === "current") return { queryRole: "contrast", ruleCodes: ["HISTORICAL_SUCCESSOR_CONTRAST"] };
    return { queryRole: input.validTimeFit === "unknown" ? "context" : "exclude", ruleCodes: [input.validTimeFit === "unknown" ? "HISTORICAL_TARGET_UNKNOWN" : "HISTORICAL_TIME_MISMATCH"] };
  }
  if (input.temporalTarget.requestedStateView === "change") {
    return input.relationIds.length > 0
      ? { queryRole: "trajectory", ruleCodes: ["CHANGE_RELATION_ENDPOINT"] }
      : { queryRole: "context", ruleCodes: ["CHANGE_UNRELATED_CONTEXT"] };
  }
  if (revision.lifecycleStatus === "current") return { queryRole: "primary", ruleCodes: ["UNSPECIFIED_CURRENT_DEFAULT"] };
  if (input.seedCandidateRefs.has(input.candidate.candidateRef) || input.relationIds.length > 0) {
    return { queryRole: input.relationIds.length > 0 ? "trajectory" : "contrast", ruleCodes: ["UNSPECIFIED_MATERIAL_HISTORY"] };
  }
  return { queryRole: "exclude", ruleCodes: ["UNSPECIFIED_NONMATERIAL_HISTORY"] };
}

export async function buildQueryStateProjection(input: {
  runId: string;
  queryPlanHash: string;
  txnSnapshotSeq: number;
  temporalTarget: TemporalTarget;
  candidate: StateAlignmentCandidate;
  seedCandidateRefs: readonly string[];
  relations: readonly FactRevisionRelation[];
  createdAtUtc: string;
}): Promise<QueryStateProjection> {
  if (!candidateVisibleAtSnapshot(input.candidate, input.txnSnapshotSeq)) {
    throw new Error("memory_state_projection_candidate_snapshot_mismatch");
  }
  if (
    input.candidate.intrinsicSnapshotMember.factRevisionId !== input.candidate.revision.factRevisionId
    || input.candidate.intrinsicSnapshotMember.revision !== input.candidate.revision.revision
    || input.candidate.intrinsicSnapshotMember.lifecycleStatus !== input.candidate.revision.lifecycleStatus
    || input.candidate.intrinsicSnapshotMember.epistemicStatus !== input.candidate.revision.epistemicStatus
  ) throw new Error("memory_state_projection_intrinsic_member_mismatch");
  const relationIds = input.relations
    .filter((relation) => relation.txnFromSeq <= input.txnSnapshotSeq
      && (relation.txnToSeq === null || input.txnSnapshotSeq < relation.txnToSeq)
      && (relation.fromRevisionId === input.candidate.candidateRef || relation.toRevisionId === input.candidate.candidateRef))
    .map((relation) => relation.relationId)
    .sort();
  const fit = validTimeFit(input.candidate.revision, input.temporalTarget);
  const role = projectionRole({
    candidate: input.candidate,
    temporalTarget: input.temporalTarget,
    validTimeFit: fit,
    seedCandidateRefs: new Set(input.seedCandidateRefs),
    relationIds,
  });
  const coverage = input.candidate.intrinsicSnapshotMember.supportCoverage;
  const evidencePolarity: QueryStateProjection["evidencePolarity"] = input.candidate.revision.epistemicStatus === "disputed"
    ? "qualifies"
    : !coverage.sufficient && coverage.activeContradictionEdgeIds.length > 0
      ? "contradicts"
      : coverage.sufficient
        ? "supports"
        : "neutral";
  const body = {
    runId: input.runId,
    queryPlanHash: input.queryPlanHash,
    txnSnapshotSeq: input.txnSnapshotSeq,
    candidateRef: input.candidate.candidateRef,
    sourceRevision: input.candidate.revision.revision,
    claimAtomId: input.candidate.revision.factKey,
    requestedStateView: input.temporalTarget.requestedStateView,
    intrinsicLifecycleStatus: input.candidate.revision.lifecycleStatus,
    intrinsicEpistemicStatus: input.candidate.revision.epistemicStatus,
    queryRole: role.queryRole,
    evidencePolarity,
    validTimeFit: fit,
    roleBasisRevisionIds: [input.candidate.candidateRef],
    roleBasisRelationIds: relationIds,
    ruleCodes: role.ruleCodes,
    projectionVersion: MEMORY_VNEXT_GATE_D_PROJECTION_VERSION,
  };
  const artifactHash = await memoryArtifactHash("memory-query-state-projection", body);
  return {
    projectionId: `projection_${artifactHash.slice(0, 32)}`,
    ...body,
    artifactHash,
    createdAtUtc: input.createdAtUtc,
  };
}

export function assertDeterministicFloorPreserved(
  expansion: RevisionExpansionArtifact,
  retainedCandidateRefs: readonly string[],
): void {
  const retained = new Set(retainedCandidateRefs);
  const missing = expansion.addedCandidates
    .filter((candidate) => candidate.deterministicFloor && !retained.has(candidate.candidateRef))
    .map((candidate) => candidate.candidateRef)
    .sort();
  if (missing.length > 0) throw new Error(`memory_deterministic_floor_removed:${missing.join(",")}`);
}

export type StateAlignmentInspectorRecord = {
  runId: string;
  queryPlanHash: string;
  txnSnapshotSeq: number;
  temporalTarget: TemporalTarget;
  expansionArtifactId: string | null;
  expansionCompleteness: RevisionExpansionArtifact["completeness"] | null;
  projectionIds: string[];
  shadowOnly: boolean;
};

export async function readStateAlignmentInspector(db: D1Database, runId: string): Promise<StateAlignmentInspectorRecord | null> {
  const run = await db.prepare(
    `SELECT run_id,query_plan_hash,txn_snapshot_seq,requested_state_view,reference_time_utc,owner_time_zone,
      target_valid_from_utc,target_valid_to_utc,target_time_precision,basis
     FROM memory_temporal_targets WHERE run_id=?`,
  ).bind(runId).first<Record<string, unknown>>();
  if (!run) return null;
  const expansion = await db.prepare(
    `SELECT artifact_id,completeness,shadow_only FROM memory_revision_expansion_artifacts
     WHERE run_id=? ORDER BY created_at DESC LIMIT 1`,
  ).bind(runId).first<Record<string, unknown>>();
  const projections = await db.prepare(
    `SELECT projection_id FROM memory_query_state_projections WHERE run_id=? ORDER BY projection_id`,
  ).bind(runId).all<Record<string, unknown>>();
  return {
    runId: String(run.run_id),
    queryPlanHash: String(run.query_plan_hash),
    txnSnapshotSeq: Number(run.txn_snapshot_seq),
    temporalTarget: {
      requestedStateView: String(run.requested_state_view) as RequestedStateView,
      referenceTimeUtc: String(run.reference_time_utc),
      ownerTimeZone: String(run.owner_time_zone),
      targetValidFromUtc: typeof run.target_valid_from_utc === "string" ? run.target_valid_from_utc : null,
      targetValidToUtc: typeof run.target_valid_to_utc === "string" ? run.target_valid_to_utc : null,
      targetTimePrecision: String(run.target_time_precision) as TemporalTarget["targetTimePrecision"],
      basis: String(run.basis) as TemporalTarget["basis"],
    },
    expansionArtifactId: expansion ? String(expansion.artifact_id) : null,
    expansionCompleteness: expansion ? String(expansion.completeness) as RevisionExpansionArtifact["completeness"] : null,
    projectionIds: projections.results.map((row) => String(row.projection_id)),
    shadowOnly: expansion ? Number(expansion.shadow_only) === 1 : true,
  };
}
