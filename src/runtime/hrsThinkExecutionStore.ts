import { sha256Hex } from "../utils/hash";

export type HrsThinkExecutionState =
  | "prepared"
  | "submitted"
  | "held"
  | "running"
  | "completed"
  | "failed"
  | "attention_required";

export type HrsThinkExecutionRow = {
  execution_id: string;
  request_identity: string;
  request_id_hash: string;
  client_request_hash: string;
  inference_request_hash: string;
  inference_source: string;
  tg_batch_key: string | null;
  source_identity: string;
  owner_id: string;
  chat_id: string;
  scope_kind: "private" | "qa_room";
  thread_key: string;
  think_instance_id: string;
  submission_id: string;
  submission_idempotency_key: string;
  input_hash: string;
  execution_profile: "read_tools" | "action" | "code";
  tool_surface_hash: string;
  state: HrsThinkExecutionState;
  revision: number;
  fencing_token: string;
  next_inspection_at: string | null;
  terminal_result_hash: string | null;
  terminal_status: string | null;
  error_code: string | null;
  namespace: string;
  conversation_id: string | null;
  source: string;
  request_model: string;
  upstream_model: string;
  archive_idempotency_key: string | null;
  latest_user_message_id: string | null;
  turn_order_key: number | null;
  provider: string;
  model_call_count: number;
  tool_call_count: number;
  direct_call_count: number;
  code_mode_call_count: number;
  recovery_attempt: number;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
};

export type HrsThinkExecutionIdentity = {
  requestIdentity: string;
  clientRequestHash: string;
  inferenceRequestHash: string;
  inferenceSource: string;
  tgBatchKey: string | null;
  sourceIdentity: string;
  ownerId: string;
  chatId: string;
  scopeKind: "private" | "qa_room";
  threadKey: string;
  thinkInstanceId: string;
  submissionId: string;
  submissionIdempotencyKey: string;
  inputHash: string;
  executionProfile: "read_tools" | "action" | "code";
  toolSurfaceHash: string;
  namespace: string;
  conversationId: string | null;
  source: string;
  requestModel: string;
  upstreamModel: string;
  archiveIdempotencyKey: string | null;
  latestUserMessageId: string | null;
  turnOrderKey: number | null;
  provider: string;
};

export type HrsThinkExecutionReceipt = {
  execution_id: string;
  projection_result_hash: string | null;
  projection_completed_at: string | null;
  cleanup_completed_at: string | null;
  attention_completed_at: string | null;
  observation_completed_at: string | null;
  updated_at: string;
};

export type StableHrsThinkIdentity = {
  executionId: string;
  requestIdHash: string;
  fencingToken: string;
};

export async function stableHrsThinkIdentity(input: {
  requestIdentity: string;
  inputHash: string;
  executionProfile: string;
}): Promise<StableHrsThinkIdentity> {
  const requestIdHash = await sha256Hex(input.requestIdentity);
  return {
    executionId: `hrse_${(await sha256Hex(`execution\0${input.requestIdentity}`)).slice(0,40)}`,
    requestIdHash,
    fencingToken: await sha256Hex(`fence\0${input.requestIdentity}\0${1}`),
  };
}

