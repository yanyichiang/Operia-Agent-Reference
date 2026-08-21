import type { OperiaThinkRunResult } from "./OperiaThinkHarness";
import { qualifiesNaturalThinkToolTask } from "./productionThinkRouting";
import { observeProductionSdkShadow, type ProductionSdkShadowSnapshot } from "./sdkShadow";

type ObservationEnv = { DB: D1Database };

export async function finishThinkCanaryObservation(env: ObservationEnv, input: {
  requestId: string;
  result?: OperiaThinkRunResult;
  latencyMs: number;
  errorCode?: string;
  qualifyingContext?: {
    naturalSource: boolean;
    replay: boolean;
    continuation: boolean;
    synthetic: boolean;
  };
}): Promise<void> {
  const result = input.result;
  const qualifying = Boolean(result && input.qualifyingContext && qualifiesNaturalThinkToolTask({
    ...input.qualifyingContext,
    status: result.status,
    toolCalls: result.toolCalls,
    toolErrors: result.toolErrors,
    externalWrites: 0,
    pendingApprovals: result.pendingApprovals.length + result.pendingSdkApprovals.length,
  }));
  const qualificationReason = qualifying
    ? "completed_natural_tool_task"
    : !result ? "think_failed"
      : result.toolCalls === 0 ? "answer_only"
        : result.toolErrors.length > 0 ? "tool_error"
          : result.pendingApprovals.length + result.pendingSdkApprovals.length > 0 ? "approval_pending"
          : "not_qualifying";
  const updated = await env.DB.prepare(`UPDATE think_canary_runs SET
    status=?,model_calls=?,tool_calls=?,direct_calls=?,codemode_calls=?,skill_calls=?,external_writes=0,
    tool_keys_json=?,tool_errors_json=?,natural_task=?,qualifying_tool_task=?,qualification_reason=?,input_tokens=?,output_tokens=?,cached_input_tokens=?,cache_write_input_tokens=?,latency_ms=?,error_code=?,telemetry_status=?,sdk_shadow_status=?,sdk_shadow_json=?,sdk_shadow_error_code=?,completed_at=?
    WHERE request_id=? RETURNING request_id`).bind(
      result ? result.status : "failed",
      result?.modelCalls ?? 0,
      result?.toolCalls ?? 0,
      result?.directCalls ?? 0,
      result?.codeModeCalls ?? 0,
      result?.skillCalls ?? 0,
      JSON.stringify(result?.toolKeys ?? []),
      JSON.stringify(result?.toolErrors ?? []),
      result ? 1 : 0,
      qualifying ? 1 : 0,
      qualificationReason,
      result?.usage.inputTokens ?? 0,
      result?.usage.outputTokens ?? 0,
      result?.usage.cachedInputTokens ?? 0,
      result?.usage.cacheWriteTokens ?? 0,
      input.latencyMs,
      input.errorCode ?? null,
      "completed",
      result?.sdkShadowSnapshot.enabled ? "pending" : "disabled",
      "{}",
      null,
      new Date().toISOString(),
      input.requestId,
  ).first<{request_id:string}>();
  if (!updated) throw new Error("think_canary_observation_row_missing");
  if (result) await persistThinkSdkShadowObservation(env, input.requestId, result.sdkShadowSnapshot);
}

export async function parkThinkCanaryObservation(env: ObservationEnv, input: {
  requestId: string;
  result: OperiaThinkRunResult;
  latencyMs: number;
}): Promise<void> {
  const result = input.result;
  const updated = await env.DB.prepare(`UPDATE think_canary_runs SET
    model_calls=?,tool_calls=?,direct_calls=?,codemode_calls=?,skill_calls=?,external_writes=0,
    tool_keys_json=?,tool_errors_json=?,natural_task=0,qualifying_tool_task=0,qualification_reason='codemode_pending',
    input_tokens=?,output_tokens=?,cached_input_tokens=?,cache_write_input_tokens=?,latency_ms=?,error_code=NULL,
    telemetry_status='parked',sdk_shadow_status=?,sdk_shadow_json=?,sdk_shadow_error_code=? WHERE request_id=? AND status='started'
    RETURNING request_id`).bind(
      result.modelCalls,
      result.toolCalls,
      result.directCalls,
      result.codeModeCalls,
      result.skillCalls,
      JSON.stringify(result.toolKeys),
      JSON.stringify(result.toolErrors),
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.cachedInputTokens,
      result.usage.cacheWriteTokens,
      input.latencyMs,
      result.sdkShadowSnapshot.enabled ? "pending" : "disabled",
      "{}",
      null,
      input.requestId,
    ).first<{request_id:string}>();
  if (!updated) throw new Error("think_canary_park_observation_row_missing");
  await persistThinkSdkShadowObservation(env, input.requestId, result.sdkShadowSnapshot);
}

