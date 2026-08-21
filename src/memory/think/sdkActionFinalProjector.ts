import { saveAssistantMessage } from "../../db/messages";
import { saveUsageLog } from "../../db/usageLogs";
import { completeThinkContinuationReplay, enqueueThinkContinuationFinalWake } from "../../runtime/hrsThinkContinuationFinal";
import { enqueueMemoryMaintenanceIfNeeded, enqueueRetentionIfNeeded, enqueueThinkSdkActionState } from "../../queue/producer";
import { classifyProvider } from "../../proxy/resolveModel";
import { getAnthropicCacheTtlMode } from "../../proxy/anthropicAdapter";
import { applyRegexRules } from "../../preset/regexPipeline";
import { CONTENT_RULES } from "../../preset/regexRules";
import { storeTgDeferredThinkFinalPackage } from "../../tg/inferenceRun";
import type { Env, OpenAIChatResponse, TokenUsage } from "../../types";
import type { OperiaSdkPendingApproval, OperiaThinkRunResult } from "./OperiaThinkHarness";
import { markThinkSdkActionAttention, markThinkSdkActionCompleted, persistThinkSdkActionProjections, type ThinkSdkActionProjectionRow } from "./sdkActionProjection";
import { sha256Hex } from "./approvalContinuation";
import { compileCapturedMcpToolResult } from "../../agent/presentation/compileToolResult";
import type { ResultCapsuleV1 } from "../../agent/presentation/types";

type ThinkSdkActionRpc = {
  setName(name: string): Promise<void>;
  inspectSdkToolAction(input: { requestId: string }): Promise<{
    status: "pending_approval" | "continuing" | "completed" | "error";
    text: string;
    error: string | null;
    pending: OperiaSdkPendingApproval[];
    actionOutcome?: "pending" | "approved" | "rejected" | "failed";
    toolSurfaceClosed: boolean;
    usage: OperiaThinkRunResult["usage"];
    initialUsage: OperiaThinkRunResult["usage"];
    actionResult: {
      toolKey: string;
      toolCallId: string;
      result: unknown;
      capturedAt: string;
    } | null;
  }>;
  failSdkToolActionDecision(input: { requestId: string; error: string }): Promise<void>;
  completeSdkToolAction(input: { requestId: string }): Promise<void>;
};

