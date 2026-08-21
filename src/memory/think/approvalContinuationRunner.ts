import { saveAssistantMessage } from "../../db/messages";
import { saveUsageLog } from "../../db/usageLogs";
import { readCompletedInferenceReplay } from "../inferenceIdempotency";
import { completeThinkContinuationReplay, enqueueThinkContinuationFinalWake } from "../../runtime/hrsThinkContinuationFinal";
import { enqueueMemoryMaintenanceIfNeeded, enqueueRetentionIfNeeded } from "../../queue/producer";
import { classifyProvider } from "../../proxy/resolveModel";
import { getAnthropicCacheTtlMode } from "../../proxy/anthropicAdapter";
import { applyRegexRules } from "../../preset/regexPipeline";
import { CONTENT_RULES } from "../../preset/regexRules";
import { handoffTgKnownFinalProjection, requireTgInferenceAttention, storeTgDeferredThinkFinalPackage } from "../../tg/inferenceRun";
import type { Env, OpenAIChatResponse, TokenUsage } from "../../types";
import {
  enqueueThinkApprovalContinuation,
  approvalRetryDisposition,
  MAX_THINK_APPROVAL_CONTINUATION_ATTEMPTS,
  MAX_THINK_APPROVAL_FINALIZATION_ATTEMPTS,
  expireThinkApprovalContinuation,
  readThinkApprovalContinuationByRef,
  readThinkApprovalContinuationGroup,
  retryApprovalContinuationAtBoundary,
  sha256Hex,
  thinkApprovalSubmissionId,
  updateThinkApprovalContinuationState,
  type ThinkApprovalContinuationRow,
} from "./approvalContinuation";
import type {
  OperiaApprovalContinuationInspection,
  OperiaApprovalContinuationOutcome,
} from "./OperiaThinkHarness";
import { completeProductionThinkTask, readProductionApprovalReceipt, type ProductionApprovalReceipt } from "./productionAgentGatewayClient";

type OperiaThinkApprovalRpc = {
  setName(name: string): Promise<void>;
  submitApprovalContinuation(input: {
    requestId: string;
    outcomes: OperiaApprovalContinuationOutcome[];
  }): Promise<{ submissionId: string; accepted: boolean; status: string }>;
  inspectApprovalContinuation(input: {
    requestId: string;
    submissionId: string;
  }): Promise<OperiaApprovalContinuationInspection>;
  completeApprovalContinuation(input: { requestId: string; submissionId: string }): Promise<void>;
};

const MAX_PROVIDER_START_ATTEMPTS = MAX_THINK_APPROVAL_CONTINUATION_ATTEMPTS;
const MAX_FINALIZATION_ATTEMPTS = MAX_THINK_APPROVAL_FINALIZATION_ATTEMPTS;

