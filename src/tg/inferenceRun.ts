import type { OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { classifyTerminalCompleteness } from "../reliability/terminalCompleteness";
import type { ConversationState } from "../memory/conversationState";
import type { ResultCapsuleV1 } from "../agent/presentation/types";
import { nowIso } from "../utils/time";
import {
  inferencePublicationSourceRoute,
  prepareTgPublicationSourceRouteInsert,
  readTgPublicationSourceRoute,
  verifyTgPublicationSourceRoute,
  type TgPublicationSourceAuthorityMode,
} from "./publicationSource";

export type TgInferenceFinalPackage = {
  response: OpenAIChatResponse;
  mediaIntents: Record<string, unknown>[];
  toolTraces: Array<{ taskId: string; toolName: string; round: number; status: string }>;
  replyToMessageId: number | null;
  resultCapsules?: ResultCapsuleV1[];
};

export type TgInferenceRun = {
  batch_key: string;
  chat_id: string;
  inbox_ids_json: string;
  request_json: string;
  user_text: string;
  prior_state_json: string;
  voice_authorized: number;
  voice_once: number;
  voice_model: string;
  reply_to_message_id: number | null;
  interaction_targets_json: string;
  status: string;
  resume_from_status: string | null;
  attempts: number;
  delivery_attempts: number;
  lease_until: string | null;
  next_attempt_at: string | null;
  first_response_json: string | null;
  final_package_json: string | null;
  last_phase: string | null;
  last_error: string | null;
  delivery_seq: number | null;
  state_revision: number;
  outcome_wait_expires_at: string | null;
  terminal_completeness: string | null;
  created_at: string;
  updated_at: string;
};

const RUN_COLUMNS = `batch_key,chat_id,inbox_ids_json,request_json,user_text,prior_state_json,
  voice_authorized,voice_once,voice_model,reply_to_message_id,interaction_targets_json,status,resume_from_status,
  attempts,delivery_attempts,lease_until,next_attempt_at,first_response_json,final_package_json,last_phase,last_error,
  delivery_seq,state_revision,outcome_wait_expires_at,terminal_completeness,created_at,updated_at`;

export async function persistTgInferenceRun(db: D1Database, input: {
  batchKey: string;
  chatId: string;
  inboxIds: number[];
  request: OpenAIChatRequest;
  userText: string;
  priorState: ConversationState;
  voiceAuthorized: boolean;
  voiceOnce: boolean;
  voiceModel: string;
  replyToMessageId: number | null;
  interactionTargets: number[];
  claimToken: string;
  publicationAuthority:TgPublicationSourceAuthorityMode;
}): Promise<void> {
  const now = nowIso();
  const prior = await getTgInferenceRun(db,input.batchKey);
  const deliverySeq = input.inboxIds.filter((id) => Number.isSafeInteger(id) && id > 0)
    .reduce((minimum,id) => Math.min(minimum,id),Number.POSITIVE_INFINITY);
  if (!Number.isSafeInteger(deliverySeq)) throw new Error("tg_inference_delivery_seq_missing");
  const placeholders = input.inboxIds.map(() => "?").join(",");
  const statements = [db.prepare(`INSERT INTO tg_chat_inference_runs
    (batch_key,chat_id,inbox_ids_json,request_json,user_text,prior_state_json,voice_authorized,voice_once,voice_model,
      reply_to_message_id,interaction_targets_json,status,delivery_seq,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?) ON CONFLICT(batch_key) DO NOTHING`)
    .bind(input.batchKey,input.chatId,JSON.stringify(input.inboxIds),JSON.stringify(input.request),input.userText,
      JSON.stringify(input.priorState),input.voiceAuthorized ? 1 : 0,input.voiceOnce ? 1 : 0,input.voiceModel,
      input.replyToMessageId,JSON.stringify(input.interactionTargets),deliverySeq,now,now),
    db.prepare(`UPDATE tg_inbox SET handed_off_at=?,claim_lease_until=NULL
      WHERE claim_token=? AND id IN (${placeholders})`)
      .bind(now,input.claimToken,...input.inboxIds),
  ];
  if (!prior) {
    statements.splice(1,0,prepareTgPublicationSourceRouteInsert(db,
      inferencePublicationSourceRoute(input.batchKey,input.publicationAuthority,now),now));
  }
  await db.batch(statements);
  const stored = await getTgInferenceRun(db,input.batchKey);
  if (!stored) throw new Error("tg_inference_persist_missing");
  const sourceRoute = await readTgPublicationSourceRoute(db,input.batchKey);
  if (!prior) {
    await verifyTgPublicationSourceRoute(db,inferencePublicationSourceRoute(
      input.batchKey,input.publicationAuthority,stored.created_at));
  } else if (sourceRoute) {
    await verifyTgPublicationSourceRoute(db,inferencePublicationSourceRoute(
      input.batchKey,sourceRoute.authorityMode,stored.created_at));
  }
}

function syntheticCommandMessageId(batchKey:string):number {
  if (!/^[a-f0-9]{64}$/.test(batchKey)) throw new Error("tg_command_batch_key_invalid");
  // Telegram message ids are positive. A stable negative identity lets the
  // existing inbox AUTOINCREMENT allocate one globally ordered delivery_seq
  // without colliding with a real Telegram message or duplicating on replay.
  return -(Number.parseInt(batchKey.slice(0,13),16)+1);
}

/**
 * Persist a command-origin inference using the same durable source and global
 * delivery ordering substrate as an ordinary Telegram turn. The placeholder
 * inbox row is already processed and is never eligible for chat ingestion.
 */
export async function persistTgCommandInferenceRun(db:D1Database,input:{
  batchKey:string;
  taskId:string;
  chatId:string;
  request:OpenAIChatRequest;
  userText:string;
  priorState:ConversationState;
  initialStatus:"prepared"|"deferred";
  publicationAuthority:TgPublicationSourceAuthorityMode;
  deferredTask?:{
    taskId:string;
    ownerId:string;
    toolCallId:string;
    toolName:string;
  };
}):Promise<TgInferenceRun> {
  if ((input.initialStatus === "deferred") !== Boolean(input.deferredTask)) {
    throw new Error("tg_command_deferred_task_contract_invalid");
  }
  if (input.deferredTask && input.deferredTask.taskId !== input.taskId) {
    throw new Error("tg_command_deferred_task_identity_invalid");
  }
  const now = nowIso();
  const syntheticMessageId = syntheticCommandMessageId(input.batchKey);
  const prior = await getTgInferenceRun(db,input.batchKey);
  const statements:D1PreparedStatement[] = [];
  if (!prior) {
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO tg_inbox(
          chat_id,message_id,update_id,text,kind,payload_json,attempts,processed,
          claim_token,claim_lease_until,handed_off_at,created_at)
        VALUES(?,?,NULL,'','text','{"publication_source":"tool_command"}',1,1,NULL,NULL,?,?)`)
        .bind(input.chatId,syntheticMessageId,now,now),
      db.prepare(`INSERT INTO tg_chat_inference_runs(
          batch_key,chat_id,inbox_ids_json,request_json,user_text,prior_state_json,
          voice_authorized,voice_once,voice_model,reply_to_message_id,interaction_targets_json,
          status,delivery_seq,created_at,updated_at)
        SELECT ?,?,json_array(source.id),?,?,?,0,0,'expressive',NULL,'[]',?,source.id,?,?
        FROM tg_inbox source WHERE source.chat_id=? AND source.message_id=?
        ON CONFLICT(batch_key) DO NOTHING`)
        .bind(input.batchKey,input.chatId,JSON.stringify(input.request),input.userText,
          JSON.stringify(input.priorState),input.initialStatus,now,now,input.chatId,syntheticMessageId),
      db.prepare(`INSERT INTO tg_publication_tool_command_sources(
          task_id,batch_key,chat_id,created_at)
        SELECT ?,source.batch_key,source.chat_id,source.created_at
        FROM tg_chat_inference_runs source
        WHERE source.batch_key=? AND source.chat_id=?
        ON CONFLICT(task_id) DO NOTHING`)
        .bind(input.taskId,input.batchKey,input.chatId),
    );
    if (input.deferredTask) {
      statements.push(db.prepare(`INSERT INTO tg_agent_continuations(
          id,task_id,chat_id,owner_id,request_json,tool_call_id,tool_name,user_text,
          prior_state_json,batch_key,voice_authorized,voice_once,voice_model,
          reply_to_message_id,interaction_targets_json,round,status,approval_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,0,0,'expressive',NULL,'[]',1,'waiting_agent',NULL,?,?)
        ON CONFLICT(task_id) DO NOTHING`)
        .bind(`tg-command-continuation:${input.batchKey}`,input.deferredTask.taskId,
          input.chatId,input.deferredTask.ownerId,JSON.stringify(input.request),
          input.deferredTask.toolCallId,input.deferredTask.toolName,input.userText,
          JSON.stringify(input.priorState),input.batchKey,now,now));
    }
    statements.push(prepareTgPublicationSourceRouteInsert(db,
      inferencePublicationSourceRoute(input.batchKey,input.publicationAuthority,now),now));
    await db.batch(statements);
  }
  const stored = await getTgInferenceRun(db,input.batchKey);
  if (!stored) throw new Error("tg_command_inference_persist_missing");
  if (stored.chat_id !== input.chatId
    || stored.request_json !== JSON.stringify(input.request)
    || stored.user_text !== input.userText
    || stored.prior_state_json !== JSON.stringify(input.priorState)
    || !Number.isSafeInteger(stored.delivery_seq) || Number(stored.delivery_seq) <= 0) {
    throw new Error("tg_command_inference_identity_conflict");
  }
  const sourceRoute=await readTgPublicationSourceRoute(db,input.batchKey);
  if (!sourceRoute) throw new Error("tg_command_inference_publication_source_missing");
  await verifyTgPublicationSourceRoute(db,inferencePublicationSourceRoute(
    input.batchKey,sourceRoute.authorityMode,stored.created_at));
  const commandSource=await db.prepare(`SELECT task_id,batch_key,chat_id,created_at
    FROM tg_publication_tool_command_sources WHERE task_id=?`).bind(input.taskId)
    .first<{task_id:string;batch_key:string;chat_id:string;created_at:string}>();
  if (!commandSource || commandSource.batch_key !== input.batchKey
    || commandSource.chat_id !== input.chatId || commandSource.created_at !== stored.created_at) {
    throw new Error("tg_tool_command_source_identity_conflict");
  }
  if (input.deferredTask) {
    const continuation=await db.prepare(`SELECT id,chat_id,owner_id,request_json,tool_call_id,
        tool_name,user_text,prior_state_json,batch_key
      FROM tg_agent_continuations WHERE task_id=?`).bind(input.deferredTask.taskId).first<{
        id:string;chat_id:string;owner_id:string;request_json:string;tool_call_id:string;
        tool_name:string;user_text:string;prior_state_json:string;batch_key:string;
      }>();
    if (!continuation
      || continuation.id !== `tg-command-continuation:${input.batchKey}`
      || continuation.chat_id !== input.chatId
      || continuation.owner_id !== input.deferredTask.ownerId
      || continuation.request_json !== JSON.stringify(input.request)
      || continuation.tool_call_id !== input.deferredTask.toolCallId
      || continuation.tool_name !== input.deferredTask.toolName
      || continuation.user_text !== input.userText
      || continuation.prior_state_json !== JSON.stringify(input.priorState)
      || continuation.batch_key !== input.batchKey) {
      throw new Error("tg_command_continuation_identity_conflict");
    }
  }
  return stored;
}

export async function hasActiveTgInferenceRun(db: D1Database, chatId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS active FROM tg_chat_inference_runs WHERE chat_id=?
    AND status NOT IN ('completed','delivery_pending','deferred','attention_required','failed') LIMIT 1`)
    .bind(chatId).first<{ active: number }>();
  return Boolean(row);
}

export async function claimTgInferenceRun(db: D1Database, batchKey: string, leaseSeconds: number): Promise<TgInferenceRun | null> {
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + Math.max(30, leaseSeconds) * 1000).toISOString();
  return db.prepare(`UPDATE tg_chat_inference_runs SET
      resume_from_status=CASE WHEN status='leased' THEN COALESCE(resume_from_status,'prepared') ELSE status END,
      status='leased',lease_until=?,attempts=attempts+1,updated_at=?
    WHERE batch_key=? AND (
      status IN ('prepared','ready')
      OR (status='delivering' AND final_package_json IS NOT NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
      OR (status='retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
      OR (status IN ('calling','delivering','leased') AND (lease_until IS NULL OR lease_until < ?))
    )
    RETURNING ${RUN_COLUMNS}`)
    .bind(leaseUntil,now,batchKey,now,now,now).first<TgInferenceRun>();
}

