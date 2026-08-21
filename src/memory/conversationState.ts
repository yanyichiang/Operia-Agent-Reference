import { authenticate } from "../auth/apiKey";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { nowIso } from "../utils/time";
import {
  assignRecentCacheEpochIds,
  buildCompactionEvents,
  buildCompactorResponseSchema,
  parseCompactorEnvelope,
  parseRecentTurns,
  parseSummaryEnvelope,
  planCacheAlignedConversationFold,
  projectConversationForTurn,
  LIVE_CONTEXT_MAX_AGE_MS,
  RECENT_CACHE_EPOCHS_TO_KEEP,
  RECENT_INJECT_MAX_BYTES,
  RECENT_INJECT_MAX_TURNS,
  sha256Hex,
  type CompactorParseDiagnostics,
  type ConversationRecentTurn,
  type ConversationState,
  type RollingSummaryEnvelopeV2,
} from "./conversationFreshness";
import { applyPublicationConversation } from "./publicationConversationConsumer";
import { readConversationEventPartMaterialization } from "./conversationEventParts";

export type { ConversationRecentTurn, ConversationState, ConversationProjection } from "./conversationFreshness";

const DEFAULT_FOLD_TRIGGER_TURNS = RECENT_INJECT_MAX_TURNS;
const DEFAULT_RECENT_KEEP_TURNS = 10;
const DEFAULT_RETRY_COOLDOWN_SECONDS = 900;
const SUMMARY_TARGET_CHARS = 1500;
const SUMMARY_MAX_INPUT_CHARS = 80_000;
const SUMMARY_MAX_OUTPUT_TOKENS = 2048;
export const SUMMARY_MAX_EVENTS_PER_FOLD = 8;

function integerSetting(value: string | undefined, fallback: number, minimum: number, maximum = 86_400): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.min(Math.floor(parsed), maximum);
}

function summaryText(response: OpenAIChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : content == null ? "" : JSON.stringify(content).trim();
}

export function planConversationFold<T extends { content?: unknown; role?: unknown }>(
  recent: T[],
  trigger: number,
  keep: number,
  maxBytes = RECENT_INJECT_MAX_BYTES,
): {
  shouldFold: boolean; evicted: T[]; kept: T[];
} {
  const recentBytes = recent.reduce((total, turn) =>
    total + (typeof turn.content === "string" ? new TextEncoder().encode(turn.content).byteLength : 0), 0);
  if (recent.length < trigger && recentBytes <= maxBytes) {
    return { shouldFold: false, evicted: [], kept: recent };
  }
  const keepCount = Math.max(1, Math.min(keep, recent.length - 1));
  const evicted=recent.slice(0,-keepCount);
  const kept=recent.slice(-keepCount);
  // A byte-only trigger can otherwise put the boundary between the user and
  // assistant halves of one canonical turn. Move the assistant half with its
  // owner message so compaction and the retained suffix both remain coherent.
  if (evicted.at(-1)?.role==="user" && kept[0]?.role==="assistant") {
    evicted.push(kept.shift()!);
  }
  return { shouldFold: true, evicted, kept };
}

function boundedFreshFoldPlan(
  evicted: ConversationRecentTurn[],
  kept: ConversationRecentTurn[],
  priorChars: number,
): { evicted: ConversationRecentTurn[]; kept: ConversationRecentTurn[]; partial: boolean } | null {
  let selectedCount = 0;
  let selectedChars = 0;
  while (selectedCount < evicted.length) {
    const first = evicted[selectedCount];
    const groupSize = first.role === "user" && evicted[selectedCount + 1]?.role === "assistant" ? 2 : 1;
    const group = evicted.slice(selectedCount, selectedCount + groupSize);
    const groupChars = group.reduce((total, turn) => total + turn.content.length, 0);
    if (selectedCount + group.length > SUMMARY_MAX_EVENTS_PER_FOLD) break;
    if (priorChars + selectedChars + groupChars > SUMMARY_MAX_INPUT_CHARS) break;
    selectedCount += group.length;
    selectedChars += groupChars;
  }
  if (selectedCount === 0) return null;
  return {
    evicted: evicted.slice(0, selectedCount),
    kept: [...evicted.slice(selectedCount), ...kept],
    partial: selectedCount < evicted.length,
  };
}

export async function readConversationState(db: D1Database, recipientId: string): Promise<ConversationState> {
  const row = await db.prepare(`SELECT s.summary,s.recent_json,s.updated_at,
      f.state_revision,f.summary_manifest_json
    FROM tg_chat_state s LEFT JOIN tg_chat_state_freshness f ON f.chat_id=s.chat_id
    WHERE s.chat_id=?`)
    .bind(recipientId).first<{ summary: string; recent_json: string; updated_at: string;
      state_revision: number | null; summary_manifest_json: string | null }>();
  if (!row) return { summary: "", recent: [], updatedAt: null };
  try {
    const recent = parseRecentTurns(JSON.parse(row.recent_json));
    let summaryEnvelope: RollingSummaryEnvelopeV2 | null = null;
    if (row.summary_manifest_json) summaryEnvelope = parseSummaryEnvelope(JSON.parse(row.summary_manifest_json));
    return { summary: row.summary || "", recent, summaryEnvelope,
      stateRevision: row.state_revision ?? 0, updatedAt: row.updated_at };
  } catch {
    console.warn("memory.conversation state contained invalid recent_json", { recipientId });
    return { summary: row.summary || "", recent: [], updatedAt: row.updated_at };
  }
}

