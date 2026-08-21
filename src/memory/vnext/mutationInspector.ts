export type MutationInspectorRecord = {
  proposalId: string;
  proposalRevision: number;
  proposalKind: string;
  proposalState: string;
  stateVersion: number;
  captureId: string | null;
  captureKey: string | null;
  terminalEventId: string | null;
  terminalContentHash: string | null;
  secretScanArtifactId: string | null;
  captureStatus: string | null;
  extractorRunId: string | null;
  extractorStatus: string | null;
  model: string | null;
  extractorPromptVersion: string | null;
  extractorPromptHash: string | null;
  extractorSchemaVersion: string | null;
  extractorSchemaHash: string | null;
  extractorInputViewHash: string | null;
  extractorEvidenceAllowlistHash: string | null;
  extractorOutputHash: string | null;
  classification: string | null;
  protectedImpacts: string[];
  classificationRuleCodes: string[];
  candidateArtifactId: string | null;
  candidateSetTotalCount: number | null;
  candidatePageIndex: number | null;
  candidateTerminalPage: boolean | null;
  completeCandidateDigest: string | null;
  candidateMembers: Array<{
    candidateId: string;
    headRevision: number;
    ordinal: number;
    memberRole: "carry" | "new";
  }>;
  candidatePages: Array<{
    artifactId: string;
    pageIndex: number;
    previousPageHash: string | null;
    generatorVersion: string;
    candidateSourceHighWatermark: number;
    prefilterRuleCodes: string[];
    prefilterCounts: Record<string, number>;
    artifactHash: string;
    nextCandidateIndex: number;
    terminalPage: boolean;
    members: Array<{
      candidateId: string;
      headRevision: number;
      ordinal: number;
      memberRole: "carry" | "new";
    }>;
  }>;
  decisionId: string | null;
  decisionAction: string | null;
  selectedMergeTargetId: string | null;
  decisionRuleCodes: string[];
  semanticEffectKey: string | null;
  judgePromptVersion: string | null;
  judgeSchemaVersion: string | null;
  judgeInputHash: string | null;
  judgeOutput: {
    decision: "approve" | "merge" | "discard";
    score: number;
    grounded: boolean;
    durable: boolean;
    mergeTargetId: string | null;
    mergeScore: number | null;
    reasonCode: string;
  } | null;
  judgeOutputHash: string | null;
  decisionHash: string | null;
  decisionPolicyVersion: string | null;
  commitStatus: string | null;
  shadowOnly: boolean;
};

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("memory_inspector_array_invalid");
  }
  return value;
}

