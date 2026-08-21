import { nowIso } from "../utils/time";

export type TgAgentContinuation = {
  id: string; task_id: string; chat_id: string; owner_id: string; request_json: string; tool_call_id: string;
  tool_name: string;
  voice_authorized: number; voice_once: number;
  voice_model: string;
  reply_to_message_id: number | null; interaction_targets_json: string;
  user_text: string; prior_state_json: string; batch_key: string; round: number; status: string; resume_from_status: string | null; lease_until: string | null;
  attempts: number; approval_json: string | null; final_response_json: string | null;
};

export async function persistTgContinuation(db: D1Database, input: {
  id: string; taskId: string; chatId: string; ownerId: string; request: unknown; toolCallId: string; toolName?: string;
  userText: string; priorState: unknown; batchKey: string; voiceAuthorized: boolean; voiceOnce: boolean; voiceModel: string;
  replyToMessageId?: number | null; interactionTargets?: number[];
  status: "waiting_agent" | "approval_required"; approval?: unknown;
}): Promise<void> {
  const now = nowIso();
  await db.prepare(`INSERT INTO tg_agent_continuations
    (id,task_id,chat_id,owner_id,request_json,tool_call_id,tool_name,user_text,prior_state_json,batch_key,voice_authorized,voice_once,voice_model,reply_to_message_id,interaction_targets_json,round,status,approval_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?) ON CONFLICT(task_id) DO NOTHING`)
    .bind(input.id,input.taskId,input.chatId,input.ownerId,JSON.stringify(input.request),input.toolCallId,input.toolName ?? "delegate_action",input.userText,
      JSON.stringify(input.priorState),input.batchKey,input.voiceAuthorized ? 1 : 0,input.voiceOnce ? 1 : 0,input.voiceModel,input.replyToMessageId ?? null,
      JSON.stringify(input.interactionTargets ?? []),input.status,input.approval ? JSON.stringify(input.approval) : null,now,now).run();
}

export async function claimTgContinuations(db: D1Database, limit = 10, leaseMs = 30_000): Promise<TgAgentContinuation[]> {
  const now = nowIso(); const lease = new Date(Date.now() + leaseMs).toISOString();
  await db.prepare(`UPDATE tg_agent_continuations SET status='attention_required',last_error='operia_outcome_unknown',updated_at=?
    WHERE status='operia_calling' AND lease_until < ?`).bind(now,now).run();
  const result = await db.prepare(`UPDATE tg_agent_continuations SET
    resume_from_status=CASE WHEN status='leased' THEN COALESCE(resume_from_status,
      CASE
        WHEN json_type(final_response_json,'$.choices[0].message.tool_calls')='array' THEN 'round_transition'
        WHEN final_response_json IS NOT NULL THEN 'outbox_pending'
        WHEN approval_json IS NOT NULL THEN 'approval_required'
        ELSE 'waiting_agent'
      END)
      ELSE status END,
    status='leased',lease_until=?,attempts=attempts+1,updated_at=?
    WHERE id IN (SELECT id FROM tg_agent_continuations WHERE
      (status IN ('waiting_agent','approval_required','round_transition','outbox_pending') AND (lease_until IS NULL OR lease_until < ?))
      OR (status='leased' AND (lease_until IS NULL OR lease_until < ?))
      ORDER BY updated_at LIMIT ?)
    RETURNING id,task_id,chat_id,owner_id,request_json,tool_call_id,tool_name,user_text,prior_state_json,batch_key,voice_authorized,voice_once,voice_model,reply_to_message_id,interaction_targets_json,round,status,resume_from_status,lease_until,attempts,approval_json,final_response_json`)
    .bind(lease,now,now,now,limit).all<TgAgentContinuation>();
  return result.results ?? [];
}

export async function hasActiveTgContinuation(db: D1Database, chatId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS active FROM tg_agent_continuations WHERE chat_id=?
    AND status NOT IN ('completed','failed','cancelled','attention_required') LIMIT 1`).bind(chatId).first<{active:number}>();
  return Boolean(row);
}

export async function advanceTgContinuation(db: D1Database, id: string, input: { taskId:string; request:unknown; toolCallId:string; toolName?:string; round:number }): Promise<void> {
  await db.prepare(`UPDATE tg_agent_continuations SET task_id=?,request_json=?,tool_call_id=?,tool_name=?,round=?,status='waiting_agent',
    resume_from_status=NULL,lease_until=NULL,approval_json=NULL,final_response_json=NULL,last_error=NULL,updated_at=?
    WHERE id=? AND status IN ('leased','round_transition')`)
    .bind(input.taskId,JSON.stringify(input.request),input.toolCallId,input.toolName ?? "delegate_action",input.round,nowIso(),id).run();
}

export async function setTgContinuationStatus(db: D1Database, id: string, status: string, fields: { approval?: unknown; finalResponse?: unknown; error?: string; clearLease?: boolean } = {}): Promise<void> {
  await db.prepare(`UPDATE tg_agent_continuations SET status=?,approval_json=COALESCE(?,approval_json),
    final_response_json=COALESCE(?,final_response_json),last_error=?,lease_until=CASE WHEN ? THEN NULL ELSE lease_until END,updated_at=? WHERE id=?`)
    .bind(status,fields.approval === undefined ? null : JSON.stringify(fields.approval),fields.finalResponse === undefined ? null : JSON.stringify(fields.finalResponse),
      fields.error ?? null,fields.clearLease ? 1 : 0,nowIso(),id).run();
}
