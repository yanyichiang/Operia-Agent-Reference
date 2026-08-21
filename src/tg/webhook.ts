import { enqueueTgProcessFromWebhook } from "../queue/producer";
import type { Env } from "../types";
import { insertInbox } from "./state";
import { applyPendingCapabilitySelection, applyPendingMcpNaturalSelection, handleCommand, parseCommand } from "./commands";
import { handleCallback } from "./callbacks";
import { answerCallbackQuery, sendChatAction } from "./telegram";
import { getTelegramAudio } from "./voice";
import { upsertObservedSticker } from "./stickerCatalog";
import { initialTgQueueDelaySeconds } from "./scheduling";
import { getTelegramImage, hasUnsupportedTelegramImageDocument } from "./image";
import { recordTgEvent } from "./settings";
import { AGENT_ROOM_BOT_TURN_LIMIT, agentRoomsEnabled, getActiveAgentRoom, getActiveRoomAgent, normalizeRoomThreadKey, type TgAgentRoom, type TgRoomAgent } from "./agentRooms";
import { sendAgentRoomStatus } from "./roomStatus";
import { sendSandboxControlMessage } from "./roomStatus";
import { controlAgentSandbox } from "./agentClient";
import { observeRoomMessage, queueRoomSummaryIfNeeded } from "./roomSharedState";
import { authorizeTelegramCallback, isLegacyAllowedChat } from "./callbackAuthority";

type TgReactionType = { type?: string; emoji?: string; custom_emoji_id?: string };
type TgReplyMessage = {
  message_id?: number;
  text?: string;
  caption?: string;
  from?: { id?: number; is_bot?: boolean; first_name?: string; username?: string };
};
type TgMessageEntity = { type?:string; offset?:number; length?:number; user?:{id?:number;is_bot?:boolean} };

interface TgUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    caption?: string;
    media_group_id?: string;
    entities?: TgMessageEntity[];
    message_thread_id?: number;
    from?: { id?: number; is_bot?: boolean };
    chat?: { id?: number | string; type?: string };
    photo?: Array<{ file_id?: string; file_unique_id?: string; file_size?: number; width?: number; height?: number }>;
    document?: { file_id?: string; file_unique_id?: string; mime_type?: string; file_size?: number; file_name?: string; width?: number; height?: number };
    voice?: { file_id?: string; file_unique_id?: string; duration?: number; mime_type?: string; file_size?: number };
    audio?: { file_id?: string; file_unique_id?: string; duration?: number; mime_type?: string; file_size?: number; file_name?: string };
    sticker?: { file_id?: string; file_unique_id?: string; emoji?: string; set_name?: string; type?: string };
    reply_to_message?: TgReplyMessage;
  };
  message_reaction?: {
    chat?: { id?: number | string; type?: string };
    message_id?: number;
    user?: { id?: number; is_bot?: boolean };
    old_reaction?: TgReactionType[];
    new_reaction?: TgReactionType[];
    date?: number;
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number; is_bot?: boolean };
    message?: {
      message_id?: number | string;
      message_thread_id?: number;
      from?: { id?: number; is_bot?: boolean };
      chat?: { id?: number | string; type?: string };
    };
  };
}

export function isChatAllowed(env: Env, chatId: string): boolean {
  return isLegacyAllowedChat(env, chatId);
}

function replyContext(message: TgReplyMessage | undefined): Record<string, unknown> | undefined {
  if (!message || !Number.isInteger(message.message_id)) return undefined;
  const excerpt = (message.text || message.caption || "").replace(/\s+/g, " ").trim().slice(0, 280);
  return {
    messageId: message.message_id,
    excerpt,
    author: message.from?.is_bot ? "assistant" : "owner",
  };
}

