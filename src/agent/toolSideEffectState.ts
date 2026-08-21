import { assertJsonValue, canonicalJson, safeSerializeForDisplay, type JsonValue } from "../utils/json";
import {
  THINK_APPROVAL_PROBE_SERVER_ID,
  THINK_APPROVAL_PROBE_TOOL_NAME,
} from "../thinkApprovalProbe";

export const PROVIDER_RESULT_RECEIPT_SCHEMA_VERSION = 1;

export type SerializableProviderResultReceipt = {
  schemaVersion: 1;
  providerCallCompleted: true;
  resultStatus: "serializable";
  value: JsonValue;
  errorClass: null;
};

export type UnserializableProviderResultReceipt = {
  schemaVersion: 1;
  providerCallCompleted: true;
  resultStatus: "unserializable";
  display: string;
  errorClass: "unsupported_result_shape";
};

export type ProviderResultReceipt = SerializableProviderResultReceipt | UnserializableProviderResultReceipt;

export type ProviderResultReceiptInput =
  | { resultStatus: "serializable"; value: unknown; providerAttempt?: number; completedAt?: string }
  | { resultStatus: "unserializable"; display: string; providerAttempt?: number; completedAt?: string };

export type ProviderResultClassification =
  | { resultStatus: "serializable"; receiptInput: { resultStatus: "serializable"; value: unknown } }
  | { resultStatus: "unserializable"; receiptInput: { resultStatus: "unserializable"; display: string } };

export function encodeProviderResultReceipt(input: ProviderResultReceiptInput): ProviderResultReceipt {
  if (input.resultStatus === "serializable") {
    return {
      schemaVersion: PROVIDER_RESULT_RECEIPT_SCHEMA_VERSION,
      providerCallCompleted: true,
      resultStatus: "serializable",
      value: assertJsonValue(input.value),
      errorClass: null,
      ...(input.providerAttempt !== undefined ? { providerAttempt: input.providerAttempt } : {}),
      ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    } as SerializableProviderResultReceipt;
  }
  if (typeof input.display !== "string") throw new Error("provider_receipt_display_required");
  return {
    schemaVersion: PROVIDER_RESULT_RECEIPT_SCHEMA_VERSION,
    providerCallCompleted: true,
    resultStatus: "unserializable",
    display: input.display,
    errorClass: "unsupported_result_shape",
    ...(input.providerAttempt !== undefined ? { providerAttempt: input.providerAttempt } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
  } as UnserializableProviderResultReceipt;
}

export function encodeProviderResultReceiptJson(input: ProviderResultReceiptInput): string {
  return canonicalJson(assertJsonValue(encodeProviderResultReceipt(input)));
}

export function decodeProviderResultReceipt(value: unknown): ProviderResultReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== PROVIDER_RESULT_RECEIPT_SCHEMA_VERSION) return null;
  if (record.providerCallCompleted !== true) return null;
  if (record.resultStatus === "serializable") {
    return {
      schemaVersion: PROVIDER_RESULT_RECEIPT_SCHEMA_VERSION,
      providerCallCompleted: true,
      resultStatus: "serializable",
      value: assertJsonValue(record.value),
      errorClass: null,
      ...(typeof record.providerAttempt === "number" ? { providerAttempt: record.providerAttempt } : {}),
      ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
    };
  }
  if (record.resultStatus === "unserializable") {
    if (typeof record.display !== "string") return null;
    return {
      schemaVersion: PROVIDER_RESULT_RECEIPT_SCHEMA_VERSION,
      providerCallCompleted: true,
      resultStatus: "unserializable",
      display: record.display,
      errorClass: "unsupported_result_shape",
      ...(typeof record.providerAttempt === "number" ? { providerAttempt: record.providerAttempt } : {}),
      ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
    };
  }
  return null;
}

export function receiptToTaskResult(receipt: ProviderResultReceipt): unknown {
  if (receipt.resultStatus === "serializable") {
    return receipt.value;
  }
  return {
    kind: "provider_result_unserializable",
    display: receipt.display,
    errorClass: receipt.errorClass,
  };
}

export function classifyProviderResult(value: unknown): ProviderResultClassification {
  try {
    return {
      resultStatus: "serializable",
      receiptInput: { resultStatus: "serializable", value: assertJsonValue(value) },
    };
  } catch {
    return {
      resultStatus: "unserializable",
      receiptInput: { resultStatus: "unserializable", display: safeSerializeForDisplay(value) },
    };
  }
}