export async function createOrReadHrsThinkExecution(
  db: D1Database,
  input: HrsThinkExecutionIdentity,
  at = new Date().toISOString(),
): Promise<{ row: HrsThinkExecutionRow; created: boolean }> {
  const stable = await stableHrsThinkIdentity(input);
  const inserted = await db.prepare(`INSERT INTO hrs_think_executions
    (execution_id,request_identity,request_id_hash,client_request_hash,inference_request_hash,inference_source,tg_batch_key,
     source_identity,owner_id,chat_id,scope_kind,thread_key,think_instance_id,submission_id,submission_idempotency_key,input_hash,execution_profile,
     tool_surface_hash,state,revision,fencing_token,next_inspection_at,namespace,conversation_id,source,
     request_model,upstream_model,archive_idempotency_key,latest_user_message_id,turn_order_key,provider,
     created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',1,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(request_identity) DO NOTHING RETURNING *`).bind(
      stable.executionId,input.requestIdentity,stable.requestIdHash,input.clientRequestHash,input.inferenceRequestHash,input.inferenceSource,
      input.tgBatchKey,input.sourceIdentity,input.ownerId,input.chatId,input.scopeKind,input.threadKey,input.thinkInstanceId,
      input.submissionId,input.submissionIdempotencyKey,
      input.inputHash,input.executionProfile,input.toolSurfaceHash,stable.fencingToken,at,input.namespace,
      input.conversationId,input.source,input.requestModel,input.upstreamModel,input.archiveIdempotencyKey,
      input.latestUserMessageId,input.turnOrderKey,input.provider,at,at,
    ).first<HrsThinkExecutionRow>();
  if (inserted) return { row: inserted,created: true };
  const row = await readHrsThinkExecutionByRequest(db,input.requestIdentity);
  if (!row || !sameImmutableExecution(row,input,stable)) {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_identity_conflict");
  }
  return { row,created: false };
}

export async function readHrsThinkExecution(
  db: D1Database,
  executionId: string,
): Promise<HrsThinkExecutionRow | null> {
  return db.prepare("SELECT * FROM hrs_think_executions WHERE execution_id=?")
    .bind(executionId).first<HrsThinkExecutionRow>();
}

export async function readHrsThinkExecutionByRequest(
  db: D1Database,
  requestIdentity: string,
): Promise<HrsThinkExecutionRow | null> {
  return db.prepare("SELECT * FROM hrs_think_executions WHERE request_identity=?")
    .bind(requestIdentity).first<HrsThinkExecutionRow>();
}

export async function readHrsThinkExecutionReceipt(
  db: D1Database,
  executionId: string,
): Promise<HrsThinkExecutionReceipt> {
  const receipt = await db.prepare("SELECT * FROM hrs_think_execution_receipts WHERE execution_id=?")
    .bind(executionId).first<HrsThinkExecutionReceipt>();
  if (!receipt) throw new HrsThinkExecutionConflictError("hrs_think_execution_receipt_missing");
  return receipt;
}

export async function markHrsThinkProjectionPending(
  db: D1Database,
  input: { executionId: string; resultHash: string; at?: string },
): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  const updated = await db.prepare(`UPDATE hrs_think_execution_receipts
    SET projection_result_hash=?,projection_completed_at=NULL,updated_at=?
    WHERE execution_id=? AND EXISTS (SELECT 1 FROM hrs_think_executions execution
      WHERE execution.execution_id=? AND execution.terminal_result_hash=?
        AND execution.state IN ('held','completed')) RETURNING execution_id`)
    .bind(input.resultHash,at,input.executionId,input.executionId,input.resultHash)
    .first<{execution_id:string}>();
  if (updated) return;
  const receipt = await readHrsThinkExecutionReceipt(db,input.executionId);
  if (receipt.projection_result_hash === input.resultHash && receipt.projection_completed_at === null) return;
  throw new HrsThinkExecutionConflictError("hrs_think_projection_pending_conflict");
}

export async function markHrsThinkProjectionComplete(
  db: D1Database,
  input: { executionId: string; resultHash: string; at?: string },
): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  const updated = await db.prepare(`UPDATE hrs_think_execution_receipts
    SET projection_completed_at=?,updated_at=?
    WHERE execution_id=? AND projection_result_hash=? AND projection_completed_at IS NULL
      AND EXISTS (SELECT 1 FROM hrs_think_executions execution
        WHERE execution.execution_id=? AND execution.terminal_result_hash=?
          AND execution.state IN ('held','completed')) RETURNING execution_id`)
    .bind(at,at,input.executionId,input.resultHash,input.executionId,input.resultHash)
    .first<{execution_id:string}>();
  if (updated) return;
  const receipt = await readHrsThinkExecutionReceipt(db,input.executionId);
  if (receipt.projection_result_hash === input.resultHash && receipt.projection_completed_at !== null) return;
  throw new HrsThinkExecutionConflictError("hrs_think_projection_completion_conflict");
}

