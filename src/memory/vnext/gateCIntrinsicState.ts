import type {
  ClaimAtom,
  EvidenceSupportGroup,
  FactRevision,
  FactRevisionEvidence,
} from "./contracts";
import { canonicalJson } from "../import/hashes";
import { memoryArtifactHash } from "./integrity";

export const MEMORY_VNEXT_GATE_C_SNAPSHOT_VERSION = "memory-vnext-intrinsic-snapshot-c1";

export const FACT_REVISION_RELATIONS = [
  "STATE_CHANGE",
  "RETROACTIVE_CORRECTION",
  "SCOPE_CLARIFICATION",
  "EPISTEMIC_RETRACTION",
  "MERGES",
  "SPLITS",
] as const;

export type FactRevisionRelationKind = (typeof FACT_REVISION_RELATIONS)[number];

export type StatefulFactRevision = FactRevision & {
  claimAtom: ClaimAtom;
  namespace: string;
  contentRef: string;
};

export type FactRevisionRelation = {
  relationId: string;
  fromRevisionId: string;
  toRevisionId: string;
  relation: FactRevisionRelationKind;
  txnFromSeq: number;
  txnToSeq: number | null;
  mutationDecisionId: string;
};

export type FactRevisionStateEvent = {
  eventId: string;
  factRevisionId: string;
  txnSeq: number;
  fromLifecycleStatus: FactRevision["lifecycleStatus"];
  toLifecycleStatus: FactRevision["lifecycleStatus"];
  fromEpistemicStatus: FactRevision["epistemicStatus"];
  toEpistemicStatus: FactRevision["epistemicStatus"];
  causeRef: string;
};

export type RevisionSupportCoverage = {
  factRevisionId: string;
  activeSupportGroupIds: string[];
  satisfiedSupportGroupIds: string[];
  activeSupportEdgeIds: string[];
  activeContradictionEdgeIds: string[];
  sufficient: boolean;
};

export type IntrinsicRevisionSnapshotMember = {
  factRevisionId: string;
  factKey: string;
  revision: number;
  claimAtom: ClaimAtom;
  epistemicStatus: FactRevision["epistemicStatus"];
  lifecycleStatus: FactRevision["lifecycleStatus"];
  validFromUtc: string | null;
  validToUtc: string | null;
  validStartKind: FactRevision["validStartKind"];
  validEndKind: FactRevision["validEndKind"];
  supportCoverage: RevisionSupportCoverage;
};

export type UnresolvedContradiction = {
  contradictionId: string;
  leftRevisionId: string;
  rightRevisionId: string;
  factKey: string;
  ruleCodes: string[];
};

export type IntrinsicStateSnapshot = {
  artifactId: string;
  txnSnapshotSeq: number;
  members: IntrinsicRevisionSnapshotMember[];
  relations: FactRevisionRelation[];
  unresolvedContradictions: UnresolvedContradiction[];
  snapshotVersion: string;
  artifactHash: string;
  createdAtUtc: string;
};

type TxnVisible = { txnFromSeq: number; txnToSeq: number | null };
type EdgeTxnVisible = { edgeTxnFromSeq: number; edgeTxnToSeq: number | null };

export function isVisibleAtTxn(item: TxnVisible, txnSnapshotSeq: number): boolean {
  if (!Number.isSafeInteger(txnSnapshotSeq) || txnSnapshotSeq < 1) {
    throw new Error("memory_txn_snapshot_invalid");
  }
  return item.txnFromSeq <= txnSnapshotSeq && (item.txnToSeq === null || txnSnapshotSeq < item.txnToSeq);
}

export function isEvidenceVisibleAtTxn(item: EdgeTxnVisible, txnSnapshotSeq: number): boolean {
  if (!Number.isSafeInteger(txnSnapshotSeq) || txnSnapshotSeq < 1) {
    throw new Error("memory_txn_snapshot_invalid");
  }
  return item.edgeTxnFromSeq <= txnSnapshotSeq
    && (item.edgeTxnToSeq === null || txnSnapshotSeq < item.edgeTxnToSeq);
}

function timeValue(value: string | null, kind: FactRevision["validStartKind"] | FactRevision["validEndKind"]): number | null {
  if (kind === "UNBOUNDED") return Number.NEGATIVE_INFINITY;
  if (kind === "OPEN_ENDED") return Number.POSITIVE_INFINITY;
  if (kind === "UNKNOWN") return null;
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) throw new Error("memory_valid_time_invalid");
  return parsed;
}