export async function resumeThinkApprovalContinuation(
  env: Env,
  input: { approvalRef: string; attempt: number },
  ctx?: ExecutionContext,
): Promise<void> {
  const row = await readThinkApprovalContinuationByRef(env.DB, input.approvalRef);
  if (!row) return;
  if (row.status === "completed") {
    await releaseOuterThinkTask(env, row);
    return;
  }
  if (isTerminal(row.status)) {
    try {
      await ensureThinkApprovalTerminalProjection(env, row);
    } catch (error) {
      await enqueueKnownFinalProjectionRepair(env, row, input.attempt, retryDelay(input.attempt));
      console.error("operia_think_approval_terminal_projection_degraded", { code: boundedCode(error) });
    }
    await releaseOuterThinkTask(env, row);
    return;
  }
  if (row.status === "continuing") {
    try {
      if (await repairPersistedApprovalFinal(env, row, input.attempt)) return;
    } catch (error) {
      await handleApprovalReplayProbeFailure(env, row, input.attempt, error);
      return;
    }
  }
  if (input.attempt > MAX_FINALIZATION_ATTEMPTS) {
    await terminalizeGroup(env, row, "think_approval_attempt_budget_exhausted");
    return;
  }

  if (row.status === "pending_approval") {
    const remainingMs = Date.parse(row.expires_at) - Date.now();
    if (remainingMs > 0) {
      await enqueueThinkApprovalContinuation(env, row.approval_ref, input.attempt, Math.max(1, Math.ceil(remainingMs / 1_000)));
      return;
    }
    const expired = await expireThinkApprovalContinuation(env.DB, row.approval_ref);
    if (!expired) return;
    row.status = expired.status;
    row.decision_scope = expired.decision_scope;
  }

  if (row.status === "decision_reserved") {
    let receipt: ProductionApprovalReceipt;
    try {
      receipt = await readProductionApprovalReceipt({
        env,
        taskId: row.agent_task_id,
        thinkTaskId: row.think_task_id,
        ticketId: row.agent_ticket_id,
        approvalRef: row.approval_ref,
        toolKey: row.tool_key,
        authorityScopeHash: row.authority_scope_hash,
        agentCallKey: row.agent_call_key,
        argsHash: row.args_hash,
        schemaHash: row.schema_hash,
        policyVersion: row.policy_version,
        pauseGeneration: row.pause_generation,
      });
    } catch (error) {
      await retryContinuation(env, row, input.attempt, retryDelay(input.attempt), MAX_PROVIDER_START_ATTEMPTS);
      console.error("operia_think_approval_receipt_degraded", { code: boundedCode(error) });
      return;
    }
    if (receipt.status === "pending") {
      await retryContinuation(env, row, input.attempt, retryDelay(input.attempt), MAX_PROVIDER_START_ATTEMPTS);
      return;
    }
    if (["cancelled", "expired", "quarantined", "attention_required"].includes(receipt.status)) {
      await updateThinkApprovalContinuationState({
        db: env.DB,
        approvalRef: row.approval_ref,
        from: ["decision_reserved"],
        to: receipt.status === "quarantined" || receipt.status === "attention_required" ? "quarantined" : "attention_required",
        errorCode: `agent_receipt_${receipt.status}`,
        incrementAttempts: true,
      });
      await terminalizeGroup(env, row, `agent_receipt_${receipt.status}`);
      return;
    }
    if ((receipt.status !== "completed" && receipt.status !== "rejected") || !receipt.receiptHash) {
      await terminalizeGroup(env, row, `agent_receipt_unexpected_${boundedCode(receipt.status)}`);
      return;
    }
    await updateThinkApprovalContinuationState({
      db: env.DB,
      approvalRef: row.approval_ref,
      from: ["decision_reserved"],
      to: receipt.status === "rejected" ? "rejected" : "result_ready",
      receiptHash: receipt.receiptHash,
      incrementAttempts: true,
    });
  }

  const group = await readThinkApprovalContinuationGroup(env.DB, row.request_id);
  if (group.length === 0) return;
  if (group.some((item) => item.status === "pending_approval" || item.status === "decision_reserved")) {
    await retryContinuation(env, row, input.attempt, retryDelay(input.attempt), MAX_PROVIDER_START_ATTEMPTS);
    return;
  }
  if (group.some((item) => item.status === "quarantined" || item.status === "attention_required")) {
    await terminalizeGroup(env, group[0], "think_approval_group_terminal");
    return;
  }

  const submissionId = await thinkApprovalSubmissionId(row.request_id);
  const leader = group[0];
  if (group.every((item) => item.status === "result_ready" || item.status === "rejected")) {
    if (approvalRetryDisposition(input.attempt, MAX_PROVIDER_START_ATTEMPTS).kind === "terminalize") {
      await terminalizeGroup(env, leader, "think_approval_attempt_budget_exhausted_before_provider");
      return;
    }
    const claimed = await claimContinuationGroup(env.DB, group, leader.approval_ref, submissionId);
    if (!claimed) {
      const observed = await readThinkApprovalContinuationGroup(env.DB, row.request_id);
      if (observed.some((item) => item.status === "quarantined" || item.status === "attention_required")) {
        await releaseOuterThinkTask(env, leader);
        return;
      }
      await retryContinuation(env, leader, input.attempt, 1, MAX_PROVIDER_START_ATTEMPTS);
      return;
    }
    let outcomes: OperiaApprovalContinuationOutcome[];
    try {
      outcomes = await readCanonicalAgentOutcomes(env, group);
    } catch (error) {
      if (isDeterministicApprovalOutcomeError(error)) {
        await terminalizeGroup(env, leader, `think_approval_outcome_${boundedCode(error)}`);
        return;
      }
      await retryContinuation(env, leader, input.attempt, retryDelay(input.attempt), MAX_FINALIZATION_ATTEMPTS);
      console.error("operia_think_approval_outcome_read_degraded", { code: boundedCode(error) });
      return;
    }
    let think: OperiaThinkApprovalRpc;
    try {
      think = await thinkApprovalRpc(env, leader);
      await think.submitApprovalContinuation({ requestId: leader.request_id, outcomes });
    } catch (error) {
      await retryContinuation(env, leader, input.attempt, retryDelay(input.attempt), MAX_FINALIZATION_ATTEMPTS);
      console.error("operia_think_approval_submit_degraded", { code: boundedCode(error) });
      return;
    }
    await retryContinuation(env, leader, input.attempt, 1, MAX_FINALIZATION_ATTEMPTS);
    return;
  }

  if (!group.every((item) => item.status === "continuing" || item.status === "completed")) {
    await terminalizeGroup(env, leader, "think_approval_group_state_invalid");
    return;
  }
  if (group.every((item) => item.status === "completed")) return;

  let think: OperiaThinkApprovalRpc;
  try {
    think = await thinkApprovalRpc(env, leader);
  } catch (error) {
    await retryContinuation(env, leader, input.attempt, retryDelay(input.attempt), MAX_FINALIZATION_ATTEMPTS);
    console.error("operia_think_approval_rpc_degraded", { code: boundedCode(error) });
    return;
  }
  let inspection: OperiaApprovalContinuationInspection;
  try {
    inspection = await think.inspectApprovalContinuation({ requestId: leader.request_id, submissionId });
  } catch (error) {
    const code = boundedCode(error);
    if (code === "operia_think_approval_submission_mismatch") {
      await terminalizeGroup(env, leader, code);
      return;
    }
    // A crash between the D1 CAS and durable submission acceptance is safe:
    // submitMessages is keyed by the stable request id and can be retried.
    if (code.includes("submission_missing")) {
      if (approvalRetryDisposition(input.attempt, MAX_FINALIZATION_ATTEMPTS).kind === "terminalize") {
        await terminalizeGroup(env, leader, "think_approval_finalization_budget_exhausted");
        return;
      }
      try {
        const outcomes = await readCanonicalAgentOutcomes(env, group);
        await think.submitApprovalContinuation({ requestId: leader.request_id, outcomes });
      } catch (recoveryError) {
        await retryContinuation(env, leader, input.attempt, retryDelay(input.attempt), MAX_FINALIZATION_ATTEMPTS);
        console.error("operia_think_approval_recovery_degraded", { code: boundedCode(recoveryError) });
        return;
      }
      await retryContinuation(env, leader, input.attempt, 1, MAX_FINALIZATION_ATTEMPTS);
      return;
    }
    await retryContinuation(env, leader, input.attempt, retryDelay(input.attempt), MAX_FINALIZATION_ATTEMPTS);
    console.error("operia_think_approval_inspect_degraded", { code });
    return;
  }
  if (inspection.status === "pending" || inspection.status === "running") {
    await retryContinuation(env, leader, input.attempt, retryDelay(input.attempt), MAX_FINALIZATION_ATTEMPTS);
    return;
  }
  if (inspection.status !== "completed" || !inspection.text.trim()) {
    await terminalizeGroup(
      env,
      leader,
      `think_submission_${inspection.status}:${boundedCode(inspection.error ?? "empty_final")}`,
    );
    return;
  }

  let response: OpenAIChatResponse;
  try {
    response = await persistContinuationFinal(env, leader, inspection);
    await enqueueThinkContinuationFinalWake({
      env,authority:leader.hrs_execution_id ? "hrs" : "accepted",
      requestIdentity:leader.request_id,tgBatchKey:leader.tg_batch_key,
      hrsExecutionId:leader.hrs_execution_id,responseJson:JSON.stringify(response),
    });
  } catch (error) {
    await enqueueKnownFinalProjectionRepair(env, leader, input.attempt, retryDelay(input.attempt));
    console.error("operia_think_approval_final_persistence_degraded", { code: boundedCode(error) });
    return;
  }
  await markGroupCompleted(env.DB, row.request_id, submissionId);
  await releaseOuterThinkTask(env, leader);
  try {
    await think.completeApprovalContinuation({ requestId: leader.request_id, submissionId });
  } catch (error) {
    console.error("operia_think_approval_cleanup_degraded", { code: boundedCode(error) });
  }
  console.info("operia_think_approval_continuation_completed", {
    request_id_hash: (await sha256Hex(leader.request_id)).slice(0, 12),
    approvals: group.length,
    response_id: response.id,
  });
}

