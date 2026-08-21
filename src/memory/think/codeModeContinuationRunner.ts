import { saveAssistantMessage } from "../../db/messages";
import { saveUsageLog } from "../../db/usageLogs";
import { enqueueMemoryMaintenanceIfNeeded, enqueueRetentionIfNeeded } from "../../queue/producer";
import { applyRegexRules } from "../../preset/regexPipeline";
import { CONTENT_RULES } from "../../preset/regexRules";
import { classifyProvider } from "../../proxy/resolveModel";
import { getAnthropicCacheTtlMode } from "../../proxy/anthropicAdapter";
import { handoffTgKnownFinalProjection, requireTgInferenceAttention, storeTgDeferredThinkFinalPackage } from "../../tg/inferenceRun";
import type { Env, OpenAIChatResponse, TokenUsage } from "../../types";
import { readCompletedInferenceReplay } from "../inferenceIdempotency";
import { completeThinkContinuationReplay, enqueueThinkContinuationFinalWake } from "../../runtime/hrsThinkContinuationFinal";
import {
  enqueueThinkCodeModeContinuation,
  readThinkCodeModeContinuation,
  sha256Hex,
  THINK_CODEMODE_FINALIZATION_ATTEMPT_LIMIT,
  THINK_CODEMODE_PROVIDER_ATTEMPT_LIMIT,
  thinkCodeModeSubmissionId,
  updateThinkCodeModeContinuation,
  type ThinkCodeModeContinuationRow,
} from "./codeModeContinuation";
import type { OperiaCodeModeContinuationInspection } from "./OperiaThinkHarness";
import { completeProductionThinkTask, resumeProductionCodeMode, type ProductionCodeModeCompleted } from "./productionAgentGatewayClient";

type OperiaThinkCodeModeRpc = {
  setName(name: string): Promise<void>;
  submitCodeModeContinuation(input: {
    requestId: string;
    executionId: string;
    receiptHash: string;
    result: ProductionCodeModeCompleted;
    submissionId: string;
  }): Promise<{ submissionId: string; accepted: boolean; status: string }>;
  inspectCodeModeContinuation(input: { requestId: string; submissionId: string }): Promise<OperiaCodeModeContinuationInspection>;
  completeCodeModeContinuation(input: { requestId: string; submissionId: string }): Promise<void>;
};

