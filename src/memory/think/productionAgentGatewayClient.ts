import type { ToolDescriptionV3, ToolDescriptorV3 } from "../../agent/toolCatalog";
import type { JsonValue } from "../../agent/types";
import { THINK_APPROVAL_PROBE_INTENT } from "../../thinkApprovalProbe";

export type OperiaThinkScope = {
  ownerId: string;
  chatId: string;
  scopeKind: "private" | "qa_room";
  threadKey: string;
};

export type ProductionAgentGatewayEnv = {
  AGENT_SERVICE?: Fetcher;
  AGENT_THINK_SERVICE_BEARER?: string;
};

export type ProductionApprovalReceipt = {
  ticketId: string;
  taskId: string;
  thinkTaskId?: string;
  agentCallKey?: string;
  argsHash?: string;
  schemaHash?: string;
  policyVersion?: string;
  pauseGeneration?: number;
  status: "pending" | "completed" | "rejected" | "expired" | "cancelled" | "quarantined" | "attention_required";
  receiptHash?: string;
  result?: unknown;
};

export type ProductionCatalog = {
  catalogRevision: string;
  snapshotHash: string;
  policyVersion: string;
  connectorVersions: Record<string, string>;
  descriptors: ToolDescriptorV3[];
};

export type ProductionThinkActionGrant = {
  grantId: string;
  status: "proposed";
  toolKey: string;
  argsHash: string;
  schemaHash: string;
  policyVersion: string;
  catalogRevision: string;
  catalogSnapshotHash: string;
  pauseGeneration: number;
  billingClass: string;
  expiresAt: string;
  externalWrites: 0;
};

export type ProductionCodeModePending = {
  kind: "codemode_pending";
  requestId: string;
  executionId: string;
  status: "accepted" | "executing";
  retryAfterMs: number;
  externalWrites: 0;
};

export type ProductionCodeModeCompleted = {
  kind: "codemode_completed";
  requestId: string;
  executionId: string;
  status: "completed";
  receiptHash: string;
  result: unknown;
  externalWrites: 0;
};

export type ProductionCodeModeTerminal = {
  kind: "codemode_terminal";
  requestId: string;
  executionId: string;
  status: "failed" | "quarantined" | "attention_required";
  error: string;
  externalWrites: 0;
};

export type ProductionCodeModeImmediate = {
  kind: "codemode_immediate";
  requestId: string;
  status: "completed";
  result: unknown;
  externalWrites: 0;
};

export type ProductionCodeModeState = ProductionCodeModePending | ProductionCodeModeCompleted | ProductionCodeModeTerminal | ProductionCodeModeImmediate;

export async function readProductionCatalog(env: ProductionAgentGatewayEnv, scope: OperiaThinkScope): Promise<ProductionCatalog> {
  return gatewayJson(env, scope, "/service/think/catalog", { method: "GET" });
}

export async function searchProductionTools(input: {
  env: ProductionAgentGatewayEnv;
  scope: OperiaThinkScope;
  catalog: ProductionCatalog;
  query: string;
  limit: number;
}): Promise<{ catalogRevision: string; catalogSnapshotHash: string; tools: ToolDescriptorV3[] }> {
  return gatewayJson(input.env, input.scope, "/service/think/search", {
    method: "POST",
    body: JSON.stringify({
      ...input.scope,
      query: input.query,
      limit: input.limit,
      catalogRevision: input.catalog.catalogRevision,
      catalogSnapshotHash: input.catalog.snapshotHash,
    }),
  });
}

export async function describeProductionTool(input: {
  env: ProductionAgentGatewayEnv;
  scope: OperiaThinkScope;
  catalog: ProductionCatalog;
  toolKey: string;
}): Promise<ToolDescriptionV3> {
  return gatewayJson(input.env, input.scope, "/service/think/describe", {
    method: "POST",
    body: JSON.stringify({
      ...input.scope,
      toolKey: input.toolKey,
      catalogRevision: input.catalog.catalogRevision,
      catalogSnapshotHash: input.catalog.snapshotHash,
    }),
  });
}