async function retryContinuation(
  env: Env,
  row: ThinkApprovalContinuationRow,
  attempt: number,
  delaySeconds: number,
  maxAttempts: number,
): Promise<void> {
  await retryApprovalContinuationAtBoundary({
    attempt,
    maxAttempts,
    enqueue: (nextAttempt) => enqueueThinkApprovalContinuation(env, row.approval_ref, nextAttempt, delaySeconds),
    terminalize: () => terminalizeGroup(env, row, "think_approval_attempt_budget_exhausted"),
  });
}

async function readCanonicalAgentOutcomes(
  env: Env,
  group: readonly ThinkApprovalContinuationRow[],
): Promise<OperiaApprovalContinuationOutcome[]> {
  const outcomes: OperiaApprovalContinuationOutcome[] = [];
  for (const row of group) {
    const receipt: ProductionApprovalReceipt = await readProductionApprovalReceipt({
      env,
      taskId: row.agent_task_id,
      thinkTaskId: row.think_task_id,
      ticketId: row.agent_ticket_id,
      approvalRef: row.approval_ref,
      toolKey: row.tool_key,
      authorityScopeHash: row.authority_scope_hash,
      agentCallKey: row.agent_call_key,
      argsHash: row.args_hash,
      schemaHash: row.schema_hash,
      policyVersion: row.policy_version,
      pauseGeneration: row.pause_generation,
    });
    if ((receipt.status !== "completed" && receipt.status !== "rejected") || !receipt.receiptHash) {
      throw new Error(`think_approval_agent_receipt_${boundedCode(receipt.status)}`);
    }
    if (row.result_receipt_hash !== receipt.receiptHash) throw new Error("think_approval_receipt_hash_drift");
    const result = receipt.result ?? { outcome: receipt.status === "rejected" ? "action_denied" : "completed" };
    const encoded = JSON.stringify(result);
    if (new TextEncoder().encode(encoded).byteLength > 64 * 1024) throw new Error("think_approval_result_too_large");
    outcomes.push({
      approvalRef: row.approval_ref,
      taskId: row.agent_task_id,
      ticketId: row.agent_ticket_id,
      toolKey: row.tool_key,
      status: receipt.status,
      receiptHash: receipt.receiptHash,
      result,
    });
  }
  return outcomes;
}