export async function markHrsThinkCleanupComplete(
  db: D1Database,
  executionId: string,
  at = new Date().toISOString(),
): Promise<void> {
  const updated = await db.prepare(`UPDATE hrs_think_execution_receipts
    SET cleanup_completed_at=COALESCE(cleanup_completed_at,?),updated_at=?
    WHERE execution_id=? AND EXISTS (SELECT 1 FROM hrs_think_executions execution
      WHERE execution.execution_id=? AND (execution.state IN ('completed','failed','attention_required')
        OR (execution.state='held' AND execution.terminal_status='continuation_pending')))
    RETURNING execution_id`).bind(at,at,executionId,executionId).first<{execution_id:string}>();
  if (updated) return;
  const receipt = await readHrsThinkExecutionReceipt(db,executionId);
  if (receipt.cleanup_completed_at !== null) return;
  throw new HrsThinkExecutionConflictError("hrs_think_cleanup_completion_conflict");
}

export async function markHrsThinkAttentionComplete(
  db: D1Database,
  executionId: string,
  at = new Date().toISOString(),
): Promise<void> {
  const updated = await db.prepare(`UPDATE hrs_think_execution_receipts
    SET attention_completed_at=COALESCE(attention_completed_at,?),updated_at=?
    WHERE execution_id=? AND EXISTS (SELECT 1 FROM hrs_think_executions execution
      WHERE execution.execution_id=? AND execution.state='attention_required') RETURNING execution_id`)
    .bind(at,at,executionId,executionId).first<{execution_id:string}>();
  if (updated) return;
  const receipt = await readHrsThinkExecutionReceipt(db,executionId);
  if (receipt.attention_completed_at !== null) return;
  throw new HrsThinkExecutionConflictError("hrs_think_attention_completion_conflict");
}

export async function markHrsThinkObservationComplete(
  db: D1Database,
  executionId: string,
  at = new Date().toISOString(),
): Promise<void> {
  const updated = await db.prepare(`UPDATE hrs_think_execution_receipts
    SET observation_completed_at=COALESCE(observation_completed_at,?),updated_at=?
    WHERE execution_id=? AND EXISTS (SELECT 1 FROM hrs_think_executions execution
      WHERE execution.execution_id=? AND (execution.state='completed'
        OR (execution.state='held' AND execution.terminal_status='continuation_pending')))
    RETURNING execution_id`).bind(at,at,executionId,executionId).first<{execution_id:string}>();
  if (updated) return;
  const receipt = await readHrsThinkExecutionReceipt(db,executionId);
  if (receipt.observation_completed_at !== null) return;
  throw new HrsThinkExecutionConflictError("hrs_think_observation_completion_conflict");
}

export class HrsThinkExecutionConflictError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "HrsThinkExecutionConflictError";
  }
}

