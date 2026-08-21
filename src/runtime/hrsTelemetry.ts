import type { TurnPlan } from "./turnPlan";
import type { HrsRollout } from "./hrsRollout";
import { sha256Hex } from "../utils/hash";

async function hashed(value: string): Promise<string> {
  return sha256Hex(value);
}

export async function persistHrsTurnPlan(input: {
  db: D1Database;
  requestId: string;
  namespace: string;
  plan: TurnPlan;
  thinkRoute: "not_evaluated" | "ineligible" | "eligible";
  rollout: HrsRollout;
  createdAt?: string;
}): Promise<string> {
  const requestIdHash = await hashed(input.requestId);
  await input.db.prepare(`INSERT OR IGNORE INTO hrs_turn_execution_plans
    (request_id_hash,namespace_hash,execution_profile,executor,planner_reason_codes_json,
     tool_surface_json,max_model_steps,latency_budget_ms,think_route,turn_plan_mode,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      requestIdHash,
      await hashed(input.namespace),
      input.plan.profile,
      input.plan.executor,
      JSON.stringify(input.plan.reasonCodes),
      JSON.stringify(input.plan.toolSurface),
      input.plan.maxModelSteps,
      input.plan.latencyBudgetMs,
      input.thinkRoute,
      input.rollout.turn,
      input.createdAt ?? new Date().toISOString(),
    ).run();
  return requestIdHash;
}

export async function persistHrsTurnOutcome(input: {
  db: D1Database;
  requestId: string;
  revision?: number;
  status: "prepared" | "submitted" | "held" | "running" | "completed" | "failed" | "attention_required";
  modelCallCount: number;
  toolCallCount: number;
  directCallCount: number;
  ingressToModelStartMs?: number | null;
  modelTotalMs?: number | null;
  finalCaptureMs?: number | null;
  finalPersistMs?: number | null;
  recoveryReason?: string | null;
}): Promise<void> {
  const requestIdHash = await hashed(input.requestId);
  const revision = input.revision ?? 1;
  const recordedAt = new Date().toISOString();
  const values = [
    input.status,input.modelCallCount,input.toolCallCount,input.directCallCount,
    input.ingressToModelStartMs ?? null,input.modelTotalMs ?? null,input.finalCaptureMs ?? null,
    input.finalPersistMs ?? null,input.recoveryReason?.slice(0,160) ?? null,recordedAt,
  ] as const;
  const changed = revision === 1
    ? await input.db.prepare(`INSERT INTO hrs_turn_execution_outcomes
        (request_id_hash,revision,status,model_call_count,tool_call_count,direct_call_count,
         ingress_to_model_start_ms,model_total_ms,final_capture_ms,final_persist_ms,recovery_reason,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(request_id_hash) DO NOTHING RETURNING request_id_hash`)
      .bind(requestIdHash,revision,...values).first<{ request_id_hash:string }>()
    : await input.db.prepare(`UPDATE hrs_turn_execution_outcomes SET
        revision=?,status=?,model_call_count=?,tool_call_count=?,direct_call_count=?,
        ingress_to_model_start_ms=?,model_total_ms=?,final_capture_ms=?,final_persist_ms=?,
        recovery_reason=?,recorded_at=?
      WHERE request_id_hash=? AND revision=? RETURNING request_id_hash`)
      .bind(revision,...values,requestIdHash,revision-1).first<{ request_id_hash:string }>();
  if (changed) return;
  const current = await input.db.prepare(`SELECT revision,status,model_call_count,tool_call_count,direct_call_count,
      ingress_to_model_start_ms,model_total_ms,final_capture_ms,final_persist_ms,recovery_reason
    FROM hrs_turn_execution_outcomes WHERE request_id_hash=?`).bind(requestIdHash).first<{
      revision:number;status:string;model_call_count:number;tool_call_count:number;direct_call_count:number;
      ingress_to_model_start_ms:number|null;model_total_ms:number|null;final_capture_ms:number|null;
      final_persist_ms:number|null;recovery_reason:string|null;
    }>();
  const exact = current?.revision === revision && current.status === input.status
    && current.model_call_count === input.modelCallCount && current.tool_call_count === input.toolCallCount
    && current.direct_call_count === input.directCallCount
    && current.ingress_to_model_start_ms === (input.ingressToModelStartMs ?? null)
    && current.model_total_ms === (input.modelTotalMs ?? null)
    && current.final_capture_ms === (input.finalCaptureMs ?? null)
    && current.final_persist_ms === (input.finalPersistMs ?? null)
    && current.recovery_reason === (input.recoveryReason?.slice(0,160) ?? null);
  if (!exact) {
    throw new Error("hrs_turn_outcome_stale_or_conflicting_revision");
  }
}
