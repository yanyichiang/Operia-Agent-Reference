import { canonicalJson } from "../import/hashes";
import { memoryArtifactHash, utf8ByteLength } from "./integrity";
import type {
  QueryStateProjection,
  RequestedStateView,
  RevisionExpansionArtifact,
} from "./gateDStateAlignment";

export const MEMORY_VNEXT_GATE_E_PACKET_VERSION = "memory-state-evidence-packet-e1";
export const MEMORY_VNEXT_GATE_E_RENDERER_VERSION = "memory-state-length-delimited-renderer-e1";

export const GHOST_MEMORY_FAILURE_CODES = [
  "BANK_STATE_MISSING",
  "BANK_RELATION_MISSING",
  "SEED_CANDIDATE_MISS",
  "REVISION_EXPANSION_MISS",
  "STATE_PROJECTION_ERROR",
  "FUSION_OR_RERANK_DROP",
  "PACKET_INCOMPLETE",
  "PACKET_RENDER_MISMATCH",
  "RECEIPT_MISMATCH",
  "QA_STATE_RESOLUTION_ERROR",
] as const;

export type GhostMemoryFailureCode = (typeof GHOST_MEMORY_FAILURE_CODES)[number];

export type StateEvidenceSource = {
  evidenceBundleId: string;
  candidateRef: string;
  sourceRevision: number;
  completeness: "complete" | "incomplete";
  content: string;
};

export type StatePacketGroupPlan = {
  groupId: string;
  groupKind: "PRIMARY_STATE" | "STATE_TRANSITION" | "MATERIAL_CONTRAST" | "DISPUTE_SET" | "CONTEXT";
  atomicity: "ALL_REQUIRED" | "ANY_SUFFICIENT";
  candidateRefs: string[];
  projectionIds: string[];
  evidenceBundleIds: string[];
  revisionRelationIds: string[];
};

export type StateEvidencePacketGroup = StatePacketGroupPlan & {
  included: boolean;
  completeness: "complete" | "incomplete";
  omissionReason:
    | null
    | "incomplete_relation_chain"
    | "incomplete_evidence"
    | "token_budget"
    | "byte_budget"
    | "source_unavailable"
    | "privacy_boundary";
  groupHash: string;
};

export type StateEvidencePacket = {
  packetId: string;
  runId: string;
  queryPlanHash: string;
  txnSnapshotSeq: number;
  requestedStateView: RequestedStateView;
  groups: StateEvidencePacketGroup[];
  packetVersion: string;
  packetHash: string;
  totalBytes: number;
  estimatedTokens: number;
  createdAtUtc: string;
};

export type RenderedStateInjection = {
  sourceRef: string;
  sourceRevision: number;
  projectionId: string;
  packetGroupId: string;
  requestedStateView: RequestedStateView;
  queryRole: Exclude<QueryStateProjection["queryRole"], "exclude">;
  evidencePolarity: QueryStateProjection["evidencePolarity"];
  renderedFragmentHash: string;
  order: number;
};

export type RenderedStatePacket = {
  packetId: string;
  rendererVersion: string;
  rendered: string;
  renderedHash: string;
  orderedStateInjections: RenderedStateInjection[];
};

export type RecallReceiptStateExtension = {
  queryPlanHash: string;
  txnSnapshotSeq: number;
  requestedStateView: RequestedStateView;
  revisionExpansionArtifactId: string | null;
  queryStateProjectionIds: string[];
  stateEvidencePacketId: string | null;
  orderedStateInjections: RenderedStateInjection[];
};

export type StatePacketRuntimePolicy = {
  memoryStateProjectionShadow: boolean;
  memoryRevisionExpansionShadow: boolean;
  memoryStatePacketShadow: boolean;
  memoryStatePacketInject: boolean;
};

export const MEMORY_VNEXT_STATE_PACKET_CANDIDATE_POLICY: Readonly<StatePacketRuntimePolicy> = Object.freeze({
  memoryStateProjectionShadow: false,
  memoryRevisionExpansionShadow: false,
  memoryStatePacketShadow: false,
  memoryStatePacketInject: false,
});

const GROUP_PRIORITY: Readonly<Record<StatePacketGroupPlan["groupKind"], number>> = {
  PRIMARY_STATE: 0,
  DISPUTE_SET: 1,
  STATE_TRANSITION: 2,
  MATERIAL_CONTRAST: 3,
  CONTEXT: 4,
};