export async function transitionHrsThinkExecution(input: {
  db: D1Database;
  current: HrsThinkExecutionRow;
  from: readonly HrsThinkExecutionState[];
  to: HrsThinkExecutionState;
  nextInspectionAt?: string | null;
  terminalResultHash?: string | null;
  terminalStatus?: string | null;
  errorCode?: string | null;
  modelCallCount?: number;
  toolCallCount?: number;
  directCallCount?: number;
  codeModeCallCount?: number;
  recoveryAttempt?: number;
  at?: string;
}): Promise<HrsThinkExecutionRow> {
  if (!input.from.includes(input.current.state)) {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_from_state_mismatch");
  }
  const revision = input.current.revision + 1;
  const fencingToken = await sha256Hex(`fence\0${input.current.execution_id}\0${revision}`);
  const at = input.at ?? new Date().toISOString();
  const terminal = isTerminalHrsThinkState(input.to);
  const target = {
    nextInspectionAt: terminal ? null : input.nextInspectionAt ?? input.current.next_inspection_at,
    terminalResultHash: input.terminalResultHash ?? input.current.terminal_result_hash,
    terminalStatus: input.terminalStatus ?? input.current.terminal_status,
    errorCode: input.errorCode ?? null,
    modelCallCount: input.modelCallCount ?? input.current.model_call_count,
    toolCallCount: input.toolCallCount ?? input.current.tool_call_count,
    directCallCount: input.directCallCount ?? input.current.direct_call_count,
    codeModeCallCount: input.codeModeCallCount ?? input.current.code_mode_call_count,
    recoveryAttempt: input.recoveryAttempt ?? input.current.recovery_attempt,
  };
  const placeholders = input.from.map(() => "?").join(",");
  const updated = await input.db.prepare(`UPDATE hrs_think_executions SET
      state=?,revision=?,fencing_token=?,next_inspection_at=?,terminal_result_hash=?,terminal_status=?,error_code=?,
      model_call_count=?,tool_call_count=?,direct_call_count=?,code_mode_call_count=?,recovery_attempt=?,
      updated_at=?,terminal_at=?
    WHERE execution_id=? AND revision=? AND fencing_token=? AND state IN (${placeholders}) RETURNING *`).bind(
      input.to,revision,fencingToken,target.nextInspectionAt,target.terminalResultHash,target.terminalStatus,target.errorCode,
      target.modelCallCount,target.toolCallCount,target.directCallCount,target.codeModeCallCount,target.recoveryAttempt,
      at,terminal ? at : null,input.current.execution_id,input.current.revision,input.current.fencing_token,...input.from,
    ).first<HrsThinkExecutionRow>();
  if (updated) return updated;
  const observed = await readHrsThinkExecution(input.db,input.current.execution_id);
  if (observed && observed.revision === revision && observed.fencing_token === fencingToken
    && observed.state === input.to && observed.terminal_result_hash === target.terminalResultHash
    && observed.terminal_status === target.terminalStatus && observed.error_code === target.errorCode
    && observed.next_inspection_at === target.nextInspectionAt
    && observed.model_call_count === target.modelCallCount && observed.tool_call_count === target.toolCallCount
    && observed.direct_call_count === target.directCallCount && observed.code_mode_call_count === target.codeModeCallCount
    && observed.recovery_attempt === target.recoveryAttempt) return observed;
  throw new HrsThinkExecutionConflictError("hrs_think_execution_stale_revision");
}

export async function listDueHrsThinkExecutions(
  db: D1Database,
  at = new Date().toISOString(),
  limit = 25,
): Promise<HrsThinkExecutionRow[]> {
  const bounded = Math.max(1,Math.min(100,Math.floor(limit)));
  const rows = await db.prepare(`SELECT * FROM hrs_think_executions
    WHERE execution_id IN (SELECT execution.execution_id FROM hrs_think_executions execution
      JOIN hrs_think_execution_receipts receipt ON receipt.execution_id=execution.execution_id
      WHERE (
        execution.state IN ('prepared','submitted','held','running')
        AND NOT (execution.state='held' AND execution.terminal_status='continuation_pending'
          AND receipt.projection_result_hash=execution.terminal_result_hash
          AND receipt.projection_completed_at IS NOT NULL AND receipt.cleanup_completed_at IS NOT NULL
          AND receipt.observation_completed_at IS NOT NULL)
        AND (execution.next_inspection_at IS NULL OR execution.next_inspection_at<=?)
      ) OR (
        execution.state='completed' AND (
          receipt.projection_result_hash IS NOT execution.terminal_result_hash
          OR receipt.projection_completed_at IS NULL OR receipt.cleanup_completed_at IS NULL
          OR receipt.observation_completed_at IS NULL)
      ) OR (
        execution.state='failed' AND receipt.cleanup_completed_at IS NULL
      ) OR (
        execution.state='attention_required'
        AND (receipt.cleanup_completed_at IS NULL OR receipt.attention_completed_at IS NULL)
      ))
    ORDER BY COALESCE(next_inspection_at,created_at),created_at LIMIT ?`).bind(at,bounded)
    .all<HrsThinkExecutionRow>();
  return rows.results;
}

export function isTerminalHrsThinkState(state: HrsThinkExecutionState): boolean {
  return state === "completed" || state === "failed" || state === "attention_required";
}

/**
 * Continuation projectors complete the existing inference replay before they
 * hand its ordinary final package back to TG. If the request belongs to HRS,
 * advance the application authority first; accepted/legacy continuations have
 * no HRS row and remain unchanged.
 */
