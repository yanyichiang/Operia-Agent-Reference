import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import {
  buildAnthropicHeaders,
  getAnthropicNativeUrl,
  stripAnthropicModelPrefix,
} from "../../proxy/anthropicAdapter";

export type OperiaMemoryLanguageModelEnv = {
  AI_GATEWAY_BASE_URL?: string;
  CF_AIG_TOKEN?: string;
};

/**
 * Build Think's model through the same Memory-owned Anthropic gateway policy
 * as the legacy inference path. The Agent worker never receives provider
 * credentials and the AI SDK's placeholder x-api-key is stripped before the
 * request leaves Memory; Cloudflare AI Gateway owns upstream authentication.
 */
export function createOperiaMemoryLanguageModel(
  env: OperiaMemoryLanguageModelEnv,
  targetModel: string,
  fetchImpl: typeof fetch = fetch,
): LanguageModel {
  const baseURL = getAnthropicNativeUrl(env).replace(/\/messages$/i, "");
  const policyHeaders = buildAnthropicHeaders(env, targetModel);

  const gatewayFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("x-api-key");
    for (const [name, value] of policyHeaders) headers.set(name, value);
    return fetchImpl(input, { ...init, headers });
  };

  return createAnthropic({
    baseURL,
    // Required by the provider factory but removed by gatewayFetch. The real
    // credential remains the Memory-owned cf-aig-authorization header.
    apiKey: "operia-gateway-managed",
    name: "<MEMORY_SERVICE>.anthropic",
    fetch: gatewayFetch,
  })(stripAnthropicModelPrefix(targetModel));
}
