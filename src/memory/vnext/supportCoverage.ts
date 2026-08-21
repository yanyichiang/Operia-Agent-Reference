import type { EvidenceRelation } from "./contracts";
import { memoryArtifactHash } from "./integrity";

export const MEMORY_SUPPORT_COVERAGE_POLICY_VERSION = "memory-support-coverage-v2.0.0";

export type CoverageSupportEdge = {
  edgeId: string;
  supportGroupId: string | null;
  relation: EvidenceRelation;
  rootLineageId: string;
  elicitationEpisodeId: string;
  active: boolean;
  authority: "owner" | "operia" | "trusted_tool" | "third_party" | "none";
  weakObservation: boolean;
  material: boolean;
};

export type CoverageSupportGroup = {
  supportGroupId: string;
  mode: "ALL_REQUIRED" | "ANY_SUFFICIENT";
  memberEdgeIds: string[];
};

export type SupportCoverageResult = {
  coverageHash: string;
  survivingSupportGroupIds: string[];
  sufficientPositiveSupport: boolean;
  materialContradictionEdgeIds: string[];
  qualificationEdgeIds: string[];
  independentPositiveLineageCount: number;
  proposedEpistemicStatus: "known" | "believed" | "disputed";
  proposedLifecycleStatus: "current" | "historical" | "superseded" | "retracted";
  reasonCodes: string[];
  policyVersion: string;
};

function positive(edge: CoverageSupportEdge): boolean {
  return edge.relation === "SUPPORTS" || edge.relation === "CONFIRMS";
}

export async function recomputeSupportCoverage(input: {
  edges: CoverageSupportEdge[];
  groups: CoverageSupportGroup[];
  realWorldStateEnded?: boolean;
  representationSuperseded?: boolean;
}): Promise<SupportCoverageResult> {
  const byId = new Map(input.edges.map((edge) => [edge.edgeId,edge]));
  if (byId.size !== input.edges.length) throw new Error("memory_support_edge_duplicate");
  const survivingSupportGroupIds: string[] = [];
  const independentLineages = new Set<string>();
  for (const group of input.groups) {
    const members = [...new Set(group.memberEdgeIds)].map((id) => byId.get(id));
    if (members.some((edge) => !edge)) throw new Error("memory_support_group_member_missing");
    const positiveMembers = members.filter((edge): edge is CoverageSupportEdge => Boolean(edge && positive(edge)));
    const satisfied = members.length > 0 && (group.mode === "ALL_REQUIRED"
      ? positiveMembers.length === members.length && positiveMembers.every((edge) => edge.active && edge.authority !== "none")
      : positiveMembers.some((edge) => edge.active && edge.authority !== "none"));
    if (!satisfied) continue;
    survivingSupportGroupIds.push(group.supportGroupId);
    for (const edge of positiveMembers.filter((item) => item.active && item.authority !== "none")) {
      independentLineages.add(`${edge.rootLineageId}:${edge.elicitationEpisodeId}`);
    }
  }
  const materialContradictionEdgeIds = input.edges
    .filter((edge) => edge.active && edge.material && edge.authority !== "none" && edge.relation === "CONTRADICTS")
    .map((edge) => edge.edgeId).sort();
  const qualificationEdgeIds = input.edges
    .filter((edge) => edge.active && edge.material && edge.authority !== "none" && edge.relation === "QUALIFIES")
    .map((edge) => edge.edgeId).sort();
  const sufficientPositiveSupport = survivingSupportGroupIds.length > 0;
  const weakObservation = input.edges.some((edge) => edge.active && edge.weakObservation && edge.authority !== "none");
  const proposedEpistemicStatus: SupportCoverageResult["proposedEpistemicStatus"] = sufficientPositiveSupport
    ? materialContradictionEdgeIds.length > 0 ? "disputed" : "known"
    : weakObservation ? "believed" : "believed";
  const proposedLifecycleStatus: SupportCoverageResult["proposedLifecycleStatus"] = input.realWorldStateEnded
    ? "historical"
    : input.representationSuperseded
      ? "superseded"
      : sufficientPositiveSupport || weakObservation
        ? "current"
        : "retracted";
  const reasonCodes = [
    sufficientPositiveSupport ? "POSITIVE_SUPPORT_SUFFICIENT" : "POSITIVE_SUPPORT_INSUFFICIENT",
    ...(materialContradictionEdgeIds.length > 0 ? ["MATERIAL_CONTRADICTION_PRESENT"] : []),
    ...(qualificationEdgeIds.length > 0 ? ["MATERIAL_QUALIFICATION_PRESENT"] : []),
    ...(weakObservation && !sufficientPositiveSupport ? ["WEAK_OBSERVATION_ONLY"] : []),
    ...(input.realWorldStateEnded ? ["REAL_WORLD_STATE_ENDED"] : []),
    ...(input.representationSuperseded ? ["REPRESENTATION_SUPERSEDED"] : []),
  ];
  const core = {
    survivingSupportGroupIds: survivingSupportGroupIds.sort(),
    sufficientPositiveSupport,
    materialContradictionEdgeIds,
    qualificationEdgeIds,
    independentPositiveLineageCount: independentLineages.size,
    proposedEpistemicStatus,
    proposedLifecycleStatus,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    policyVersion: MEMORY_SUPPORT_COVERAGE_POLICY_VERSION,
  };
  return { coverageHash: await memoryArtifactHash("memory-support-coverage-v2",core),...core };
}

