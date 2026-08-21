import { sha256Hex } from "./toolCatalog";
import { assertJsonValue, canonicalJson } from "../utils/json";

export const REVERSIBLE_WRITE_POLICY_VERSION = "operia-reversible-write-v1";

export type ReversibleWriteDomain = "calendar" | "mcp";
export type ReversibleWriteChannel = "owner_private" | "fixed_qa_room";

export type ReversibleWriteApproval = {
  ticketId: string;
  status: "approved";
  source: "agent_ticket" | "owner_explicit_once";
  decisionScope: "once" | "task";
  ownerId: string;
  taskId: string;
  channelScopeHash: string;
  resourceGate: string;
  toolKey: string;
  argsHash: string;
  schemaHash: string;
  policyVersion: string;
  expiresAt: string;
};

export type ReversibleWriteRequest = {
  requestId: string;
  idempotencyKey: string;
  ownerId: string;
  taskId: string;
  channelScopeHash: string;
  channel: ReversibleWriteChannel;
  targetKind: "resource_owner";
  domain: ReversibleWriteDomain;
  resourceGate: string;
  resourceId: string | null;
  toolKey: string;
  action: string;
  args: Record<string, unknown>;
  argsHash: string;
  schemaHash: string;
  policyVersion: string;
  connectorVersion: string;
  expected: {
    etag?: string;
    ownerRevision?: number;
  };
  approval: ReversibleWriteApproval;
};

export type ReversibleWritePreflight = {
  allowed: true;
  resourceGate: string;
  domain: ReversibleWriteDomain;
  toolKey: string;
  riskClass: "write";
  externalWrite: true;
  serialized: true;
  requiresApproval: true;
  policyVersion: string;
  schemaHash: string;
  connectorVersion: string;
};

export type ReversibleWriteSnapshot = {
  resourceId: string;
  etag: string;
  ownerRevision: number;
  fingerprint: string;
  observedAt: string;
};

export type ReversibleWriteUndo = {
  kind: "native" | "compensation";
  resourceGate: string;
  toolKey: string;
  action: string;
  resourceId: string;
  expectedEtag?: string;
  argsHash: string;
  note?: string;
};

export type ReversibleWriteProviderOutcome =
  | {
    status: "succeeded";
    providerStatus: number;
    snapshot: ReversibleWriteSnapshot;
    undo: ReversibleWriteUndo;
  }
  | {
    status: "conflict";
    providerStatus: number;
    code: string;
    current?: ReversibleWriteSnapshot;
  }
  | {
    status: "outcome_unknown";
    providerStatus?: number;
    code: string;
  }
  | {
    status: "failed";
    providerStatus?: number;
    code: string;
    definitive: true;
  };

export type ReversibleWriteReceipt = {
  requestId: string;
  idempotencyKey: string;
  requestHash: string;
  ownerId: string;
  taskId: string;
  channelScopeHash: string;
  domain: ReversibleWriteDomain;
  resourceGate: string;
  resourceId: string;
  toolKey: string;
  action: string;
  argsHash: string;
  schemaHash: string;
  policyVersion: string;
  connectorVersion: string;
  approvalTicketId: string;
  approvalSource: ReversibleWriteApproval["source"];
  state: "succeeded";
  beforeFingerprint: string | null;
  afterFingerprint: string;
  afterEtag: string;
  afterOwnerRevision: number;
  resultHash: string;
  reconciled: boolean;
  externalWriteCount: 1;
  autoRetry: false;
  undo: ReversibleWriteUndo;
  createdAt: string;
};

export type ReversibleWriteResult =
  | { state: "succeeded"; replayed: boolean; receipt: ReversibleWriteReceipt }
  | {
    state: "conflict" | "failed";
    replayed: false;
    code: string;
    providerStatus?: number;
    externalWriteCount: 0 | 1;
    autoRetry: false;
  }
  | {
    state: "attention_required";
    replayed: false;
    code: string;
    providerStatus?: number;
    externalWriteCount: 0 | 1;
    autoRetry: false;
    reconciliationAttempted: true;
    priorAttemptUnknown: boolean;
  };