export async function getTgInferenceRun(db: D1Database, batchKey: string): Promise<TgInferenceRun | null> {
  return db.prepare(`SELECT ${RUN_COLUMNS} FROM tg_chat_inference_runs WHERE batch_key=?`)
    .bind(batchKey).first<TgInferenceRun>();
}

export async function setTgInferenceCalling(db: D1Database, batchKey: string, leaseSeconds: number): Promise<void> {
  const leaseUntil = new Date(Date.now() + Math.max(30, leaseSeconds) * 1000).toISOString();
  const outcomeWaitExpiresAt = new Date(Date.now() + 900 * 1_000).toISOString();
  const updated = await db.prepare(`UPDATE tg_chat_inference_runs SET status='calling',resume_from_status=NULL,lease_until=?,
    next_attempt_at=NULL,last_phase='operia',last_error=NULL,outcome_wait_expires_at=?,
    state_revision=state_revision+1,updated_at=? WHERE batch_key=? AND status='leased'
    RETURNING batch_key`)
    .bind(leaseUntil,outcomeWaitExpiresAt,nowIso(),batchKey).first<{batch_key:string}>();
  if (!updated) throw new Error("tg_inference_call_transition_rejected");
}

export async function storeTgFirstResponse(db: D1Database, batchKey: string, response: OpenAIChatResponse): Promise<boolean> {
  const stored = await db.prepare(`UPDATE tg_chat_inference_runs SET first_response_json=?,status='leased',last_phase='continuation',
    last_error=NULL,updated_at=? WHERE batch_key=? AND status='calling' AND first_response_json IS NULL
    RETURNING batch_key`).bind(JSON.stringify(response),nowIso(),batchKey).first<{batch_key:string}>();
  return Boolean(stored);
}