async function thinkApprovalRpc(env: Env, row: ThinkApprovalContinuationRow): Promise<OperiaThinkApprovalRpc> {
  if (!env.OPERIA_THINK) throw new Error("think_approval_namespace_missing");
  const think = env.OPERIA_THINK.get(env.OPERIA_THINK.idFromName(row.think_instance_id)) as unknown as OperiaThinkApprovalRpc;
  await think.setName(row.think_instance_id);
  return think;
}

async function claimContinuationGroup(
  db: D1Database,
  group: readonly ThinkApprovalContinuationRow[],
  leaderRef: string,
  submissionId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const leader = await db.prepare(`UPDATE think_approval_continuations SET status='continuing',think_submission_id=?,
      continuation_attempts=continuation_attempts+1,updated_at=?
    WHERE approval_ref=? AND status IN ('result_ready','rejected') RETURNING approval_ref`)
    .bind(submissionId, now, leaderRef).first<{ approval_ref: string }>();
  if (!leader) return false;
  for (const row of group.slice(1)) {
    const changed = await db.prepare(`UPDATE think_approval_continuations SET status='continuing',think_submission_id=?,
        continuation_attempts=continuation_attempts+1,updated_at=?
      WHERE approval_ref=? AND status IN ('result_ready','rejected') RETURNING approval_ref`)
      .bind(submissionId, now, row.approval_ref).first<{ approval_ref: string }>();
    if (!changed) {
      await markGroupAttention(db, row.request_id, "think_approval_group_claim_partial");
      return false;
    }
  }
  return true;
}