export type DispatchState = "reserved" | "dispatched" | "terminal_observed";

export type ProviderReplayContract =
  | { kind: "never_replay" }
  | { kind: "stable_idempotency"; key: string }
  | { kind: "read_after_write"; adapter: string }
  | { kind: "read_only_safe" }
  | { kind: "unsafe_unknown" };

export type RetrySafetyProof =
  | { kind: "not_dispatched" }
  | { kind: "stable_idempotency"; idempotencyKey: string }
  | { kind: "owner_attested_not_applied"; evidence: string }
  | {
      kind: "system_verified_not_applied";
      verifier: string;
      evidenceHash: string;
      observedAt: string;
    }
  | {
      kind: "read_after_write";
      adapter: string;
      state: "not_applied" | "applied" | "inconclusive";
      evidenceHash: string;
      observedAt: string;
    }
  | { kind: "read_only_safe" }
  | { kind: "mcp_elicitation_continuation" }
  | { kind: "browser_checkpoint_recovery" };

const PROVIDER_REPLAY_CONTRACT_REGISTRY: Record<string, ProviderReplayContract> = {
  // External mutating / message / device / purchase effects: no blind replay.
  "home-assistant/call_service": { kind: "never_replay" },
  "grok/generate_image": { kind: "never_replay" },
  "voice/speak": { kind: "never_replay" },
  "html-artifact/create": { kind: "never_replay" },
  "browser/browser_resume": { kind: "never_replay" },
  "browser/browser_task": { kind: "never_replay" },
  "browser/browser_execute": { kind: "never_replay" },
  "sandbox-runtime/execute_script": { kind: "never_replay" },

  // Genuinely read-only or deterministic canary providers.
  "operia-observer/system_status": { kind: "read_only_safe" },
  "source-code/list": { kind: "read_only_safe" },
  "source-code/search": { kind: "read_only_safe" },
  "source-code/read": { kind: "read_only_safe" },
  "source-code/inspect": { kind: "read_only_safe" },
  "sandbox-codemode/execute_read_plan": { kind: "read_only_safe" },
  "health/health_summary": { kind: "read_only_safe" },
  "health/health_trends": { kind: "read_only_safe" },
  "calendar/calendar_summary": { kind: "read_only_safe" },
  "calendar/calendar_upcoming": { kind: "read_only_safe" },
  "grok/search_web": { kind: "read_only_safe" },
  [`${THINK_APPROVAL_PROBE_SERVER_ID}/${THINK_APPROVAL_PROBE_TOOL_NAME}`]: { kind: "read_only_safe" },
  "browser/browser_markdown": { kind: "read_only_safe" },
  "browser/browser_links": { kind: "read_only_safe" },
  "browser/browser_scrape": { kind: "read_only_safe" },
  "browser/browser_extract": { kind: "read_only_safe" },
  "browser/site_adapter_read": { kind: "read_only_safe" },
};

export function parseToolKeyFromCallKey(callKey: string): string | null {
  const parts = callKey.split(":");
  if (parts.length < 4) return null;
  const serverId = parts[parts.length - 3];
  const toolName = parts[parts.length - 2];
  if (!serverId || !toolName) return null;
  return `${serverId}/${toolName}`;
}

export function lookupProviderReplayContract(callKey: string): ProviderReplayContract {
  const toolKey = parseToolKeyFromCallKey(callKey);
  if (!toolKey) return { kind: "unsafe_unknown" };
  return PROVIDER_REPLAY_CONTRACT_REGISTRY[toolKey] ?? { kind: "unsafe_unknown" };
}

export function retrySafetyAllowsRetry(input: {
  status: string;
  providerCallCompleted: boolean;
  dispatchState: DispatchState | null | undefined;
  replayContract?: ProviderReplayContract | null;
  proof?: RetrySafetyProof | null;
}): boolean {
  if (input.providerCallCompleted) return false;
  if (input.status !== "uncertain" && input.status !== "retry_authorized") return false;
  const dispatchState = input.dispatchState ?? "dispatched";
  if (dispatchState === "terminal_observed") return false;
  if (dispatchState === "reserved") {
    // The local execution path never reached the Provider dispatch boundary.
    return true;
  }
  const contract = input.replayContract ?? { kind: "unsafe_unknown" };
  const proof = input.proof ?? null;
  switch (contract.kind) {
    case "never_replay":
      return false;
    case "read_only_safe":
      return proof?.kind === "read_only_safe";
    case "stable_idempotency": {
      if (!proof || proof.kind !== "stable_idempotency") return false;
      return proof.idempotencyKey === contract.key;
    }
    case "read_after_write": {
      if (!proof || proof.kind !== "read_after_write") return false;
      return proof.state === "not_applied";
    }
    case "unsafe_unknown":
    default:
      return proof?.kind === "owner_attested_not_applied" || proof?.kind === "system_verified_not_applied";
  }
}

