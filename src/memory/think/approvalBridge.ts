export type ThinkApprovalStatus =
  | "projected"
  | "approved"
  | "rejected"
  | "expired"
  | "consumed"
  | "quarantined";

export type ThinkApprovalScope = "once" | "task" | "reject";

export type ThinkApprovalProjectionRecord = {
  approvalRef: string;
  thinkExecutionId: string;
  thinkCallId: string;
  agentTicketId: string;
  taskId: string;
  approvalRound: number;
  toolKey: string;
  argsHash: string;
  schemaHash: string;
  riskClass: string;
  policyVersion: string;
  ownerId: string;
  channelScopeHash: string;
  pauseGeneration: number;
  expiresAt: string;
  status: ThinkApprovalStatus;
  decisionScope?: ThinkApprovalScope;
};

export type ThinkApprovalAuthority = {
  ownerId: string;
  channelScopeHash: string;
  taskId: string;
  agentTicketId: string;
};

type AgentReservation = {
  status: "reserved" | "replayed";
  decisionScope: ThinkApprovalScope;
};

type AgentConsumption =
  | { status: "completed" | "replayed"; result: unknown }
  | { status: "unknown_side_effect" };

export type ThinkApprovalBridgeDependencies = {
  reserveAgentDecision(
    projection: Readonly<ThinkApprovalProjectionRecord>,
    decisionScope: ThinkApprovalScope,
  ): Promise<AgentReservation>;
  approveThinkExecution(executionId: string): Promise<unknown>;
  rejectThinkExecution(executionId: string, reason: string): Promise<unknown>;
  quarantineAgentTicket(ticketId: string, code: string): Promise<void>;
};

export type ThinkApprovalConsumeDependencies = {
  recheckAndConsumeAgentCall(projection: Readonly<ThinkApprovalProjectionRecord>): Promise<AgentConsumption>;
  quarantineAgentTicket(ticketId: string, code: string): Promise<void>;
};

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,159}$/;

export async function createThinkApprovalProjection(
  input: Omit<ThinkApprovalProjectionRecord, "approvalRef" | "status">,
): Promise<ThinkApprovalProjectionRecord> {
  assertProjectionInput(input);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode([
      "operia-think-approval-v1",
      input.thinkExecutionId,
      input.thinkCallId,
      input.agentTicketId,
      input.taskId,
      String(input.approvalRound),
      input.toolKey,
      input.argsHash,
      input.schemaHash,
      input.policyVersion,
      input.channelScopeHash,
      String(input.pauseGeneration),
    ].join("\0")),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { ...input, approvalRef: `tap_${hex.slice(0, 32)}`, status: "projected" };
}

export function publicThinkApprovalDetails(
  projection: Readonly<ThinkApprovalProjectionRecord>,
): Record<string, unknown> {
  return {
    approvalRef: projection.approvalRef,
    agentTicketId: projection.agentTicketId,
    taskId: projection.taskId,
    toolKey: projection.toolKey,
    riskClass: projection.riskClass,
    argsHashPrefix: `${projection.argsHash.slice(0, 16)}…`,
    policyVersion: projection.policyVersion.slice(0, 80),
    expiresAt: projection.expiresAt,
    status: projection.status,
    note: "原始参数、凭据与内部执行标识均不展示。",
  };
}

export async function resolveThinkApprovalProjection(
  projection: Readonly<ThinkApprovalProjectionRecord>,
  authority: Readonly<ThinkApprovalAuthority>,
  decisionScope: ThinkApprovalScope,
  dependencies: ThinkApprovalBridgeDependencies,
): Promise<ThinkApprovalProjectionRecord> {
  assertAuthority(projection, authority);
  if (projection.status !== "projected") throw new Error("think_approval_not_projected");
  if (Date.parse(projection.expiresAt) <= Date.now()) {
    return { ...projection, status: "expired", decisionScope: "reject" };
  }
  const reservation = await dependencies.reserveAgentDecision(projection, decisionScope);
  if (reservation.decisionScope !== decisionScope) throw new Error("think_approval_agent_scope_mismatch");
  try {
    if (decisionScope === "reject") {
      await dependencies.rejectThinkExecution(projection.thinkExecutionId, "Owner rejected only the current action.");
      return { ...projection, status: "rejected", decisionScope };
    }
    await dependencies.approveThinkExecution(projection.thinkExecutionId);
    return { ...projection, status: "approved", decisionScope };
  } catch {
    await dependencies.quarantineAgentTicket(projection.agentTicketId, "think_resolution_unknown");
    return { ...projection, status: "quarantined", decisionScope };
  }
}