async function persistContinuationFinal(
  env: Env,
  row: ThinkApprovalContinuationRow,
  inspection: OperiaApprovalContinuationInspection,
): Promise<OpenAIChatResponse> {
  const filteredContent = applyRegexRules(inspection.text, CONTENT_RULES);
  const usage: TokenUsage = {
    prompt_tokens: inspection.usage.inputTokens,
    completion_tokens: inspection.usage.outputTokens,
    total_tokens: inspection.usage.totalTokens,
    input_tokens: inspection.usage.inputTokens,
    output_tokens: inspection.usage.outputTokens,
    cache_read_input_tokens: inspection.usage.cachedInputTokens,
    cache_creation_input_tokens: inspection.usage.cacheWriteTokens,
  };
  const response: OpenAIChatResponse = {
    id: `chatcmpl_think_${(await sha256Hex(`approval-final\0${row.request_id}`)).slice(0, 32)}`,
    object: "chat.completion",
    created: stableCreatedSeconds(row.created_at),
    model: row.upstream_model,
    choices: [{ index: 0, message: { role: "assistant", content: filteredContent }, finish_reason: "stop" }],
    usage,
    operia_think: {
      route: "think-0.15-approval-continuation",
      model_calls: 1,
      tool_calls: 0,
      direct_calls: 0,
      codemode_calls: 0,
      skill_calls: 0,
      tool_keys: [],
      tool_errors: [],
      pending_approvals: [],
      runtime_model: row.upstream_model,
      public_alias: row.request_model,
      external_writes: 0,
      approval_continuation: true,
    },
  };
  let savedAssistantId: string | null = null;
  if (row.conversation_id) {
    const saved = await saveAssistantMessage(env.DB, {
      conversationId: row.conversation_id,
      namespace: row.namespace,
      source: row.source,
      content: filteredContent,
      requestModel: row.request_model,
      upstreamModel: row.upstream_model,
      provider: classifyProvider(row.upstream_model),
      stream: false,
      finishReason: "stop",
      usage,
      cacheMode: "think-0.15-approval-continuation-usage-v2",
      cacheTtl: getAnthropicCacheTtlMode(env),
      idempotencyKey: row.archive_idempotency_key,
      publicationStateV2Enabled: env.MEMORY_PUBLICATION_STATE_V2_ENABLED === "true",
    });
    savedAssistantId = saved.id;
  }
  const responseJson = JSON.stringify(response);
  await completeThinkContinuationReplay({
    env,hrsExecutionId:row.hrs_execution_id,requestIdentity:row.request_id,responseJson,
    requestHash:row.inference_request_hash,source:row.inference_source,
    terminalStatus:"approval_continuation_completed",
  });
  await projectApprovalFinalToTg(env, row, response);
  await Promise.all([
    saveUsageLog(env.DB, {
      messageId: savedAssistantId,
      namespace: row.namespace,
      provider: classifyProvider(row.upstream_model),
      model: row.upstream_model,
      usage,
      cacheMode: "think-0.15-approval-continuation-usage-v2",
      cacheTtl: getAnthropicCacheTtlMode(env),
      requestKind: "assistant_message:think_approval_continuation",
      correlationId: row.tg_batch_key,
    }),
    (row.source !== "telegram" || env.MEMORY_PUBLICATION_STATE_V2_ENABLED !== "true")
      && row.conversation_id && savedAssistantId
      ? enqueueMemoryMaintenanceIfNeeded(env, {
        namespace: row.namespace,
        conversationId: row.conversation_id,
        toMessageId: savedAssistantId,
        source: row.source,
      })
      : Promise.resolve(),
    row.source !== "telegram" || env.MEMORY_PUBLICATION_STATE_V2_ENABLED !== "true"
      ? enqueueRetentionIfNeeded(env, row.namespace) : Promise.resolve(),
  ]).catch((error) => console.error("operia_think_approval_observation_degraded", { code: boundedCode(error) }));
  return response;
}

