import type { Env } from "../../types";

export type ThinkCodeModeContinuationStatus =
  | "pending_agent" | "result_ready" | "continuing" | "finalizing" | "completed" | "stopped"
  | "failed" | "quarantined" | "attention_required";

export type ThinkCodeModeContinuationRow = {
  codemode_ref: string;
  request_id: string;
  agent_request_id: string;
  think_instance_id: string;
  agent_execution_id: string;
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
  status: ThinkCodeModeContinuationStatus;
  result_receipt_hash: string | null;
  continuation_attempts: number;
  last_error_code: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type PersistThinkCodeModeContinuation = {
  codemodeRef: string;
  requestId: string;
  agentRequestId: string;
  thinkInstanceId: string;
  agentExecutionId: string;
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

const SAFE_REF = /^tcm_[a-f0-9]{32}$/;
const SAFE_EXECUTION = /^cmxe_[a-f0-9]{64}$/;
export const THINK_CODEMODE_PROVIDER_ATTEMPT_LIMIT = 24;
export const THINK_CODEMODE_FINALIZATION_ATTEMPT_LIMIT = 48;

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function stableThinkCodeModeRef(requestId: string, executionId: string): Promise<string> {
  const digest = await sha256Hex(`operia:think:codemode-continuation:v1\0${requestId}\0${executionId}`);
  return `tcm_${digest.slice(0, 32)}`;
}

export async function thinkCodeModeSubmissionId(requestId: string, executionId: string, receiptHash: string): Promise<string> {
  const digest = await sha256Hex(`operia:think:codemode-submission:v1\0${requestId}\0${executionId}\0${receiptHash}`);
  return `thsub_${digest.slice(0, 40)}`;
}

export async function persistThinkCodeModeContinuation(db: D1Database, row: PersistThinkCodeModeContinuation): Promise<void> {
  assertPersistedRow(row);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO think_codemode_continuations
    (codemode_ref,request_id,agent_request_id,think_instance_id,agent_execution_id,authority_scope_hash,
     inference_request_hash,inference_source,conversation_id,namespace,source,request_model,upstream_model,
     archive_idempotency_key,tg_batch_key,hrs_execution_id,status,expires_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(codemode_ref) DO UPDATE SET updated_at=excluded.updated_at
    WHERE think_codemode_continuations.request_id=excluded.request_id
      AND think_codemode_continuations.think_instance_id=excluded.think_instance_id
      AND think_codemode_continuations.agent_execution_id=excluded.agent_execution_id
      AND think_codemode_continuations.authority_scope_hash=excluded.authority_scope_hash
      AND COALESCE(think_codemode_continuations.hrs_execution_id,'')=COALESCE(excluded.hrs_execution_id,'')`)
    .bind(row.codemodeRef,row.requestId,row.agentRequestId,row.thinkInstanceId,row.agentExecutionId,row.authorityScopeHash,
      row.inferenceRequestHash,row.inferenceSource,row.conversationId,row.namespace,row.source,row.requestModel,row.upstreamModel,
      row.archiveIdempotencyKey,row.tgBatchKey,row.hrsExecutionId ?? null,"pending_agent",row.expiresAt,now,now).run();
}

export async function readThinkCodeModeContinuation(db: D1Database, ref: string): Promise<ThinkCodeModeContinuationRow | null> {
  if (!SAFE_REF.test(ref)) return null;
  return db.prepare("SELECT * FROM think_codemode_continuations WHERE codemode_ref=?").bind(ref).first<ThinkCodeModeContinuationRow>();
}

export async function updateThinkCodeModeContinuation(input: {
  db: D1Database;
  ref: string;
  from: readonly ThinkCodeModeContinuationStatus[];
  to: ThinkCodeModeContinuationStatus;
  receiptHash?: string | null;
  submissionId?: string | null;
  errorCode?: string | null;
  incrementAttempts?: boolean;
}): Promise<boolean> {
  if (!SAFE_REF.test(input.ref) || input.from.length === 0) return false;
  const now = new Date().toISOString();
  const placeholders = input.from.map(() => "?").join(",");
  const completedAt = ["completed","stopped","failed","quarantined","attention_required"].includes(input.to) ? now : null;
  const row = await input.db.prepare(`UPDATE think_codemode_continuations SET status=?,
      result_receipt_hash=COALESCE(?,result_receipt_hash),think_submission_id=COALESCE(?,think_submission_id),
      last_error_code=?,continuation_attempts=continuation_attempts+?,updated_at=?,completed_at=COALESCE(?,completed_at)
    WHERE codemode_ref=? AND status IN (${placeholders}) RETURNING codemode_ref`)
    .bind(input.to,input.receiptHash ?? null,input.submissionId ?? null,input.errorCode ?? null,
      input.incrementAttempts ? 1 : 0,now,completedAt,input.ref,...input.from).first<{codemode_ref:string}>();
  return Boolean(row);
}

export async function enqueueThinkCodeModeContinuation(env: Env, ref: string, attempt = 0, delaySeconds = 0): Promise<void> {
  if (!env.MEMORY_QUEUE) throw new Error("think_codemode_queue_missing");
  if (!SAFE_REF.test(ref) || !Number.isSafeInteger(attempt) || attempt < 0
    || attempt >= THINK_CODEMODE_FINALIZATION_ATTEMPT_LIMIT) {
    throw new Error("think_codemode_queue_input_invalid");
  }
  await env.MEMORY_QUEUE.send({ type: "think_codemode_resume", codemodeRef: ref, attempt }, { delaySeconds });
}

export async function stopThinkCodeModeContinuation(env: Env, ref: string): Promise<ThinkCodeModeContinuationRow | null> {
  const row = await readThinkCodeModeContinuation(env.DB, ref);
  if (!row) return null;
  if (["completed","failed","quarantined","attention_required"].includes(row.status)) return row;
  if (row.status === "stopped") return row;
  const stopped = await updateThinkCodeModeContinuation({ db: env.DB, ref, from: ["pending_agent","result_ready","continuing"],
    to: "stopped", errorCode: "codemode_owner_stopped" });
  if (!stopped) return await readThinkCodeModeContinuation(env.DB, ref);
  return { ...row, status: "stopped", last_error_code: "codemode_owner_stopped" };
}

function assertPersistedRow(row: PersistThinkCodeModeContinuation): void {
  if (!SAFE_REF.test(row.codemodeRef) || !SAFE_EXECUTION.test(row.agentExecutionId)) throw new Error("think_codemode_locator_invalid");
  if (!/^[a-f0-9]{64}$/.test(row.authorityScopeHash) || !/^[a-f0-9]{64}$/.test(row.inferenceRequestHash)) {
    throw new Error("think_codemode_hash_invalid");
  }
  if (!Number.isFinite(Date.parse(row.expiresAt))) throw new Error("think_codemode_expiry_invalid");
}