export async function recoverTgFirstResponse(db: D1Database, batchKey: string, responseJson: string): Promise<boolean> {
  const recovered = await db.prepare(`UPDATE tg_chat_inference_runs SET first_response_json=?,status='ready',resume_from_status=NULL,
    lease_until=NULL,next_attempt_at=NULL,last_phase='memory_recovered',last_error=NULL,outcome_wait_expires_at=NULL,
    state_revision=state_revision+1,updated_at=?
    WHERE batch_key=? AND first_response_json IS NULL AND final_package_json IS NULL
      AND (status IN ('calling','awaiting_memory_outcome') OR (
        status='attention_required' AND last_error='memory_outcome_reconcile_exhausted'
        AND julianday(COALESCE(outcome_wait_expires_at,datetime(updated_at,'+15 minutes')))>julianday('now')
        AND NOT EXISTS (SELECT 1 FROM tg_chat_inference_runs newer
          WHERE newer.chat_id=tg_chat_inference_runs.chat_id
            AND newer.delivery_seq>tg_chat_inference_runs.delivery_seq
            AND (newer.final_package_json IS NOT NULL OR newer.status IN ('delivery_pending','completed')))
      )) RETURNING batch_key`)
    .bind(responseJson,nowIso(),batchKey).first<{batch_key:string}>();
  return Boolean(recovered);
}