export async function resumeThinkCodeModeContinuation(
  env: Env,
  input: { codemodeRef: string; attempt: number },
  ctx?: ExecutionContext,
): Promise<void> {
  const row = await readThinkCodeModeContinuation(env.DB, input.codemodeRef);
  if (!row) return;
  if (isTerminal(row.status)) {
    if (row.status !== "completed") {
      try {
        await ensureThinkCodeModeTerminalProjection(env, row);
      } catch (error) {
        await enqueueKnownFinalProjectionRepair(env, row, input.attempt, retryDelay(input.attempt));
        console.error("operia_think_codemode_terminal_projection_degraded", { code: boundedCode(error) });
      }
    }
    return;
  }
  if (row.status === "continuing" || row.status === "finalizing") {
    try {
      if (await repairPersistedCodeModeFinal(env, row, input.attempt)) return;
    } catch (error) {
      await handleCodeModeReplayProbeFailure(env, row, input.attempt, error);
      return;
    }
  }
  const providerNotSubmitted = row.status === "pending_agent" || row.status === "result_ready";
  const attemptLimit = providerNotSubmitted
    ? THINK_CODEMODE_PROVIDER_ATTEMPT_LIMIT
    : THINK_CODEMODE_FINALIZATION_ATTEMPT_LIMIT;
  if (input.attempt >= attemptLimit || (providerNotSubmitted && Date.parse(row.expires_at) <= Date.now())) {
    await terminalizeOuterContinuation(env, row, { to: "attention_required", errorCode: providerNotSubmitted
      ? "think_codemode_attempt_budget_exhausted"
      : "think_codemode_finalization_budget_exhausted" });
    return;
  }

  if (row.status === "pending_agent") {
    let state;
    try {
      state = await resumeProductionCodeMode({ env, executionId: row.agent_execution_id,
        authorityScopeHash: row.authority_scope_hash, action: "resume" });
    } catch (error) {
      await requeueBeforeProviderOrAttention(env, row, input.attempt, retryDelay(input.attempt));
      console.error("operia_think_codemode_agent_resume_degraded", { code: boundedCode(error) });
      return;
    }
    if (state.kind === "codemode_pending") {
      await requeueBeforeProviderOrAttention(env, row, input.attempt,
        Math.max(1, Math.ceil(state.retryAfterMs / 1_000)));
      return;
    }
    if (state.kind === "codemode_terminal") {
      await terminalizeOuterContinuation(env, row, { from: ["pending_agent"], to: state.status,
        errorCode: state.error, incrementAttempts: true });
      return;
    }
    try {
      assertAgentResult(row, state);
    } catch (error) {
      await terminalizeOuterContinuation(env, row, { to: "attention_required", errorCode: boundedCode(error) });
      return;
    }
    await updateThinkCodeModeContinuation({ db: env.DB, ref: row.codemode_ref, from: ["pending_agent"],
      to: "result_ready", receiptHash: state.receiptHash, incrementAttempts: true });
  }

  const current = await readThinkCodeModeContinuation(env.DB, row.codemode_ref);
  if (!current || isTerminal(current.status)) return;
  if (current.status === "result_ready") {
    if (!current.result_receipt_hash) {
      await terminalizeOuterContinuation(env, current, { to: "attention_required",
        errorCode: "think_codemode_receipt_missing" });
      return;
    }
    const submissionId = await thinkCodeModeSubmissionId(current.request_id, current.agent_execution_id, current.result_receipt_hash);
    const claimed = await updateThinkCodeModeContinuation({ db: env.DB, ref: current.codemode_ref, from: ["result_ready"],
      to: "continuing", submissionId, incrementAttempts: true });
    if (!claimed) {
      await requeueBeforeProviderOrAttention(env, current, input.attempt, 1);
      return;
    }
    let result: ProductionCodeModeCompleted | Awaited<ReturnType<typeof resumeProductionCodeMode>>;
    try {
      result = await resumeProductionCodeMode({ env, executionId: current.agent_execution_id,
        authorityScopeHash: current.authority_scope_hash, action: "status" });
    } catch (error) {
      await requeueFinalizationOrAttention(env, current, input.attempt, retryDelay(input.attempt));
      console.error("operia_think_codemode_agent_status_degraded", { code: boundedCode(error) });
      return;
    }
    if (result.kind !== "codemode_completed") {
      await terminalizeOuterContinuation(env, current, { to: "attention_required",
        errorCode: `think_codemode_receipt_${result.status}` });
      return;
    }
    try {
      assertAgentResult(current, result);
    } catch (error) {
      await terminalizeOuterContinuation(env, current, { to: "attention_required", errorCode: boundedCode(error) });
      return;
    }
    if (result.receiptHash !== current.result_receipt_hash) {
      await terminalizeOuterContinuation(env, current, { to: "attention_required",
        errorCode: "think_codemode_receipt_hash_drift" });
      return;
    }
    let think: OperiaThinkCodeModeRpc;
    try {
      think = await thinkRpc(env, current);
      await think.submitCodeModeContinuation({ requestId: current.request_id, executionId: current.agent_execution_id,
        receiptHash: result.receiptHash, result, submissionId });
    } catch (error) {
      await requeueFinalizationOrAttention(env, current, input.attempt, retryDelay(input.attempt));
      console.error("operia_think_codemode_submit_degraded", { code: boundedCode(error) });
      return;
    }
    await requeueFinalizationOrAttention(env, current, input.attempt, 1);
    return;
  }
  if ((current.status !== "continuing" && current.status !== "finalizing") || !current.think_submission_id) {
    await terminalizeOuterContinuation(env, current, { to: "attention_required",
      errorCode: "think_codemode_state_invalid" });
    return;
  }

  let think: OperiaThinkCodeModeRpc;
  try {
    think = await thinkRpc(env, current);
  } catch (error) {
    await requeueFinalizationOrAttention(env, current, input.attempt, retryDelay(input.attempt));
    console.error("operia_think_codemode_rpc_degraded", { code: boundedCode(error) });
    return;
  }
  let inspection: OperiaCodeModeContinuationInspection;
  try {
    inspection = await think.inspectCodeModeContinuation({ requestId: current.request_id, submissionId: current.think_submission_id });
  } catch (error) {
    const code = boundedCode(error);
    if (code === "operia_think_codemode_submission_mismatch") {
      await terminalizeOuterContinuation(env, current, { to: "attention_required", errorCode: code });
      return;
    }
    if (code.includes("submission_missing")) {
      try {
        await recoverMissingSubmission(env, current, think);
      } catch (recoveryError) {
        // The Agent status read and Think resubmission both cross service/DO
        // boundaries. A single transport failure must not discard an already
        // durable Agent receipt; retry under the finalization budget instead.
        await requeueFinalizationOrAttention(env, current, input.attempt, retryDelay(input.attempt));
        console.error("operia_think_codemode_recovery_degraded", { code: boundedCode(recoveryError) });
        return;
      }
      await requeueFinalizationOrAttention(env, current, input.attempt, 1);
      return;
    }
    await requeueFinalizationOrAttention(env, current, input.attempt, retryDelay(input.attempt));
    console.error("operia_think_codemode_inspect_degraded", { code });
    return;
  }
  if (inspection.status === "pending" || inspection.status === "running") {
    await requeueFinalizationOrAttention(env, current, input.attempt, retryDelay(input.attempt));
    return;
  }
  if (inspection.status !== "completed" || !inspection.text.trim()) {
    await terminalizeOuterContinuation(env, current, { to: "attention_required",
      errorCode: `think_submission_${inspection.status}:${boundedCode(inspection.error ?? "empty_final")}` });
    return;
  }

  if (current.status === "continuing") {
    const finalizing = await updateThinkCodeModeContinuation({ db: env.DB, ref: current.codemode_ref,
      from: ["continuing"], to: "finalizing" });
    if (!finalizing) return;
  }
  try {
    const response = await persistContinuationFinal(env, current, inspection);
    await enqueueThinkContinuationFinalWake({
      env,authority:current.hrs_execution_id ? "hrs" : "accepted",
      requestIdentity:current.request_id,tgBatchKey:current.tg_batch_key,
      hrsExecutionId:current.hrs_execution_id,responseJson:JSON.stringify(response),
    });
  } catch (error) {
    await enqueueKnownFinalProjectionRepair(env, current, input.attempt, retryDelay(input.attempt));
    console.error("operia_think_codemode_final_persistence_degraded", { code: boundedCode(error) });
    return;
  }
  const completed = await terminalizeOuterContinuation(env, current, { from: ["finalizing"], to: "completed" });
  if (!completed) return;
  await think.completeCodeModeContinuation({ requestId: current.request_id, submissionId: current.think_submission_id })
    .catch((error) => console.error("operia_think_codemode_cleanup_degraded", { code: boundedCode(error) }));
}