export function sideEffectReplayDecision(input: {
  status: string | null;
  providerCallCompleted: boolean;
  dispatchState?: DispatchState | null;
  hasReceipt: boolean;
}): "invoke" | "reuse" | "attention_required" {
  if (input.status === null) return "invoke";
  if (input.status === "reserved") return "invoke";
  if (input.status === "retry_authorized") return "invoke";
  if (input.providerCallCompleted || input.status === "completed") {
    return input.hasReceipt ? "reuse" : "attention_required";
  }
  return "attention_required";
}

export function canAuthorizeRetry(input: {
  status: string;
  providerCallCompleted: boolean;
  taskStatus?: string;
  dispatchState?: DispatchState | null;
  replayContract?: ProviderReplayContract | null;
  proof?: RetrySafetyProof | null;
}): boolean {
  if (input.taskStatus !== undefined && input.taskStatus !== "attention_required") return false;
  if (input.status !== "uncertain") return false;
  return retrySafetyAllowsRetry({
    status: input.status,
    providerCallCompleted: input.providerCallCompleted,
    dispatchState: input.dispatchState,
    replayContract: input.replayContract,
    proof: input.proof,
  });
}

const RETRY_PROOF_MAX_EVIDENCE_CHARS = 4096;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  // Allow only well-formed ISO-8601 timestamps with an explicit offset/Z.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(value);
}

function isHexSha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function assertExactFields(record: Record<string, unknown>, allowed: string[]): void {
  const actual = Object.keys(record);
  if (actual.length !== allowed.length || !allowed.every((key) => actual.includes(key))) {
    throw new Error("retry_proof_unknown_fields");
  }
}

export type RetrySafetyProofParseContext = { source: "client" | "server" };

export function parseRetrySafetyProof(
  value: unknown,
  context: RetrySafetyProofParseContext = { source: "client" },
): RetrySafetyProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("retry_proof_malformed");
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (!isNonEmptyString(kind)) throw new Error("retry_proof_kind_required");

  switch (kind) {
    case "not_dispatched": {
      assertExactFields(record, ["kind"]);
      return { kind: "not_dispatched" };
    }
    case "stable_idempotency": {
      assertExactFields(record, ["kind", "idempotencyKey"]);
      if (!isNonEmptyString(record.idempotencyKey)) throw new Error("retry_proof_idempotency_key_required");
      return { kind: "stable_idempotency", idempotencyKey: record.idempotencyKey };
    }
    case "owner_attested_not_applied": {
      assertExactFields(record, ["kind", "evidence"]);
      if (!isNonEmptyString(record.evidence)) throw new Error("retry_proof_evidence_required");
      if (record.evidence.length > RETRY_PROOF_MAX_EVIDENCE_CHARS) throw new Error("retry_proof_evidence_oversized");
      return { kind: "owner_attested_not_applied", evidence: record.evidence };
    }
    case "system_verified_not_applied": {
      assertExactFields(record, ["kind", "verifier", "evidenceHash", "observedAt"]);
      const verifier = record.verifier;
      const evidenceHash = record.evidenceHash;
      const observedAt = record.observedAt;
      if (!isNonEmptyString(verifier)) throw new Error("retry_proof_verifier_required");
      if (!isHexSha256(evidenceHash)) throw new Error("retry_proof_evidence_hash_invalid");
      if (!isIsoTimestamp(observedAt)) throw new Error("retry_proof_observed_at_invalid");
      if (context.source === "client") throw new Error("retry_proof_system_verification_forbidden_from_client");
      return {
        kind: "system_verified_not_applied",
        verifier: verifier as string,
        evidenceHash: evidenceHash as string,
        observedAt: observedAt as string,
      };
    }
    case "read_after_write": {
      assertExactFields(record, ["kind", "adapter", "state", "evidenceHash", "observedAt"]);
      const adapter = record.adapter;
      const state = record.state;
      const evidenceHash = record.evidenceHash;
      const observedAt = record.observedAt;
      if (!isNonEmptyString(adapter)) throw new Error("retry_proof_adapter_required");
      if (!["not_applied", "applied", "inconclusive"].includes(state as string)) {
        throw new Error("retry_proof_read_state_invalid");
      }
      if (!isHexSha256(evidenceHash)) throw new Error("retry_proof_evidence_hash_invalid");
      if (!isIsoTimestamp(observedAt)) throw new Error("retry_proof_observed_at_invalid");
      if (context.source === "client") throw new Error("retry_proof_read_after_write_forbidden_from_client");
      return {
        kind: "read_after_write",
        adapter: adapter as string,
        state: state as "not_applied" | "applied" | "inconclusive",
        evidenceHash: evidenceHash as string,
        observedAt: observedAt as string,
      };
    }
    case "read_only_safe": {
      assertExactFields(record, ["kind"]);
      return { kind: "read_only_safe" };
    }
    case "mcp_elicitation_continuation": {
      assertExactFields(record, ["kind"]);
      if (context.source === "client") throw new Error("retry_proof_mcp_elicitation_forbidden_from_client");
      return { kind: "mcp_elicitation_continuation" };
    }
    case "browser_checkpoint_recovery": {
      assertExactFields(record, ["kind"]);
      if (context.source === "client") throw new Error("retry_proof_browser_checkpoint_forbidden_from_client");
      return { kind: "browser_checkpoint_recovery" };
    }
    default:
      throw new Error("retry_proof_kind_unknown");
  }
}

