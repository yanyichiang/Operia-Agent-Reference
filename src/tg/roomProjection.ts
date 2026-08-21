import type { Env } from "../types";
import { AGENT_ROOM_BOT_TURN_LIMIT, AGENT_ROOM_BOT_TURN_WINDOW_SECONDS, agentRoomsEnabled, listAgentRooms, type TgAgentRoom, type TgRoomAgent } from "./agentRooms";
import { getRoomSharedState, roomTranscriptProjection } from "./roomSharedState";

type CountRow = { status: string; count: number };
type AttentionItem = {
  kind: "inference" | "outbox" | "summary";
  id: string;
  status: string;
  errorCode: string | null;
  updatedAt: string;
};

function countMap(rows: CountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
}

function cleanError(value: unknown): string | null {
  const error = String(value || "").trim();
  return error ? error.replace(/\s+/g, " ").slice(0, 160) : null;
}

function projectedAgent(agent: TgRoomAgent) {
  return {
    id: agent.id,
    botUserId: agent.bot_user_id,
    botName: agent.bot_name,
    botUsername: agent.bot_username,
    runtimeKind: agent.runtime_kind,
    transportOwner: agent.transport_owner,
    status: agent.status,
    membershipStatus: agent.membership_status,
    membershipRevision: agent.membership_revision,
    botToBotMode: agent.bot_to_bot_mode,
    revision: agent.revision,
    verifiedAt: agent.verified_at,
  };
}