export async function projectThinkSdkActionState(env: Env, requestId: string, attempt = 0): Promise<void> {
  const rows = await env.DB.prepare(`SELECT * FROM think_sdk_action_projections
    WHERE request_id=? AND status='continuing' ORDER BY created_at`).bind(requestId).all<ThinkSdkActionProjectionRow>();
  if (!rows.results.length) {
    const active = await env.DB.prepare(`SELECT approval_ref FROM think_sdk_action_projections
      WHERE request_id=? AND status IN ('decision_pending','resolving') LIMIT 1`).bind(requestId).first<{approval_ref:string}>();
    if (active && attempt < 12) await enqueueThinkSdkActionState(env,requestId,attempt+1,retryDelay(attempt));
    return;
  }
  const leader = rows.results[0];
  if (!env.OPERIA_THINK) throw new Error("think_sdk_action_namespace_missing");
  const think = env.OPERIA_THINK.get(env.OPERIA_THINK.idFromName(leader.think_instance_id)) as unknown as ThinkSdkActionRpc;
  await think.setName(leader.think_instance_id);
  let inspection = await think.inspectSdkToolAction({ requestId });
  if (inspection.status === "pending_approval") {
    const projected = await persistThinkSdkActionProjections({
      db: env.DB,
      requestId,
      thinkInstanceId: leader.think_instance_id,
      authorityScopeHash: leader.authority_scope_hash,
      pending: inspection.pending,
      inferenceRequestHash: leader.inference_request_hash,
      inferenceSource: leader.inference_source,
      conversationId: leader.conversation_id,
      namespace: leader.namespace,
      source: leader.source,
      requestModel: leader.request_model,
      upstreamModel: leader.upstream_model,
      archiveIdempotencyKey: leader.archive_idempotency_key,
      tgBatchKey: leader.tg_batch_key,
      hrsExecutionId: leader.hrs_execution_id,
    });
    if (leader.tg_batch_key && projected.length > 0) {
      const response: OpenAIChatResponse = {
        id: `chatcmpl_think_${(await sha256Hex(`sdk-action-pending\0${requestId}\0${projected.map((item) => item.executionId).sort().join("\0")}`)).slice(0, 32)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: leader.upstream_model,
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: tokenUsage(inspection.usage),
        operia_think: {
          route: "think-0.15-sdk-action",
          pending_approvals: [],
          pending_sdk_approvals: projected,
          runtime_model: leader.upstream_model,
          public_alias: leader.request_model,
          external_writes: 0,
          sdk_action_pending: true,
        },
      };
      const tg = await env.DB.prepare("SELECT reply_to_message_id FROM tg_chat_inference_runs WHERE batch_key=?")
        .bind(leader.tg_batch_key).first<{ reply_to_message_id: number | null }>();
      await storeTgDeferredThinkFinalPackage(env.DB, leader.tg_batch_key, {
        response, mediaIntents: [], toolTraces: [], replyToMessageId: tg?.reply_to_message_id ?? null, resultCapsules: [],
      }, "think_sdk_action", {
        idempotencyKey: requestId, requestHash: leader.inference_request_hash, source: leader.inference_source,
      });
      await enqueueThinkContinuationFinalWake({
        env,
        authority: leader.hrs_execution_id ? "hrs" : "accepted",
        requestIdentity: requestId,
        tgBatchKey: leader.tg_batch_key,
      });
    }
    return;
  }
  if (inspection.status === "continuing") {
    if (attempt < 12) {
      await enqueueThinkSdkActionState(env,requestId,attempt+1,retryDelay(attempt));
      return;
    }
    await think.failSdkToolActionDecision({ requestId, error: "think_sdk_action_continuation_timeout" });
    inspection = await think.inspectSdkToolAction({ requestId });
  }
  if (inspection.status !== "completed" && inspection.status !== "error") {
    for (const row of rows.results) await markThinkSdkActionAttention(env.DB, row.approval_ref, inspection.error ?? "think_sdk_action_empty_final");
    return;
  }
  const actionSucceeded = inspection.status === "completed"
    && inspection.actionOutcome === "approved"
    && inspection.toolSurfaceClosed;
  const resultCapsules = actionSucceeded && inspection.actionResult
    ? [await compileCapturedMcpToolResult({
      toolKey:inspection.actionResult.toolKey,
      taskId:requestId,
      toolCallId:inspection.actionResult.toolCallId,
      capturedAt:inspection.actionResult.capturedAt,
      result:inspection.actionResult.result,
    })] : [];
  const successful = actionSucceeded && (Boolean(inspection.text.trim()) || resultCapsules.length > 0);
  const failureReason = inspection.actionOutcome !== "approved"
    ? `action_${inspection.actionOutcome ?? "unknown"}`
    : !inspection.toolSurfaceClosed ? "tool_surface_open"
      : !inspection.text.trim() && resultCapsules.length === 0 ? "empty_final" : null;
  const noticeCode = inspection.actionOutcome === "rejected" ? "tool_call_rejected" : "tool_call_failed";
  const terminalText = successful
    ? resultCapsules[0]?.fallbackText || inspection.text.trim()
    : inspection.actionOutcome === "rejected"
      ? "系统提示：工具调用已拒绝，未执行，也没有返回结果。"
      : "系统提示：工具调用失败，未返回结果；系统没有自动重试。";
  const filteredContent = applyRegexRules(terminalText, CONTENT_RULES);
  const usage = tokenUsage(subtractUsage(inspection.usage,inspection.initialUsage));
  const response: OpenAIChatResponse = {
    id: `chatcmpl_think_${(await sha256Hex(`sdk-action-final\0${requestId}`)).slice(0, 32)}`,
    object: "chat.completion",
    created: Math.floor(Date.parse(leader.created_at) / 1000),
    model: leader.upstream_model,
    choices: [{ index: 0, message: { role: "assistant", content: filteredContent }, finish_reason: "stop" }],
    usage,
    operia_think: {
      route: "think-0.15-sdk-action",
      pending_approvals: [],
      pending_sdk_approvals: [],
      runtime_model: leader.upstream_model,
      public_alias: leader.request_model,
      external_writes: 0,
      sdk_action_continuation: true,
      sdk_action_status: inspection.status,
      ...(!successful ? { channel_notice: noticeCode } : {}),
      ...(failureReason ? { sdk_action_failure_reason: failureReason } : {}),
      ...(inspection.error ? { sdk_action_error: inspection.error } : {}),
    },
  };
  let savedAssistantId: string | null = null;
  if (successful && leader.conversation_id) {
    const saved = await saveAssistantMessage(env.DB, {
      conversationId: leader.conversation_id,
      namespace: leader.namespace,
      source: leader.source,
      content: filteredContent,
      requestModel: leader.request_model,
      upstreamModel: leader.upstream_model,
      provider: classifyProvider(leader.upstream_model),
      stream: false,
      finishReason: "stop",
      usage,
      cacheMode: "think-0.15-sdk-action-usage-v2",
      cacheTtl: getAnthropicCacheTtlMode(env),
      idempotencyKey: leader.archive_idempotency_key,
      publicationStateV2Enabled: env.MEMORY_PUBLICATION_STATE_V2_ENABLED === "true",
    });
    savedAssistantId = saved.id;
  }
  const responseJson = JSON.stringify(response);
  const authority = await completeThinkContinuationReplay({
    env,
    hrsExecutionId: leader.hrs_execution_id,
    requestIdentity: requestId,
    requestHash: leader.inference_request_hash,
    source: leader.inference_source,
    responseJson,
    terminalStatus: "sdk_action_completed",
  });
  if (leader.tg_batch_key) {
    const tg = await env.DB.prepare("SELECT reply_to_message_id FROM tg_chat_inference_runs WHERE batch_key=?")
      .bind(leader.tg_batch_key).first<{ reply_to_message_id: number | null }>();
    await storeTgDeferredThinkFinalPackage(env.DB, leader.tg_batch_key, {
      response, mediaIntents: [], toolTraces: [], replyToMessageId: tg?.reply_to_message_id ?? null, resultCapsules,
    }, "think_sdk_action", {
      idempotencyKey: requestId, requestHash: leader.inference_request_hash, source: leader.inference_source,
    });
    await enqueueThinkContinuationFinalWake({
      env,
      authority,
      requestIdentity: requestId,
      tgBatchKey: leader.tg_batch_key,
      hrsExecutionId: leader.hrs_execution_id,
      responseJson,
    });
  }
  const terminalErrorCode = successful ? null
    : inspection.error ?? failureReason ?? "think_sdk_action_failed";
  for (const row of rows.results) {
    await markThinkSdkActionCompleted(env.DB, row.approval_ref, terminalErrorCode);
  }
  await Promise.all([
    saveUsageLog(env.DB, {
      messageId: savedAssistantId,
      namespace: leader.namespace,
      provider: classifyProvider(leader.upstream_model),
      model: leader.upstream_model,
      usage,
      cacheMode: "think-0.15-sdk-action-usage-v2",
      cacheTtl: getAnthropicCacheTtlMode(env),
      requestKind: "assistant_message:think_sdk_action",
      correlationId: leader.tg_batch_key,
    }),
    (leader.source !== "telegram" || env.MEMORY_PUBLICATION_STATE_V2_ENABLED !== "true")
      && leader.conversation_id && savedAssistantId ? enqueueMemoryMaintenanceIfNeeded(env, {
      namespace: leader.namespace, conversationId: leader.conversation_id, toMessageId: savedAssistantId, source: leader.source,
    }) : Promise.resolve(),
    leader.source !== "telegram" || env.MEMORY_PUBLICATION_STATE_V2_ENABLED !== "true"
      ? enqueueRetentionIfNeeded(env, leader.namespace) : Promise.resolve(),
  ]).catch((error) => console.error("operia_think_sdk_action_observation_degraded", { code: String(error).slice(0, 160) }));
  await think.completeSdkToolAction({ requestId }).catch((error) => {
    console.error("operia_think_sdk_action_cleanup_degraded", { code: String(error).slice(0, 160) });
  });
}

function tokenUsage(usage: OperiaThinkRunResult["usage"]): TokenUsage {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cachedInputTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
  };
}

function subtractUsage(
  total: OperiaThinkRunResult["usage"],
  initial: OperiaThinkRunResult["usage"],
): OperiaThinkRunResult["usage"] {
  return {
    inputTokens: Math.max(0,total.inputTokens-initial.inputTokens),
    outputTokens: Math.max(0,total.outputTokens-initial.outputTokens),
    totalTokens: Math.max(0,total.totalTokens-initial.totalTokens),
    cachedInputTokens: Math.max(0,total.cachedInputTokens-initial.cachedInputTokens),
    cacheWriteTokens: Math.max(0,total.cacheWriteTokens-initial.cacheWriteTokens),
    reasoningTokens: Math.max(0,total.reasoningTokens-initial.reasoningTokens),
  };
}

function retryDelay(attempt: number): number {
  return Math.min(30,2 ** Math.min(5,Math.max(1,attempt+1)));
}