export type ReversibleWriteHost = {
  paused(): boolean;
  preflight(request: ReversibleWriteRequest): Promise<ReversibleWritePreflight>;
  consumeApproval(request: ReversibleWriteRequest): Promise<ReversibleWriteApproval>;
  loadReceipt(resourceGate: string, idempotencyKey: string): Promise<ReversibleWriteReceipt | null>;
  acquireResourceLease(resourceGate: string, requestId: string): Promise<boolean>;
  releaseResourceLease(resourceGate: string, requestId: string): Promise<void>;
  reserveInvocation(input: {
    resourceGate: string;
    idempotencyKey: string;
    requestHash: string;
    requestId: string;
    taskId: string;
  }): Promise<
    | { status: "reserved" }
    | { status: "uncertain"; code: string; providerStatus?: number }
  >;
  cancelUnstartedReservation(input: {
    resourceGate: string;
    idempotencyKey: string;
    requestHash: string;
    requestId: string;
  }): Promise<void>;
  readCurrent(request: ReversibleWriteRequest, reason: "preflight" | "mutation_reconciliation"): Promise<ReversibleWriteSnapshot | null>;
  invokeOnce(request: ReversibleWriteRequest, before: ReversibleWriteSnapshot | null): Promise<ReversibleWriteProviderOutcome>;
  matchesIntendedState(request: ReversibleWriteRequest, snapshot: ReversibleWriteSnapshot): Promise<boolean>;
  commitReceipt(receipt: ReversibleWriteReceipt): Promise<void>;
  markAttention(input: {
    request: ReversibleWriteRequest;
    code: string;
    providerStatus?: number;
    reconciliationAttempted: true;
  }): Promise<void>;
  audit(event: {
    type: "reversible_write.succeeded" | "reversible_write.replayed" | "reversible_write.conflict"
      | "reversible_write.failed" | "reversible_write.attention_required";
    requestId: string;
    taskId: string;
    resourceGate: string;
    toolKey: string;
    argsHash: string;
    requestHash: string;
    externalWriteCount: 0 | 1;
    code?: string;
    reconciled?: boolean;
  }): Promise<void>;
};