const readState = readConversationState;

async function latestFoldAttempt(db: D1Database, recipientId: string): Promise<{
  status:string; createdAt:string; reason:string|null; stateRevision:number|null;
} | null> {
  const row = await db.prepare(`SELECT status,created_at,metadata_json FROM conversation_events
    WHERE channel='telegram' AND recipient_id=? AND event_type='summary.fold'
    ORDER BY id DESC LIMIT 1`).bind(recipientId).first<{
      status:string; created_at:string; metadata_json:string;
    }>();
  if (!row) return null;
  let reason:string|null=null;
  let stateRevision:number|null=null;
  try {
    const metadata=JSON.parse(row.metadata_json) as Record<string,unknown>;
    reason=typeof metadata.reason==="string"?metadata.reason:null;
    stateRevision=Number.isInteger(metadata.stateRevision)?Number(metadata.stateRevision):null;
  } catch {
    // Invalid metadata cannot be trusted to create a permanent retry block.
  }
  return {status:row.status,createdAt:row.created_at,reason,stateRevision};
}

async function latestFoldFailure(db: D1Database, recipientId: string): Promise<string | null> {
  const attempt=await latestFoldAttempt(db,recipientId);
  return attempt?.status==="failed"?attempt.createdAt:null;
}

function coolingDown(lastFailureAt: string | null, seconds: number): boolean {
  if (!lastFailureAt || seconds <= 0) return false;
  const timestamp = Date.parse(lastFailureAt);
  return Number.isFinite(timestamp) && timestamp + seconds * 1000 > Date.now();
}

function conversationNeedsFold(env: Env, state: ConversationState): boolean {
  if (env.CONVERSATION_FRESHNESS_V2_ENABLED === "true") {
    return planCacheAlignedConversationFold(state.recent, nowIso()).shouldFold;
  }
  const trigger = integerSetting(env.CONVERSATION_FOLD_TRIGGER_TURNS, DEFAULT_FOLD_TRIGGER_TURNS, 2, 10_000);
  const keep = integerSetting(env.CONVERSATION_RECENT_KEEP_TURNS, DEFAULT_RECENT_KEEP_TURNS, 1, trigger - 1);
  return planConversationFold(state.recent, trigger, keep).shouldFold;
}

async function enqueueConversationFoldAfterCommit(
  env: Env,
  recipientId: string,
  state: ConversationState,
): Promise<void> {
  const expectedRevision = state.stateRevision ?? null;
  if (!env.MEMORY_QUEUE || expectedRevision === null || !conversationNeedsFold(env, state)) return;
  const latest=await latestFoldAttempt(env.DB,recipientId);
  if (latest?.status==="failed" && latest.reason==="uncompactable_turn"
    && latest.stateRevision===expectedRevision) return;
  try {
    await env.MEMORY_QUEUE.send({ type: "conversation_fold", recipientId, expectedRevision });
  } catch (error) {
    const now = nowIso();
    const code = String(error).slice(0, 160);
    console.warn("conversation_fold_enqueue_failed",{recipientId,expectedRevision,code});
    try {
      await env.DB.prepare(`INSERT INTO conversation_events(
          channel,recipient_id,event_type,status,metadata_json,created_at)
        VALUES('telegram',?,'summary.fold_enqueue','failed',?,?)`)
        .bind(recipientId,JSON.stringify({expectedRevision,code}),now).run();
    } catch {
      // The append is already durable. A later append or scheduled scan can
      // enqueue the same idempotent revision without changing turn ownership.
    }
  }
}