function parseNumberRecord(raw: string): Record<string, number> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memory_inspector_record_invalid");
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)) {
    throw new Error("memory_inspector_record_invalid");
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

function parseJudgeOutput(raw: string | null): MutationInspectorRecord["judgeOutput"] {
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memory_inspector_judge_output_invalid");
  const record = value as Record<string, unknown>;
  if (
    !["approve", "merge", "discard"].includes(String(record.decision))
    || typeof record.score !== "number"
    || typeof record.grounded !== "boolean"
    || typeof record.durable !== "boolean"
    || !(record.mergeTargetId === null || typeof record.mergeTargetId === "string")
    || !(record.mergeScore === null || typeof record.mergeScore === "number")
    || typeof record.reasonCode !== "string"
  ) throw new Error("memory_inspector_judge_output_invalid");
  return record as MutationInspectorRecord["judgeOutput"];
}

export async function readMutationInspector(
  db: D1Database,
  input: { proposalId: string; proposalRevision: number },
): Promise<MutationInspectorRecord | null> {
  const row = await db.prepare(
    `SELECT * FROM memory_mutation_inspector_v
     WHERE proposal_id=? AND proposal_revision=?
     ORDER BY decision_created_at DESC, candidate_page_index DESC
     LIMIT 1`,
  ).bind(input.proposalId, input.proposalRevision).first<Record<string, unknown>>();
  if (!row) return null;
  const artifactId = typeof row.candidate_artifact_id === "string" ? row.candidate_artifact_id : null;
  const members = artifactId
    ? await db.prepare(
      `SELECT candidate_id,head_revision,ordinal,member_role
       FROM memory_candidate_set_members WHERE artifact_id=? ORDER BY ordinal`,
    ).bind(artifactId).all<Record<string, unknown>>()
    : { results: [] };
  const pages = await db.prepare(
    `SELECT artifact_id,page_index,previous_page_hash,generator_version,candidate_source_high_watermark,
       prefilter_rule_codes_json,prefilter_counts_json,artifact_hash,next_candidate_index,terminal_page
     FROM memory_candidate_set_artifacts
     WHERE proposal_id=? AND proposal_revision=? ORDER BY page_index`,
  ).bind(input.proposalId, input.proposalRevision).all<Record<string, unknown>>();
  const candidatePages = await Promise.all(pages.results.map(async (page) => {
    const pageMembers = await db.prepare(
      `SELECT candidate_id,head_revision,ordinal,member_role
       FROM memory_candidate_set_members WHERE artifact_id=? ORDER BY ordinal`,
    ).bind(String(page.artifact_id)).all<Record<string, unknown>>();
    return {
      artifactId: String(page.artifact_id),
      pageIndex: Number(page.page_index),
      previousPageHash: typeof page.previous_page_hash === "string" ? page.previous_page_hash : null,
      generatorVersion: String(page.generator_version),
      candidateSourceHighWatermark: Number(page.candidate_source_high_watermark),
      prefilterRuleCodes: parseStringArray(String(page.prefilter_rule_codes_json)),
      prefilterCounts: parseNumberRecord(String(page.prefilter_counts_json)),
      artifactHash: String(page.artifact_hash),
      nextCandidateIndex: Number(page.next_candidate_index),
      terminalPage: Number(page.terminal_page) === 1,
      members: pageMembers.results.map((member) => ({
        candidateId: String(member.candidate_id),
        headRevision: Number(member.head_revision),
        ordinal: Number(member.ordinal),
        memberRole: member.member_role === "carry" ? "carry" as const : "new" as const,
      })),
    };
  }));
  return {
    proposalId: String(row.proposal_id),
    proposalRevision: Number(row.proposal_revision),
    proposalKind: String(row.proposal_kind),
    proposalState: String(row.projected_state),
    stateVersion: Number(row.state_version),
    captureId: typeof row.capture_id === "string" ? row.capture_id : null,
    captureKey: typeof row.capture_key === "string" ? row.capture_key : null,
    terminalEventId: typeof row.terminal_event_id === "string" ? row.terminal_event_id : null,
    terminalContentHash: typeof row.terminal_content_hash === "string" ? row.terminal_content_hash : null,
    secretScanArtifactId: typeof row.secret_scan_artifact_id === "string" ? row.secret_scan_artifact_id : null,
    captureStatus: typeof row.capture_status === "string" ? row.capture_status : null,
    extractorRunId: typeof row.extractor_run_id === "string" ? row.extractor_run_id : null,
    extractorStatus: typeof row.extractor_status === "string" ? row.extractor_status : null,
    model: typeof row.model === "string" ? row.model : null,
    extractorPromptVersion: typeof row.prompt_version === "string" ? row.prompt_version : null,
    extractorPromptHash: typeof row.prompt_hash === "string" ? row.prompt_hash : null,
    extractorSchemaVersion: typeof row.extractor_schema_version === "string" ? row.extractor_schema_version : null,
    extractorSchemaHash: typeof row.schema_hash === "string" ? row.schema_hash : null,
    extractorInputViewHash: typeof row.input_view_hash === "string" ? row.input_view_hash : null,
    extractorEvidenceAllowlistHash: typeof row.evidence_allowlist_hash === "string" ? row.evidence_allowlist_hash : null,
    extractorOutputHash: typeof row.extractor_output_hash === "string" ? row.extractor_output_hash : null,
    classification: typeof row.classification === "string" ? row.classification : null,
    protectedImpacts: parseStringArray(typeof row.protected_impacts_json === "string" ? row.protected_impacts_json : null),
    classificationRuleCodes: parseStringArray(typeof row.classification_rule_codes_json === "string" ? row.classification_rule_codes_json : null),
    candidateArtifactId: artifactId,
    candidateSetTotalCount: row.candidate_set_total_count === null || row.candidate_set_total_count === undefined ? null : Number(row.candidate_set_total_count),
    candidatePageIndex: row.candidate_page_index === null || row.candidate_page_index === undefined ? null : Number(row.candidate_page_index),
    candidateTerminalPage: row.candidate_terminal_page === null || row.candidate_terminal_page === undefined ? null : Number(row.candidate_terminal_page) === 1,
    completeCandidateDigest: typeof row.complete_candidate_digest === "string" ? row.complete_candidate_digest : null,
    candidateMembers: members.results.map((member) => ({
      candidateId: String(member.candidate_id),
      headRevision: Number(member.head_revision),
      ordinal: Number(member.ordinal),
      memberRole: member.member_role === "carry" ? "carry" : "new",
    })),
    candidatePages,
    decisionId: typeof row.decision_id === "string" ? row.decision_id : null,
    decisionAction: typeof row.decision_action === "string" ? row.decision_action : null,
    selectedMergeTargetId: typeof row.selected_merge_target_id === "string" ? row.selected_merge_target_id : null,
    decisionRuleCodes: parseStringArray(typeof row.decision_rule_codes_json === "string" ? row.decision_rule_codes_json : null),
    semanticEffectKey: typeof row.semantic_effect_key === "string" ? row.semantic_effect_key : null,
    judgePromptVersion: typeof row.judge_prompt_version === "string" ? row.judge_prompt_version : null,
    judgeSchemaVersion: typeof row.judge_schema_version === "string" ? row.judge_schema_version : null,
    judgeInputHash: typeof row.judge_input_hash === "string" ? row.judge_input_hash : null,
    judgeOutput: parseJudgeOutput(typeof row.judge_output_json === "string" ? row.judge_output_json : null),
    judgeOutputHash: typeof row.judge_output_hash === "string" ? row.judge_output_hash : null,
    decisionHash: typeof row.decision_hash === "string" ? row.decision_hash : null,
    decisionPolicyVersion: typeof row.decision_policy_version === "string" ? row.decision_policy_version : null,
    commitStatus: typeof row.commit_status === "string" ? row.commit_status : null,
    shadowOnly: Number(row.shadow_only ?? 0) === 1,
  };
}
