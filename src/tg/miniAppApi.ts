import type { Env } from "../types";
import { CONTROL_TOPOLOGY } from "../controlRegistry";
import {
  getAgentControlProjection,
  getAgentHeartbeatProjection,
  getAgentHtmlArtifact,
  getAgentMcpControl,
  getAgentOperationsProjection,
  controlAgentTask,
  forwardMcpElicitationDecision,
  isAgentCommandOwner,
  listAgentHtmlArtifacts,
  readAgentHtmlArtifactBundle,
  saveAgentHtmlArtifactState,
  updateAgentCapability,
  updateAgentHeartbeatConfig,
  updateAgentMcpTool,
  updateAgentSkillInstallation,
} from "./agentClient";
import {
  authorizeMiniAppSession,
  clearMiniAppSessionCookie,
  createMiniAppSession,
  miniAppCsrfToken,
  miniAppSessionLocator,
  miniAppSessionCookie,
  validateMiniAppCsrfToken,
  validateTelegramInitData,
} from "./miniAppAuth";
import { createCalendarConnectLink, disconnectCalendar, getCalendarProjection, mutateCalendar } from "./calendarClient";
import type { CalendarProjection } from "../calendar/types";
import { getHealthProjection } from "./healthClient";
import type { HealthProjection } from "../health/types";
import { setAgentRoomWakePolicy } from "./agentRooms";
import { getAgentRoomProjection, listAgentRoomProjections } from "./roomProjection";
import { setRoomOwnerPin, setRoomSummaryMode } from "./roomSharedState";
import { listOpenTgAttention } from "./attention";
import { executeNoteAction, getNoteLifeProjection, listNoteItems, type NoteServiceBinding } from "../note/client";
import type { NoteItemRecord } from "../note/types";
import type { OperiaActionContract } from "../contracts/operiaProduct";
import { getTgMemoryCacheHealth, getTgMemoryControls, resetTgMemoryControl, searchTgWorkersAiModels, setTgMemoryControl, type TgMemoryCacheHealth } from "./memoryControlClient";
import { getChatConfig, getTgSetting, normalizeVoiceModel, setTgSetting, setVoiceMode } from "./settings";
import { getTgCloudflareAnalytics, type TgCloudflareAnalyticsProjection } from "./operiaDashboardClient";
import { listMiniAppMemories, updateMiniAppMemoryPresentation } from "./private/miniAppMemoryClient";

const MAX_SESSION_BODY_BYTES = 12_000;
const MINIAPP_PROJECTION_SCOPES = ["full", "memory", "context", "life", "notes", "console"] as const;
type MiniAppProjectionScope = typeof MINIAPP_PROJECTION_SCOPES[number];

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      ...headers,
    },
  });
}

function isEnabled(env: Env): boolean {
  return env.TG_MINIAPP_ENABLED?.trim().toLowerCase() === "true";
}

function artifactsEnabled(env: Env): boolean {
  return env.AGENT_HTML_ARTIFACTS_ENABLED?.trim().toLowerCase() === "true";
}

function calendarEnabled(env: Env): boolean {
  return env.CALENDAR_GOOGLE_ENABLED?.trim().toLowerCase() === "true";
}

function calendarWriteEnabled(env: Env): boolean {
  return env.TG_MINIAPP_CALENDAR_WRITE_ENABLED?.trim().toLowerCase() === "true";
}

function healthEnabled(env: Env): boolean {
  return env.HEALTH_MINIAPP_ENABLED?.trim().toLowerCase() === "true";
}

function operationsEnabled(env: Env): boolean {
  return env.TG_MINIAPP_OPERATIONS_ENABLED?.trim().toLowerCase() === "true";
}

function ownerScope(env: Env, userId: string): { ownerId: string; chatId: string } | null {
  const ownerId = env.TG_AGENT_OWNER_ID?.trim();
  const chatId = env.TG_AGENT_OWNER_CHAT_ID?.trim();
  if (!ownerId || !chatId || userId !== ownerId || !isAgentCommandOwner(env, chatId)) return null;
  return { ownerId, chatId };
}

function noteBinding(env: Env): NoteServiceBinding | null {
  const bearer = env.NOTE_SERVICE_BEARER?.trim();
  const ownerId = env.NOTE_OWNER_ID?.trim() || env.TG_AGENT_OWNER_ID?.trim();
  if (!env.NOTE_SERVICE || !bearer || !ownerId) return null;
  return { service: env.NOTE_SERVICE, bearer, ownerId };
}

function actionId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function noteActionContract(
  scope: { ownerId: string },
  operation: string,
  targetId: string,
  expectedRevision: number | null,
): OperiaActionContract {
  const id = actionId("action");
  return {
    schemaVersion: 1,
    actionId: id,
    idempotencyKey: id,
    ownerId: scope.ownerId,
    ownerDomain: "note.example.com",
    actor: { kind: "owner", id: scope.ownerId },
    requester: "owner",
    authorizedBy: scope.ownerId,
    sourceSurface: "miniapp",
    target: { type: "note_item", id: targetId },
    operation,
    expectedRevision,
    rootTaskId: null,
    parentTaskId: null,
    requestedAt: new Date().toISOString(),
  };
}

function isSameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  return origin === url.origin && (url.hostname === "tgbot.example.com" || url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

async function readSessionBody(request: Request): Promise<{ initData: string } | null> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_SESSION_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_SESSION_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text) as { initData?: unknown };
    return typeof value.initData === "string" ? { initData: value.initData } : null;
  } catch {
    return null;
  }
}

async function readBoundedJsonObject(request: Request, maxBytes = 20_000): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxBytes) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function reserveReplayKey(env: Env, replayKey: string, expiresAt: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM tg_miniapp_auth_replays WHERE expires_at <= ?").bind(now).run();
  try {
    await env.DB.prepare(`INSERT INTO tg_miniapp_auth_replays(replay_key,expires_at,created_at)
      VALUES(?,?,datetime('now'))`).bind(replayKey, expiresAt).run();
    return true;
  } catch {
    return false;
  }
}

