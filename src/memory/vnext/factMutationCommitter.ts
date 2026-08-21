import { canonicalJson } from "../import/hashes";
import type { ClaimAtomV2, FactRevision, MutationRelation } from "./contracts";
import { memoryArtifactHash } from "./integrity";

export const MEMORY_FACT_MUTATION_COMMITTER_VERSION = "memory-fact-mutation-committer-v2.0.0";

type PromotionRow = {
  case_id: string;
  relation: Exclude<MutationRelation,"DUPLICATE" | "REINFORCE" | "DEFERRED_COMPARISON">;
  from_claim_atom_id: string;
  to_claim_atom_id: string;
  from_fact_revision_id: string;
  fact_key: string;
  revision: number;
  subject: ClaimAtomV2["subjectRef"];
  predicate: string;
  scope: string;
  old_epistemic_status: FactRevision["epistemicStatus"];
  old_lifecycle_status: FactRevision["lifecycleStatus"];
  target_subject: ClaimAtomV2["subjectRef"];
  target_predicate: string;
  target_value_json: string;
  target_scope_json: string;
  target_qualifiers_json: string;
  proposal_id: string;
  proposal_revision: number;
  input_id: string;
  namespace: string;
  legacy_memory_id: string;
  learned_at_utc: string;
};

type PromotionEvidenceRow = {
  interpretation_id: string;
  evidence_ref_id: string;
  evidence_relation: "SUPPORTS" | "CONFIRMS" | "CONTRADICTS" | "QUALIFIES";
  validated_authority: string;
  support_group_id: string | null;
  root_lineage_id: string | null;
  canonical_event_id: string;
  occurred_at_utc: string;
};

function parseObject(raw: string,code: string): Record<string,unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(code);
  return parsed as Record<string,unknown>;
}

function lifecycleForOld(relation: PromotionRow["relation"]): FactRevision["lifecycleStatus"] | null {
  if (relation === "STATE_CHANGE") return "historical";
  if (relation === "RETROACTIVE_CORRECTION") return "retracted";
  if (relation === "SCOPE_CLARIFICATION" || relation === "EPISTEMIC_RETRACTION") return "superseded";
  if (relation === "DISPUTE") return "current";
  return null;
}

function epistemicForNew(row: PromotionRow): FactRevision["epistemicStatus"] {
  if (row.relation === "DISPUTE") return "disputed";
  if (row.relation === "EPISTEMIC_RETRACTION") return "believed";
  return row.target_subject === "third_party" ? "believed" : "known";
}