async function recoverMissingSubmission(env: Env, row: ThinkCodeModeContinuationRow, think: OperiaThinkCodeModeRpc): Promise<void> {
  if (!row.result_receipt_hash || !row.think_submission_id) throw new Error("think_codemode_recovery_identity_missing");
  const result = await resumeProductionCodeMode({ env, executionId: row.agent_execution_id,
    authorityScopeHash: row.authority_scope_hash, action: "status" });
  if (result.kind !== "codemode_completed" || result.receiptHash !== row.result_receipt_hash) {
    throw new Error("think_codemode_recovery_receipt_drift");
  }
  await think.submitCodeModeContinuation({ requestId: row.request_id, executionId: row.agent_execution_id,
    receiptHash: result.receiptHash, result, submissionId: row.think_submission_id });
}

async function thinkRpc(env: Env, row: ThinkCodeModeContinuationRow): Promise<OperiaThinkCodeModeRpc> {
  if (!env.OPERIA_THINK) throw new Error("think_codemode_namespace_missing");
  const think = env.OPERIA_THINK.get(env.OPERIA_THINK.idFromName(row.think_instance_id)) as unknown as OperiaThinkCodeModeRpc;
  await think.setName(row.think_instance_id);
  return think;
}

function assertAgentResult(row: ThinkCodeModeContinuationRow, result: ProductionCodeModeCompleted): void {
  if (result.executionId !== row.agent_execution_id || result.requestId !== row.agent_request_id
    || !/^[a-f0-9]{64}$/.test(result.receiptHash)) throw new Error("think_codemode_agent_receipt_invalid");
  if (new TextEncoder().encode(JSON.stringify(result.result)).byteLength > 64 * 1024) throw new Error("think_codemode_result_too_large");
}