async function projectApprovalFinalToTg(
  env: Env,
  row: ThinkApprovalContinuationRow,
  response: OpenAIChatResponse,
): Promise<void> {
  if (!row.tg_batch_key) return;
  const tg = await env.DB.prepare("SELECT reply_to_message_id FROM tg_chat_inference_runs WHERE batch_key=?")
    .bind(row.tg_batch_key).first<{ reply_to_message_id: number | null }>();
  await storeTgDeferredThinkFinalPackage(env.DB, row.tg_batch_key, {
    response,
    mediaIntents: [],
    toolTraces: [],
    replyToMessageId: tg?.reply_to_message_id ?? null,
  }, "think_approval_continuation", {
    idempotencyKey: row.request_id,
    requestHash: row.inference_request_hash,
    source: row.inference_source,
  });
}

async function repairPersistedApprovalFinal(
  env: Env,
  row: ThinkApprovalContinuationRow,
  attempt: number,
): Promise<boolean> {
  const encoded = await readCompletedInferenceReplay(env.DB, row.request_id, {
    requestHash: row.inference_request_hash,
    source: row.inference_source,
  });
  if (!encoded) return false;
  let response: OpenAIChatResponse;
  try { response = JSON.parse(encoded) as OpenAIChatResponse; }
  catch { throw new Error("think_approval_persisted_replay_invalid"); }
  const think = response.operia_think;
  if (!think || typeof think !== "object" || Array.isArray(think)
    || (think as Record<string, unknown>).approval_continuation !== true) {
    throw new Error("think_approval_persisted_replay_kind_mismatch");
  }
  try {
    await projectApprovalFinalToTg(env, row, response);
    await enqueueThinkContinuationFinalWake({
      env,authority:row.hrs_execution_id ? "hrs" : "accepted",
      requestIdentity:row.request_id,tgBatchKey:row.tg_batch_key,
      hrsExecutionId:row.hrs_execution_id,responseJson:encoded,
    });
  } catch (error) {
    await enqueueKnownFinalProjectionRepair(env, row, attempt, retryDelay(attempt));
    console.error("operia_think_approval_replay_projection_degraded", { code: boundedCode(error) });
    return true;
  }
  await completeApprovalProjectionRepair(env, row);
  return true;
}

async function handleApprovalReplayProbeFailure(
  env: Env,
  row: ThinkApprovalContinuationRow,
  attempt: number,
  error: unknown,
): Promise<void> {
  const code = boundedCode(error);
  const deterministic = code === "inference_replay_identity_mismatch"
    || code === "think_approval_persisted_replay_invalid"
    || code === "think_approval_persisted_replay_kind_mismatch";
  if (!deterministic && attempt + 1 < MAX_FINALIZATION_ATTEMPTS) {
    await enqueueThinkApprovalContinuation(env, row.approval_ref, attempt + 1, retryDelay(attempt));
    console.error("operia_think_approval_replay_probe_degraded", { code });
    return;
  }
  await failClosedApprovalReplay(env, row, deterministic
    ? `think_approval_replay_${code}`
    : "think_approval_replay_probe_budget_exhausted");
}

async function failClosedApprovalReplay(
  env: Env,
  row: ThinkApprovalContinuationRow,
  code: string,
): Promise<void> {
  await markGroupAttention(env.DB, row.request_id, boundedCode(code));
  if (row.tg_batch_key) {
    await requireTgInferenceAttention(env.DB, row.tg_batch_key, "think_approval_replay", boundedCode(code));
  }
  await releaseOuterThinkTask(env, row);
  console.error("operia_think_approval_replay_fail_closed", { code: boundedCode(code) });
}

async function completeApprovalProjectionRepair(env: Env, row: ThinkApprovalContinuationRow): Promise<void> {
  if (!row.think_submission_id) throw new Error("think_approval_projection_submission_missing");
  await markGroupCompleted(env.DB, row.request_id, row.think_submission_id);
  await releaseOuterThinkTask(env, row);
}