export async function executeReversibleWrite(
  rawRequest: ReversibleWriteRequest,
  host: ReversibleWriteHost,
  nowMs = Date.now(),
): Promise<ReversibleWriteResult> {
  const request = normalizeReversibleWriteRequest(rawRequest);
  const computedArgsHash = await sha256Hex(canonicalJson(assertJsonValue(request.args)));
  if (request.argsHash.replace(/^sha256:/, "") !== computedArgsHash) {
    throw new Error("reversible_write_args_hash_mismatch");
  }
  const requestHash = await reversibleWriteRequestHash(request);
  if (host.paused()) throw new Error("reversible_write_global_pause");

  const preflight = assertReversibleWritePreflight(await host.preflight(request), request);
  const existing = await host.loadReceipt(request.resourceGate, request.idempotencyKey);
  if (existing) {
    assertReversibleWriteReceipt(existing, request, requestHash, preflight);
    await host.audit(auditEvent("reversible_write.replayed", request, requestHash, 0, {
      reconciled: existing.reconciled,
    }));
    return { state: "succeeded", replayed: true, receipt: structuredClone(existing) };
  }

  const acquired = await host.acquireResourceLease(request.resourceGate, request.requestId);
  if (!acquired) throw new Error("reversible_write_serialized_write_in_progress");
  try {
    if (host.paused()) throw new Error("reversible_write_global_pause");
    assertReversibleWritePreflight(await host.preflight(request), request);
    const replayAfterLease = await host.loadReceipt(request.resourceGate, request.idempotencyKey);
    if (replayAfterLease) {
      assertReversibleWriteReceipt(replayAfterLease, request, requestHash, preflight);
      await host.audit(auditEvent("reversible_write.replayed", request, requestHash, 0, {
        reconciled: replayAfterLease.reconciled,
      }));
      return { state: "succeeded", replayed: true, receipt: structuredClone(replayAfterLease) };
    }

    const before = await host.readCurrent(request, "preflight");
    const conflict = expectedStateConflict(request, before);
    if (conflict) {
      await host.audit(auditEvent("reversible_write.conflict", request, requestHash, 0, { code: conflict }));
      return { state: "conflict", replayed: false, code: conflict, externalWriteCount: 0, autoRetry: false };
    }

    const reservation = await host.reserveInvocation({
      resourceGate: request.resourceGate,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      requestId: request.requestId,
      taskId: request.taskId,
    });
    if (reservation.status === "uncertain") {
      const code = boundedWriteCode(reservation.code, "reversible_write_prior_attempt_unknown");
      await host.markAttention({
        request,
        code,
        providerStatus: reservation.providerStatus,
        reconciliationAttempted: true,
      });
      await host.audit(auditEvent("reversible_write.attention_required", request, requestHash, 0, { code }));
      return {
        state: "attention_required",
        replayed: false,
        code,
        providerStatus: reservation.providerStatus,
        externalWriteCount: 0,
        autoRetry: false,
        reconciliationAttempted: true,
        priorAttemptUnknown: true,
      };
    }

    let approval: ReversibleWriteApproval;
    try {
      approval = assertReversibleWriteApproval(await host.consumeApproval(request), request, nowMs);
    } catch (error) {
      await host.cancelUnstartedReservation({
        resourceGate: request.resourceGate,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        requestId: request.requestId,
      });
      throw error;
    }

    const outcome = await host.invokeOnce(request, before);
    if (outcome.status === "conflict") {
      const code = boundedWriteCode(outcome.code, "reversible_write_provider_conflict");
      await host.audit(auditEvent("reversible_write.conflict", request, requestHash, 1, { code }));
      return {
        state: "conflict",
        replayed: false,
        code,
        providerStatus: outcome.providerStatus,
        externalWriteCount: 1,
        autoRetry: false,
      };
    }
    if (outcome.status === "failed") {
      const code = boundedWriteCode(outcome.code, "reversible_write_provider_failed");
      await host.audit(auditEvent("reversible_write.failed", request, requestHash, 1, { code }));
      return {
        state: "failed",
        replayed: false,
        code,
        providerStatus: outcome.providerStatus,
        externalWriteCount: 1,
        autoRetry: false,
      };
    }

    let after: ReversibleWriteSnapshot;
    let undo: ReversibleWriteUndo;
    let providerStatus: number | undefined;
    let reconciled = false;
    if (outcome.status === "outcome_unknown") {
      providerStatus = outcome.providerStatus;
      const observed = await host.readCurrent(request, "mutation_reconciliation");
      const matched = observed ? await host.matchesIntendedState(request, observed) : false;
      if (!observed || !matched) {
        const code = boundedWriteCode(outcome.code, "reversible_write_outcome_unknown");
        await host.markAttention({ request, code, providerStatus, reconciliationAttempted: true });
        await host.audit(auditEvent("reversible_write.attention_required", request, requestHash, 1, { code }));
        return {
          state: "attention_required",
          replayed: false,
          code,
          providerStatus,
          externalWriteCount: 1,
          autoRetry: false,
          reconciliationAttempted: true,
          priorAttemptUnknown: false,
        };
      }
      after = observed;
      undo = assertReversibleWriteUndo(await reconciliationUndo(request, before, observed), request);
      reconciled = true;
    } else {
      providerStatus = outcome.providerStatus;
      const observed = await host.readCurrent(request, "mutation_reconciliation");
      if (!observed || observed.fingerprint !== outcome.snapshot.fingerprint || observed.etag !== outcome.snapshot.etag) {
        const code = "reversible_write_read_after_write_mismatch";
        await host.markAttention({ request, code, providerStatus, reconciliationAttempted: true });
        await host.audit(auditEvent("reversible_write.attention_required", request, requestHash, 1, { code }));
        return {
          state: "attention_required",
          replayed: false,
          code,
          providerStatus,
          externalWriteCount: 1,
          autoRetry: false,
          reconciliationAttempted: true,
          priorAttemptUnknown: false,
        };
      }
      after = observed;
      undo = assertReversibleWriteUndo(outcome.undo, request);
    }

    const receipt: ReversibleWriteReceipt = {
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      ownerId: request.ownerId,
      taskId: request.taskId,
      channelScopeHash: request.channelScopeHash,
      domain: request.domain,
      resourceGate: request.resourceGate,
      resourceId: after.resourceId,
      toolKey: request.toolKey,
      action: request.action,
      argsHash: request.argsHash,
      schemaHash: request.schemaHash,
      policyVersion: request.policyVersion,
      connectorVersion: request.connectorVersion,
      approvalTicketId: approval.ticketId,
      approvalSource: approval.source,
      state: "succeeded",
      beforeFingerprint: before?.fingerprint ?? null,
      afterFingerprint: after.fingerprint,
      afterEtag: after.etag,
      afterOwnerRevision: after.ownerRevision,
      resultHash: await sha256Hex(canonicalJson(assertJsonValue({
        resourceId: after.resourceId,
        etag: after.etag,
        ownerRevision: after.ownerRevision,
        fingerprint: after.fingerprint,
      }))),
      reconciled,
      externalWriteCount: 1,
      autoRetry: false,
      undo,
      createdAt: new Date(nowMs).toISOString(),
    };
    await host.commitReceipt(receipt);
    await host.audit(auditEvent("reversible_write.succeeded", request, requestHash, 1, { reconciled }));
    return { state: "succeeded", replayed: false, receipt };
  } finally {
    await host.releaseResourceLease(request.resourceGate, request.requestId);
  }
}

