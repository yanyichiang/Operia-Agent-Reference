import type { Env } from "../types";
import { nowIso } from "../utils/time";
import { authorizeTgAdminRead, authorizeTgDomainSession, authorizeTgMutation, getAdminCsrfToken } from "./adminAuth";
import { MENU_COMMANDS, TG_MODELS, buildBotFatherCommands, compatibilityCommands, displayCommandName } from "./commands";
import { getChatConfig, getTgSetting, normalizeVoiceModel, setChatModel, setTgSetting, setVoiceMode } from "./settings";
import { syncBotCommands } from "./telegram";
import { getAgentControlProjection, getAgentHeartbeatProjection, getAgentMcpControl, getAgentReasoningTrace, getAgentRuntimeSnapshot, updateAgentMcpTool } from "./agentClient";
import { CONTROL_TOPOLOGY, controlDefinitionsFor, controlManifestFor, controlNavigationLinks, staticControlValue } from "../controlRegistry";
import { getTgMemoryControls, resetTgMemoryControl, setTgMemoryControl } from "./memoryControlClient";
import { getConversationState, resetConversationState } from "./conversationClient";
import { addAgentToRoom, agentRoomsEnabled, createAgentRoom, listAgentRooms, setAgentRoomWakePolicy, setRoomAgentStatus } from "./agentRooms";
import { getAgentRoomProjection, listAgentRoomProjections } from "./roomProjection";
import { setRoomOwnerPin, setRoomSummaryMode } from "./roomSharedState";
import { listOpenTgAttention } from "./attention";

async function agentSnapshot(env: Env): Promise<unknown> {
  if (!env.AGENT_SERVICE) return { configured: false, capabilities: [], summary: { enabled: 0, disabled: 0 } };
  return getAgentRuntimeSnapshot(env);
}

const REASONING_MODES = ["off", "summary", "debug_trace"] as const;

async function usageSnapshot(env: Env) {
  const usage = await env.DB.prepare(`SELECT u.created_at,u.model,u.service_tier,u.ttft_ms,u.total_ms,
    u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_creation_tokens
    FROM usage_logs u JOIN messages m ON m.id=u.message_id
    WHERE m.source='telegram' ORDER BY u.created_at DESC LIMIT 30`).all<{
      created_at: string; model: string; service_tier: string | null; ttft_ms: number | null; total_ms: number | null;
      input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_creation_tokens: number | null;
    }>();
  return { usage: (usage.results || []).map((row) => ({
    createdAt: row.created_at, model: row.model, serviceTier: row.service_tier,
    ttftMs: row.ttft_ms, totalMs: row.total_ms, inputTokens: row.input_tokens,
    outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens,
    cacheCreateTokens: row.cache_creation_tokens,
  })), costSummary: {
    label: "费用摘要入口",
    status: "账单来源待接入",
    description: "Usage 明细仅展示请求指标；费用需要 Agent/provider 账单摘要 API 提供可核验来源。",
  } };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try { return await request.json<Record<string, unknown>>(); } catch { return {}; }
}

async function chatId(env: Env): Promise<string> {
  return (env.TG_ALLOWED_CHAT_IDS || "").split(",").map((id) => id.trim()).filter(Boolean)[0] || "";
}

async function controlLinks(env: Env) {
  void env;
  return controlNavigationLinks();
}

async function overview(env: Env) {
  const owner = await chatId(env);
  const [pending, events, session, outbox, continuations,openAttention] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM tg_inbox WHERE processed = 0").first<{ count: number }>(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM tg_events WHERE created_at >= datetime('now', '-24 hours') GROUP BY status").all<{ status: string; count: number }>(),
    owner ? getConversationState(env, owner).catch(() => null) : null,
    env.DB.prepare("SELECT status,COUNT(*) AS count FROM tg_agent_outbox GROUP BY status").all<{ status: string; count: number }>(),
    env.DB.prepare("SELECT status,COUNT(*) AS count FROM tg_agent_continuations GROUP BY status").all<{ status: string; count: number }>(),
    listOpenTgAttention(env.DB,100),
  ]);
  const status = Object.fromEntries((events.results || []).map((row) => [row.status, row.count]));
  const outboxStatus = Object.fromEntries((outbox.results || []).map((row) => [row.status, row.count]));
  const continuationStatus = Object.fromEntries((continuations.results || []).map((row) => [row.status, row.count]));
  const processing = ["waiting_agent", "approval_required", "round_transition", "outbox_pending", "leased", "operia_calling"]
    .reduce((total, key) => total + Number(continuationStatus[key] || 0), 0) + Number(outboxStatus.pending || 0) + Number(outboxStatus.leased || 0) + Number(outboxStatus.sending || 0);
  const attention = openAttention.length + Number(continuationStatus.attention_required || 0);
  return {
    lanes: [
      { id: "incoming", title: "消息入口", count: pending?.count || 0, note: "等待合并处理的 Telegram 消息" },
      { id: "processing", title: "处理中", count: processing, note: "当前 Agent continuation 与媒体投递" },
      { id: "attention", title: "需要关注", count: attention, note: "仅统计尚未解决并已去重的 Attention" },
      { id: "completed", title: "已完成", count: Number(status.ok || 0) + Number(status.completed || 0) + Number(outboxStatus.sent || 0), note: "过去 24 小时事件与已发送媒体" }
    ],
    activeSessions: session && (session.updatedAt || session.summary || session.recent.length > 0) ? 1 : 0,
    generatedAt: nowIso()
  };
}