export async function commitVerifiedFactMutation(input: {
  db: D1Database;
  mutationCaseId: string;
  createdAtUtc: string;
}): Promise<{
  commitId: string;
  fromFactRevisionId: string;
  toFactRevisionId: string;
  relation: PromotionRow["relation"];
  txnSeq: number;
}> {
  const row = await input.db.prepare(`SELECT
      c.case_id,r.relation,r.from_claim_atom_id,r.to_claim_atom_id,
      fm.fact_revision_id AS from_fact_revision_id,f.fact_key,f.revision,f.subject,f.predicate,f.scope,
      f.epistemic_status AS old_epistemic_status,f.lifecycle_status AS old_lifecycle_status,
      target.subject_ref AS target_subject,target.predicate_id AS target_predicate,
      target.canonical_value_json AS target_value_json,target.scope_json AS target_scope_json,
      target.qualifiers_json AS target_qualifiers_json,
      p.proposal_id,p.proposal_revision,receipt.input_id,i.namespace,i.legacy_memory_id,o.learned_at_utc
    FROM memory_claim_mutation_cases c
    JOIN memory_claim_mutation_relations r ON r.case_id=c.case_id
    JOIN memory_fact_revision_claim_atoms fm ON fm.claim_atom_id=r.from_claim_atom_id
    JOIN memory_fact_revisions f ON f.fact_revision_id=fm.fact_revision_id
    JOIN memory_claim_atoms target ON target.claim_atom_id=r.to_claim_atom_id
    JOIN memory_proposal_claim_atoms pca ON pca.claim_atom_id=target.claim_atom_id
    JOIN memory_proposals p ON p.proposal_id=pca.proposal_id AND p.proposal_revision=pca.proposal_revision
    JOIN memory_ordinary_fact_commit_receipts receipt
      ON receipt.proposal_id=p.proposal_id AND receipt.status='DEFERRED_COMPARISON'
    JOIN memory_ordinary_fact_write_inputs i ON i.input_id=receipt.input_id
    JOIN memory_ordinary_fact_write_origins o ON o.input_id=i.input_id
    WHERE c.case_id=? AND c.status='VERIFIED'
      AND r.relation IN ('COEXISTS','STATE_CHANGE','RETROACTIVE_CORRECTION','SCOPE_CLARIFICATION','EPISTEMIC_RETRACTION','DISPUTE')
    ORDER BY receipt.created_at,receipt.input_id LIMIT 1`).bind(input.mutationCaseId).first<PromotionRow>();
  if (!row) throw new Error("memory_verified_fact_mutation_source_unresolved");
  if (row.subject !== row.target_subject || row.predicate !== row.target_predicate) {
    throw new Error("memory_verified_fact_mutation_claim_family_mismatch");
  }
  const head = await input.db.prepare(`SELECT fact_revision_id,revision FROM memory_fact_revisions
    WHERE fact_key=? ORDER BY revision DESC LIMIT 1`).bind(row.fact_key).first<{ fact_revision_id: string; revision: number }>();
  if (!head || head.fact_revision_id !== row.from_fact_revision_id || Number(head.revision) !== Number(row.revision)) {
    throw new Error("memory_verified_fact_mutation_source_not_current_head");
  }
  const evidenceResult = await input.db.prepare(`SELECT
      i.interpretation_id,i.evidence_ref_id,i.evidence_relation,i.validated_authority,
      gm.support_group_id,m.root_lineage_id,r.canonical_event_id,r.occurred_at_utc
    FROM memory_evidence_interpretations i
    JOIN memory_evidence_refs r ON r.evidence_ref_id=i.evidence_ref_id
    LEFT JOIN memory_evidence_ref_v2_metadata m ON m.evidence_ref_id=i.evidence_ref_id
    LEFT JOIN memory_evidence_support_group_members gm ON gm.interpretation_id=i.interpretation_id
    WHERE i.proposal_id=? AND i.validated_authority<>'none'
    ORDER BY i.interpretation_id`).bind(row.proposal_id).all<PromotionEvidenceRow>();
  const evidence = evidenceResult.results ?? [];
  const positive = evidence.filter((item) => item.evidence_relation === "SUPPORTS" || item.evidence_relation === "CONFIRMS");
  if (positive.length === 0 || positive.some((item) => !item.support_group_id)) {
    throw new Error("memory_verified_fact_mutation_positive_support_incomplete");
  }
  const targetScope = parseObject(row.target_scope_json,"memory_verified_fact_mutation_scope_invalid");
  parseObject(row.target_qualifiers_json,"memory_verified_fact_mutation_qualifiers_invalid");
  const scopeKey = typeof targetScope.key === "string" ? targetScope.key : "";
  if (!scopeKey || scopeKey !== row.scope) throw new Error("memory_verified_fact_mutation_scope_key_mismatch");
  const validFromUtc = typeof targetScope.validFromUtc === "string" ? targetScope.validFromUtc : null;
  const validToUtc = typeof targetScope.validToUtc === "string" ? targetScope.validToUtc : null;
  const precision = typeof targetScope.temporalPrecision === "string" ? targetScope.temporalPrecision : "unknown";
  const observedAtUtc = evidence.map((item) => item.occurred_at_utc).sort().at(-1) ?? input.createdAtUtc;
  const nextRevision = Number(row.revision) + 1;
  const contentHash = await memoryArtifactHash("memory-fact-content",JSON.parse(row.target_value_json));
  const revisionHash = await memoryArtifactHash("memory-verified-fact-mutation-revision-v2", {
    mutationCaseId: row.case_id,
    factKey: row.fact_key,
    revision: nextRevision,
    targetClaimAtomId: row.to_claim_atom_id,
    contentHash,
  });
  const toFactRevisionId = `fr_${revisionHash.slice(0,32)}`;
  const commitHash = await memoryArtifactHash("memory-verified-fact-mutation-commit-v2", {
    mutationCaseId: row.case_id,
    fromFactRevisionId: row.from_fact_revision_id,
    toFactRevisionId,
    relation: row.relation,
    expectedHeadRevision: row.revision,
  });
  const commitId = `vfmc_${commitHash.slice(0,32)}`;
  const stateHash = await memoryArtifactHash("memory-verified-fact-mutation-state-v2", {
    commitId,fromFactRevisionId: row.from_fact_revision_id,relation: row.relation,
  });
  const statements: D1PreparedStatement[] = [
    input.db.prepare("UPDATE memory_txn_clock SET last_seq=last_seq+1 WHERE singleton=1"),
    input.db.prepare(`INSERT INTO memory_verified_fact_mutation_commits(
      commit_id,mutation_case_id,input_id,from_fact_revision_id,to_fact_revision_id,relation,
      expected_head_revision,observed_head_revision,txn_seq,commit_hash,policy_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?,(SELECT last_seq FROM memory_txn_clock WHERE singleton=1),?,?,?)`).bind(
      commitId,row.case_id,row.input_id,row.from_fact_revision_id,toFactRevisionId,row.relation,
      row.revision,row.revision,commitHash,MEMORY_FACT_MUTATION_COMMITTER_VERSION,input.createdAtUtc,
    ),
    input.db.prepare(`INSERT INTO memory_fact_revisions(
      fact_revision_id,fact_key,revision,subject,predicate,scope,value_json,epistemic_status,lifecycle_status,
      valid_from_utc,valid_to_utc,valid_start_kind,valid_end_kind,valid_time_precision,valid_time_basis,
      txn_from_seq,txn_to_seq,content_ref,created_at
    ) VALUES(?,?,?,?,?,?,?,?, 'current',?,?,?,?,?,'owner_explicit',
      (SELECT last_seq FROM memory_txn_clock WHERE singleton=1),NULL,?,?)`).bind(
      toFactRevisionId,row.fact_key,nextRevision,row.target_subject,row.target_predicate,scopeKey,row.target_value_json,
      epistemicForNew(row),validFromUtc,validToUtc,validFromUtc ? "KNOWN" : "UNKNOWN",
      validToUtc ? "KNOWN" : "OPEN_ENDED",precision,evidence[0].canonical_event_id,input.createdAtUtc,
    ),
    input.db.prepare(`INSERT INTO memory_fact_revision_metadata(
      fact_revision_id,namespace,observed_at_utc,learned_at_utc,protected_impacts_json,content_hash,created_at
    ) VALUES(?,?,?,?, '[]',?,?)`).bind(
      toFactRevisionId,row.namespace,observedAtUtc,row.learned_at_utc,contentHash,input.createdAtUtc,
    ),
    input.db.prepare(`INSERT INTO memory_fact_revision_claim_atoms(
      fact_revision_id,claim_atom_id,compatibility_hash,created_at
    ) VALUES(?,?,?,?)`).bind(toFactRevisionId,row.to_claim_atom_id,revisionHash,input.createdAtUtc),
    input.db.prepare(`INSERT INTO memory_fact_legacy_refs(
      legacy_memory_id,namespace,fact_revision_id,input_id,created_at
    ) VALUES(?,?,?,?,?)`).bind(row.legacy_memory_id,row.namespace,toFactRevisionId,row.input_id,input.createdAtUtc),
  ];
  for (const item of evidence) {
    const lineageId = item.root_lineage_id ?? `legacy:${item.evidence_ref_id}`;
    statements.push(input.db.prepare(`INSERT INTO memory_fact_revision_evidence(
      fact_revision_id,interpretation_id,lineage_id,support_group_id,relation,material,weak_observation,
      edge_txn_from_seq,edge_txn_to_seq,edge_close_reason
    ) VALUES(?,?,?,?,?,1,0,(SELECT last_seq FROM memory_txn_clock WHERE singleton=1),NULL,NULL)`).bind(
      toFactRevisionId,item.interpretation_id,lineageId,
      item.evidence_relation === "SUPPORTS" || item.evidence_relation === "CONFIRMS" ? item.support_group_id : null,
      item.evidence_relation,
    ));
  }
  const oldLifecycle = lifecycleForOld(row.relation);
  if (oldLifecycle !== null) {
    const oldEpistemic = row.old_epistemic_status;
    const nextOldEpistemic = row.relation === "DISPUTE" ? "disputed" : oldEpistemic;
    statements.push(input.db.prepare(`INSERT INTO memory_fact_revision_state_events(
      event_id,fact_revision_id,txn_seq,from_lifecycle_status,to_lifecycle_status,
      from_epistemic_status,to_epistemic_status,cause_ref,created_at
    ) VALUES(?,?,(SELECT last_seq FROM memory_txn_clock WHERE singleton=1),?,?,?,?,?,?)`).bind(
      `frse_${stateHash.slice(0,32)}`,row.from_fact_revision_id,row.old_lifecycle_status,oldLifecycle,
      oldEpistemic,nextOldEpistemic,commitId,input.createdAtUtc,
    ));
  }
  if (["STATE_CHANGE","RETROACTIVE_CORRECTION","SCOPE_CLARIFICATION","EPISTEMIC_RETRACTION"].includes(row.relation)) {
    statements.push(input.db.prepare(`INSERT INTO memory_fact_revision_relations(
      relation_id,from_revision_id,to_revision_id,relation,txn_from_seq,txn_to_seq,mutation_decision_id,created_at
    ) VALUES(?,?,?,?,(SELECT last_seq FROM memory_txn_clock WHERE singleton=1),NULL,?,?)`).bind(
      `frr_${stateHash.slice(0,32)}`,row.from_fact_revision_id,toFactRevisionId,row.relation,commitId,input.createdAtUtc,
    ));
  }
  const proposalTransitions = [
    ["DEFERRED_COMPARISON","VALIDATED","verified_mutation_relation",3,4],
    ["VALIDATED","AUTO_COMMIT_READY","verified_mutation_commit_ready",4,5],
    ["AUTO_COMMIT_READY","COMMITTED",commitId,5,6],
  ] as const;
  for (const [fromState,toState,causeRef,expectedVersion,resultingVersion] of proposalTransitions) {
    statements.push(input.db.prepare(`INSERT INTO memory_proposal_state_events(
      event_id,proposal_id,proposal_revision,from_state,to_state,cause_ref,
      expected_state_version,resulting_state_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      `pse_${revisionHash.slice(0,24)}_${resultingVersion}`,row.proposal_id,row.proposal_revision,
      fromState,toState,causeRef,expectedVersion,resultingVersion,input.createdAtUtc,
    ));
  }
  await input.db.batch(statements);
  const committed = await input.db.prepare(`SELECT txn_seq FROM memory_verified_fact_mutation_commits WHERE commit_id=?`)
    .bind(commitId).first<{ txn_seq: number }>();
  if (!committed) throw new Error("memory_verified_fact_mutation_commit_missing");
  return {
    commitId,
    fromFactRevisionId: row.from_fact_revision_id,
    toFactRevisionId,
    relation: row.relation,
    txnSeq: Number(committed.txn_seq),
  };
}