async function persistContinuationFinal(env: Env, row: ThinkCodeModeContinuationRow, inspection: OperiaCodeModeContinuationInspection): Promise<OpenAIChatResponse> {
  const filteredContent = applyRegexRules(inspection.text, CONTENT_RULES);
  const usage: TokenUsage = { prompt_tokens: inspection.usage.inputTokens, completion_tokens: inspection.usage.outputTokens,
    total_tokens: inspection.usage.totalTokens, input_tokens: inspection.usage.inputTokens, output_tokens: inspection.usage.outputTokens,
    cache_read_input_tokens: inspection.usage.cachedInputTokens, cache_creation_input_tokens: inspection.usage.cacheWriteTokens };
  const response: OpenAIChatResponse = {
    id: `chatcmpl_think_${(await sha256Hex(`codemode-final\0${row.request_id}`)).slice(0,32)}`,
    object: "chat.completion", created: stableCreatedSeconds(row.created_at), model: row.upstream_model,
    choices: [{ index: 0, message: { role: "assistant", content: filteredContent }, finish_reason: "stop" }], usage,
    operia_think: { route: "think-0.15-codemode-continuation", model_calls: 1, tool_calls: 0, direct_calls: 0,
      codemode_calls: 0, skill_calls: 0, tool_keys: [], tool_errors: [], pending_approvals: [],
      result_capsules:inspection.resultCapsules,
      runtime_model: row.upstream_model, public_alias: row.request_model, external_writes: 0, codemode_continuation: true },
  };
  let savedAssistantId: string | null = null;
  if (row.conversation_id) {
    const saved = await saveAssistantMessage(env.DB, { conversationId: row.conversation_id, namespace: row.namespace,
      source: row.source, content: filteredContent, requestModel: row.request_model, upstreamModel: row.upstream_model,
      provider: classifyProvider(row.upstream_model), stream: false, finishReason: "stop", usage,
      cacheMode: "think-0.15-codemode-continuation-usage-v2",
      cacheTtl: getAnthropicCacheTtlMode(env), idempotencyKey: row.archive_idempotency_key,
      publicationStateV2Enabled: env.MEMORY_PUBLICATION_STATE_V2_ENABLED === "true" });
    savedAssistantId = saved.id;
  }
  const responseJson = JSON.stringify(response);
  await completeThinkContinuationReplay({
    env,hrsExecutionId:row.hrs_execution_id,requestIdentity:row.request_id,responseJson,
    requestHash:row.inference_request_hash,source:row.inference_source,
    terminalStatus:"codemode_continuation_completed",
  });
  await projectCodeModeFinalToTg(env, row, response);
  await Promise.all([
    saveUsageLog(env.DB, { messageId: savedAssistantId, namespace: row.namespace, provider: classifyProvider(row.upstream_model),
      model: row.upstream_model, usage, cacheMode: "think-0.15-codemode-continuation-usage-v2",
      cacheTtl: getAnthropicCacheTtlMode(env),
      requestKind: "assistant_message:think_codemode_continuation", correlationId: row.tg_batch_key }),
    (row.source !== "telegram" || env.MEMORY_PUBLICATION_STATE_V2_ENABLED !== "true")
      && row.conversation_id && savedAssistantId ? enqueueMemoryMaintenanceIfNeeded(env,
      { namespace: row.namespace, conversationId: row.conversation_id, toMessageId: savedAssistantId, source: row.source }) : Promise.resolve(),
    row.source !== "telegram" || env.MEMORY_PUBLICATION_STATE_V2_ENABLED !== "true"
      ? enqueueRetentionIfNeeded(env, row.namespace) : Promise.resolve(),
  ]).catch((error) => console.error("operia_think_codemode_observation_degraded", { code: boundedCode(error) }));
  await finishThinkCodeModeObservation(env, row, inspection).catch((error) => {
    console.error("operia_think_codemode_finish_observation_degraded", { code: boundedCode(error) });
  });
  return response;
}

