import type { Env, MemoryNightReviewQueueMessage, OpenAIChatRequest, OpenAIChatResponse } from "../../types";
import { callOpenAICompat } from "../../proxy/openaiAdapter";
import { canonicalJson } from "../import/hashes";
import { buildLocalSecretRedactedViews } from "./secretViews";
import type { ClaimAtomV2 } from "./contracts";
import {
  buildOwnerModelSnapshot,
  scrubOwnerContext,
  type ConflictSafeDimension,
  type OwnerDimensionRevision,
} from "./ownerCognitiveModel";
import { getPredicateDefinition } from "./predicateRegistry";
import {
  adjudicateNightReview,
  buildBlindReviewPacket,
  buildProfileReviewPacket,
  MEMORY_NIGHT_REVIEW_POLICY_VERSION,
  NIGHT_REVIEW_VERDICT_JSON_SCHEMA,
  nightReviewModelConfig,
  parseNightReviewVerdict,
  persistNightReviewCasePackets,
  persistNightReviewHarnessDecision,
  persistNightReviewVerdict,
  type BlindReviewPacket,
  type NightReviewRelation,
  type NightReviewVerdict,
  type ProfileReviewPacket,
} from "./nightReviewCourt";
import { memoryArtifactHash, utf8Slice, utf8SpanHash } from "./integrity";

export const MEMORY_NIGHT_REVIEW_RUNTIME_VERSION = "memory-night-review-runtime-v2.0.0";
export const MEMORY_NIGHT_REVIEW_OWNER_TIME_ZONE = "<YOUR_TIMEZONE>";
export const MEMORY_NIGHT_REVIEW_CRON = "0 20 * * *";

const DEFAULT_MAX_CASES = 8;
const DEFAULT_MAX_TOKENS = 2600;
const MAX_CASES_CAP = 50;
const MAX_TOKENS_CAP = 8000;
const REVIEW_DECISIONS: NightReviewRelation[] = [
  "DUPLICATE","REINFORCE","COEXISTS","STATE_CHANGE","RETROACTIVE_CORRECTION",
  "SCOPE_CLARIFICATION","EPISTEMIC_RETRACTION","KEEP_DISPUTED","DEFER",
];

type NightReviewRunRow = {
  run_id: string;
  review_date_local: string;
  scheduled_for_utc: string;
  window_start_utc: string;
  window_end_utc: string;
  snapshot_id: string;
  base_txn_seq: number;
  max_cases: number;
};

type NightReviewSource = {
  sourceKind: "DEFERRED_MUTATION" | "OPEN_DISPUTE";
  sourceId: string;
  sourceCreatedAt: string;
  claimAId: string;
  claimBId: string;
  disputeId: string | null;
  priority: number;
  existingCaseId: string | null;
  deterministicPreclassification: unknown;
};

type ClaimEvidenceFragment = {
  parentEvidenceUnitId: string;
  evidenceRefId: string;
  canonicalEventId: string;
  contentRevision: number;
  byteStart: number;
  byteEnd: number;
  spanHash: string;
  structuralRole: "evidence" | "question" | "answer" | "tool_result" | "authority_attestation";
  actorClass: string;
  validatedAuthority: string;
  sourceMode: string;
  relation: string;
  occurredAtUtc: string;
  content: string;
  fragmentHash: string;
};

type ClaimReviewEvidenceBundle = {
  claimAtomId: string;
  evidenceUnitIds: string[];
  rootLineageIds: string[];
  structuralContextRefs: string[];
  fragments: ClaimEvidenceFragment[];
  completeness: "complete" | "incomplete";
  incompletenessCodes: string[];
  bundleHash: string;
};

type PreparedReviewCase = {
  source: NightReviewSource;
  blindPacket: BlindReviewPacket;
  profilePacket: ProfileReviewPacket;
  caseEvidenceUnitIds: string[];
  scrubbedDimensions: Array<{ dimensionRevisionId: string; reasonCodes: string[] }>;
  protectedImpact: boolean;
  predicateFamily: string;
};

type ModelCallResult = {
  verdict: NightReviewVerdict | null;
  failureCode: string | null;
  inputHash: string;
  outputHash: string | null;
  requestIdHash: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

function readBoundedInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed),1),max) : fallback;
}

function parseStringArray(raw: string): string[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("memory_night_review_string_array_invalid");
  }
  return [...new Set(value)].sort();
}

function parseObject(raw: string, code: string): Record<string,unknown> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string,unknown>;
}

function localDateAt(utc: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MEMORY_NIGHT_REVIEW_OWNER_TIME_ZONE,
    year: "numeric",month: "2-digit",day: "2-digit",
  }).formatToParts(utc);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function predicateFamily(predicateId: string): string {
  return predicateId.normalize("NFKC").trim().toLowerCase();
}

async function loadActiveDimensions(db: D1Database, asOfTxnSeq: number): Promise<OwnerDimensionRevision[]> {
  const result = await db.prepare(`SELECT
      dimension_revision_id,dimension_key,revision,value_json,assertion_mode,epistemic_status,stability,
      valid_from_utc,valid_to_utc,support_group_ids_json,contradiction_edge_ids_json,
      alternative_revision_ids_json,derived_from_dimension_revision_ids_json,root_lineage_ids_json,
      lineage_closure_hash,txn_from_seq,txn_to_seq,inference_policy,policy_version,
      producer_provider,producer_model
    FROM memory_owner_dimension_revisions
    WHERE txn_from_seq<=? AND (txn_to_seq IS NULL OR ?<txn_to_seq)
    ORDER BY dimension_key,revision`).bind(asOfTxnSeq,asOfTxnSeq).all<Record<string,unknown>>();
  return (result.results ?? []).map((row) => ({
    dimensionRevisionId: String(row.dimension_revision_id),
    dimensionKey: String(row.dimension_key),
    revision: Number(row.revision),
    valueJson: JSON.parse(String(row.value_json)),
    assertionMode: row.assertion_mode as OwnerDimensionRevision["assertionMode"],
    epistemicStatus: row.epistemic_status as OwnerDimensionRevision["epistemicStatus"],
    stability: row.stability as OwnerDimensionRevision["stability"],
    validFromUtc: row.valid_from_utc === null ? null : String(row.valid_from_utc),
    validToUtc: row.valid_to_utc === null ? null : String(row.valid_to_utc),
    supportGroupIds: parseStringArray(String(row.support_group_ids_json)),
    contradictionEdgeIds: parseStringArray(String(row.contradiction_edge_ids_json)),
    alternativeRevisionIds: parseStringArray(String(row.alternative_revision_ids_json)),
    derivedFromDimensionRevisionIds: parseStringArray(String(row.derived_from_dimension_revision_ids_json)),
    rootLineageIds: parseStringArray(String(row.root_lineage_ids_json)),
    lineageClosureHash: String(row.lineage_closure_hash),
    txnFromSeq: Number(row.txn_from_seq),
    txnToSeq: row.txn_to_seq === null ? null : Number(row.txn_to_seq),
    inferencePolicy: row.inference_policy as OwnerDimensionRevision["inferencePolicy"],
    policyVersion: String(row.policy_version),
    producerProvider: row.producer_provider === null ? null : String(row.producer_provider),
    producerModel: row.producer_model === null ? null : String(row.producer_model),
  }));
}