export async function storeTgFinalPackage(db: D1Database, batchKey: string, pkg: TgInferenceFinalPackage): Promise<void> {
  const completeness = classifyTerminalCompleteness(pkg.response.choices?.[0]?.finish_reason).completeness;
  const updated = await db.prepare(`UPDATE tg_chat_inference_runs SET final_package_json=?,status='ready',resume_from_status=NULL,
    lease_until=NULL,next_attempt_at=NULL,last_phase='delivery',last_error=NULL,terminal_completeness=?,updated_at=?
    WHERE batch_key=? AND status='leased' RETURNING batch_key`)
    .bind(JSON.stringify(pkg),completeness,nowIso(),batchKey).first<{batch_key:string}>();
  if (!updated) throw new Error("tg_inference_final_transition_rejected");
}

/** Durable handoff boundary: the original inference becomes independently
 * recoverable before the continuation is terminalized. If this transition
 * succeeds, the minute recovery scanner can resume it even when Queue wake
 * admission has not happened yet. */
export async function handoffTgAgentContinuationFinalPackage(
  db:D1Database,
  input:{continuationId:string;batchKey:string;pkg:TgInferenceFinalPackage},
):Promise<void> {
  const encoded=JSON.stringify(input.pkg);
  const completeness=classifyTerminalCompleteness(
    input.pkg.response.choices?.[0]?.finish_reason,
  ).completeness;
  const now=nowIso();
  const updated=await db.prepare(`UPDATE tg_chat_inference_runs SET
      final_package_json=?,status='ready',resume_from_status=NULL,lease_until=NULL,next_attempt_at=NULL,
      last_phase='agent_continuation',last_error=NULL,terminal_completeness=?,updated_at=?,completed_at=NULL
    WHERE batch_key=? AND status='deferred' AND final_package_json IS NULL
      AND EXISTS(SELECT 1 FROM tg_agent_continuations continuation
        WHERE continuation.id=? AND continuation.batch_key=tg_chat_inference_runs.batch_key
          AND (continuation.status='outbox_pending'
            OR (continuation.status='leased' AND continuation.resume_from_status='outbox_pending')))
    RETURNING batch_key`).bind(encoded,completeness,now,input.batchKey,input.continuationId)
    .first<{batch_key:string}>();
  if (!updated) {
    const existing=await db.prepare(`SELECT status,final_package_json
      FROM tg_chat_inference_runs WHERE batch_key=?`).bind(input.batchKey)
      .first<{status:string;final_package_json:string|null}>();
    if (existing?.final_package_json !== encoded
      || !["ready","leased","delivering","delivery_pending","completed","attention_required"]
        .includes(existing.status)) {
      throw new Error("tg_agent_continuation_final_identity_conflict");
    }
  }
  const completed=await db.prepare(`UPDATE tg_agent_continuations SET status='completed',
      resume_from_status=NULL,lease_until=NULL,last_error=NULL,updated_at=?
    WHERE id=? AND batch_key=? AND (status IN ('outbox_pending','completed')
      OR (status='leased' AND resume_from_status='outbox_pending'))
      AND EXISTS(SELECT 1 FROM tg_chat_inference_runs run WHERE run.batch_key=?
        AND run.final_package_json=? AND run.status IN (
          'ready','leased','delivering','delivery_pending','completed','attention_required'))
    RETURNING id`).bind(now,input.continuationId,input.batchKey,input.batchKey,encoded)
    .first<{id:string}>();
  if (!completed) throw new Error("tg_agent_continuation_final_handoff_conflict");
}