export async function consumeThinkApprovedAction(
  projection: Readonly<ThinkApprovalProjectionRecord>,
  dependencies: ThinkApprovalConsumeDependencies,
): Promise<{ projection: ThinkApprovalProjectionRecord; result: unknown; replayed: boolean }> {
  if (projection.status !== "approved" || (projection.decisionScope !== "once" && projection.decisionScope !== "task")) {
    throw new Error("think_approval_not_authorized");
  }
  const consumed = await dependencies.recheckAndConsumeAgentCall(projection);
  if (consumed.status === "unknown_side_effect") {
    await dependencies.quarantineAgentTicket(projection.agentTicketId, "unknown_side_effect");
    throw new Error("think_approval_unknown_side_effect");
  }
  return {
    projection: { ...projection, status: "consumed" },
    result: consumed.result,
    replayed: consumed.status === "replayed",
  };
}

export function rejectedActionContinuation(projection: Readonly<ThinkApprovalProjectionRecord>): {
  continueTask: true;
  outcome: "action_denied";
  safeAlternativeAllowed: true;
  toolKey: string;
} {
  if (projection.status !== "rejected") throw new Error("think_approval_not_rejected");
  return {
    continueTask: true,
    outcome: "action_denied",
    safeAlternativeAllowed: true,
    toolKey: projection.toolKey,
  };
}

export function matchesThinkTaskGrant(
  granted: Readonly<ThinkApprovalProjectionRecord>,
  candidate: Readonly<ThinkApprovalProjectionRecord>,
): boolean {
  return granted.decisionScope === "task"
    && granted.status === "consumed"
    && Date.parse(granted.expiresAt) > Date.now()
    && granted.taskId === candidate.taskId
    && granted.ownerId === candidate.ownerId
    && granted.channelScopeHash === candidate.channelScopeHash
    && granted.toolKey === candidate.toolKey
    && granted.argsHash === candidate.argsHash
    && granted.schemaHash === candidate.schemaHash
    && granted.riskClass === candidate.riskClass
    && granted.policyVersion === candidate.policyVersion;
}

export async function stopProjectedTask(
  projection: Readonly<ThinkApprovalProjectionRecord>,
  dependencies: {
    stopAgentTask(taskId: string, ownerId: string, channelScopeHash: string): Promise<void>;
    rejectThinkExecution(executionId: string, reason: string): Promise<unknown>;
  },
): Promise<{ taskId: string; status: "stopped" }> {
  await dependencies.stopAgentTask(projection.taskId, projection.ownerId, projection.channelScopeHash);
  if (projection.status === "projected") {
    await dependencies.rejectThinkExecution(projection.thinkExecutionId, "Owner stopped the task.");
  }
  return { taskId: projection.taskId, status: "stopped" };
}

function assertProjectionInput(input: Omit<ThinkApprovalProjectionRecord, "approvalRef" | "status">): void {
  for (const [field, value] of Object.entries({
    thinkExecutionId: input.thinkExecutionId,
    thinkCallId: input.thinkCallId,
    agentTicketId: input.agentTicketId,
    taskId: input.taskId,
    toolKey: input.toolKey,
    riskClass: input.riskClass,
    policyVersion: input.policyVersion,
    ownerId: input.ownerId,
  })) {
    if (!SAFE_ID.test(value)) throw new Error(`think_approval_${field}_invalid`);
  }
  if (!HASH.test(input.argsHash) || !HASH.test(input.schemaHash) || !HASH.test(input.channelScopeHash)) {
    throw new Error("think_approval_hash_invalid");
  }
  if (!Number.isSafeInteger(input.approvalRound) || input.approvalRound < 0
    || !Number.isSafeInteger(input.pauseGeneration) || input.pauseGeneration < 0
    || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("think_approval_projection_invalid");
  }
}

function assertAuthority(
  projection: Readonly<ThinkApprovalProjectionRecord>,
  authority: Readonly<ThinkApprovalAuthority>,
): void {
  if (projection.ownerId !== authority.ownerId) throw new Error("think_approval_owner_mismatch");
  if (projection.channelScopeHash !== authority.channelScopeHash) throw new Error("think_approval_channel_mismatch");
  if (projection.taskId !== authority.taskId) throw new Error("think_approval_task_mismatch");
  if (projection.agentTicketId !== authority.agentTicketId) throw new Error("think_approval_ticket_mismatch");
}
