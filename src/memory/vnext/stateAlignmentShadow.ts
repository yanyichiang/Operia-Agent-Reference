import type { Env } from "../../types";
import type { RecallResult } from "../v2/recall";
import { canonicalJson } from "../import/hashes";
import type { EvidenceSupportGroup, FactRevisionEvidence } from "./contracts";
import {
  buildIntrinsicStateSnapshot,
  type FactRevisionRelation,
  type FactRevisionStateEvent,
  type StatefulFactRevision,
} from "./gateCIntrinsicState";
import {
  buildQueryStateProjection,
  buildRevisionExpansionArtifact,
  buildTemporalTarget,
  type QueryStateProjection,
  type RequestedStateView,
  type RevisionExpansionArtifact,
  type StateAlignmentCandidate,
} from "./gateDStateAlignment";
import {
  buildRecallReceiptStateExtension,
  buildStateEvidencePacket,
  renderStateEvidencePacket,
  verifyRecallReceiptState,
  type StateEvidenceSource,
  type StatePacketGroupPlan,
} from "./gateEStatePacket";
import { memoryArtifactHash } from "./integrity";

const FACT_CAP = 16;
const PACKET_MAX_BYTES = 12_000;
const PACKET_MAX_TOKENS = 3_000;

type FactRow = {
  fact_revision_id: string;
  fact_key: string;
  revision: number;
  subject: StatefulFactRevision["claimAtom"]["subject"];
  predicate: string;
  scope: string;
  value_json: string;
  epistemic_status: StatefulFactRevision["epistemicStatus"];
  lifecycle_status: StatefulFactRevision["lifecycleStatus"];
  valid_from_utc: string | null;
  valid_to_utc: string | null;
  valid_start_kind: StatefulFactRevision["validStartKind"];
  valid_end_kind: StatefulFactRevision["validEndKind"];
  valid_time_precision: StatefulFactRevision["validTimePrecision"];
  valid_time_basis: StatefulFactRevision["validTimeBasis"];
  txn_from_seq: number;
  txn_to_seq: number | null;
  content_ref: string;
};

type RelationRow = {
  relation_id: string;
  from_revision_id: string;
  to_revision_id: string;
  relation: FactRevisionRelation["relation"];
  txn_from_seq: number;
  txn_to_seq: number | null;
  mutation_decision_id: string;
};

function flag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function stateAlignmentShadowFlags(env: Env): {
  projection: boolean;
  expansion: boolean;
  packet: boolean;
  inject: false;
} {
  if (flag(env.MEMORY_STATE_PACKET_INJECT_ENABLED)) {
    throw new Error("memory_state_packet_injection_forbidden");
  }
  return {
    projection: flag(env.MEMORY_STATE_PROJECTION_SHADOW_ENABLED),
    expansion: flag(env.MEMORY_REVISION_EXPANSION_SHADOW_ENABLED),
    packet: flag(env.MEMORY_STATE_PACKET_SHADOW_ENABLED),
    inject: false,
  };
}