export async function enqueueDueConversationFolds(env: Env, limit = 20): Promise<number> {
  if (env.WORKER_ROLE !== "memory" || !env.MEMORY_QUEUE
    || env.CONVERSATION_FRESHNESS_V2_ENABLED !== "true") return 0;
  const retrySeconds = integerSetting(env.CONVERSATION_SUMMARY_RETRY_COOLDOWN_SECONDS,
    DEFAULT_RETRY_COOLDOWN_SECONDS, 0);
  const retryCutoff = new Date(Date.now() - retrySeconds * 1000).toISOString();
  const ageCutoff = new Date(Date.now() - LIVE_CONTEXT_MAX_AGE_MS).toISOString();
  const rows = await env.DB.prepare(`SELECT s.chat_id,s.summary,s.recent_json,s.updated_at,
      f.state_revision,f.summary_manifest_json
    FROM tg_chat_state s JOIN tg_chat_state_freshness f ON f.chat_id=s.chat_id
    WHERE json_array_length(s.recent_json)>0
      AND ((SELECT COUNT(DISTINCT json_extract(j.value,'$.cacheEpochId'))
          FROM json_each(s.recent_json) j
          WHERE json_extract(j.value,'$.cacheEpochId') IS NOT NULL)>?
        OR json_array_length(s.recent_json)>?
        OR (SELECT COALESCE(SUM(length(CAST(json_extract(j.value,'$.content') AS BLOB))),0)
          FROM json_each(s.recent_json) j)>?
        OR json_extract(s.recent_json,'$[0].occurredAtUtc') IS NULL
        OR julianday(json_extract(s.recent_json,'$[0].occurredAtUtc'))<julianday(?))
      AND COALESCE((SELECT NOT(e.status='failed'
          AND json_extract(e.metadata_json,'$.reason')='uncompactable_turn'
          AND json_extract(e.metadata_json,'$.stateRevision')=f.state_revision)
        FROM conversation_events e
        WHERE e.channel='telegram' AND e.recipient_id=s.chat_id AND e.event_type='summary.fold'
        ORDER BY e.id DESC LIMIT 1),1)=1
      AND (?=0 OR COALESCE((SELECT
          e.status='failed' AND julianday(e.created_at)>julianday(?)
        FROM conversation_events e
        WHERE e.channel='telegram' AND e.recipient_id=s.chat_id AND e.event_type='summary.fold'
        ORDER BY e.id DESC LIMIT 1),0)=0)
    ORDER BY f.updated_at ASC LIMIT ?`)
    .bind(RECENT_CACHE_EPOCHS_TO_KEEP,
      RECENT_INJECT_MAX_TURNS * RECENT_CACHE_EPOCHS_TO_KEEP,
      RECENT_INJECT_MAX_BYTES * RECENT_CACHE_EPOCHS_TO_KEEP,
      ageCutoff,retrySeconds,retryCutoff,
      Math.max(1,Math.min(100,Math.floor(limit)))).all<{
      chat_id:string; summary:string; recent_json:string; updated_at:string;
      state_revision:number; summary_manifest_json:string|null;
    }>();
  let enqueued = 0;
  for (const row of rows.results ?? []) {
    let recent: ConversationRecentTurn[];
    let summaryEnvelope: RollingSummaryEnvelopeV2 | null = null;
    try {
      recent = parseRecentTurns(JSON.parse(row.recent_json));
      if (row.summary_manifest_json) summaryEnvelope = parseSummaryEnvelope(JSON.parse(row.summary_manifest_json));
    }
    catch { continue; }
    const state: ConversationState = {
      summary: row.summary || "",
      recent,
      stateRevision: row.state_revision,
      updatedAt: row.updated_at,
      summaryEnvelope,
    };
    if (!conversationNeedsFold(env,state)) continue;
    try {
      await env.MEMORY_QUEUE.send({
        type:"conversation_fold",recipientId:row.chat_id,expectedRevision:row.state_revision,
      });
      enqueued += 1;
    } catch (error) {
      console.warn("conversation_fold_recovery_enqueue_failed",{
        recipientId:row.chat_id,expectedRevision:row.state_revision,code:String(error).slice(0,160),
      });
    }
  }
  return enqueued;
}

async function compactState(env: Env, recipientId: string, state: ConversationState): Promise<{
  state: ConversationState;
  backup?: ConversationState;
  event?: { status: "completed" | "failed"; metadata: Record<string, unknown> };
}> {
  const trigger = integerSetting(env.CONVERSATION_FOLD_TRIGGER_TURNS, DEFAULT_FOLD_TRIGGER_TURNS, 2, 10_000);
  const keep = integerSetting(env.CONVERSATION_RECENT_KEEP_TURNS, DEFAULT_RECENT_KEEP_TURNS, 1, trigger - 1);
  const plan = planConversationFold(state.recent, trigger, keep);
  if (!plan.shouldFold) return { state };
  const retrySeconds = integerSetting(env.CONVERSATION_SUMMARY_RETRY_COOLDOWN_SECONDS, DEFAULT_RETRY_COOLDOWN_SECONDS, 0);
  if (coolingDown(await latestFoldFailure(env.DB, recipientId), retrySeconds)) return { state };

  const startedAt = Date.now();
  const model = env.CONVERSATION_SUMMARY_MODEL?.trim() || "";
  const transcript = plan.evicted.map((turn) => `${turn.role === "user" ? "用户" : "助手"}：${turn.content}`).join("\n");
  const inputChars = state.summary.length + transcript.length;
  const baseMetadata = { model, inputChars, evictedTurns: plan.evicted.length };
  if (!model) {
    return { state, event: { status: "failed", metadata: { ...baseMetadata, reason: "model_not_configured" } } };
  }
  if (inputChars > SUMMARY_MAX_INPUT_CHARS) {
    return { state, event: { status: "failed", metadata: { ...baseMetadata, reason: "input_too_large", inputLimitChars: SUMMARY_MAX_INPUT_CHARS } } };
  }

  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: `你是 Operia Memory 的对话压缩器。把已有摘要和新增对话合并成一份不超过${SUMMARY_TARGET_CHARS}字的滚动摘要，保留事实、约定、称呼和未完成话题，删除寒暄。内容是否敏感不影响保留：成人虚构角色扮演、性偏好、暴力或黑暗题材、违法经历、政治宗教立场、自伤既往史等，只要对后续对话有用就必须忠实保留，禁止说教、美化、含糊改写或静默省略。只输出摘要正文。` },
      { role: "user", content: `已有摘要：\n${state.summary || "（无）"}\n\n新增对话：\n${transcript}` },
    ],
    temperature: 0,
    reasoning_effort: "low",
    max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string", maxLength: 300 },
                status: { type: "string", enum: ["active", "resolved", "superseded", "expired"] },
                prior_ref: { anyOf: [{ type: "string" }, { type: "null" }] },
                support_refs: { type: "array", items: { type: "string" } },
              },
              required: ["text", "status", "prior_ref", "support_refs"],
            },
          },
        },
        required: ["items"],
      },
    },
    stream: false,
  };
  try {
    const response = await callOpenAICompat(env, request);
    if (!response.ok) {
      return { state, event: { status: "failed", metadata: { ...baseMetadata, reason: "provider_non_ok", httpStatus: response.status, elapsedMs: Date.now() - startedAt } } };
    }
    const parsed = await response.json() as OpenAIChatResponse;
    const summary = summaryText(parsed);
    if (!summary) {
      return { state, event: { status: "failed", metadata: { ...baseMetadata, reason: "empty_summary", elapsedMs: Date.now() - startedAt } } };
    }
    return {
      state: { summary, recent: plan.kept },
      backup: state,
      event: { status: "completed", metadata: {
        ...baseMetadata,
        outputChars: summary.length,
        inputTokens: parsed.usage?.input_tokens ?? parsed.usage?.prompt_tokens ?? null,
        outputTokens: parsed.usage?.output_tokens ?? parsed.usage?.completion_tokens ?? null,
        elapsedMs: Date.now() - startedAt,
      } },
    };
  } catch (error) {
    return { state, event: { status: "failed", metadata: { ...baseMetadata, reason: "exception", code: String(error).slice(0, 160), elapsedMs: Date.now() - startedAt } } };
  }
}