async function safeProjection<T>(work: (() => Promise<T>) | null, fallback: T): Promise<T> {
  if (!work) return fallback;
  try { return await work(); } catch { return fallback; }
}

function emptyD1Result<T>(): D1Result<T> {
  return {
    success: true,
    results: [],
    meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 },
  };
}

async function miniAppUsageSnapshot(env: Env): Promise<Record<string, unknown>> {
  const result = await env.DB.prepare(`SELECT u.created_at,u.model,u.service_tier,u.ttft_ms,u.total_ms,
    u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_creation_tokens,u.client_system_hash
    FROM usage_logs u JOIN messages m ON m.id=u.message_id
    WHERE m.source='telegram' ORDER BY u.created_at DESC LIMIT 12`).all<{
      created_at: string; model: string; service_tier: string | null; ttft_ms: number | null; total_ms: number | null;
      input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null;
      cache_creation_tokens: number | null; client_system_hash: string | null;
    }>();
  return {
    requests: (result.results || []).map((row) => ({
      createdAt: row.created_at,
      model: row.model,
      serviceTier: row.service_tier,
      ttftMs: row.ttft_ms,
      totalMs: row.total_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreateTokens: row.cache_creation_tokens,
      prefixHash: row.client_system_hash?.slice(0, 16) || null,
    })),
    cost: { status: "not_connected", note: "只显示可核验 usage；未接账单来源时不估算费用。" },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function agentControlValue(projection: unknown, key: string): { value: unknown; source: string; revision: number; updatedAt: string | null } | null {
  const own = record(record(projection).own);
  const values = Array.isArray(own.values) ? own.values : [];
  for (const item of values) {
    const row = record(item);
    const definition = record(row.definition);
    const current = record(row.current);
    if (definition.key !== key) continue;
    return {
      value: current.value,
      source: typeof row.source === "string" ? row.source : "agent",
      revision: Number.isSafeInteger(Number(current.revision)) ? Number(current.revision) : 0,
      updatedAt: typeof current.updatedAt === "string" ? current.updatedAt : null,
    };
  }
  return null;
}

function memoryControlValue(controls: unknown, key: string): { value: unknown; source: string; revision: number; canReset: boolean } | null {
  const snapshot = record(controls);
  const values = Array.isArray(snapshot.values) ? snapshot.values : [];
  for (const item of values) {
    const row = record(item);
    if (row.key !== key) continue;
    return {
      value: row.effectiveValue,
      source: typeof row.effectiveSource === "string" ? row.effectiveSource : "memory",
      revision: Number.isSafeInteger(Number(row.revision)) ? Number(row.revision) : 0,
      canReset: row.canReset === true,
    };
  }
  return null;
}

function modelProjection(agent: unknown, memoryControls: unknown, observedAt: string): Record<string, unknown> {
  const chat = memoryControlValue(memoryControls, "memory.inference.chat_model");
  const planner = agentControlValue(agent, "agent.planner.model");
  const routes = [
    ...(chat && typeof chat.value === "string" && chat.value.trim() ? [{ id: "chat", label: "主聊天", model: chat.value, ownerDomain: "memory.example.com", effectiveSource: chat.source, revision: chat.revision, canReset: chat.canReset, status: "ready" }] : []),
    ...(planner && typeof planner.value === "string" && planner.value.trim() ? [{ id: "planner", label: "工具规划", model: planner.value, ownerDomain: "agent.example.com", effectiveSource: planner.source, revision: planner.revision, status: "ready" }] : []),
  ];
  return {
    status: routes.length === 2 ? "ready" : routes.length ? "partial" : "unavailable",
    observedAt,
    routes,
    pendingRoutes: ["stt", "tts", "vision", "image", "memory_summary", "health_summary"],
  };
}

function voiceProjection(agent: unknown, env: Env, observedAt: string, delivery: Awaited<ReturnType<typeof getChatConfig>> | null): Record<string, unknown> {
  const enabled = agentControlValue(agent, "agent.voice.provider.enabled");
  const minimax = agentControlValue(agent, "agent.voice.providers.minimax.enabled");
  const defaultProvider = agentControlValue(agent, "agent.voice.default_provider");
  const budget = agentControlValue(agent, "agent.voice.budget.daily_micro_usd");
  const sharedEnabled = enabled?.value === true;
  return {
    status: enabled ? (sharedEnabled ? "partial" : "disabled") : "unavailable",
    observedAt,
    ownerDomain: "agent.example.com",
    enabled: sharedEnabled,
    defaultProvider: typeof defaultProvider?.value === "string" ? defaultProvider.value : null,
    dailyBudgetUsd: typeof budget?.value === "number" ? budget.value / 1_000_000 : null,
    telegramDeliveryEnabled: env.VOICE_ENABLED?.trim().toLowerCase() === "true",
    deliveryMode: delivery ? (delivery.voiceOnce ? "once" : delivery.voicePolicy) : "off",
    deliveryModel: delivery?.voiceModel || "expressive",
    providers: [
      { id: "elevenlabs", enabled: sharedEnabled, source: enabled?.source || "unavailable" },
      { id: "minimax", enabled: sharedEnabled && minimax?.value === true, source: minimax?.source || "unavailable" },
      { id: "custom", enabled: false, source: "not_registered" },
    ],
  };
}

async function bootstrap(
  env: Env,
  userId: string,
  csrfToken: string,
  sessionLocator: string,
  projectionScope: MiniAppProjectionScope = "full",
): Promise<Record<string, unknown>> {
  const observedAt = new Date().toISOString();
  const scope = ownerScope(env, userId);
  const notes = noteBinding(env);
  const includeFull = projectionScope === "full";
  const includeMemory = includeFull || projectionScope === "memory";
  const includeContext = includeFull || projectionScope === "context";
  const includeLife = includeFull || projectionScope === "life";
  const includeNotes = includeFull || projectionScope === "notes";
  const includeConsole = includeFull || projectionScope === "console";
  const calendarFallback: CalendarProjection = {
    ownerDomain: "calendar.example.com",
    status: calendarEnabled(env) ? "unavailable" : "disabled",
    observedAt,
    staleAfter: observedAt,
    upcoming: [],
    remainingToday: 0,
  };
  const healthFallback: HealthProjection = {
    schemaVersion: 1,
    ownerDomain: "health.example.com",
    status: healthEnabled(env) ? "unavailable" : "disabled",
    range: 7,
    timezone: "<YOUR_TIMEZONE>",
    observedAt,
    freshness: { state: "missing", ageSeconds: null },
    summary: {},
    series: [],
    timelineEvents: [],
    source: { kind: "Not Connected", labels: [] },
    missingData: true,
    fullViewUrl: "https://health.example.com/",
    disclaimer: "informational_not_medical_diagnosis",
  };
  const cacheFallback: TgMemoryCacheHealth = {
    status: "unavailable", ownerDomain: "memory.example.com", observedAt, windowHours: 24,
    totalRequests: 0, cacheHitRequests: 0, coldStartRequests: 0, cacheCreationTokens: 0,
    cacheReadTokens: 0, inputTokens: 0, promptTokens: 0, cacheHitRequestRate: 0, cacheReadShare: 0,
    policy: { promptCacheMode: null, stableTtl: null, conversationTtl: null, evaluationWindow: null },
    fingerprints: [], recent: [],
  };
  const billingFallback: TgCloudflareAnalyticsProjection = {
    schemaVersion: 1, ownerDomain: "operia.example.com", source: "cloudflare.ai-gateway",
    status: "unavailable", range: "24h", observedAt, staleAfter: observedAt, gateway: "default",
    summary: null, series: [], components: [], models: [], reason: "not_connected",
  };
  const [pending, events, outbox, continuations, attentionRows, tgAttentionRows, timeline, heartbeat, agent, operations, mcp, usage, artifacts, calendar, health, rooms, noteItems, noteLife, memories, memoryControls, memoryCache, billing] = await Promise.all([
    includeFull ? env.DB.prepare("SELECT COUNT(*) AS count FROM tg_inbox WHERE processed = 0").first<{ count: number }>() : Promise.resolve(null),
    includeFull ? env.DB.prepare("SELECT status,COUNT(*) AS count FROM tg_events WHERE created_at >= datetime('now','-24 hours') GROUP BY status").all<{ status: string; count: number }>() : Promise.resolve(emptyD1Result<{ status: string; count: number }>()),
    includeFull ? env.DB.prepare("SELECT status,COUNT(*) AS count FROM tg_agent_outbox GROUP BY status").all<{ status: string; count: number }>() : Promise.resolve(emptyD1Result<{ status: string; count: number }>()),
    includeFull ? env.DB.prepare("SELECT status,COUNT(*) AS count FROM tg_agent_continuations GROUP BY status").all<{ status: string; count: number }>() : Promise.resolve(emptyD1Result<{ status: string; count: number }>()),
    includeFull ? env.DB.prepare(`SELECT id,tool_name,status,round,updated_at FROM tg_agent_continuations
      WHERE status='attention_required' ORDER BY updated_at DESC LIMIT 20`).all<{
        id: string; tool_name: string; status: string; round: number; updated_at: string;
      }>() : Promise.resolve(emptyD1Result<{ id: string; tool_name: string; status: string; round: number; updated_at: string }>()),
    includeFull ? listOpenTgAttention(env.DB, 30) : Promise.resolve([]),
    includeLife ? env.DB.prepare(`SELECT id,event_type,status,created_at FROM tg_events
      WHERE event_type NOT IN ('reasoning.trace','prompt.raw') ORDER BY id DESC LIMIT 20`).all<{
        id: number; event_type: string; status: string; created_at: string;
      }>() : Promise.resolve(emptyD1Result<{ id: number; event_type: string; status: string; created_at: string }>()),
    safeProjection(includeConsole && env.AGENT_SERVICE ? () => getAgentHeartbeatProjection(env) : null, { status: "unavailable" }),
    safeProjection(includeConsole && env.AGENT_SERVICE ? () => getAgentControlProjection(env) : null, { status: "unavailable" }),
    safeProjection(includeConsole && env.AGENT_SERVICE ? () => getAgentOperationsProjection(env) : null, {
      status: "unavailable", tasks: [], approvals: [], elicitations: [], skills: [], attention: [], observedAt,
    }),
    safeProjection(includeConsole && env.AGENT_SERVICE ? () => getAgentMcpControl(env) : null, { status: "unavailable" }),
    safeProjection(includeFull ? () => miniAppUsageSnapshot(env) : null, { requests: [], cost: { status: "unavailable" } }),
    safeProjection(includeFull && artifactsEnabled(env) && env.AGENT_SERVICE ? () => listAgentHtmlArtifacts(env) : null, { artifacts: [], observedAt }),
    safeProjection(includeLife && calendarEnabled(env) && env.CALENDAR_SERVICE ? () => getCalendarProjection(env, userId) : null, calendarFallback),
    safeProjection(includeLife && healthEnabled(env) && env.HEALTH_SERVICE ? () => getHealthProjection(env, 7) : null, healthFallback),
    safeProjection(includeFull ? () => listAgentRoomProjections(env) : null, []),
    safeProjection(includeNotes && notes ? () => listNoteItems(notes, { status: "active", limit: 100 }) : null, { data: [] as NoteItemRecord[] }),
    safeProjection(includeFull && notes ? () => getNoteLifeProjection(notes) : null, null),
    safeProjection(includeMemory && env.MEMORY_SERVICE && env.TG_CHAT_API_KEY ? () => listMiniAppMemories(env, 80) : null, {
      data: [], paging: { limit: 80, cursor: null, has_more: false, count: 0 },
    }),
    safeProjection((includeContext || includeConsole) && scope && env.MEMORY_SERVICE && env.MEMORY_CONTROL_SERVICE_BEARER
      ? () => getTgMemoryControls(env, scope.chatId) : null, null),
    safeProjection(includeContext && scope && env.MEMORY_SERVICE && env.MEMORY_CONTROL_SERVICE_BEARER
      ? () => getTgMemoryCacheHealth(env, 24) : null, cacheFallback),
    safeProjection(includeContext && scope && env.OPERIA_DASHBOARD_SERVICE && env.OPERIA_DASHBOARD_SERVICE_BEARER
      ? () => getTgCloudflareAnalytics(env, "24h") : null, billingFallback),
  ]);
  const outboxCounts = Object.fromEntries((outbox.results || []).map((row) => [row.status, row.count]));
  const continuationCounts = Object.fromEntries((continuations.results || []).map((row) => [row.status, row.count]));
  const tgAttention = tgAttentionRows.length + Number(attentionRows.results?.length || 0);
  const operationAttention = Array.isArray(operations.attention) ? operations.attention : [];
  const operationApprovals = Array.isArray(operations.approvals) ? operations.approvals : [];
  const operationElicitations = Array.isArray(operations.elicitations) ? operations.elicitations : [];
  const attention = tgAttention + operationAttention.length + operationApprovals.filter((item) =>
    item && typeof item === "object" && (item as Record<string, unknown>).status === "pending"
  ).length + operationElicitations.filter((item) =>
    item && typeof item === "object" && (item as Record<string, unknown>).status === "pending"
  ).length;
  const memoryContext = {
    ...memoryCache,
    sourceVersion: typeof memoryControls?.ownerVersion === "string" ? memoryControls.ownerVersion : null,
    staleAfter: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  const [reasoningMode, reasoningOnce, chatConfig] = includeConsole ? await Promise.all([
    getTgSetting(env.DB, "reasoning_mode", "summary"),
    scope ? getTgSetting(env.DB, `reasoning_once:${scope.chatId}`, false) : Promise.resolve(false),
    scope ? getChatConfig(env.DB, scope.chatId) : Promise.resolve(null),
  ]) : ["off", false, null] as const;

  return {
    schemaVersion: 1,
    build: "miniapp-v2",
    projectionScope,
    observedAt,
    csrfToken,
    owner: { userId, domain: "tgbot.example.com" },
    presentation: {
      ownerDomain: "tgbot.example.com",
      reasoningMode,
      reasoningOnce,
      canonicalKey: "telegram.presentation.reasoning_mode",
    },
    memory: {
      ownerDomain: "memory.example.com",
      items: memories.data,
      paging: memories.paging,
      controls: memoryControls,
      context: memoryContext,
    },
    notes: {
      ownerDomain: "note.example.com",
      items: noteItems.data,
      life: noteLife,
    },
    today: {
      opus: { ownerDomain: "memory.example.com", status: "available", label: "Opus 4.6", observedAt },
      calendar,
      home: { ownerDomain: "home-assistant", status: "not_connected", observedAt },
      health,
      attention,
      pendingMessages: pending?.count || 0,
    },
    timeline: [
      ...(calendar.upcoming || []).map((event) => ({
        eventId: `calendar:${event.eventId}`,
        ownerDomain: "calendar.example.com",
        sourceType: "calendar",
        occurredAt: event.start,
        observedAt: event.observedAt,
        title: event.title,
        status: event.status,
      })),
      ...(health.timelineEvents || []),
      ...(timeline.results || []).map((row) => ({
      eventId: `telegram:${row.id}`,
      ownerDomain: "tgbot.example.com",
      sourceType: "telegram",
      occurredAt: row.created_at,
      observedAt,
      title: row.event_type,
      status: row.status,
      })),
    ].sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt))).slice(0, 20),
    workbench: {
      operationsEnabled: operationsEnabled(env),
      heartbeat,
      agent,
      operations,
      mcp,
      usage: {
        ...usage,
        cache: memoryContext,
        billing,
      },
      models: modelProjection(agent, memoryControls, observedAt),
      voice: voiceProjection(agent, env, observedAt, chatConfig),
      attention: [
        ...operationAttention,
        ...tgAttentionRows.map((row) => ({
          kind: row.kind,id: row.attention_id,status: row.status,summary: row.summary,
          observedAt: row.last_seen_at,occurrenceCount: row.occurrence_count,
          canonicalLink: row.canonical_link,retryPolicy:"manual_review_no_blind_retry",
        })),
        ...(attentionRows.results || []).map((row) => ({
          kind:"telegram_continuation",id:row.id,status:row.status,
          summary:`${row.tool_name || "continuation"} · round ${row.round}`,
          observedAt:row.updated_at,retryPolicy:"manual_review_no_blind_retry",
        })),
      ].slice(0, 30),
      health: { status: health.status, freshness: health.freshness },
      outbox: outboxCounts,
      continuations: continuationCounts,
    },
    workgroup: {
      ownerDomain: "tgbot.example.com",
      operationsEnabled: operationsEnabled(env),
      rooms,
    },
    together: { reading: "planned", watching: "planned", focus: "planned" },
    games: [{ id: "riddle", title: "Riddle", status: "planned", href: "/app/games/riddle" }],
    artifacts: {
      enabled: artifactsEnabled(env),
      interactiveEnabled: env.AGENT_INTERACTIVE_ARTIFACTS_ENABLED?.trim().toLowerCase() === "true",
      items: artifacts.artifacts,
      observedAt: artifacts.observedAt,
      autoOpenArtifactId: artifacts.artifacts.find((artifact) => artifact.status === "ready" && artifact.correlation?.sessionId === sessionLocator)?.artifactId ?? null,
    },
    topology: { registryVersion: CONTROL_TOPOLOGY.registryVersion },
  };
}