async function projectCodeModeFinalToTg(
  env: Env,
  row: ThinkCodeModeContinuationRow,
  response: OpenAIChatResponse,
): Promise<void> {
  if (!row.tg_batch_key) return;
  const tg = await env.DB.prepare("SELECT reply_to_message_id FROM tg_chat_inference_runs WHERE batch_key=?")
    .bind(row.tg_batch_key).first<{reply_to_message_id:number|null}>();
  await storeTgDeferredThinkFinalPackage(env.DB, row.tg_batch_key,
    { response, mediaIntents: [], toolTraces: [], replyToMessageId: tg?.reply_to_message_id ?? null,
      resultCapsules:inspectionResultCapsules(response) },
    "think_codemode_continuation", {
      idempotencyKey: row.request_id,
      requestHash: row.inference_request_hash,
      source: row.inference_source,
    });
}

function inspectionResultCapsules(response: OpenAIChatResponse) {
  const think = response.operia_think;
  const capsules = think && typeof think === "object" && !Array.isArray(think)
    ? (think as Record<string,unknown>).result_capsules : null;
  return Array.isArray(capsules) ? capsules : [];
}

async function repairPersistedCodeModeFinal(
  env: Env,
  row: ThinkCodeModeContinuationRow,
  attempt: number,
): Promise<boolean> {
  const encoded = await readCompletedInferenceReplay(env.DB, row.request_id, {
    requestHash: row.inference_request_hash,
    source: row.inference_source,
  });
  if (!encoded) return false;
  let response: OpenAIChatResponse;
  try { response = JSON.parse(encoded) as OpenAIChatResponse; }
  catch { throw new Error("think_codemode_persisted_replay_invalid"); }
  const think = response.operia_think;
  if (!think || typeof think !== "object" || Array.isArray(think)
    || (think as Record<string, unknown>).codemode_continuation !== true) {
    throw new Error("think_codemode_persisted_replay_kind_mismatch");
  }
  try {
    await projectCodeModeFinalToTg(env, row, response);
    await enqueueThinkContinuationFinalWake({
      env,authority:row.hrs_execution_id ? "hrs" : "accepted",
      requestIdentity:row.request_id,tgBatchKey:row.tg_batch_key,
      hrsExecutionId:row.hrs_execution_id,responseJson:encoded,
    });
  } catch (error) {
    await enqueueKnownFinalProjectionRepair(env, row, attempt, retryDelay(attempt));
    console.error("operia_think_codemode_replay_projection_degraded", { code: boundedCode(error) });
    return true;
  }
  await completeCodeModeProjectionRepair(env, row);
  return true;
}

async function handleCodeModeReplayProbeFailure(
  env: Env,
  row: ThinkCodeModeContinuationRow,
  attempt: number,
  error: unknown,
): Promise<void> {
  const code = boundedCode(error);
  const deterministic = code === "inference_replay_identity_mismatch"
    || code === "think_codemode_persisted_replay_invalid"
    || code === "think_codemode_persisted_replay_kind_mismatch";
  if (!deterministic && attempt + 1 < THINK_CODEMODE_FINALIZATION_ATTEMPT_LIMIT) {
    await enqueueThinkCodeModeContinuation(env, row.codemode_ref, attempt + 1, retryDelay(attempt));
    console.error("operia_think_codemode_replay_probe_degraded", { code });
    return;
  }
  await failClosedCodeModeReplay(env, row, deterministic
    ? `think_codemode_replay_${code}`
    : "think_codemode_replay_probe_budget_exhausted");
}

async function failClosedCodeModeReplay(
  env: Env,
  row: ThinkCodeModeContinuationRow,
  code: string,
): Promise<void> {
  await updateThinkCodeModeContinuation({ db: env.DB, ref: row.codemode_ref,
    from: ["continuing","finalizing"], to: "attention_required", errorCode: boundedCode(code) });
  if (row.tg_batch_key) {
    await requireTgInferenceAttention(env.DB, row.tg_batch_key, "think_codemode_replay", boundedCode(code));
  }
  await completeProductionThinkTask({ env, thinkTaskId: row.request_id,
    authorityScopeHash: row.authority_scope_hash })
    .catch((cleanupError) => console.error("operia_think_codemode_task_grant_cleanup_degraded",
      { code: boundedCode(cleanupError) }));
  console.error("operia_think_codemode_replay_fail_closed", { code: boundedCode(code) });
}

