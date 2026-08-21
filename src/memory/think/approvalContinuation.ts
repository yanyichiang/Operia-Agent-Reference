import type { Env } from "../../types";

export type ThinkApprovalDecisionScope = "once" | "task" | "reject";
export type ThinkApprovalContinuationStatus =
  | "pending_approval"
  | "decision_reserved"
  | "result_ready"
  | "continuing"
  | "completed"
  | "rejected"
  | "stopped"
  | "quarantined"
  | "attention_required";

export type ThinkApprovalContinuationRow = {
  approval_ref: string;
  request_id: string;
  think_instance_id: string;
  agent_task_id: string;
  agent_ticket_id: string;
  think_task_id: string;
  agent_call_key: string;
  tool_key: string;
  args_hash: string;
  schema_hash: string;
  policy_version: string;
  pause_generation: number;
  authority_scope_hash: string;
  inference_request_hash: string;
  inference_source: string;
  conversation_id: string | null;
  namespace: string;
  source: string;
  request_model: string;
  upstream_model: string;
  archive_idempotency_key: string | null;
  tg_batch_key: string | null;
  hrs_execution_id: string | null;
  think_submission_id: string | null;
  decision_scope: ThinkApprovalDecisionScope | null;
  status: ThinkApprovalContinuationStatus;
  result_receipt_hash: string | null;
  continuation_attempts: number;
  last_error_code: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type PersistThinkApprovalContinuation = {
  approvalRef: string;
  requestId: string;
  thinkInstanceId: string;
  agentTaskId: string;
  agentTicketId: string;
  thinkTaskId: string;
  agentCallKey: string;
  toolKey: string;
  argsHash: string;
  schemaHash: string;
  policyVersion: string;
  pauseGeneration: number;
  authorityScopeHash: string;
  inferenceRequestHash: string;
  inferenceSource: string;
  conversationId: string | null;
  namespace: string;
  source: string;
  requestModel: string;
  upstreamModel: string;
  archiveIdempotencyKey: string | null;
  tgBatchKey: string | null;
  hrsExecutionId?: string | null;
  expiresAt: string;
};

const SAFE_REF = /^tap_[a-f0-9]{32}$/;
const SAFE_TASK = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const SAFE_TICKET = /^apt_[a-f0-9]{24}$/;
const SAFE_CALL_KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_DECISION = new Set<ThinkApprovalDecisionScope>(["once", "task", "reject"]);
export const MAX_THINK_APPROVAL_CONTINUATION_ATTEMPTS = 24;
export const MAX_THINK_APPROVAL_FINALIZATION_ATTEMPTS = 48;

export function approvalRetryDisposition(
  attempt: number,
  maxAttempts = MAX_THINK_APPROVAL_CONTINUATION_ATTEMPTS,
): { kind: "enqueue"; nextAttempt: number } | { kind: "terminalize" } {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
    throw new Error("think_approval_retry_input_invalid");
  }
  return attempt >= maxAttempts ? { kind: "terminalize" } : { kind: "enqueue", nextAttempt: attempt + 1 };
}