export async function storeTgDeferredThinkFinalPackage(
  db: D1Database,
  batchKey: string,
  pkg: TgInferenceFinalPackage,
  phase: "think_approval_continuation" | "think_codemode_continuation" | "think_sdk_action" | "harness_durable" = "think_approval_continuation",
  identity?: { idempotencyKey: string; requestHash: string; source: string },
): Promise<void> {
  const encoded = JSON.stringify(pkg);
  const completeness = classifyTerminalCompleteness(pkg.response.choices?.[0]?.finish_reason).completeness;
  const now = nowIso();
  if (identity && identity.idempotencyKey !== `tg:${batchKey}`) {
    throw new Error("tg_deferred_think_identity_mismatch");
  }
  if (identity) {
    const replay = await db.prepare(`SELECT 1 AS matched FROM inference_idempotency
      WHERE idempotency_key=? AND request_hash=? AND source=?`)
      .bind(identity.idempotencyKey,identity.requestHash,identity.source).first<{matched:number}>();
    if (!replay) throw new Error("tg_deferred_think_identity_mismatch");
  }
  const eligibleStatuses = identity ? "'calling','leased','deferred'" : "'deferred'";
  const identityClause = identity
    ? `AND EXISTS (SELECT 1 FROM inference_idempotency replay
        WHERE replay.idempotency_key=? AND replay.request_hash=? AND replay.source=?)`
    : "";
  const statement = db.prepare(`UPDATE tg_chat_inference_runs SET final_package_json=?,status='ready',resume_from_status=NULL,
    lease_until=NULL,next_attempt_at=NULL,last_phase=?,last_error=NULL,terminal_completeness=?,updated_at=?,completed_at=NULL
    WHERE batch_key=? AND status IN (${eligibleStatuses}) AND (final_package_json IS NULL OR final_package_json=?
      OR (?=1 AND json_extract(final_package_json,'$.response.operia_think.route')='think-0.15-sdk-action')
      OR (?=1 AND json_extract(final_package_json,'$.response.operia_think.harness_pending_projection')=1))
      ${identityClause}
    RETURNING batch_key`);
  const replaceSdkActionPackage = phase === "think_sdk_action" ? 1 : 0;
  const replaceHarnessPendingPackage = phase === "harness_durable" ? 0 : 1;
  const updated = identity
    ? await statement.bind(encoded,phase,completeness,now,batchKey,encoded,replaceSdkActionPackage,replaceHarnessPendingPackage,
        identity.idempotencyKey,identity.requestHash,identity.source)
      .first<{batch_key:string}>()
    : await statement.bind(encoded,phase,completeness,now,batchKey,encoded,replaceSdkActionPackage,replaceHarnessPendingPackage)
      .first<{batch_key:string}>();
  if (updated) return;
  const existing = await db.prepare("SELECT status,final_package_json FROM tg_chat_inference_runs WHERE batch_key=?")
    .bind(batchKey).first<{status:string;final_package_json:string|null}>();
  if (existing?.final_package_json === encoded
    && ["ready","delivery_pending","delivering","completed","attention_required"].includes(existing.status)) return;
  throw new Error("tg_deferred_think_final_transition_rejected");
}