async function completeCodeModeProjectionRepair(env: Env, row: ThinkCodeModeContinuationRow): Promise<void> {
  await updateThinkCodeModeContinuation({ db: env.DB, ref: row.codemode_ref,
    from: ["continuing","finalizing"], to: "completed" });
  await completeProductionThinkTask({ env, thinkTaskId: row.request_id,
    authorityScopeHash: row.authority_scope_hash })
    .catch((error) => console.error("operia_think_codemode_task_grant_cleanup_degraded", { code: boundedCode(error) }));
}

type OuterTerminalStatus = "completed" | "failed" | "quarantined" | "attention_required";

async function terminalizeOuterContinuation(
  env: Env,
  row: ThinkCodeModeContinuationRow,
  input: {
    from?: readonly ThinkCodeModeContinuationRow["status"][];
    to: OuterTerminalStatus;
    errorCode?: string | null;
    incrementAttempts?: boolean;
  },
): Promise<boolean> {
  const changed = await updateThinkCodeModeContinuation({ db: env.DB, ref: row.codemode_ref,
    from: input.from ?? ["pending_agent","result_ready","continuing","finalizing"], to: input.to,
    errorCode: input.errorCode == null ? null : boundedCode(input.errorCode), incrementAttempts: input.incrementAttempts });
  const terminal = await readThinkCodeModeContinuation(env.DB, row.codemode_ref);
  if (terminal && terminal.status !== "completed" && isTerminal(terminal.status)) {
    await ensureThinkCodeModeTerminalProjection(env, terminal);
  }
  if (changed) {
    await completeProductionThinkTask({ env, thinkTaskId: row.request_id,
      authorityScopeHash: row.authority_scope_hash })
      .catch((error) => console.error("operia_think_codemode_task_grant_cleanup_degraded", { code: boundedCode(error) }));
  }
  return changed;
}

export async function ensureThinkCodeModeTerminalProjection(
  env: Env,
  row: ThinkCodeModeContinuationRow,
): Promise<void> {
  if (row.status === "completed" || !isTerminal(row.status)) return;
  const response = await terminalResponse(row);
  const responseJson = JSON.stringify(response);
  await completeThinkContinuationReplay({
    env,hrsExecutionId:row.hrs_execution_id,requestIdentity:row.request_id,responseJson,
    requestHash:row.inference_request_hash,source:row.inference_source,
    terminalStatus:"codemode_continuation_terminal",
  });
  if (row.tg_batch_key) {
    const tg = await env.DB.prepare("SELECT reply_to_message_id FROM tg_chat_inference_runs WHERE batch_key=?")
      .bind(row.tg_batch_key).first<{reply_to_message_id:number|null}>();
    await storeTgDeferredThinkFinalPackage(env.DB, row.tg_batch_key, {
      response,
      mediaIntents: [],
      toolTraces: [],
      replyToMessageId: tg?.reply_to_message_id ?? null,
    }, "think_codemode_continuation", {
      idempotencyKey: row.request_id,
      requestHash: row.inference_request_hash,
      source: row.inference_source,
    });
  }
  await finishThinkCodeModeTerminalObservation(env, row).catch((error) => {
    console.error("operia_think_codemode_terminal_observation_degraded", { code: boundedCode(error) });
  });
  await enqueueThinkContinuationFinalWake({
    env,authority:row.hrs_execution_id ? "hrs" : "accepted",
    requestIdentity:row.request_id,tgBatchKey:row.tg_batch_key,
    hrsExecutionId:row.hrs_execution_id,responseJson,
  });
}