export function normalizeInboundReactions(reactions: TgReactionType[] | undefined): Array<Record<string, string>> {
  if (!Array.isArray(reactions)) return [];
  return reactions.flatMap((reaction) => {
    if (reaction?.type === "emoji" && reaction.emoji) return [{ type: "emoji", emoji: reaction.emoji }];
    if (reaction?.type === "custom_emoji" && reaction.custom_emoji_id) return [{ type: "custom_emoji", customEmojiId: reaction.custom_emoji_id }];
    if (reaction?.type === "paid") return [{ type: "paid" }];
    return [];
  });
}

function entityText(text:string,entity:TgMessageEntity):string{
  if(!Number.isInteger(entity.offset)||!Number.isInteger(entity.length)||Number(entity.offset)<0||Number(entity.length)<=0) return "";
  return text.slice(Number(entity.offset),Number(entity.offset)+Number(entity.length));
}

export function targetsRoomAgent(text:string,entities:TgMessageEntity[]|undefined,reply:TgReplyMessage|undefined,agent:TgRoomAgent):boolean{
  if(reply?.from?.is_bot&&String(reply.from.id)===agent.bot_user_id) return true;
  const username=agent.bot_username?.toLowerCase();
  return (entities||[]).some((entity)=>{
    if(entity.type==="text_mention") return entity.user?.is_bot===true&&String(entity.user.id)===agent.bot_user_id;
    if((entity.type==="mention"||entity.type==="bot_command")&&username){
      const raw=entityText(text,entity).toLowerCase();
      return raw.endsWith(`@${username}`);
    }
    return false;
  });
}

async function groupRoute(env:Env,message:NonNullable<TgUpdate["message"]>):Promise<{room:TgAgentRoom;agent:TgRoomAgent;threadKey:string;actorKind:"owner"|"agent";sourceBotUserId:string|null}|null>{
  if(!agentRoomsEnabled(env)) return null;
  const chatId=String(message.chat?.id??"");
  const room=await getActiveAgentRoom(env.DB,chatId);
  if(!room||room.wake_policy==="off"||room.topic_policy==="off") return null;
  const threadKey=normalizeRoomThreadKey(message.message_thread_id);
  if(!threadKey||threadKey!==room.allowed_thread_key) return null;
  const actorUserId=String(message.from?.id??"");
  let actorKind:"owner"|"agent"="owner"; let sourceBotUserId:string|null=null;
  if(actorUserId!==room.owner_user_id){
    if(!message.from?.is_bot)return null;
    const source=await getActiveRoomAgent(env.DB,room.id,actorUserId);
    if(!source||source.runtime_kind==="operia_worker")return null;
    const recent=await env.DB.prepare(`SELECT COUNT(*) AS count FROM tg_agent_room_audit
      WHERE room_id=? AND event_type='bot.message.accepted' AND created_at>=datetime('now','-2 minutes')`)
      .bind(room.id).first<{count:number}>();
    if(Number(recent?.count||0)>=AGENT_ROOM_BOT_TURN_LIMIT)return null;
    actorKind="agent";sourceBotUserId=source.bot_user_id;
  }
  const agent=await env.DB.prepare(`SELECT * FROM tg_agent_room_agents
    WHERE room_id=? AND runtime_kind='operia_worker' AND status='active' ORDER BY created_at LIMIT 1`)
    .bind(room.id).first<TgRoomAgent>();
  if(!agent||!targetsRoomAgent(message.text||"",message.entities,message.reply_to_message,agent)) return null;
  return {room,agent,threadKey,actorKind,sourceBotUserId};
}

async function scheduleChatProcessing(env: Env, chatId: string, ctx?: ExecutionContext): Promise<void> {
  await enqueueTgProcessFromWebhook(env,chatId,initialTgQueueDelaySeconds(env));
  if (ctx) ctx.waitUntil(sendChatAction(env,chatId,"typing").catch(() => undefined));
}

/**
 * Telegram webhook entry. Always answers 200 for handled-but-ignored updates —
 * any non-200 makes Telegram redeliver the same update forever.
 */
