import { authenticateDomainSession } from "../auth/domainSession";
import {
  deleteMemoryControlOverride,
  claimMemoryNextTurn,
  getMemoryControlSnapshot,
  listMemoryControlEvents,
  putMemoryControlOverride,
  putMemoryGlobalControl,
  releaseMemoryNextTurn,
  type ControlMutationActor,
} from "../control/ownerStore";
import { parseControlScopeRef } from "../control/scope";
import type { ControlScopeRef } from "../control/types";
import type { Env } from "../types";
import { getThinkObservationSummary } from "../memory/think/observationTelemetry";
import { getCacheHealthSummary } from "./debug";
import { authorizeInternalService, internalServiceAuthSpecForRoute, matchInternalServicePath } from "../security/credentials";
import { findMemoryControlRoutes } from "../security/internalServiceRegistry";

const ORIGIN = "https://memory.example.com";
const encoder = new TextEncoder();

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function memoryControlCsrfToken(env: Env): Promise<string | null> {
  if (!env.OPERIA_SESSION_SECRET) return null;
  return hmac(`memory-control:v1:${ORIGIN}`, env.OPERIA_SESSION_SECRET);
}

async function browserAuthorized(request: Request, env: Env): Promise<boolean> {
  const headers = new Headers(request.headers);
  headers.set("x-operia-session", "1");
  return (await authenticateDomainSession(new Request(request.clone(), { headers }), env)).ok;
}

async function authorizeBrowser(request: Request, env: Env, mutation: boolean): Promise<ControlMutationActor | null> {
  if (!await browserAuthorized(request, env)) return null;
  if (mutation) {
    if (new URL(request.url).origin !== ORIGIN || request.headers.get("origin") !== ORIGIN) return null;
    const expected = await memoryControlCsrfToken(env);
    if (!expected || request.headers.get("x-csrf-token") !== expected) return null;
  }
  return { type: "user", id: "domain-session", sourceDomain: ORIGIN.slice("https://".length) };
}

async function authorizeService(request: Request, env: Env): Promise<ControlMutationActor | null> {
  const url = new URL(request.url);
  if (url.hostname !== "<MEMORY_SERVICE>.internal") return null;

  const memoryControlRoutes = findMemoryControlRoutes();
  const route = memoryControlRoutes.find((candidate) =>
    matchInternalServicePath(candidate.path, url.pathname) && candidate.methods.includes(request.method)
  );
  if (!route) return null;

  const identity = await authorizeInternalService(
    request,
    internalServiceAuthSpecForRoute(route),
    env.MEMORY_CONTROL_SERVICE_BEARER?.trim(),
  );
  if (!identity) return null;

  return { type: "service", id: identity.serviceId, sourceDomain: identity.sourceDomain };
}

function scopeFromUrl(url: URL): ControlScopeRef | undefined {
  const channel = url.searchParams.get("channel")?.trim();
  const chatId = url.searchParams.get("chat_id")?.trim();
  if (!channel) return undefined;
  return chatId ? { type: "chat", channel, chatId } : { type: "channel", channel };
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("revision_conflict")) return json({ error: "revision_conflict" }, 409);
  if (message.includes("control_has_dedicated_owner")) return json({ error: message }, 409);
  if (message.includes("control_read_only")) return json({ error: message }, 422);
  if (message.includes("missing_revision") || message.includes("invalid_revision")) return json({ error: message.split(":")[0] }, 428);
  if (message.includes("not_found")) return json({ error: message }, 404);
  if (message.includes("invalid_") || message.includes("scope_") || message.includes("outside_")) return json({ error: message }, 422);
  console.error("memory control mutation failed", { message: message.slice(0, 240) });
  return json({ error: "control_mutation_failed" }, 500);
}

