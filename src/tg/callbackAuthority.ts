import type { Env } from "../types";
import {
  agentRoomsEnabled,
  getActiveAgentRoom,
  getActiveRoomAgent,
  normalizeRoomThreadKey,
} from "./agentRooms";

export type TelegramCallbackEnvelope = {
  chatId: string;
  chatType?: string;
  threadId?: number | string;
  clickerUserId: string;
  clickerIsBot: boolean;
  messageSenderUserId: string;
  messageSenderIsBot: boolean;
};

export type TelegramCallbackAuthority = {
  ownerId: string;
  chatId: string;
  binding: "private_owner" | "agent_room_owner";
  roomId?: string;
  threadKey: string;
};

export type TelegramCallbackAuthorityResult =
  | { ok: true; authority: TelegramCallbackAuthority }
  | { ok: false; code: "callback_environment_denied" | "callback_owner_required" | "callback_transport_denied" };

export function isLegacyAllowedChat(env: Pick<Env, "TG_ALLOWED_CHAT_IDS">, chatId: string): boolean {
  const raw = env.TG_ALLOWED_CHAT_IDS?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  return raw.split(",").map((part) => part.trim()).includes(chatId);
}

export async function authorizeTelegramCallback(
  env: Pick<Env, "WORKER_ROLE" | "TG_ALLOWED_CHAT_IDS" | "TG_AGENT_OWNER_CHAT_ID" | "TG_AGENT_OWNER_ID" | "TG_AGENT_ROOMS_ENABLED" | "DB">,
  input: TelegramCallbackEnvelope,
): Promise<TelegramCallbackAuthorityResult> {
  if (env.WORKER_ROLE !== "tgbot") return { ok: false, code: "callback_environment_denied" };
  if (!input.clickerUserId || input.clickerIsBot || !input.messageSenderIsBot) {
    return { ok: false, code: "callback_owner_required" };
  }

  if (input.chatType === "private") {
    const configuredOwnerId = env.TG_AGENT_OWNER_ID?.trim();
    const configuredOwnerChatId = env.TG_AGENT_OWNER_CHAT_ID?.trim();
    const expectedOwnerId = configuredOwnerId || input.chatId;
    if (
      !isLegacyAllowedChat(env, input.chatId)
      || input.chatId !== input.clickerUserId
      || input.clickerUserId !== expectedOwnerId
      || (configuredOwnerChatId && configuredOwnerChatId !== input.chatId)
    ) return { ok: false, code: "callback_owner_required" };
    return {
      ok: true,
      authority: { ownerId: input.clickerUserId, chatId: input.chatId, binding: "private_owner", threadKey: "private" },
    };
  }

  if (!agentRoomsEnabled(env) || !["group", "supergroup"].includes(input.chatType ?? "")) {
    return { ok: false, code: "callback_transport_denied" };
  }
  const room = await getActiveAgentRoom(env.DB, input.chatId);
  const threadKey = normalizeRoomThreadKey(input.threadId);
  if (!room || room.chat_type !== input.chatType || !threadKey || threadKey !== room.allowed_thread_key) {
    return { ok: false, code: "callback_transport_denied" };
  }
  const configuredOwnerId = env.TG_AGENT_OWNER_ID?.trim();
  if (input.clickerUserId !== room.owner_user_id || (configuredOwnerId && configuredOwnerId !== room.owner_user_id)) {
    return { ok: false, code: "callback_owner_required" };
  }
  const localAgent = await getActiveRoomAgent(env.DB, room.id, input.messageSenderUserId);
  if (!localAgent || localAgent.runtime_kind !== "operia_worker" || localAgent.transport_owner !== "<TG_SERVICE>") {
    return { ok: false, code: "callback_transport_denied" };
  }
  return {
    ok: true,
    authority: {
      ownerId: room.owner_user_id,
      chatId: room.chat_id,
      binding: "agent_room_owner",
      roomId: room.id,
      threadKey,
    },
  };
}
