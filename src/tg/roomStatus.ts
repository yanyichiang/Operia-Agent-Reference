import type { Env } from "../types";
import { AGENT_ROOM_BOT_TURN_LIMIT, AGENT_ROOM_BOT_TURN_WINDOW_SECONDS, type TgAgentRoom } from "./agentRooms";
import { tgApi } from "./telegram";

type RoomStatusActorKind = "owner" | "agent";
type RoomStatusResult = "sent" | "arguments_rejected";

function explicitThreadId(threadKey: string): number | null {
  if (threadKey === "general") return null;
  const match = /^topic:([1-9]\d*)$/.exec(threadKey);
  const threadId = match ? Number(match[1]) : null;
  return threadId != null && Number.isSafeInteger(threadId) && threadId >= 2 ? threadId : null;
}

async function sendRoomStatusText(env: Env, room: TgAgentRoom, threadKey: string, text: string): Promise<void> {
  const threadId = explicitThreadId(threadKey);
  const response = await tgApi(env, "sendMessage", {
    chat_id: room.chat_id,
    text,
    ...(threadId == null ? {} : { message_thread_id: threadId }),
  });
  if (!response.ok) throw new Error(`tg room status send failed (${response.status})`);
}

export async function sendSandboxControlMessage(
  env: Env,
  chatId: string,
  threadKey: string,
  text: string,
  rows?: Array<Array<{ text: string; callback_data: string }>>,
): Promise<void> {
  const threadId = explicitThreadId(threadKey);
  const response = await tgApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(threadId == null ? {} : { message_thread_id: threadId }),
    ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}),
  });
  if (!response.ok) throw new Error(`tg sandbox control send failed (${response.status})`);
}

/**
 * Deterministic, room-bounded status. This path may only read the room registry
 * and its loop counter; it never calls Agent/Memory services or writes TG
 * presentation settings, audit rows, inbox rows, or conversation state.
 */
export async function sendAgentRoomStatus(env: Env, input: {
  room: TgAgentRoom;
  threadKey: string;
  actorKind: RoomStatusActorKind;
  args: string;
}): Promise<RoomStatusResult> {
  if (input.threadKey !== input.room.allowed_thread_key || !["owner", "agent"].includes(input.actorKind)) {
    throw new Error("agent_room_status_context_invalid");
  }
  if (input.args.trim()) {
    await sendRoomStatusText(env, input.room, input.threadKey, "QA Room 的 /status 仅支持无参数只读状态；progress、blocks、usage、tasks 与 health 均不可在房间内使用。");
    return "arguments_rejected";
  }

  const [agents, recent] = await Promise.all([
    env.DB.prepare(`SELECT bot_name,status FROM tg_agent_room_agents
      WHERE room_id=? AND status!='removed' ORDER BY created_at`)
      .bind(input.room.id).all<{ bot_name: string; status: string }>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM tg_agent_room_audit
      WHERE room_id=? AND event_type='bot.message.accepted' AND created_at>=datetime('now','-2 minutes')`)
      .bind(input.room.id).first<{ count: number }>(),
  ]);
  const agentLines = (agents.results ?? []).slice(0, 12).map((agent) => {
    const name = agent.bot_name.replace(/\s+/g, " ").trim().slice(0, 80) || "Registered Agent";
    return `- ${name}：${agent.status}`;
  });
  const requester = input.actorKind === "owner" ? "Owner" : "Registered Agent";
  await sendRoomStatusText(env, input.room, input.threadKey, [
    "Agent QA Room 状态",
    "",
    `Room：${input.room.status}`,
    `Thread：${input.threadKey}`,
    `Wake：${input.room.wake_policy}`,
    `Requester：${requester}`,
    `Loop：${Number(recent?.count ?? 0)}/${AGENT_ROOM_BOT_TURN_LIMIT} accepted bot turns / ${AGENT_ROOM_BOT_TURN_WINDOW_SECONDS}s`,
    "Agents：",
    ...(agentLines.length ? agentLines : ["- 无已登记 Agent"]),
  ].join("\n"));
  return "sent";
}