export async function deferTgSdkActionRun(db: D1Database, batchKey: string, responseId: string): Promise<void> {
  const updated = await db.prepare(`UPDATE tg_chat_inference_runs SET status='deferred',resume_from_status=NULL,
    final_package_json=NULL,lease_until=NULL,next_attempt_at=NULL,last_error=NULL,updated_at=?,completed_at=NULL
    WHERE batch_key=? AND status IN ('calling','leased') AND (final_package_json IS NULL
      OR json_extract(final_package_json,'$.response.id')=?) RETURNING batch_key`)
    .bind(nowIso(),batchKey,responseId).first<{batch_key:string}>();
  // A newer known final may replace this pending package while Telegram is
  // presenting buttons. A mismatched response id must win that race.
  if (updated) return;
  const current = await db.prepare("SELECT status FROM tg_chat_inference_runs WHERE batch_key=?")
    .bind(batchKey).first<{status:string}>();
  if (current && ["ready","delivery_pending","delivering","completed","attention_required"].includes(current.status)) return;
  throw new Error("tg_sdk_action_defer_transition_rejected");
}

export async function deferTgHarnessPendingProjection(
  db: D1Database,
  input: { batchKey: string; responseId: string; executionId: string; responseHash: string },
): Promise<boolean> {
  const updated = await db.prepare(`UPDATE tg_chat_inference_runs SET status='deferred',resume_from_status=NULL,
    final_package_json=NULL,lease_until=NULL,next_attempt_at=NULL,last_error=NULL,updated_at=?,completed_at=NULL
    WHERE batch_key=? AND status IN ('calling','leased')
      AND json_extract(final_package_json,'$.response.id')=?
      AND json_extract(final_package_json,'$.response.operia_think.harness_pending_projection')=1
      AND json_extract(final_package_json,'$.response.operia_think.execution_id')=?
      AND EXISTS (SELECT 1 FROM hrs_think_executions execution
        WHERE execution.execution_id=? AND execution.request_identity=('tg:' || tg_chat_inference_runs.batch_key)
          AND execution.tg_batch_key=tg_chat_inference_runs.batch_key AND execution.state='held'
          AND execution.terminal_status='continuation_pending' AND execution.terminal_result_hash=?)
    RETURNING batch_key`)
    .bind(nowIso(),input.batchKey,input.responseId,input.executionId,input.executionId,input.responseHash)
    .first<{batch_key:string}>();
  if (updated) return true;
  const current = await db.prepare("SELECT status,final_package_json FROM tg_chat_inference_runs WHERE batch_key=?")
    .bind(input.batchKey).first<{status:string;final_package_json:string|null}>();
  if (current?.status === "deferred" && current.final_package_json === null) return true;
  if (current && ["ready","delivery_pending","delivering","completed","attention_required"].includes(current.status)) return false;
  const execution = await db.prepare("SELECT state,terminal_status,terminal_result_hash FROM hrs_think_executions WHERE execution_id=?")
    .bind(input.executionId).first<{state:string;terminal_status:string|null;terminal_result_hash:string|null}>();
  if (!execution || execution.state !== "held" || execution.terminal_status !== "continuation_pending"
    || execution.terminal_result_hash !== input.responseHash) return false;
  throw new Error("tg_harness_pending_defer_transition_rejected");
}

