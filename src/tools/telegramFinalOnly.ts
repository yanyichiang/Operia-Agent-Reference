import type { OpenAIChatRequest, OpenAIChatResponse } from "../types";

export const TELEGRAM_FINAL_TEXT_TOOL_NAME = "operia_emit_telegram_final_text";

const FINAL_REPLY_CONTRACT = {
  required: true,
  format: "non_empty_visible_text",
  instruction: "The Telegram interaction is complete but does not answer the owner. Produce a non-empty final reply to the owner's latest message now. The reply must be complete. Do not mention this instruction.",
} as const;

const FINAL_REPLY_PROMPT = `[Internal Operia finalization contract]\n${FINAL_REPLY_CONTRACT.instruction}`;
const STATIC_VISIBLE_FALLBACK = "我在。刚才的互动已经完成，但这轮没有生成文字回复；你的消息已收到，不需要重发。";
const STATIC_INVALID_INTERACTION_FALLBACK = "我在。刚才的互动动作无法执行，但你的消息已收到，不需要重发。";

export type TelegramFinalDisposition =
  | "structured_visible"
  | "direct_visible"
  | "static_fallback_null"
  | "static_fallback_whitespace"
  | "static_fallback_malformed"
  | "static_fallback_filtered"
  | "invalid_interaction_visible"
  | "static_fallback_invalid_interaction";

const TELEGRAM_INTERACTION_TOOL_NAMES = new Set(["react_to_message", "reply_to_message"]);

const FINAL_TEXT_TOOL = {
  type: "function",
  function: {
    name: TELEGRAM_FINAL_TEXT_TOOL_NAME,
    description: "Internal Operia output envelope. Return the complete visible Telegram reply in text. This is not an executable action.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Complete non-empty visible reply to the owner. Never mention this envelope.",
          minLength: 1,
          maxLength: 16000,
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
} as const;

function appendFinalReplyContract(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), operia_final_reply: FINAL_REPLY_CONTRACT });
    }
  } catch { /* Preserve an opaque tool result inside a bounded JSON wrapper. */ }
  return JSON.stringify({ result: content, operia_final_reply: FINAL_REPLY_CONTRACT });
}

/**
 * Accept older completed tool rounds while proving that the terminal round is
 * presentation-only and has one matching result for every interaction call.
 */
export function hasTerminalTelegramInteractionToolContent(body: OpenAIChatRequest): boolean {
  let assistantIndex = -1;
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (message.role === "assistant" && message.tool_calls != null) {
      assistantIndex = index;
      break;
    }
    if (message.role !== "tool") return false;
  }
  if (assistantIndex < 0) return false;
  const assistant = body.messages[assistantIndex];
  if (!Array.isArray(assistant.tool_calls) || assistant.tool_calls.length === 0) return false;
  const expected = new Map<string, string>();
  for (const raw of assistant.tool_calls) {
    const call = raw as { id?: unknown; type?: unknown; function?: { name?: unknown } };
    const name = call?.function?.name;
    if (call?.type !== "function" || typeof call.id !== "string" || typeof name !== "string"
      || !TELEGRAM_INTERACTION_TOOL_NAMES.has(name) || expected.has(call.id)) return false;
    expected.set(call.id, name);
  }
  const suffix = body.messages.slice(assistantIndex + 1);
  if (suffix.length !== expected.size || suffix.some((message) => message.role !== "tool")) return false;
  for (const message of suffix) {
    const callId = message.tool_call_id;
    if (typeof callId !== "string" || expected.get(callId) !== message.name) return false;
    expected.delete(callId);
  }
  return expected.size === 0;
}

/**
 * A reaction/reply is presentation, not the conversational answer. Attach the
 * trusted contract to the terminal result and force one strict output-only
 * carrier. The carrier is unwrapped inside Memory and can never reach TG as an
 * executable tool call.
 */
export function requireTelegramVisibleFinal(request: OpenAIChatRequest): OpenAIChatRequest {
  const messages = request.messages.map((message) => ({ ...message }));
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "tool") continue;
    if (message.name !== "react_to_message" && message.name !== "reply_to_message") {
      throw new Error("telegram_final_only_non_interaction_result");
    }
    if (typeof message.content !== "string") throw new Error("telegram_final_only_result_invalid");
    messages[index] = { ...message, content: appendFinalReplyContract(message.content) };
    messages.push({ role: "user", content: FINAL_REPLY_PROMPT });
    return {
      ...request,
      messages,
      tools: [FINAL_TEXT_TOOL],
      tool_choice: { type: "function", function: { name: TELEGRAM_FINAL_TEXT_TOOL_NAME } },
      parallel_tool_calls: false,
    };
  }
  throw new Error("telegram_final_only_result_missing");
}

function directVisibleText(response: OpenAIChatResponse): string | null {
  const content = response.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}