function expectedRoleForGroup(
  groupKind: StatePacketGroupPlan["groupKind"],
  role: QueryStateProjection["queryRole"],
): boolean {
  if (role === "exclude") return false;
  if (groupKind === "PRIMARY_STATE") return role === "primary";
  if (groupKind === "STATE_TRANSITION") return role === "trajectory";
  if (groupKind === "MATERIAL_CONTRAST") return role === "contrast" || role === "trajectory";
  if (groupKind === "DISPUTE_SET") return role === "primary" || role === "contrast";
  return role === "context";
}

function groupCompleteness(input: {
  plan: StatePacketGroupPlan;
  projectionById: ReadonlyMap<string, QueryStateProjection>;
  sourceById: ReadonlyMap<string, StateEvidenceSource>;
  relationIds: ReadonlySet<string>;
}): StateEvidencePacketGroup["omissionReason"] {
  const projections = input.plan.projectionIds.map((id) => input.projectionById.get(id));
  const sources = input.plan.evidenceBundleIds.map((id) => input.sourceById.get(id));
  if (projections.some((projection) => !projection) || sources.some((source) => !source)) return "source_unavailable";
  if (projections.some((projection) => projection && !expectedRoleForGroup(input.plan.groupKind, projection.queryRole))) {
    return "incomplete_evidence";
  }
  const projectionCandidates = new Set(projections.map((projection) => projection!.candidateRef));
  const evidenceCandidates = new Set(sources.map((source) => source!.candidateRef));
  if (input.plan.candidateRefs.some((ref) => !projectionCandidates.has(ref) || !evidenceCandidates.has(ref))) {
    return "incomplete_evidence";
  }
  if (sources.some((source) => source!.completeness !== "complete")) return "incomplete_evidence";
  if (input.plan.revisionRelationIds.some((id) => !input.relationIds.has(id))) return "incomplete_relation_chain";
  if (input.plan.groupKind === "STATE_TRANSITION" && (
    input.plan.atomicity !== "ALL_REQUIRED"
    || input.plan.candidateRefs.length < 2
    || input.plan.revisionRelationIds.length < 1
  )) return "incomplete_relation_chain";
  if (input.plan.groupKind === "DISPUTE_SET" && (
    input.plan.atomicity !== "ALL_REQUIRED" || input.plan.candidateRefs.length < 2
  )) return "incomplete_evidence";
  return null;
}

