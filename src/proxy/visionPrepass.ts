import type { Env, OpenAIChatMessage, OpenAIChatRequest, OpenAIChatResponse, TokenUsage } from "../types";
import { callOpenAICompat } from "./openaiAdapter";

export const VISION_PREPASS_MAX_TOKENS = 1600;
export const VISION_PREPASS_MAX_OUTPUT_CHARS = 12_000;

const VISION_PREPASS_INSTRUCTION = [
  "你是 Operia 的低成本视觉解析器，不直接回复用户。",
  "只分析本轮图片及随图文字，按图片顺序输出有界事实：精确 OCR、主体、布局、相互关系、明显细节与不确定处。",
  "不要引用人格、历史对话或工具，不要提出后续行动，不要假装看见无法确认的内容。",
  "输出将作为 volatile vision_context 交给 Opus 形成最终回答。",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isImagePart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.type === "image_url" || value.type === "input_image";
}

function lastUserMessage(messages: OpenAIChatMessage[]): OpenAIChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index];
  }
  return null;
}

export function countImageParts(request: OpenAIChatRequest): number {
  return request.messages.reduce((total, message) => total + (
    Array.isArray(message.content) ? message.content.filter(isImagePart).length : 0
  ), 0);
}

export function buildVisionPrepassRequest(request: OpenAIChatRequest, visionModel: string): OpenAIChatRequest {
  const currentUser = lastUserMessage(request.messages);
  if (!currentUser || !Array.isArray(currentUser.content) || !currentUser.content.some(isImagePart)) {
    throw new Error("vision_prepass_image_missing");
  }
  return {
    model: visionModel,
    stream: false,
    temperature: 0,
    max_tokens: VISION_PREPASS_MAX_TOKENS,
    messages: [
      { role: "system", content: VISION_PREPASS_INSTRUCTION },
      { role: "user", content: currentUser.content },
    ],
  };
}

function visibleTextFromParts(parts: unknown[]): string {
  return parts.flatMap((part) => {
    if (!isRecord(part)) return [];
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") return [part.text];
    return [];
  }).join("\n").trim();
}

export function stripImagesForMainRequest(request: OpenAIChatRequest): OpenAIChatRequest {
  const messages = request.messages.map((message) => {
    if (!Array.isArray(message.content)) return { ...message };
    const retained = message.content.filter((part) => !isImagePart(part));
    if (retained.length > 0) return { ...message, content: retained };
    if (message.role === "user") return { ...message, content: "[用户发送了图片；视觉解析见本轮 vision_context。]" };
    return { ...message, content: visibleTextFromParts(message.content) };
  });
  return { ...request, messages };
}

/**
 * A Telegram image turn has request-local vision context only. Do not expose tools to the
 * final model for that turn: a tool call would create a durable continuation that cannot
 * safely carry the image or extracted vision facts. Text-only turns keep the ordinary tool
 * registration path.
 */
export function prepareVisionFinalRequest(request: OpenAIChatRequest): OpenAIChatRequest {
  const prepared = stripImagesForMainRequest(request);
  delete prepared.tools;
  delete prepared.tool_choice;
  return prepared;
}

function responseText(response: OpenAIChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return visibleTextFromParts(content);
  return "";
}

export interface VisionPrepassResult {
  output: string;
  usage?: TokenUsage;
  totalMs: number;
  imageCount: number;
}

export async function runVisionPrepass(
  env: Env,
  request: OpenAIChatRequest,
  visionModel: string,
): Promise<VisionPrepassResult> {
  const startedAt = Date.now();
  const body = buildVisionPrepassRequest(request, visionModel);
  let upstream: Response;
  try {
    upstream = await callOpenAICompat(env, body);
  } catch {
    throw new Error("vision_prepass_fetch_unknown");
  }
  if (!upstream.ok) {
    // Do not include the provider body: it may echo image or prompt material.
    throw new Error(`vision_prepass_status_${upstream.status}`);
  }
  let parsed: OpenAIChatResponse;
  try {
    parsed = JSON.parse(await upstream.text()) as OpenAIChatResponse;
  } catch {
    throw new Error("vision_prepass_invalid_json");
  }
  const output = responseText(parsed).slice(0, VISION_PREPASS_MAX_OUTPUT_CHARS).trim();
  if (!output) throw new Error("vision_prepass_empty_output");
  return {
    output,
    usage: parsed.usage,
    totalMs: Date.now() - startedAt,
    imageCount: countImageParts(request),
  };
}