export function requestedStateViewFromQuery(query: string): RequestedStateView {
  const normalized = query.normalize("NFKC").toLowerCase();
  if (/(变化|变更|改变|改成|前后|从.{0,24}(?:到|变为)|what changed|how .*changed|change from)/iu.test(normalized)) return "change";
  if (/(之前|以前|过去|当时|曾经|原来|那时候|上一次|历史上|previously|before|at the time|used to)/iu.test(normalized)) return "historical";
  if (/(现在|目前|如今|当前|截至现在|眼下|now|currently|at present)/iu.test(normalized)) return "current";
  return "unspecified";
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function toRevision(row: FactRow): StatefulFactRevision {
  return {
    factRevisionId: row.fact_revision_id,
    factKey: row.fact_key,
    revision: Number(row.revision),
    claimAtom: {
      subject: row.subject,
      predicate: row.predicate,
      scope: row.scope,
      valueJson: parseJson(row.value_json),
    },
    epistemicStatus: row.epistemic_status,
    lifecycleStatus: row.lifecycle_status,
    validFromUtc: row.valid_from_utc,
    validToUtc: row.valid_to_utc,
    validStartKind: row.valid_start_kind,
    validEndKind: row.valid_end_kind,
    validTimePrecision: row.valid_time_precision,
    validTimeBasis: row.valid_time_basis,
    txnFromSeq: Number(row.txn_from_seq),
    txnToSeq: row.txn_to_seq === null ? null : Number(row.txn_to_seq),
    namespace: "",
    contentRef: row.content_ref,
  };
}

function toRelation(row: RelationRow): FactRevisionRelation {
  return {
    relationId: row.relation_id,
    fromRevisionId: row.from_revision_id,
    toRevisionId: row.to_revision_id,
    relation: row.relation,
    txnFromSeq: Number(row.txn_from_seq),
    txnToSeq: row.txn_to_seq === null ? null : Number(row.txn_to_seq),
    mutationDecisionId: row.mutation_decision_id,
  };
}

async function readFactRows(db: D1Database, refs: string[], txnSeq: number): Promise<{ rows: FactRow[]; seedIds: string[] }> {
  const refSql = placeholders(refs.length);
  const seedResult = await db.prepare(`SELECT fact_revision_id,fact_key,revision,subject,predicate,scope,value_json,
      epistemic_status,lifecycle_status,valid_from_utc,valid_to_utc,valid_start_kind,valid_end_kind,
      valid_time_precision,valid_time_basis,txn_from_seq,txn_to_seq,content_ref
    FROM memory_fact_revisions f
    WHERE (f.fact_revision_id IN (${refSql}) OR EXISTS (
        SELECT 1 FROM memory_fact_legacy_refs legacy
        WHERE legacy.fact_revision_id=f.fact_revision_id AND legacy.legacy_memory_id IN (${refSql})
      ))
      AND txn_from_seq<=? AND (txn_to_seq IS NULL OR ?<txn_to_seq)
    ORDER BY fact_key,revision DESC LIMIT ?`)
    .bind(...refs, ...refs, txnSeq, txnSeq, FACT_CAP).all<FactRow>();
  const seedRows = seedResult.results ?? [];
  if (seedRows.length === 0) return { rows: [], seedIds: [] };
  const factKeys = [...new Set(seedRows.map((row) => row.fact_key))];
  const allResult = await db.prepare(`SELECT fact_revision_id,fact_key,revision,subject,predicate,scope,value_json,
      epistemic_status,lifecycle_status,valid_from_utc,valid_to_utc,valid_start_kind,valid_end_kind,
      valid_time_precision,valid_time_basis,txn_from_seq,txn_to_seq,content_ref
    FROM memory_fact_revisions
    WHERE fact_key IN (${placeholders(factKeys.length)})
      AND txn_from_seq<=? AND (txn_to_seq IS NULL OR ?<txn_to_seq)
    ORDER BY fact_key,revision LIMIT ?`)
    .bind(...factKeys, txnSeq, txnSeq, FACT_CAP).all<FactRow>();
  return {
    rows: allResult.results ?? [],
    seedIds: [...new Set(seedRows.map((row) => row.fact_revision_id))].sort(),
  };
}

async function readRelations(db: D1Database, ids: string[], txnSeq: number): Promise<FactRevisionRelation[]> {
  const idSql = placeholders(ids.length);
  const result = await db.prepare(`SELECT relation_id,from_revision_id,to_revision_id,relation,txn_from_seq,txn_to_seq,mutation_decision_id
    FROM memory_fact_revision_relations
    WHERE from_revision_id IN (${idSql}) AND to_revision_id IN (${idSql})
      AND txn_from_seq<=? AND (txn_to_seq IS NULL OR ?<txn_to_seq)
    ORDER BY relation_id`)
    .bind(...ids, ...ids, txnSeq, txnSeq).all<RelationRow>();
  return (result.results ?? []).map(toRelation);
}

async function readStateEvents(db: D1Database, ids: string[], txnSeq: number): Promise<FactRevisionStateEvent[]> {
  const result = await db.prepare(`SELECT event_id,fact_revision_id,txn_seq,from_lifecycle_status,to_lifecycle_status,
      from_epistemic_status,to_epistemic_status,cause_ref
    FROM memory_fact_revision_state_events WHERE fact_revision_id IN (${placeholders(ids.length)}) AND txn_seq<=?
    ORDER BY txn_seq,event_id`).bind(...ids, txnSeq).all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => ({
    eventId: String(row.event_id),
    factRevisionId: String(row.fact_revision_id),
    txnSeq: Number(row.txn_seq),
    fromLifecycleStatus: String(row.from_lifecycle_status) as FactRevisionStateEvent["fromLifecycleStatus"],
    toLifecycleStatus: String(row.to_lifecycle_status) as FactRevisionStateEvent["toLifecycleStatus"],
    fromEpistemicStatus: String(row.from_epistemic_status) as FactRevisionStateEvent["fromEpistemicStatus"],
    toEpistemicStatus: String(row.to_epistemic_status) as FactRevisionStateEvent["toEpistemicStatus"],
    causeRef: String(row.cause_ref),
  }));
}