export async function buildStateEvidencePacket(input: {
  runId: string;
  queryPlanHash: string;
  txnSnapshotSeq: number;
  requestedStateView: RequestedStateView;
  groupPlans: readonly StatePacketGroupPlan[];
  projections: readonly QueryStateProjection[];
  evidenceSources: readonly StateEvidenceSource[];
  availableRevisionRelationIds: readonly string[];
  maxBytes: number;
  maxEstimatedTokens: number;
  createdAtUtc: string;
}): Promise<StateEvidencePacket> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new Error("memory_state_packet_byte_budget_invalid");
  if (!Number.isSafeInteger(input.maxEstimatedTokens) || input.maxEstimatedTokens < 1) throw new Error("memory_state_packet_token_budget_invalid");
  const projectionById = new Map(input.projections.map((projection) => [projection.projectionId, projection]));
  const sourceById = new Map(input.evidenceSources.map((source) => [source.evidenceBundleId, source]));
  if (projectionById.size !== input.projections.length) throw new Error("memory_state_packet_projection_id_duplicate");
  if (sourceById.size !== input.evidenceSources.length) throw new Error("memory_state_packet_evidence_bundle_id_duplicate");
  if (new Set(input.groupPlans.map((plan) => plan.groupId)).size !== input.groupPlans.length) {
    throw new Error("memory_state_packet_group_id_duplicate");
  }
  for (const projection of input.projections) {
    if (
      projection.runId !== input.runId
      || projection.queryPlanHash !== input.queryPlanHash
      || projection.txnSnapshotSeq !== input.txnSnapshotSeq
      || projection.requestedStateView !== input.requestedStateView
    ) throw new Error("memory_state_packet_projection_snapshot_mismatch");
  }
  const relationIds = new Set(input.availableRevisionRelationIds);
  const orderedPlans = [...input.groupPlans].sort((left, right) => GROUP_PRIORITY[left.groupKind] - GROUP_PRIORITY[right.groupKind]
    || left.groupId.localeCompare(right.groupId));
  const groups: StateEvidencePacketGroup[] = [];
  let usedBytes = utf8ByteLength(
    `STATE_PACKET ${MEMORY_VNEXT_GATE_E_RENDERER_VERSION}\n`
    + lengthDelimited("PACKET_META", {
      packetId: `packet_${"0".repeat(32)}`,
      queryPlanHash: input.queryPlanHash,
      txnSnapshotSeq: input.txnSnapshotSeq,
      requestedStateView: input.requestedStateView,
    })
    + "END_STATE_PACKET\n",
  );
  if (usedBytes > input.maxBytes || Math.ceil(usedBytes / 4) > input.maxEstimatedTokens) {
    throw new Error("memory_state_packet_envelope_exceeds_budget");
  }
  for (const plan of orderedPlans) {
    let omissionReason = groupCompleteness({ plan, projectionById, sourceById, relationIds });
    let bytes = 0;
    if (omissionReason === null) {
      const provisionalBody = { ...plan, included: true, completeness: "complete" as const, omissionReason: null };
      const provisionalGroup: StateEvidencePacketGroup = {
        ...provisionalBody,
        groupHash: await memoryArtifactHash("memory-state-packet-group", provisionalBody),
      };
      bytes = renderableGroupBytes(provisionalGroup, projectionById, sourceById);
      if (usedBytes + bytes > input.maxBytes) omissionReason = "byte_budget";
      if (omissionReason === null && Math.ceil((usedBytes + bytes) / 4) > input.maxEstimatedTokens) omissionReason = "token_budget";
    }
    const included = omissionReason === null;
    if (included) {
      usedBytes += bytes;
    }
    const groupBody = {
      ...plan,
      included,
      completeness: included ? "complete" as const : "incomplete" as const,
      omissionReason,
    };
    groups.push({
      ...groupBody,
      groupHash: await memoryArtifactHash("memory-state-packet-group", groupBody),
    });
  }
  const body = {
    runId: input.runId,
    queryPlanHash: input.queryPlanHash,
    txnSnapshotSeq: input.txnSnapshotSeq,
    requestedStateView: input.requestedStateView,
    groups,
    packetVersion: MEMORY_VNEXT_GATE_E_PACKET_VERSION,
    totalBytes: usedBytes,
    estimatedTokens: Math.ceil(usedBytes / 4),
  };
  const packetHash = await memoryArtifactHash("memory-state-evidence-packet", body);
  return {
    packetId: `packet_${packetHash.slice(0, 32)}`,
    ...body,
    packetHash,
    createdAtUtc: input.createdAtUtc,
  };
}

function lengthDelimited(label: string, value: unknown): string {
  const serialized = canonicalJson(value);
  return `${label}_JSON_BYTES ${utf8ByteLength(serialized)}\n${serialized}\n`;
}

function renderableGroupChunk(
  group: StateEvidencePacketGroup,
  projectionById: ReadonlyMap<string, QueryStateProjection>,
  sourceById: ReadonlyMap<string, StateEvidenceSource>,
): string {
  let chunk = lengthDelimited("GROUP_META", {
    groupId: group.groupId,
    groupKind: group.groupKind,
    atomicity: group.atomicity,
    groupHash: group.groupHash,
    revisionRelationIds: group.revisionRelationIds,
  });
  for (const projectionId of group.projectionIds) {
    const projection = projectionById.get(projectionId);
    if (!projection || projection.queryRole === "exclude" || !expectedRoleForGroup(group.groupKind, projection.queryRole)) {
      throw new Error("memory_state_packet_projection_render_mismatch");
    }
    const sources = group.evidenceBundleIds
      .map((id) => sourceById.get(id))
      .filter((source): source is StateEvidenceSource => Boolean(source && source.candidateRef === projection.candidateRef))
      .sort((left, right) => left.evidenceBundleId.localeCompare(right.evidenceBundleId));
    if (sources.length === 0) throw new Error("memory_state_packet_source_render_missing");
    for (const source of sources) {
      chunk += lengthDelimited("MEMBER_META", {
        candidateRef: projection.candidateRef,
        sourceRevision: projection.sourceRevision,
        projectionId: projection.projectionId,
        queryRole: projection.queryRole,
        evidencePolarity: projection.evidencePolarity,
        evidenceBundleId: source.evidenceBundleId,
      }) + lengthDelimited("MEMORY_CONTENT", source.content);
    }
  }
  return `${chunk}END_GROUP\n`;
}

function renderableGroupBytes(
  group: StateEvidencePacketGroup,
  projectionById: ReadonlyMap<string, QueryStateProjection>,
  sourceById: ReadonlyMap<string, StateEvidenceSource>,
): number {
  return utf8ByteLength(renderableGroupChunk(group, projectionById, sourceById));
}

