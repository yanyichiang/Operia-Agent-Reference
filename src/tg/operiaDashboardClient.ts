import type { Env } from "../types";

export type TgCloudflareAnalyticsProjection = {
  schemaVersion: 1;
  ownerDomain: "operia.example.com";
  source: "cloudflare.ai-gateway";
  status: "live" | "empty" | "unavailable";
  range: "24h" | "7d" | "30d";
  observedAt: string;
  staleAfter: string;
  gateway: string;
  summary: {
    requests: number;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    totalTokens: number;
    erroredRequests: number;
    cacheHitPct: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
  } | null;
  series: Array<{ at: string; requests: number; costUsd: number; totalTokens: number; erroredRequests: number; cacheHitPct: number }>;
  components: Array<{ id: string; requests: number; costUsd: number; totalTokens: number; latencyP50Ms: number; latencyP95Ms: number }>;
  models: Array<{ model: string; provider: string; requests: number; costUsd: number; totalTokens: number; latencyP50Ms: number; latencyP95Ms: number }>;
  reason?: string;
};

async function readBoundedJson<T>(response: Response, maxBytes = 128 * 1024): Promise<T> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("operia_dashboard_response_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("operia_dashboard_response_too_large");
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export async function getTgCloudflareAnalytics(env: Env, range: "24h" | "7d" | "30d" = "24h"): Promise<TgCloudflareAnalyticsProjection> {
  const service = env.OPERIA_DASHBOARD_SERVICE;
  const bearer = env.OPERIA_DASHBOARD_SERVICE_BEARER?.trim();
  if (!service || !bearer) throw new Error("operia_dashboard_service_not_configured");
  const response = await service.fetch(`https://<DASHBOARD_SERVICE>.internal/service/miniapp/analytics?range=${range}`, {
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/json",
      "x-operia-source-domain": "tgbot.example.com",
      "x-operia-service-id": env.TG_AGENT_SERVICE_ID?.trim() || "telegram-agent",
    },
    signal: AbortSignal.timeout(10_000),
  });
  const projection = await readBoundedJson<TgCloudflareAnalyticsProjection & { error?: string }>(response);
  if (!response.ok) throw new Error(projection.error || `operia_dashboard_http_${response.status}`);
  if (projection.schemaVersion !== 1 || projection.ownerDomain !== "operia.example.com" || projection.source !== "cloudflare.ai-gateway") {
    throw new Error("operia_dashboard_projection_invalid");
  }
  return projection;
}