export async function executeProductionTool(input: {
  env: ProductionAgentGatewayEnv;
  scope: OperiaThinkScope;
  catalog: ProductionCatalog;
  requestId: string;
  thinkTaskId: string;
  agentCallKey: string;
  allowApproval?: boolean;
  freeReadOnly?: boolean;
  approvalProbeIntent?: typeof THINK_APPROVAL_PROBE_INTENT;
  toolKey: string;
  args: JsonValue;
}): Promise<Record<string, unknown>> {
  return gatewayJson(input.env, input.scope, "/service/think/execute", {
    method: "POST",
    body: JSON.stringify({
      ...input.scope,
      requestId: input.requestId,
      thinkTaskId: input.thinkTaskId,
      agentCallKey: input.agentCallKey,
      allowApproval: input.allowApproval !== false,
      executionClass: input.freeReadOnly === true ? "free_read" : "approval_capable",
      ...(input.approvalProbeIntent ? { approvalProbeIntent: input.approvalProbeIntent } : {}),
      toolKey: input.toolKey,
      args: input.args,
      catalogRevision: input.catalog.catalogRevision,
      catalogSnapshotHash: input.catalog.snapshotHash,
    }),
  });
}

export async function preflightProductionThinkAction(input: {
  env: ProductionAgentGatewayEnv;
  scope: OperiaThinkScope;
  catalog: ProductionCatalog;
  thinkTaskId: string;
  toolCallId: string;
  operationKey: string;
  toolKey: string;
  args: JsonValue;
}): Promise<ProductionThinkActionGrant> {
  return gatewayJson(input.env, input.scope, "/service/think/actions/preflight", {
    method: "POST",
    body: JSON.stringify({
      ...input.scope,
      thinkTaskId: input.thinkTaskId,
      toolCallId: input.toolCallId,
      operationKey: input.operationKey,
      toolKey: input.toolKey,
      args: input.args,
      catalogRevision: input.catalog.catalogRevision,
      catalogSnapshotHash: input.catalog.snapshotHash,
    }),
  });
}

export async function executeProductionThinkAction(input: {
  env: ProductionAgentGatewayEnv;
  scope: OperiaThinkScope;
  grant: ProductionThinkActionGrant;
  thinkTaskId: string;
  toolCallId: string;
  operationKey: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  return gatewayJson(input.env, input.scope, "/service/think/actions/execute", {
    method: "POST",
    ...(input.signal ? { signal: input.signal } : {}),
    body: JSON.stringify({
      ...input.scope,
      grantId: input.grant.grantId,
      thinkTaskId: input.thinkTaskId,
      toolCallId: input.toolCallId,
      operationKey: input.operationKey,
    }),
  });
}

export async function revokeProductionThinkAction(input: {
  env: ProductionAgentGatewayEnv;
  scope: OperiaThinkScope;
  grant: ProductionThinkActionGrant;
  thinkTaskId: string;
  toolCallId: string;
  operationKey: string;
}): Promise<Record<string, unknown>> {
  return gatewayJson(input.env, input.scope, "/service/think/actions/revoke", {
    method: "POST",
    body: JSON.stringify({
      ...input.scope,
      grantId: input.grant.grantId,
      thinkTaskId: input.thinkTaskId,
      toolCallId: input.toolCallId,
      operationKey: input.operationKey,
    }),
  });
}

export async function executeProductionCodeMode(input: {
  env: ProductionAgentGatewayEnv;
  scope: OperiaThinkScope;
  requestId: string;
  code: string;
  codeModeV2Requested: boolean;
}): Promise<ProductionCodeModeState> {
  return codeModeGatewayJson(input.env, "/service/think/codemode", {
    method: "POST",
    body: JSON.stringify({ ...input.scope, requestId: input.requestId, code: input.code,
      codeModeV2Requested: input.codeModeV2Requested }),
  });
}

export async function resumeProductionCodeMode(input: {
  env: ProductionAgentGatewayEnv;
  executionId: string;
  authorityScopeHash: string;
  action?: "resume" | "status" | "stop";
}): Promise<ProductionCodeModePending | ProductionCodeModeCompleted | ProductionCodeModeTerminal> {
  const state = await codeModeGatewayJson(input.env, `/service/think/codemode/${input.action ?? "resume"}`, {
    method: "POST",
    body: JSON.stringify({ executionId: input.executionId, authorityScopeHash: input.authorityScopeHash }),
  });
  if (state.kind === "codemode_immediate") throw new Error("operia_think_codemode_lifecycle_immediate_invalid");
  return state;
}

export async function searchProductionSkills(input: {
  env: ProductionAgentGatewayEnv;
  scope: OperiaThinkScope;
  query: string;
}): Promise<Record<string, unknown>> {
  return gatewayJson(input.env, input.scope, "/service/think/skills/search", {
    method: "POST",
    body: JSON.stringify({ ...input.scope, query: input.query }),
  });
}

export async function activateProductionSkill(input: {
  env: ProductionAgentGatewayEnv;
  scope: OperiaThinkScope;
  skillKey: string;
  skillInput: JsonValue;
}): Promise<Record<string, unknown>> {
  return gatewayJson(input.env, input.scope, "/service/think/skills/activate", {
    method: "POST",
    body: JSON.stringify({ ...input.scope, skillKey: input.skillKey, input: input.skillInput }),
  });
}

export async function completeProductionThinkTask(input: {
  env: ProductionAgentGatewayEnv;
  thinkTaskId: string;
  authorityScopeHash: string;
}): Promise<{ thinkTaskId: string; status: "completed"; revokedGrants: number }> {
  const service = input.env.AGENT_SERVICE;
  const bearer = input.env.AGENT_THINK_SERVICE_BEARER?.trim();
  if (!service || !bearer) throw new Error("operia_think_agent_gateway_misconfigured");
  const response = await service.fetch("https://<AGENT_SERVICE>.internal/service/think/task/complete", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ thinkTaskId: input.thinkTaskId, authorityScopeHash: input.authorityScopeHash }),
  });
  const value = await response.json<unknown>();
  if (!response.ok) throw new Error(`operia_think_task_complete_http_${response.status}`);
  return value as { thinkTaskId: string; status: "completed"; revokedGrants: number };
}