export async function handleTelegramWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!env.TG_BOT_TOKEN?.trim()) {
    console.error("tg: webhook hit but TG_BOT_TOKEN is not configured");
    return new Response("telegram bot not configured", { status: 503 });
  }

  const expectedSecret = env.TG_WEBHOOK_SECRET?.trim();
  const gotSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!expectedSecret || gotSecret !== expectedSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const callback = update.callback_query;
  const callbackChatId = callback?.message?.chat?.id;
  if (callback?.id && callback.data && callbackChatId != null) {
    const chatId = String(callbackChatId);
    const ownerId = callback.from?.id != null ? String(callback.from.id) : "";
    const authority = await authorizeTelegramCallback(env, {
      chatId,
      chatType: callback.message?.chat?.type,
      threadId: callback.message?.message_thread_id,
      clickerUserId: ownerId,
      clickerIsBot: callback.from?.is_bot === true,
      messageSenderUserId: callback.message?.from?.id != null ? String(callback.message.from.id) : "",
      messageSenderIsBot: callback.message?.from?.is_bot === true,
    });
    if (!authority.ok) {
      await answerCallbackQuery(env, callback.id, "此操作只允许 Owner 在已绑定会话中执行");
      return new Response("ok");
    }
    await handleCallback(env, {
      callbackQueryId: callback.id,
      ownerId,
      chatId,
      data: callback.data,
      authority: authority.authority,
      ...(callback.message?.message_id != null ? { messageId: String(callback.message.message_id) } : {}),
    });
    return new Response("ok");
  }

  const reaction = update.message_reaction;
  const reactionChatIdRaw = reaction?.chat?.id;
  if (reaction && reactionChatIdRaw != null && Number.isInteger(reaction.message_id) && !reaction.user?.is_bot) {
    const chatId = String(reactionChatIdRaw);
    if (reaction.chat?.type === "group" || reaction.chat?.type === "supergroup") return new Response("ok");
    if (!isChatAllowed(env, chatId)) return new Response("ok");
    await insertInbox(env.DB, {
      chatId,
      updateId: update.update_id,
      text: "",
      kind: "reaction",
      payload: {
        targetMessageId: reaction.message_id,
        oldReaction: normalizeInboundReactions(reaction.old_reaction),
        newReaction: normalizeInboundReactions(reaction.new_reaction),
      },
    });
    await scheduleChatProcessing(env, chatId, ctx);
    return new Response("ok");
  }

  const message = update.message;
  let text = message?.text?.trim();
  const caption = message?.caption?.trim();
  const audio = getTelegramAudio(message);
  const image = getTelegramImage(message);
  const unsupportedImageDocument = hasUnsupportedTelegramImageDocument(message);
  const sticker = message?.sticker;
  const chatIdRaw = message?.chat?.id;
  if (!message || (!text && !audio && !image && !unsupportedImageDocument && !(sticker?.file_id && sticker.file_unique_id)) || chatIdRaw == null) {
    // edits, joins, channel posts, bot echoes — acknowledge and drop
    return new Response("ok");
  }

  const chatId = String(chatIdRaw);
  const isGroup=message.chat?.type==="group"||message.chat?.type==="supergroup";
  let roomRoute:{room:TgAgentRoom;agent:TgRoomAgent;threadKey:string;actorKind:"owner"|"agent";sourceBotUserId:string|null}|null=null;
  if(isGroup){
    if(!text)return new Response("ok");
    const observedRoom=agentRoomsEnabled(env)?await getActiveAgentRoom(env.DB,chatId):null;
    const observedThread=normalizeRoomThreadKey(message.message_thread_id);
    if(observedRoom&&observedRoom.wake_policy==="mention_or_reply"&&observedRoom.topic_policy==="exact"
      &&observedThread===observedRoom.allowed_thread_key){
      try{
        const recorded=await observeRoomMessage(env,{
          room:observedRoom,threadKey:observedThread,updateId:update.update_id,messageId:message.message_id,text,
          actorUserId:String(message.from?.id??""),actorIsBot:message.from?.is_bot===true,
          entitiesTarget:(agent)=>targetsRoomAgent(text||"",message.entities,message.reply_to_message,agent),
          replyAuthorId:message.reply_to_message?.from?.id==null?null:String(message.reply_to_message.from.id),
        });
        if(recorded){
          const summarize=queueRoomSummaryIfNeeded(env,observedRoom.id,observedThread).catch(()=>undefined);
          if(ctx)ctx.waitUntil(summarize);else await summarize;
        }
      }catch{
        // Shared transcript/summary projection must never turn a valid
        // Telegram update into a redelivery or block exact room routing.
      }
    }
    roomRoute=await groupRoute(env,message);
    if(!roomRoute) return new Response("ok");
  }else if(message.from?.is_bot){
    return new Response("ok");
  }
  if (!isChatAllowed(env, chatId)) {
    if(roomRoute){ /* Active room registry supersedes the legacy private-chat allowlist. */ }
    else {
    // Silent drop: no reply that would let strangers probe the bot. The owner
    // copies their chat_id from this log line into TG_ALLOWED_CHAT_IDS.
    console.log("tg: message from non-allowlisted chat dropped", { chatId });
    return new Response("ok");
    }
  }

  let command = text ? parseCommand(text) : null;
  if (command) {
    if(roomRoute&&command.name==="qa"&&command.args){text=command.args;command=null;}
    else if(roomRoute&&command.name==="status"){
      await sendAgentRoomStatus(env,{room:roomRoute.room,threadKey:roomRoute.threadKey,actorKind:roomRoute.actorKind,args:command.args});
      return new Response("ok");
    }
    else if(roomRoute&&(command.name==="pause"||command.name==="resume")){
      if(roomRoute.actorKind!=="owner"||command.args)return new Response("ok");
      const authority={ownerId:roomRoute.room.owner_user_id,chatId:roomRoute.room.chat_id,threadKey:roomRoute.threadKey,authorityBinding:"agent_room_owner" as const};
      if(command.name==="pause"){
        const result=await controlAgentSandbox(env,authority,"pause");
        await sendSandboxControlMessage(env,chatId,roomRoute.threadKey,result.alreadyPaused
          ?"Operia 已经处于全局暂停状态。"
          :`Operia 已全局暂停。已冻结 ${result.control.activeTasks} 个任务；恢复需要 /resume 后再次确认。`);
      }else{
        const result=await controlAgentSandbox(env,authority,"prepare_resume");
        if(result.alreadyRunning)await sendSandboxControlMessage(env,chatId,roomRoute.threadKey,"Operia 当前没有全局暂停。");
        else if(result.nonce)await sendSandboxControlMessage(env,chatId,roomRoute.threadKey,
          `准备恢复工具调用。冻结任务 ${result.control.activeTasks} 个，待审批 ${result.control.pendingApprovals} 个，未知/隔离结果 ${result.control.unknownSideEffects} 个。`,[[{text:"确认恢复",callback_data:`sandboxctl:resume:${result.nonce}`}]]);
      }
      return new Response("ok");
    }
    else if(roomRoute) return new Response("ok");
  }
  if(command){
    const commandRequestId = update.update_id != null
      ? `update-${update.update_id}`
      : `message-${chatId}-${message.message_id}`;
    await handleCommand(env, chatId, command, commandRequestId);
    return new Response("ok");
  }

  const reply = replyContext(message.reply_to_message);
  const effectiveText = text && !audio && !image ? (roomRoute ? text
    : await applyPendingMcpNaturalSelection(env,chatId,await applyPendingCapabilitySelection(env,chatId,text))) : text;
  if(roomRoute?.actorKind==="agent")await env.DB.prepare(`INSERT INTO tg_agent_room_audit
    (room_id,actor_user_id,event_type,target_id,new_revision,metadata_json,created_at) VALUES (?,?, 'bot.message.accepted',?,?,?,?)`)
    .bind(roomRoute.room.id,roomRoute.sourceBotUserId,roomRoute.agent.bot_user_id,roomRoute.room.revision,
      JSON.stringify({messageId:message.message_id??null}),new Date().toISOString()).run();
  if (sticker?.file_id && sticker.file_unique_id) {
    await upsertObservedSticker(env.DB, {
      fileId: sticker.file_id,
      fileUniqueId: sticker.file_unique_id,
      ...(sticker.set_name ? { setName: sticker.set_name } : {}),
      ...(sticker.emoji ? { emoji: sticker.emoji } : {}),
    });
    await insertInbox(env.DB, { chatId, messageId: message.message_id, updateId: update.update_id, text: "", kind: "sticker", payload: {
      fileId: sticker.file_id,
      fileUniqueId: sticker.file_unique_id,
      setName: sticker.set_name ?? null,
      emoji: sticker.emoji ?? null,
      stickerType: sticker.type ?? null,
      reply,
    } });
  } else if (unsupportedImageDocument && message.document?.file_id) {
    await insertInbox(env.DB, { chatId, messageId: message.message_id, updateId: update.update_id, text: caption ?? "", kind: "image", payload: {
      fileId: message.document.file_id,
      uniqueId: message.document.file_unique_id ?? "",
      mimeType: message.document.mime_type?.slice(0, 80) ?? "image/unsupported",
      fileSize: message.document.file_size ?? null,
      width: null,
      height: null,
      fileName: message.document.file_name?.slice(0, 160) ?? "unsupported-image",
      mediaGroupId: message.media_group_id?.slice(0, 128) ?? null,
      reply,
    } });
  } else if (image) {
    await insertInbox(env.DB, { chatId, messageId: message.message_id, updateId: update.update_id, text: caption ?? "", kind: "image", payload: {
      fileId: image.fileId,
      uniqueId: image.uniqueId,
      mimeType: image.mimeType,
      fileSize: image.fileSize ?? null,
      width: image.width ?? null,
      height: image.height ?? null,
      fileName: image.fileName,
      mediaGroupId: message.media_group_id?.slice(0, 128) ?? null,
      reply,
    }, ...(caption ? { heartbeatActivity: {
      eventKey: update.update_id != null ? `tg:update:${update.update_id}` : `tg:message:${chatId}:${message.message_id}`,
      kind: "natural_text" as const,
    } } : {}) });
    try {
      await recordTgEvent(env.DB, { chatId, eventType: "image.accepted", status: "queued", metadata: {
        updateId: update.update_id ?? null,
        messageId: message.message_id ?? null,
        mediaGroup: Boolean(message.media_group_id),
        mimeType: image.mimeType,
        declaredBytes: image.fileSize ?? null,
      } });
    } catch {
      // Observability must never turn an accepted image into a webhook retry.
    }
  } else if (audio) {
    await insertInbox(env.DB, { chatId, messageId: message.message_id, updateId: update.update_id, text: "", kind: audio.kind, payload: {
      ...(audio as unknown as Record<string, unknown>),
      reply,
    } });
  } else {
    await insertInbox(env.DB, { chatId, messageId: message.message_id, updateId: update.update_id, text: effectiveText ?? "", kind: "text",
      payload: { reply, ...(roomRoute ? {
        room:{ id:roomRoute.room.id,audience:roomRoute.room.audience,threadKey:roomRoute.threadKey,
          actorUserId:String(message.from?.id??""),actorKind:roomRoute.actorKind,sourceBotUserId:roomRoute.sourceBotUserId,
          targetBotUserId:roomRoute.agent.bot_user_id },
      } : {}) },
      ...(!roomRoute ? {heartbeatActivity: {
        eventKey: update.update_id != null ? `tg:update:${update.update_id}` : `tg:message:${chatId}:${message.message_id}`,
        kind: "natural_text",
      }} : {}) });
  }
  await scheduleChatProcessing(env, chatId, ctx);

  return new Response("ok");
}