export async function handoffTgKnownFinalProjection(
  db: D1Database,
  batchKey: string,
  phase: "think_approval_projection_repair" | "think_codemode_projection_repair",
  identity: { idempotencyKey: string; requestHash: string; source: string },
  delaySeconds = 60,
): Promise<boolean> {
  if (identity.idempotencyKey !== `tg:${batchKey}`) throw new Error("tg_known_final_identity_mismatch");
  const now = nowIso();
  const nextAttemptAt = new Date(Date.now() + Math.max(1, delaySeconds) * 1_000).toISOString();
  const handedOff = await db.prepare(`UPDATE tg_chat_inference_runs SET status='retry_wait',resume_from_status=NULL,
      lease_until=NULL,next_attempt_at=?,last_phase=?,last_error='known_final_projection_handoff',updated_at=?
    WHERE batch_key=? AND final_package_json IS NULL AND status IN ('calling','leased','deferred','retry_wait')
      AND EXISTS (SELECT 1 FROM inference_idempotency replay
        WHERE replay.idempotency_key=? AND replay.request_hash=? AND replay.source=?
          AND replay.status='completed' AND replay.response_json IS NOT NULL)
    RETURNING batch_key`)
    .bind(nextAttemptAt,phase,now,batchKey,identity.idempotencyKey,identity.requestHash,identity.source)
    .first<{batch_key:string}>();
  if (handedOff) return true;
  const existing = await db.prepare(`SELECT status,final_package_json FROM tg_chat_inference_runs WHERE batch_key=?`)
    .bind(batchKey).first<{status:string;final_package_json:string|null}>();
  return Boolean(existing?.final_package_json
    && ["ready","delivering","delivery_pending","completed","attention_required"].includes(existing.status));
}

export async function setTgInferenceDelivering(
  db: D1Database,
  batchKey: string,
  leaseSeconds: number,
  recoverySeconds: number,
): Promise<void> {
  const leaseUntil = new Date(Date.now() + Math.max(30, leaseSeconds) * 1000).toISOString();
  const nextAttemptAt = new Date(Date.now() + Math.max(1,recoverySeconds) * 1000).toISOString();
  const updated = await db.prepare(`UPDATE tg_chat_inference_runs SET status='delivering',delivery_attempts=delivery_attempts+1,
    lease_until=?,next_attempt_at=?,last_phase='delivery',updated_at=?
    WHERE batch_key=? AND status IN ('ready','leased','delivering') RETURNING batch_key`)
    .bind(leaseUntil,nextAttemptAt,nowIso(),batchKey).first<{batch_key:string}>();
  if (!updated) throw new Error("tg_inference_delivery_transition_rejected");
}

export async function releaseTgInferenceForDelivery(db: D1Database, batchKey: string): Promise<boolean> {
  const now = nowIso();
  const released = await db.prepare(`UPDATE tg_chat_inference_runs SET status='delivery_pending',resume_from_status=NULL,
    lease_until=NULL,next_attempt_at=NULL,last_phase='delivery',last_error=NULL,updated_at=?,completed_at=COALESCE(completed_at,?)
    WHERE batch_key=? AND status IN ('ready','leased','delivering') RETURNING batch_key`)
    .bind(now,now,batchKey).first<{batch_key:string}>();
  return Boolean(released);
}

export async function completeTgInferenceRun(db: D1Database, batchKey: string, status: "completed" | "deferred"): Promise<void> {
  const now = nowIso();
  if (status === "deferred") {
    // A fast Think continuation may already have atomically installed a final
    // package while the original TG invocation is still unwinding. Never
    // downgrade that ready final back to deferred.
    await db.prepare(`UPDATE tg_chat_inference_runs SET status='deferred',resume_from_status=NULL,
      lease_until=NULL,next_attempt_at=NULL,last_error=NULL,updated_at=?,completed_at=COALESCE(completed_at,?)
      WHERE batch_key=? AND status IN ('calling','leased') AND final_package_json IS NULL`)
      .bind(now,now,batchKey).run();
    return;
  }
  await db.prepare(`UPDATE tg_chat_inference_runs SET status='completed',resume_from_status=NULL,
    lease_until=NULL,next_attempt_at=NULL,last_error=NULL,updated_at=?,completed_at=COALESCE(completed_at,?)
    WHERE batch_key=?`).bind(now,now,batchKey).run();
}