async function operationsSnapshot(env: Env, id: string) {
  const [agent, voice, outbox, attention, legacyContinuationAttention, toolRuns] = await Promise.all([
    agentSnapshot(env),
    id ? getChatConfig(env.DB, id) : null,
    env.DB.prepare(`SELECT id,status,attempts,last_error,updated_at,
      COALESCE(json_extract(payload_json,'$.method'),'sendMessage') AS method
      FROM tg_agent_outbox ORDER BY updated_at DESC LIMIT 30`).all(),
    listOpenTgAttention(env.DB,30),
    env.DB.prepare(`SELECT id,tool_name,status,round,attempts,last_error,updated_at
      FROM tg_agent_continuations WHERE status='attention_required' ORDER BY updated_at DESC LIMIT 30`).all(),
    env.DB.prepare(`SELECT status,metadata_json,created_at FROM tg_events
      WHERE event_type='tool.lifecycle' ORDER BY id DESC LIMIT 30`).all(),
  ]);
  return {
    voice: voice ? { mode: voice.voiceOnce ? "once" : voice.voicePolicy, policy: voice.voicePolicy, once: voice.voiceOnce, model: voice.voiceModel, enabled: env.VOICE_ENABLED?.trim().toLowerCase() === "true" } : null,
    agent,
    mediaOutbox: outbox.results || [],
    attention: [
      ...attention,
      ...(legacyContinuationAttention.results || []),
    ],
    toolRuns: (toolRuns.results || []).map((row: Record<string, unknown>) => {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(String(row.metadata_json || "{}")) as Record<string, unknown>; } catch { /* redacted empty metadata */ }
      return { ...metadata, status: row.status, createdAt: row.created_at };
    }),
    tgLimits: { maxMediaBytes: Math.max(1, Math.min(25 * 1024 * 1024, Number(env.TG_MEDIA_MAX_BYTES) || 20 * 1024 * 1024)) },
  };
}

