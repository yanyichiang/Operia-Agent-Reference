import type { CalendarProjection } from "../calendar/types";
import type { CalendarMutationEnvelope } from "../calendar/writebackContracts";
import type { Env } from "../types";

type CalendarConnectResponse = { authorizeUrl?: string; expiresAt?: number; error?: string };

function calendarBinding(env: Env): { service: Fetcher; bearer: string } {
  const service = env.CALENDAR_SERVICE;
  const bearer = env.CALENDAR_SERVICE_BEARER?.trim();
  if (!service || !bearer) throw new Error("calendar_service_not_configured");
  return { service, bearer };
}

function serviceRequest(env: Env, ownerId: string, path: string, init: RequestInit = {}): Request {
  const { bearer } = calendarBinding(env);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  headers.set("x-calendar-owner-id", ownerId);
  return new Request(`https://calendar.internal${path}`, { ...init, headers });
}

async function readBoundedJson<T>(response: Response, maxBytes = 100_000): Promise<T> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("calendar_response_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("calendar_response_too_large");
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export async function getCalendarProjection(env: Env, ownerId: string): Promise<CalendarProjection> {
  const { service } = calendarBinding(env);
  const response = await service.fetch(serviceRequest(env, ownerId, "/service/calendar/projection"));
  const value = await readBoundedJson<CalendarProjection & { error?: string }>(response);
  if (!response.ok) throw new Error(value.error || `calendar_projection_${response.status}`);
  return value;
}

export async function createCalendarConnectLink(env: Env, ownerId: string): Promise<{ authorizeUrl: string; expiresAt: number }> {
  const { service } = calendarBinding(env);
  const response = await service.fetch(serviceRequest(env, ownerId, "/service/calendar/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ returnRoute: "/app?calendar=connected" }),
  }));
  const value = await readBoundedJson<CalendarConnectResponse>(response);
  if (!response.ok || !value.authorizeUrl || !value.expiresAt) throw new Error(value.error || `calendar_connect_${response.status}`);
  const url = new URL(value.authorizeUrl);
  if (url.protocol !== "https:" || url.hostname !== "calendar.example.com" || url.pathname !== "/oauth/start") {
    throw new Error("calendar_connect_url_invalid");
  }
  return { authorizeUrl: url.toString(), expiresAt: value.expiresAt };
}

export async function disconnectCalendar(env: Env, ownerId: string): Promise<{ ok: boolean; status: string }> {
  const { service } = calendarBinding(env);
  const response = await service.fetch(serviceRequest(env, ownerId, "/service/calendar/connection", { method: "DELETE" }));
  const value = await readBoundedJson<{ ok?: boolean; status?: string; error?: string }>(response);
  if (!response.ok || value.ok !== true) throw new Error(value.error || `calendar_disconnect_${response.status}`);
  return { ok: true, status: value.status || "disconnected" };
}

export async function mutateCalendar(
  env: Env,
  ownerId: string,
  input: Omit<CalendarMutationEnvelope, "ownerId" | "sourceDomain">,
): Promise<Record<string, unknown>> {
  const { service } = calendarBinding(env);
  const response = await service.fetch(serviceRequest(env, ownerId, "/service/calendar/mutations", {
    method: "POST",
    headers: { "content-type": "application/json", "x-calendar-source-domain": "tgbot.example.com" },
    body: JSON.stringify({ ...input, ownerId, sourceDomain: "tgbot.example.com" }),
  }));
  const value = await readBoundedJson<Record<string, unknown>>(response, 160_000);
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `calendar_mutation_${response.status}`);
  return value;
}
