import type { Env } from "../types";
import type { ConversationProjection, ConversationState } from "../memory/conversationState";

function key(env: Env): string {
  const value = env.TG_CHAT_API_KEY?.trim();
  if (!value) throw new Error("tg_chat_api_key_missing");
  return value;
}

async function requestMemory(env: Env, chatId: string, init: RequestInit): Promise<Response> {
  if (!env.MEMORY_SERVICE) throw new Error("memory_service_missing");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key(env)}`);
  headers.set("x-operia-channel", "telegram");
  headers.set("x-operia-recipient-id", chatId);
  if (init.body) headers.set("content-type", "application/json");
  return env.MEMORY_SERVICE.fetch(`https://<MEMORY_SERVICE>.internal/service/conversation/state?recipient_id=${encodeURIComponent(chatId)}`, { ...init, headers });
}

export async function getConversationState(env: Env, chatId: string): Promise<ConversationState> {
  const response = await requestMemory(env, chatId, { method: "GET" });
  if (!response.ok) throw new Error(`memory_conversation_get_${response.status}`);
  const payload = await response.json<{ state?: ConversationState }>();
  return payload.state ?? { summary: "", recent: [] };
}

export async function getConversationProjection(env: Env, input: {
  chatId: string; ownerText: string; requestStartedAtUtc: string;
}): Promise<{ state: ConversationState; projection: ConversationProjection }> {
  if (env.CONVERSATION_FRESHNESS_V2_ENABLED !== "true") {
    const state = await getConversationState(env, input.chatId);
    return { state, projection: {
      mode: "legacy",
      recent: state.recent.map((turn) => ({ role: turn.role, content: turn.content })),
      summaryPatch: null,
      metrics: {
        storedTurns: state.recent.length, selectedTurns: state.recent.length, excludedByAge: 0,
        excludedUnknownTime: 0, selectedBytes: 0, oldestSelectedUtc: null, newestSelectedUtc: null,
        summaryItemsAvailable: state.summary ? 1 : 0, summaryItemsSelected: state.summary ? 1 : 0,
        summaryItemsOwnerReactivated: 0,
      },
    } };
  }
  const response = await requestMemory(env, input.chatId, {
    method: "POST",
    body: JSON.stringify({ operation: "project", ownerText: input.ownerText,
      requestStartedAtUtc: input.requestStartedAtUtc }),
  });
  if (!response.ok) throw new Error(`memory_conversation_project_${response.status}`);
  const payload = await response.json<{ state?: ConversationState; projection?: ConversationProjection }>();
  if (!payload.state || !payload.projection) throw new Error("memory_conversation_project_invalid");
  return { state: payload.state, projection: payload.projection };
}

export async function appendConversationTurn(env: Env, input: {
  chatId: string; eventId: string; userText: string; assistantText: string;
  userOccurredAtUtc?: string | null; assistantOccurredAtUtc?: string | null;
}, timeoutMs?: number): Promise<{
  duplicate: boolean;
  needsFold: boolean;
  stateRevision: number | null;
  state: ConversationState;
}> {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort("memory_conversation_append_timeout"), Math.max(1, timeoutMs!)) : null;
  try {
    const response = await requestMemory(env, input.chatId, {
      method: "POST",
      signal: controller?.signal,
      body: JSON.stringify({ eventId: input.eventId, userText: input.userText, assistantText: input.assistantText,
        userOccurredAtUtc: input.userOccurredAtUtc ?? null,
        assistantOccurredAtUtc: input.assistantOccurredAtUtc ?? null }),
    });
    if (!response.ok) throw new Error(`memory_conversation_append_${response.status}`);
    return response.json<{
      duplicate: boolean;
      needsFold: boolean;
      stateRevision: number | null;
      state: ConversationState;
    }>();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function consumePublicationConversation(env: Env, input: {
  chatId:string;
  publicationId:string;
  outcomeRevision:number;
  eventId:string;
  userText:string;
  userOccurredAtUtc?:string|null;
  assistantOccurredAtUtc?:string|null;
}):Promise<{
  duplicate:boolean;
  sourceApplied:boolean;
  assistantApplied:boolean;
  stateRevision:number|null;
  state:ConversationState;
}> {
  const response = await requestMemory(env,input.chatId,{
    method:"POST",
    body:JSON.stringify({
      operation:"consume_publication",publicationId:input.publicationId,
      outcomeRevision:input.outcomeRevision,eventId:input.eventId,userText:input.userText,
      userOccurredAtUtc:input.userOccurredAtUtc ?? null,
      assistantOccurredAtUtc:input.assistantOccurredAtUtc ?? null,
    }),
  });
  if (!response.ok) {
    let code = `memory_publication_conversation_${response.status}`;
    try {
      const payload = await response.json<{error?:unknown}>();
      if (typeof payload.error === "string" && payload.error.trim()) code = payload.error.slice(0,160);
    } catch { /* Preserve the bounded HTTP fallback code. */ }
    throw new Error(code);
  }
  return response.json<{
    duplicate:boolean;sourceApplied:boolean;assistantApplied:boolean;
    stateRevision:number|null;state:ConversationState;
  }>();
}

export async function resetConversationState(env: Env, chatId: string): Promise<void> {
  const response = await requestMemory(env, chatId, { method: "DELETE" });
  if (!response.ok) throw new Error(`memory_conversation_reset_${response.status}`);
}