export function revisionContainsTime(revision: FactRevision, referenceTimeUtc: string): boolean | null {
  const reference = Date.parse(referenceTimeUtc);
  if (!Number.isFinite(reference)) throw new Error("memory_reference_time_invalid");
  const start = timeValue(revision.validFromUtc, revision.validStartKind);
  const end = timeValue(revision.validToUtc, revision.validEndKind);
  if (start === null || end === null) return null;
  return start <= reference && reference < end;
}

export function revisionOverlapsInterval(
  revision: FactRevision,
  targetValidFromUtc: string | null,
  targetValidToUtc: string | null,
): boolean | null {
  if (targetValidFromUtc === null || targetValidToUtc === null) return null;
  const targetStart = Date.parse(targetValidFromUtc);
  const targetEnd = Date.parse(targetValidToUtc);
  if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd) || targetStart >= targetEnd) {
    throw new Error("memory_target_interval_invalid");
  }
  const start = timeValue(revision.validFromUtc, revision.validStartKind);
  const end = timeValue(revision.validToUtc, revision.validEndKind);
  if (start === null || end === null) return null;
  return start < targetEnd && targetStart < end;
}

function scopesOverlap(left: ClaimAtom, right: ClaimAtom): boolean {
  return left.subject === right.subject
    && left.predicate === right.predicate
    && (left.scope === right.scope || left.scope === "global" || right.scope === "global");
}