export async function prepareNightReviewRun(input: {
  env: Env;
  scheduledAtUtc: string;
}): Promise<{ created: boolean; run: NightReviewRunRow }> {
  const scheduled = new Date(input.scheduledAtUtc);
  if (Number.isNaN(scheduled.getTime())) throw new Error("memory_night_review_scheduled_time_invalid");
  const scheduledForUtc = scheduled.toISOString();
  const reviewDateLocal = localDateAt(scheduled);
  const existing = await input.env.DB.prepare(`SELECT run_id,review_date_local,scheduled_for_utc,
      window_start_utc,window_end_utc,snapshot_id,base_txn_seq,max_cases
    FROM memory_night_review_runs WHERE review_date_local=?`).bind(reviewDateLocal).first<NightReviewRunRow>();
  if (existing) return { created: false,run: existing };

  const clock = await input.env.DB.prepare("SELECT last_seq FROM memory_txn_clock WHERE singleton=1")
    .first<{ last_seq: number }>();
  const baseTxnSeq = Number(clock?.last_seq ?? 0);
  const prior = await input.env.DB.prepare(`SELECT snapshot_id,snapshot_ordinal
    FROM memory_owner_model_snapshots ORDER BY snapshot_ordinal DESC LIMIT 1`)
    .first<{ snapshot_id: string; snapshot_ordinal: number }>();
  const dimensions = await loadActiveDimensions(input.env.DB,baseTxnSeq);
  const snapshot = await buildOwnerModelSnapshot({
    snapshotOrdinal: Number(prior?.snapshot_ordinal ?? 0) + 1,
    baseTxnSeq,
    priorSnapshotId: prior?.snapshot_id ?? null,
    dimensions,
  });
  const windowStartUtc = new Date(scheduled.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const maxCases = readBoundedInteger(input.env.MEMORY_NIGHT_REVIEW_MAX_CASES,DEFAULT_MAX_CASES,MAX_CASES_CAP);
  const runHash = await memoryArtifactHash("memory-night-review-run-v2", {
    reviewDateLocal,scheduledForUtc,windowStartUtc,snapshotId: snapshot.snapshotId,
    baseTxnSeq,maxCases,policyVersion: MEMORY_NIGHT_REVIEW_RUNTIME_VERSION,
  });
  const runId = `nrr_${runHash.slice(0,32)}`;
  const eventHash = await memoryArtifactHash("memory-night-review-run-state-v2", { runId,version: 1,status: "QUEUED" });
  const statements: D1PreparedStatement[] = [
    input.env.DB.prepare(`INSERT INTO memory_owner_model_snapshots(
      snapshot_id,snapshot_ordinal,base_txn_seq,prior_snapshot_id,status,snapshot_hash,policy_version,created_at
    ) VALUES(?,?,?,?,'FROZEN',?,?,?)`).bind(
      snapshot.snapshotId,snapshot.snapshotOrdinal,snapshot.baseTxnSeq,snapshot.priorSnapshotId,
      snapshot.snapshotHash,snapshot.policyVersion,scheduledForUtc,
    ),
  ];
  snapshot.dimensionRevisionIds.forEach((dimensionRevisionId,index) => statements.push(
    input.env.DB.prepare(`INSERT INTO memory_owner_model_snapshot_members(
      snapshot_id,dimension_revision_id,ordinal,member_role,created_at
    ) VALUES(?,?,?,'active',?)`).bind(snapshot.snapshotId,dimensionRevisionId,index,scheduledForUtc),
  ));
  statements.push(
    input.env.DB.prepare(`INSERT INTO memory_night_review_runs(
      run_id,review_date_local,owner_time_zone,scheduled_for_utc,window_start_utc,window_end_utc,
      snapshot_id,base_txn_seq,max_cases,policy_version,created_at
    ) VALUES(?,?,?, ?,?,?,?,?,?,?,?)`).bind(
      runId,reviewDateLocal,MEMORY_NIGHT_REVIEW_OWNER_TIME_ZONE,scheduledForUtc,windowStartUtc,scheduledForUtc,
      snapshot.snapshotId,baseTxnSeq,maxCases,MEMORY_NIGHT_REVIEW_RUNTIME_VERSION,scheduledForUtc,
    ),
    input.env.DB.prepare(`INSERT INTO memory_night_review_run_state_events(
      event_id,run_id,from_status,to_status,expected_state_version,resulting_state_version,
      attempted_cases,completed_cases,reason_code,created_at
    ) VALUES(?,?,NULL,'QUEUED',0,1,0,0,'SCHEDULED_0400_ASIA_SHANGHAI',?)`).bind(
      `nrrse_${eventHash.slice(0,32)}`,runId,scheduledForUtc,
    ),
  );
  try {
    await input.env.DB.batch(statements);
  } catch (error) {
    const raced = await input.env.DB.prepare(`SELECT run_id,review_date_local,scheduled_for_utc,
        window_start_utc,window_end_utc,snapshot_id,base_txn_seq,max_cases
      FROM memory_night_review_runs WHERE review_date_local=?`).bind(reviewDateLocal).first<NightReviewRunRow>();
    if (raced) return { created: false,run: raced };
    throw error;
  }
  return {
    created: true,
    run: {
      run_id: runId,review_date_local: reviewDateLocal,scheduled_for_utc: scheduledForUtc,
      window_start_utc: windowStartUtc,window_end_utc: scheduledForUtc,snapshot_id: snapshot.snapshotId,
      base_txn_seq: baseTxnSeq,max_cases: maxCases,
    },
  };
}

async function latestRunState(db: D1Database, runId: string): Promise<{
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  version: number;
} | null> {
  const row = await db.prepare(`SELECT to_status,resulting_state_version
    FROM memory_night_review_run_state_events WHERE run_id=?
    ORDER BY resulting_state_version DESC LIMIT 1`).bind(runId)
    .first<{ to_status: "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED"; resulting_state_version: number }>();
  return row ? { status: row.to_status,version: Number(row.resulting_state_version) } : null;
}

async function transitionRun(input: {
  db: D1Database;
  runId: string;
  toStatus: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  attemptedCases: number;
  completedCases: number;
  reasonCode: string;
  createdAtUtc: string;
}): Promise<void> {
  const state = await latestRunState(input.db,input.runId);
  if (!state) throw new Error("memory_night_review_run_state_missing");
  if (["COMPLETED","PARTIAL","FAILED"].includes(state.status)) return;
  if (state.status === input.toStatus) return;
  const hash = await memoryArtifactHash("memory-night-review-run-state-v2", {
    runId: input.runId,fromStatus: state.status,toStatus: input.toStatus,version: state.version + 1,
    attemptedCases: input.attemptedCases,completedCases: input.completedCases,reasonCode: input.reasonCode,
  });
  await input.db.prepare(`INSERT INTO memory_night_review_run_state_events(
    event_id,run_id,from_status,to_status,expected_state_version,resulting_state_version,
    attempted_cases,completed_cases,reason_code,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
    `nrrse_${hash.slice(0,32)}`,input.runId,state.status,input.toStatus,state.version,state.version + 1,
    input.attemptedCases,input.completedCases,input.reasonCode,input.createdAtUtc,
  ).run();
}

async function loadNextSource(db: D1Database, run: NightReviewRunRow): Promise<NightReviewSource | null> {
  const row = await db.prepare(`WITH
    latest_dispute_state AS (
      SELECT e.dispute_id,e.to_status,ROW_NUMBER() OVER (
        PARTITION BY e.dispute_id ORDER BY e.resulting_state_version DESC
      ) AS rank
      FROM memory_claim_dispute_state_events e
    ),
    dispute_pairs AS (
      SELECT d.dispute_id,d.created_at,d.cause,
        MAX(CASE WHEN m.ordinal=0 THEN m.claim_atom_id END) AS claim_a_id,
        MAX(CASE WHEN m.ordinal=1 THEN m.claim_atom_id END) AS claim_b_id,
        COUNT(*) AS member_count
      FROM memory_claim_dispute_sets d
      JOIN latest_dispute_state state ON state.dispute_id=d.dispute_id AND state.rank=1 AND state.to_status='open'
      JOIN memory_claim_dispute_members m ON m.dispute_id=d.dispute_id
      WHERE d.created_at<?
      GROUP BY d.dispute_id,d.created_at,d.cause
      HAVING member_count=2
    ),
    sources AS (
      SELECT 'DEFERRED_MUTATION' AS source_kind,c.case_id AS source_id,c.created_at AS source_created_at,
        c.claim_a_id,c.claim_b_id,NULL AS dispute_id,60 AS priority,
        json_object('deterministicRelation',c.deterministic_relation,'ruleCodes',json(c.rule_codes_json)) AS preclassification
      FROM memory_claim_mutation_cases c
      WHERE c.status='DEFERRED' AND c.harness_relation='DEFERRED_COMPARISON' AND c.created_at<?
      UNION ALL
      SELECT 'OPEN_DISPUTE',p.dispute_id,p.created_at,p.claim_a_id,p.claim_b_id,p.dispute_id,80,
        json_object('openDisputeCause',p.cause)
      FROM dispute_pairs p
    )
    SELECT s.*,linked.case_id AS existing_case_id
    FROM sources s
    LEFT JOIN memory_night_review_case_attempts attempted
      ON attempted.run_id=? AND attempted.source_kind=s.source_kind AND attempted.source_id=s.source_id
    LEFT JOIN memory_night_review_source_cases linked
      ON linked.source_kind=s.source_kind AND linked.source_id=s.source_id
    LEFT JOIN memory_night_review_harness_decisions decided ON decided.case_id=linked.case_id
    WHERE attempted.attempt_id IS NULL AND decided.decision_id IS NULL
    ORDER BY CASE WHEN s.source_created_at>=? THEN 1 ELSE 0 END DESC,
      s.priority DESC,s.source_created_at,s.source_kind,s.source_id
    LIMIT 1`).bind(
    run.window_end_utc,run.window_end_utc,run.run_id,run.window_start_utc,
  ).first<Record<string,unknown>>();
  if (!row) return null;
  return {
    sourceKind: row.source_kind as NightReviewSource["sourceKind"],
    sourceId: String(row.source_id),sourceCreatedAt: String(row.source_created_at),
    claimAId: String(row.claim_a_id),claimBId: String(row.claim_b_id),
    disputeId: row.dispute_id === null ? null : String(row.dispute_id),
    priority: Number(row.priority),existingCaseId: row.existing_case_id === null ? null : String(row.existing_case_id),
    deterministicPreclassification: JSON.parse(String(row.preclassification)),
  };
}

async function loadClaimAtom(db: D1Database, claimAtomId: string): Promise<ClaimAtomV2> {
  const row = await db.prepare(`SELECT claim_atom_id,claim_group_id,subject_ref,assertion_kind,predicate_id,
      object_ref,canonical_value_json,scope_json,qualifiers_json,evidence_unit_ids_json,
      predicate_registry_version,normalization_version
    FROM memory_claim_atoms WHERE claim_atom_id=?`).bind(claimAtomId).first<Record<string,unknown>>();
  if (!row) throw new Error("memory_night_review_claim_missing");
  return {
    claimAtomId: String(row.claim_atom_id),claimGroupId: String(row.claim_group_id),
    subjectRef: row.subject_ref as ClaimAtomV2["subjectRef"],assertionKind: row.assertion_kind as ClaimAtomV2["assertionKind"],
    predicateId: String(row.predicate_id),objectRef: row.object_ref === null ? null : String(row.object_ref),
    canonicalValue: JSON.parse(String(row.canonical_value_json)),
    scope: parseObject(String(row.scope_json),"memory_night_review_claim_scope_invalid") as ClaimAtomV2["scope"],
    qualifiers: parseObject(String(row.qualifiers_json),"memory_night_review_claim_qualifiers_invalid") as ClaimAtomV2["qualifiers"],
    evidenceUnitIds: parseStringArray(String(row.evidence_unit_ids_json)),
    predicateRegistryVersion: String(row.predicate_registry_version),
    normalizationVersion: String(row.normalization_version),
  };
}

async function atomicMember(input: {
  db: D1Database;
  claimAtomId: string;
  parentEvidenceUnitId: string;
  evidenceRefId: string;
  structuralRole: ClaimEvidenceFragment["structuralRole"];
  txnSnapshotSeq: number;
  structuralContextRelation?: string;
}): Promise<{ fragment: ClaimEvidenceFragment | null; rootLineageId: string | null; code: string | null }> {
  const row = await input.db.prepare(`SELECT r.evidence_ref_id,r.canonical_event_id,r.actor_class,r.occurred_at_utc,
      r.content_revision,r.byte_start,r.byte_end,r.sensitivity,m.span_hash,m.root_lineage_id,msg.content
    FROM memory_evidence_refs r
    JOIN memory_evidence_ref_v2_metadata m ON m.evidence_ref_id=r.evidence_ref_id
    LEFT JOIN messages msg ON msg.id=r.canonical_event_id
    WHERE r.evidence_ref_id=?`).bind(input.evidenceRefId).first<Record<string,unknown>>();
  if (!row) return { fragment: null,rootLineageId: null,code: "EVIDENCE_REF_MISSING" };
  const rootLineageId = String(row.root_lineage_id);
  if (row.sensitivity !== "normal") return { fragment: null,rootLineageId,code: "EVIDENCE_PRIVACY_BOUNDARY" };
  if (row.content === null || row.byte_start === null || row.byte_end === null || row.span_hash === null) {
    return { fragment: null,rootLineageId,code: "PRECISE_SPAN_REQUIRED" };
  }
  const excluded = await input.db.prepare(`SELECT 1 AS found FROM memory_retrieval_exclusions
    WHERE target_id IN (?,?,?) AND txn_from_seq<=? AND (txn_to_seq IS NULL OR ?<txn_to_seq) LIMIT 1`)
    .bind(input.evidenceRefId,String(row.canonical_event_id),input.claimAtomId,input.txnSnapshotSeq,input.txnSnapshotSeq)
    .first<{ found: number }>();
  if (excluded) return { fragment: null,rootLineageId,code: "EVIDENCE_RETRIEVAL_EXCLUDED" };
  let content: string;
  let expectedHash: string;
  try {
    content = utf8Slice(String(row.content),Number(row.byte_start),Number(row.byte_end));
    expectedHash = await utf8SpanHash({
      canonicalEventId: String(row.canonical_event_id),contentRevision: Number(row.content_revision),
      content: String(row.content),byteStart: Number(row.byte_start),byteEnd: Number(row.byte_end),
    });
  } catch {
    return { fragment: null,rootLineageId,code: "EVIDENCE_SPAN_INVALID" };
  }
  if (expectedHash !== row.span_hash) return { fragment: null,rootLineageId,code: "EVIDENCE_SPAN_HASH_MISMATCH" };
  if (buildLocalSecretRedactedViews(content).secretSpans.length > 0) {
    return { fragment: null,rootLineageId,code: "LOCAL_SECRET_SCAN_REJECTED" };
  }
  const interpretations = await input.db.prepare(`SELECT i.validated_authority,i.proposed_source_mode,i.evidence_relation
    FROM memory_proposal_claim_atoms pca
    JOIN memory_evidence_interpretations i
      ON i.proposal_id=pca.proposal_id AND i.evidence_ref_id=?
    WHERE pca.claim_atom_id=?
    ORDER BY CASE WHEN i.validated_authority='none' THEN 1 ELSE 0 END,i.interpretation_id`)
    .bind(input.evidenceRefId,input.claimAtomId).all<{
      validated_authority: string; proposed_source_mode: string; evidence_relation: string;
    }>();
  const interpretation = (interpretations.results ?? []).find((item) => item.validated_authority !== "none")
    ?? (input.structuralContextRelation ? {
      validated_authority: "structural_context",
      proposed_source_mode: "structural_context",
      evidence_relation: input.structuralContextRelation,
    } : null);
  if (!interpretation) return { fragment: null,rootLineageId,code: "EVIDENCE_AUTHORITY_NOT_VALIDATED" };
  const core = {
    parentEvidenceUnitId: input.parentEvidenceUnitId,evidenceRefId: input.evidenceRefId,
    canonicalEventId: String(row.canonical_event_id),contentRevision: Number(row.content_revision),
    byteStart: Number(row.byte_start),byteEnd: Number(row.byte_end),spanHash: String(row.span_hash),
    structuralRole: input.structuralRole,actorClass: String(row.actor_class),
    validatedAuthority: interpretation.validated_authority,sourceMode: interpretation.proposed_source_mode,
    relation: interpretation.evidence_relation,occurredAtUtc: String(row.occurred_at_utc),content,
  };
  return {
    fragment: { ...core,fragmentHash: await memoryArtifactHash("memory-night-review-evidence-fragment-v2",core) },
    rootLineageId,code: null,
  };
}

async function loadClaimEvidenceBundle(input: {
  db: D1Database;
  claim: ClaimAtomV2;
  txnSnapshotSeq: number;
}): Promise<ClaimReviewEvidenceBundle> {
  const fragments: ClaimEvidenceFragment[] = [];
  const roots = new Set<string>();
  const structuralContextRefs = new Set<string>();
  const codes = new Set<string>();
  for (const unitId of input.claim.evidenceUnitIds) {
    const atomic = await input.db.prepare(`SELECT evidence_ref_id FROM memory_evidence_ref_v2_metadata
      WHERE evidence_ref_id=?`).bind(unitId).first<{ evidence_ref_id: string }>();
    const composite = atomic ? null : await input.db.prepare(`SELECT question_evidence_ref_id,answer_evidence_ref_id,
        root_lineage_id,strong_owner_authority
      FROM memory_composite_confirmation_units WHERE evidence_unit_id=?`).bind(unitId).first<{
        question_evidence_ref_id: string; answer_evidence_ref_id: string; root_lineage_id: string;
        strong_owner_authority: number;
      }>();
    const tool = atomic || composite ? null : await input.db.prepare(`SELECT tool_result_evidence_ref_id,
        authority_attestation_evidence_ref_id,root_lineage_id
      FROM memory_scoped_tool_observation_units WHERE evidence_unit_id=?`).bind(unitId).first<{
        tool_result_evidence_ref_id: string; authority_attestation_evidence_ref_id: string; root_lineage_id: string;
      }>();
    const members: Array<{ id: string; role: ClaimEvidenceFragment["structuralRole"] }> = atomic
      ? [{ id: unitId,role: "evidence" }]
      : composite ? [
        { id: composite.question_evidence_ref_id,role: "question" },
        { id: composite.answer_evidence_ref_id,role: "answer" },
      ] : tool ? [
        { id: tool.tool_result_evidence_ref_id,role: "tool_result" },
        { id: tool.authority_attestation_evidence_ref_id,role: "authority_attestation" },
      ] : [];
    if (members.length === 0) {
      codes.add("EVIDENCE_UNIT_MISSING");
      continue;
    }
    if (composite && Number(composite.strong_owner_authority) !== 1) codes.add("COMPOSITE_AUTHORITY_INCOMPLETE");
    if (composite) roots.add(composite.root_lineage_id);
    if (tool) roots.add(tool.root_lineage_id);
    const resolved = await Promise.all(members.map((member) => atomicMember({
      db: input.db,claimAtomId: input.claim.claimAtomId,parentEvidenceUnitId: unitId,
      evidenceRefId: member.id,structuralRole: member.role,txnSnapshotSeq: input.txnSnapshotSeq,
    })));
    if (composite && resolved[1]?.fragment && resolved[0]?.code === "EVIDENCE_AUTHORITY_NOT_VALIDATED") {
      resolved[0] = await atomicMember({
        db: input.db,claimAtomId: input.claim.claimAtomId,parentEvidenceUnitId: unitId,
        evidenceRefId: members[0].id,structuralRole: members[0].role,txnSnapshotSeq: input.txnSnapshotSeq,
        structuralContextRelation: resolved[1].fragment.relation,
      });
    }
    for (const item of resolved) {
      if (item.fragment) fragments.push(item.fragment);
      if (atomic && item.rootLineageId) roots.add(item.rootLineageId);
      if (item.code) codes.add(item.code);
    }
    if (members.length > 1) {
      const expectedFrom = composite ? members[1].id : members[0].id;
      const expectedTo = composite ? members[0].id : members[1].id;
      const expectedKind = composite ? "QUESTION_ANSWER" : "TOOL_CALL_RESULT";
      const edge = await input.db.prepare(`SELECT structural_edge_id FROM memory_evidence_structural_edges
        WHERE from_evidence_ref_id=? AND to_evidence_ref_id=? AND edge_kind=?
        ORDER BY edge_ordinal,structural_edge_id LIMIT 1`).bind(
        expectedFrom,expectedTo,expectedKind,
      ).first<{ structural_edge_id: string }>();
      if (!edge) codes.add("STRUCTURAL_BINDING_MISSING");
      else structuralContextRefs.add(edge.structural_edge_id);
    }
  }
  if (fragments.length === 0) codes.add("EVIDENCE_FRAGMENTS_EMPTY");
  const uniqueFragments = [...new Map(fragments.map((fragment) => [fragment.fragmentHash,fragment])).values()]
    .sort((left,right) => left.occurredAtUtc.localeCompare(right.occurredAtUtc)
      || left.canonicalEventId.localeCompare(right.canonicalEventId) || left.byteStart - right.byteStart);
  const core = {
    claimAtomId: input.claim.claimAtomId,evidenceUnitIds: [...input.claim.evidenceUnitIds].sort(),
    rootLineageIds: [...roots].sort(),structuralContextRefs: [...structuralContextRefs].sort(),
    fragments: uniqueFragments,completeness: codes.size === 0 ? "complete" as const : "incomplete" as const,
    incompletenessCodes: [...codes].sort(),
  };
  return { ...core,bundleHash: await memoryArtifactHash("memory-night-review-claim-evidence-bundle-v2",core) };
}

async function loadConflictSafeDimensions(db: D1Database, snapshotId: string): Promise<ConflictSafeDimension[]> {
  const result = await db.prepare(`SELECT d.dimension_revision_id,d.dimension_key,d.value_json,d.assertion_mode,
      d.epistemic_status,d.root_lineage_ids_json,d.derived_from_dimension_revision_ids_json,d.inference_policy
    FROM memory_owner_model_snapshot_members m
    JOIN memory_owner_dimension_revisions d ON d.dimension_revision_id=m.dimension_revision_id
    WHERE m.snapshot_id=? ORDER BY m.ordinal`).bind(snapshotId).all<Record<string,unknown>>();
  const rows = result.results ?? [];
  const ids = rows.map((row) => String(row.dimension_revision_id));
  const predicatesByDimension = new Map<string,string[]>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const support = await db.prepare(`SELECT s.dimension_revision_id,f.predicate
      FROM memory_owner_dimension_fact_support s
      JOIN memory_fact_revisions f ON f.fact_revision_id=s.fact_revision_id
      WHERE s.dimension_revision_id IN (${placeholders})
      ORDER BY s.dimension_revision_id,f.predicate`).bind(...ids).all<{ dimension_revision_id: string; predicate: string }>();
    for (const item of support.results ?? []) {
      const current = predicatesByDimension.get(item.dimension_revision_id) ?? [];
      current.push(predicateFamily(item.predicate));
      predicatesByDimension.set(item.dimension_revision_id,[...new Set(current)].sort());
    }
  }
  return rows.map((row) => {
    const dimensionRevisionId = String(row.dimension_revision_id);
    const predicateFamilies = predicatesByDimension.get(dimensionRevisionId) ?? [];
    const dimensionKey = String(row.dimension_key);
    return {
      dimensionRevisionId,dimensionKey,
      predicateFamily: predicateFamilies[0] ?? dimensionKey,
      predicateFamilies,
      rootLineageIds: parseStringArray(String(row.root_lineage_ids_json)),
      derivedFromDimensionRevisionIds: parseStringArray(String(row.derived_from_dimension_revision_ids_json)),
      sensitiveOrProtectedMirror: row.inference_policy !== "allow_pattern"
        || /(?:permission|authorization|credential|secret|diagnosis|protected_identity)/i.test(dimensionKey),
      valueJson: JSON.parse(String(row.value_json)),
      assertionMode: row.assertion_mode as ConflictSafeDimension["assertionMode"],
      epistemicStatus: row.epistemic_status as ConflictSafeDimension["epistemicStatus"],
    };
  });
}

async function claimsHaveProtectedImpact(db: D1Database, claims: ClaimAtomV2[]): Promise<boolean> {
  if (claims.some((claim) => (getPredicateDefinition(claim.predicateId,claim.predicateRegistryVersion)?.protectedImpactRules.length ?? 0) > 0)) {
    return true;
  }
  const ids = claims.map((claim) => claim.claimAtomId);
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(`SELECT p.protected_impacts_json
    FROM memory_proposal_claim_atoms pca
    JOIN memory_proposals p ON p.proposal_id=pca.proposal_id AND p.proposal_revision=pca.proposal_revision
    WHERE pca.claim_atom_id IN (${placeholders})`).bind(...ids).all<{ protected_impacts_json: string }>();
  return (result.results ?? []).some((row) => parseStringArray(row.protected_impacts_json).length > 0);
}

async function loadExistingPreparedCase(input: {
  db: D1Database;
  source: NightReviewSource;
  claimA: ClaimAtomV2;
  claimB: ClaimAtomV2;
}): Promise<PreparedReviewCase | null> {
  if (!input.source.existingCaseId) return null;
  const row = await input.db.prepare(`SELECT c.case_id,c.protected_impact,c.predicate_family,
      b.packet_json,p.packet_id AS profile_packet_id,p.blind_packet_hash,p.conflict_safe_context_json,
      p.included_dimension_revision_ids_json,p.scrubbed_dimension_revision_ids_json,p.packet_hash AS profile_packet_hash,
      s.scrubbed_dimensions_json
    FROM memory_night_review_cases c
    JOIN memory_night_review_blind_packets b ON b.case_id=c.case_id
    JOIN memory_night_review_profile_packets p ON p.case_id=c.case_id
    JOIN memory_night_review_scrub_artifacts s ON s.case_id=c.case_id
    WHERE c.case_id=?`).bind(input.source.existingCaseId).first<Record<string,unknown>>();
  if (!row) return null;
  const blindPacket = JSON.parse(String(row.packet_json)) as BlindReviewPacket;
  const profilePacket: ProfileReviewPacket = {
    packetId: String(row.profile_packet_id),caseId: String(row.case_id),blindPacketHash: String(row.blind_packet_hash),
    conflictSafeDimensions: JSON.parse(String(row.conflict_safe_context_json)) as ConflictSafeDimension[],
    includedDimensionRevisionIds: parseStringArray(String(row.included_dimension_revision_ids_json)),
    scrubbedDimensionRevisionIds: parseStringArray(String(row.scrubbed_dimension_revision_ids_json)),
    packetHash: String(row.profile_packet_hash),conflictSafe: true,
  };
  return {
    source: input.source,blindPacket,profilePacket,
    caseEvidenceUnitIds: [...new Set([...input.claimA.evidenceUnitIds,...input.claimB.evidenceUnitIds])].sort(),
    scrubbedDimensions: JSON.parse(String(row.scrubbed_dimensions_json)) as PreparedReviewCase["scrubbedDimensions"],
    protectedImpact: Number(row.protected_impact) === 1,predicateFamily: String(row.predicate_family),
  };
}

async function prepareReviewCase(input: {
  db: D1Database;
  run: NightReviewRunRow;
  source: NightReviewSource;
  createdAtUtc: string;
}): Promise<PreparedReviewCase> {
  const [claimA,claimB] = await Promise.all([
    loadClaimAtom(input.db,input.source.claimAId),loadClaimAtom(input.db,input.source.claimBId),
  ]);
  const existing = await loadExistingPreparedCase({ db: input.db,source: input.source,claimA,claimB });
  if (existing) return existing;
  const [bundleA,bundleB,dimensions,protectedImpact] = await Promise.all([
    loadClaimEvidenceBundle({ db: input.db,claim: claimA,txnSnapshotSeq: input.run.base_txn_seq }),
    loadClaimEvidenceBundle({ db: input.db,claim: claimB,txnSnapshotSeq: input.run.base_txn_seq }),
    loadConflictSafeDimensions(input.db,input.run.snapshot_id),
    claimsHaveProtectedImpact(input.db,[claimA,claimB]),
  ]);
  if (bundleA.completeness !== "complete" || bundleB.completeness !== "complete") {
    throw new Error(`memory_night_review_evidence_incomplete:${[
      ...bundleA.incompletenessCodes,...bundleB.incompletenessCodes,
    ].sort().join(",")}`);
  }
  const caseEvidenceUnitIds = [...new Set([...claimA.evidenceUnitIds,...claimB.evidenceUnitIds])].sort();
  const caseRootLineageIds = [...new Set([...bundleA.rootLineageIds,...bundleB.rootLineageIds])].sort();
  if (caseRootLineageIds.length === 0) throw new Error("memory_night_review_root_lineage_required");
  const family = predicateFamily(claimA.predicateId);
  const scrubbed = scrubOwnerContext({
    dimensions,caseRootLineageIds,casePredicateFamily: family,
  });
  const caseHash = await memoryArtifactHash("memory-night-review-case-v2", {
    sourceKind: input.source.sourceKind,sourceId: input.source.sourceId,snapshotId: input.run.snapshot_id,
    claimAId: claimA.claimAtomId,claimBId: claimB.claimAtomId,policyVersion: MEMORY_NIGHT_REVIEW_POLICY_VERSION,
  });
  const caseId = `nrc_${caseHash.slice(0,32)}`;
  const blindPacket = await buildBlindReviewPacket({
    caseId,snapshotId: input.run.snapshot_id,claimA,claimB,evidenceBundles: [bundleA,bundleB],
    predicateDefinition: getPredicateDefinition(claimA.predicateId,claimA.predicateRegistryVersion),
    deterministicPreclassification: input.source.deterministicPreclassification,
    allowedDecisions: REVIEW_DECISIONS,
  });
  const profilePacket = await buildProfileReviewPacket({
    caseId,blindPacketHash: blindPacket.packetHash,includedDimensions: scrubbed.included,
    scrubbedDimensionRevisionIds: scrubbed.scrubbed.map((item) => item.dimensionRevisionId),
  });
  await persistNightReviewCasePackets({
    db: input.db,
    caseKind: input.source.sourceKind === "OPEN_DISPUTE" ? "DISPUTE" : "DEFERRED_COMPARISON",
    blindPacket,profilePacket,caseRootLineageIds,predicateFamily: family,protectedImpact,
    openedTxnSeq: input.run.base_txn_seq,priority: input.source.priority,disputeId: input.source.disputeId,
    scrubbedDimensions: scrubbed.scrubbed,createdAtUtc: input.createdAtUtc,
  });
  await input.db.prepare(`INSERT OR IGNORE INTO memory_night_review_source_cases(
    source_kind,source_id,case_id,first_run_id,source_created_at,predicate_family,created_at
  ) VALUES(?,?,?,?,?,?,?)`).bind(
    input.source.sourceKind,input.source.sourceId,caseId,input.run.run_id,input.source.sourceCreatedAt,
    family,input.createdAtUtc,
  ).run();
  const linked = await input.db.prepare(`SELECT case_id FROM memory_night_review_source_cases
    WHERE source_kind=? AND source_id=?`).bind(input.source.sourceKind,input.source.sourceId)
    .first<{ case_id: string }>();
  if (linked?.case_id !== caseId) throw new Error("memory_night_review_source_case_identity_mismatch");
  return {
    source: { ...input.source,existingCaseId: caseId },blindPacket,profilePacket,caseEvidenceUnitIds,
    scrubbedDimensions: scrubbed.scrubbed,protectedImpact,predicateFamily: family,
  };
}

function extractJsonObject(text: string): unknown | null {
  try { return JSON.parse(text) as unknown; } catch { /* bounded recovery below */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start,end + 1)) as unknown; } catch { return null; }
}

function buildReviewerPrompt(input: {
  pass: "BLIND" | "PROFILE";
  blindPacket: BlindReviewPacket;
  profilePacket: ProfileReviewPacket;
  blindVerdict: NightReviewVerdict | null;
}): string {
  const common = [
    "You are the bounded Night Review Court for Operia Memory. Return only strict JSON matching the supplied schema.",
    "You may propose a relation, but you cannot write facts, modify Subject Core, create evidence, grant permissions, or execute actions.",
    "Recency, message order, revision number, and learned time never decide the persistent winner.",
    "Use only the supplied exact evidence spans. If evidence does not prove a directional relation, return DEFER or KEEP_DISPUTED.",
    "DUPLICATE and REINFORCE are symmetric. STATE_CHANGE needs an explicit later real-world state. RETROACTIVE_CORRECTION needs an explicit correction of a prior assertion. SCOPE_CLARIFICATION needs explicit scope evidence. EPISTEMIC_RETRACTION withdraws certainty without inventing the opposite value.",
    "basisEvidenceUnitIds must be selected only from the claim evidenceUnitIds in the packet.",
  ];
  if (input.pass === "BLIND") {
    return [...common,
      "This is the BLIND pass. The packet contains no Owner Cognitive Model. reliedDimensionRevisionIds must be [] and profileInfluence must be NONE.",
      "<blind_packet>",canonicalJson(input.blindPacket),"</blind_packet>",
    ].join("\n");
  }
  return [...common,
    "This is the PROFILE pass. The blind pass was unresolved. ConflictSafeOwnerContext is interpretation-only and has already been lineage-scrubbed.",
    "The profile may only disambiguate language or scope, or break a genuine tie. It cannot override explicit evidence or serve as fact support.",
    "reliedDimensionRevisionIds may contain only includedDimensionRevisionIds. Never rely on scrubbedDimensionRevisionIds.",
    "<blind_packet>",canonicalJson(input.blindPacket),"</blind_packet>",
    "<blind_verdict>",canonicalJson(input.blindVerdict),"</blind_verdict>",
    "<conflict_safe_profile_packet>",canonicalJson(input.profilePacket),"</conflict_safe_profile_packet>",
  ].join("\n");
}

async function loadRecoveredModelAttempt(input: {
  db: D1Database;
  runId: string;
  caseId: string;
  pass: "BLIND" | "PROFILE";
}): Promise<ModelCallResult | null> {
  const row = await input.db.prepare(`SELECT status,failure_code,input_hash,output_hash,verdict_json,
      provider_request_id_hash,input_tokens,output_tokens
    FROM memory_night_review_model_attempts WHERE run_id=? AND case_id=? AND pass=?`)
    .bind(input.runId,input.caseId,input.pass).first<Record<string,unknown>>();
  if (!row) return null;
  return {
    verdict: row.verdict_json === null ? null : parseNightReviewVerdict(JSON.parse(String(row.verdict_json))),
    failureCode: row.failure_code === null ? null : String(row.failure_code),
    inputHash: String(row.input_hash),outputHash: row.output_hash === null ? null : String(row.output_hash),
    requestIdHash: row.provider_request_id_hash === null ? null : String(row.provider_request_id_hash),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
  };
}

async function callReviewer(input: {
  env: Env;
  runId: string;
  pass: "BLIND" | "PROFILE";
  prepared: PreparedReviewCase;
  blindVerdict: NightReviewVerdict | null;
  createdAtUtc: string;
}): Promise<ModelCallResult> {
  const caseId = input.prepared.blindPacket.caseId;
  const recovered = await loadRecoveredModelAttempt({
    db: input.env.DB,runId: input.runId,caseId,pass: input.pass,
  });
  if (recovered) return recovered;
  const modelConfig = nightReviewModelConfig(input.env);
  const prompt = buildReviewerPrompt({
    pass: input.pass,blindPacket: input.prepared.blindPacket,
    profilePacket: input.prepared.profilePacket,blindVerdict: input.blindVerdict,
  });
  const request: OpenAIChatRequest = {
    model: modelConfig.model,
    messages: [
      { role: "system",content: "You are a strict JSON adjudicator. Output JSON only." },
      { role: "user",content: prompt },
    ],
    temperature: 0,
    reasoning_effort: modelConfig.reasoningConfig.effort,
    max_tokens: readBoundedInteger(input.env.MEMORY_NIGHT_REVIEW_MAX_TOKENS,DEFAULT_MAX_TOKENS,MAX_TOKENS_CAP),
    response_format: {
      type: "json_schema",
      json_schema: { name: "memory_night_review_verdict",strict: true,schema: NIGHT_REVIEW_VERDICT_JSON_SCHEMA },
    },
    stream: false,
  };
  const inputHash = await memoryArtifactHash("memory-night-review-model-input-v2",request);
  let verdict: NightReviewVerdict | null = null;
  let failureCode: string | null = null;
  let outputHash: string | null = null;
  let requestIdHash: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  try {
    const response = await callOpenAICompat(input.env,request);
    if (!response.ok) {
      failureCode = `PROVIDER_HTTP_${response.status}`;
    } else {
      const body = await response.json() as OpenAIChatResponse;
      const message = body.choices?.[0]?.message as ({ content?: unknown; reasoning_content?: unknown }) | undefined;
      const content = typeof message?.content === "string" ? message.content.trim() : "";
      const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
      const rawText = content || reasoning;
      outputHash = rawText ? await memoryArtifactHash("memory-night-review-model-output-v2",rawText) : null;
      if (typeof body.id === "string" && body.id) {
        requestIdHash = await memoryArtifactHash("memory-night-review-provider-request-id-v2",body.id);
      }
      inputTokens = Number.isFinite(body.usage?.prompt_tokens) ? Number(body.usage?.prompt_tokens) :
        Number.isFinite(body.usage?.input_tokens) ? Number(body.usage?.input_tokens) : null;
      outputTokens = Number.isFinite(body.usage?.completion_tokens) ? Number(body.usage?.completion_tokens) :
        Number.isFinite(body.usage?.output_tokens) ? Number(body.usage?.output_tokens) : null;
      const raw = extractJsonObject(rawText);
      if (!raw) failureCode = "MODEL_OUTPUT_JSON_INVALID";
      else {
        try {
          verdict = parseNightReviewVerdict(raw);
          if (verdict.caseId !== caseId) {
            verdict = null;
            failureCode = "MODEL_OUTPUT_CASE_MISMATCH";
          }
        } catch (error) {
          failureCode = error instanceof Error ? error.message.toUpperCase() : "MODEL_OUTPUT_SCHEMA_INVALID";
        }
      }
    }
  } catch (error) {
    failureCode = error instanceof Error ? `MODEL_CALL_${error.message}`.slice(0,160) : "MODEL_CALL_FAILED";
  }
  const attemptHash = await memoryArtifactHash("memory-night-review-model-attempt-v2", {
    runId: input.runId,caseId,pass: input.pass,inputHash,outputHash,failureCode,
  });
  await input.env.DB.prepare(`INSERT INTO memory_night_review_model_attempts(
    model_attempt_id,run_id,case_id,pass,status,failure_code,model_provider,model_model,
    prompt_version,schema_version,reasoning_config_json,input_hash,output_hash,verdict_json,
    provider_request_id_hash,input_tokens,output_tokens,estimated_cost_usd,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`).bind(
    `nrma_${attemptHash.slice(0,32)}`,input.runId,caseId,input.pass,verdict ? "SUCCEEDED" : "FAILED",
    verdict ? null : (failureCode ?? "MODEL_RESULT_MISSING"),modelConfig.provider,modelConfig.model,
    modelConfig.promptVersion,modelConfig.schemaVersion,canonicalJson(modelConfig.reasoningConfig),inputHash,
    outputHash,verdict ? canonicalJson(verdict) : null,requestIdHash,inputTokens,outputTokens,input.createdAtUtc,
  ).run();
  return { verdict,failureCode: verdict ? null : failureCode ?? "MODEL_RESULT_MISSING",inputHash,outputHash,requestIdHash,inputTokens,outputTokens };
}

async function persistCaseAttempt(input: {
  db: D1Database;
  runId: string;
  source: NightReviewSource;
  caseId: string | null;
  status: "PACKET_REJECTED" | "MODEL_FAILED" | "DEFERRED" | "REVIEWED" | "OWNER_REVIEW";
  failureCode: string | null;
  createdAtUtc: string;
}): Promise<void> {
  const hash = await memoryArtifactHash("memory-night-review-case-attempt-v2", {
    runId: input.runId,sourceKind: input.source.sourceKind,sourceId: input.source.sourceId,
    caseId: input.caseId,status: input.status,failureCode: input.failureCode,
  });
  await input.db.prepare(`INSERT OR IGNORE INTO memory_night_review_case_attempts(
    attempt_id,run_id,source_kind,source_id,case_id,status,failure_code,estimated_cost_usd,created_at
  ) VALUES(?,?,?,?,?,?,?,0,?)`).bind(
    `nrca_${hash.slice(0,32)}`,input.runId,input.source.sourceKind,input.source.sourceId,input.caseId,
    input.status,input.failureCode,input.createdAtUtc,
  ).run();
}

async function processSource(input: {
  env: Env;
  run: NightReviewRunRow;
  source: NightReviewSource;
  createdAtUtc: string;
}): Promise<void> {
  let prepared: PreparedReviewCase;
  try {
    prepared = await prepareReviewCase({ db: input.env.DB,run: input.run,source: input.source,createdAtUtc: input.createdAtUtc });
  } catch (error) {
    await persistCaseAttempt({
      db: input.env.DB,runId: input.run.run_id,source: input.source,caseId: null,status: "PACKET_REJECTED",
      failureCode: error instanceof Error ? error.message.slice(0,200) : "PACKET_BUILD_FAILED",createdAtUtc: input.createdAtUtc,
    });
    return;
  }
  const modelConfig = nightReviewModelConfig(input.env);
  const blind = await callReviewer({
    env: input.env,runId: input.run.run_id,pass: "BLIND",prepared,blindVerdict: null,createdAtUtc: input.createdAtUtc,
  });
  if (!blind.verdict || !blind.outputHash) {
    await persistCaseAttempt({
      db: input.env.DB,runId: input.run.run_id,source: input.source,caseId: prepared.blindPacket.caseId,
      status: "MODEL_FAILED",failureCode: blind.failureCode ?? "BLIND_MODEL_FAILED",createdAtUtc: input.createdAtUtc,
    });
    return;
  }
  const blindVerdictId = await persistNightReviewVerdict({
    db: input.env.DB,packetId: prepared.blindPacket.packetId,pass: "BLIND",verdict: blind.verdict,
    modelConfig,inputHash: blind.inputHash,outputHash: blind.outputHash,createdAtUtc: input.createdAtUtc,
  });
  const blindClear = blind.verdict.relation !== "DEFER" && blind.verdict.uncertaintyCodes.length === 0;
  let profileVerdict: NightReviewVerdict | null = null;
  let profileVerdictId: string | null = null;
  if (!blindClear) {
    const profile = await callReviewer({
      env: input.env,runId: input.run.run_id,pass: "PROFILE",prepared,
      blindVerdict: blind.verdict,createdAtUtc: input.createdAtUtc,
    });
    if (!profile.verdict || !profile.outputHash) {
      await persistCaseAttempt({
        db: input.env.DB,runId: input.run.run_id,source: input.source,caseId: prepared.blindPacket.caseId,
        status: "MODEL_FAILED",failureCode: profile.failureCode ?? "PROFILE_MODEL_FAILED",createdAtUtc: input.createdAtUtc,
      });
      return;
    }
    profileVerdict = profile.verdict;
    profileVerdictId = await persistNightReviewVerdict({
      db: input.env.DB,packetId: prepared.profilePacket.packetId,pass: "PROFILE",verdict: profile.verdict,
      modelConfig,inputHash: profile.inputHash,outputHash: profile.outputHash,createdAtUtc: input.createdAtUtc,
    });
  }
  const decision = adjudicateNightReview({
    caseId: prepared.blindPacket.caseId,allowedDecisions: prepared.blindPacket.allowedDecisions,
    caseEvidenceUnitIds: prepared.caseEvidenceUnitIds,blindVerdict: blind.verdict,profileVerdict,
    includedDimensionRevisionIds: prepared.profilePacket.includedDimensionRevisionIds,
    scrubbedDimensionRevisionIds: prepared.profilePacket.scrubbedDimensionRevisionIds,
    protectedImpact: prepared.protectedImpact,
  });
  await persistNightReviewHarnessDecision({
    db: input.env.DB,decision,blindVerdictId,profileVerdictId,committedMutationCaseId: null,
    createdAtUtc: input.createdAtUtc,
  });
  const status = decision.ownerReviewRequired ? "OWNER_REVIEW"
    : decision.finalRelation === "DEFER" || decision.finalRelation === "KEEP_DISPUTED" ? "DEFERRED" : "REVIEWED";
  await persistCaseAttempt({
    db: input.env.DB,runId: input.run.run_id,source: input.source,caseId: prepared.blindPacket.caseId,
    status,failureCode: null,createdAtUtc: input.createdAtUtc,
  });
}

async function runCounts(db: D1Database, runId: string): Promise<{
  attempted: number;
  completed: number;
  failures: number;
}> {
  const row = await db.prepare(`SELECT COUNT(*) AS attempted,
      COALESCE(SUM(CASE WHEN status IN ('DEFERRED','REVIEWED','OWNER_REVIEW') THEN 1 ELSE 0 END),0) AS completed,
      COALESCE(SUM(CASE WHEN status IN ('PACKET_REJECTED','MODEL_FAILED') THEN 1 ELSE 0 END),0) AS failures
    FROM memory_night_review_case_attempts WHERE run_id=?`).bind(runId)
    .first<{ attempted: number; completed: number; failures: number }>();
  return {
    attempted: Number(row?.attempted ?? 0),completed: Number(row?.completed ?? 0),failures: Number(row?.failures ?? 0),
  };
}

export async function runNightReviewQueueStep(input: {
  env: Env;
  message: MemoryNightReviewQueueMessage;
  nowUtc?: string;
}): Promise<{ requeue: MemoryNightReviewQueueMessage | null; status: string; attempted: number; completed: number }> {
  if (input.env.MEMORY_NIGHT_REVIEW_ENABLED !== "true") {
    return { requeue: null,status: "disabled",attempted: 0,completed: 0 };
  }
  const run = await input.env.DB.prepare(`SELECT run_id,review_date_local,scheduled_for_utc,
      window_start_utc,window_end_utc,snapshot_id,base_txn_seq,max_cases
    FROM memory_night_review_runs WHERE run_id=?`).bind(input.message.runId).first<NightReviewRunRow>();
  if (!run || run.snapshot_id !== input.message.snapshotId || run.review_date_local !== input.message.reviewDate) {
    throw new Error("memory_night_review_queue_run_identity_mismatch");
  }
  const createdAtUtc = input.nowUtc ?? new Date().toISOString();
  let counts = await runCounts(input.env.DB,run.run_id);
  const priorState = await latestRunState(input.env.DB,run.run_id);
  if (priorState && ["COMPLETED","PARTIAL","FAILED"].includes(priorState.status)) {
    return { requeue: null,status: priorState.status.toLowerCase(),attempted: counts.attempted,completed: counts.completed };
  }
  await transitionRun({
    db: input.env.DB,runId: run.run_id,toStatus: "RUNNING",attemptedCases: counts.attempted,
    completedCases: counts.completed,reasonCode: "QUEUE_CONSUMER_STARTED",createdAtUtc,
  });
  const budget = Math.min(Math.max(Math.floor(input.message.remainingCases),0),run.max_cases - counts.attempted);
  if (budget <= 0) {
    const source = await loadNextSource(input.env.DB,run);
    const terminal = source ? "PARTIAL" : counts.failures > 0 ? "PARTIAL" : "COMPLETED";
    await transitionRun({
      db: input.env.DB,runId: run.run_id,toStatus: terminal,attemptedCases: counts.attempted,
      completedCases: counts.completed,reasonCode: source ? "CASE_BUDGET_EXHAUSTED" : counts.failures ? "CASE_FAILURES_REMAIN_UNRESOLVED" : "NO_PENDING_CASES",
      createdAtUtc,
    });
    return { requeue: null,status: terminal.toLowerCase(),attempted: counts.attempted,completed: counts.completed };
  }
  const source = await loadNextSource(input.env.DB,run);
  if (!source) {
    const terminal = counts.failures > 0 ? "PARTIAL" : "COMPLETED";
    await transitionRun({
      db: input.env.DB,runId: run.run_id,toStatus: terminal,attemptedCases: counts.attempted,
      completedCases: counts.completed,reasonCode: counts.failures ? "CASE_FAILURES_REMAIN_UNRESOLVED" : "NO_PENDING_CASES",
      createdAtUtc,
    });
    return { requeue: null,status: terminal.toLowerCase(),attempted: counts.attempted,completed: counts.completed };
  }
  await processSource({ env: input.env,run,source,createdAtUtc });
  counts = await runCounts(input.env.DB,run.run_id);
  const remainingCases = Math.min(input.message.remainingCases - 1,run.max_cases - counts.attempted);
  const nextSource = remainingCases > 0 ? await loadNextSource(input.env.DB,run) : null;
  if (nextSource) {
    return {
      requeue: {
        type: "memory_night_review",runId: run.run_id,reviewDate: run.review_date_local,
        snapshotId: run.snapshot_id,remainingCases,
      },
      status: "running",attempted: counts.attempted,completed: counts.completed,
    };
  }
  const stillPending = await loadNextSource(input.env.DB,run);
  const terminal = stillPending || counts.failures > 0 ? "PARTIAL" : "COMPLETED";
  await transitionRun({
    db: input.env.DB,runId: run.run_id,toStatus: terminal,attemptedCases: counts.attempted,
    completedCases: counts.completed,reasonCode: stillPending ? "CASE_BUDGET_EXHAUSTED"
      : counts.failures ? "CASE_FAILURES_REMAIN_UNRESOLVED" : "BOUNDED_REVIEW_COMPLETE",
    createdAtUtc,
  });
  return { requeue: null,status: terminal.toLowerCase(),attempted: counts.attempted,completed: counts.completed };
}