async function readEvidence(db: D1Database, ids: string[]): Promise<{ edges: FactRevisionEvidence[]; groups: EvidenceSupportGroup[]; secretIds: Set<string> }> {
  const idSql = placeholders(ids.length);
  const edgeResult = await db.prepare(`SELECT fact_revision_id,interpretation_id,lineage_id,support_group_id,relation,
      edge_txn_from_seq,edge_txn_to_seq FROM memory_fact_revision_evidence
    WHERE fact_revision_id IN (${idSql}) ORDER BY fact_revision_id,interpretation_id,lineage_id,edge_txn_from_seq`)
    .bind(...ids).all<Record<string, unknown>>();
  const edges: FactRevisionEvidence[] = (edgeResult.results ?? []).map((row) => ({
    factRevisionId: String(row.fact_revision_id),
    interpretationId: String(row.interpretation_id),
    lineageId: String(row.lineage_id),
    supportGroupId: row.support_group_id === null ? null : String(row.support_group_id),
    relation: String(row.relation) as FactRevisionEvidence["relation"],
    edgeTxnFromSeq: Number(row.edge_txn_from_seq),
    edgeTxnToSeq: row.edge_txn_to_seq === null ? null : Number(row.edge_txn_to_seq),
  }));
  const groupIds = [...new Set(edges.flatMap((edge) => edge.supportGroupId ? [edge.supportGroupId] : []))];
  let groups: EvidenceSupportGroup[] = [];
  if (groupIds.length > 0) {
    const groupResult = await db.prepare(`SELECT g.support_group_id,g.mode,g.group_hash,m.interpretation_id,m.ordinal
      FROM memory_evidence_support_groups g JOIN memory_evidence_support_group_members m USING(support_group_id)
      WHERE g.support_group_id IN (${placeholders(groupIds.length)}) ORDER BY g.support_group_id,m.ordinal`)
      .bind(...groupIds).all<Record<string, unknown>>();
    const grouped = new Map<string, EvidenceSupportGroup>();
    for (const row of groupResult.results ?? []) {
      const id = String(row.support_group_id);
      const current = grouped.get(id) ?? {
        supportGroupId: id,
        mode: String(row.mode) as EvidenceSupportGroup["mode"],
        interpretationIds: [],
        groupHash: String(row.group_hash),
      };
      current.interpretationIds.push(String(row.interpretation_id));
      grouped.set(id, current);
    }
    groups = [...grouped.values()];
  }
  const secretResult = await db.prepare(`SELECT DISTINCT e.fact_revision_id
    FROM memory_fact_revision_evidence e
    JOIN memory_evidence_interpretations i ON i.interpretation_id=e.interpretation_id
    JOIN memory_evidence_refs r ON r.evidence_ref_id=i.evidence_ref_id
    WHERE e.fact_revision_id IN (${idSql}) AND r.sensitivity='secret'`).bind(...ids).all<{ fact_revision_id: string }>();
  return { edges, groups, secretIds: new Set((secretResult.results ?? []).map((row) => row.fact_revision_id)) };
}

async function readTombstonedIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  const result = await db.prepare(`SELECT target_ref FROM memory_tombstones
    WHERE target_kind='fact_revision' AND target_ref IN (${placeholders(ids.length)})`)
    .bind(...ids).all<{ target_ref: string }>();
  return new Set((result.results ?? []).map((row) => row.target_ref));
}

