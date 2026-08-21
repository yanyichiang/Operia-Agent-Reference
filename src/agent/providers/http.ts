import { ProviderError, type ProviderFetch, type ProviderId } from "./types";

const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;

export type ProviderHttpConfig = {
  provider: ProviderId;
  fetch: ProviderFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
};

export function requireEnabled(provider: ProviderId, enabled: boolean, credential?: string): string {
  if (!enabled) throw new ProviderError(provider, "disabled");
  const normalized = credential?.trim();
  if (!normalized) throw new ProviderError(provider, "not_configured");
  return normalized;
}

export async function fetchJson(config: ProviderHttpConfig, input: RequestInfo | URL, init: RequestInit): Promise<unknown> {
  const { text, status } = await fetchText(config, input, init, ["application/json"]);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError(config.provider, "invalid_response_json", status);
  }
}

export async function fetchText(
  config: ProviderHttpConfig,
  input: RequestInfo | URL,
  init: RequestInit,
  allowedContentTypes: readonly string[],
): Promise<{ text: string; status: number; contentType: string }> {
  return withTimeout(config, async (signal) => {
    const response = await fetchResponse(config, input, { ...init, signal });
    const contentType = requireContentType(config.provider, response, allowedContentTypes);
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readBodyBounded(config, response));
      return { text, status: response.status, contentType };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(config.provider, "invalid_response_encoding", response.status);
    }
  });
}

export async function fetchBytes(
  config: ProviderHttpConfig,
  input: RequestInfo | URL,
  init: RequestInit,
  allowedContentTypes: readonly string[],
): Promise<{ bytes: Uint8Array; contentType: string }> {
  return withTimeout(config, async (signal) => {
    const response = await fetchResponse(config, input, { ...init, signal });
    const contentType = requireContentType(config.provider, response, allowedContentTypes);
    return { bytes: await readBodyBounded(config, response), contentType };
  });
}

async function fetchResponse(config: ProviderHttpConfig, input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  try {
    const response = await config.fetch(input, init);
    if (!response.ok) {
      const diagnostics = await upstreamDiagnostics(response);
      throw new ProviderError(config.provider, "upstream_error", response.status, diagnostics);
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (init.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw new ProviderError(config.provider, "timeout");
    throw new ProviderError(config.provider, "network_error");
  }
}

async function upstreamDiagnostics(response: Response): Promise<{ upstreamCode?: string; requestId?: string }> {
  const requestId = response.headers.get("cf-aig-request-id") ?? response.headers.get("x-request-id") ?? undefined;
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json" || !response.body) return { upstreamCode: statusDiagnostic(response.status), requestId };

  let text = "";
  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ERROR_RESPONSE_BYTES) {
        await reader.cancel();
        return { upstreamCode: statusDiagnostic(response.status), requestId };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { upstreamCode: statusDiagnostic(response.status), requestId };
  }

  try {
    const root = JSON.parse(text) as unknown;
    return { upstreamCode: diagnosticFromPayload(root, response.status), requestId };
  } catch {
    return { upstreamCode: statusDiagnostic(response.status), requestId };
  }
}

function diagnosticFromPayload(value: unknown, status: number): string {
  const root = errorRecord(value);
  const nested = errorRecord(root.error);
  const firstError = Array.isArray(root.errors) ? errorRecord(root.errors[0]) : {};
  for (const candidate of [nested.code, nested.type, root.code, root.type, firstError.code, firstError.type, typeof root.error === "string" ? root.error : undefined]) {
    if (typeof candidate !== "string" && typeof candidate !== "number") continue;
    const safe = String(candidate).trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
    if (safe && safe.length <= 80 && /^(?:invalid|permission|forbidden|authentication|authorization|unauthorized|rate|billing|payment|credit|balance|insufficient|model|endpoint|not_found|server|service|upstream|timeout|temporarily|quota|content_policy|moderation)[a-z0-9_.-]*$/.test(safe)) return safe;
  }
  const message = [nested.message, root.message, firstError.message].find((candidate) => typeof candidate === "string");
  if (typeof message === "string") {
    const normalized = message.toLowerCase();
    if (/credit|balance|billing|payment|spend limit/.test(normalized)) return "billing_unavailable";
    if (/permission|forbidden|not allowed|blocked|access/.test(normalized)) return "permission_denied";
    if (/api key|authorization|authentication|token/.test(normalized)) return "invalid_credentials";
    if (/model.+not found|unknown model|model.+unavailable/.test(normalized)) return "model_unavailable";
    if (/rate limit|too many requests/.test(normalized)) return "rate_limited";
  }
  return statusDiagnostic(status);
}

function statusDiagnostic(status: number): string {
  if (status === 401) return "invalid_credentials";
  if (status === 402) return "billing_unavailable";
  if (status === 403) return "permission_denied";
  if (status === 404) return "model_or_endpoint_not_found";
  if (status === 408 || status === 504) return "upstream_timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_unavailable";
  return `http_${status}`;
}

function errorRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function withTimeout<T>(config: ProviderHttpConfig, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (config.signal?.aborted) controller.abort();
  else config.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), boundedInteger(config.timeoutMs, 10_000, 1, MAX_TIMEOUT_MS));
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderError(config.provider, "timeout");
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(config.provider, "network_error");
  } finally {
    clearTimeout(timer);
    config.signal?.removeEventListener("abort", abort);
  }
}

async function readBodyBounded(config: ProviderHttpConfig, response: Response): Promise<Uint8Array> {
  const limit = boundedInteger(config.maxResponseBytes, 1024 * 1024, 1, MAX_RESPONSE_BYTES);
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const declaredLength = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > limit) {
      throw new ProviderError(config.provider, "response_too_large", response.status);
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ProviderError(config.provider, "response_too_large", response.status);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(config.provider, "response_read_failed", response.status);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function requireContentType(provider: ProviderId, response: Response, allowed: readonly string[]): string {
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!contentType || !allowed.some((item) => contentType === item || (item.endsWith("/") && contentType.startsWith(item)))) {
    throw new ProviderError(provider, "unexpected_content_type", response.status);
  }
  return contentType;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
