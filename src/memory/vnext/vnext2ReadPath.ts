import type { Env } from "../../types";
import {
  hydrateEpisodicCandidatesStructurally,
  MEMORY_STRUCTURAL_HYDRATION_VERSION,
  type EpisodicCandidate,
  type StructurallyHydratedEpisodicCandidate,
} from "../episodic";
import { canonicalJson } from "../import/hashes";
import type { EvidenceSupportGroup, FactRevisionEvidence } from "./contracts";
import { buildEvidenceBundle,persistEvidenceBundle,type EvidenceBundle } from "./evidenceBundleBuilder";
import {
  buildIntrinsicStateSnapshot,
  type FactRevisionRelation,
  type FactRevisionStateEvent,
  type IntrinsicStateSnapshot,
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
  type TemporalTarget,
} from "./gateDStateAlignment";
import { memoryArtifactHash } from "./integrity";
import { persistStateAlignmentArtifacts,requestedStateViewFromQuery } from "./stateAlignmentShadow";

export const MEMORY_VNEXT_READ_PATH_VERSION = "memory-vnext-read-path-v2.0.0";
const FACT_CANDIDATE_CAP = 32;

export type VNextFactLaneSeed = {
  legacyMemoryId: string;
  retrievalScore: number;
  retrievalRank: number;
};

export type VNextReadCandidate = {
  candidateRef: string;
  sourceLane: "fact_revision" | "episodic";
  sourceRevision: number | null;
  rootSeedRef: string | null;
  retrievalScore: number;
  queryRole: QueryStateProjection["queryRole"] | null;
  deterministicFloor: boolean;
  lineageCollapseKey: string | null;
  fusionRank: number | null;
  selected: boolean;
  decisionCode: string;
};

export type VNextReadPathResult = {
  runId: string;
  queryPlanHash: string;
  txnSnapshotSeq: number;
  requestedStateView: RequestedStateView;
  temporalTarget: TemporalTarget;
  snapshot: IntrinsicStateSnapshot;
  expansion: RevisionExpansionArtifact;
  projections: QueryStateProjection[];
  candidates: VNextReadCandidate[];
  evidenceBundles: EvidenceBundle[];
  episodic: StructurallyHydratedEpisodicCandidate[];
  artifactHash: string;
};

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