async function compactFreshState(env: Env, recipientId: string, state: ConversationState): Promise<{
  state: ConversationState;
  backup?: ConversationState;
  event?: { status: "completed" | "failed"; metadata: Record<string, unknown> };
}> {
  const plan = planCacheAlignedConversationFold(state.recent, nowIso());
  if (!plan.shouldFold) return { state };
  const retrySeconds = integerSetting(env.CONVERSATION_SUMMARY_RETRY_COOLDOWN_SECONDS, DEFAULT_RETRY_COOLDOWN_SECONDS, 0);
  const latestAttempt=await latestFoldAttempt(env.DB,recipientId);
  if (latestAttempt?.status==="failed" && latestAttempt.reason==="uncompactable_turn"
    && latestAttempt.stateRevision===(state.stateRevision??null)) return {state};
  const providerCoolingDown = coolingDown(latestAttempt?.status==="failed"?latestAttempt.createdAt:null,retrySeconds);
  if (providerCoolingDown) return { state };

  const startedAt = Date.now();
  const model = env.CONVERSATION_SUMMARY_MODEL?.trim() || "";
  let prior = state.summaryEnvelope ?? null;
  if (!prior && state.summary.trim()) {
    const legacyText = state.summary.trim();
    prior = {
      version: 2,
      revision: 0,
      policyVersion: "legacy-unknown-v1",
      generatedAtUtc: nowIso(),
      coversFromUtc: null,
      coversThroughUtc: null,
      temporalConfidence: "unknown",
      items: [{
        itemId: await sha256Hex(`legacy-summary:${legacyText}`),
        text: legacyText.slice(0, 300),
        status: "active",
        firstSupportedAtUtc: null,
        lastSupportedAtUtc: null,
        temporalConfidence: "unknown",
        supportCount: 1,
        sourceEventHashes: [await sha256Hex(`legacy-summary-source:${legacyText}`)],
      }],
      renderedText: legacyText.slice(0, 1_500),
      renderedSha256: await sha256Hex(legacyText.slice(0, 1_500)),
    };
  }
  const boundedPlan = boundedFreshFoldPlan(
    plan.evicted,
    plan.kept,
    prior?.renderedText.length ?? state.summary.length,
  );
  if (!boundedPlan) {
    const inputChars = (prior?.renderedText.length ?? state.summary.length)
      + (plan.evicted[0]?.content.length ?? 0);
    return {
      state,
      event: { status: "failed", metadata: {
        model,inputChars,evictedTurns:0,pendingTurns:plan.evicted.length,policy:"freshness_v2",
        stateRevision:state.stateRevision??null,
        reason:"uncompactable_turn",inputLimitChars:SUMMARY_MAX_INPUT_CHARS,
        statePreserved:true,lossyFallbackSuppressed:true,requiresAttention:true,
      } },
    };
  }
  const events = await buildCompactionEvents(boundedPlan.evicted);
  const inputChars = events.reduce((total, event) => total + event.content.length, 0)
    + (prior?.renderedText.length ?? state.summary.length);
  const baseMetadata = {
    model,inputChars,evictedTurns:boundedPlan.evicted.length,pendingTurns:boundedPlan.kept.length,
    partialFold:boundedPlan.partial,policy:"freshness_v2",stateRevision:state.stateRevision??null,
  };
  const preserveStateOnFailure = (reason: string, extra: Record<string,unknown> = {}) => ({
    state,
    event: { status: "failed" as const, metadata: {
      ...baseMetadata,...extra,reason,statePreserved:true,lossyFallbackSuppressed:true,
    } },
  });
  if (!model) {
    return preserveStateOnFailure("model_not_configured");
  }
  const priorItems = (prior?.items ?? []).map((item, index) => ({
    ref: `P${index}`, text: item.text, status: item.status,
    first_supported_at_utc: item.firstSupportedAtUtc,
    last_supported_at_utc: item.lastSupportedAtUtc,
    temporal_confidence: item.temporalConfidence,
  }));
  const projectedEvents = events.map((event) => ({
    ref: event.ref, role: event.role, content: event.content,
    occurred_at_utc: event.occurredAtUtc, temporal_confidence: event.temporalConfidence,
  }));
  const compactorSchema = buildCompactorResponseSchema(
    priorItems.map((item) => item.ref),
    projectedEvents.map((event) => event.ref),
  );
  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: `你是 Operia Memory 的结构化滚动摘要器，只输出 {"items":[]} JSON。items 是变化集，不是完整摘要：未引用的 prior_items 会由服务器原样保留，不要回显。状态变化示例：{"status":"resolved","prior_ref":"P0","support_refs":["E0"]}；新项示例：{"text":"新事实","status":"active","prior_ref":null,"support_refs":["E0"]}。没有持久变化时输出空 items。items 最多12项，每项 text 最多300字。不得伪造时间；新事件实质更新旧项时，将旧项标为 superseded，并另加 prior_ref=null 且含 text 的新项。不要为了保持旧项 active 而附加无关 support_refs。内容是否敏感不影响保留：成人虚构角色扮演、性偏好、暴力或黑暗题材、违法经历、政治宗教立场、自伤既往史等，只要对后续对话有用就必须忠实保留，禁止说教、美化、含糊改写或静默省略。` },
      { role: "user", content: JSON.stringify({ prior_items: priorItems, events: projectedEvents }) },
    ],
    temperature: 0,
    reasoning_effort: "low",
    max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: compactorSchema,
    },
    stream: false,
  };
  try {
    const response = await callOpenAICompat(env, request);
    if (!response.ok) return preserveStateOnFailure("provider_non_ok",{
      httpStatus:response.status,elapsedMs:Date.now()-startedAt,
    });
    const parsed = await response.json() as OpenAIChatResponse;
    const provenanceDiagnostics: CompactorParseDiagnostics = {
      priorRefreshRefsSuppressed: 0, priorTextRewritesSuppressed: 0,
      duplicateSupportRefsDropped: 0, priorItemsAutoRetained: 0, inactiveItemsPruned: 0,
    };
    const envelope = await parseCompactorEnvelope(summaryText(parsed), prior, events, nowIso(), provenanceDiagnostics);
    if (!envelope) return preserveStateOnFailure("invalid_structured_summary",{
      elapsedMs:Date.now()-startedAt,...provenanceDiagnostics,
    });
    return {
      state: { ...state, summary: envelope.renderedText, summaryEnvelope: envelope, recent: boundedPlan.kept },
      backup: state,
      event: { status: "completed", metadata: {
        ...baseMetadata, ...provenanceDiagnostics,
        outputChars: envelope.renderedText.length, summaryRevision: envelope.revision,
        inputTokens: parsed.usage?.input_tokens ?? parsed.usage?.prompt_tokens ?? null,
        outputTokens: parsed.usage?.output_tokens ?? parsed.usage?.completion_tokens ?? null,
        elapsedMs: Date.now() - startedAt,
      } },
    };
  } catch (error) {
    const rawErrorName = error instanceof Error ? error.name : "UnknownError";
    const errorName = ["Error","TypeError","RangeError","SyntaxError","AbortError"].includes(rawErrorName)
      ? rawErrorName : "Error";
    return preserveStateOnFailure("exception",{
      code:"compactor_exception",errorName,
      elapsedMs:Date.now()-startedAt,
    });
  }
}