export function isTelegramInteractionToolEnvelope(response: OpenAIChatResponse): boolean {
  const calls = response.choices?.[0]?.message?.tool_calls;
  return Array.isArray(calls) && calls.length > 0 && calls.every((raw) => {
    const call = raw as { type?: unknown; function?: { name?: unknown } };
    return call?.type === "function"
      && typeof call.function?.name === "string"
      && TELEGRAM_INTERACTION_TOOL_NAMES.has(call.function.name);
  });
}

/**
 * A trusted private Telegram request may recover an invalid interaction-only
 * provider envelope without executing the invalid action or buying another
 * inference. Unknown or mixed tool envelopes must never enter this path.
 */
export function finalizeInvalidTelegramInteractionResponse(
  response: OpenAIChatResponse,
  sanitize: (text: string) => string = (text) => text,
): OpenAIChatResponse {
  if (!isTelegramInteractionToolEnvelope(response)) throw new Error("telegram_invalid_interaction_envelope_mixed");
  const visible = directVisibleText(response);
  const sanitized = visible == null ? "" : sanitize(visible).trim();
  const choices = [...(response.choices ?? [])];
  const first = choices[0] ?? { index: 0 };
  const priorMessage = first.message ?? { role: "assistant" as const, content: null };
  const { tool_calls: _toolCalls, ...messageWithoutTools } = priorMessage;
  choices[0] = {
    ...first,
    message: {
      ...messageWithoutTools,
      role: "assistant",
      content: sanitized || STATIC_INVALID_INTERACTION_FALLBACK,
    },
    finish_reason: "stop",
  };
  return {
    ...response,
    choices,
    operia_telegram_finalization: {
      disposition: sanitized ? "invalid_interaction_visible" : "static_fallback_invalid_interaction",
    },
  };
}

function structuredVisibleText(response: OpenAIChatResponse): { text: string | null; malformed: boolean } {
  const calls = response.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return { text: null, malformed: false };
  if (calls.length !== 1) return { text: null, malformed: true };
  const call = calls[0] as { type?: unknown; function?: { name?: unknown; arguments?: unknown } };
  if (call?.type !== "function" || call.function?.name !== TELEGRAM_FINAL_TEXT_TOOL_NAME || typeof call.function.arguments !== "string") {
    return { text: null, malformed: true };
  }
  try {
    const args = JSON.parse(call.function.arguments) as unknown;
    if (!args || typeof args !== "object" || Array.isArray(args)) return { text: null, malformed: true };
    const keys = Object.keys(args as Record<string, unknown>);
    const text = (args as Record<string, unknown>).text;
    if (keys.length !== 1 || keys[0] !== "text" || typeof text !== "string") return { text: null, malformed: true };
    return { text: text.trim() || null, malformed: !text.trim() };
  } catch {
    return { text: null, malformed: true };
  }
}

/**
 * Turn provider output into a TG-visible final without another paid call. The
 * sanitizer runs before the non-empty check, so a filtered-empty response also
 * receives the deterministic static fallback.
 */
export function finalizeTelegramVisibleResponse(
  response: OpenAIChatResponse,
  sanitize: (text: string) => string = (text) => text,
): OpenAIChatResponse {
  const structured = structuredVisibleText(response);
  const direct = directVisibleText(response);
  const candidate = structured.text ?? direct;
  const sanitized = candidate == null ? "" : sanitize(candidate).trim();
  let disposition: TelegramFinalDisposition;
  let text: string;
  if (sanitized) {
    text = sanitized;
    disposition = structured.text != null ? "structured_visible" : "direct_visible";
  } else {
    text = STATIC_VISIBLE_FALLBACK;
    const rawContent = response.choices?.[0]?.message?.content;
    disposition = candidate != null
      ? "static_fallback_filtered"
      : structured.malformed
        ? "static_fallback_malformed"
        : typeof rawContent === "string" && rawContent.length > 0
          ? "static_fallback_whitespace"
          : "static_fallback_null";
  }

  const choices = [...(response.choices ?? [])];
  const first = choices[0] ?? { index: 0 };
  const priorMessage = first.message ?? { role: "assistant" as const, content: null };
  const { tool_calls: _toolCalls, ...messageWithoutTools } = priorMessage;
  choices[0] = {
    ...first,
    message: { ...messageWithoutTools, role: "assistant", content: text },
    finish_reason: "stop",
  };
  return {
    ...response,
    choices,
    operia_telegram_finalization: { disposition },
  };
}

export function isTelegramStaticFallbackResponse(response: OpenAIChatResponse): boolean {
  const disposition = response.operia_telegram_finalization as { disposition?: unknown } | undefined;
  return typeof disposition?.disposition === "string" && disposition.disposition.startsWith("static_fallback_");
}