export async function reversibleWriteRequestHash(request: ReversibleWriteRequest): Promise<string> {
  return sha256Hex(canonicalJson(assertJsonValue({
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    ownerId: request.ownerId,
    taskId: request.taskId,
    channelScopeHash: request.channelScopeHash,
    channel: request.channel,
    targetKind: request.targetKind,
    domain: request.domain,
    resourceGate: request.resourceGate,
    resourceId: request.resourceId,
    toolKey: request.toolKey,
    action: request.action,
    args: request.args,
    argsHash: request.argsHash,
    schemaHash: request.schemaHash,
    policyVersion: request.policyVersion,
    connectorVersion: request.connectorVersion,
    expected: request.expected,
    approvalTicketId: request.approval.ticketId,
    approvalSource: request.approval.source,
  })));
}

function normalizeReversibleWriteRequest(input: ReversibleWriteRequest): ReversibleWriteRequest {
  const request = structuredClone(input);
  request.requestId = normalizeToken(request.requestId, "reversible_write_request_id_invalid", 128);
  request.idempotencyKey = normalizeToken(request.idempotencyKey, "reversible_write_idempotency_key_invalid", 128);
  request.ownerId = normalizeToken(request.ownerId, "reversible_write_owner_invalid", 128);
  request.taskId = normalizeToken(request.taskId, "reversible_write_task_invalid", 128);
  request.channelScopeHash = normalizeHash(request.channelScopeHash, "reversible_write_channel_scope_invalid");
  request.resourceGate = normalizeGate(request.resourceGate);
  request.toolKey = normalizeToolKey(request.toolKey);
  request.action = normalizeToken(request.action, "reversible_write_action_invalid", 80);
  if (/(?:^|[._:/-])(?:email|mail|send_email|send_message|reply_message)(?:$|[._:/-])/.test(
    `${request.resourceGate}:${request.toolKey}:${request.action}`,
  )) {
    throw new Error("reversible_write_communication_denied");
  }
  request.argsHash = normalizeHash(request.argsHash, "reversible_write_args_hash_invalid");
  request.schemaHash = normalizeHash(request.schemaHash, "reversible_write_schema_hash_invalid");
  request.policyVersion = normalizeToken(request.policyVersion, "reversible_write_policy_version_invalid", 128);
  request.connectorVersion = normalizeToken(request.connectorVersion, "reversible_write_connector_version_invalid", 128);
  if (!request.args || typeof request.args !== "object" || Array.isArray(request.args)) {
    throw new Error("reversible_write_args_invalid");
  }
  if (request.channel !== "owner_private" && request.channel !== "fixed_qa_room") {
    throw new Error("reversible_write_channel_denied");
  }
  if (request.targetKind !== "resource_owner") throw new Error("reversible_write_third_party_target_denied");
  if (request.domain === "calendar") {
    if (request.resourceGate !== "calendar.primary") throw new Error("reversible_write_calendar_gate_denied");
  } else if (request.domain === "mcp") {
    if (!/^mcp\.[a-z0-9][a-z0-9._:-]{2,159}$/.test(request.resourceGate)) {
      throw new Error("reversible_write_mcp_gate_invalid");
    }
  } else {
    throw new Error("reversible_write_domain_denied");
  }
  if (request.resourceId !== null) {
    request.resourceId = normalizeToken(request.resourceId, "reversible_write_resource_id_invalid", 192);
  }
  if (request.expected.etag !== undefined) {
    request.expected.etag = normalizeOpaqueEtag(request.expected.etag);
  }
  if (
    request.expected.ownerRevision !== undefined
    && (!Number.isSafeInteger(request.expected.ownerRevision) || request.expected.ownerRevision < 0)
  ) {
    throw new Error("reversible_write_owner_revision_invalid");
  }
  if (
    request.resourceId === null
      ? request.expected.etag !== undefined || request.expected.ownerRevision !== undefined
      : request.expected.etag === undefined || request.expected.ownerRevision === undefined
  ) {
    throw new Error("reversible_write_expected_state_required");
  }
  return request;
}