/**
 * Read the Agent-owned terminal receipt for one exact Think approval. The Agent
 * endpoint must verify ticket/task pins and return only the already-sanitized
 * result; Memory never reads approval args, credential material, or the task's
 * full checkpoint.
 */
export async function readProductionApprovalReceipt(input: {
  env: ProductionAgentGatewayEnv;
  ticketId: string;
  taskId: string;
  thinkTaskId: string;
  approvalRef: string;
  toolKey: string;
  authorityScopeHash: string;
  agentCallKey: string;
  argsHash: string;
  schemaHash: string;
  policyVersion: string;
  pauseGeneration: number;
}): Promise<ProductionApprovalReceipt> {
  const service = input.env.AGENT_SERVICE;
  const bearer = input.env.AGENT_THINK_SERVICE_BEARER?.trim();
  if (!service || !bearer) throw new Error("operia_think_agent_gateway_misconfigured");
  const response = await service.fetch(`https://<AGENT_SERVICE>.internal/service/think/approvals/${encodeURIComponent(input.ticketId)}/receipt`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      taskId: input.taskId,
      thinkTaskId: input.thinkTaskId,
      approvalRef: input.approvalRef,
      toolKey: input.toolKey,
      authorityScopeHash: input.authorityScopeHash,
      agentCallKey: input.agentCallKey,
      argsHash: input.argsHash,
      schemaHash: input.schemaHash,
      policyVersion: input.policyVersion,
      pauseGeneration: input.pauseGeneration,
    }),
  });
  const value = await response.json<unknown>();
  if (!response.ok) {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
    if (response.status === 409 && record && (record.status === "cancelled" || record.status === "attention_required" || record.status === "quarantined")) {
      return { ticketId: input.ticketId, taskId: input.taskId, status: record.status };
    }
    throw new Error(String(record?.error ?? `operia_think_agent_http_${response.status}`).slice(0, 300));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("operia_think_approval_receipt_invalid");
  const receipt = value as Record<string, unknown>;
  const statuses = new Set(["pending", "completed", "rejected", "expired", "cancelled", "quarantined", "attention_required"]);
  if (receipt.ticketId !== input.ticketId || receipt.taskId !== input.taskId || typeof receipt.status !== "string" || !statuses.has(receipt.status)) {
    throw new Error("operia_think_approval_receipt_invalid");
  }
  if ((receipt.status === "completed" || receipt.status === "rejected")
    && (receipt.thinkTaskId !== input.thinkTaskId || receipt.agentCallKey !== input.agentCallKey || receipt.argsHash !== input.argsHash
      || receipt.schemaHash !== input.schemaHash || receipt.policyVersion !== input.policyVersion
      || receipt.pauseGeneration !== input.pauseGeneration)) {
    return { ticketId: input.ticketId, taskId: input.taskId, status: "quarantined" };
  }
  if (receipt.status === "completed" || receipt.status === "rejected") {
    if (typeof receipt.receiptHash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.receiptHash)) {
      throw new Error("operia_think_approval_receipt_hash_invalid");
    }
  }
  return receipt as ProductionApprovalReceipt;
}