export async function handleMiniAppApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!isEnabled(env)) return json({ error: "miniapp_disabled" }, 404);

  if (request.method === "POST" && url.pathname === "/api/miniapp/session") {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const body = await readSessionBody(request);
    const botToken = env.TG_BOT_TOKEN?.trim();
    const ownerUserId = env.TG_AGENT_OWNER_ID?.trim();
    const sessionSecret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    if (!body) return json({ error: "invalid_request" }, 400);
    if (!botToken || !ownerUserId || !sessionSecret) return json({ error: "miniapp_not_configured" }, 503);
    const maxAgeSeconds = Number(env.TG_MINIAPP_AUTH_MAX_AGE_SECONDS) || 300;
    const identity = await validateTelegramInitData({ initData: body.initData, botToken, ownerUserId, maxAgeSeconds });
    if (!identity) return json({ error: "telegram_auth_invalid" }, 401);
    if (!await reserveReplayKey(env, identity.replayKey, identity.authDate + Math.min(Math.max(maxAgeSeconds, 60), 900))) {
      return json({ error: "telegram_auth_replayed" }, 409);
    }
    const ttlSeconds = Math.min(Math.max(Number(env.TG_MINIAPP_SESSION_TTL_SECONDS) || 900, 300), 1800);
    const { session, token } = await createMiniAppSession(identity.userId, sessionSecret, ttlSeconds);
    return json({ ok: true, expiresAt: session.expiresAt }, 201, { "set-cookie": miniAppSessionCookie(token, ttlSeconds) });
  }

  if (request.method === "DELETE" && url.pathname === "/api/miniapp/session") {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    return json({ ok: true }, 200, { "set-cookie": clearMiniAppSessionCookie() });
  }

  if (request.method === "GET" && url.pathname === "/api/miniapp/bootstrap") {
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    const rawScope = url.searchParams.get("scope") || "full";
    if (!MINIAPP_PROJECTION_SCOPES.includes(rawScope as MiniAppProjectionScope)) return json({ error: "invalid_projection_scope" }, 400);
    const startedAt = performance.now();
    const payload = await bootstrap(
      env,
      session.userId,
      await miniAppCsrfToken(session, secret),
      await miniAppSessionLocator(session, secret),
      rawScope as MiniAppProjectionScope,
    );
    return json(payload, 200, { "server-timing": `miniapp-${rawScope};dur=${(performance.now() - startedAt).toFixed(1)}` });
  }

  if (request.method === "GET" && url.pathname === "/api/miniapp/health") {
    const session = await authorizeMiniAppSession(request, env);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!healthEnabled(env)) return json({ error: "health_disabled" }, 404);
    const range = url.searchParams.get("range") === "30" ? 30 : 7;
    const rawGroup = url.searchParams.get("group") || undefined;
    const group = rawGroup && ["activity", "sleep", "cardio", "body", "mobility", "respiratory", "vitals", "nutrition", "lifestyle", "environment", "other"].includes(rawGroup)
      ? rawGroup as import("../health/types").HealthMetricGroup
      : undefined;
    return json(await getHealthProjection(env, range, group));
  }

  if (request.method === "GET" && url.pathname === "/api/miniapp/models") {
    const session = await authorizeMiniAppSession(request, env);
    if (!session) return json({ error: "unauthorized" }, 401);
    try {
      return json(await searchTgWorkersAiModels(env, url.searchParams.get("search") || ""));
    } catch (error) {
      console.error("miniapp model catalog failed", { error: String(error).slice(0, 160) });
      return json({ error: "model_catalog_unavailable" }, 503);
    }
  }

  if (request.method === "PATCH" && url.pathname === "/api/miniapp/settings/model-route") {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    const scope = session ? ownerScope(env, session.userId) : null;
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) return json({ error: "csrf_denied" }, 403);
    if (!scope) return json({ error: "owner_scope_denied" }, 403);
    const body = await readBoundedJsonObject(request, 4_000);
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    const reset = body?.action === "reset";
    if (body?.route !== "chat" || (!reset && !/^workers-ai\/@cf\/[A-Za-z0-9._/-]{3,180}$/.test(model))) {
      return json({ error: "invalid_model_route" }, 422);
    }
    try {
      const controls = reset
        ? await resetTgMemoryControl(env, scope.chatId, "memory.inference.chat_model")
        : await setTgMemoryControl(env, scope.chatId, "memory.inference.chat_model", model);
      return json({ ok: true, route: { id: "chat", model: controls.request.model, ownerDomain: controls.ownerDomain, ownerVersion: controls.ownerVersion } });
    } catch (error) {
      const status = String(error).includes("409") || String(error).includes("revision") ? 409 : 503;
      return json({ error: status === 409 ? "owner_revision_conflict" : "model_route_unavailable" }, status);
    }
  }

  if (request.method === "PATCH" && url.pathname === "/api/miniapp/settings/reasoning-presentation") {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    const scope = session ? ownerScope(env, session.userId) : null;
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) return json({ error: "csrf_denied" }, 403);
    if (!scope) return json({ error: "owner_scope_denied" }, 403);
    const body = await readBoundedJsonObject(request, 2_000);
    const mode = body?.mode;
    if (mode !== "on" && mode !== "off" && mode !== "once") return json({ error: "invalid_reasoning_presentation_mode" }, 422);
    if (mode === "once") await setTgSetting(env.DB, `reasoning_once:${scope.chatId}`, true);
    else await setTgSetting(env.DB, "reasoning_mode", mode === "on" ? "summary" : "off");
    return json({ ok: true, reasoningMode: await getTgSetting(env.DB, "reasoning_mode", "summary"), reasoningOnce: await getTgSetting(env.DB, `reasoning_once:${scope.chatId}`, false) });
  }

  if (request.method === "PUT" && url.pathname === "/api/miniapp/settings/voice") {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    const scope = session ? ownerScope(env, session.userId) : null;
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) return json({ error: "csrf_denied" }, 403);
    if (!scope) return json({ error: "owner_scope_denied" }, 403);
    const body = await readBoundedJsonObject(request, 2_000);
    const mode = body?.mode === "off" || body?.mode === "once" || body?.mode === "auto" ? body.mode : null;
    if (!mode || !["realtime", "quality", "expressive"].includes(String(body?.model || ""))) return json({ error: "invalid_voice_setting" }, 422);
    await setVoiceMode(env.DB, scope.chatId, mode, normalizeVoiceModel(body?.model));
    const readback = await getChatConfig(env.DB, scope.chatId);
    return json({ ok: true, ownerDomain: "tgbot.example.com", mode: readback.voiceOnce ? "once" : readback.voicePolicy, model: readback.voiceModel });
  }

  if (request.method === "PUT" && url.pathname === "/api/miniapp/settings/heartbeat") {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    const scope = session ? ownerScope(env, session.userId) : null;
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) return json({ error: "csrf_denied" }, 403);
    if (!scope) return json({ error: "owner_scope_denied" }, 403);
    const body = await readBoundedJsonObject(request, 20_000);
    if (!body || !Number.isSafeInteger(Number(body.revision)) || !body.config || typeof body.config !== "object" || Array.isArray(body.config)) {
      return json({ error: "invalid_heartbeat_setting" }, 422);
    }
    try {
      return json(await updateAgentHeartbeatConfig(env, {
        ...scope,revision:Number(body.revision),config:body.config as Record<string, unknown>,
      }));
    } catch (error) {
      const status = Number(/agent_http_(\d+)/.exec(String(error))?.[1] || 503);
      return json({ error: status === 409 ? "owner_revision_conflict" : "heartbeat_setting_unavailable" }, status);
    }
  }

  const skillSettingMatch = /^\/api\/miniapp\/settings\/skills\/([A-Za-z0-9._:-]{1,160})$/.exec(url.pathname);
  if (request.method === "PUT" && skillSettingMatch) {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    const scope = session ? ownerScope(env, session.userId) : null;
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) return json({ error: "csrf_denied" }, 403);
    if (!scope) return json({ error: "owner_scope_denied" }, 403);
    const body = await readBoundedJsonObject(request, 2_000);
    if (!body || typeof body.enabled !== "boolean" || !Number.isSafeInteger(Number(body.revision))) return json({ error: "invalid_skill_setting" }, 422);
    try {
      return json(await updateAgentSkillInstallation(env, {
        ...scope,skillKey:skillSettingMatch[1],revision:Number(body.revision),enabled:body.enabled,
      }));
    } catch (error) {
      const status = Number(/agent_http_(\d+)/.exec(String(error))?.[1] || 503);
      return json({ error: status === 409 ? "owner_revision_conflict" : "skill_setting_unavailable" }, status);
    }
  }

  const capabilitySettingMatch = /^\/api\/miniapp\/settings\/capabilities\/([A-Za-z0-9._:-]{1,160})$/.exec(url.pathname);
  if (request.method === "PATCH" && capabilitySettingMatch) {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    const scope = session ? ownerScope(env, session.userId) : null;
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) return json({ error: "csrf_denied" }, 403);
    if (!scope) return json({ error: "owner_scope_denied" }, 403);
    const body = await readBoundedJsonObject(request, 2_000);
    if (body?.status !== "disabled" || !Number.isSafeInteger(Number(body.revision)) || Number(body.revision) < 0) {
      return json({ error: "invalid_capability_setting" }, 422);
    }
    try {
      return json(await updateAgentCapability(env, {
        ...scope,capabilityId:capabilitySettingMatch[1],revision:Number(body.revision),status:body.status,
      }));
    } catch (error) {
      const status = Number(/agent_http_(\d+)/.exec(String(error))?.[1] || 503);
      return json({ error: status === 409 ? "owner_revision_conflict" : "capability_setting_unavailable" }, status);
    }
  }

  const memoryPresentationMatch = /^\/api\/miniapp\/memory\/([A-Za-z0-9._:-]{1,200})\/presentation$/.exec(url.pathname);
  if (request.method === "PATCH" && memoryPresentationMatch) {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) {
      return json({ error: "csrf_denied" }, 403);
    }
    if (!ownerScope(env, session.userId)) return json({ error: "owner_scope_denied" }, 403);
    const body = await readBoundedJsonObject(request, 4_000);
    const revision = Number(body?.revision);
    const hasStarred = typeof body?.starred === "boolean";
    const hasDisplayPinned = typeof body?.displayPinned === "boolean";
    if (!body || !Number.isSafeInteger(revision) || revision < 1 || (!hasStarred && !hasDisplayPinned)) {
      return json({ error: "invalid_memory_presentation_mutation" }, 422);
    }
    try {
      return json(await updateMiniAppMemoryPresentation(env, {
        id: memoryPresentationMatch[1],
        revision,
        ...(hasStarred ? { starred: body.starred as boolean } : {}),
        ...(hasDisplayPinned ? { displayPinned: body.displayPinned as boolean } : {}),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "memory_presentation_unavailable";
      const status = message.includes("412") || message.includes("revision") ? 409 : 503;
      return json({ error: status === 409 ? "memory_revision_conflict" : "memory_presentation_unavailable" }, status);
    }
  }

  const noteItemMatch = /^\/api\/miniapp\/notes\/([A-Za-z0-9._:-]{1,200})(?:\/(convert|complete|reopen|reorder|delete|restore))?$/.exec(url.pathname);
  const isNoteMutation = (request.method === "POST" && url.pathname === "/api/miniapp/notes")
    || Boolean(noteItemMatch && ["POST", "PATCH", "DELETE"].includes(request.method));
  if (isNoteMutation) {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) {
      return json({ error: "csrf_denied" }, 403);
    }
    if (!ownerScope(env, session.userId)) return json({ error: "owner_scope_denied" }, 403);
    const binding = noteBinding(env);
    if (!binding) return json({ error: "note_not_configured" }, 503);
    const body = await readBoundedJsonObject(request, 220_000);
    if (!body) return json({ error: "invalid_request" }, 400);
    try {
      if (!noteItemMatch) {
        const kind = body.kind === "todo" ? "todo" : body.kind === "memo" ? "memo" : null;
        if (!kind || typeof body.markdown !== "string") return json({ error: "note_content_invalid" }, 422);
        const id = actionId("note");
        return json(await executeNoteAction(binding, {
          path: "/service/note/items",
          method: "POST",
          contract: noteActionContract({ ownerId: binding.ownerId }, "note.create", id, null),
          body: { kind, markdown: body.markdown, dueAt: body.dueAt ?? null },
        }), 201);
      }
      const id = noteItemMatch[1];
      const action = noteItemMatch[2] || "update";
      const revision = Number(body.revision);
      if (!Number.isSafeInteger(revision) || revision < 1) return json({ error: "note_revision_required" }, 422);
      const operation = `note.${action}`;
      const method = action === "update" ? "PATCH" : action === "delete" ? "DELETE" : "POST";
      const payload: Record<string, unknown> = {};
      if (action === "update") {
        if (typeof body.markdown !== "string") return json({ error: "note_content_invalid" }, 422);
        payload.markdown = body.markdown;
        if (body.dueAt === null || typeof body.dueAt === "string") payload.dueAt = body.dueAt;
      } else if (action === "convert") {
        if (body.kind !== "memo" && body.kind !== "todo") return json({ error: "note_kind_invalid" }, 422);
        payload.kind = body.kind;
      } else if (action === "reorder") {
        if (!Number.isSafeInteger(Number(body.position))) return json({ error: "todo_position_invalid" }, 422);
        payload.position = Number(body.position);
      }
      return json(await executeNoteAction(binding, {
        path: `/service/note/items/${encodeURIComponent(id)}${action === "update" ? "" : `/${action}`}`,
        method,
        expectedRevision: revision,
        contract: noteActionContract({ ownerId: binding.ownerId }, operation, id, revision),
        body: payload,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "note_action_unavailable";
      const status = message.includes("revision_conflict") ? 409 : message.includes("not_found") ? 404 : 503;
      return json({ error: status === 409 ? "note_revision_conflict" : message.slice(0, 160) }, status);
    }
  }

  const roomWakeMatch = /^\/api\/miniapp\/workgroup\/rooms\/(room_[a-f0-9]{32})\/wake$/.exec(url.pathname);
  const roomSummaryMatch = /^\/api\/miniapp\/workgroup\/rooms\/(room_[a-f0-9]{32})\/summary$/.exec(url.pathname);
  const roomPinMatch = /^\/api\/miniapp\/workgroup\/rooms\/(room_[a-f0-9]{32})\/pin$/.exec(url.pathname);
  const isRoomMutation = Boolean(
    (request.method === "PATCH" && (roomWakeMatch || roomSummaryMatch))
    || (request.method === "PUT" && roomPinMatch)
  );
  if (isRoomMutation) {
    if (!operationsEnabled(env)) return json({ error: "miniapp_operations_disabled" }, 404);
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) {
      return json({ error: "csrf_denied" }, 403);
    }
    if (!ownerScope(env, session.userId)) return json({ error: "owner_scope_denied" }, 403);
    const body = await readBoundedJsonObject(request, 8_000);
    if (!body) return json({ error: "invalid_request" }, 400);
    const roomId = (roomWakeMatch || roomSummaryMatch || roomPinMatch)?.[1] || "";
    try {
      if (roomWakeMatch) {
        const wakePolicy = body.wakePolicy === "off" || body.wakePolicy === "mention_or_reply"
          ? body.wakePolicy
          : null;
        if (!wakePolicy || !Number.isInteger(Number(body.revision))) {
          return json({ error: "invalid_room_wake_mutation" }, 422);
        }
        await setAgentRoomWakePolicy(env, {
          roomId,
          wakePolicy,
          revision: Number(body.revision),
        }, session.userId);
      } else if (roomSummaryMatch) {
        const mode = body.mode === "off" || body.mode === "active" ? body.mode : null;
        if (!mode || !Number.isInteger(Number(body.revision))) {
          return json({ error: "invalid_room_summary_mutation" }, 422);
        }
        await setRoomSummaryMode(env, {
          roomId,
          mode,
          revision: Number(body.revision),
        }, session.userId);
      } else {
        if (typeof body.text !== "string" || !Number.isInteger(Number(body.revision))) {
          return json({ error: "invalid_room_pin_mutation" }, 422);
        }
        await setRoomOwnerPin(env, {
          roomId,
          text: body.text,
          revision: Number(body.revision),
        }, session.userId);
      }
      return json({ ok: true, room: await getAgentRoomProjection(env, roomId) });
    } catch (error) {
      const message = String(error);
      const status = message.includes("revision_conflict") ? 409
        : message.includes("owner_required") ? 403
          : message.includes("not_found") ? 404
            : 422;
      return json({ error: status === 409 ? "owner_revision_conflict" : message.slice(0, 160) }, status);
    }
  }

  const taskControlMatch = /^\/api\/miniapp\/operations\/tasks\/([A-Za-z0-9_-]{1,128})\/control$/.exec(url.pathname);
  const elicitationDecisionMatch = /^\/api\/miniapp\/operations\/elicitations\/([A-Za-z0-9_-]{1,128})\/decision$/.exec(url.pathname);
  const isOperationsMutation = request.method === "POST" && Boolean(
    taskControlMatch || elicitationDecisionMatch || url.pathname === "/api/miniapp/operations/mcp/tools"
  );
  if (isOperationsMutation) {
    if (!operationsEnabled(env)) return json({ error: "miniapp_operations_disabled" }, 404);
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) return json({ error: "csrf_denied" }, 403);
    const scope = ownerScope(env, session.userId);
    if (!scope) return json({ error: "owner_scope_denied" }, 403);
    const body = await readBoundedJsonObject(request, 8_000);
    if (!body) return json({ error: "invalid_request" }, 400);

    try {
      if (taskControlMatch) {
        const action = body.action === "pause" || body.action === "resume" || body.action === "stop" ? body.action : null;
        if (!action) return json({ error: "invalid_task_action" }, 422);
        return json({ ok: true, snapshot: await controlAgentTask(env, taskControlMatch[1], action, scope) }, 202);
      }
      if (elicitationDecisionMatch) {
        const action = body.action === "accept" || body.action === "decline" || body.action === "cancel" ? body.action : null;
        if (!action) return json({ error: "invalid_elicitation_action" }, 422);
        const result = await forwardMcpElicitationDecision(env, { ticketId: elicitationDecisionMatch[1], action, ...scope });
        return json(result, result.status);
      }
      const provider = typeof body.provider === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(body.provider) ? body.provider : null;
      const tool = typeof body.tool === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(body.tool) ? body.tool : null;
      const etag = typeof body.etag === "string" && body.etag.length <= 200 ? body.etag : null;
      if (!provider || !tool || !etag || typeof body.enabled !== "boolean") return json({ error: "invalid_mcp_mutation" }, 422);
      return json(await updateAgentMcpTool(env, { ...scope, provider, tool, etag, enabled: body.enabled }), 200);
    } catch (error) {
      const status = Number(/agent_(?:task_)?http_(\d+)/.exec(String(error))?.[1] || 503);
      return json({ error: status === 409 ? "owner_revision_conflict" : "owner_action_unavailable" }, status);
    }
  }

  const calendarEventMatch = /^\/api\/miniapp\/calendar\/events\/([A-Za-z0-9_-]{5,1024})$/.exec(url.pathname);
  const isCalendarMutation = (request.method === "POST" && url.pathname === "/api/miniapp/calendar/events")
    || Boolean(calendarEventMatch && (request.method === "PATCH" || request.method === "DELETE"));
  if (isCalendarMutation) {
    if (!calendarWriteEnabled(env)) return json({ error: "calendar_write_disabled" }, 404);
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) return json({ error: "csrf_denied" }, 403);
    if (!ownerScope(env, session.userId)) return json({ error: "owner_scope_denied" }, 403);
    const body = await readBoundedJsonObject(request, 16_000);
    if (!body) return json({ error: "invalid_request" }, 400);
    const action = request.method === "POST" ? "create" : request.method === "DELETE" ? "delete"
      : body.move === true ? "move" : "update";
    const patch = action === "delete" ? {} : body.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return json({ error: "calendar_patch_invalid" }, 422);
    try {
      const result = await mutateCalendar(env, session.userId, {
        requestId: actionId("calreq"),
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : actionId("calidem"),
        action,
        ...(calendarEventMatch ? { eventId: calendarEventMatch[1] } : {}),
        ...(body.recurrenceScope === "series" || body.recurrenceScope === "instance" ? { recurrenceScope: body.recurrenceScope } : {}),
        expected: {
          ...(typeof body.googleEtag === "string" ? { googleEtag: body.googleEtag } : {}),
          ...(Number.isSafeInteger(Number(body.ownerRevision)) ? { ownerRevision: Number(body.ownerRevision) } : {}),
        },
        patch: patch as Record<string, unknown>,
      });
      return json(result, action === "create" ? 201 : 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "calendar_mutation_unavailable";
      const status = message.includes("conflict") || message.includes("reauthorization") || message.includes("expected_state") ? 409
        : message.includes("not_found") ? 404 : 503;
      return json({ error: message.slice(0, 160) }, status);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/miniapp/calendar/connect") {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) return json({ error: "csrf_denied" }, 403);
    if (!calendarEnabled(env)) return json({ error: "calendar_disabled" }, 404);
    return json(await createCalendarConnectLink(env, session.userId), 201);
  }

  if (request.method === "DELETE" && url.pathname === "/api/miniapp/calendar/connection") {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) return json({ error: "csrf_denied" }, 403);
    return json(await disconnectCalendar(env, session.userId));
  }

  if (url.pathname === "/api/miniapp/artifacts" && request.method === "GET") {
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!artifactsEnabled(env)) return json({ error: "artifacts_disabled" }, 404);
    const result = await listAgentHtmlArtifacts(env, url.searchParams.get("after") || undefined);
    const locator = await miniAppSessionLocator(session, secret);
    return json({
      ...result,
      autoOpenArtifactId: result.artifacts.find((artifact) => artifact.status === "ready" && artifact.correlation?.sessionId === locator)?.artifactId ?? null,
    });
  }

  const detailMatch = /^\/api\/miniapp\/artifacts\/(art_[a-f0-9]{24})$/.exec(url.pathname);
  if (detailMatch && request.method === "GET") {
    const session = await authorizeMiniAppSession(request, env);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!artifactsEnabled(env)) return json({ error: "artifacts_disabled" }, 404);
    return json(await getAgentHtmlArtifact(env, detailMatch[1]));
  }

  const bundleMatch = /^\/api\/miniapp\/artifacts\/(art_[a-f0-9]{24})\/versions\/(\d+)\/bundle$/.exec(url.pathname);
  if (bundleMatch && request.method === "GET") {
    const session = await authorizeMiniAppSession(request, env);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!artifactsEnabled(env)) return json({ error: "artifacts_disabled" }, 404);
    const upstream = await readAgentHtmlArtifactBundle(env, bundleMatch[1], Number(bundleMatch[2]));
    if (!upstream.ok) return json({ error: `artifact_bundle_${upstream.status}` }, upstream.status);
    return new Response(upstream.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "frame-ancestors 'self'",
        "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-artifact-content-hash": upstream.headers.get("x-artifact-content-hash") || "",
      },
    });
  }

  const stateMatch = /^\/api\/miniapp\/artifacts\/(art_[a-f0-9]{24})\/versions\/(\d+)\/state$/.exec(url.pathname);
  if (stateMatch && request.method === "POST") {
    if (!isSameOrigin(request)) return json({ error: "origin_denied" }, 403);
    const session = await authorizeMiniAppSession(request, env);
    const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
    if (!session || !secret) return json({ error: "unauthorized" }, 401);
    if (!await validateMiniAppCsrfToken(session, secret, request.headers.get("x-miniapp-csrf"))) return json({ error: "csrf_denied" }, 403);
    if (!artifactsEnabled(env)) return json({ error: "artifacts_disabled" }, 404);
    const body = await readBoundedJsonObject(request);
    if (!body || !Number.isSafeInteger(Number(body.revision))) return json({ error: "invalid_request" }, 400);
    return json(await saveAgentHtmlArtifactState(env, stateMatch[1], Number(stateMatch[2]), Number(body.revision), body.value));
  }

  return json({ error: "not_found" }, 404);
}