function assertReversibleWritePreflight(
  value: ReversibleWritePreflight,
  request: ReversibleWriteRequest,
): ReversibleWritePreflight {
  if (
    !value
    || value.allowed !== true
    || value.resourceGate !== request.resourceGate
    || value.domain !== request.domain
    || value.toolKey !== request.toolKey
    || value.riskClass !== "write"
    || value.externalWrite !== true
    || value.serialized !== true
    || value.requiresApproval !== true
    || value.policyVersion !== request.policyVersion
    || value.schemaHash !== request.schemaHash
    || value.connectorVersion !== request.connectorVersion
  ) {
    throw new Error("reversible_write_preflight_denied");
  }
  return value;
}

function assertReversibleWriteApproval(
  value: ReversibleWriteApproval,
  request: ReversibleWriteRequest,
  nowMs: number,
): ReversibleWriteApproval {
  const expected = request.approval;
  if (
    !value
    || value.status !== "approved"
    || value.ticketId !== expected.ticketId
    || value.source !== expected.source
    || value.decisionScope !== expected.decisionScope
    || value.ownerId !== request.ownerId
    || value.taskId !== request.taskId
    || value.channelScopeHash !== request.channelScopeHash
    || value.resourceGate !== request.resourceGate
    || value.toolKey !== request.toolKey
    || value.argsHash !== request.argsHash
    || value.schemaHash !== request.schemaHash
    || value.policyVersion !== request.policyVersion
    || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= nowMs
  ) {
    throw new Error("reversible_write_approval_scope_mismatch");
  }
  return value;
}

function assertReversibleWriteReceipt(
  receipt: ReversibleWriteReceipt,
  request: ReversibleWriteRequest,
  requestHash: string,
  preflight: ReversibleWritePreflight,
): void {
  if (
    receipt.requestHash !== requestHash
    || receipt.ownerId !== request.ownerId
    || receipt.taskId !== request.taskId
    || receipt.channelScopeHash !== request.channelScopeHash
    || receipt.domain !== request.domain
    || receipt.resourceGate !== request.resourceGate
    || receipt.toolKey !== request.toolKey
    || receipt.argsHash !== request.argsHash
    || receipt.schemaHash !== preflight.schemaHash
    || receipt.policyVersion !== preflight.policyVersion
    || receipt.connectorVersion !== preflight.connectorVersion
    || receipt.externalWriteCount !== 1
    || receipt.autoRetry !== false
  ) {
    throw new Error("reversible_write_idempotency_key_reused");
  }
}