async function requestHash(request: Request, body: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify({ method: request.method, path: new URL(request.url).pathname, body })));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function replayIdempotency(env: Env, key: string, hash: string): Promise<Response | null> {
  const row = await env.DB.prepare("SELECT request_hash,response_json,status FROM control_idempotency WHERE idempotency_key=? AND expires_at>?")
    .bind(key, new Date().toISOString()).first<{ request_hash: string; response_json: string; status: number }>();
  if (!row) return null;
  if (row.request_hash !== hash) return json({ error: "idempotency_conflict" }, 409);
  return new Response(row.response_json, { status: row.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function storeIdempotency(env: Env, key: string, hash: string, payload: unknown, status: number): Promise<void> {
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
  await env.DB.prepare(`INSERT OR REPLACE INTO control_idempotency
    (idempotency_key,request_hash,response_json,status,created_at,expires_at) VALUES(?,?,?,?,?,?)`)
    .bind(key, hash, JSON.stringify(payload), status, now.toISOString(), expires.toISOString()).run();
}

async function workersAiModels(env: Env, search: string): Promise<Response> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) return json({ error: "workers_ai_catalog_not_configured" }, 503);
  const endpoint = new URL(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search`);
  endpoint.searchParams.set("page", "1");
  endpoint.searchParams.set("per_page", "100");
  if (search) endpoint.searchParams.set("search", search.slice(0, 100));
  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  const payload: { success?: boolean; result?: unknown[]; errors?: unknown[] } = await response
    .json<{ success?: boolean; result?: unknown[]; errors?: unknown[] }>().catch(() => ({}));
  if (!response.ok || payload.success !== true || !Array.isArray(payload.result)) {
    console.error("workers ai model catalog failed", { status: response.status });
    return json({ error: "workers_ai_catalog_unavailable" }, 503);
  }
  const models = payload.result.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const rawName = typeof row.name === "string" ? row.name : typeof row.id === "string" ? row.id : "";
    if (!rawName) return [];
    const task = typeof row.task === "string" ? row.task : "unknown";
    if (task.trim().toLowerCase().replace(/[\s_]+/g, "-") !== "text-generation") return [];
    const id = rawName.startsWith("workers-ai/") ? rawName : `workers-ai/${rawName}`;
    const properties = Array.isArray(row.properties) ? row.properties.filter((item): item is string => typeof item === "string") : [];
    return [{ id, name: rawName, task, description: typeof row.description === "string" ? row.description : "", properties }];
  });
  return json({ models, observedAt: new Date().toISOString() });
}

export async function handleMemoryControlApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const service = url.pathname.startsWith("/service/control/");
  const relative = url.pathname.replace(/^\/(?:api|service)\/control/, "");
  const mutation = !["GET", "HEAD"].includes(request.method);

  let actor: ControlMutationActor | null = null;
  if (service) {
    // Secondary host fence: the handler must also assert internal hostname in
    // case the router is ever rearranged.
    if (url.hostname !== "<MEMORY_SERVICE>.internal") {
      return json({ error: "not_found" }, 404);
    }

    // Route / method enforcement from the Registry before auth.
    const memoryControlRoutes = findMemoryControlRoutes();
    const route = memoryControlRoutes.find((candidate) =>
      matchInternalServicePath(candidate.path, url.pathname) && candidate.methods.includes(request.method)
    );
    if (!route) {
      const anyMethodRoute = memoryControlRoutes.find((candidate) =>
        matchInternalServicePath(candidate.path, url.pathname)
      );
      return json({ error: anyMethodRoute ? "method_not_allowed" : "not_found" }, anyMethodRoute ? 405 : 404);
    }

    actor = await authorizeService(request, env);
    if (!actor) return json({ error: "unauthorized" }, 401);
  } else {
    actor = await authorizeBrowser(request, env, mutation);
    if (!actor) return json({ error: "unauthorized" }, 401);
  }

  if (request.method === "GET" && relative === "/bootstrap") {
    return json({ csrfToken: service ? null : await memoryControlCsrfToken(env), snapshot: await getMemoryControlSnapshot(env, scopeFromUrl(url)) });
  }
  if (request.method === "GET" && relative === "/values") {
    const requested = new Set((url.searchParams.get("keys") || "").split(",").map((key) => key.trim()).filter(Boolean));
    const snapshot = await getMemoryControlSnapshot(env, scopeFromUrl(url));
    return json({ ...snapshot, values: requested.size ? snapshot.values.filter((item) => requested.has(item.key)) : snapshot.values });
  }
  if ((request.method === "GET" || request.method === "POST") && relative === "/effective") {
    let scope = scopeFromUrl(url);
    if (request.method === "POST") {
      const body: Record<string, unknown> = await request.json<Record<string, unknown>>().catch(() => ({}));
      if (body.scope) scope = parseControlScopeRef(body.scope);
    }
    return json(await getMemoryControlSnapshot(env, scope));
  }
  if (request.method === "GET" && relative === "/events") {
    return json({ events: await listMemoryControlEvents(env, Number(url.searchParams.get("limit")) || 50) });
  }
  if (request.method === "GET" && relative === "/cache-health") {
    try {
      return json(await getCacheHealthSummary(env, Number(url.searchParams.get("hours")) || 24));
    } catch (error) {
      console.error("control cache health query failed", error);
      return json({ error: "cache_health_query_failed" }, 500);
    }
  }
  if (request.method === "GET" && relative === "/models") {
    return workersAiModels(env, url.searchParams.get("search")?.trim() || "");
  }
  if (request.method === "GET" && relative === "/think-observation") {
    try {
      return json(await getThinkObservationSummary(env, Number(url.searchParams.get("hours")) || 24));
    } catch (error) {
      console.error("control Think observation query failed", error);
      return json({ error: "think_observation_query_failed" }, 500);
    }
  }

  if (request.method === "POST" && (relative === "/next-turn/claim" || relative === "/next-turn/release")) {
    const body: Record<string, unknown> = await request.json<Record<string, unknown>>().catch(() => ({}));
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    if (requestId.length < 8 || requestId.length > 200) return json({ error: "invalid_request_id" }, 422);
    let scope: ControlScopeRef;
    try { scope = parseControlScopeRef(body.scope); } catch (error) { return errorResponse(error); }
    if (scope.type !== "next_turn") return json({ error: "invalid_next_turn_scope" }, 422);
    if (actor.type === "service" && actor.sourceDomain === "tgbot.example.com" && scope.channel !== "telegram") {
      return json({ error: "service_scope_not_allowed" }, 403);
    }
    try {
      if (relative.endsWith("/claim")) return json(await claimMemoryNextTurn(env, { requestId, scope, actor }));
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (!idempotencyKey || idempotencyKey.length < 8) return json({ error: "idempotency_key_required" }, 428);
      return json(await releaseMemoryNextTurn(env, { requestId, scope, actor }));
    } catch (error) { return errorResponse(error); }
  }

  const globalMatch = /^\/values\/(.+)$/.exec(relative);
  const overrideMatch = /^\/overrides\/(.+)$/.exec(relative);
  if (!globalMatch && !overrideMatch) return json({ error: "not_found" }, 404);

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) return json({ error: "idempotency_key_required" }, 428);
  const body: Record<string, unknown> = await request.json<Record<string, unknown>>().catch(() => ({}));
  const hash = await requestHash(request, body);
  const replay = await replayIdempotency(env, idempotencyKey, hash);
  if (replay) return replay;

  try {
    let snapshot;
    if (globalMatch && request.method === "PUT") {
      snapshot = await putMemoryGlobalControl(env, { key: decodeURIComponent(globalMatch[1]), value: body.value,
        ifMatch: request.headers.get("if-match"), actor, requestId: idempotencyKey });
    } else if (overrideMatch && request.method === "PUT") {
      snapshot = await putMemoryControlOverride(env, { key: decodeURIComponent(overrideMatch[1]), scope: parseControlScopeRef(body.scope),
        value: body.value, ifMatch: request.headers.get("if-match"), actor,
        expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined, requestId: idempotencyKey });
    } else if (overrideMatch && request.method === "DELETE") {
      snapshot = await deleteMemoryControlOverride(env, { key: decodeURIComponent(overrideMatch[1]), scope: parseControlScopeRef(body.scope),
        ifMatch: request.headers.get("if-match"), actor, requestId: idempotencyKey });
    } else {
      return json({ error: "method_not_allowed" }, 405);
    }
    const payload = { ok: true, snapshot };
    await storeIdempotency(env, idempotencyKey, hash, payload, 200);
    return json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