async function persistThinkSdkShadowObservation(
  env: ObservationEnv,
  requestId: string,
  snapshot: ProductionSdkShadowSnapshot,
): Promise<void> {
  if (!snapshot.enabled) return;
  const observation = await observeProductionSdkShadow(snapshot);
  const updated = await env.DB.prepare(`UPDATE think_canary_runs SET
    sdk_shadow_status=?,sdk_shadow_json=?,sdk_shadow_error_code=? WHERE request_id=? RETURNING request_id`).bind(
      observation.status,
      JSON.stringify(observation.result ?? {}),
      observation.errorCode,
      requestId,
    ).first<{request_id:string}>();
  if (!updated) throw new Error("think_sdk_shadow_observation_row_missing");
}

export async function getThinkObservationSummary(env: ObservationEnv, hours: number): Promise<Record<string, unknown>> {
  const boundedHours = Math.min(Math.max(Math.floor(hours || 24), 1), 24 * 30);
  const since = new Date(Date.now() - boundedHours * 60 * 60_000).toISOString();
  const row = await env.DB.prepare(`SELECT
      COUNT(*) AS total_turns,
      SUM(CASE WHEN qualifying_tool_task=1 THEN 1 ELSE 0 END) AS successful_tool_tasks,
      SUM(CASE WHEN status='completed' AND tool_calls=0 THEN 1 ELSE 0 END) AS answer_only,
      SUM(CASE WHEN status='failed' OR json_array_length(tool_errors_json)>0 THEN 1 ELSE 0 END) AS tool_error,
      SUM(CASE WHEN qualification_reason='approval_pending' THEN 1 ELSE 0 END) AS approval_pending,
      SUM(CASE WHEN sdk_shadow_status!='disabled' THEN 1 ELSE 0 END) AS shadow_observed,
      SUM(CASE WHEN sdk_shadow_status='shadowed' AND json_extract(sdk_shadow_json,'$.comparison.allRoutingFieldsMatch')=1 THEN 1 ELSE 0 END) AS shadow_matched,
      SUM(CASE WHEN sdk_shadow_status='shadowed' AND json_extract(sdk_shadow_json,'$.comparison.allRoutingFieldsMatch')=0 THEN 1 ELSE 0 END) AS shadow_mismatched,
      SUM(CASE WHEN sdk_shadow_status='incompatible' THEN 1 ELSE 0 END) AS shadow_incompatible,
      SUM(CASE WHEN sdk_shadow_status='error' THEN 1 ELSE 0 END) AS shadow_error,
      SUM(CASE WHEN sdk_shadow_status='pending' THEN 1 ELSE 0 END) AS shadow_pending,
      SUM(CASE WHEN telemetry_status!='completed' AND julianday(started_at)<julianday('now','-5 minutes') THEN 1 ELSE 0 END) AS telemetry_degraded
    FROM think_canary_runs WHERE started_at>=?`).bind(since).first<Record<string, number | null>>();
  return {
    hours: boundedHours,
    since,
    totalThinkTurns: Number(row?.total_turns ?? 0),
    successfulToolTasks: Number(row?.successful_tool_tasks ?? 0),
    answerOnly: Number(row?.answer_only ?? 0),
    toolError: Number(row?.tool_error ?? 0),
    approvalPending: Number(row?.approval_pending ?? 0),
    shadowObserved: Number(row?.shadow_observed ?? 0),
    shadowMatched: Number(row?.shadow_matched ?? 0),
    shadowMismatched: Number(row?.shadow_mismatched ?? 0),
    shadowIncompatible: Number(row?.shadow_incompatible ?? 0),
    shadowError: Number(row?.shadow_error ?? 0),
    shadowPending: Number(row?.shadow_pending ?? 0),
    telemetryDegraded: Number(row?.telemetry_degraded ?? 0),
    expansionSampleField: "qualifying_tool_task",
    canonicalDeduplication: "request_id_primary_key",
  };
}
