import type { AssembledPrompt } from "../assembler/types";
import { assembledToOpenAIChatMessages } from "../assembler/toOpenAI";
import type { Env, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import type { ExactMemoryDispatchGuard } from "../memory/vnext/recallRuntime";

function workersAiModelName(model: string): string | null {
  const normalized = model.trim();
  if (normalized.startsWith("workers-ai/")) return normalized.slice("workers-ai/".length);
  if (normalized.startsWith("worker/")) return normalized.slice("worker/".length);
  if (normalized.startsWith("@cf/")) return normalized;
  return null;
}

function readWorkersAiChatContent(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const value = result as { response?: unknown; choices?: unknown };
  if (typeof value.response === "string") return value.response;
  // Workers AI's native binding returns JSON Mode / JSON Schema responses as
  // an object in `response`, not as a pre-serialized chat string. Preserve the
  // OpenAI-compatible boundary by serializing that object into message content.
  if (value.response !== null && typeof value.response === "object") {
    return JSON.stringify(value.response);
  }
  if (Array.isArray(value.choices)) {
    const first = value.choices[0] as { message?: { content?: unknown } } | undefined;
    const content = first?.message?.content;
    if (typeof content === "string") return content;
    if (content !== null && typeof content === "object") return JSON.stringify(content);
  }
  return "";
}

function buildWorkersAiRunInput(body: OpenAIChatRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {
    messages: body.messages
  };
  if (body.temperature !== undefined) input.temperature = body.temperature;
  if (body.max_tokens !== undefined) input.max_tokens = body.max_tokens;
  const responseFormat = body.response_format;
  if (responseFormat && typeof responseFormat === "object") {
    const format = responseFormat as Record<string, unknown>;
    const jsonSchema = format.json_schema && typeof format.json_schema === "object"
      ? format.json_schema as Record<string, unknown>
      : null;
    const guidedJson = jsonSchema?.schema && typeof jsonSchema.schema === "object"
      ? jsonSchema.schema
      : jsonSchema;
    if (guidedJson) input.guided_json = guidedJson;
    else input.response_format = responseFormat;
  }
  return input;
}

function wrapWorkersAiChatResponse(model: string, result: unknown): OpenAIChatResponse {
  const content = readWorkersAiChatContent(result);
  const usage =
    result && typeof result === "object" && "usage" in result
      ? (result as { usage?: OpenAIChatResponse["usage"] }).usage
      : undefined;
  return {
    id: `workers-ai-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ],
    ...(usage ? { usage } : {})
  };
}

function stripClaudeNativeThinkingFields(req: OpenAIChatRequest): OpenAIChatRequest {
  const cleaned: OpenAIChatRequest = { ...req };
  delete cleaned.thinking;
  return cleaned;
}

export function buildOpenAICompatRequest(req: OpenAIChatRequest, targetModel: string): OpenAIChatRequest {
  const cleaned = stripClaudeNativeThinkingFields(req);
  return {
    ...cleaned,
    model: targetModel,
    stream: Boolean(cleaned.stream)
  };
}

/**
 * Build an OpenAI-compatible request from an AssembledPrompt.
 * System blocks are merged into one system message; conversation messages
 * (including image_url) are preserved as-is.
 */
export function buildOpenAIRequestFromAssembled(
  req: OpenAIChatRequest,
  targetModel: string,
  assembled: AssembledPrompt
): OpenAIChatRequest {
  const messages = assembledToOpenAIChatMessages(assembled);
  return buildOpenAICompatRequest({ ...req, messages }, targetModel);
}

export function getOpenAICompatUrl(env: Env): string {
  return `${normalizeAiGatewayBaseUrl(env)}/compat/chat/completions`;
}

export function normalizeAiGatewayBaseUrl(env: Pick<Env, "AI_GATEWAY_BASE_URL">): string {
  const base = env.AI_GATEWAY_BASE_URL;
  if (!base) {
    throw new Error("Missing AI_GATEWAY_BASE_URL");
  }

  return base
    .replace(/\/+$/, "")
    .replace(/\/compat$/i, "")
    .replace(/\/compat\/chat\/completions$/i, "")
    .replace(/\/compat\/embeddings$/i, "")
    .replace(/\/anthropic\/v1\/messages$/i, "");
}

export function buildOpenAICompatHeaders(env: Env): Headers {
  const headers = new Headers({
    "content-type": "application/json"
  });

  if (env.CF_AIG_TOKEN) {
    headers.set("cf-aig-authorization", `Bearer ${env.CF_AIG_TOKEN}`);
  }

  return headers;
}

function isCloudflareUnifiedDeepSeekModel(model: string): boolean {
  return model.trim().startsWith("deepseek/");
}

function cloudflareUnifiedChatUrl(env: Env): string {
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error("Missing CLOUDFLARE_ACCOUNT_ID");
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`;
}

function cloudflareUnifiedChatHeaders(env: Env): Headers {
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error("Missing CLOUDFLARE_API_TOKEN");
  const headers = new Headers({
    authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    "content-type": "application/json",
    "cf-aig-gateway-id": "default",
  });
  return headers;
}

export async function callOpenAICompat(
  env: Env,
  body: OpenAIChatRequest,
  memoryDispatchGuard?: ExactMemoryDispatchGuard,
  signal?: AbortSignal,
): Promise<Response> {
  const workersAiModel = workersAiModelName(body.model);
  if (workersAiModel) {
    if (!env.AI) {
      return new Response(
        JSON.stringify({ error: { message: "Missing Workers AI binding", type: "workers_ai_error" } }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
    }

    const workersInput = buildWorkersAiRunInput(body);
    await memoryDispatchGuard?.verify(workersInput,"openai_workers_ai_binding");
    try {
      if (body.stream) {
        const stream = await env.AI.run(workersAiModel as never, {
          ...workersInput,
          stream: true
        }, signal ? { signal } : undefined);
        return new Response(stream as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }

      const result = await env.AI.run(workersAiModel as never, workersInput, signal ? { signal } : undefined);
      return new Response(JSON.stringify(wrapWorkersAiChatResponse(body.model, result)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: { message, type: "workers_ai_error" } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }
  }

  if (isCloudflareUnifiedDeepSeekModel(body.model)) {
    await memoryDispatchGuard?.verify(body,"openai_cloudflare_unified_http");
    return fetch(cloudflareUnifiedChatUrl(env), {
      method: "POST",
      headers: cloudflareUnifiedChatHeaders(env),
      body: JSON.stringify(body),
      signal,
    });
  }

  await memoryDispatchGuard?.verify(body,"openai_compat_gateway_http");
  return fetch(getOpenAICompatUrl(env), {
    method: "POST",
    headers: buildOpenAICompatHeaders(env),
    body: JSON.stringify(body),
    signal,
  });
}

export async function callOpenAICompatEmbeddings(
  env: Env,
  body: { model: string; input: string | string[]; dimensions?: number },
  signal?: AbortSignal,
): Promise<Response> {
  const headers = buildOpenAICompatHeaders(env);
  if (body.model.startsWith("workers-ai/") && env.CLOUDFLARE_API_TOKEN) {
    headers.set("authorization", `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
  }

  return fetch(`${normalizeAiGatewayBaseUrl(env)}/compat/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
}