export type DependencyEdge = {
  dependencyEdgeId: string;
  fromNodeId: string;
  toNodeId: string;
  active: boolean;
};

export function propagateDescendantInvalidation(input: {
  closedRootNodeIds: string[];
  dependencyEdges: DependencyEdge[];
}): { invalidatedNodeIds: string[]; traversedEdgeIds: string[] } {
  const queue = [...new Set(input.closedRootNodeIds)].sort();
  const visited = new Set(queue);
  const traversed = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const edge of input.dependencyEdges.filter((item) => item.active && item.fromNodeId === node)) {
      traversed.add(edge.dependencyEdgeId);
      if (visited.has(edge.toNodeId)) continue;
      visited.add(edge.toNodeId);
      queue.push(edge.toNodeId);
    }
  }
  return {
    invalidatedNodeIds: [...visited].filter((id) => !input.closedRootNodeIds.includes(id)).sort(),
    traversedEdgeIds: [...traversed].sort(),
  };
}

export async function closeEvidenceEdges(input: {
  db: D1Database;
  evidenceRefIds: string[];
  txnSeq: number;
}): Promise<number> {
  if (!Number.isSafeInteger(input.txnSeq) || input.txnSeq < 1) throw new Error("memory_support_close_txn_invalid");
  let closed = 0;
  for (const evidenceRefId of [...new Set(input.evidenceRefIds)].sort()) {
    const result = await input.db.prepare(`UPDATE memory_fact_revision_evidence
      SET edge_txn_to_seq=?,edge_close_reason='SOURCE_EVIDENCE_CLOSED'
      WHERE interpretation_id IN (
        SELECT interpretation_id FROM memory_evidence_interpretations WHERE evidence_ref_id=?
      ) AND edge_txn_to_seq IS NULL AND edge_txn_from_seq < ?`).bind(
        input.txnSeq,evidenceRefId,input.txnSeq,
      ).run();
    closed += Number(result.meta?.changes ?? 0);
  }
  return closed;
}

export type MemoryInfluenceAction = "HIDE" | "FORGET" | "PURGE";

export function planMemoryInfluenceAction(input: {
  action: MemoryInfluenceAction;
  targetKind: "canonical_event" | "evidence_unit" | "claim_atom" | "fact_revision" | "owner_dimension";
  targetId: string;
  explicitPurgeNow: boolean;
}): {
  closeRetrievalEdges: boolean;
  closeSupportEdges: boolean;
  removeCanonicalContent: boolean;
  recoverable: boolean;
  reasonCodes: string[];
} {
  if (!input.targetId.trim()) throw new Error("memory_influence_target_required");
  if (input.action === "PURGE" && !input.explicitPurgeNow) throw new Error("memory_purge_explicit_now_required");
  if (input.action === "HIDE") return {
    closeRetrievalEdges: true,closeSupportEdges: false,removeCanonicalContent: false,recoverable: true,
    reasonCodes: ["HIDE_RECALL_ONLY"],
  };
  if (input.action === "FORGET") return {
    closeRetrievalEdges: true,closeSupportEdges: true,removeCanonicalContent: false,recoverable: true,
    reasonCodes: ["FORGET_CLOSES_INFLUENCE"],
  };
  return {
    closeRetrievalEdges: true,closeSupportEdges: true,removeCanonicalContent: true,recoverable: false,
    reasonCodes: ["PURGE_EXPLICIT_IRREVERSIBLE"],
  };
}
