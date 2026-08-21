import type { Env } from "../types";
import { tgApi } from "./telegram";

export const AGENT_ROOM_BOT_TURN_LIMIT = 5;
export const AGENT_ROOM_BOT_TURN_WINDOW_SECONDS = 120;

export type TgAgentRoom = {
  id:string; household_id:string; chat_id:string; title:string; chat_type:"group"|"supergroup";
  owner_user_id:string; status:"active"|"suspended"|"removed"; wake_policy:"mention_or_reply"|"off";
  topic_policy:"exact"|"off"; allowed_thread_key:string; audience:"owner_debug_shared";
  membership_revision:number; revision:number; created_at:string; updated_at:string;
};

export function agentRoomsEnabled(env:Pick<Env,"TG_AGENT_ROOMS_ENABLED">):boolean{
  return env.TG_AGENT_ROOMS_ENABLED?.trim().toLowerCase()==="true";
}

export function normalizeRoomThreadKey(value: unknown): string | null {
  // Telegram's built-in General forum topic uses message_thread_id=1. Older
  // non-forum/group updates may omit the field or surface 0, so all three
  // representations belong to one stable room key.
  if (value == null || value === 0 || value === "0" || value === 1 || value === "1") return "general";
  const threadId = Number(value);
  return Number.isSafeInteger(threadId) && threadId >= 2 ? `topic:${threadId}` : null;
}

export async function loadAgentRoomTurns(
  db:D1Database, roomId:string, threadKey:string,
):Promise<Array<{role:"user"|"assistant";content:string}>>{
  await db.prepare("DELETE FROM tg_agent_room_turns WHERE expires_at<=?").bind(new Date().toISOString()).run();
  const rows=await db.prepare(`SELECT user_text,assistant_text FROM tg_agent_room_turns
    WHERE room_id=? AND thread_key=? AND expires_at>? ORDER BY created_at DESC LIMIT 4`)
    .bind(roomId,threadKey,new Date().toISOString()).all<{user_text:string;assistant_text:string}>();
  return [...(rows.results||[])].reverse().flatMap((row)=>[
    {role:"user" as const,content:row.user_text},
    ...(row.assistant_text.trim() ? [{role:"assistant" as const,content:row.assistant_text}] : []),
  ]);
}

export async function appendAgentRoomTurn(db:D1Database,input:{
  roomId:string;threadKey:string;batchKey:string;userText:string;assistantText:string;
}):Promise<void>{
  const now=new Date();
  const expiresAt=new Date(now.getTime()+2*60*60*1000).toISOString();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO tg_agent_room_turns
      (room_id,thread_key,batch_key,user_text,assistant_text,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(input.roomId,input.threadKey,input.batchKey,input.userText.slice(0,12000),input.assistantText.slice(0,12000),expiresAt,now.toISOString()),
    db.prepare("DELETE FROM tg_agent_room_turns WHERE expires_at<=?").bind(now.toISOString()),
    db.prepare(`DELETE FROM tg_agent_room_turns WHERE room_id=? AND thread_key=? AND id NOT IN (
      SELECT id FROM tg_agent_room_turns WHERE room_id=? AND thread_key=? ORDER BY created_at DESC LIMIT 4
    )`).bind(input.roomId,input.threadKey,input.roomId,input.threadKey),
  ]);
}

export type TgRoomAgent = {
  id:string; room_id:string; bot_user_id:string; bot_name:string; bot_username:string|null;
  runtime_kind:"operia_worker"|"cc_connect"; transport_owner:string;
  status:"active"|"suspended"|"removed"; membership_status:string; membership_revision:number;
  bot_to_bot_mode:"unknown"|"off"|"enabled";
  revision:number; verified_at:string; created_at:string; updated_at:string;
};

type TelegramUser = { id?:number|string; is_bot?:boolean; first_name?:string; username?:string };
type TelegramMember = { status?:string; user?:TelegramUser };