async function gatewayJson<T>(
  env: ProductionAgentGatewayEnv,
  scope: OperiaThinkScope,
  path: string,
  init: RequestInit,
): Promise<T> {
  const service = env.AGENT_SERVICE;
  const bearer = env.AGENT_THINK_SERVICE_BEARER?.trim();
  if (!service || !bearer) throw new Error("operia_think_agent_gateway_misconfigured");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  headers.set("content-type", "application/json");
  headers.set("x-operia-owner-id", scope.ownerId);
  headers.set("x-operia-chat-id", scope.chatId);
  headers.set("x-operia-scope-kind", scope.scopeKind);
  headers.set("x-operia-thread-key", scope.threadKey);
  const response = await service.fetch(new Request(`https://<AGENT_SERVICE>.internal${path}`, { ...init, headers }));
  const value = await response.json<unknown>();
  if (!response.ok) {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
    const code = record && "error" in record
      ? String(record.error)
      : `operia_think_agent_http_${response.status}`;
    const detail = record && typeof record.message === "string" ? record.message : "";
    throw new Error(`${code}${detail ? `:${detail}` : ""}`.slice(0, 300));
  }
  return value as T;
}

async function codeModeGatewayJson(
  env: ProductionAgentGatewayEnv,
  path: string,
  init: RequestInit,
): Promise<ProductionCodeModeState> {
  const service = env.AGENT_SERVICE;
  const bearer = env.AGENT_THINK_SERVICE_BEARER?.trim();
  if (!service || !bearer) throw new Error("operia_think_agent_gateway_misconfigured");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  headers.set("content-type", "application/json");
  const response = await service.fetch(new Request(`https://<AGENT_SERVICE>.internal${path}`, { ...init, headers }));
  const value = await response.json<unknown>();
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!record) throw new Error("operia_think_codemode_response_invalid");
  if (response.status === 202 && record.kind === "codemode_pending"
    && typeof record.requestId === "string" && typeof record.executionId === "string") {
    return {
      kind: "codemode_pending",
      requestId: record.requestId,
      executionId: record.executionId,
      status: record.status === "executing" ? "executing" : "accepted",
      retryAfterMs: typeof record.retryAfterMs === "number" ? Math.max(250, record.retryAfterMs) : 1_000,
      externalWrites: 0,
    };
  }
  if (response.ok && record.kind === "codemode_completed" && record.status === "completed"
    && typeof record.requestId === "string" && typeof record.executionId === "string"
    && typeof record.receiptHash === "string" && /^[a-f0-9]{64}$/.test(record.receiptHash)) {
    return { ...record, kind: "codemode_completed", status: "completed", externalWrites: 0 } as ProductionCodeModeCompleted;
  }
  if (response.ok && record.kind === "codemode_immediate" && record.status === "completed"
    && typeof record.requestId === "string") {
    return { kind: "codemode_immediate", requestId: record.requestId, status: "completed",
      result: record.result, externalWrites: 0 };
  }
  if (response.ok && record.kind == null && typeof record.requestId === "string"
    && !("executionId" in record) && "result" in record) {
    return { kind: "codemode_immediate", requestId: record.requestId, status: "completed",
      result: record.result, externalWrites: 0 };
  }
  if ((response.status === 409 || response.status === 423 || (response.status === 202 && record.kind === "codemode_terminal"))
    && typeof record.requestId === "string" && typeof record.executionId === "string") {
    const status = record.status === "quarantined" ? "quarantined"
      : record.status === "attention_required" ? "attention_required" : "failed";
    return { kind: "codemode_terminal", requestId: record.requestId, executionId: record.executionId, status,
      error: String(record.error ?? `codemode_${status}`).slice(0, 180), externalWrites: 0 };
  }
  throw new Error(String(record.error ?? `operia_think_agent_http_${response.status}`).slice(0, 300));
}