async function terminalResponse(row: ThinkCodeModeContinuationRow): Promise<OpenAIChatResponse> {
  const content = row.status === "stopped"
    ? "任务已按你的要求停止，不会自动续跑。"
    : row.status === "quarantined"
      ? "这次工具结果已被安全隔离，没有交付，也不会自动重试。"
      : row.status === "attention_required"
        ? "这次工具任务的结果无法安全确认，系统已停止自动重试，以避免重复调用或重复费用。"
        : "这次沙盒工具计划没有完成，未产生外部写入；系统不会自动重试。";
  const createdAt = Date.parse(row.created_at);
  return {
    id: `chatcmpl_think_${(await sha256Hex(`codemode-terminal\0${row.request_id}\0${row.status}\0${row.last_error_code ?? ""}`)).slice(0,32)}`,
    object: "chat.completion",
    created: Number.isFinite(createdAt) ? Math.floor(createdAt / 1_000) : 0,
    model: row.upstream_model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    operia_think: {
      route: "think-0.15-codemode-terminal",
      model_calls: 0,
      tool_calls: 0,
      direct_calls: 0,
      codemode_calls: 0,
      skill_calls: 0,
      tool_keys: [],
      tool_errors: row.last_error_code ? [boundedCode(row.last_error_code)] : [],
      pending_approvals: [],
      runtime_model: row.upstream_model,
      public_alias: row.request_model,
      external_writes: 0,
      codemode_terminal: true,
      codemode_terminal_status: row.status,
      codemode_ref: row.codemode_ref,
    },
  };
}

async function finishThinkCodeModeTerminalObservation(env: Env, row: ThinkCodeModeContinuationRow): Promise<void> {
  const completedAt = row.completed_at ?? row.updated_at;
  const startedAt = Date.parse(row.created_at);
  const endedAt = Date.parse(completedAt);
  const latencyMs = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : null;
  await env.DB.prepare(`UPDATE think_canary_runs SET status='failed',natural_task=0,qualifying_tool_task=0,
    qualification_reason='codemode_terminal',latency_ms=COALESCE(latency_ms,?),error_code=?,telemetry_status='completed',
    completed_at=COALESCE(completed_at,?) WHERE request_id=? AND status='started'`)
    .bind(latencyMs, boundedCode(row.last_error_code ?? `codemode_${row.status}`), completedAt, row.request_id).run();
}

async function finishThinkCodeModeObservation(
  env: Env,
  row: ThinkCodeModeContinuationRow,
  inspection: OperiaCodeModeContinuationInspection,
): Promise<void> {
  const completedAt = new Date().toISOString();
  const startedAt = Date.parse(row.created_at);
  const latencyMs = Number.isFinite(startedAt) ? Math.max(0, Date.parse(completedAt) - startedAt) : null;
  await env.DB.prepare(`UPDATE think_canary_runs SET status='completed',model_calls=model_calls+1,
    natural_task=1,qualifying_tool_task=1,qualification_reason='completed_natural_tool_task',
    input_tokens=input_tokens+?,output_tokens=output_tokens+?,cached_input_tokens=cached_input_tokens+?,
    cache_write_input_tokens=cache_write_input_tokens+?,latency_ms=?,error_code=NULL,telemetry_status='completed',completed_at=?
    WHERE request_id=? AND status='started'`).bind(
      inspection.usage.inputTokens,
      inspection.usage.outputTokens,
      inspection.usage.cachedInputTokens,
      inspection.usage.cacheWriteTokens,
      latencyMs,
      completedAt,
      row.request_id,
    ).run();
}

async function requeueBeforeProviderOrAttention(
  env: Env,
  row: ThinkCodeModeContinuationRow,
  attempt: number,
  delaySeconds: number,
): Promise<void> {
  await requeueWithinBudget(env, row, attempt, delaySeconds, THINK_CODEMODE_PROVIDER_ATTEMPT_LIMIT,
    "think_codemode_attempt_budget_exhausted");
}

async function requeueFinalizationOrAttention(
  env: Env,
  row: ThinkCodeModeContinuationRow,
  attempt: number,
  delaySeconds: number,
): Promise<void> {
  await requeueWithinBudget(env, row, attempt, delaySeconds, THINK_CODEMODE_FINALIZATION_ATTEMPT_LIMIT,
    "think_codemode_finalization_budget_exhausted");
}