async function telegramResult<T>(env:Env,method:string,payload:Record<string,unknown>):Promise<T>{
  const response=await tgApi(env,method,payload);
  const body=await response.json() as {ok?:boolean;result?:T;description?:string};
  if(!response.ok||body.ok!==true||body.result==null) throw new Error(`telegram_${method}_failed:${String(body.description||response.status).slice(0,120)}`);
  return body.result;
}

function numericId(value:unknown,label:string):string{
  const normalized=String(value??"").trim();
  if(!/^-?[1-9]\d*$/.test(normalized)) throw new Error(`${label}_invalid`);
  return normalized;
}

function activeMember(status:string|undefined):boolean{
  return ["creator","administrator","member","restricted"].includes(status||"");
}

function adminMember(status:string|undefined):boolean{
  return status==="creator"||status==="administrator";
}

function normalizeName(value:unknown):string{
  const name=String(value??"").replace(/\s+/g," ").trim();
  if(!name||name.length>80) throw new Error("bot_name_invalid");
  return name;
}

export async function getActiveAgentRoom(db:D1Database,chatId:string):Promise<TgAgentRoom|null>{
  return db.prepare("SELECT * FROM tg_agent_rooms WHERE chat_id=? AND status='active'").bind(chatId).first<TgAgentRoom>();
}

export async function getActiveRoomAgent(db:D1Database,roomId:string,botUserId:string):Promise<TgRoomAgent|null>{
  return db.prepare("SELECT * FROM tg_agent_room_agents WHERE room_id=? AND bot_user_id=? AND status='active'")
    .bind(roomId,botUserId).first<TgRoomAgent>();
}

export async function listAgentRooms(db:D1Database):Promise<Array<TgAgentRoom&{agents:TgRoomAgent[]}>>{
  const [rooms,agents]=await Promise.all([
    db.prepare("SELECT * FROM tg_agent_rooms WHERE status!='removed' ORDER BY created_at").all<TgAgentRoom>(),
    db.prepare("SELECT * FROM tg_agent_room_agents WHERE status!='removed' ORDER BY created_at").all<TgRoomAgent>(),
  ]);
  return (rooms.results||[]).map((room)=>({...room,agents:(agents.results||[]).filter((agent)=>agent.room_id===room.id)}));
}

export async function buildAgentRoomRegistryContext(db:D1Database,roomId:string):Promise<string|null>{
  const rows=await db.prepare(`SELECT bot_name,bot_username,runtime_kind FROM tg_agent_room_agents
    WHERE room_id=? AND status='active' ORDER BY runtime_kind`).bind(roomId)
    .all<Pick<TgRoomAgent,"bot_name"|"bot_username"|"runtime_kind">>();
  const agents=rows.results||[];
  const operia=agents.find((agent)=>agent.runtime_kind==="operia_worker");
  const codex=agents.find((agent)=>agent.runtime_kind==="cc_connect");
  if(!operia||!codex)return null;
  const label=(agent:typeof operia)=>`${agent.bot_name}${agent.bot_username?` (@${agent.bot_username})`:""}`;
  return [
    "[Agent room registry — dynamic presentation context]",
    `Local agent: ${label(operia)}. Owner may call this agent Operia or O老师.`,
    `Peer agent: ${label(codex)}. Owner may call this agent Codex, Cody or C老师.`,
    "Aliases are friendly display names only; identity and authorization still require the registered Telegram Bot ID and exact room registry.",
    `A direct @mention or a reply to a registered agent message is an explicit target. The room loop guard allows at most ${AGENT_ROOM_BOT_TURN_LIMIT} accepted agent-origin turns in ${AGENT_ROOM_BOT_TURN_WINDOW_SECONDS} seconds.`,
    "Use reply-to and ordinary reactions only for current interaction-context message IDs. They are Telegram presentation actions, not Memory, MCP or Agent authority.",
    "Remain friendly colleagues. Do not start autonomous social, romantic or relationship role-play, and do not keep chatting without an owner-directed task.",
  ].join("\n");
}

