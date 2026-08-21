import { applyRegexRules } from "../preset/regexPipeline";
import { CONTENT_RULES } from "../preset/regexRules";
import type { OperiaThinkRunResult } from "../memory/think/OperiaThinkHarness";
import type { OpenAIChatResponse, TokenUsage } from "../types";
import { sha256Hex } from "../utils/hash";
import type { HrsThinkExecutionRow } from "./hrsThinkExecutionStore";

export function buildHrsHeldResponse(input: {
  executionId: string;
  submissionId: string;
  requestModel: string;
  createdAt: string;
}): OpenAIChatResponse {
  return {
    id: `chatcmpl_hrs_held_${input.executionId.slice(5)}`,
    object: "chat.completion",
    created: stableCreatedSeconds(input.createdAt),
    model: input.requestModel,
    choices: [{ index:0,message:{ role:"assistant",content:"" },finish_reason:"stop" }],
    usage: emptyTokenUsage(),
    operia_think: {
      route:"think-0.15-durable-submission",
      harness_held:true,
      execution_id:input.executionId,
      submission_id:input.submissionId,
      non_final:true,
      external_writes:0,
    },
  };
}

export async function buildHrsFinalResponse(
  row: HrsThinkExecutionRow,
  result: OperiaThinkRunResult,
): Promise<{ response: OpenAIChatResponse; filteredContent: string; usage: TokenUsage; responseHash: string }> {
  const filteredContent = applyRegexRules(result.text,CONTENT_RULES);
  if (!filteredContent.trim()) throw new Error("hrs_think_completed_without_text");
  const usage: TokenUsage = {
    prompt_tokens:result.usage.inputTokens,
    completion_tokens:result.usage.outputTokens,
    total_tokens:result.usage.totalTokens,
    input_tokens:result.usage.inputTokens,
    output_tokens:result.usage.outputTokens,
    cache_read_input_tokens:result.usage.cachedInputTokens,
    cache_creation_input_tokens:result.usage.cacheWriteTokens,
  };
  const response: OpenAIChatResponse = {
    id:`chatcmpl_think_${(await sha256Hex(`hrs-final\0${row.execution_id}\0${row.input_hash}`)).slice(0,32)}`,
    object:"chat.completion",
    created:stableCreatedSeconds(row.created_at),
    model:row.upstream_model,
    choices:[{ index:0,message:{ role:"assistant",content:filteredContent },finish_reason:finishReason(result) }],
    usage,
    operia_think:{
      route:"think-0.15-durable-final",
      execution_id:row.execution_id,
      submission_id:row.submission_id,
      execution_profile:row.execution_profile,
      model_calls:result.modelCalls,
      tool_calls:result.toolCalls,
      direct_calls:result.directCalls,
      codemode_calls:result.codeModeCalls,
      skill_calls:result.skillCalls,
      tool_keys:result.toolKeys,
      tool_errors:result.toolErrors,
      result_capsules:result.resultCapsules,
      pending_approvals:[],
      pending_sdk_approvals:[],
      runtime_model:row.upstream_model,
      public_alias:row.request_model,
      external_writes:0,
      durable_submission:true,
    },
  };
  return { response,filteredContent,usage,responseHash:await sha256Hex(JSON.stringify(response)) };
}

export async function buildHrsPendingResponse(input: {
  row: HrsThinkExecutionRow;
  result: OperiaThinkRunResult;
  projectedSdkApprovals?: unknown[];
  pendingCodeMode?: Record<string,unknown> | null;
}): Promise<OpenAIChatResponse> {
  const content = applyRegexRules(input.result.text,CONTENT_RULES);
  return {
    id:`chatcmpl_think_${(await sha256Hex(`hrs-pending\0${input.row.execution_id}\0${input.row.input_hash}`)).slice(0,32)}`,
    object:"chat.completion",
    created:stableCreatedSeconds(input.row.created_at),
    model:input.row.upstream_model,
    choices:[{ index:0,message:{ role:"assistant",content },finish_reason:"stop" }],
    usage:{
      prompt_tokens:input.result.usage.inputTokens,completion_tokens:input.result.usage.outputTokens,
      total_tokens:input.result.usage.totalTokens,input_tokens:input.result.usage.inputTokens,
      output_tokens:input.result.usage.outputTokens,cache_read_input_tokens:input.result.usage.cachedInputTokens,
      cache_creation_input_tokens:input.result.usage.cacheWriteTokens,
    },
    operia_think:{
      route:"think-0.15-durable-pending",
      harness_pending_projection:true,
      execution_id:input.row.execution_id,
      submission_id:input.row.submission_id,
      execution_profile:input.row.execution_profile,
      model_calls:input.result.modelCalls,
      tool_calls:input.result.toolCalls,
      direct_calls:input.result.directCalls,
      codemode_calls:input.result.codeModeCalls,
      skill_calls:input.result.skillCalls,
      tool_keys:input.result.toolKeys,
      tool_errors:input.result.toolErrors,
      result_capsules:input.result.resultCapsules,
      pending_approvals:input.result.pendingApprovals,
      approval_continuation_pending:input.result.pendingApprovals.length>0,
      pending_sdk_approvals:input.projectedSdkApprovals ?? input.result.pendingSdkApprovals,
      ...(input.pendingCodeMode ? { pending_codemode:input.pendingCodeMode } : {}),
      runtime_model:input.row.upstream_model,
      public_alias:input.row.request_model,
      external_writes:0,
      non_final:true,
    },
  };
}

function finishReason(result: OperiaThinkRunResult): string {
  if (result.terminalCompleteness === "partial") return "length";
  if (result.terminalCompleteness === "failed") return "error";
  if (result.terminalCompleteness === "attention") {
    const raw = result.terminalFinishReason?.raw;
    return raw === "content_filter" || raw === "content-filter" ? "content_filter" : "other";
  }
  return "stop";
}

function stableCreatedSeconds(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? Math.floor(parsed/1_000) : 0;
}

function emptyTokenUsage(): TokenUsage {
  return { prompt_tokens:0,completion_tokens:0,total_tokens:0,input_tokens:0,output_tokens:0,
    cache_read_input_tokens:0,cache_creation_input_tokens:0 };
}