function revisionsOverlap(left: StatefulFactRevision, right: StatefulFactRevision): boolean | null {
  const leftStart = timeValue(left.validFromUtc, left.validStartKind);
  const leftEnd = timeValue(left.validToUtc, left.validEndKind);
  const rightStart = timeValue(right.validFromUtc, right.validStartKind);
  const rightEnd = timeValue(right.validToUtc, right.validEndKind);
  if (leftStart === null || leftEnd === null || rightStart === null || rightEnd === null) return null;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function evidenceEdgeId(edge: FactRevisionEvidence): string {
  return [edge.factRevisionId, edge.interpretationId, edge.lineageId, edge.edgeTxnFromSeq].join(":");
}

export function evaluateSupportCoverage(input: {
  factRevisionId: string;
  txnSnapshotSeq: number;
  evidenceEdges: readonly FactRevisionEvidence[];
  supportGroups: readonly EvidenceSupportGroup[];
}): RevisionSupportCoverage {
  const active = input.evidenceEdges
    .filter((edge) => edge.factRevisionId === input.factRevisionId && isEvidenceVisibleAtTxn(edge, input.txnSnapshotSeq))
    .sort((left, right) => evidenceEdgeId(left).localeCompare(evidenceEdgeId(right)));
  const activeInterpretationIds = new Set(active.map((edge) => edge.interpretationId));
  const groups = input.supportGroups
    .filter((group) => active.some((edge) => edge.supportGroupId === group.supportGroupId))
    .sort((left, right) => left.supportGroupId.localeCompare(right.supportGroupId));
  const satisfied = groups.filter((group) => {
    if (group.interpretationIds.length === 0) return false;
    return group.mode === "ALL_REQUIRED"
      ? group.interpretationIds.every((id) => activeInterpretationIds.has(id))
      : group.interpretationIds.some((id) => activeInterpretationIds.has(id));
  });
  const supportEdgeIds = active
    .filter((edge) => edge.relation === "SUPPORTS" || edge.relation === "CONFIRMS")
    .map(evidenceEdgeId);
  return {
    factRevisionId: input.factRevisionId,
    activeSupportGroupIds: groups.map((group) => group.supportGroupId),
    satisfiedSupportGroupIds: satisfied.map((group) => group.supportGroupId),
    activeSupportEdgeIds: supportEdgeIds,
    activeContradictionEdgeIds: active.filter((edge) => edge.relation === "CONTRADICTS").map(evidenceEdgeId),
    sufficient: satisfied.length > 0 && supportEdgeIds.length > 0,
  };
}

export function projectRevisionIntrinsicState(
  revision: StatefulFactRevision,
  stateEvents: readonly FactRevisionStateEvent[],
  txnSnapshotSeq: number,
): StatefulFactRevision {
  let lifecycleStatus = revision.lifecycleStatus;
  let epistemicStatus = revision.epistemicStatus;
  const events = stateEvents
    .filter((event) => event.factRevisionId === revision.factRevisionId && event.txnSeq <= txnSnapshotSeq)
    .sort((left, right) => left.txnSeq - right.txnSeq || left.eventId.localeCompare(right.eventId));
  for (const event of events) {
    if (event.fromLifecycleStatus !== lifecycleStatus || event.fromEpistemicStatus !== epistemicStatus) {
      throw new Error("memory_revision_state_event_from_mismatch");
    }
    lifecycleStatus = event.toLifecycleStatus;
    epistemicStatus = event.toEpistemicStatus;
  }
  return { ...revision, lifecycleStatus, epistemicStatus };
}

function relationResolvesPair(relations: readonly FactRevisionRelation[], leftId: string, rightId: string): boolean {
  return relations.some((relation) => (
    relation.fromRevisionId === leftId && relation.toRevisionId === rightId
  ) || (
    relation.fromRevisionId === rightId && relation.toRevisionId === leftId
  ));
}

export async function buildIntrinsicStateSnapshot(input: {
  txnSnapshotSeq: number;
  revisions: readonly StatefulFactRevision[];
  relations: readonly FactRevisionRelation[];
  evidenceEdges: readonly FactRevisionEvidence[];
  supportGroups: readonly EvidenceSupportGroup[];
  stateEvents?: readonly FactRevisionStateEvent[];
  createdAtUtc: string;
}): Promise<IntrinsicStateSnapshot> {
  if (!Number.isFinite(Date.parse(input.createdAtUtc))) throw new Error("memory_snapshot_created_at_invalid");
  const visibleRevisions = input.revisions
    .filter((revision) => isVisibleAtTxn(revision, input.txnSnapshotSeq))
    .map((revision) => projectRevisionIntrinsicState(revision, input.stateEvents ?? [], input.txnSnapshotSeq))
    .sort((left, right) => left.factRevisionId.localeCompare(right.factRevisionId));
  const visibleRelations = input.relations
    .filter((relation) => isVisibleAtTxn(relation, input.txnSnapshotSeq))
    .sort((left, right) => left.relationId.localeCompare(right.relationId));
  const members = visibleRevisions.map((revision): IntrinsicRevisionSnapshotMember => ({
    factRevisionId: revision.factRevisionId,
    factKey: revision.factKey,
    revision: revision.revision,
    claimAtom: revision.claimAtom,
    epistemicStatus: revision.epistemicStatus,
    lifecycleStatus: revision.lifecycleStatus,
    validFromUtc: revision.validFromUtc,
    validToUtc: revision.validToUtc,
    validStartKind: revision.validStartKind,
    validEndKind: revision.validEndKind,
    supportCoverage: evaluateSupportCoverage({
      factRevisionId: revision.factRevisionId,
      txnSnapshotSeq: input.txnSnapshotSeq,
      evidenceEdges: input.evidenceEdges,
      supportGroups: input.supportGroups,
    }),
  }));
  const unresolvedContradictions: UnresolvedContradiction[] = [];
  for (let leftIndex = 0; leftIndex < visibleRevisions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < visibleRevisions.length; rightIndex += 1) {
      const left = visibleRevisions[leftIndex];
      const right = visibleRevisions[rightIndex];
      if (left.factKey !== right.factKey || !scopesOverlap(left.claimAtom, right.claimAtom)) continue;
      if (canonicalJson(left.claimAtom.valueJson) === canonicalJson(right.claimAtom.valueJson)) continue;
      if (revisionsOverlap(left, right) === false) continue;
      const leftCoverage = members[leftIndex].supportCoverage;
      const rightCoverage = members[rightIndex].supportCoverage;
      if (!leftCoverage.sufficient || !rightCoverage.sufficient) continue;
      if (relationResolvesPair(visibleRelations, left.factRevisionId, right.factRevisionId)) continue;
      const pair = [left.factRevisionId, right.factRevisionId].sort();
      unresolvedContradictions.push({
        contradictionId: await memoryArtifactHash("memory-unresolved-contradiction", {
          txnSnapshotSeq: input.txnSnapshotSeq,
          pair,
        }),
        leftRevisionId: pair[0],
        rightRevisionId: pair[1],
        factKey: left.factKey,
        ruleCodes: [revisionsOverlap(left, right) === null ? "VALID_TIME_OVERLAP_UNKNOWN" : "VALID_TIME_OVERLAP"],
      });
    }
  }
  const body = {
    txnSnapshotSeq: input.txnSnapshotSeq,
    members,
    relations: visibleRelations,
    unresolvedContradictions,
    snapshotVersion: MEMORY_VNEXT_GATE_C_SNAPSHOT_VERSION,
  };
  const artifactHash = await memoryArtifactHash("memory-intrinsic-state-snapshot", body);
  return {
    artifactId: `intrinsic_${artifactHash.slice(0, 32)}`,
    ...body,
    artifactHash,
    createdAtUtc: input.createdAtUtc,
  };
}