export async function completeHrsThinkExecutionForReplay(
  db: D1Database,
  input: {
    executionId: string;
    requestIdentity: string;
    responseJson: string;
    terminalStatus: string;
    modelCallCount?: number;
    toolCallCount?: number;
    directCallCount?: number;
    codeModeCallCount?: number;
    recoveryAttempt?: number;
  },
): Promise<HrsThinkExecutionRow> {
  const row = await readHrsThinkExecution(db,input.executionId);
  if (!row || row.request_identity !== input.requestIdentity) {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_locator_conflict");
  }
  const responseHash = await sha256Hex(input.responseJson);
  if (row.state === "completed") {
    if (row.terminal_result_hash !== responseHash) {
      throw new HrsThinkExecutionConflictError("hrs_think_execution_terminal_result_conflict");
    }
    const replay = await db.prepare(`SELECT request_hash,source,status,response_json,upstream_status
      FROM inference_idempotency WHERE idempotency_key=?`).bind(row.request_identity).first<{
        request_hash:string;source:string;status:string;response_json:string|null;upstream_status:number|null;
      }>();
    if (!replay || replay.request_hash !== row.inference_request_hash || replay.source !== row.inference_source
      || replay.status !== "completed" || replay.response_json !== input.responseJson || replay.upstream_status !== 200) {
      throw new HrsThinkExecutionConflictError("hrs_think_execution_terminal_replay_conflict");
    }
    const receipt = await readHrsThinkExecutionReceipt(db,row.execution_id);
    if (receipt.projection_result_hash === null) {
      await markHrsThinkProjectionPending(db,{ executionId:row.execution_id,resultHash:responseHash });
    } else if (receipt.projection_result_hash !== responseHash) {
      throw new HrsThinkExecutionConflictError("hrs_think_execution_terminal_projection_conflict");
    }
    return row;
  }
  if (row.state === "failed" || row.state === "attention_required") {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_terminal_state_conflict");
  }
  const revision = row.revision+1;
  const fencingToken = await sha256Hex(`fence\0${row.execution_id}\0${revision}`);
  const at = new Date().toISOString();
  const modelCallCount = input.modelCallCount ?? row.model_call_count;
  const toolCallCount = input.toolCallCount ?? row.tool_call_count;
  const directCallCount = input.directCallCount ?? row.direct_call_count;
  const codeModeCallCount = input.codeModeCallCount ?? row.code_mode_call_count;
  const recoveryAttempt = input.recoveryAttempt ?? row.recovery_attempt;
  await db.batch([
    db.prepare(`UPDATE hrs_think_executions SET state='completed',revision=?,fencing_token=?,
        next_inspection_at=NULL,terminal_result_hash=?,terminal_status=?,error_code=NULL,
        model_call_count=?,tool_call_count=?,direct_call_count=?,code_mode_call_count=?,recovery_attempt=?,
        updated_at=?,terminal_at=?
      WHERE execution_id=? AND request_identity=? AND revision=? AND fencing_token=?
        AND state IN ('prepared','submitted','held','running')
        AND EXISTS (SELECT 1 FROM inference_idempotency replay
          WHERE replay.idempotency_key=? AND replay.request_hash=? AND replay.source=?
            AND replay.status IN ('calling','responded'))`)
      .bind(revision,fencingToken,responseHash,input.terminalStatus,modelCallCount,toolCallCount,directCallCount,
        codeModeCallCount,recoveryAttempt,at,at,row.execution_id,row.request_identity,row.revision,row.fencing_token,
        row.request_identity,row.inference_request_hash,row.inference_source),
    db.prepare(`UPDATE inference_idempotency SET status='completed',response_json=?,upstream_status=200,
        last_error=NULL,updated_at=?,completed_at=?
      WHERE idempotency_key=? AND request_hash=? AND source=? AND status IN ('calling','responded')
        AND EXISTS (SELECT 1 FROM hrs_think_executions execution
          WHERE execution.execution_id=? AND execution.request_identity=? AND execution.state='completed'
            AND execution.revision=? AND execution.terminal_result_hash=?)`)
      .bind(input.responseJson,at,at,row.request_identity,row.inference_request_hash,row.inference_source,
        row.execution_id,row.request_identity,revision,responseHash),
    db.prepare(`UPDATE inference_presentations SET status='consumed',updated_at=?
      WHERE idempotency_key=? AND request_hash=? AND source=? AND status='ready'
        AND EXISTS (SELECT 1 FROM hrs_think_executions execution
          WHERE execution.execution_id=? AND execution.request_identity=? AND execution.state='completed'
            AND execution.revision=? AND execution.terminal_result_hash=?)
        AND EXISTS (SELECT 1 FROM inference_idempotency replay
          WHERE replay.idempotency_key=? AND replay.request_hash=? AND replay.source=?
            AND replay.status='completed' AND replay.response_json=?)`)
      .bind(at,row.request_identity,row.inference_request_hash,row.inference_source,
        row.execution_id,row.request_identity,revision,responseHash,
        row.request_identity,row.inference_request_hash,row.inference_source,input.responseJson),
    db.prepare(`UPDATE hrs_think_execution_receipts SET projection_result_hash=?,projection_completed_at=NULL,updated_at=?
      WHERE execution_id=? AND EXISTS (SELECT 1 FROM hrs_think_executions execution
        WHERE execution.execution_id=? AND execution.state='completed' AND execution.revision=?
          AND execution.terminal_result_hash=?)`)
      .bind(responseHash,at,row.execution_id,row.execution_id,revision,responseHash),
  ]);
  const completed = await readHrsThinkExecution(db,row.execution_id);
  if (!completed || completed.state !== "completed" || completed.revision !== revision
    || completed.fencing_token !== fencingToken || completed.terminal_result_hash !== responseHash) {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_atomic_completion_rejected");
  }
  const replay = await db.prepare(`SELECT request_hash,source,status,response_json,upstream_status
    FROM inference_idempotency WHERE idempotency_key=?`).bind(row.request_identity).first<{
      request_hash:string;source:string;status:string;response_json:string|null;upstream_status:number|null;
    }>();
  if (!replay || replay.request_hash !== row.inference_request_hash || replay.source !== row.inference_source
    || replay.status !== "completed" || replay.response_json !== input.responseJson || replay.upstream_status !== 200) {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_atomic_replay_rejected");
  }
  const receipt = await readHrsThinkExecutionReceipt(db,row.execution_id);
  if (receipt.projection_result_hash !== responseHash || receipt.projection_completed_at !== null) {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_atomic_projection_rejected");
  }
  return completed;
}

