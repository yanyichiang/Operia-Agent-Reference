import { sha256Hex } from "./toolCatalog";

export const OPERIA_CODEMODE_EXECUTION_LEASE_MS = 90_000;
export const OPERIA_CODEMODE_MAX_RECOVERY_GENERATIONS = 3;

export type OperiaCodeModeExecutionStatus =
  | "accepted"
  | "executing"
  | "completed"
  | "failed"
  | "quarantined"
  | "attention_required";

export type OperiaCodeModeExecutionIdentity = {
  taskId: string;
  executionId: string;
  ownerId: string;
  chatId: string;
  scopeKind: "private" | "qa_room";
  threadKey: string;
  requestId: string;
  codeHash: string;
  catalogRevision: string;
  catalogSnapshotHash: string;
  policyVersion: string;
  connectorVersionsJson: string;
  skillRevision: string;
  pauseGeneration: number;
};

export type OperiaCodeModeExecutionRow = {
  status: string;
  resultJson: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  recoveryGeneration: number;
} & OperiaCodeModeExecutionIdentity;

export type OperiaCodeModeExecutionDecision =
  | { kind: "claim"; nextRecoveryGeneration: number }
  | { kind: "pending"; retryAfterMs: number; recoveryGeneration: number }
  | { kind: "completed"; resultJson: string }
  | { kind: "terminal"; status: "failed" | "quarantined" | "attention_required"; errorCode: string };

export type OperiaCodeModeInnerReplayPolicy = "safe_local" | "downstream_idempotent" | "never_retry_unknown";

export type OperiaCodeModeInnerCallRow = {
  status: "reserved" | "invoking" | "completed" | "failed" | "unknown";
  replayPolicy: OperiaCodeModeInnerReplayPolicy;
  attemptCount: number;
  recoveryGeneration: number;
};

export type OperiaCodeModeInnerDecision =
  | { kind: "invoke"; recovered: boolean }
  | { kind: "pending" }
  | { kind: "receipt" }
  | { kind: "unknown"; errorCode: string }
  | { kind: "failed"; errorCode: string };

export async function deriveCodeModeExecutionTaskId(input: {
  ownerId: string;
  chatId: string;
  scopeKind: "private" | "qa_room";
  threadKey: string;
  requestId: string;
}): Promise<string> {
  return deriveDomainSeparatedId("cmx_", "operia:codemode:execution:v1", [
    input.ownerId,
    input.chatId,
    input.scopeKind,
    input.threadKey,
    input.requestId,
  ]);
}

export async function deriveCodeModeInnerTaskId(input: {
  outerTaskId: string;
  executionId: string;
  callKey: string;
}): Promise<string> {
  return deriveDomainSeparatedId("cm_", "operia:codemode:inner:v1", [
    input.outerTaskId,
    input.executionId,
    input.callKey,
  ]);
}

export async function deriveCodeModeSandboxTaskId(input: {
  outerTaskId: string;
  executionId: string;
  callKey: string;
}): Promise<string> {
  return deriveDomainSeparatedId("cms_", "operia:codemode:sandbox:v1", [
    input.outerTaskId,
    input.executionId,
    input.callKey,
  ]);
}

export function decideCodeModeExecution(
  row: OperiaCodeModeExecutionRow,
  expected: OperiaCodeModeExecutionIdentity,
  nowMs: number,
): OperiaCodeModeExecutionDecision {
  assertExecutionIdentity(row, expected);
  if (row.status === "completed") {
    return row.resultJson
      ? { kind: "completed", resultJson: row.resultJson }
      : { kind: "terminal", status: "attention_required", errorCode: "codemode_completed_result_missing" };
  }
  if (row.status === "failed" || row.status === "quarantined" || row.status === "attention_required") {
    return { kind: "terminal", status: row.status, errorCode: `codemode_execution_${row.status}` };
  }
  if (row.status === "accepted") {
    return { kind: "claim", nextRecoveryGeneration: row.recoveryGeneration + 1 };
  }
  if (row.status !== "executing") {
    return { kind: "terminal", status: "attention_required", errorCode: "codemode_execution_status_invalid" };
  }
  const leaseExpiresMs = row.leaseExpiresAt ? Date.parse(row.leaseExpiresAt) : Number.NaN;
  if (Number.isFinite(leaseExpiresMs) && leaseExpiresMs > nowMs) {
    return {
      kind: "pending",
      retryAfterMs: Math.max(250, leaseExpiresMs - nowMs),
      recoveryGeneration: row.recoveryGeneration,
    };
  }
  if (row.recoveryGeneration >= OPERIA_CODEMODE_MAX_RECOVERY_GENERATIONS) {
    return { kind: "terminal", status: "attention_required", errorCode: "codemode_recovery_budget_exhausted" };
  }
  return { kind: "claim", nextRecoveryGeneration: row.recoveryGeneration + 1 };
}

export function codeModeInnerReplayPolicy(method: string): OperiaCodeModeInnerReplayPolicy {
  if (method === "catalog.search" || method === "catalog.describe" || method.startsWith("skill.")) return "safe_local";
  if (method === "mcp.call" || method === "direct.call") return "downstream_idempotent";
  return "never_retry_unknown";
}

export function decideCodeModeInnerCall(
  row: OperiaCodeModeInnerCallRow | null,
  replayPolicy: OperiaCodeModeInnerReplayPolicy,
  recoveryGeneration: number,
): OperiaCodeModeInnerDecision {
  if (!row || row.status === "reserved") return { kind: "invoke", recovered: Boolean(row) };
  if (row.replayPolicy !== replayPolicy) return { kind: "unknown", errorCode: "codemode_inner_replay_policy_drift" };
  if (row.status === "completed") return { kind: "receipt" };
  if (row.status === "unknown") return { kind: "unknown", errorCode: "codemode_inner_unknown_result" };
  if (row.status === "failed") return { kind: "failed", errorCode: "codemode_inner_failed" };
  if (row.recoveryGeneration === recoveryGeneration) return { kind: "pending" };
  if (replayPolicy === "never_retry_unknown") {
    return { kind: "unknown", errorCode: "codemode_inner_unknown_result" };
  }
  if (row.attemptCount >= 2) {
    return { kind: "unknown", errorCode: "codemode_inner_recovery_budget_exhausted" };
  }
  return { kind: "invoke", recovered: true };
}

export function codeModeLeaseExpiry(nowMs: number): string {
  return new Date(nowMs + OPERIA_CODEMODE_EXECUTION_LEASE_MS).toISOString();
}

function assertExecutionIdentity(
  row: OperiaCodeModeExecutionIdentity,
  expected: OperiaCodeModeExecutionIdentity,
): void {
  const keys: Array<keyof OperiaCodeModeExecutionIdentity> = [
    "taskId",
    "executionId",
    "ownerId",
    "chatId",
    "scopeKind",
    "threadKey",
    "requestId",
    "codeHash",
    "catalogRevision",
    "catalogSnapshotHash",
    "policyVersion",
    "connectorVersionsJson",
    "skillRevision",
    "pauseGeneration",
  ];
  for (const key of keys) {
    if (row[key] !== expected[key]) throw new Error(`codemode_execution_${String(key)}_drift`);
  }
}

async function deriveDomainSeparatedId(prefix: string, domain: string, parts: string[]): Promise<string> {
  const digest = await sha256Hex(`${domain}\0${parts.join("\0")}`);
  return `${prefix}${digest}`;
}