export type RetryAuthorityReceipt = {
  schemaVersion: 1;
  callKey: string;
  contract: ProviderReplayContract;
  proof: RetrySafetyProof;
  authorizedBy: { type: "owner" | "system"; id: string };
  authorizedAt: string;
};

export function encodeRetryAuthorityReceipt(receipt: RetryAuthorityReceipt): string {
  return canonicalJson(assertJsonValue(receipt));
}

export function decodeRetryAuthorityReceipt(value: unknown): RetryAuthorityReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  if (!isNonEmptyString(record.callKey)) return null;
  if (!record.contract || typeof record.contract !== "object" || Array.isArray(record.contract)) return null;
  if (!record.authorizedBy || typeof record.authorizedBy !== "object" || Array.isArray(record.authorizedBy)) return null;
  const authorizedBy = record.authorizedBy as Record<string, unknown>;
  if (!["owner", "system"].includes(authorizedBy.type as string) || !isNonEmptyString(authorizedBy.id)) return null;
  if (!isIsoTimestamp(record.authorizedAt)) return null;
  let proof: RetrySafetyProof;
  try {
    proof = parseRetrySafetyProof(record.proof, { source: "server" });
  } catch {
    return null;
  }
  const contract = record.contract as ProviderReplayContract;
  if (!["never_replay", "stable_idempotency", "read_after_write", "read_only_safe", "unsafe_unknown"].includes(contract.kind)) {
    return null;
  }
  if (contract.kind === "stable_idempotency" && !isNonEmptyString(contract.key)) return null;
  if (contract.kind === "read_after_write" && !isNonEmptyString(contract.adapter)) return null;
  return {
    schemaVersion: 1,
    callKey: record.callKey,
    contract,
    proof,
    authorizedBy: { type: authorizedBy.type as "owner" | "system", id: authorizedBy.id },
    authorizedAt: record.authorizedAt as string,
  };
}

export function pinnedContractMatches(contract: ProviderReplayContract, pinned: ProviderReplayContract): boolean {
  if (contract.kind !== pinned.kind) return false;
  if (contract.kind === "stable_idempotency" && pinned.kind === "stable_idempotency") {
    return contract.key === pinned.key;
  }
  if (contract.kind === "read_after_write" && pinned.kind === "read_after_write") {
    return contract.adapter === pinned.adapter;
  }
  return true;
}

const SYSTEM_ONLY_RETRY_PROOF_KINDS = new Set([
  "system_verified_not_applied",
  "read_after_write",
  "mcp_elicitation_continuation",
  "browser_checkpoint_recovery",
]);

function retryProofCompatibleWithContract(
  contract: ProviderReplayContract,
  proof: RetrySafetyProof,
): boolean {
  // Server-side continuation proofs are independent of the underlying Provider replay contract
  // because they represent resuming an already-authorized elicitation or checkpoint sequence.
  if (proof.kind === "mcp_elicitation_continuation" || proof.kind === "browser_checkpoint_recovery") {
    return true;
  }
  switch (contract.kind) {
    case "never_replay":
      return false;
    case "read_only_safe":
      return proof.kind === "read_only_safe";
    case "stable_idempotency":
      return proof.kind === "stable_idempotency" && proof.idempotencyKey === contract.key;
    case "read_after_write":
      return (
        proof.kind === "read_after_write" &&
        proof.adapter === contract.adapter &&
        proof.state === "not_applied"
      );
    case "unsafe_unknown":
    default:
      return proof.kind === "owner_attested_not_applied" || proof.kind === "system_verified_not_applied";
  }
}