export async function createAgentRoom(env:Env,input:{chatId:unknown;ownerUserId:unknown;threadId?:unknown}):Promise<TgAgentRoom>{
  const chatId=numericId(input.chatId,"chat_id");
  const ownerUserId=numericId(input.ownerUserId,"owner_user_id");
  const chat=await telegramResult<{id?:number|string;title?:string;type?:string;is_forum?:boolean}>(env,"getChat",{chat_id:chatId});
  if(String(chat.id)!==chatId||!(chat.type==="group"||chat.type==="supergroup")) throw new Error("room_must_be_telegram_group");
  const allowedThreadKey=normalizeRoomThreadKey(input.threadId);
  if(!allowedThreadKey) throw new Error("room_thread_id_invalid");
  if(allowedThreadKey!=="general"&&!(chat.type==="supergroup"&&chat.is_forum)) throw new Error("room_topic_requires_forum_supergroup");
  const botIdentity=await telegramResult<TelegramUser>(env,"getMe",{});
  const [ownerMembership,botMembership]=await Promise.all([
    telegramResult<TelegramMember>(env,"getChatMember",{chat_id:chatId,user_id:ownerUserId}),
    telegramResult<TelegramMember>(env,"getChatMember",{chat_id:chatId,user_id:botIdentity.id}),
  ]);
  if(!adminMember(ownerMembership.status)) throw new Error("operia_owner_must_be_group_admin");
  if(!botIdentity.is_bot||!adminMember(botMembership.status)) throw new Error("operia_must_be_group_admin");
  const now=new Date().toISOString(); const roomId=`room_${crypto.randomUUID().replaceAll("-","")}`;
  const householdId=`household_${crypto.randomUUID().replaceAll("-","")}`;
  const title=String(chat.title||"Telegram Agent Room").slice(0,160);
  const botUserId=numericId(botIdentity.id,"bot_user_id"); const botName=normalizeName(botIdentity.first_name);
  const botUsername=botIdentity.username?.trim()||null;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO tg_agent_rooms
      (id,household_id,chat_id,title,chat_type,owner_user_id,status,wake_policy,topic_policy,allowed_thread_key,audience,membership_revision,revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'active','off','exact',?,'owner_debug_shared',1,1,?,?)`)
      .bind(roomId,householdId,chatId,title,chat.type,ownerUserId,allowedThreadKey,now,now),
    env.DB.prepare(`INSERT INTO tg_agent_room_agents
      (id,room_id,bot_user_id,bot_name,bot_username,runtime_kind,transport_owner,status,membership_status,membership_revision,revision,verified_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'operia_worker','<TG_SERVICE>','active',?,1,1,?,?,?)`)
      .bind(`agent_${crypto.randomUUID().replaceAll("-","")}`,roomId,botUserId,botName,botUsername,botMembership.status||"administrator",now,now,now),
    env.DB.prepare(`INSERT INTO tg_agent_room_audit(room_id,actor_user_id,event_type,target_id,new_revision,metadata_json,created_at)
      VALUES (?,?, 'room.created',?,1,?,?)`).bind(roomId,ownerUserId,chatId,JSON.stringify({chatType:chat.type,isForum:Boolean(chat.is_forum),threadKey:allowedThreadKey}),now),
  ]);
  const room=await getActiveAgentRoom(env.DB,chatId); if(!room) throw new Error("room_create_failed"); return room;
}

export async function addAgentToRoom(env:Env,input:{roomId:unknown;botUserId:unknown;botName:unknown;runtimeKind:unknown;revision:unknown},actorUserId:string):Promise<TgRoomAgent>{
  const roomId=String(input.roomId||""); const expectedRevision=Number(input.revision);
  const room=await env.DB.prepare("SELECT * FROM tg_agent_rooms WHERE id=? AND status='active'").bind(roomId).first<TgAgentRoom>();
  if(!room) throw new Error("room_not_found");
  if(actorUserId!==room.owner_user_id) throw new Error("room_owner_required");
  if(!Number.isInteger(expectedRevision)||expectedRevision!==room.revision) throw new Error("room_revision_conflict");
  const botUserId=numericId(input.botUserId,"bot_user_id"); const submittedName=normalizeName(input.botName);
  const runtimeKind=String(input.runtimeKind||"");
  if(runtimeKind!=="cc_connect") throw new Error("only_codex_cc_connect_is_allowed");
  const existing=await env.DB.prepare("SELECT runtime_kind,status FROM tg_agent_room_agents WHERE room_id=? AND status!='removed'")
    .bind(room.id).all<{runtime_kind:string;status:string}>();
  if((existing.results||[]).length!==1||(existing.results||[])[0]?.runtime_kind!=="operia_worker") throw new Error("room_agent_pair_already_fixed");
  const membership=await telegramResult<TelegramMember>(env,"getChatMember",{chat_id:room.chat_id,user_id:botUserId});
  if(!activeMember(membership.status)||!membership.user?.is_bot||String(membership.user.id)!==botUserId) throw new Error("telegram_bot_membership_invalid");
  const liveName=normalizeName(membership.user.first_name);
  const liveUsername=membership.user.username?.trim()||null;
  if(submittedName!==liveName&&submittedName!==liveUsername&&submittedName!==`@${liveUsername}`) throw new Error("bot_name_does_not_match_telegram");
  const now=new Date().toISOString(); const nextRevision=room.revision+1; const membershipRevision=room.membership_revision+1;
  const agentId=`agent_${crypto.randomUUID().replaceAll("-","")}`;
  const update=env.DB.prepare(`UPDATE tg_agent_rooms SET revision=?,membership_revision=?,updated_at=? WHERE id=? AND revision=?`)
    .bind(nextRevision,membershipRevision,now,room.id,expectedRevision);
  const insert=env.DB.prepare(`INSERT INTO tg_agent_room_agents
    (id,room_id,bot_user_id,bot_name,bot_username,runtime_kind,transport_owner,status,membership_status,membership_revision,revision,verified_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'active',?,?,1,?,?,?)`)
    .bind(agentId,room.id,botUserId,liveName,liveUsername,runtimeKind,runtimeKind,membership.status||"member",membershipRevision,now,now,now);
  const results=await env.DB.batch([update,insert,env.DB.prepare(`INSERT INTO tg_agent_room_audit
    (room_id,actor_user_id,event_type,target_id,old_revision,new_revision,metadata_json,created_at) VALUES (?,?, 'agent.added',?,?,?,?,?)`)
    .bind(room.id,actorUserId,botUserId,room.revision,nextRevision,JSON.stringify({runtimeKind,botUsername:liveUsername}),now)]);
  if(results[0]?.meta?.changes!==1) throw new Error("room_revision_conflict");
  const agent=await getActiveRoomAgent(env.DB,room.id,botUserId); if(!agent) throw new Error("agent_add_failed"); return agent;
}

export async function setAgentRoomWakePolicy(env:Env,input:{roomId:unknown;wakePolicy:unknown;revision:unknown},actorUserId:string):Promise<TgAgentRoom>{
  const roomId=String(input.roomId||""); const expectedRevision=Number(input.revision);
  const wakePolicy=String(input.wakePolicy||"");
  if(!["off","mention_or_reply"].includes(wakePolicy)) throw new Error("room_wake_policy_invalid");
  const room=await env.DB.prepare("SELECT * FROM tg_agent_rooms WHERE id=? AND status='active'").bind(roomId).first<TgAgentRoom>();
  if(!room) throw new Error("room_not_found");
  if(actorUserId!==room.owner_user_id) throw new Error("room_owner_required");
  if(!Number.isInteger(expectedRevision)||expectedRevision!==room.revision) throw new Error("room_revision_conflict");
  if(wakePolicy==="mention_or_reply"){
    const agents=await env.DB.prepare("SELECT runtime_kind,status FROM tg_agent_room_agents WHERE room_id=? AND status!='removed' ORDER BY runtime_kind")
      .bind(room.id).all<{runtime_kind:string;status:string}>();
    const pair=agents.results||[];
    if(pair.length!==2||pair.some((agent)=>agent.status!=="active")||pair[0]?.runtime_kind!=="operia_worker"||pair[1]?.runtime_kind!=="cc_connect") {
      throw new Error("room_requires_exact_active_operia_codex_pair");
    }
  }
  const now=new Date().toISOString(); const nextRevision=room.revision+1;
  const results=await env.DB.batch([
    env.DB.prepare("UPDATE tg_agent_rooms SET wake_policy=?,revision=?,updated_at=? WHERE id=? AND revision=?")
      .bind(wakePolicy,nextRevision,now,room.id,expectedRevision),
    env.DB.prepare(`INSERT INTO tg_agent_room_audit
      (room_id,actor_user_id,event_type,target_id,old_revision,new_revision,metadata_json,created_at) VALUES (?,?, 'room.wake_changed',?,?,?,?,?)`)
      .bind(room.id,actorUserId,room.id,room.revision,nextRevision,JSON.stringify({from:room.wake_policy,to:wakePolicy}),now),
  ]);
  if(results[0]?.meta?.changes!==1) throw new Error("room_revision_conflict");
  const updated=await env.DB.prepare("SELECT * FROM tg_agent_rooms WHERE id=?").bind(room.id).first<TgAgentRoom>();
  if(!updated) throw new Error("room_not_found");
  return updated;
}

export async function setRoomAgentStatus(env:Env,input:{roomId:unknown;botUserId:unknown;status:unknown;revision:unknown},actorUserId:string):Promise<void>{
  const roomId=String(input.roomId||""); const botUserId=numericId(input.botUserId,"bot_user_id");
  const expectedRevision=Number(input.revision); const status=String(input.status||"");
  if(!["active","suspended","removed"].includes(status)) throw new Error("agent_status_invalid");
  const room=await env.DB.prepare("SELECT * FROM tg_agent_rooms WHERE id=? AND status='active'").bind(roomId).first<TgAgentRoom>();
  if(!room) throw new Error("room_not_found");
  if(actorUserId!==room.owner_user_id) throw new Error("room_owner_required");
  if(!Number.isInteger(expectedRevision)||expectedRevision!==room.revision) throw new Error("room_revision_conflict");
  const agent=await env.DB.prepare("SELECT * FROM tg_agent_room_agents WHERE room_id=? AND bot_user_id=? AND status!='removed'")
    .bind(room.id,botUserId).first<TgRoomAgent>();
  if(!agent) throw new Error("room_agent_not_found");
  if(agent.runtime_kind==="operia_worker"&&status!=="active") throw new Error("local_operia_cannot_be_removed_from_its_transport");
  const now=new Date().toISOString(); const nextRevision=room.revision+1; const membershipRevision=room.membership_revision+1;
  const results=await env.DB.batch([
    env.DB.prepare("UPDATE tg_agent_rooms SET revision=?,membership_revision=?,updated_at=? WHERE id=? AND revision=?")
      .bind(nextRevision,membershipRevision,now,room.id,expectedRevision),
    env.DB.prepare("UPDATE tg_agent_room_agents SET status=?,membership_revision=?,revision=revision+1,updated_at=? WHERE id=?")
      .bind(status,membershipRevision,now,agent.id),
    env.DB.prepare(`INSERT INTO tg_agent_room_audit
      (room_id,actor_user_id,event_type,target_id,old_revision,new_revision,metadata_json,created_at) VALUES (?,?, 'agent.status_changed',?,?,?,?,?)`)
      .bind(room.id,actorUserId,botUserId,room.revision,nextRevision,JSON.stringify({from:agent.status,to:status}),now),
  ]);
  if(results[0]?.meta?.changes!==1) throw new Error("room_revision_conflict");
}
