import { sha256Hex } from "./approvalContinuation";
import type { OperiaSdkPendingApproval } from "./OperiaThinkHarness";

export type ThinkSdkActionProjectionRow = {
  approval_ref: string;
  execution_id: string;
  request_id: string;
  think_instance_id: string;
  authority_scope_hash: string;
  tool_key: string;
  operation_key: string;
  billing_class: string;
  summary: string;
  expires_at: string;
  status: "pending_approval" | "decision_pending" | "resolving" | "continuing" | "completed" | "attention_required";
  decision: "approve" | "reject" | null;
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
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export async function sdkActionApprovalRef(requestId: string, executionId: string): Promise<string> {
  const digest = await sha256Hex(`operia:think-sdk-action-projection:v1\0${requestId}\0${executionId}`);
  return `tsa_${digest.slice(0, 32)}`;
}

export async function persistThinkSdkActionProjections(input: {
  db: D1Database;
  requestId: string;
  thinkInstanceId: string;
  authorityScopeHash: string;
  pending: readonly OperiaSdkPendingApproval[];
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
}): Promise<Array<OperiaSdkPendingApproval & { approvalRef: string; callbacks: { approve: string; reject: string } }>> {
  const now = new Date().toISOString();
  const projected = [];
  for (const item of input.pending) {
    const approvalRef = await sdkActionApprovalRef(input.requestId, item.executionId);
    await input.db.prepare(`INSERT OR IGNORE INTO think_sdk_action_projections
      (approval_ref,execution_id,request_id,think_instance_id,authority_scope_hash,tool_key,operation_key,billing_class,
       summary,expires_at,status,inference_request_hash,inference_source,conversation_id,namespace,source,request_model,
       upstream_model,archive_idempotency_key,tg_batch_key,hrs_execution_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending_approval',?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      approvalRef, item.executionId, input.requestId, input.thinkInstanceId, input.authorityScopeHash,
      item.toolKey, item.operationKey, item.billingClass, item.summary, item.expiresAt,
      input.inferenceRequestHash, input.inferenceSource, input.conversationId, input.namespace, input.source,
      input.requestModel, input.upstreamModel, input.archiveIdempotencyKey, input.tgBatchKey,
      input.hrsExecutionId ?? null, now, now,
    ).run();
    const stored = await readThinkSdkActionProjection(input.db, approvalRef);
    const pinsMatch = stored
      && stored.execution_id === item.executionId
      && stored.request_id === input.requestId
      && stored.think_instance_id === input.thinkInstanceId
      && stored.authority_scope_hash === input.authorityScopeHash
      && stored.tool_key === item.toolKey
      && stored.operation_key === item.operationKey
      && stored.billing_class === item.billingClass
      && stored.summary === item.summary
      && stored.expires_at === item.expiresAt
      && stored.inference_request_hash === input.inferenceRequestHash
      && stored.inference_source === input.inferenceSource
      && stored.conversation_id === input.conversationId
      && stored.namespace === input.namespace
      && stored.source === input.source
      && stored.request_model === input.requestModel
      && stored.upstream_model === input.upstreamModel
      && stored.archive_idempotency_key === input.archiveIdempotencyKey
      && stored.tg_batch_key === input.tgBatchKey
      && stored.hrs_execution_id === (input.hrsExecutionId ?? null);
    if (!pinsMatch) throw new Error("think_sdk_action_projection_pin_drift");
    projected.push({
      ...item,
      approvalRef,
      callbacks: { approve: `sda:a:${approvalRef}`, reject: `sda:r:${approvalRef}` },
    });
  }
  return projected;
}

export async function readThinkSdkActionProjection(db: D1Database, approvalRef: string): Promise<ThinkSdkActionProjectionRow | null> {
  return db.prepare("SELECT * FROM think_sdk_action_projections WHERE approval_ref=?")
    .bind(approvalRef).first<ThinkSdkActionProjectionRow>();
}

export async function claimThinkSdkActionDecision(input: {
  db: D1Database;
  approvalRef: string;
  authorityScopeHash: string;
  decision: "approve" | "reject";
}): Promise<ThinkSdkActionProjectionRow | null> {
  const now = new Date().toISOString();
  return input.db.prepare(`UPDATE think_sdk_action_projections SET status='decision_pending',decision=?,last_error_code=NULL,updated_at=?
    WHERE approval_ref=? AND authority_scope_hash=? AND status='pending_approval' AND expires_at>?
      AND NOT EXISTS (
        SELECT 1 FROM think_sdk_action_projections selected
        WHERE selected.request_id=think_sdk_action_projections.request_id
          AND selected.approval_ref<>think_sdk_action_projections.approval_ref
          AND selected.status IN ('decision_pending','resolving','continuing','completed')
      )
    RETURNING *`).bind(input.decision, now, input.approvalRef, input.authorityScopeHash, now)
    .first<ThinkSdkActionProjectionRow>();
}

export async function releaseThinkSdkActionDecisionClaim(db: D1Database, approvalRef: string, code: string): Promise<void> {
  await db.prepare(`UPDATE think_sdk_action_projections SET status='pending_approval',decision=NULL,last_error_code=?,updated_at=?
    WHERE approval_ref=? AND status='decision_pending'`).bind(code.slice(0,160),new Date().toISOString(),approvalRef).run();
}

export async function claimThinkSdkActionExecution(
  db: D1Database,
  approvalRef: string,
  leaseMs = 120_000,
): Promise<ThinkSdkActionProjectionRow | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - Math.max(30_000,leaseMs)).toISOString();
  return db.prepare(`UPDATE think_sdk_action_projections SET status='resolving',last_error_code=NULL,updated_at=?
    WHERE approval_ref=? AND (
      status='decision_pending' OR (status='resolving' AND updated_at<=?)
    ) RETURNING *`).bind(now.toISOString(),approvalRef,staleBefore).first<ThinkSdkActionProjectionRow>();
}

export async function requeueThinkSdkActionDecision(db: D1Database, approvalRef: string, code: string): Promise<void> {
  const changed = await db.prepare(`UPDATE think_sdk_action_projections SET status='decision_pending',last_error_code=?,updated_at=?
    WHERE approval_ref=? AND status='resolving' RETURNING approval_ref`)
    .bind(code.slice(0,160),new Date().toISOString(),approvalRef).first<{approval_ref:string}>();
  if (!changed) throw new Error("think_sdk_action_projection_state_drift");
}

export async function markThinkSdkActionContinuing(db: D1Database, approvalRef: string): Promise<void> {
  const changed = await db.prepare(`UPDATE think_sdk_action_projections SET status='continuing',last_error_code=NULL,updated_at=?
    WHERE approval_ref=? AND status='resolving' RETURNING approval_ref`).bind(new Date().toISOString(), approvalRef)
    .first<{ approval_ref: string }>();
  if (!changed) throw new Error("think_sdk_action_projection_state_drift");
}

export async function markThinkSdkActionAttention(db: D1Database, approvalRef: string, code: string): Promise<void> {
  await db.prepare(`UPDATE think_sdk_action_projections SET status='attention_required',last_error_code=?,updated_at=?
    WHERE approval_ref=? AND status!='completed'`).bind(code.slice(0, 160), new Date().toISOString(), approvalRef).run();
}

export async function markThinkSdkActionCompleted(
  db: D1Database,
  approvalRef: string,
  terminalErrorCode: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE think_sdk_action_projections SET status='completed',last_error_code=?,updated_at=?,completed_at=?
    WHERE approval_ref=? AND status='continuing'`)
    .bind(terminalErrorCode?.slice(0, 160) ?? null, now, now, approvalRef).run();
}

export async function completeThinkSdkActionSiblings(db: D1Database, requestId: string, selectedApprovalRef: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE think_sdk_action_projections SET status='completed',decision='reject',
    last_error_code='superseded_by_single_action',updated_at=?,completed_at=?
    WHERE request_id=? AND approval_ref<>? AND status='pending_approval'`)
    .bind(now,now,requestId,selectedApprovalRef).run();
}