async function enqueueKnownFinalProjectionRepair(
  env: Env,
  row: ThinkCodeModeContinuationRow,
  attempt: number,
  delaySeconds: number,
): Promise<void> {
  if (attempt + 1 < THINK_CODEMODE_FINALIZATION_ATTEMPT_LIMIT) {
    await enqueueThinkCodeModeContinuation(env, row.codemode_ref, attempt + 1, delaySeconds);
    return;
  }
  let encoded: string | null;
  try {
    encoded = await readCompletedInferenceReplay(env.DB, row.request_id, {
      requestHash: row.inference_request_hash,
      source: row.inference_source,
    });
  } catch (error) {
    await absorbCodeModeProjectionCapFailure(env, row,
      `think_codemode_projection_cap_read_${boundedCode(error)}`);
    return;
  }
  let handedOff = !row.tg_batch_key && Boolean(encoded);
  if (encoded && row.tg_batch_key) {
    try {
      handedOff = await handoffTgKnownFinalProjection(env.DB, row.tg_batch_key,
        "think_codemode_projection_repair", {
          idempotencyKey: row.request_id,
          requestHash: row.inference_request_hash,
          source: row.inference_source,
        });
    } catch (error) {
      await absorbCodeModeProjectionCapFailure(env, row,
        `think_codemode_projection_cap_handoff_${boundedCode(error)}`);
      return;
    }
  }
  if (handedOff) {
    if (row.status === "continuing" || row.status === "finalizing") {
      try {
        await completeCodeModeProjectionRepair(env, row);
      } catch (error) {
        console.error("operia_think_codemode_projection_completion_degraded", { code: boundedCode(error) });
        await updateThinkCodeModeContinuation({ db: env.DB, ref: row.codemode_ref,
          from: ["continuing","finalizing"], to: "attention_required",
          errorCode: "think_codemode_projection_completion_degraded" })
          .catch((attentionError) => console.error("operia_think_codemode_projection_completion_attention_degraded",
            { code: boundedCode(attentionError) }));
        await completeProductionThinkTask({ env, thinkTaskId: row.request_id,
          authorityScopeHash: row.authority_scope_hash })
          .catch((cleanupError) => console.error("operia_think_codemode_task_grant_cleanup_degraded",
            { code: boundedCode(cleanupError) }));
      }
    }
    console.error("operia_think_codemode_projection_handed_to_tg_recovery", { codemode_ref: row.codemode_ref });
    return;
  }
  await absorbCodeModeProjectionCapFailure(env, row, "think_codemode_projection_cap_unavailable");
}

async function absorbCodeModeProjectionCapFailure(
  env: Env,
  row: ThinkCodeModeContinuationRow,
  code: string,
): Promise<void> {
  try {
    await failClosedCodeModeReplay(env, row, boundedCode(code));
  } catch (error) {
    console.error("operia_think_codemode_projection_cap_attention_degraded", {
      code: boundedCode(code),
      persistence_code: boundedCode(error),
    });
    await completeProductionThinkTask({ env, thinkTaskId: row.request_id,
      authorityScopeHash: row.authority_scope_hash })
      .catch((cleanupError) => console.error("operia_think_codemode_task_grant_cleanup_degraded",
        { code: boundedCode(cleanupError) }));
  }
}

async function requeueWithinBudget(
  env: Env,
  row: ThinkCodeModeContinuationRow,
  attempt: number,
  delaySeconds: number,
  attemptLimit: number,
  exhaustedCode: string,
): Promise<void> {
  if (attempt + 1 >= attemptLimit) {
    await terminalizeOuterContinuation(env, row, { to: "attention_required", errorCode: exhaustedCode });
    return;
  }
  await enqueueThinkCodeModeContinuation(env, row.codemode_ref, attempt + 1, delaySeconds);
}

function isTerminal(status: string): boolean {
  return ["completed","stopped","failed","quarantined","attention_required"].includes(status);
}

function stableCreatedSeconds(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}

function retryDelay(attempt: number): number { return Math.min(15, Math.max(1, 1 + Math.floor(attempt / 3))); }
function boundedCode(value: unknown): string {
  return String(value instanceof Error ? value.message : value).replace(/[^a-zA-Z0-9:_-]/g,"_").slice(0,180) || "unknown";
}
