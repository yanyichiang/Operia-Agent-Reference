import type { HealthMetricGroup, HealthProjection } from "../health/types";
import type { Env } from "../types";

function healthBinding(env: Env): { service: Fetcher; bearer: string } {
  const service = env.HEALTH_SERVICE;
  const bearer = env.HEALTH_SERVICE_BEARER?.trim();
  if (!service || !bearer) throw new Error("health_service_not_configured");
  return { service, bearer };
}

async function readBoundedJson<T>(response: Response, maxBytes = 100_000): Promise<T> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("health_response_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("health_response_too_large");
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function query(range: 7 | 30, group?: string): string {
  const params = new URLSearchParams({ range: String(range) });
  if (group) params.set("group", group);
  return params.toString();
}

export async function getHealthProjection(env: Env, range: 7 | 30 = 7, group?: HealthMetricGroup): Promise<HealthProjection> {
  const { service, bearer } = healthBinding(env);
  const response = await service.fetch(new Request(`https://health.internal/service/health/projection?${query(range, group)}`, {
    headers: { authorization: `Bearer ${bearer}`, "x-health-client": "telegram-miniapp" },
  }));
  const value = await readBoundedJson<HealthProjection & { error?: string }>(response);
  if (!response.ok) throw new Error(value.error || `health_projection_${response.status}`);
  if (value.schemaVersion !== 1 || value.ownerDomain !== "health.example.com" || !Array.isArray(value.series)) throw new Error("health_projection_invalid");
  return value;
}
