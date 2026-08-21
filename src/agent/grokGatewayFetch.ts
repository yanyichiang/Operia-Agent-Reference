import type { AgentEnv } from "./types";
import type { ProviderFetch } from "./providers/types";

const XAI_ORIGIN = "https://api.x.ai";
const INTERNAL_ORIGIN = "https://<MEMORY_SERVICE>.internal";
const SERVICE_PREFIX = "/service/agent/grok";
const ALLOWED_PATHS = new Set([
  "/v1/responses",
  "/v1/images/generations",
  "/v1/images/edits",
]);

type GatewayBrokerEnv = Pick<AgentEnv, "MEMORY_MCP" | "MEMORY_GATEWAY_BROKER_BEARER">;

export function createGrokGatewayFetch(env: GatewayBrokerEnv, fallback: ProviderFetch = fetch): ProviderFetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== XAI_ORIGIN) return fallback(input, init);
    if (!ALLOWED_PATHS.has(url.pathname) || url.search || url.hash) throw new Error("xai_gateway_path_forbidden");

    const bearer = env.MEMORY_GATEWAY_BROKER_BEARER?.trim();
    if (!bearer) throw new Error("xai_gateway_broker_not_configured");
    const headers = new Headers();
    const authorization = request.headers.get("authorization");
    const contentType = request.headers.get("content-type");
    if (authorization) headers.set("authorization", authorization);
    if (contentType) headers.set("content-type", contentType);
    headers.set("x-operia-service-authorization", `Bearer ${bearer}`);
    headers.set("x-operia-source-domain", "agent.example.com");
    headers.set("x-operia-service-id", "agent-grok-gateway-broker");

    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    return env.MEMORY_MCP.fetch(`${INTERNAL_ORIGIN}${SERVICE_PREFIX}${url.pathname}`, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
    });
  };
}