async function readEvidenceSources(db: D1Database, candidates: StateAlignmentCandidate[]): Promise<StateEvidenceSource[]> {
  const contentRefs = [...new Set(candidates.filter((candidate) => candidate.sensitivity === "normal" && !candidate.purged)
    .map((candidate) => candidate.revision.contentRef))];
  if (contentRefs.length === 0) return [];
  const result = await db.prepare(`SELECT canonical_event_id,index_eligible_text,index_view_hash
    FROM memory_index_eligible_views WHERE canonical_event_id IN (${placeholders(contentRefs.length)})`)
    .bind(...contentRefs).all<{ canonical_event_id: string; index_eligible_text: string; index_view_hash: string }>();
  const byRef = new Map((result.results ?? []).map((row) => [row.canonical_event_id, row]));
  const sources: StateEvidenceSource[] = [];
  for (const candidate of candidates) {
    const row = byRef.get(candidate.revision.contentRef);
    if (!row || candidate.sensitivity !== "normal" || candidate.purged) continue;
    sources.push({
      evidenceBundleId: `bundle_${(await memoryArtifactHash("memory-state-shadow-evidence-bundle", {
        candidateRef: candidate.candidateRef,
        sourceRevision: candidate.revision.revision,
        indexViewHash: row.index_view_hash,
      })).slice(0, 32)}`,
      candidateRef: candidate.candidateRef,
      sourceRevision: candidate.revision.revision,
      completeness: "complete",
      content: row.index_eligible_text,
    });
  }
  return sources;
}

async function buildGroupPlans(input: {
  projections: QueryStateProjection[];
  expansion: RevisionExpansionArtifact;
  relations: FactRevisionRelation[];
  contradictions: Array<{ contradictionId: string; leftRevisionId: string; rightRevisionId: string }>;
  sources: StateEvidenceSource[];
}): Promise<StatePacketGroupPlan[]> {
  const projectionByCandidate = new Map(input.projections.map((projection) => [projection.candidateRef, projection]));
  const sourceByCandidate = new Map(input.sources.map((source) => [source.candidateRef, source]));
  const grouped = new Set<string>();
  const plans: StatePacketGroupPlan[] = [];
  for (const contradiction of input.contradictions) {
    const ids = [contradiction.leftRevisionId, contradiction.rightRevisionId];
    const projections = ids.map((id) => projectionByCandidate.get(id));
    if (projections.some((item) => !item || item.queryRole === "exclude")) continue;
    ids.forEach((id) => grouped.add(id));
    plans.push({
      groupId: `group_${(await memoryArtifactHash("memory-state-shadow-dispute-group", contradiction)).slice(0, 32)}`,
      groupKind: "DISPUTE_SET",
      atomicity: "ALL_REQUIRED",
      candidateRefs: ids,
      projectionIds: projections.map((item) => item!.projectionId),
      evidenceBundleIds: ids.flatMap((id) => sourceByCandidate.get(id)?.evidenceBundleId ?? []),
      revisionRelationIds: [],
    });
  }
  if (input.expansion.requestedStateView === "change") {
    for (const relation of input.relations) {
      const ids = [relation.fromRevisionId, relation.toRevisionId];
      const projections = ids.map((id) => projectionByCandidate.get(id));
      if (projections.some((item) => !item || item.queryRole === "exclude")) continue;
      ids.forEach((id) => grouped.add(id));
      plans.push({
        groupId: `group_${(await memoryArtifactHash("memory-state-shadow-transition-group", relation)).slice(0, 32)}`,
        groupKind: "STATE_TRANSITION",
        atomicity: "ALL_REQUIRED",
        candidateRefs: ids,
        projectionIds: projections.map((item) => item!.projectionId),
        evidenceBundleIds: ids.flatMap((id) => sourceByCandidate.get(id)?.evidenceBundleId ?? []),
        revisionRelationIds: [relation.relationId],
      });
    }
  }
  for (const projection of input.projections) {
    if (projection.queryRole === "exclude" || grouped.has(projection.candidateRef)) continue;
    const source = sourceByCandidate.get(projection.candidateRef);
    plans.push({
      groupId: `group_${(await memoryArtifactHash("memory-state-shadow-singleton-group", {
        candidateRef: projection.candidateRef,
        projectionId: projection.projectionId,
      })).slice(0, 32)}`,
      groupKind: projection.queryRole === "primary" ? "PRIMARY_STATE" : "CONTEXT",
      atomicity: "ANY_SUFFICIENT",
      candidateRefs: [projection.candidateRef],
      projectionIds: [projection.projectionId],
      evidenceBundleIds: source ? [source.evidenceBundleId] : [],
      revisionRelationIds: projection.roleBasisRelationIds,
    });
  }
  return plans;
}

