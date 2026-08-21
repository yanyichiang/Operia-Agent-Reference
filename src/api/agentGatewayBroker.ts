import type { Env } from "../types";

const INTERNAL_HOST = "<MEMORY_SERVICE>.internal";
const SERVICE_AUTH_HEADER = "x-operia-service-authorization";
const SOURCE_DOMAIN = "agent.example.com";
const SERVICE_ID = "agent-grok-gateway-broker";
const MAX_REQUEST_BYTES = 26 * 1024 * 1024;
const ROUTES = new Map([
  ["/service/agent/grok/v1/responses", "/grok/v1/responses"],
  ["/service/agent/grok/v1/images/generations", "/grok/v1/images/generations"],
  ["/service/agent/grok/v1/images/edits", "/grok/v1/images/edits"],
]);

type BrokerEnv = Pick<Env, "AGENT_GATEWAY_BROKER_API_KEY" | "AI_GATEWAY_BASE_URL" | "CF_AIG_TOKEN">;
type GatewayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function json(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

async function constantTimeEqual(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(actualDigest);
  const right = new Uint8Array(expectedDigest);
  let mismatch = left.byteLength ^ right.byteLength;
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0 && actual.length > 0;
}

async function authorized(request: Request, expected?: string): Promise<boolean> {
  if (!expected?.trim()) return false;
  const header = request.headers.get(SERVICE_AUTH_HEADER) ?? "";
  const actual = header.startsWith("Bearer ") ? header.slice(7) : "";
  return constantTimeEqual(actual, expected.trim());
}

function gatewayTarget(baseUrl: string | undefined, suffix: string): URL | null {
  try {
    const base = new URL(baseUrl ?? "");
    if (base.protocol !== "https:" || base.hostname !== "gateway.ai.cloudflare.com" || base.search || base.hash) return null;
    if (!/^\/v1\/[a-f0-9]{32}\/[A-Za-z0-9_-]+\/?$/.test(base.pathname)) return null;
    base.pathname = `${base.pathname.replace(/\/+$/, "")}${suffix}`;
    return base;
  } catch {
    return null;
  }
}

async function readBoundedBody(request: Request): Promise<ArrayBuffer> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  return body;
}

export async function handleAgentGatewayBroker(
  request: Request,
  env: BrokerEnv,
  gatewayFetch: GatewayFetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== INTERNAL_HOST) return json("not_found", 404);
  const suffix = ROUTES.get(url.pathname);
  if (!suffix) return json("not_found", 404);
  if (request.method !== "POST") return json("method_not_allowed", 405);
  if (url.search || request.headers.get("x-operia-source-domain") !== SOURCE_DOMAIN || request.headers.get("x-operia-service-id") !== SERVICE_ID) {
    return json("unauthorized", 401);
  }
  if (!await authorized(request, env.AGENT_GATEWAY_BROKER_API_KEY)) return json("unauthorized", 401);

  const providerAuthorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(providerAuthorization)) return json("provider_authorization_missing", 401);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return json("unsupported_content_type", 415);
  const gatewayAuthorization = env.CF_AIG_TOKEN?.trim();
  const target = gatewayTarget(env.AI_GATEWAY_BASE_URL, suffix);
  if (!gatewayAuthorization || !target) return json("gateway_not_configured", 503);

  let body: ArrayBuffer;
  try {
    body = await readBoundedBody(request);
  } catch {
    return json("request_too_large", 413);
  }

  try {
    const upstream = await gatewayFetch(target, {
      method: "POST",
      headers: {
        authorization: providerAuthorization,
        "cf-aig-authorization": `Bearer ${gatewayAuthorization}`,
        "cf-aig-metadata": JSON.stringify({ operia_component: "grok" }),
        "content-type": "application/json",
      },
      body,
      signal: request.signal,
    });
    const headers = new Headers({ "cache-control": "no-store" });
    const upstreamContentType = upstream.headers.get("content-type");
    if (upstreamContentType) headers.set("content-type", upstreamContentType);
    const requestId = upstream.headers.get("cf-aig-request-id");
    if (requestId) headers.set("cf-aig-request-id", requestId);
    const providerRequestId = upstream.headers.get("x-request-id");
    if (providerRequestId) headers.set("x-request-id", providerRequestId);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch {
    return json("gateway_unreachable", 502);
  }
}