export async function requireHrsThinkExecutionAttention(
  db: D1Database,
  input: { executionId: string; requestIdentity: string; errorCode: string; recoveryAttempt?: number },
): Promise<HrsThinkExecutionRow> {
  const row = await readHrsThinkExecution(db,input.executionId);
  if (!row || row.request_identity !== input.requestIdentity) {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_locator_conflict");
  }
  const replayError = `hrs_think:${input.errorCode}`.slice(0,300);
  if (row.state === "attention_required") {
    if (row.error_code !== input.errorCode) {
      throw new HrsThinkExecutionConflictError("hrs_think_execution_attention_conflict");
    }
    const replay = await db.prepare(`SELECT request_hash,source,status,last_error FROM inference_idempotency
      WHERE idempotency_key=?`).bind(row.request_identity).first<{
        request_hash:string;source:string;status:string;last_error:string|null;
      }>();
    if (!replay || replay.request_hash !== row.inference_request_hash || replay.source !== row.inference_source
      || replay.status !== "attention_required" || replay.last_error !== replayError) {
      throw new HrsThinkExecutionConflictError("hrs_think_execution_attention_replay_conflict");
    }
    return row;
  }
  if (row.state === "completed" || row.state === "failed") {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_terminal_state_conflict");
  }
  const revision = row.revision+1;
  const fencingToken = await sha256Hex(`fence\0${row.execution_id}\0${revision}`);
  const at = new Date().toISOString();
  const recoveryAttempt = input.recoveryAttempt ?? row.recovery_attempt;
  await db.batch([
    db.prepare(`UPDATE hrs_think_executions SET state='attention_required',revision=?,fencing_token=?,
        next_inspection_at=NULL,terminal_status='attention_required',error_code=?,recovery_attempt=?,
        updated_at=?,terminal_at=?
      WHERE execution_id=? AND request_identity=? AND revision=? AND fencing_token=?
        AND state IN ('prepared','submitted','held','running')
        AND EXISTS (SELECT 1 FROM inference_idempotency replay
          WHERE replay.idempotency_key=? AND replay.request_hash=? AND replay.source=?
            AND replay.status IN ('calling','responded'))`)
      .bind(revision,fencingToken,input.errorCode,recoveryAttempt,at,at,row.execution_id,row.request_identity,
        row.revision,row.fencing_token,row.request_identity,row.inference_request_hash,row.inference_source),
    db.prepare(`UPDATE inference_idempotency SET status='attention_required',last_error=?,updated_at=?
      WHERE idempotency_key=? AND request_hash=? AND source=? AND status IN ('calling','responded')
        AND EXISTS (SELECT 1 FROM hrs_think_executions execution
          WHERE execution.execution_id=? AND execution.request_identity=? AND execution.state='attention_required'
            AND execution.revision=? AND execution.error_code=?)`)
      .bind(replayError,at,row.request_identity,row.inference_request_hash,row.inference_source,
        row.execution_id,row.request_identity,revision,input.errorCode),
    db.prepare(`UPDATE inference_presentations SET status='attention_required',updated_at=?
      WHERE idempotency_key=? AND request_hash=? AND source=? AND status='ready'
        AND EXISTS (SELECT 1 FROM hrs_think_executions execution
          WHERE execution.execution_id=? AND execution.state='attention_required' AND execution.revision=?)
        AND EXISTS (SELECT 1 FROM inference_idempotency replay
          WHERE replay.idempotency_key=? AND replay.status='attention_required' AND replay.last_error=?)`)
      .bind(at,row.request_identity,row.inference_request_hash,row.inference_source,row.execution_id,revision,
        row.request_identity,replayError),
  ]);
  const attention = await readHrsThinkExecution(db,row.execution_id);
  if (!attention || attention.state !== "attention_required" || attention.revision !== revision
    || attention.fencing_token !== fencingToken || attention.error_code !== input.errorCode) {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_atomic_attention_rejected");
  }
  const replay = await db.prepare(`SELECT status,last_error FROM inference_idempotency WHERE idempotency_key=?`)
    .bind(row.request_identity).first<{status:string;last_error:string|null}>();
  if (!replay || replay.status !== "attention_required" || replay.last_error !== replayError) {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_atomic_attention_replay_rejected");
  }
  return attention;
}