export async function persistStateAlignmentArtifacts(input: {
  db: D1Database;
  snapshot: Awaited<ReturnType<typeof buildIntrinsicStateSnapshot>>;
  target: ReturnType<typeof buildTemporalTarget>;
  expansion: RevisionExpansionArtifact;
  projections: QueryStateProjection[];
  packet: Awaited<ReturnType<typeof buildStateEvidencePacket>> | null;
  rendered: Awaited<ReturnType<typeof renderStateEvidencePacket>> | null;
  receipt: ReturnType<typeof buildRecallReceiptStateExtension> | null;
}): Promise<void> {
  const now = input.snapshot.createdAtUtc;
  const statements: D1PreparedStatement[] = [
    input.db.prepare(`INSERT OR IGNORE INTO memory_intrinsic_state_snapshots(
      artifact_id,txn_snapshot_seq,member_count,relation_count,contradiction_count,snapshot_version,artifact_hash,shadow_only,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(input.snapshot.artifactId,input.snapshot.txnSnapshotSeq,input.snapshot.members.length,
      input.snapshot.relations.length,input.snapshot.unresolvedContradictions.length,input.snapshot.snapshotVersion,input.snapshot.artifactHash,1,now),
    input.db.prepare(`INSERT OR IGNORE INTO memory_temporal_targets(
      run_id,query_plan_hash,txn_snapshot_seq,requested_state_view,reference_time_utc,owner_time_zone,
      target_valid_from_utc,target_valid_to_utc,target_time_precision,basis,shadow_only,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,?)`).bind(input.expansion.runId,input.expansion.queryPlanHash,input.expansion.txnSnapshotSeq,
      input.target.requestedStateView,input.target.referenceTimeUtc,input.target.ownerTimeZone,input.target.targetValidFromUtc,
      input.target.targetValidToUtc,input.target.targetTimePrecision,input.target.basis,now),
  ];
  for (const member of input.snapshot.members) {
    statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_intrinsic_state_snapshot_members(
      artifact_id,fact_revision_id,fact_key,source_revision,claim_atom_json,lifecycle_status,epistemic_status,
      support_coverage_json,member_hash) VALUES(?,?,?,?,?,?,?,?,?)`).bind(input.snapshot.artifactId,member.factRevisionId,
      member.factKey,member.revision,canonicalJson(member.claimAtom),member.lifecycleStatus,member.epistemicStatus,
      canonicalJson(member.supportCoverage),await memoryArtifactHash("memory-intrinsic-snapshot-member",member)));
  }
  for (const relation of input.snapshot.relations) {
    statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_intrinsic_state_snapshot_relations(
      artifact_id,relation_id,relation,from_revision_id,to_revision_id) VALUES(?,?,?,?,?)`)
      .bind(input.snapshot.artifactId,relation.relationId,relation.relation,relation.fromRevisionId,relation.toRevisionId));
  }
  for (const contradiction of input.snapshot.unresolvedContradictions) {
    statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_unresolved_contradictions(
      artifact_id,contradiction_id,fact_key,left_revision_id,right_revision_id,rule_codes_json) VALUES(?,?,?,?,?,?)`)
      .bind(input.snapshot.artifactId,contradiction.contradictionId,contradiction.factKey,contradiction.leftRevisionId,
        contradiction.rightRevisionId,canonicalJson(contradiction.ruleCodes)));
  }
  statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_revision_expansion_artifacts(
    artifact_id,run_id,query_plan_hash,txn_snapshot_seq,requested_state_view,seed_candidate_refs_json,hop_limit,
    candidate_cap,completeness,expansion_version,artifact_hash,shadow_only,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)`)
    .bind(input.expansion.artifactId,input.expansion.runId,input.expansion.queryPlanHash,input.expansion.txnSnapshotSeq,
      input.expansion.requestedStateView,canonicalJson(input.expansion.seedCandidateRefs),input.expansion.hopLimit,
      input.expansion.candidateCap,input.expansion.completeness,input.expansion.expansionVersion,input.expansion.artifactHash,now));
  input.expansion.traversedRelations.forEach((item,index) => statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_revision_expansion_traversals(
    artifact_id,ordinal,relation_id,relation,from_revision_id,to_revision_id,direction,root_seed_ref,rule_code)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(input.expansion.artifactId,index,item.relationId,item.relation,item.fromRevisionId,
    item.toRevisionId,item.direction,item.rootSeedRef,item.ruleCode)));
  input.expansion.addedCandidates.forEach((item,index) => statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_revision_expansion_added(
    artifact_id,ordinal,candidate_ref,source_revision,root_seed_ref,relation_id,basis_kind,expansion_reason,deterministic_floor)
    VALUES(?,?,?,?,?,?,?, ?,1)`).bind(input.expansion.artifactId,index,item.candidateRef,item.sourceRevision,item.rootSeedRef,
    item.relationId,item.expansionReason === "material_contradiction" ? "unresolved_contradiction" : "revision_relation",item.expansionReason)));
  input.expansion.omittedCandidates.forEach((item,index) => statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_revision_expansion_omitted(
    artifact_id,ordinal,candidate_ref,reason) VALUES(?,?,?,?)`).bind(input.expansion.artifactId,index,item.candidateRef,item.reason)));
  for (const projection of input.projections) {
    statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_query_state_projections(
      projection_id,run_id,query_plan_hash,txn_snapshot_seq,candidate_ref,source_revision,claim_atom_id,requested_state_view,
      intrinsic_lifecycle_status,intrinsic_epistemic_status,query_role,evidence_polarity,valid_time_fit,
      role_basis_revision_ids_json,role_basis_relation_ids_json,rule_codes_json,projection_version,artifact_hash,shadow_only,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`).bind(projection.projectionId,projection.runId,projection.queryPlanHash,
      projection.txnSnapshotSeq,projection.candidateRef,projection.sourceRevision,projection.claimAtomId,projection.requestedStateView,
      projection.intrinsicLifecycleStatus,projection.intrinsicEpistemicStatus,projection.queryRole,projection.evidencePolarity,
      projection.validTimeFit,canonicalJson(projection.roleBasisRevisionIds),canonicalJson(projection.roleBasisRelationIds),
      canonicalJson(projection.ruleCodes),projection.projectionVersion,projection.artifactHash,now));
  }
  if (input.packet && input.rendered && input.receipt) {
    statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_state_evidence_packets(
      packet_id,run_id,query_plan_hash,txn_snapshot_seq,requested_state_view,packet_version,packet_hash,total_bytes,
      estimated_tokens,shadow_only,injection_enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,0,?)`).bind(input.packet.packetId,
      input.packet.runId,input.packet.queryPlanHash,input.packet.txnSnapshotSeq,input.packet.requestedStateView,input.packet.packetVersion,
      input.packet.packetHash,input.packet.totalBytes,input.packet.estimatedTokens,now));
    for (const [index,group] of input.packet.groups.entries()) {
      statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_state_evidence_packet_groups(
        packet_id,group_id,ordinal,group_kind,atomicity,candidate_refs_json,projection_ids_json,evidence_bundle_ids_json,
        revision_relation_ids_json,included,completeness,omission_reason,group_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(input.packet.packetId,group.groupId,index,group.groupKind,group.atomicity,canonicalJson(group.candidateRefs),
          canonicalJson(group.projectionIds),canonicalJson(group.evidenceBundleIds),canonicalJson(group.revisionRelationIds),
          group.included ? 1 : 0,group.completeness,group.omissionReason,group.groupHash));
      if (group.included) {
        group.projectionIds.forEach((projectionId,ordinal) => {
          const projection = input.projections.find((item) => item.projectionId === projectionId)!;
          const sourceRef = input.receipt!.orderedStateInjections.find((item) => item.projectionId === projectionId && item.packetGroupId === group.groupId)?.sourceRef;
          if (!sourceRef) return;
          statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_state_evidence_packet_members(
            packet_id,group_id,ordinal,candidate_ref,projection_id,evidence_bundle_id,source_revision) VALUES(?,?,?,?,?,?,?)`)
            .bind(input.packet!.packetId,group.groupId,ordinal,projection.candidateRef,projectionId,sourceRef,projection.sourceRevision));
        });
      }
    }
    const renderId = `render_${input.rendered.renderedHash.slice(0, 32)}`;
    statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_state_packet_render_artifacts(
      render_id,packet_id,renderer_version,rendered_hash,rendered_bytes,shadow_only,created_at) VALUES(?,?,?,?,?,1,?)`)
      .bind(renderId,input.packet.packetId,input.rendered.rendererVersion,input.rendered.renderedHash,
        new TextEncoder().encode(input.rendered.rendered).byteLength,now));
    const receiptHash = await memoryArtifactHash("memory-recall-receipt-state-extension",input.receipt);
    const receiptId = `state_receipt_${receiptHash.slice(0, 32)}`;
    statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_recall_receipt_state_extensions(
      receipt_id,run_id,query_plan_hash,txn_snapshot_seq,requested_state_view,revision_expansion_artifact_id,
      query_state_projection_ids_json,state_evidence_packet_id,render_id,receipt_hash,shadow_only,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,?)`).bind(receiptId,input.packet.runId,input.packet.queryPlanHash,input.packet.txnSnapshotSeq,
      input.packet.requestedStateView,input.expansion.artifactId,canonicalJson(input.receipt.queryStateProjectionIds),
      input.packet.packetId,renderId,receiptHash,now));
    for (const item of input.receipt.orderedStateInjections) {
      statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_recall_receipt_state_injections(
        receipt_id,injection_order,source_ref,source_revision,projection_id,packet_id,packet_group_id,
        requested_state_view,query_role,evidence_polarity,rendered_fragment_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(receiptId,item.order,item.sourceRef,item.sourceRevision,item.projectionId,input.packet.packetId,item.packetGroupId,
          item.requestedStateView,item.queryRole,item.evidencePolarity,item.renderedFragmentHash));
    }
  }
  await input.db.batch(statements);
}

