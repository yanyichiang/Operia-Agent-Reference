type ReliabilityResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: unknown; tool_calls?: unknown };
  }>;
};

import { classifyTerminalCompleteness as classifyFinishCompleteness,
  type TerminalCompleteness } from "../reliability/terminalCompleteness";
export type { TerminalCompleteness } from "../reliability/terminalCompleteness";

export type FinalResponseDisposition =
  | { kind: "visible"; text: string }
  | { kind: "canonical_tool"; text: "" }
  | { kind: "empty"; code: "empty_stop_null" | "empty_stop_whitespace" | "empty_stop_filtered_or_empty" | "empty_length" | "empty_other"; text: "" };

export function classifyTerminalCompleteness(response: ReliabilityResponse): TerminalCompleteness {
  return classifyFinishCompleteness(response.choices?.[0]?.finish_reason).completeness;
}

const CANONICAL_TOOLS = new Set([
  "request_context", "delegate_action", "browse_web", "browser_markdown", "search_web",
  "generate_image", "speak", "react_to_message", "reply_to_message",
]);

export function boundedCorrelationId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9:._-]+$/.test(normalized)) return null;
  return normalized;
}

export function correlationIdFromBatchKey(batchKey: string): string {
  return boundedCorrelationId(batchKey.split(":", 1)[0]) ?? "invalid-correlation";
}

export function classifyFinalResponse(response: ReliabilityResponse): FinalResponseDisposition {
  const choice = response.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  if (text) return { kind: "visible", text };
  const calls = choice?.message?.tool_calls;
  if (Array.isArray(calls) && calls.some((call) => {
    if (!call || typeof call !== "object") return false;
    const candidate = call as { type?: unknown; function?: { name?: unknown } };
    return candidate.type === "function" && typeof candidate.function?.name === "string" && CANONICAL_TOOLS.has(candidate.function.name);
  })) return { kind: "canonical_tool", text: "" };
  if (choice?.finish_reason === "length") return { kind: "empty", code: "empty_length", text: "" };
  if (choice?.finish_reason === "stop" && content == null) return { kind: "empty", code: "empty_stop_null", text: "" };
  if (choice?.finish_reason === "stop" && content === "") return { kind: "empty", code: "empty_stop_filtered_or_empty", text: "" };
  if (choice?.finish_reason === "stop" && typeof content === "string") return { kind: "empty", code: "empty_stop_whitespace", text: "" };
  return { kind: "empty", code: "empty_other", text: "" };
}

export function finalizeVisibleInteractionResponse(response: ReliabilityResponse, text: string): ReliabilityResponse {
  const choice = response.choices?.[0];
  return {
    ...response,
    choices: [{
      ...choice,
      finish_reason: "stop",
      message: {
        ...choice?.message,
        content: text,
        tool_calls: undefined,
      },
    }],
  };
}

export function finalizeInvalidInteractionResponse(response: ReliabilityResponse): ReliabilityResponse {
  return finalizeVisibleInteractionResponse(
    response,
    "我在。刚才的互动请求无法执行，但你的消息已收到，不需要重发。",
  );
}

export type TerminalInferenceFailure = "memory_outcome_unknown" | "memory_attention_required" | "memory_response_invalid" | "outbox_outcome_unknown" | "paragraph_delivery_attention" | "empty_final" | "image_failed" | "vision_failed" | "interaction_final_invalid";

function parseChatPipelineFailure(message: string): { status: number; type: string; detail: string | null } | null {
  const match = message.match(/^chat_pipeline_http_(\d{3}):([a-z0-9_]{1,80})(?::([a-z0-9_:-]{1,180}))?$/);
  if (!match) return null;
  return { status:Number(match[1]),type:match[2],detail:match[3] ?? null };
}

export function classifyTerminalInferenceFailure(error: unknown): TerminalInferenceFailure | null {
  const message = error instanceof Error ? error.message : String(error);
  const pipeline = parseChatPipelineFailure(message);
  if (pipeline?.status === 502 && pipeline.type === "tool_round_parse_failed") return "memory_response_invalid";
  if (pipeline?.status === 409 && pipeline.type === "idempotency_outcome_unknown") {
    if (pipeline.detail?.endsWith(":attention_required") || pipeline.detail === "attention_required") return "memory_attention_required";
    return "memory_outcome_unknown";
  }
  if (message.includes("tg_outbox_attention_required")) return "outbox_outcome_unknown";
  if (message.includes("tg_paragraph_final_attention:")) return "paragraph_delivery_attention";
  if (/(?:idempotency_outcome_unknown|inference_outcome_pending_or_unknown):(calling|responded)/.test(message)) return "memory_outcome_unknown";
  if (message.includes("idempotency_outcome_unknown") && /:attention_required(?:\b|$)/.test(message)) return "memory_attention_required";
  if (message.includes("tg_invalid_final:")) return "empty_final";
  if (message.includes("telegram_image_") || message.includes("telegram_bot_token_missing")) return "image_failed";
  if (message.includes("vision_prepass_")) return "vision_failed";
  if (message.includes("tg_continuation_round_limit") || message.includes("tg_unresolved_canonical_tool")) return "interaction_final_invalid";
  return null;
}