type SeedMappingRow = FactRow & { legacy_memory_id: string };

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function toRevision(row: FactRow,namespace: string): StatefulFactRevision {
  return {
    factRevisionId: row.fact_revision_id,
    factKey: row.fact_key,
    revision: Number(row.revision),
    claimAtom: {
      subject: row.subject,
      predicate: row.predicate,
      scope: row.scope,
      valueJson: JSON.parse(row.value_json) as unknown,
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
    namespace,
    contentRef: row.content_ref,
  };
}

async function readFactBank(input: {
  db: D1Database;
  namespace: string;
  seeds: readonly VNextFactLaneSeed[];
  txnSnapshotSeq: number;
}): Promise<{
  revisions: StatefulFactRevision[];
  seedFactIds: string[];
  seedScores: Map<string,number>;
}> {
  if (input.seeds.length === 0) return { revisions: [],seedFactIds: [],seedScores: new Map() };
  const ids = [...new Set(input.seeds.map((seed) => seed.legacyMemoryId))];
  const seedRows = (await input.db.prepare(`SELECT legacy.legacy_memory_id,f.fact_revision_id,f.fact_key,f.revision,
      f.subject,f.predicate,f.scope,f.value_json,f.epistemic_status,f.lifecycle_status,f.valid_from_utc,
      f.valid_to_utc,f.valid_start_kind,f.valid_end_kind,f.valid_time_precision,f.valid_time_basis,
      f.txn_from_seq,f.txn_to_seq,f.content_ref
    FROM memory_fact_legacy_refs legacy
    JOIN memory_fact_revisions f ON f.fact_revision_id=legacy.fact_revision_id
    WHERE legacy.namespace=? AND legacy.legacy_memory_id IN (${placeholders(ids.length)})
      AND f.txn_from_seq<=? AND (f.txn_to_seq IS NULL OR ?<f.txn_to_seq)
    ORDER BY f.fact_key,f.revision`)
    .bind(input.namespace,...ids,input.txnSnapshotSeq,input.txnSnapshotSeq).all<SeedMappingRow>()).results ?? [];
  if (seedRows.length === 0) return { revisions: [],seedFactIds: [],seedScores: new Map() };
  const factKeys = [...new Set(seedRows.map((row) => row.fact_key))];
  const rows = (await input.db.prepare(`SELECT fact_revision_id,fact_key,revision,subject,predicate,scope,value_json,
      epistemic_status,lifecycle_status,valid_from_utc,valid_to_utc,valid_start_kind,valid_end_kind,
      valid_time_precision,valid_time_basis,txn_from_seq,txn_to_seq,content_ref
    FROM memory_fact_revisions
    WHERE fact_key IN (${placeholders(factKeys.length)})
      AND txn_from_seq<=? AND (txn_to_seq IS NULL OR ?<txn_to_seq)
    ORDER BY fact_key,revision LIMIT ?`)
    .bind(...factKeys,input.txnSnapshotSeq,input.txnSnapshotSeq,FACT_CANDIDATE_CAP).all<FactRow>()).results ?? [];
  const scoreByLegacy = new Map(input.seeds.map((seed) => [seed.legacyMemoryId,seed.retrievalScore]));
  const seedScores = new Map<string,number>();
  for (const row of seedRows) {
    seedScores.set(row.fact_revision_id,Math.max(seedScores.get(row.fact_revision_id) ?? Number.NEGATIVE_INFINITY,
      scoreByLegacy.get(row.legacy_memory_id) ?? 0));
  }
  return {
    revisions: rows.map((row) => toRevision(row,input.namespace)),
    seedFactIds: [...seedScores.keys()].sort(),
    seedScores,
  };
}

async function readRelations(db: D1Database,ids: readonly string[],txnSnapshotSeq: number): Promise<FactRevisionRelation[]> {
  if (ids.length === 0) return [];
  const result = await db.prepare(`SELECT relation_id,from_revision_id,to_revision_id,relation,txn_from_seq,
      txn_to_seq,mutation_decision_id FROM memory_fact_revision_relations
    WHERE from_revision_id IN (${placeholders(ids.length)}) AND to_revision_id IN (${placeholders(ids.length)})
      AND txn_from_seq<=? AND (txn_to_seq IS NULL OR ?<txn_to_seq)
    ORDER BY relation_id`).bind(...ids,...ids,txnSnapshotSeq,txnSnapshotSeq).all<Record<string,unknown>>();
  return (result.results ?? []).map((row) => ({
    relationId: String(row.relation_id),fromRevisionId: String(row.from_revision_id),
    toRevisionId: String(row.to_revision_id),relation: String(row.relation) as FactRevisionRelation["relation"],
    txnFromSeq: Number(row.txn_from_seq),txnToSeq: row.txn_to_seq === null ? null : Number(row.txn_to_seq),
    mutationDecisionId: String(row.mutation_decision_id),
  }));
}

async function readStateEvents(db: D1Database,ids: readonly string[],txnSnapshotSeq: number): Promise<FactRevisionStateEvent[]> {
  if (ids.length === 0) return [];
  const result = await db.prepare(`SELECT event_id,fact_revision_id,txn_seq,from_lifecycle_status,to_lifecycle_status,
      from_epistemic_status,to_epistemic_status,cause_ref FROM memory_fact_revision_state_events
    WHERE fact_revision_id IN (${placeholders(ids.length)}) AND txn_seq<=? ORDER BY txn_seq,event_id`)
    .bind(...ids,txnSnapshotSeq).all<Record<string,unknown>>();
  return (result.results ?? []).map((row) => ({
    eventId: String(row.event_id),factRevisionId: String(row.fact_revision_id),txnSeq: Number(row.txn_seq),
    fromLifecycleStatus: String(row.from_lifecycle_status) as FactRevisionStateEvent["fromLifecycleStatus"],
    toLifecycleStatus: String(row.to_lifecycle_status) as FactRevisionStateEvent["toLifecycleStatus"],
    fromEpistemicStatus: String(row.from_epistemic_status) as FactRevisionStateEvent["fromEpistemicStatus"],
    toEpistemicStatus: String(row.to_epistemic_status) as FactRevisionStateEvent["toEpistemicStatus"],
    causeRef: String(row.cause_ref),
  }));
}

async function readEvidence(input: {
  db: D1Database;
  ids: readonly string[];
  txnSnapshotSeq: number;
}): Promise<{ edges: FactRevisionEvidence[]; groups: EvidenceSupportGroup[]; excludedFactIds: Set<string>; lineageKeys: Map<string,string> }> {
  if (input.ids.length === 0) return { edges: [],groups: [],excludedFactIds: new Set(),lineageKeys: new Map() };
  const result = await input.db.prepare(`SELECT fact_revision_id,interpretation_id,lineage_id,support_group_id,relation,
      edge_txn_from_seq,edge_txn_to_seq FROM memory_fact_revision_evidence
    WHERE fact_revision_id IN (${placeholders(input.ids.length)})
      AND edge_txn_from_seq<=? AND (edge_txn_to_seq IS NULL OR ?<edge_txn_to_seq)
    ORDER BY fact_revision_id,interpretation_id,lineage_id,edge_txn_from_seq`)
    .bind(...input.ids,input.txnSnapshotSeq,input.txnSnapshotSeq).all<Record<string,unknown>>();
  const edges: FactRevisionEvidence[] = (result.results ?? []).map((row) => ({
    factRevisionId: String(row.fact_revision_id),interpretationId: String(row.interpretation_id),
    lineageId: String(row.lineage_id),supportGroupId: row.support_group_id === null ? null : String(row.support_group_id),
    relation: String(row.relation) as FactRevisionEvidence["relation"],edgeTxnFromSeq: Number(row.edge_txn_from_seq),
    edgeTxnToSeq: row.edge_txn_to_seq === null ? null : Number(row.edge_txn_to_seq),
  }));
  const groupIds = [...new Set(edges.flatMap((edge) => edge.supportGroupId ? [edge.supportGroupId] : []))];
  const groupsById = new Map<string,EvidenceSupportGroup>();
  if (groupIds.length > 0) {
    const groups = await input.db.prepare(`SELECT g.support_group_id,g.mode,g.group_hash,m.interpretation_id,m.ordinal
      FROM memory_evidence_support_groups g JOIN memory_evidence_support_group_members m USING(support_group_id)
      WHERE g.support_group_id IN (${placeholders(groupIds.length)}) ORDER BY g.support_group_id,m.ordinal`)
      .bind(...groupIds).all<Record<string,unknown>>();
    for (const row of groups.results ?? []) {
      const id = String(row.support_group_id);
      const current = groupsById.get(id) ?? {
        supportGroupId: id,mode: String(row.mode) as EvidenceSupportGroup["mode"],
        interpretationIds: [],groupHash: String(row.group_hash),
      };
      current.interpretationIds.push(String(row.interpretation_id));
      groupsById.set(id,current);
    }
  }
  const exclusionResult = await input.db.prepare(`SELECT target_id FROM memory_retrieval_exclusions
    WHERE target_kind='fact_revision' AND target_id IN (${placeholders(input.ids.length)})
      AND txn_from_seq<=? AND (txn_to_seq IS NULL OR ?<txn_to_seq)`)
    .bind(...input.ids,input.txnSnapshotSeq,input.txnSnapshotSeq).all<{ target_id: string }>();
  const secretResult = await input.db.prepare(`SELECT DISTINCT e.fact_revision_id FROM memory_fact_revision_evidence e
    JOIN memory_evidence_interpretations i ON i.interpretation_id=e.interpretation_id
    JOIN memory_evidence_refs r ON r.evidence_ref_id=i.evidence_ref_id
    WHERE e.fact_revision_id IN (${placeholders(input.ids.length)}) AND r.sensitivity='secret'`)
    .bind(...input.ids).all<{ fact_revision_id: string }>();
  const excludedFactIds = new Set([
    ...(exclusionResult.results ?? []).map((row) => row.target_id),
    ...(secretResult.results ?? []).map((row) => row.fact_revision_id),
  ]);
  const lineagesByFact = new Map<string,string[]>();
  for (const edge of edges.filter((item) => item.relation === "SUPPORTS" || item.relation === "CONFIRMS")) {
    const current = lineagesByFact.get(edge.factRevisionId) ?? [];
    current.push(edge.lineageId);
    lineagesByFact.set(edge.factRevisionId,current);
  }
  const lineageKeys = new Map<string,string>();
  for (const [factId,lineages] of lineagesByFact) lineageKeys.set(factId,[...new Set(lineages)].sort().join("|"));
  return { edges,groups: [...groupsById.values()],excludedFactIds,lineageKeys };
}

function rolePriority(role: QueryStateProjection["queryRole"] | null): number {
  return role === "primary" ? 0 : role === "trajectory" ? 1 : role === "contrast" ? 2 : role === "context" ? 3 : 4;
}

async function persistReadArtifacts(input: {
  env: Env;
  result: VNextReadPathResult;
  namespaceHash: string;
  queryHash: string;
  shadowOnly: boolean;
  createdAtUtc: string;
}): Promise<void> {
  const { result } = input;
  const statements: D1PreparedStatement[] = [input.env.DB.prepare(`INSERT OR IGNORE INTO memory_vnext_read_runs(
    run_id,namespace_hash,query_hash,query_plan_hash,txn_snapshot_seq,requested_state_view,seed_count,expanded_count,
    projected_count,selected_count,deterministic_floor_count,read_path_version,shadow_only,artifact_hash,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    result.runId,input.namespaceHash,input.queryHash,result.queryPlanHash,result.txnSnapshotSeq,result.requestedStateView,
    result.expansion.seedCandidateRefs.length,result.expansion.addedCandidates.length,result.projections.length,
    result.candidates.filter((item) => item.selected).length,result.candidates.filter((item) => item.deterministicFloor).length,
    MEMORY_VNEXT_READ_PATH_VERSION,input.shadowOnly ? 1 : 0,result.artifactHash,input.createdAtUtc,
  )];
  for (const item of result.candidates) {
    statements.push(input.env.DB.prepare(`INSERT OR IGNORE INTO memory_vnext_read_candidates(
      run_id,candidate_ref,source_lane,source_revision,root_seed_ref,retrieval_score,query_role,deterministic_floor,
      lineage_collapse_key,fusion_rank,selected,decision_code
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      result.runId,item.candidateRef,item.sourceLane,item.sourceRevision,item.rootSeedRef,item.retrievalScore,item.queryRole,
      item.deterministicFloor ? 1 : 0,item.lineageCollapseKey,item.fusionRank,item.selected ? 1 : 0,item.decisionCode,
    ));
  }
  for (const item of result.episodic) {
    const body = {
      runId: result.runId,candidateRef: item.id,targetCanonicalEventId: item.canonical_message_id,
      hydratedEventRefs: item.hydrated_event_refs,structuralEdgeIds: item.structural_edge_ids,targetOnly: item.target_only,
      policyVersion: MEMORY_STRUCTURAL_HYDRATION_VERSION,
    };
    const receiptHash = await memoryArtifactHash("memory-structural-hydration-receipt-v2",body);
    statements.push(input.env.DB.prepare(`INSERT OR IGNORE INTO memory_structural_hydration_receipts_v2(
      receipt_id,run_id,episodic_candidate_ref,target_canonical_event_id,hydrated_event_refs_json,
      structural_edge_ids_json,target_only,policy_version,receipt_hash,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
      `shr_${receiptHash.slice(0,32)}`,result.runId,item.id,item.canonical_message_id,
      canonicalJson(item.hydrated_event_refs),canonicalJson(item.structural_edge_ids),item.target_only ? 1 : 0,
      MEMORY_STRUCTURAL_HYDRATION_VERSION,receiptHash,input.createdAtUtc,
    ));
  }
  await input.env.DB.batch(statements);
  for (const bundle of result.evidenceBundles) {
    await persistEvidenceBundle({ db: input.env.DB,runId: result.runId,bundle,createdAtUtc: input.createdAtUtc });
  }
}

export async function runVNext2ReadPath(input: {
  env: Env;
  runId: string;
  namespace: string;
  namespaceHash: string;
  query: string;
  queryHash: string;
  startedAtUtc: string;
  factSeeds: readonly VNextFactLaneSeed[];
  episodicSeeds: readonly EpisodicCandidate[];
  maxSelected: number;
  shadowOnly: boolean;
}): Promise<VNextReadPathResult | null> {
  if (!Number.isSafeInteger(input.maxSelected) || input.maxSelected < 1) throw new Error("memory_vnext_read_top_k_invalid");
  const clock = await input.env.DB.prepare("SELECT last_seq FROM memory_txn_clock WHERE singleton=1")
    .first<{ last_seq: number }>();
  const txnSnapshotSeq = Number(clock?.last_seq ?? 0);
  if (!Number.isSafeInteger(txnSnapshotSeq) || txnSnapshotSeq < 1) return null;
  const bank = await readFactBank({
    db: input.env.DB,namespace: input.namespace,seeds: input.factSeeds,txnSnapshotSeq,
  });
  if ((bank.revisions.length === 0 || bank.seedFactIds.length === 0) && input.episodicSeeds.length === 0) return null;
  const ids = bank.revisions.map((revision) => revision.factRevisionId);
  const [relations,stateEvents,evidence,episodic] = await Promise.all([
    readRelations(input.env.DB,ids,txnSnapshotSeq),
    readStateEvents(input.env.DB,ids,txnSnapshotSeq),
    readEvidence({ db: input.env.DB,ids,txnSnapshotSeq }),
    hydrateEpisodicCandidatesStructurally(input.env.DB,input.namespace,[...input.episodicSeeds]),
  ]);
  const eligibleRevisions = bank.revisions.filter((revision) => !evidence.excludedFactIds.has(revision.factRevisionId));
  const eligibleIds = new Set(eligibleRevisions.map((revision) => revision.factRevisionId));
  const seedFactIds = bank.seedFactIds.filter((id) => eligibleIds.has(id));
  if ((eligibleRevisions.length === 0 || seedFactIds.length === 0) && episodic.length === 0) return null;
  const eligibleRelations = relations.filter((relation) => eligibleIds.has(relation.fromRevisionId)
    && eligibleIds.has(relation.toRevisionId));
  const createdAtUtc = new Date().toISOString();
  const snapshot = await buildIntrinsicStateSnapshot({
    txnSnapshotSeq,revisions: eligibleRevisions,relations: eligibleRelations,
    evidenceEdges: evidence.edges.filter((edge) => eligibleIds.has(edge.factRevisionId)),
    supportGroups: evidence.groups,stateEvents: stateEvents.filter((event) => eligibleIds.has(event.factRevisionId)),createdAtUtc,
  });
  const candidateById = new Map<string,StateAlignmentCandidate>();
  for (const revision of eligibleRevisions) {
    const member = snapshot.members.find((item) => item.factRevisionId === revision.factRevisionId);
    if (!member) continue;
    candidateById.set(revision.factRevisionId,{
      candidateRef: revision.factRevisionId,
      revision: { ...revision,lifecycleStatus: member.lifecycleStatus,epistemicStatus: member.epistemicStatus },
      intrinsicSnapshotMember: member,namespace: input.namespace,
      authorityBoundary: ["owner","operia","relationship"].includes(revision.claimAtom.subject) ? "protected" : "ordinary",
      protectedVisibility: "owner",sensitivity: "normal",purged: false,
    });
  }
  const requestedStateView = requestedStateViewFromQuery(input.query);
  const temporalTarget = buildTemporalTarget({
    temporalIntent: requestedStateView,referenceTimeUtc: input.startedAtUtc,
    ownerTimeZone: input.env.MEMORY_STATE_OWNER_TIME_ZONE?.trim() || "<YOUR_TIMEZONE>",
    basis: requestedStateView === "unspecified" ? "unspecified"
      : requestedStateView === "current" ? "current_request_time" : "query_explicit",
  });
  const queryPlanHash = await memoryArtifactHash("memory-vnext2-query-plan",{
    runId: input.runId,queryHash: input.queryHash,txnSnapshotSeq,requestedStateView,
    factSeedRefs: seedFactIds,episodicSeedRefs: episodic.map((item) => item.id),
  });
  const candidates = [...candidateById.values()];
  const expansion = await buildRevisionExpansionArtifact({
    runId: input.runId,queryPlanHash,txnSnapshotSeq,temporalTarget,seedCandidateRefs: seedFactIds,
    candidates,relations: eligibleRelations,materialContradictions: snapshot.unresolvedContradictions,
    candidateCap: FACT_CANDIDATE_CAP,createdAtUtc,
  });
  const retainedIds = new Set([...expansion.seedCandidateRefs,...expansion.addedCandidates.map((item) => item.candidateRef)]);
  const projections = await Promise.all(candidates.filter((candidate) => retainedIds.has(candidate.candidateRef)).map((candidate) =>
    buildQueryStateProjection({
      runId: input.runId,queryPlanHash,txnSnapshotSeq,temporalTarget,candidate,
      seedCandidateRefs: expansion.seedCandidateRefs,relations: eligibleRelations,createdAtUtc,
    })));
  const floorById = new Map(expansion.addedCandidates.map((item) => [item.candidateRef,item]));
  const atomicFloorIds = new Set(expansion.addedCandidates
    .filter((item) => item.deterministicFloor).map((item) => item.candidateRef));
  if (requestedStateView === "change") {
    for (const relation of eligibleRelations) {
      if (retainedIds.has(relation.fromRevisionId) && retainedIds.has(relation.toRevisionId)) {
        atomicFloorIds.add(relation.fromRevisionId);
        atomicFloorIds.add(relation.toRevisionId);
      }
    }
  }
  for (const contradiction of snapshot.unresolvedContradictions) {
    if (retainedIds.has(contradiction.leftRevisionId) && retainedIds.has(contradiction.rightRevisionId)) {
      atomicFloorIds.add(contradiction.leftRevisionId);
      atomicFloorIds.add(contradiction.rightRevisionId);
    }
  }
  const rootScore = (candidateRef: string): { score: number; root: string | null } => {
    const direct = bank.seedScores.get(candidateRef);
    if (direct !== undefined) return { score: direct,root: candidateRef };
    const expanded = floorById.get(candidateRef);
    return { score: expanded ? bank.seedScores.get(expanded.rootSeedRef) ?? 0 : 0,root: expanded?.rootSeedRef ?? null };
  };
  const factCandidates: VNextReadCandidate[] = projections.map((projection) => {
    const score = rootScore(projection.candidateRef);
    const revision = candidateById.get(projection.candidateRef)!.revision;
    return {
      candidateRef: projection.candidateRef,sourceLane: "fact_revision",sourceRevision: projection.sourceRevision,
      rootSeedRef: score.root,retrievalScore: score.score,queryRole: projection.queryRole,
      deterministicFloor: atomicFloorIds.has(projection.candidateRef),
      lineageCollapseKey: `${revision.factKey}:${evidence.lineageKeys.get(projection.candidateRef) ?? "no-lineage"}`,
      fusionRank: null,selected: false,decisionCode: projection.queryRole === "exclude" ? "QUERY_STATE_EXCLUDE" : "FUSION_CANDIDATE",
    };
  });
  const episodicCandidates: VNextReadCandidate[] = episodic.map((item) => ({
    candidateRef: item.id,sourceLane: "episodic",sourceRevision: null,rootSeedRef: item.id,
    retrievalScore: item.rrf_score + (item.exact_match ? 1 : 0),queryRole: "context",
    deterministicFloor: item.exact_match,lineageCollapseKey: `event:${item.canonical_message_id}`,
    fusionRank: null,selected: false,decisionCode: "FUSION_CANDIDATE",
  }));
  const ranked = [...factCandidates,...episodicCandidates].filter((item) => item.queryRole !== "exclude")
    .sort((left,right) => Number(right.deterministicFloor) - Number(left.deterministicFloor)
      || rolePriority(left.queryRole) - rolePriority(right.queryRole)
      || right.retrievalScore - left.retrievalScore
      || left.candidateRef.localeCompare(right.candidateRef));
  const deduped: VNextReadCandidate[] = [];
  const seenCollapseKeys = new Set<string>();
  for (const item of ranked) {
    const collapseKey = item.lineageCollapseKey;
    if (collapseKey && seenCollapseKeys.has(collapseKey) && !item.deterministicFloor) {
      item.decisionCode = "LINEAGE_COLLAPSED";
      continue;
    }
    if (collapseKey) seenCollapseKeys.add(collapseKey);
    deduped.push(item);
  }
  const floorCount = deduped.filter((item) => item.deterministicFloor).length;
  const selectionCap = Math.max(input.maxSelected,floorCount);
  deduped.slice(0,selectionCap).forEach((item,index) => {
    item.selected = true;item.fusionRank = index + 1;item.decisionCode = item.deterministicFloor
      ? "SELECTED_DETERMINISTIC_FLOOR" : "SELECTED_FUSION";
  });
  for (const item of deduped.slice(selectionCap)) item.decisionCode = "NOT_TOP_K";
  const allCandidates = [...factCandidates,...episodicCandidates];
  const evidenceBundles = await Promise.all(factCandidates.filter((item) => item.selected).map((item) =>
    buildEvidenceBundle({ db: input.env.DB,factRevisionId: item.candidateRef,txnSnapshotSeq })));
  const artifactBody = {
    runId: input.runId,queryPlanHash,txnSnapshotSeq,requestedStateView,expansionArtifactId: expansion.artifactId,
    projectionIds: projections.map((item) => item.projectionId).sort(),
    candidates: allCandidates.map((item) => ({
      candidateRef: item.candidateRef,sourceLane: item.sourceLane,sourceRevision: item.sourceRevision,
      rootSeedRef: item.rootSeedRef,retrievalScore: item.retrievalScore,queryRole: item.queryRole,
      deterministicFloor: item.deterministicFloor,lineageCollapseKey: item.lineageCollapseKey,
      fusionRank: item.fusionRank,selected: item.selected,decisionCode: item.decisionCode,
    })).sort((left,right) => left.candidateRef.localeCompare(right.candidateRef)),
    evidenceBundleHashes: evidenceBundles.map((bundle) => bundle.bundleHash).sort(),
    readPathVersion: MEMORY_VNEXT_READ_PATH_VERSION,
  };
  const artifactHash = await memoryArtifactHash("memory-vnext-read-path-artifact",artifactBody);
  const result: VNextReadPathResult = {
    runId: input.runId,queryPlanHash,txnSnapshotSeq,requestedStateView,temporalTarget,snapshot,expansion,projections,
    candidates: allCandidates,evidenceBundles,episodic,artifactHash,
  };
  await persistStateAlignmentArtifacts({
    db: input.env.DB,snapshot,target: temporalTarget,expansion,projections,packet: null,rendered: null,receipt: null,
  });
  await persistReadArtifacts({
    env: input.env,result,namespaceHash: input.namespaceHash,queryHash: input.queryHash,
    shadowOnly: input.shadowOnly,createdAtUtc,
  });
  return result;
}