function expectedStateConflict(request: ReversibleWriteRequest, before: ReversibleWriteSnapshot | null): string | null {
  if (request.resourceId !== null && !before) return "reversible_write_resource_not_found";
  if (request.resourceId === null && before) return "reversible_write_create_target_exists";
  if (request.expected.etag !== undefined && request.expected.etag !== before?.etag) {
    return "reversible_write_etag_conflict";
  }
  if (
    request.expected.ownerRevision !== undefined
    && request.expected.ownerRevision !== before?.ownerRevision
  ) {
    return "reversible_write_owner_revision_conflict";
  }
  return null;
}

async function reconciliationUndo(
  request: ReversibleWriteRequest,
  before: ReversibleWriteSnapshot | null,
  after: ReversibleWriteSnapshot,
): Promise<ReversibleWriteUndo> {
  return {
    kind: "compensation",
    resourceGate: request.resourceGate,
    toolKey: request.toolKey,
    action: before ? "restore_previous_snapshot" : "delete_created_resource",
    resourceId: after.resourceId,
    expectedEtag: after.etag,
    argsHash: await sha256Hex(canonicalJson(assertJsonValue({
      resourceGate: request.resourceGate,
      resourceId: after.resourceId,
      beforeFingerprint: before?.fingerprint ?? null,
      afterFingerprint: after.fingerprint,
    }))),
    note: "Provider outcome was reconciled by read-after-write; only an explicit compensating action is available.",
  };
}

function assertReversibleWriteUndo(value: ReversibleWriteUndo, request: ReversibleWriteRequest): ReversibleWriteUndo {
  if (
    !value
    || (value.kind !== "native" && value.kind !== "compensation")
    || value.resourceGate !== request.resourceGate
    || value.toolKey !== request.toolKey
    || !value.action
    || !value.resourceId
    || !/^(?:sha256:)?[a-f0-9]{64}$/.test(value.argsHash)
  ) {
    throw new Error("reversible_write_undo_invalid");
  }
  if (value.kind === "compensation" && !value.note) throw new Error("reversible_write_compensation_note_required");
  return structuredClone(value);
}

function auditEvent(
  type: Parameters<ReversibleWriteHost["audit"]>[0]["type"],
  request: ReversibleWriteRequest,
  requestHash: string,
  externalWriteCount: 0 | 1,
  detail: { code?: string; reconciled?: boolean } = {},
): Parameters<ReversibleWriteHost["audit"]>[0] {
  return {
    type,
    requestId: request.requestId,
    taskId: request.taskId,
    resourceGate: request.resourceGate,
    toolKey: request.toolKey,
    argsHash: request.argsHash,
    requestHash,
    externalWriteCount,
    ...detail,
  };
}

function normalizeToken(value: unknown, code: string, maxLength: number): string {
  const token = typeof value === "string" ? value.trim() : "";
  const pattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${maxLength - 1}}$`);
  if (!pattern.test(token)) throw new Error(code);
  return token;
}

function normalizeHash(value: unknown, code: string): string {
  const hash = typeof value === "string" ? value.trim() : "";
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(hash)) throw new Error(code);
  return hash;
}

function normalizeGate(value: unknown): string {
  const gate = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._:-]{2,159}$/.test(gate)) throw new Error("reversible_write_resource_gate_invalid");
  return gate;
}

function normalizeToolKey(value: unknown): string {
  const toolKey = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._:-]{0,95}\/[a-z0-9][a-z0-9._:-]{0,95}$/.test(toolKey)) {
    throw new Error("reversible_write_tool_key_invalid");
  }
  return toolKey;
}

function normalizeOpaqueEtag(value: unknown): string {
  const etag = typeof value === "string" ? value.trim() : "";
  if (!etag || etag.length > 256 || /[\u0000-\u001f\u007f]/.test(etag)) {
    throw new Error("reversible_write_etag_invalid");
  }
  return etag;
}

function boundedWriteCode(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value : "";
  const code = raw.trim().replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 120);
  return code || fallback;
}