async function markGroupCompleted(db: D1Database, requestId: string, submissionId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE think_approval_continuations SET status='completed',last_error_code=NULL,updated_at=?,completed_at=?
    WHERE request_id=? AND think_submission_id=? AND status='continuing'`)
    .bind(now, now, requestId, submissionId).run();
}

async function markGroupAttention(db: D1Database, requestId: string, code: string): Promise<void> {
  await db.prepare(`UPDATE think_approval_continuations SET status='attention_required',last_error_code=?,updated_at=?
    WHERE request_id=? AND status NOT IN ('completed','quarantined','attention_required')`)
    .bind(boundedCode(code), new Date().toISOString(), requestId).run();
}

async function terminalizeGroup(env: Env, row: ThinkApprovalContinuationRow, code: string): Promise<void> {
  await markGroupAttention(env.DB, row.request_id, code);
  const terminal = await readThinkApprovalContinuationByRef(env.DB, row.approval_ref) ?? row;
  await ensureThinkApprovalTerminalProjection(env, terminal);
  await releaseOuterThinkTask(env, row);
}

export async function ensureThinkApprovalTerminalProjection(
  env: Env,
  row: ThinkApprovalContinuationRow,
): Promise<void> {
  if (!isTerminal(row.status)) return;
  const response = await approvalTerminalResponse(row);
  const responseJson = JSON.stringify(response);
  await completeThinkContinuationReplay({
    env,hrsExecutionId:row.hrs_execution_id,requestIdentity:row.request_id,responseJson,
    requestHash:row.inference_request_hash,source:row.inference_source,
    terminalStatus:"approval_continuation_terminal",
  });
  if (row.tg_batch_key) {
    const tg = await env.DB.prepare("SELECT reply_to_message_id FROM tg_chat_inference_runs WHERE batch_key=?")
      .bind(row.tg_batch_key).first<{ reply_to_message_id: number | null }>();
    await storeTgDeferredThinkFinalPackage(env.DB, row.tg_batch_key, {
      response,
      mediaIntents: [],
      toolTraces: [],
      replyToMessageId: tg?.reply_to_message_id ?? null,
    }, "think_approval_continuation", {
      idempotencyKey: row.request_id,
      requestHash: row.inference_request_hash,
      source: row.inference_source,
    });
    await enqueueThinkContinuationFinalWake({
      env,authority:row.hrs_execution_id ? "hrs" : "accepted",
      requestIdentity:row.request_id,tgBatchKey:row.tg_batch_key,
      hrsExecutionId:row.hrs_execution_id,responseJson,
    });
  }
  await finishThinkApprovalTerminalObservation(env, row).catch((error) => {
    console.error("operia_think_approval_terminal_observation_degraded", { code: boundedCode(error) });
  });
}

async function approvalTerminalResponse(row: ThinkApprovalContinuationRow): Promise<OpenAIChatResponse> {
  return {
    id: `chatcmpl_think_${(await sha256Hex(`approval-terminal\0${row.request_id}`)).slice(0, 32)}`,
    object: "chat.completion",
    created: stableCreatedSeconds(row.created_at),
    model: row.upstream_model,
    choices: [{ index: 0, message: { role: "assistant",
      content: "系统提示：工具调用失败，未返回结果；系统没有自动续跑或重试。" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    operia_think: {
      route: "think-0.15-approval-terminal",
      model_calls: 0,
      tool_calls: 0,
      direct_calls: 0,
      codemode_calls: 0,
      skill_calls: 0,
      tool_keys: [],
      tool_errors: [],
      pending_approvals: [],
      runtime_model: row.upstream_model,
      public_alias: row.request_model,
      external_writes: 0,
      approval_terminal: true,
      channel_notice: "tool_call_failed",
    },
  };
}

async function finishThinkApprovalTerminalObservation(env: Env, row: ThinkApprovalContinuationRow): Promise<void> {
  const completedAt = row.completed_at ?? row.updated_at;
  const startedAt = Date.parse(row.created_at);
  const endedAt = Date.parse(completedAt);
  const latencyMs = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : null;
  await env.DB.prepare(`UPDATE think_canary_runs SET status='failed',natural_task=0,qualifying_tool_task=0,
    qualification_reason='approval_terminal',latency_ms=COALESCE(latency_ms,?),error_code=?,telemetry_status='completed',
    completed_at=COALESCE(completed_at,?) WHERE request_id=? AND status='started'`)
    .bind(latencyMs, boundedCode(row.last_error_code ?? `approval_${row.status}`), completedAt, row.request_id).run();
}

async function enqueueKnownFinalProjectionRepair(
  env: Env,
  row: ThinkApprovalContinuationRow,
  attempt: number,
  delaySeconds: number,
): Promise<void> {
  if (attempt + 1 < MAX_FINALIZATION_ATTEMPTS) {
    await enqueueThinkApprovalContinuation(env, row.approval_ref, attempt + 1, delaySeconds);
    return;
  }
  let encoded: string | null;
  try {
    encoded = await readCompletedInferenceReplay(env.DB, row.request_id, {
      requestHash: row.inference_request_hash,
      source: row.inference_source,
    });
  } catch (error) {
    await absorbApprovalProjectionCapFailure(env, row,
      `think_approval_projection_cap_read_${boundedCode(error)}`);
    return;
  }
  let handedOff = !row.tg_batch_key && Boolean(encoded);
  if (encoded && row.tg_batch_key) {
    try {
      handedOff = await handoffTgKnownFinalProjection(env.DB, row.tg_batch_key,
        "think_approval_projection_repair", {
          idempotencyKey: row.request_id,
          requestHash: row.inference_request_hash,
          source: row.inference_source,
        });
    } catch (error) {
      await absorbApprovalProjectionCapFailure(env, row,
        `think_approval_projection_cap_handoff_${boundedCode(error)}`);
      return;
    }
  }
  if (handedOff) {
    if (row.status === "continuing" && row.think_submission_id) {
      try {
        await completeApprovalProjectionRepair(env, row);
      } catch (error) {
        console.error("operia_think_approval_projection_completion_degraded", { code: boundedCode(error) });
        await markGroupAttention(env.DB, row.request_id, "think_approval_projection_completion_degraded")
          .catch((attentionError) => console.error("operia_think_approval_projection_completion_attention_degraded",
            { code: boundedCode(attentionError) }));
        await releaseOuterThinkTask(env, row);
      }
    }
    console.error("operia_think_approval_projection_handed_to_tg_recovery", { approval_ref: row.approval_ref });
    return;
  }
  await absorbApprovalProjectionCapFailure(env, row, "think_approval_projection_cap_unavailable");
}

async function absorbApprovalProjectionCapFailure(
  env: Env,
  row: ThinkApprovalContinuationRow,
  code: string,
): Promise<void> {
  try {
    await failClosedApprovalReplay(env, row, boundedCode(code));
  } catch (error) {
    console.error("operia_think_approval_projection_cap_attention_degraded", {
      code: boundedCode(code),
      persistence_code: boundedCode(error),
    });
    await releaseOuterThinkTask(env, row);
  }
}

async function releaseOuterThinkTask(env: Env, row: ThinkApprovalContinuationRow): Promise<void> {
  await completeProductionThinkTask({
    env,
    thinkTaskId: row.think_task_id,
    authorityScopeHash: row.authority_scope_hash,
  }).catch((error) => console.error("operia_think_task_grant_cleanup_degraded", { code: boundedCode(error) }));
}

function retryDelay(attempt: number): number {
  return Math.min(15, Math.max(1, 1 + Math.floor(attempt / 3)));
}

function isTerminal(status: string): boolean {
  return status === "stopped" || status === "quarantined" || status === "attention_required";
}

function isDeterministicApprovalOutcomeError(error: unknown): boolean {
  const code = boundedCode(error);
  return code.startsWith("think_approval_agent_receipt_")
    || code === "think_approval_receipt_hash_drift"
    || code === "think_approval_result_too_large";
}

function stableCreatedSeconds(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}

function boundedCode(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 180) || "unknown";
}