export async function renderStateEvidencePacket(input: {
  packet: StateEvidencePacket;
  projections: readonly QueryStateProjection[];
  evidenceSources: readonly StateEvidenceSource[];
}): Promise<RenderedStatePacket> {
  const projectionById = new Map(input.projections.map((projection) => [projection.projectionId, projection]));
  const sourceById = new Map(input.evidenceSources.map((source) => [source.evidenceBundleId, source]));
  const chunks = [
    `STATE_PACKET ${MEMORY_VNEXT_GATE_E_RENDERER_VERSION}\n`,
    lengthDelimited("PACKET_META", {
      packetId: input.packet.packetId,
      queryPlanHash: input.packet.queryPlanHash,
      txnSnapshotSeq: input.packet.txnSnapshotSeq,
      requestedStateView: input.packet.requestedStateView,
    }),
  ];
  const orderedStateInjections: RenderedStateInjection[] = [];
  for (const group of input.packet.groups.filter((candidate) => candidate.included)) {
    if (group.completeness !== "complete" || group.omissionReason !== null) throw new Error("memory_state_packet_partial_group_render_forbidden");
    chunks.push(lengthDelimited("GROUP_META", {
      groupId: group.groupId,
      groupKind: group.groupKind,
      atomicity: group.atomicity,
      groupHash: group.groupHash,
      revisionRelationIds: group.revisionRelationIds,
    }));
    for (const projectionId of group.projectionIds) {
      const projection = projectionById.get(projectionId);
      if (!projection || projection.queryRole === "exclude" || !expectedRoleForGroup(group.groupKind, projection.queryRole)) {
        throw new Error("memory_state_packet_projection_render_mismatch");
      }
      const sources = group.evidenceBundleIds
        .map((id) => sourceById.get(id))
        .filter((source): source is StateEvidenceSource => Boolean(source && source.candidateRef === projection.candidateRef))
        .sort((left, right) => left.evidenceBundleId.localeCompare(right.evidenceBundleId));
      if (sources.length === 0) throw new Error("memory_state_packet_source_render_missing");
      for (const source of sources) {
        const fragment = lengthDelimited("MEMBER_META", {
          candidateRef: projection.candidateRef,
          sourceRevision: projection.sourceRevision,
          projectionId: projection.projectionId,
          queryRole: projection.queryRole,
          evidencePolarity: projection.evidencePolarity,
          evidenceBundleId: source.evidenceBundleId,
        }) + lengthDelimited("MEMORY_CONTENT", source.content);
        chunks.push(fragment);
        orderedStateInjections.push({
          sourceRef: source.evidenceBundleId,
          sourceRevision: source.sourceRevision,
          projectionId: projection.projectionId,
          packetGroupId: group.groupId,
          requestedStateView: input.packet.requestedStateView,
          queryRole: projection.queryRole,
          evidencePolarity: projection.evidencePolarity,
          renderedFragmentHash: await memoryArtifactHash("memory-state-rendered-fragment", fragment),
          order: orderedStateInjections.length,
        });
      }
    }
    chunks.push("END_GROUP\n");
  }
  chunks.push("END_STATE_PACKET\n");
  const rendered = chunks.join("");
  return {
    packetId: input.packet.packetId,
    rendererVersion: MEMORY_VNEXT_GATE_E_RENDERER_VERSION,
    rendered,
    renderedHash: await memoryArtifactHash("memory-state-rendered-packet", rendered),
    orderedStateInjections,
  };
}

export function buildRecallReceiptStateExtension(input: {
  packet: StateEvidencePacket;
  expansion: RevisionExpansionArtifact | null;
  projections: readonly QueryStateProjection[];
  rendered: RenderedStatePacket;
}): RecallReceiptStateExtension {
  if (input.rendered.packetId !== input.packet.packetId) throw new Error("memory_state_receipt_packet_mismatch");
  return {
    queryPlanHash: input.packet.queryPlanHash,
    txnSnapshotSeq: input.packet.txnSnapshotSeq,
    requestedStateView: input.packet.requestedStateView,
    revisionExpansionArtifactId: input.expansion?.artifactId ?? null,
    queryStateProjectionIds: input.projections.map((projection) => projection.projectionId).sort(),
    stateEvidencePacketId: input.packet.packetId,
    orderedStateInjections: input.rendered.orderedStateInjections,
  };
}