export async function persistStateAlignmentShadow(env: Env, input: {
  namespace: string;
  query: string;
  recall: RecallResult | null;
}): Promise<void> {
  const flags = stateAlignmentShadowFlags(env);
  if (!flags.projection && !flags.expansion && !flags.packet) return;
  if (!flags.projection || !flags.expansion || (flags.packet && (!flags.projection || !flags.expansion))) {
    throw new Error("memory_state_shadow_flag_dependency_invalid");
  }
  const trace = input.recall?.trace;
  if (!trace) return;
  const refs = [...new Set(trace.candidates.filter((candidate) => candidate.decision === "selected_for_assembly")
    .map((candidate) => candidate.candidate_ref))].slice(0, FACT_CAP);
  if (refs.length === 0) return;
  const clock = await env.DB.prepare("SELECT last_seq FROM memory_txn_clock WHERE singleton=1").first<{ last_seq: number }>();
  const txnSeq = Number(clock?.last_seq ?? 0);
  if (!Number.isSafeInteger(txnSeq) || txnSeq < 1) {
    console.info("memory state alignment shadow skipped", { code: "state_bank_empty", run_id: trace.run.id });
    return;
  }
  const factRead = await readFactRows(env.DB, refs, txnSeq);
  if (factRead.rows.length === 0 || factRead.seedIds.length === 0) {
    console.info("memory state alignment shadow skipped", { code: "no_vnext_seed_match", run_id: trace.run.id });
    return;
  }
  const revisions = factRead.rows.map((row) => ({ ...toRevision(row), namespace: input.namespace }));
  const ids = revisions.map((revision) => revision.factRevisionId);
  const [allRelations,allStateEvents,evidence,tombstonedIds] = await Promise.all([
    readRelations(env.DB,ids,txnSeq),readStateEvents(env.DB,ids,txnSeq),readEvidence(env.DB,ids),readTombstonedIds(env.DB,ids),
  ]);
  const eligibleRevisions = revisions.filter((revision) => !evidence.secretIds.has(revision.factRevisionId)
    && !tombstonedIds.has(revision.factRevisionId));
  const eligibleIds = new Set(eligibleRevisions.map((revision) => revision.factRevisionId));
  const eligibleSeedIds = factRead.seedIds.filter((id) => eligibleIds.has(id));
  if (eligibleRevisions.length === 0 || eligibleSeedIds.length === 0) {
    console.info("memory state alignment shadow skipped", { code: "no_safe_vnext_seed", run_id: trace.run.id });
    return;
  }
  const relations = allRelations.filter((relation) => eligibleIds.has(relation.fromRevisionId) && eligibleIds.has(relation.toRevisionId));
  const stateEvents = allStateEvents.filter((event) => eligibleIds.has(event.factRevisionId));
  const evidenceEdges = evidence.edges.filter((edge) => eligibleIds.has(edge.factRevisionId));
  const now = new Date().toISOString();
  const snapshot = await buildIntrinsicStateSnapshot({
    txnSnapshotSeq: txnSeq,revisions:eligibleRevisions,relations,evidenceEdges,supportGroups:evidence.groups,stateEvents,createdAtUtc:now,
  });
  const candidateById = new Map<string, StateAlignmentCandidate>();
  for (const revision of eligibleRevisions) {
    const member = snapshot.members.find((item) => item.factRevisionId === revision.factRevisionId);
    if (!member) continue;
    const projectedRevision = {
      ...revision,
      lifecycleStatus: member.lifecycleStatus,
      epistemicStatus: member.epistemicStatus,
    };
    candidateById.set(revision.factRevisionId, {
      candidateRef: revision.factRevisionId,
      revision: projectedRevision,
      intrinsicSnapshotMember: member,
      namespace: input.namespace,
      authorityBoundary: ["owner","operia","relationship"].includes(projectedRevision.claimAtom.subject) ? "protected" : "ordinary",
      protectedVisibility: "owner",
      sensitivity: "normal",
      purged: false,
    });
  }
  const candidates = [...candidateById.values()];
  const requestedStateView = requestedStateViewFromQuery(input.query);
  const target = buildTemporalTarget({
    temporalIntent: requestedStateView,referenceTimeUtc:trace.run.started_at_utc,ownerTimeZone:env.MEMORY_STATE_OWNER_TIME_ZONE?.trim() || "<YOUR_TIMEZONE>",
    basis: requestedStateView === "unspecified" ? "unspecified" : requestedStateView === "current" ? "current_request_time" : "query_explicit",
  });
  const queryPlanHash = await memoryArtifactHash("memory-state-shadow-query-plan", {
    runId: trace.run.id,queryHash: trace.run.query_hash,policyVersion: trace.run.policy_version,indexVersion: trace.run.index_version,
    txnSnapshotSeq: txnSeq,requestedStateView,
  });
  const expansion = await buildRevisionExpansionArtifact({
    runId:trace.run.id,queryPlanHash,txnSnapshotSeq:txnSeq,temporalTarget:target,seedCandidateRefs:eligibleSeedIds,
    candidates,relations,materialContradictions:snapshot.unresolvedContradictions,createdAtUtc:now,
  });
  const retained = new Set([...expansion.seedCandidateRefs,...expansion.addedCandidates.map((item) => item.candidateRef)]);
  const projections = await Promise.all(candidates.filter((candidate) => retained.has(candidate.candidateRef)).map((candidate) =>
    buildQueryStateProjection({runId:trace.run.id,queryPlanHash,txnSnapshotSeq:txnSeq,temporalTarget:target,candidate,
      seedCandidateRefs:expansion.seedCandidateRefs,relations,createdAtUtc:now})));
  let packet: Awaited<ReturnType<typeof buildStateEvidencePacket>> | null = null;
  let rendered: Awaited<ReturnType<typeof renderStateEvidencePacket>> | null = null;
  let receipt: ReturnType<typeof buildRecallReceiptStateExtension> | null = null;
  if (flags.packet) {
    const packetCandidates = candidates.filter((candidate) => retained.has(candidate.candidateRef));
    const sources = await readEvidenceSources(env.DB,packetCandidates);
    const groupPlans = await buildGroupPlans({projections,expansion,relations,contradictions:snapshot.unresolvedContradictions,sources});
    packet = await buildStateEvidencePacket({runId:trace.run.id,queryPlanHash,txnSnapshotSeq:txnSeq,
      requestedStateView:target.requestedStateView,groupPlans,projections,evidenceSources:sources,
      availableRevisionRelationIds:relations.map((relation) => relation.relationId),maxBytes:PACKET_MAX_BYTES,
      maxEstimatedTokens:PACKET_MAX_TOKENS,createdAtUtc:now});
    rendered = await renderStateEvidencePacket({packet,projections,evidenceSources:sources});
    receipt = buildRecallReceiptStateExtension({packet,expansion,projections,rendered});
    const verified = verifyRecallReceiptState({receipt,packet,expansion,projections,rendered});
    if (!verified.ok) throw new Error(`memory_state_shadow_receipt_invalid:${verified.mismatchCodes.join(",")}`);
  }
  await persistStateAlignmentArtifacts({db:env.DB,snapshot,target,expansion,projections,packet,rendered,receipt});
}