export async function appendTurn(env: Env, recipientId: string, eventId: string, userText: string, assistantText: string,
  userOccurredAtUtc: string | null, assistantOccurredAtUtc: string | null): Promise<Response> {
  const freshnessEnabled = env.CONVERSATION_FRESHNESS_V2_ENABLED === "true";
  const priorEvent = await env.DB.prepare("SELECT applied,recipient_id FROM conversation_turn_events WHERE event_id=?")
    .bind(eventId).first<{ applied: number; recipient_id: string }>();
  if (priorEvent && priorEvent.recipient_id !== recipientId) return privateJson({ error: "event_recipient_conflict" }, 409);
  if (priorEvent?.applied === 1) {
    const state = await readState(env.DB, recipientId);
    await enqueueConversationFoldAfterCommit(env,recipientId,state);
    return privateJson({ ok: true, duplicate: true, needsFold: conversationNeedsFold(env, state),
      stateRevision: state.stateRevision ?? null, state });
  }

  const now = nowIso();
  if (freshnessEnabled) {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO tg_chat_state(chat_id,summary,recent_json,updated_at)
        VALUES(?,'','[]',?)`).bind(recipientId, now),
      env.DB.prepare(`INSERT OR IGNORE INTO tg_chat_state_freshness(chat_id,v2_started_at_utc,updated_at)
        VALUES(?,?,?)`).bind(recipientId, now, now),
    ]);
  }

  const before = await readState(env.DB, recipientId);
  const occurred = (value: string | null): string | null => {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  };
  const userAt = occurred(userOccurredAtUtc);
  const assistantAt = occurred(assistantOccurredAtUtc);
  const assistantApplied = assistantText.trim().length > 0;
  const newTurns: ConversationRecentTurn[] = [freshnessEnabled
    ? { version: 2, eventId: `${eventId}:owner`, role: "user", content: userText,
        occurredAtUtc: userAt, observedAtUtc: now, temporalConfidence: userAt ? "exact" : "unknown" }
    : { role: "user", content: userText }];
  if (assistantApplied) {
    newTurns.push(freshnessEnabled
      ? { version: 2, eventId: `${eventId}:assistant`, role: "assistant", content: assistantText,
          occurredAtUtc: assistantAt, observedAtUtc: now, temporalConfidence: assistantAt ? "exact" : "unknown" }
      : { role: "assistant", content: assistantText });
  }
  const appended: ConversationState = { ...before, summary: before.summary, recent: assignRecentCacheEpochIds([
    ...before.recent,
    ...newTurns,
  ]) };
  const expectedRevision = before.stateRevision ?? 0;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT OR IGNORE INTO conversation_turn_events(event_id,channel,recipient_id,applied,created_at)
      VALUES(?,'telegram',?,0,?)`).bind(eventId, recipientId, now),
  ];
  const freshnessPredicate = freshnessEnabled
    ? " AND EXISTS(SELECT 1 FROM tg_chat_state_freshness WHERE chat_id=? AND state_revision=?)"
    : "";
  const stateStatement = env.DB.prepare(`INSERT INTO tg_chat_state(chat_id,summary,recent_json,updated_at)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM conversation_turn_events WHERE event_id=? AND applied=0)${freshnessPredicate}
    ON CONFLICT(chat_id) DO UPDATE SET summary=excluded.summary,recent_json=excluded.recent_json,updated_at=excluded.updated_at`)
    .bind(...(freshnessEnabled
      ? [recipientId, appended.summary, JSON.stringify(appended.recent), now, eventId, recipientId, expectedRevision]
      : [recipientId, appended.summary, JSON.stringify(appended.recent), now, eventId]));
  statements.push(stateStatement);
  if (freshnessEnabled) {
    statements.push(env.DB.prepare(`UPDATE tg_chat_state_freshness SET state_revision=state_revision+1,updated_at=?
      WHERE chat_id=? AND state_revision=? AND EXISTS(
        SELECT 1 FROM conversation_turn_events WHERE event_id=? AND applied=0)`)
      .bind(now, recipientId, expectedRevision, eventId));
  }
  statements.push(env.DB.prepare(`UPDATE conversation_turn_events SET applied=1,applied_at=?
    WHERE event_id=? AND applied=0${freshnessEnabled
      ? " AND EXISTS(SELECT 1 FROM tg_chat_state_freshness WHERE chat_id=? AND state_revision=?)"
      : ""}`)
    .bind(...(freshnessEnabled
      ? [now, eventId, recipientId, expectedRevision + 1]
      : [now, eventId])));
  statements.push(env.DB.prepare(`INSERT INTO conversation_event_part_materializations(
      event_id,source_applied,assistant_applied,provenance,created_at,updated_at)
    SELECT ?,1,?,'legacy_append',?,?
    WHERE EXISTS(SELECT 1 FROM conversation_turn_events event
      WHERE event.event_id=? AND event.recipient_id=? AND event.applied=1)
    ON CONFLICT(event_id) DO NOTHING`)
    .bind(eventId,assistantApplied?1:0,now,now,eventId,recipientId));
  await env.DB.batch(statements);
  const applied = await env.DB.prepare("SELECT applied FROM conversation_turn_events WHERE event_id=? AND recipient_id=?")
    .bind(eventId, recipientId).first<{ applied: number }>();
  if (applied?.applied !== 1) return privateJson({ error: "state_revision_conflict" }, 409);
  const partMaterialization = await readConversationEventPartMaterialization(env.DB,eventId);
  if (!partMaterialization || partMaterialization.provenance !== "legacy_append"
    || partMaterialization.sourceApplied !== true
    || partMaterialization.assistantApplied !== assistantApplied) {
    return privateJson({error:"event_part_materialization_conflict"},409);
  }
  const state = await readState(env.DB, recipientId);
  await enqueueConversationFoldAfterCommit(env,recipientId,state);
  return privateJson({ ok: true, duplicate: false, needsFold: conversationNeedsFold(env, state),
    stateRevision: state.stateRevision ?? null, state });
}