export async function handleTgAdminApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const mutation = !["GET", "HEAD"].includes(request.method);
  if (mutation ? !await authorizeTgMutation(request, env) : !await authorizeTgAdminRead(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }
  const id = await chatId(env);

  if (request.method === "GET" && url.pathname === "/api/tg/bootstrap") {
    if (!await authorizeTgDomainSession(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }
    return json({ csrfToken: await getAdminCsrfToken(request, env), overview: await overview(env), links: await controlLinks(env), manifest: controlManifestFor("tgbot.example.com") });
  }
  if (request.method === "GET" && url.pathname === "/api/tg/overview") return json(await overview(env));
  if(request.method==="GET"&&url.pathname==="/api/tg/rooms") {
    return json({enabled:agentRoomsEnabled(env),rooms:await listAgentRoomProjections(env)});
  }
  if(request.method==="POST"&&url.pathname==="/api/tg/rooms"){
    const body=await readJson(request);
    try{return json({ok:true,room:await createAgentRoom(env,{chatId:body.chatId,ownerUserId:body.ownerUserId,threadId:body.threadId})},201);}
    catch(error){const message=String(error);return json({error:message.slice(0,180)},message.includes("UNIQUE")?409:422);}
  }
  if(request.method==="POST"&&url.pathname==="/api/tg/room-agents"){
    const body=await readJson(request);
    const room=(await listAgentRooms(env.DB)).find((candidate)=>candidate.id===String(body.roomId||""));
    if(!room)return json({error:"room_not_found"},404);
    try{return json({ok:true,agent:await addAgentToRoom(env,{roomId:body.roomId,botUserId:body.botUserId,botName:body.botName,runtimeKind:body.runtimeKind,revision:body.revision},room.owner_user_id)},201);}
    catch(error){const message=String(error);return json({error:message.slice(0,180)},message.includes("revision_conflict")||message.includes("UNIQUE")?409:422);}
  }
  if(request.method==="PATCH"&&url.pathname==="/api/tg/room-agents"){
    const body=await readJson(request);
    const room=(await listAgentRooms(env.DB)).find((candidate)=>candidate.id===String(body.roomId||""));
    if(!room)return json({error:"room_not_found"},404);
    try{await setRoomAgentStatus(env,{roomId:body.roomId,botUserId:body.botUserId,status:body.status,revision:body.revision},room.owner_user_id);return json({ok:true});}
    catch(error){const message=String(error);return json({error:message.slice(0,180)},message.includes("revision_conflict")?409:422);}
  }
  if(request.method==="PATCH"&&url.pathname==="/api/tg/rooms/wake"){
    const body=await readJson(request);
    const room=(await listAgentRooms(env.DB)).find((candidate)=>candidate.id===String(body.roomId||""));
    if(!room)return json({error:"room_not_found"},404);
    try{return json({ok:true,room:await setAgentRoomWakePolicy(env,{roomId:body.roomId,wakePolicy:body.wakePolicy,revision:body.revision},room.owner_user_id)});}
    catch(error){const message=String(error);return json({error:message.slice(0,180)},message.includes("revision_conflict")?409:422);}
  }
  if(request.method==="PATCH"&&url.pathname==="/api/tg/rooms/summary"){
    const body=await readJson(request);
    const room=(await listAgentRooms(env.DB)).find((candidate)=>candidate.id===String(body.roomId||""));
    if(!room)return json({error:"room_not_found"},404);
    try{
      await setRoomSummaryMode(env,{
        roomId:room.id,mode:String(body.mode||""),revision:Number(body.revision),
      },room.owner_user_id);
      return json({ok:true,room:await getAgentRoomProjection(env,room.id)});
    }catch(error){
      const message=String(error);
      return json({error:message.slice(0,180)},message.includes("revision_conflict")?409:422);
    }
  }
  if(request.method==="PUT"&&url.pathname==="/api/tg/rooms/pin"){
    const body=await readJson(request);
    const room=(await listAgentRooms(env.DB)).find((candidate)=>candidate.id===String(body.roomId||""));
    if(!room)return json({error:"room_not_found"},404);
    try{
      await setRoomOwnerPin(env,{
        roomId:room.id,text:String(body.text??""),revision:Number(body.revision),
      },room.owner_user_id);
      return json({ok:true,room:await getAgentRoomProjection(env,room.id)});
    }catch(error){
      const message=String(error);
      return json({error:message.slice(0,180)},message.includes("revision_conflict")?409:422);
    }
  }
  if (request.method === "GET" && url.pathname === "/api/tg/heartbeat") {
    return json(env.AGENT_SERVICE ? await getAgentHeartbeatProjection(env) : { status: "unavailable" });
  }
  if (request.method === "GET" && url.pathname === "/api/tg/commands") {
    const menuCommands = MENU_COMMANDS.map(([command, description]) => ({ command, displayCommand: displayCommandName(command), description }));
    const hiddenCommands = compatibilityCommands().map((definition) => ({
      command: definition.command,
      displayCommand: displayCommandName(definition.command),
      canonicalCommand: definition.canonicalCommand,
      argsPrefix: definition.argsPrefix ?? "",
      emptyArgs: definition.emptyArgs ?? definition.argsPrefix ?? "",
      description: definition.description,
    }));
    return json({
      commands: menuCommands,
      menuCommands,
      compatibilityCommands: hiddenCommands,
      catalogPolicy: "BotFather 只同步固定入口；动态 tool/skill catalog 只通过 owner-only Agent Service Binding 查询。",
    });
  }
  if (request.method === "POST" && url.pathname === "/api/tg/commands/sync") {
    if (!id) return json({ error: "telegram owner chat is not configured" }, 409);
    const result = await syncBotCommands(env, buildBotFatherCommands(), id);
    return json({
      ok: true,
      verifiedCount: result.verifiedCount,
      verifiedTargets: result.verifiedTargets,
      bot: result.bot,
      webhook: result.webhook,
      menuButton: result.menuButton,
      syncedAt: nowIso(),
    });
  }
  if (request.method === "GET" && url.pathname === "/api/tg/models") {
    return json({ models: TG_MODELS, selected: id ? (await getChatConfig(env.DB, id)).model : "companion" });
  }
  if (request.method === "PUT" && url.pathname === "/api/tg/model") {
    const body = await readJson(request);
    const model = String(body.model || "");
    if (!id || !TG_MODELS.includes(model as typeof TG_MODELS[number])) return json({ error: "invalid model" }, 400);
    await setChatModel(env.DB, id, model);
    return json({ ok: true, model });
  }
  if (request.method === "GET" && url.pathname === "/api/tg/session") {
    const state = id ? await getConversationState(env, id) : null;
    return json({ configured: Boolean(id), state: state ? {
      updated_at: state.updatedAt ?? null,
      summary_chars: state.summary.length,
      recent_turns: state.recent.length,
      recent_bytes: JSON.stringify(state.recent).length,
      owner: "memory",
    } : null });
  }
  if (request.method === "POST" && url.pathname === "/api/tg/session/reset") {
    if (!id) return json({ error: "chat not configured" }, 409);
    await resetConversationState(env, id);
    return json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/tg/events") {
    const result = await env.DB.prepare("SELECT id, event_type, status, metadata_json, created_at FROM tg_events ORDER BY id DESC LIMIT 50").all();
    return json({ events: result.results || [] });
  }
  if (request.method === "GET" && url.pathname === "/api/tg/security") {
    return json({ webhookSecret: Boolean(env.TG_WEBHOOK_SECRET), chatAllowlist: Boolean(id), botToken: Boolean(env.TG_BOT_TOKEN), domainSession: Boolean(env.OPERIA_SESSION_SECRET), agentService: Boolean(env.AGENT_SERVICE && env.AGENT_CONTEXT_SERVICE_BEARER) });
  }
  if (request.method === "GET" && url.pathname === "/api/tg/agent-capabilities") return json(await agentSnapshot(env));
  if (request.method === "GET" && url.pathname === "/api/tg/mcp") {
    try { return json(await getAgentMcpControl(env)); }
    catch (error) { return json({ error: String(error).slice(0, 180) }, 503); }
  }
  if (request.method === "PATCH" && url.pathname === "/api/tg/mcp/tools") {
    if (!id) return json({ error: "telegram owner chat is not configured" }, 409);
    const body = await readJson(request);
    const provider = typeof body.provider === "string" ? body.provider : "";
    const tool = typeof body.tool === "string" ? body.tool : "";
    const etag = request.headers.get("if-match")?.trim() || "";
    if (!provider || !tool || typeof body.enabled !== "boolean" || !etag) return json({ error: "invalid mcp tool mutation" }, 422);
    try {
      return json(await updateAgentMcpTool(env, {
        ownerId: env.TG_AGENT_OWNER_ID?.trim() || id,
        chatId: id,
        provider,
        tool,
        enabled: body.enabled,
        etag,
      }));
    } catch (error) {
      const message = String(error);
      return json({ error: message.slice(0, 180) }, message.includes("agent_http_412") ? 412 : 503);
    }
  }
  if (request.method === "GET" && url.pathname === "/api/tg/operations") return json(await operationsSnapshot(env, id));
  if (request.method === "PUT" && url.pathname === "/api/tg/voice") {
    if (!id) return json({ error: "chat not configured" }, 409);
    const body = await readJson(request);
    const requested = body.mode ?? body.policy;
    const mode = requested === "auto" || requested === "once" || requested === "off" ? requested : null;
    if (!mode) return json({ error: "invalid voice mode" }, 400);
    const model = normalizeVoiceModel(body.model);
    if (mode !== "off" && env.VOICE_ENABLED?.trim().toLowerCase() !== "true") return json({ error: "voice provider disabled" }, 409);
    await setVoiceMode(env.DB, id, mode, model);
    return json({ ok: true, mode, model });
  }
  if (request.method === "GET" && url.pathname === "/api/tg/usage") return json(await usageSnapshot(env));
  if (request.method === "GET" && url.pathname === "/api/tg/reasoning") {
    const mode = await getTgSetting(env.DB, "reasoning_mode", "off");
    const progressMode = await getTgSetting(env.DB, "telegram.presentation.task_progress_mode", "live");
    const expandableResponseStatus = await getTgSetting(env.DB, "telegram.presentation.expandable_response_status", true);
    const trace = mode === "debug_trace" ? await getAgentReasoningTrace(env) : { events: [] };
    let execution: unknown = { status: "unavailable" };
    let executionError: string | undefined;
    try { execution = id ? await getTgMemoryControls(env, id) : { status: "chat_not_configured" }; }
    catch (error) { executionError = String(error).slice(0, 120); execution = { status: "unavailable", error: executionError }; }
    return json({ mode, progressMode, expandableResponseStatus, summaries: [], execution, executionError, ...trace });
  }
  if (request.method === "PUT" && url.pathname === "/api/tg/reasoning") {
    const body = await readJson(request); const mode = String(body.mode || "");
    if (!REASONING_MODES.includes(mode as typeof REASONING_MODES[number])) return json({ error: "invalid reasoning mode" }, 400);
    await setTgSetting(env.DB, "reasoning_mode", mode);
    return json({ ok: true, mode });
  }
  if (request.method === "PUT" && url.pathname === "/api/tg/presentation") {
    const body = await readJson(request);
    if (body.progressMode !== undefined) {
      const mode = String(body.progressMode);
      if (!["live", "compact", "off"].includes(mode)) return json({ error: "invalid progress mode" }, 400);
      await setTgSetting(env.DB, "telegram.presentation.task_progress_mode", mode);
    }
    if (body.expandableResponseStatus !== undefined) {
      if (typeof body.expandableResponseStatus !== "boolean") return json({ error: "invalid response status mode" }, 400);
      await setTgSetting(env.DB, "telegram.presentation.expandable_response_status", body.expandableResponseStatus);
    }
    return json({ ok: true });
  }
  if (request.method === "PUT" && url.pathname === "/api/tg/reasoning-execution") {
    if (!id) return json({ error: "chat not configured" }, 409);
    const body = await readJson(request);
    const key = String(body.key || "");
    const allowed = ["memory.inference.reasoning.enabled", "memory.inference.reasoning.effort", "memory.inference.sampling.temperature"];
    if (!allowed.includes(key)) return json({ error: "invalid control key" }, 400);
    try {
      const snapshot = body.reset === true
        ? await resetTgMemoryControl(env, id, key)
        : await setTgMemoryControl(env, id, key, body.value);
      return json({ ok: true, snapshot });
    } catch (error) {
      const message = String(error);
      const status = message.includes("_409") ? 409 : message.includes("_422") ? 422 : 503;
      return json({ error: message.slice(0, 180) }, status);
    }
  }
  if (request.method === "GET" && url.pathname === "/api/tg/control-projection") {
    const config = id ? await getChatConfig(env.DB, id) : null;
    const reasoningMode = await getTgSetting(env.DB, "reasoning_mode", "off");
    const progressMode = await getTgSetting(env.DB, "telegram.presentation.task_progress_mode", "live");
    const responseStatus = await getTgSetting(env.DB, "telegram.presentation.expandable_response_status", true);
    return json({
      registryVersion: CONTROL_TOPOLOGY.registryVersion,
      definitions: controlDefinitionsFor("tgbot.example.com"),
      values: [
        { key: "telegram.presentation.reasoning_mode", current: staticControlValue("telegram.presentation.reasoning_mode", reasoningMode), source: "owner_store" },
        { key: "telegram.presentation.task_progress_mode", current: staticControlValue("telegram.presentation.task_progress_mode", progressMode), source: "owner_store" },
        { key: "telegram.presentation.expandable_response_status", current: staticControlValue("telegram.presentation.expandable_response_status", responseStatus), source: "owner_store" },
        { key: "telegram.voice.delivery_mode", current: staticControlValue("telegram.voice.delivery_mode", config ? (config.voiceOnce ? "once" : config.voicePolicy) : "off"), source: "owner_store" },
      ],
      inherited: env.AGENT_SERVICE ? await getAgentControlProjection(env) : { status: "unavailable" },
    });
  }
  if (request.method === "GET" && url.pathname === "/api/tg/control-links") return json({ links: await controlLinks(env) });
  if (request.method === "PUT" && url.pathname === "/api/tg/control-links") {
    return json({ error: "control_links_owned_by_topology_registry", owner: "ops.example.com" }, 409);
  }
  return json({ error: "not found" }, 404);
}