function sameImmutableExecution(
  row: HrsThinkExecutionRow,
  input: HrsThinkExecutionIdentity,
  stable: StableHrsThinkIdentity,
): boolean {
  return row.execution_id === stable.executionId && row.request_id_hash === stable.requestIdHash
    && row.client_request_hash === input.clientRequestHash
    && row.inference_request_hash === input.inferenceRequestHash && row.inference_source === input.inferenceSource
    && row.tg_batch_key === input.tgBatchKey && row.source_identity === input.sourceIdentity
    && row.owner_id === input.ownerId && row.chat_id === input.chatId && row.scope_kind === input.scopeKind
    && row.thread_key === input.threadKey
    && row.think_instance_id === input.thinkInstanceId && row.submission_id === input.submissionId
    && row.submission_idempotency_key === input.submissionIdempotencyKey && row.input_hash === input.inputHash
    && row.execution_profile === input.executionProfile && row.tool_surface_hash === input.toolSurfaceHash
    && row.namespace === input.namespace && row.conversation_id === input.conversationId && row.source === input.source
    && row.request_model === input.requestModel && row.upstream_model === input.upstreamModel
    && row.archive_idempotency_key === input.archiveIdempotencyKey
    && row.latest_user_message_id === input.latestUserMessageId && row.turn_order_key === input.turnOrderKey
    && row.provider === input.provider;
}