export type RecallReceiptStateVerification = {
  ok: boolean;
  failureCodes: GhostMemoryFailureCode[];
  mismatchCodes: string[];
};

export function verifyRecallReceiptState(input: {
  receipt: RecallReceiptStateExtension;
  packet: StateEvidencePacket;
  expansion: RevisionExpansionArtifact | null;
  projections: readonly QueryStateProjection[];
  rendered: RenderedStatePacket;
}): RecallReceiptStateVerification {
  const mismatches: string[] = [];
  if (
    input.receipt.queryPlanHash !== input.packet.queryPlanHash
    || input.receipt.txnSnapshotSeq !== input.packet.txnSnapshotSeq
    || input.receipt.requestedStateView !== input.packet.requestedStateView
  ) mismatches.push("TEMPORAL_TARGET_CHAIN_MISMATCH");
  if (input.receipt.stateEvidencePacketId !== input.packet.packetId || input.rendered.packetId !== input.packet.packetId) {
    mismatches.push("PACKET_ID_MISMATCH");
  }
  if ((input.expansion?.artifactId ?? null) !== input.receipt.revisionExpansionArtifactId) {
    mismatches.push("EXPANSION_ARTIFACT_MISMATCH");
  }
  const projectionById = new Map(input.projections.map((projection) => [projection.projectionId, projection]));
  const expectedProjectionIds = input.projections.map((projection) => projection.projectionId).sort();
  if (canonicalJson(expectedProjectionIds) !== canonicalJson(input.receipt.queryStateProjectionIds)) {
    mismatches.push("PROJECTION_SET_MISMATCH");
  }
  const includedGroups = new Map(input.packet.groups.filter((group) => group.included).map((group) => [group.groupId, group]));
  if (input.receipt.orderedStateInjections.length !== input.rendered.orderedStateInjections.length) {
    mismatches.push("ORDERED_INJECTION_COUNT_MISMATCH");
  }
  input.receipt.orderedStateInjections.forEach((injection, index) => {
    const renderedInjection = input.rendered.orderedStateInjections[index];
    const projection = projectionById.get(injection.projectionId);
    const group = includedGroups.get(injection.packetGroupId);
    if (!renderedInjection || canonicalJson(renderedInjection) !== canonicalJson(injection)) {
      mismatches.push(`RENDERED_FRAGMENT_MISMATCH:${index}`);
    }
    if (!projection || !group || !group.projectionIds.includes(injection.projectionId)) {
      mismatches.push(`PACKET_MEMBERSHIP_MISMATCH:${index}`);
    } else if (!expectedRoleForGroup(group.groupKind, projection.queryRole) || projection.queryRole !== injection.queryRole) {
      mismatches.push(`PROJECTION_ROLE_PLACEMENT_MISMATCH:${index}`);
    }
  });
  if (input.expansion) {
    const injectedCandidates = new Set(input.receipt.orderedStateInjections.map((item) => {
      const projection = projectionById.get(item.projectionId);
      return projection?.candidateRef;
    }));
    for (const candidate of input.expansion.addedCandidates.filter((item) => item.deterministicFloor)) {
      if (!injectedCandidates.has(candidate.candidateRef)) mismatches.push(`DETERMINISTIC_FLOOR_MISSING:${candidate.candidateRef}`);
    }
  }
  const failureCodes: GhostMemoryFailureCode[] = [];
  if (mismatches.some((code) => code.startsWith("RENDERED_FRAGMENT") || code.startsWith("PROJECTION_ROLE"))) {
    failureCodes.push("PACKET_RENDER_MISMATCH");
  }
  if (mismatches.some((code) => code.startsWith("DETERMINISTIC_FLOOR"))) failureCodes.push("FUSION_OR_RERANK_DROP");
  if (mismatches.some((code) => !code.startsWith("RENDERED_FRAGMENT") && !code.startsWith("PROJECTION_ROLE") && !code.startsWith("DETERMINISTIC_FLOOR"))) {
    failureCodes.push("RECEIPT_MISMATCH");
  }
  return { ok: mismatches.length === 0, failureCodes, mismatchCodes: mismatches };
}

export function assertStatePacketInjectionAuthorized(policy: StatePacketRuntimePolicy): void {
  if (!policy.memoryStatePacketInject) throw new Error("memory_state_packet_injection_disabled");
  if (!policy.memoryStateProjectionShadow || !policy.memoryRevisionExpansionShadow || !policy.memoryStatePacketShadow) {
    throw new Error("memory_state_packet_prerequisite_shadow_disabled");
  }
}