export async function foldConversationStateAtRevision(
  env: Env,
  recipientId: string,
  expectedRevision: number,
): Promise<Response> {
  if (env.CONVERSATION_FRESHNESS_V2_ENABLED !== "true") {
    return privateJson({ ok: true, status: "noop", stateRevision: null });
  }
  const before = await readState(env.DB, recipientId);
  const currentRevision = before.stateRevision ?? 0;
  if (currentRevision !== expectedRevision) {
    return privateJson({ ok: true, status: "stale", stateRevision: currentRevision });
  }
  const compacted = await compactFreshState(env, recipientId, before);
  if (!compacted.event) {
    return privateJson({ ok: true, status: "noop", stateRevision: currentRevision });
  }
  const now = nowIso();
  if (compacted.event.status === "failed" || !compacted.backup) {
    await env.DB.prepare(`INSERT INTO conversation_events(channel,recipient_id,event_type,status,metadata_json,created_at)
      SELECT 'telegram',?,'summary.fold',?,?,? WHERE EXISTS(
        SELECT 1 FROM tg_chat_state_freshness WHERE chat_id=? AND state_revision=?)`)
      .bind(recipientId, "failed", JSON.stringify(compacted.event.metadata), now, recipientId, expectedRevision)
      .run();
    return privateJson({ ok: true, status: "failed", stateRevision: currentRevision });
  }

  const envelope = compacted.state.summaryEnvelope ?? null;
  const foldId = `fold:${recipientId}:${expectedRevision}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO tg_chat_state_fold_backup(chat_id,fold_id,summary,recent_json,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS(
        SELECT 1 FROM tg_chat_state_freshness WHERE chat_id=? AND state_revision=?)
      ON CONFLICT(chat_id) DO UPDATE SET fold_id=excluded.fold_id,summary=excluded.summary,
        recent_json=excluded.recent_json,created_at=excluded.created_at`)
      .bind(recipientId, foldId, compacted.backup.summary, JSON.stringify(compacted.backup.recent), now,
        recipientId, expectedRevision),
    env.DB.prepare(`INSERT INTO tg_chat_state_freshness_backup(
        chat_id,fold_id,state_revision,summary_manifest_json,rendered_sha256,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(
        SELECT 1 FROM tg_chat_state_freshness WHERE chat_id=? AND state_revision=?)
      ON CONFLICT(chat_id) DO UPDATE SET fold_id=excluded.fold_id,state_revision=excluded.state_revision,
        summary_manifest_json=excluded.summary_manifest_json,rendered_sha256=excluded.rendered_sha256,
        created_at=excluded.created_at`)
      .bind(recipientId, foldId, expectedRevision,
        compacted.backup.summaryEnvelope ? JSON.stringify(compacted.backup.summaryEnvelope) : null,
        compacted.backup.summaryEnvelope?.renderedSha256 ?? null, now, recipientId, expectedRevision),
    env.DB.prepare(`UPDATE tg_chat_state SET summary=?,recent_json=?,updated_at=?
      WHERE chat_id=? AND EXISTS(
        SELECT 1 FROM tg_chat_state_freshness WHERE chat_id=? AND state_revision=?)`)
      .bind(compacted.state.summary, JSON.stringify(compacted.state.recent), now,
        recipientId, recipientId, expectedRevision),
    env.DB.prepare(`UPDATE tg_chat_state_freshness SET
        state_revision=state_revision+1,summary_revision=?,summary_policy_version=?,summary_generated_at_utc=?,
        summary_covers_from_utc=?,summary_covers_through_utc=?,summary_temporal_confidence=?,
        summary_manifest_json=?,rendered_sha256=?,updated_at=?
      WHERE chat_id=? AND state_revision=?`)
      .bind(envelope?.revision ?? 0, envelope?.policyVersion ?? null, envelope?.generatedAtUtc ?? null,
        envelope?.coversFromUtc ?? null, envelope?.coversThroughUtc ?? null,
        envelope?.temporalConfidence ?? "unknown", envelope ? JSON.stringify(envelope) : null,
        envelope?.renderedSha256 ?? null, now, recipientId, expectedRevision),
    env.DB.prepare(`INSERT INTO conversation_events(channel,recipient_id,event_type,status,metadata_json,created_at)
      SELECT 'telegram',?,'summary.fold','completed',?,? WHERE EXISTS(
        SELECT 1 FROM tg_chat_state_freshness
        WHERE chat_id=? AND state_revision=? AND rendered_sha256=?)`)
      .bind(recipientId, JSON.stringify(compacted.event.metadata), now, recipientId,
        expectedRevision + 1, envelope?.renderedSha256 ?? null),
  ]);
  const after = await readState(env.DB, recipientId);
  if ((after.stateRevision ?? 0) !== expectedRevision + 1
    || after.summaryEnvelope?.revision !== envelope?.revision
    || after.summaryEnvelope?.renderedSha256 !== envelope?.renderedSha256) {
    return privateJson({ ok: true, status: "stale", stateRevision: after.stateRevision ?? 0 });
  }
  await enqueueConversationFoldAfterCommit(env,recipientId,after);
  return privateJson({ ok: true, status: "completed", stateRevision: after.stateRevision ?? 0 });
}

function privateJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export async function handleConversationStateService(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (env.WORKER_ROLE !== "memory" || url.hostname !== "<MEMORY_SERVICE>.internal") return new Response("not found", { status: 404 });
  const auth = await authenticate(request, env);
  if (!auth.ok || auth.keyName !== "TG_CHAT_API_KEY" || request.headers.get("x-operia-channel") !== "telegram") {
    return privateJson({ error: "unauthorized" }, 401);
  }
  const headerRecipient = request.headers.get("x-operia-recipient-id")?.trim() || "";
  const recipientId = url.searchParams.get("recipient_id")?.trim() || headerRecipient;
  if (!recipientId || recipientId !== headerRecipient) return privateJson({ error: "recipient_mismatch" }, 403);

  if (request.method === "GET") return privateJson({ ok: true, state: await readState(env.DB, recipientId) });
  if (request.method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM tg_chat_state_freshness_backup WHERE chat_id=?").bind(recipientId),
      env.DB.prepare("DELETE FROM tg_chat_state_fold_backup WHERE chat_id=?").bind(recipientId),
      env.DB.prepare("DELETE FROM tg_chat_state WHERE chat_id=?").bind(recipientId),
    ]);
    return privateJson({ ok: true });
  }
  if (request.method !== "POST") return privateJson({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await request.json<Record<string, unknown>>(); } catch { return privateJson({ error: "invalid_json" }, 400); }
  if (body.operation === "project") {
    const ownerText = typeof body.ownerText === "string" ? body.ownerText : "";
    const requestStartedAtUtc = typeof body.requestStartedAtUtc === "string" ? body.requestStartedAtUtc : "";
    const parsedStartedAt = Date.parse(requestStartedAtUtc);
    if (typeof body.ownerText !== "string" || ownerText.length > 100_000 || !Number.isFinite(parsedStartedAt)) {
      return privateJson({ error: "invalid_projection_request" }, 422);
    }
    const state = await readState(env.DB, recipientId);
    const projection = await projectConversationForTurn(state, ownerText,
      new Date(parsedStartedAt).toISOString(), env.CONVERSATION_FRESHNESS_V2_ENABLED === "true");
    if (projection.metrics.summaryFanoutGuardTriggered) {
      console.warn("conversation_summary_fanout_guard", {
        stateRevision: state.stateRevision ?? null,
        summaryRevision: state.summaryEnvelope?.revision ?? null,
        renderedSha256: state.summaryEnvelope?.renderedSha256 ?? null,
        autoLiveSuppressed: projection.metrics.summaryItemsAutoLiveSuppressed,
        maxSharedSourceHashItems: projection.metrics.summarySupportFanoutMax,
        selectedItems: projection.metrics.summaryItemsSelected,
        ownerReactivatedItems: projection.metrics.summaryItemsOwnerReactivated,
      });
    }
    if (projection.metrics.contextCoverageDegraded) {
      console.warn("conversation_projection_coverage_degraded", {
        stateRevision: state.stateRevision ?? null,
        summaryRevision: state.summaryEnvelope?.revision ?? null,
        renderedSha256: state.summaryEnvelope?.renderedSha256 ?? null,
        projectionMode: projection.metrics.recentProjectionMode ?? null,
        storedTurns: projection.metrics.storedTurns,
        selectedTurns: projection.metrics.selectedTurns,
        omittedTurns: projection.metrics.omittedTurns ?? 0,
        uncoveredOmittedTurns: projection.metrics.uncoveredOmittedTurns ?? 0,
        evidenceTurnsSelected: projection.metrics.historyEvidenceTurnsSelected ?? 0,
        summaryBudgetLimited: projection.metrics.summaryBudgetLimited ?? false,
        summaryItemsDroppedByBudget: projection.metrics.summaryItemsDroppedByBudget ?? 0,
        selectedBytes: projection.metrics.selectedBytes,
        omittedBytes: projection.metrics.omittedBytes ?? 0,
      });
    }
    return privateJson({ ok: true, state, projection });
  }
  if (body.operation === "consume_publication") {
    const publicationId = typeof body.publicationId === "string" ? body.publicationId.trim().slice(0, 240) : "";
    const eventId = typeof body.eventId === "string" ? body.eventId.trim().slice(0, 200) : "";
    const outcomeRevision = Number(body.outcomeRevision);
    const validUserText = typeof body.userText === "string" && body.userText.length > 0;
    const userOccurredAtUtc = typeof body.userOccurredAtUtc === "string" ? body.userOccurredAtUtc : null;
    const assistantOccurredAtUtc = typeof body.assistantOccurredAtUtc === "string" ? body.assistantOccurredAtUtc : null;
    if (!publicationId || !eventId || !Number.isSafeInteger(outcomeRevision) || outcomeRevision < 1
      || !validUserText) {
      return privateJson({ error:"invalid_publication_consumption" },422);
    }
    try {
      const result = await applyPublicationConversation(env,{
        publicationId,outcomeRevision,recipientScope:recipientId,conversationEventId:eventId,
        userText:String(body.userText).slice(0,100_000),
        userOccurredAtUtc,assistantOccurredAtUtc,
      });
      await enqueueConversationFoldAfterCommit(env,recipientId,result.state);
      return privateJson({ok:true,...result,needsFold:conversationNeedsFold(env,result.state),
        stateRevision:result.state.stateRevision ?? null});
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      return privateJson({error:code.slice(0,160)},
        code.includes("conflict") || code.includes("superseded") ? 409 : 422);
    }
  }
  const eventId = typeof body.eventId === "string" ? body.eventId.trim().slice(0, 200) : "";
  const validUserText = typeof body.userText === "string" && body.userText.length > 0;
  const validAssistantText = typeof body.assistantText === "string";
  const userText = validUserText ? String(body.userText).slice(0, 100_000) : "";
  const assistantText = validAssistantText ? String(body.assistantText).slice(0, 100_000) : "";
  if (!eventId || !validUserText || !validAssistantText) return privateJson({ error: "invalid_turn" }, 422);
  const userOccurredAtUtc = typeof body.userOccurredAtUtc === "string" ? body.userOccurredAtUtc : null;
  const assistantOccurredAtUtc = typeof body.assistantOccurredAtUtc === "string" ? body.assistantOccurredAtUtc : null;
  if ((userOccurredAtUtc && !Number.isFinite(Date.parse(userOccurredAtUtc)))
    || (assistantOccurredAtUtc && !Number.isFinite(Date.parse(assistantOccurredAtUtc)))) {
    return privateJson({ error: "invalid_occurrence_time" }, 422);
  }
  return appendTurn(env, recipientId, eventId, userText, assistantText, userOccurredAtUtc, assistantOccurredAtUtc);
}