async function projectRoom(env: Env, room: TgAgentRoom & { agents: TgRoomAgent[] }) {
  const [
    shared,
    transcript,
    loop,
    inbox,
    runs,
    outbox,
    audit,
    events,
    inferenceAttention,
    outboxAttention,
  ] = await Promise.all([
    getRoomSharedState(env.DB, room),
    roomTranscriptProjection(env.DB, room),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM tg_agent_room_audit
      WHERE room_id=? AND event_type='bot.message.accepted' AND created_at>=datetime('now','-2 minutes')`)
      .bind(room.id).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM tg_inbox WHERE chat_id=? AND processed=0")
      .bind(room.chat_id).first<{ count: number }>(),
    env.DB.prepare(`SELECT status,COUNT(*) AS count FROM tg_chat_inference_runs
      WHERE chat_id=? AND created_at>=datetime('now','-24 hours') GROUP BY status`)
      .bind(room.chat_id).all<CountRow>(),
    env.DB.prepare(`SELECT status,COUNT(*) AS count FROM tg_agent_outbox
      WHERE chat_id=? AND created_at>=datetime('now','-24 hours') GROUP BY status`)
      .bind(room.chat_id).all<CountRow>(),
    env.DB.prepare(`SELECT id,event_type,old_revision,new_revision,created_at
      FROM tg_agent_room_audit WHERE room_id=? ORDER BY id DESC LIMIT 16`)
      .bind(room.id).all<{
        id: number;
        event_type: string;
        old_revision: number | null;
        new_revision: number | null;
        created_at: string;
      }>(),
    env.DB.prepare(`SELECT id,event_type,status,created_at FROM tg_events
      WHERE chat_id=? AND event_type NOT IN ('reasoning.trace','prompt.raw')
      ORDER BY id DESC LIMIT 16`)
      .bind(room.chat_id).all<{ id: number; event_type: string; status: string; created_at: string }>(),
    env.DB.prepare(`SELECT batch_key,status,last_error,updated_at FROM tg_chat_inference_runs
      WHERE chat_id=? AND status='attention_required' ORDER BY updated_at DESC LIMIT 12`)
      .bind(room.chat_id).all<{
        batch_key: string;
        status: string;
        last_error: string | null;
        updated_at: string;
      }>(),
    env.DB.prepare(`SELECT id,status,last_error,updated_at FROM tg_agent_outbox
      WHERE chat_id=? AND status IN ('attention_required','send_outcome_unknown')
      ORDER BY updated_at DESC LIMIT 12`)
      .bind(room.chat_id).all<{
        id: string;
        status: string;
        last_error: string | null;
        updated_at: string;
      }>(),
  ]);

  const accepted = Number(loop?.count || 0);
  const attention: AttentionItem[] = [
    ...(inferenceAttention.results || []).map((row) => ({
      kind: "inference" as const,
      id: row.batch_key.slice(0, 16),
      status: row.status,
      errorCode: cleanError(row.last_error),
      updatedAt: row.updated_at,
    })),
    ...(outboxAttention.results || []).map((row) => ({
      kind: "outbox" as const,
      id: row.id,
      status: row.status,
      errorCode: cleanError(row.last_error),
      updatedAt: row.updated_at,
    })),
    ...(shared.summary_status === "attention" ? [{
      kind: "summary" as const,
      id: room.id,
      status: shared.summary_status,
      errorCode: cleanError(shared.last_error_code),
      updatedAt: shared.updated_at,
    }] : []),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 20);

  const recentEvents = [
    ...(audit.results || []).map((row) => ({
      id: `room-audit:${row.id}`,
      ownerDomain: "tgbot.example.com",
      eventType: row.event_type,
      status: "recorded",
      oldRevision: row.old_revision,
      newRevision: row.new_revision,
      createdAt: row.created_at,
    })),
    ...(events.results || []).map((row) => ({
      id: `telegram:${row.id}`,
      ownerDomain: "tgbot.example.com",
      eventType: row.event_type,
      status: row.status,
      oldRevision: null,
      newRevision: null,
      createdAt: row.created_at,
    })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 20);

  return {
    id: room.id,
    householdId: room.household_id,
    chatId: room.chat_id,
    title: room.title,
    chatType: room.chat_type,
    ownerUserId: room.owner_user_id,
    status: room.status,
    revision: room.revision,
    membershipRevision: room.membership_revision,
    topic: {
      policy: room.topic_policy,
      threadKey: room.allowed_thread_key,
      exact: true,
    },
    agents: room.agents.map(projectedAgent),
    routing: {
      globalEnabled: agentRoomsEnabled(env),
      wakePolicy: room.wake_policy,
      targeting: "explicit_mention_or_reply",
      namespace: `tg-room:${room.id}`,
      privateChatIsolated: true,
      privateMemory: "prohibited",
      roomQueue: {
        binding: "TG_ROOM_QUEUE",
        queue: "operia-tg-agent-room",
        configured: Boolean(env.TG_ROOM_QUEUE),
        dedicated: true,
        backlog: {
          status: "unavailable",
          count: null,
          reason: "Cloudflare Queue live backlog is not exposed to the Worker; D1 counts are not substituted.",
        },
      },
    },
    durableState: {
      pendingInbox: Number(inbox?.count || 0),
      inference24h: countMap(runs.results || []),
      outbox24h: countMap(outbox.results || []),
    },
    loopGuard: {
      windowSeconds: AGENT_ROOM_BOT_TURN_WINDOW_SECONDS,
      limit: AGENT_ROOM_BOT_TURN_LIMIT,
      acceptedBotTurns: accepted,
      remaining: Math.max(0, AGENT_ROOM_BOT_TURN_LIMIT - accepted),
      state: accepted >= AGENT_ROOM_BOT_TURN_LIMIT ? "blocked" : "ready",
    },
    attention: {
      count: attention.length,
      items: attention,
      retryPolicy: "manual_review_no_blind_retry",
    },
    recentEvents,
    shared: {
      ownerDomain: "tgbot.example.com",
      privateMemoryConnected: false,
      transcript,
      summary: {
        mode: shared.summary_mode,
        status: shared.summary_status,
        text: shared.summary_text,
        model: shared.summary_model,
        revision: shared.summary_revision,
        controlRevision: shared.control_revision,
        expiresAt: shared.summary_expires_at,
        errorCode: shared.last_error_code,
        updatedAt: shared.updated_at,
      },
      pin: {
        text: shared.pin_text,
        revision: shared.pin_revision,
        ownerOnly: true,
        longTermMemory: false,
        updatedAt: shared.updated_at,
      },
    },
  };
}

export async function listAgentRoomProjections(env: Env) {
  const rooms = await listAgentRooms(env.DB);
  return Promise.all(rooms.map((room) => projectRoom(env, room)));
}

export async function getAgentRoomProjection(env: Env, roomId: string) {
  return (await listAgentRoomProjections(env)).find((room) => room.id === roomId) || null;
}