export async function retryTgInferenceRun(db: D1Database, batchKey: string, phase: string, error: string, delaySeconds: number): Promise<void> {
  const nextAttemptAt = new Date(Date.now() + Math.max(1, delaySeconds) * 1000).toISOString();
  await db.prepare(`UPDATE tg_chat_inference_runs SET status='retry_wait',resume_from_status=NULL,lease_until=NULL,
    next_attempt_at=?,last_phase=?,last_error=?,updated_at=? WHERE batch_key=?`)
    .bind(nextAttemptAt,phase,error.slice(0,300),nowIso(),batchKey).run();
}

export async function holdTgInferenceForMemoryOutcome(
  db: D1Database,
  batchKey: string,
  phase: string,
  error: string,
  holdSeconds: number,
): Promise<boolean> {
  const now = nowIso();
  const outcomeWaitExpiresAt = new Date(Date.now() + Math.max(30,holdSeconds) * 1_000).toISOString();
  const held = await db.prepare(`UPDATE tg_chat_inference_runs SET status='awaiting_memory_outcome',resume_from_status=NULL,
    lease_until=NULL,next_attempt_at=NULL,last_phase=?,last_error=?,outcome_wait_expires_at=?,
    state_revision=state_revision+1,updated_at=?
    WHERE batch_key=? AND first_response_json IS NULL AND final_package_json IS NULL
      AND status IN ('calling','leased','retry_wait','awaiting_memory_outcome') RETURNING batch_key`)
    .bind(phase,error.slice(0,300),outcomeWaitExpiresAt,now,batchKey).first<{batch_key:string}>();
  return Boolean(held);
}

export async function expireTgInferenceMemoryOutcome(
  db: D1Database,
  batchKey: string,
): Promise<boolean> {
  const now = nowIso();
  const expired = await db.prepare(`UPDATE tg_chat_inference_runs SET status='attention_required',resume_from_status=NULL,
      lease_until=NULL,next_attempt_at=NULL,last_phase='operia',last_error='memory_outcome_unresolved',
      state_revision=state_revision+1,updated_at=?
    WHERE batch_key=? AND status IN ('calling','awaiting_memory_outcome') AND first_response_json IS NULL
      AND final_package_json IS NULL AND outcome_wait_expires_at IS NOT NULL AND outcome_wait_expires_at<=?
      AND NOT EXISTS (SELECT 1 FROM inference_idempotency replay
        WHERE replay.idempotency_key=('tg:'||tg_chat_inference_runs.batch_key)
          AND replay.status='completed' AND replay.response_json IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM inference_presentations presentation
        WHERE presentation.idempotency_key=('tg:'||tg_chat_inference_runs.batch_key)
          AND presentation.status='ready')
    RETURNING batch_key`).bind(now,batchKey,now).first<{batch_key:string}>();
  if (!expired) return false;
  await db.prepare(`UPDATE tg_paragraph_stream_batches SET state='attention_required',final_closed=1,
    lease_token=NULL,lease_until=NULL,last_error=COALESCE(last_error,'memory_outcome_unresolved'),updated_at=?
    WHERE batch_key=? AND state IN ('open','closing')`).bind(now,batchKey).run();
  return true;
}

export async function requireTgInferenceAttention(db: D1Database, batchKey: string, phase: string, error: string): Promise<void> {
  const now = nowIso();
  const boundedError = error.slice(0,300);
  await db.batch([
    db.prepare(`UPDATE tg_chat_inference_runs SET status='attention_required',resume_from_status=NULL,lease_until=NULL,
      next_attempt_at=NULL,last_phase=?,last_error=?,updated_at=? WHERE batch_key=?`)
      .bind(phase,boundedError,now,batchKey),
    db.prepare(`UPDATE tg_paragraph_stream_batches SET state='attention_required',final_closed=1,
      lease_token=NULL,lease_until=NULL,last_error=COALESCE(last_error,?),updated_at=?
      WHERE batch_key=? AND state IN ('open','closing')`)
      .bind(boundedError,now,batchKey),
  ]);
}

export async function dueTgInferenceRunKeys(db: D1Database, limit = 10): Promise<string[]> {
  const now = nowIso();
  const rows = await db.prepare(`SELECT batch_key FROM tg_chat_inference_runs WHERE
      status IN ('prepared','ready')
      OR (status='delivering' AND final_package_json IS NOT NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
      OR (status='retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
      OR (status IN ('calling','delivering','leased') AND (lease_until IS NULL OR lease_until < ?))
    ORDER BY updated_at LIMIT ?`)
    .bind(now,now,now,limit).all<{ batch_key: string }>();
  return (rows.results ?? []).map((row) => row.batch_key);
}