export async function retryApprovalContinuationAtBoundary(input: {
  attempt: number;
  maxAttempts?: number;
  enqueue(nextAttempt: number): Promise<void>;
  terminalize(): Promise<void>;
}): Promise<"enqueued" | "terminalized"> {
  const disposition = approvalRetryDisposition(input.attempt, input.maxAttempts);
  if (disposition.kind === "terminalize") {
    await input.terminalize();
    return "terminalized";
  }
  await input.enqueue(disposition.nextAttempt);
  return "enqueued";
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function stableThinkApprovalRef(input: {
  requestId: string;
  taskId: string;
  ticketId: string;
  toolKey: string;
}): Promise<string> {
  const digest = await sha256Hex([
    "operia:think:approval-continuation:v1",
    input.requestId,
    input.taskId,
    input.ticketId,
    input.toolKey,
  ].join("\0"));
  return `tap_${digest.slice(0, 32)}`;
}

export async function thinkApprovalAuthorityScopeHash(input: {
  ownerId: string;
  chatId: string;
  scopeKind: "private" | "qa_room";
  threadKey: string;
}): Promise<string> {
  return sha256Hex([
    "operia:think:approval-authority:v1",
    input.ownerId,
    input.chatId,
    input.scopeKind,
    input.threadKey,
  ].join("\0"));
}

export function thinkApprovalSubmissionId(requestId: string): Promise<string> {
  return sha256Hex(`operia:think:approval-submission:v1\0${requestId}`)
    .then((digest) => `thsub_${digest.slice(0, 40)}`);
}

export function nextThinkAgentCallIdentity(input: {
  thinkTaskId: string;
  sequence: number;
  kind: "system-status" | "tool";
}): { thinkTaskId: string; agentCallKey: string; requestId: string; nextSequence: number } {
  if (!SAFE_TASK.test(input.thinkTaskId) || !Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new Error("think_agent_call_identity_invalid");
  }
  const nextSequence = input.sequence + 1;
  const suffix = input.thinkTaskId.replace(/[^A-Za-z0-9:_-]/g, "-").slice(0, 88);
  const agentCallKey = `thinkcall:${nextSequence}:${input.kind}:${suffix}`.slice(0, 128);
  return { thinkTaskId: input.thinkTaskId, agentCallKey, requestId: agentCallKey, nextSequence };
}

export function ticketIdFromApprovalPresentation(value: Record<string, unknown>): string | null {
  const ticketId = typeof value.ticketId === "string" ? value.ticketId : "";
  return SAFE_TICKET.test(ticketId) ? ticketId : null;
}

export function approvalExpiryFromPresentation(value: Record<string, unknown>): string | null {
  const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt : "";
  return Number.isFinite(Date.parse(expiresAt)) ? expiresAt : null;
}

export async function persistThinkApprovalContinuations(
  db: D1Database,
  rows: readonly PersistThinkApprovalContinuation[],
): Promise<void> {
  const now = new Date().toISOString();
  for (const row of rows) assertPersistedRow(row);
  for (const row of rows) {
    await db.prepare(`INSERT INTO think_approval_continuations
      (approval_ref,request_id,think_instance_id,agent_task_id,agent_ticket_id,think_task_id,agent_call_key,tool_key,
       args_hash,schema_hash,policy_version,pause_generation,
       authority_scope_hash,inference_request_hash,inference_source,conversation_id,namespace,source,
       request_model,upstream_model,archive_idempotency_key,tg_batch_key,hrs_execution_id,status,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(approval_ref) DO UPDATE SET
        updated_at=excluded.updated_at
      WHERE think_approval_continuations.request_id=excluded.request_id
        AND think_approval_continuations.think_instance_id=excluded.think_instance_id
        AND think_approval_continuations.agent_task_id=excluded.agent_task_id
        AND think_approval_continuations.agent_ticket_id=excluded.agent_ticket_id
        AND think_approval_continuations.think_task_id=excluded.think_task_id
        AND think_approval_continuations.agent_call_key=excluded.agent_call_key
        AND think_approval_continuations.tool_key=excluded.tool_key
        AND think_approval_continuations.args_hash=excluded.args_hash
        AND think_approval_continuations.schema_hash=excluded.schema_hash
        AND think_approval_continuations.policy_version=excluded.policy_version
        AND think_approval_continuations.pause_generation=excluded.pause_generation
        AND think_approval_continuations.authority_scope_hash=excluded.authority_scope_hash
        AND COALESCE(think_approval_continuations.hrs_execution_id,'')=COALESCE(excluded.hrs_execution_id,'')`)
      .bind(
        row.approvalRef, row.requestId, row.thinkInstanceId, row.agentTaskId, row.agentTicketId,
        row.thinkTaskId, row.agentCallKey, row.toolKey, row.argsHash, row.schemaHash, row.policyVersion, row.pauseGeneration,
        row.authorityScopeHash, row.inferenceRequestHash, row.inferenceSource, row.conversationId,
        row.namespace, row.source, row.requestModel, row.upstreamModel, row.archiveIdempotencyKey,
        row.tgBatchKey, row.hrsExecutionId ?? null, "pending_approval", row.expiresAt, now, now,
      ).run();
  }
}

export async function reserveThinkApprovalDecision(input: {
  env: Env;
  ticketId: string;
  decisionScope: ThinkApprovalDecisionScope;
  authorityScopeHash: string;
}): Promise<ThinkApprovalContinuationRow | null> {
  if (!SAFE_TICKET.test(input.ticketId) || !SAFE_DECISION.has(input.decisionScope)
    || !/^[a-f0-9]{64}$/.test(input.authorityScopeHash)) return null;
  const now = new Date().toISOString();
  const updated = await input.env.DB.prepare(`UPDATE think_approval_continuations SET
      status=CASE WHEN status='pending_approval' THEN 'decision_reserved' ELSE status END,
      decision_scope=COALESCE(decision_scope,?),updated_at=?
    WHERE agent_ticket_id=? AND authority_scope_hash=?
      AND status IN ('pending_approval','decision_reserved','result_ready','continuing','completed','rejected')
      AND (decision_scope IS NULL OR decision_scope=?)
      AND NOT EXISTS (
        SELECT 1 FROM think_approval_continuations AS terminal
        WHERE terminal.request_id=think_approval_continuations.request_id
          AND terminal.status IN ('stopped','quarantined','attention_required')
      )
    RETURNING *`)
    .bind(input.decisionScope, now, input.ticketId, input.authorityScopeHash, input.decisionScope)
    .first<ThinkApprovalContinuationRow>();
  return updated ?? null;
}

export async function readThinkApprovalContinuationByTicket(
  db: D1Database,
  ticketId: string,
): Promise<ThinkApprovalContinuationRow | null> {
  if (!SAFE_TICKET.test(ticketId)) return null;
  return db.prepare("SELECT * FROM think_approval_continuations WHERE agent_ticket_id=?")
    .bind(ticketId).first<ThinkApprovalContinuationRow>();
}

export async function expireThinkApprovalContinuation(
  db: D1Database,
  approvalRef: string,
): Promise<ThinkApprovalContinuationRow | null> {
  if (!SAFE_REF.test(approvalRef)) return null;
  const now = new Date().toISOString();
  return db.prepare(`UPDATE think_approval_continuations SET status='decision_reserved',decision_scope='reject',
      last_error_code='approval_expired',updated_at=?
    WHERE approval_ref=? AND status='pending_approval' AND expires_at<=? RETURNING *`)
    .bind(now, approvalRef, now).first<ThinkApprovalContinuationRow>();
}

export async function stopThinkApprovalContinuation(input: {
  env: Env;
  taskId?: string;
  ticketId?: string;
  authorityScopeHash: string;
}): Promise<ThinkApprovalContinuationRow | null> {
  const byTask = typeof input.taskId === "string" && SAFE_TASK.test(input.taskId);
  const byTicket = typeof input.ticketId === "string" && SAFE_TICKET.test(input.ticketId);
  if (byTask === byTicket || !/^[a-f0-9]{64}$/.test(input.authorityScopeHash)) return null;
  const located = await input.env.DB.prepare(`SELECT * FROM think_approval_continuations
    WHERE ${byTask ? "agent_task_id" : "agent_ticket_id"}=? AND authority_scope_hash=? LIMIT 1`)
    .bind(byTask ? input.taskId : input.ticketId, input.authorityScopeHash).first<ThinkApprovalContinuationRow>();
  if (!located) return null;
  if (located.status === "completed") return null;
  if (located.status === "stopped") return located;
  const now = new Date().toISOString();
  await input.env.DB.prepare(`UPDATE think_approval_continuations SET status='stopped',decision_scope='reject',
    last_error_code='owner_stopped',updated_at=?,completed_at=COALESCE(completed_at,?)
    WHERE request_id=? AND status NOT IN ('completed','stopped')`)
    .bind(now, now, located.request_id).run();
  return { ...located, status: "stopped", decision_scope: "reject", last_error_code: "owner_stopped", updated_at: now };
}

export async function readThinkApprovalContinuationByRef(
  db: D1Database,
  approvalRef: string,
): Promise<ThinkApprovalContinuationRow | null> {
  if (!SAFE_REF.test(approvalRef)) return null;
  return db.prepare("SELECT * FROM think_approval_continuations WHERE approval_ref=?")
    .bind(approvalRef).first<ThinkApprovalContinuationRow>();
}

export async function readThinkApprovalContinuationGroup(
  db: D1Database,
  requestId: string,
): Promise<ThinkApprovalContinuationRow[]> {
  const result = await db.prepare(`SELECT * FROM think_approval_continuations
    WHERE request_id=? ORDER BY created_at,approval_ref`).bind(requestId).all<ThinkApprovalContinuationRow>();
  return result.results ?? [];
}

export async function updateThinkApprovalContinuationState(input: {
  db: D1Database;
  approvalRef: string;
  from: readonly ThinkApprovalContinuationStatus[];
  to: ThinkApprovalContinuationStatus;
  receiptHash?: string | null;
  submissionId?: string | null;
  errorCode?: string | null;
  incrementAttempts?: boolean;
}): Promise<boolean> {
  if (!SAFE_REF.test(input.approvalRef) || input.from.length === 0) return false;
  const placeholders = input.from.map(() => "?").join(",");
  const now = new Date().toISOString();
  const completedAt = input.to === "completed" ? now : null;
  const updated = await input.db.prepare(`UPDATE think_approval_continuations SET
      status=?,result_receipt_hash=COALESCE(?,result_receipt_hash),
      think_submission_id=COALESCE(?,think_submission_id),last_error_code=?,
      continuation_attempts=continuation_attempts+?,updated_at=?,completed_at=COALESCE(?,completed_at)
    WHERE approval_ref=? AND status IN (${placeholders}) RETURNING approval_ref`)
    .bind(
      input.to, input.receiptHash ?? null, input.submissionId ?? null, input.errorCode ?? null,
      input.incrementAttempts ? 1 : 0, now, completedAt, input.approvalRef, ...input.from,
    ).first<{ approval_ref: string }>();
  return Boolean(updated);
}

export async function enqueueThinkApprovalContinuation(
  env: Env,
  approvalRef: string,
  attempt = 0,
  delaySeconds = 0,
): Promise<void> {
  if (!env.MEMORY_QUEUE) throw new Error("think_approval_queue_missing");
  if (!SAFE_REF.test(approvalRef) || !Number.isSafeInteger(attempt) || attempt < 0
    || attempt > MAX_THINK_APPROVAL_FINALIZATION_ATTEMPTS) {
    throw new Error("think_approval_queue_input_invalid");
  }
  await env.MEMORY_QUEUE.send({ type: "think_approval_resume", approvalRef, attempt }, { delaySeconds });
}

function assertPersistedRow(row: PersistThinkApprovalContinuation): void {
  if (typeof row.approvalRef !== "string" || typeof row.agentTaskId !== "string" || typeof row.agentTicketId !== "string"
    || !SAFE_REF.test(row.approvalRef) || !SAFE_TASK.test(row.agentTaskId) || !SAFE_TICKET.test(row.agentTicketId)) {
    throw new Error("think_approval_locator_invalid");
  }
  if (typeof row.thinkTaskId !== "string" || typeof row.agentCallKey !== "string"
    || typeof row.argsHash !== "string" || typeof row.schemaHash !== "string" || typeof row.policyVersion !== "string"
    || !SAFE_TASK.test(row.thinkTaskId) || !SAFE_CALL_KEY.test(row.agentCallKey)
    || !SHA256.test(row.argsHash) || !SHA256.test(row.schemaHash)
    || !row.policyVersion || row.policyVersion.length > 240
    || !Number.isSafeInteger(row.pauseGeneration) || row.pauseGeneration < 0) {
    throw new Error("think_approval_pin_invalid");
  }
  if (!SHA256.test(row.authorityScopeHash) || !SHA256.test(row.inferenceRequestHash)) {
    throw new Error("think_approval_hash_invalid");
  }
  if (!Number.isFinite(Date.parse(row.expiresAt))) throw new Error("think_approval_expiry_invalid");
}
