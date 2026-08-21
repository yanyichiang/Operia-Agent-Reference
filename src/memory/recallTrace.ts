import { markMemoriesRecalled } from "../db/memories";
import { markMemoriesInjected } from "../db/v2";
import type { Env } from "../types";
import { sha256Hex } from "../utils/hash";
import type {
  RecallCandidateTrace,
  RecallDecision,
  RecallResult,
} from "./v2/recall";

const TRACE_RETENTION_DAYS = 90;

export interface AssembledMemoryRef {
  id: string;
  source: string | null;
  byte_count: number;
}

function retentionUntil(now: Date): string {
  return new Date(now.getTime() + TRACE_RETENTION_DAYS * 86_400_000).toISOString();
}

function scoreBucket(score: number): "high" | "medium" | "low" {
  return score >= 0.75 ? "high" : score >= 0.4 ? "medium" : "low";
}

function finalizeCandidate(
  candidate: RecallCandidateTrace,
  injected: Map<string, AssembledMemoryRef>
): RecallCandidateTrace & { decision: RecallDecision } {
  if (candidate.decision !== "selected_for_assembly") {
    return candidate as RecallCandidateTrace & { decision: RecallDecision };
  }
  if (injected.has(candidate.candidate_ref)) {
    return { ...candidate, decision: "injected", decision_stage: "assembler" };
  }
  return { ...candidate, decision: "source_unavailable", decision_stage: "assembler" };
}

export async function persistRecallAssemblyTrace(
  env: Env,
  input: {
    namespace: string;
    recall: RecallResult | null;
    injectedMemories: AssembledMemoryRef[];
  }
): Promise<void> {
  const trace = input.recall?.trace;
  if (!trace) return;

  const now = new Date();
  const nowIso = now.toISOString();
  const injectedById = new Map(input.injectedMemories.map((memory) => [memory.id, memory]));
  const candidates = trace.candidates.map((candidate) => finalizeCandidate(candidate, injectedById));
  const injectedCandidates = candidates.filter((candidate) => candidate.decision === "injected");
  const injectedBytes = injectedCandidates.reduce(
    (sum, candidate) => sum + (injectedById.get(candidate.candidate_ref)?.byte_count ?? 0),
    0
  );
  const run = {
    ...trace.run,
    injected_count: injectedCandidates.length,
    injection_bytes: injectedBytes,
    completed_at_utc: nowIso,
  };
  const expiresAt = retentionUntil(now);

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO recall_runs(
      id,request_id_hash,namespace_hash,current_event_ref,query_hash,policy_version,index_version,
      reranker_version,channels_requested_json,channels_completed_json,channels_failed_json,
      available_count,injected_count,injection_bytes,started_at_utc,completed_at_utc,retention_until,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        channels_completed_json=excluded.channels_completed_json,
        channels_failed_json=excluded.channels_failed_json,
        available_count=excluded.available_count,
        injected_count=excluded.injected_count,
        injection_bytes=excluded.injection_bytes,
        completed_at_utc=excluded.completed_at_utc,
        retention_until=excluded.retention_until`)
      .bind(
        run.id,
        run.request_id_hash,
        run.namespace_hash,
        run.current_event_ref,
        run.query_hash,
        run.policy_version,
        run.index_version,
        run.reranker_version,
        JSON.stringify(run.channels_requested),
        JSON.stringify(run.channels_completed),
        JSON.stringify(run.channels_failed),
        run.available_count,
        run.injected_count,
        run.injection_bytes,
        run.started_at_utc,
        run.completed_at_utc,
        expiresAt,
        nowIso
      ),
  ];

  for (const candidate of candidates) {
    statements.push(env.DB.prepare(`INSERT INTO recall_candidate_traces(
      run_id,candidate_ref,source_layer,channel_ranks_json,channel_scores_json,rrf_score,
      score_components_json,pre_rerank_rank,rerank_score,post_rerank_rank,fact_key_hash,
      fact_status,duplicate_group,hydrated_event_refs_json,final_rank,decision,decision_stage,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id,candidate_ref) DO UPDATE SET
        final_rank=excluded.final_rank,decision=excluded.decision,
        decision_stage=excluded.decision_stage,created_at=excluded.created_at`)
      .bind(
        run.id,
        candidate.candidate_ref,
        candidate.source_layer,
        JSON.stringify(candidate.channel_ranks),
        JSON.stringify(candidate.channel_scores),
        candidate.rrf_score,
        JSON.stringify(candidate.score_components),
        candidate.pre_rerank_rank,
        candidate.rerank_score,
        candidate.post_rerank_rank,
        candidate.fact_key_hash,
        candidate.fact_status,
        candidate.duplicate_group,
        JSON.stringify(candidate.hydrated_event_refs),
        candidate.final_rank,
        candidate.decision,
        candidate.decision_stage,
        nowIso
      ));
  }

  for (const candidate of injectedCandidates) {
    const assembled = injectedById.get(candidate.candidate_ref)!;
    const recordHash = await sha256Hex(candidate.candidate_ref);
    statements.push(
      env.DB.prepare(`INSERT OR REPLACE INTO recall_injection_receipts(
        run_id,candidate_ref,request_id_hash,block_id,final_rank,byte_count,assembled_at_utc)
        VALUES(?,?,?,'dynamic_memory_patch',?,?,?)`)
        .bind(
          run.id,
          candidate.candidate_ref,
          run.request_id_hash,
          candidate.final_rank ?? 1,
          assembled.byte_count,
          nowIso
        ),
      env.DB.prepare(`INSERT OR IGNORE INTO context_injection_receipts(
        namespace_hash,request_id_hash,layer,record_hash,selected_at_utc,freshness,score_bucket,byte_count,created_at)
        VALUES(?,?,'ordinary_memory',?,?,'unknown',?,?,?)`)
        .bind(
          run.namespace_hash,
          run.request_id_hash,
          recordHash,
          nowIso,
          scoreBucket(candidate.score_components.final_score ?? 0),
          assembled.byte_count,
          nowIso
        )
    );
  }

  statements.push(env.DB.prepare(`INSERT INTO recall_metrics_daily(
      metric_date,namespace_hash,policy_version,run_count,candidate_count,injected_count,
      injection_bytes,channel_failure_count,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(metric_date,namespace_hash,policy_version) DO UPDATE SET
      run_count=run_count+excluded.run_count,
      candidate_count=candidate_count+excluded.candidate_count,
      injected_count=injected_count+excluded.injected_count,
      injection_bytes=injection_bytes+excluded.injection_bytes,
      channel_failure_count=channel_failure_count+excluded.channel_failure_count,
      updated_at=excluded.updated_at`)
    .bind(
      nowIso.slice(0, 10),
      run.namespace_hash,
      run.policy_version,
      1,
      candidates.length,
      injectedCandidates.length,
      injectedBytes,
      run.channels_failed.length,
      nowIso
    ));

  await env.DB.batch(statements);

  const memoryHitIds = new Set(
    (input.recall?.hits ?? [])
      .filter((hit) => hit.source_layer === "memory")
      .map((hit) => hit.id)
  );
  const injectedMemoryIds = injectedCandidates
    .map((candidate) => candidate.candidate_ref)
    .filter((id) => memoryHitIds.has(id));
  if (injectedMemoryIds.length > 0) {
    await Promise.all([
      markMemoriesRecalled(env.DB, { namespace: input.namespace, ids: injectedMemoryIds }),
      markMemoriesInjected(env.DB, { namespace: input.namespace, ids: injectedMemoryIds }),
    ]);
  }
}
