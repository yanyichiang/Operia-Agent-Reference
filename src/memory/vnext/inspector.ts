export const MEMORY_VNEXT2_INSPECTOR_VERSION = "memory-vnext2-inspector-v1";

type InspectorRows = Array<Record<string, unknown>>;

function rows(result: D1Result<unknown>): InspectorRows {
  return (result.results ?? []) as InspectorRows;
}

export async function readMemoryVnext2Inspector(input: {
  db: D1Database;
  namespace: string;
  namespaceHash: string;
  limit: number;
}): Promise<Record<string, unknown>> {
  const { db,namespace,namespaceHash,limit } = input;
  const scopedNightCases = `
    WITH scoped_cases AS (
      SELECT DISTINCT c.case_id
      FROM memory_night_review_cases c
      LEFT JOIN memory_claim_atoms aa ON aa.claim_atom_id=c.claim_a_id
      LEFT JOIN memory_claim_groups ga ON ga.claim_group_id=aa.claim_group_id
      LEFT JOIN messages ma ON ma.id=ga.canonical_event_id
      LEFT JOIN memory_claim_atoms ab ON ab.claim_atom_id=c.claim_b_id
      LEFT JOIN memory_claim_groups gb ON gb.claim_group_id=ab.claim_group_id
      LEFT JOIN messages mb ON mb.id=gb.canonical_event_id
      WHERE ma.namespace=? OR mb.namespace=? OR EXISTS (
        SELECT 1
        FROM memory_claim_dispute_members dm
        JOIN memory_claim_atoms da ON da.claim_atom_id=dm.claim_atom_id
        JOIN memory_claim_groups dg ON dg.claim_group_id=da.claim_group_id
        JOIN messages md ON md.id=dg.canonical_event_id
        WHERE dm.dispute_id=c.dispute_id AND md.namespace=?
      )
    )`;
  const results = await db.batch([
    db.prepare(`SELECT contract_key,contract_version,created_at
      FROM memory_vnext_contract_versions
      WHERE contract_key IN (
        'proposal_producer','evidence_unit','claim_atom','predicate_registry','mutation_relation',
        'mutation_verifier','fact_mutation_committer','support_coverage','memory_influence',
        'dynamic_recall_need','counterfactual_behavior_evaluation','owner_cognitive_model',
        'night_review_court','night_review_runtime','read_path','evidence_bundle',
        'structural_hydration','mb1','visible_context_ledger','exact_dispatch_receipt'
      ) ORDER BY contract_key`),
    db.prepare(`SELECT i.evidence_unit_id,i.evidence_unit_kind,i.canonical_event_id,i.conversation_id,
        i.actor_class,i.event_role,i.reply_to_event_id,i.content_revision,i.byte_start,i.byte_end,
        i.span_hash,i.episode_id,i.root_lineage_id,i.elicitation_origin,
        i.composite_strong_owner_authority,i.structural_edge_count,i.created_at
      FROM memory_evidence_unit_inspector_v i
      JOIN messages m ON m.id=i.canonical_event_id AND m.namespace=?
      ORDER BY i.created_at DESC,i.evidence_unit_id LIMIT ?`).bind(namespace,limit),
    db.prepare(`SELECT i.claim_atom_id,i.claim_group_id,i.canonical_event_id,i.content_revision,
        i.subject_ref,i.assertion_kind,i.predicate_id,i.object_ref,i.scope_json,i.qualifiers_json,
        i.evidence_unit_ids_json,i.predicate_registry_version,i.normalization_version,i.atom_hash,
        i.proposal_id,i.proposal_revision,i.evidence_unit_count,i.created_at
      FROM memory_claim_atom_inspector_v i
      JOIN messages m ON m.id=i.canonical_event_id AND m.namespace=?
      ORDER BY i.created_at DESC,i.claim_atom_id LIMIT ?`).bind(namespace,limit),
    db.prepare(`SELECT DISTINCT i.*
      FROM memory_claim_mutation_inspector_v i
      JOIN memory_claim_atoms a ON a.claim_atom_id=i.claim_a_id
      JOIN memory_claim_groups g ON g.claim_group_id=a.claim_group_id
      JOIN messages m ON m.id=g.canonical_event_id AND m.namespace=?
      ORDER BY i.created_at DESC,i.case_id LIMIT ?`).bind(namespace,limit),
    db.prepare(`SELECT DISTINCT i.*
      FROM memory_claim_dispute_inspector_v i
      JOIN memory_claim_dispute_members dm ON dm.dispute_id=i.dispute_id
      JOIN memory_claim_atoms a ON a.claim_atom_id=dm.claim_atom_id
      JOIN memory_claim_groups g ON g.claim_group_id=a.claim_group_id
      JOIN messages m ON m.id=g.canonical_event_id AND m.namespace=?
      ORDER BY i.created_at DESC,i.dispute_id LIMIT ?`).bind(namespace,limit),
    db.prepare(`SELECT i.*
      FROM memory_support_coverage_inspector_v i
      JOIN memory_fact_revision_metadata f ON f.fact_revision_id=i.fact_revision_id AND f.namespace=?
      ORDER BY i.created_at DESC,i.coverage_snapshot_id LIMIT ?`).bind(namespace,limit),
    db.prepare(`SELECT i.dimension_revision_id,i.dimension_key,i.family_key,i.revision,i.assertion_mode,
        i.epistemic_status,i.stability,i.valid_from_utc,i.valid_to_utc,i.support_group_ids_json,
        i.contradiction_edge_ids_json,i.alternative_revision_ids_json,
        i.derived_from_dimension_revision_ids_json,i.root_lineage_ids_json,i.lineage_closure_hash,
        i.txn_from_seq,i.txn_to_seq,i.inference_policy,i.producer_provider,i.producer_model,
        i.snapshot_ids_json,i.created_at
      FROM memory_owner_model_inspector_v i
      WHERE EXISTS (
        SELECT 1 FROM memory_owner_dimension_fact_support s
        JOIN memory_fact_revision_metadata f ON f.fact_revision_id=s.fact_revision_id
        WHERE s.dimension_revision_id=i.dimension_revision_id AND f.namespace=?
      )
      ORDER BY i.created_at DESC,i.dimension_revision_id LIMIT ?`).bind(namespace,limit),
    db.prepare(`${scopedNightCases}
      SELECT i.* FROM memory_night_review_attempt_inspector_v i
      JOIN scoped_cases s ON s.case_id=i.case_id
      ORDER BY i.created_at DESC,i.attempt_id LIMIT ?`).bind(namespace,namespace,namespace,limit),
    db.prepare(`${scopedNightCases}
      SELECT DISTINCT i.* FROM memory_night_review_run_inspector_v i
      JOIN memory_night_review_case_attempts a ON a.run_id=i.run_id
      JOIN scoped_cases s ON s.case_id=a.case_id
      ORDER BY i.created_at DESC,i.run_id LIMIT ?`).bind(namespace,namespace,namespace,limit),
    db.prepare(`SELECT * FROM memory_dynamic_recall_inspector_v
      WHERE namespace_hash=? ORDER BY created_at DESC,decision_id LIMIT ?`).bind(namespaceHash,limit),
    db.prepare(`SELECT * FROM memory_vnext_read_inspector_v
      WHERE run_id IN (SELECT run_id FROM memory_vnext_read_runs WHERE namespace_hash=?)
      ORDER BY created_at DESC,run_id LIMIT ?`).bind(namespaceHash,limit),
    db.prepare(`SELECT i.* FROM memory_evidence_bundle_inspector_v i
      JOIN memory_vnext_read_runs r ON r.run_id=i.run_id AND r.namespace_hash=?
      ORDER BY i.created_at DESC,i.evidence_bundle_id LIMIT ?`).bind(namespaceHash,limit),
    db.prepare(`SELECT p.packet_hash,p.run_id,p.need,p.requested_view,p.status,p.miss_domain,
        p.payload_bytes,p.total_bytes,p.estimated_tokens,p.renderer_version,p.shadow_only,p.created_at,
        COUNT(g.group_hash) AS group_count
      FROM memory_mb1_packets p
      JOIN memory_vnext_read_runs r ON r.run_id=p.run_id AND r.namespace_hash=?
      LEFT JOIN memory_mb1_packet_groups g ON g.packet_hash=p.packet_hash
      GROUP BY p.packet_hash ORDER BY p.created_at DESC,p.packet_hash LIMIT ?`).bind(namespaceHash,limit),
    db.prepare(`SELECT i.* FROM memory_exact_dispatch_inspector_v i
      JOIN memory_vnext_read_runs r ON r.run_id=i.run_id AND r.namespace_hash=?
      ORDER BY i.assembled_at DESC,i.receipt_id LIMIT ?`).bind(namespaceHash,limit),
    db.prepare(`SELECT summary_id,corpus_id,primary_provider,primary_model,evaluator_version,
        complete_case_count,needful_gain_count,memory_induced_regression_count,oracle_gap_count,
        evidence_utilization_failure_count,unnecessary_injection_count,neededness_false_negative_count,
        unnecessary_interference_count,safe_marginal_utility,thresholds_json,blocker_codes_json,
        metrics_hash,created_at
      FROM memory_counterfactual_summaries ORDER BY created_at DESC,summary_id LIMIT ?`).bind(limit),
  ]);

  return {
    inspector_version: MEMORY_VNEXT2_INSPECTOR_VERSION,
    namespace_hash: namespaceHash,
    limit,
    privacy_boundary: {
      raw_evidence_content_included: false,
      canonical_values_included: false,
      portrait_content_included: false,
      mutation_capability: false,
    },
    contract_versions: rows(results[0]),
    evidence_units: rows(results[1]),
    claim_atoms: rows(results[2]),
    mutation_cases: rows(results[3]),
    dispute_sets: rows(results[4]),
    support_coverage: rows(results[5]),
    owner_model_dimensions: rows(results[6]),
    night_review_attempts: rows(results[7]),
    night_review_runs: rows(results[8]),
    dynamic_recall: rows(results[9]),
    read_runs: rows(results[10]),
    evidence_bundles: rows(results[11]),
    mb1_packets: rows(results[12]),
    exact_dispatch_receipts: rows(results[13]),
    counterfactual_summaries: rows(results[14]),
  };
}