export function validateRetryAuthorityForClaim(input: {
  authority: RetryAuthorityReceipt;
  callKey: string;
  pinnedContract: ProviderReplayContract;
}): { valid: boolean; reason?: string } {
  const { authority, callKey, pinnedContract } = input;
  if (authority.schemaVersion !== 1) {
    return { valid: false, reason: "retry_authority_schema_version_mismatch" };
  }
  if (authority.callKey !== callKey) {
    return { valid: false, reason: "retry_authority_call_key_mismatch" };
  }
  if (!pinnedContractMatches(pinnedContract, authority.contract)) {
    return { valid: false, reason: "retry_authority_contract_mismatch" };
  }
  if (!retryProofCompatibleWithContract(pinnedContract, authority.proof)) {
    return { valid: false, reason: "retry_authority_proof_incompatible_with_contract" };
  }
  const proofKind = authority.proof.kind;
  if (SYSTEM_ONLY_RETRY_PROOF_KINDS.has(proofKind) && authority.authorizedBy.type !== "system") {
    return { valid: false, reason: "retry_authority_system_proof_requires_system_actor" };
  }
  if (proofKind === "mcp_elicitation_continuation") {
    if (!authority.authorizedBy.id.startsWith("mcp-elicitation:")) {
      return { valid: false, reason: "retry_authority_mcp_source_required" };
    }
  }
  if (proofKind === "browser_checkpoint_recovery") {
    if (!authority.authorizedBy.id.startsWith("browser-checkpoint:")) {
      return { valid: false, reason: "retry_authority_browser_checkpoint_source_required" };
    }
  }
  return { valid: true };
}

export type SideEffectState = {
  status: string;
  providerCallCompleted: boolean;
  dispatchState: DispatchState;
  providerAttemptCount: number;
  responseJson: string | null;
  resultStatus: string | null;
  errorClass: string | null;
};

export function providerReserveTransition(state?: Partial<SideEffectState>): SideEffectState {
  return {
    status: "reserved",
    providerCallCompleted: false,
    dispatchState: "reserved",
    providerAttemptCount: 0,
    responseJson: null,
    resultStatus: null,
    errorClass: null,
    ...state,
  };
}

export function providerAttemptClaimTransition(
  state: SideEffectState,
  toStatus: "started" | "retry_authorized" = "started",
): SideEffectState {
  return {
    ...state,
    status: toStatus,
    dispatchState: "dispatched",
    providerAttemptCount: state.providerAttemptCount + 1,
    providerCallCompleted: false,
    responseJson: null,
    resultStatus: null,
    errorClass: null,
  };
}

export function providerMarkDispatchedTransition(state: SideEffectState): SideEffectState {
  return {
    ...state,
    status: state.status === "reserved" ? "started" : state.status,
    dispatchState: "dispatched",
  };
}

export function providerMarkOutcomeUnknownTransition(state: SideEffectState): SideEffectState {
  return {
    ...state,
    status: "uncertain",
    dispatchState: "dispatched",
    providerCallCompleted: false,
    responseJson: null,
    resultStatus: null,
    errorClass: null,
  };
}

export function providerDeferredTransition(state: SideEffectState): SideEffectState {
  return {
    ...state,
    status: "awaiting_input",
    providerCallCompleted: false,
    responseJson: null,
    resultStatus: null,
    errorClass: null,
  };
}

export function providerResumeFromElicitationTransition(state: SideEffectState): SideEffectState {
  return {
    ...state,
    status: "retry_authorized",
    providerCallCompleted: false,
    responseJson: null,
    resultStatus: null,
    errorClass: null,
  };
}

export function providerCompletionTransition(
  state: SideEffectState,
  receipt: ProviderResultReceipt,
): SideEffectState {
  return {
    ...state,
    status: "completed",
    providerCallCompleted: true,
    dispatchState: "terminal_observed",
    responseJson: canonicalJson(assertJsonValue(receipt)),
    resultStatus: receipt.resultStatus,
    errorClass: receipt.errorClass,
  };
}
