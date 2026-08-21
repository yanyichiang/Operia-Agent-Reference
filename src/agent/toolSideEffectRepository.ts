import {
  assertJsonValue,
  canonicalJson,
  safeSerializeForDisplay,
  type JsonValue,
} from "../utils/json";
import {
  decodeProviderResultReceipt,
  decodeRetryAuthorityReceipt,
  encodeProviderResultReceipt,
  encodeRetryAuthorityReceipt,
  lookupProviderReplayContract,
  pinnedContractMatches,
  providerCompletionTransition,
  retrySafetyAllowsRetry,
  validateRetryAuthorityForClaim,
  type DispatchState,
  type ProviderReplayContract,
  type ProviderResultReceipt,
  type RetryAuthorityReceipt,
  type RetrySafetyProof,
  type SideEffectState,
} from "./toolSideEffectState";

export type SideEffectSql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => T[];

export const DEFAULT_DISPATCH_STATE: DispatchState = "reserved";

function normalizeSqlValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export function makeSqlExecutor(db: { prepare: (sql: string) => { all: (...params: unknown[]) => unknown[]; run: (...params: unknown[]) => void } }): SideEffectSql {
  return <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    let sql = strings[0];
    const params: unknown[] = [];
    for (let i = 0; i < values.length; i += 1) {
      sql += "?" + strings[i + 1];
      params.push(normalizeSqlValue(values[i]));
    }
    const statement = db.prepare(sql);
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith("SELECT") || upper.includes("RETURNING")) {
      return statement.all(...params) as T[];
    }
    statement.run(...params);
    return [] as T[];
  };
}

type ToolSideEffectRow = {
  call_key: string;
  task_id: string;
  status: string;
  response_json: string | null;
  logical_invocation_count: number;
  provider_attempt_count: number;
  last_attempt_at: string | null;
  provider_call_completed: number;
  dispatch_state: DispatchState | null;
  result_status: string | null;
  error_class: string | null;
  invocation_contract_json: string | null;
  retry_authority_json: string | null;
  created_at: string;
  updated_at: string;
};

function inferDispatchState(row: Pick<ToolSideEffectRow, "status" | "provider_call_completed" | "dispatch_state">): DispatchState {
  if (row.dispatch_state) return row.dispatch_state;
  if (row.status === "completed" && row.provider_call_completed) return "terminal_observed";
  if (row.status === "awaiting_input") return "reserved";
  return "dispatched";
}

export function toSideEffectState(row: ToolSideEffectRow): SideEffectState {
  return {
    status: row.status,
    providerCallCompleted: Boolean(row.provider_call_completed),
    dispatchState: inferDispatchState(row),
    providerAttemptCount: row.provider_attempt_count,
    responseJson: row.response_json ?? null,
    resultStatus: row.result_status ?? null,
    errorClass: row.error_class ?? null,
  };
}

function parseInvocationContract(row: Pick<ToolSideEffectRow, "invocation_contract_json">): ProviderReplayContract | null {
  if (!row.invocation_contract_json) return null;
  try {
    const parsed = JSON.parse(row.invocation_contract_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const contract = parsed as ProviderReplayContract;
    if (!["never_replay", "stable_idempotency", "read_after_write", "read_only_safe", "unsafe_unknown"].includes(contract.kind)) return null;
    return contract;
  } catch {
    return null;
  }
}

export function upgradeLegacyCompletedRow(
  sql: SideEffectSql,
  callKey: string,
  row: ToolSideEffectRow,
): SideEffectState | null {
  if (row.status !== "completed" || !row.response_json) return null;
  let legacyValue: JsonValue;
  try {
    legacyValue = JSON.parse(row.response_json) as JsonValue;
  } catch {
    return null;
  }
  if (decodeProviderResultReceipt(legacyValue) !== null) {
    return toSideEffectState(row);
  }
  const receipt = encodeProviderResultReceipt({ resultStatus: "serializable", value: legacyValue });
  const responseJson = canonicalJson(assertJsonValue(receipt));
  const now = new Date().toISOString();
  sql`UPDATE tool_side_effects
    SET provider_call_completed=1,
        dispatch_state='terminal_observed',
        result_status='serializable',
        error_class=NULL,
        response_json=${responseJson},
        updated_at=${now}
    WHERE call_key=${callKey} AND status='completed'`;
  return {
    status: "completed",
    providerCallCompleted: true,
    dispatchState: "terminal_observed",
    providerAttemptCount: row.provider_attempt_count,
    responseJson,
    resultStatus: "serializable",
    errorClass: null,
  };
}

export function loadReplayState(sql: SideEffectSql, callKey: string): SideEffectState | null {
  const rows = sql<ToolSideEffectRow>`SELECT * FROM tool_side_effects WHERE call_key=${callKey}`;
  const row = rows[0];
  if (!row) return null;
  if (row.status === "completed") {
    let parsed: unknown = null;
    try {
      parsed = row.response_json ? JSON.parse(row.response_json) : null;
    } catch {
      parsed = null;
    }
    const receipt = parsed ? decodeProviderResultReceipt(parsed) : null;
    if (!receipt && row.response_json) {
      const upgraded = upgradeLegacyCompletedRow(sql, callKey, row);
      if (upgraded) return upgraded;
    }
  }
  if (row.status === "retry_authorized") {
    let authority: RetryAuthorityReceipt | null = null;
    try {
      authority = row.retry_authority_json ? decodeRetryAuthorityReceipt(JSON.parse(row.retry_authority_json)) : null;
    } catch {
      authority = null;
    }
    if (!authority) {
      // Legacy or corrupted retry_authorized without a valid authority receipt must fail closed.
      const now = new Date().toISOString();
      sql`UPDATE tool_side_effects
        SET status='uncertain', dispatch_state='dispatched', updated_at=${now}
        WHERE call_key=${callKey} AND status='retry_authorized'`;
      const reloaded = sql<ToolSideEffectRow>`SELECT * FROM tool_side_effects WHERE call_key=${callKey}`[0];
      return reloaded ? toSideEffectState(reloaded) : null;
    }
  }
  return toSideEffectState(row);
}

export function reserveLogicalInvocation(
  sql: SideEffectSql,
  input: { callKey: string; taskId: string; contract?: ProviderReplayContract; now?: string },
): SideEffectState {
  const now = input.now ?? new Date().toISOString();
  const existing = loadReplayState(sql, input.callKey);
  if (existing) {
    if (existing.status === "reserved") return existing;
    throw new Error("side_effect_already_reserved");
  }
  const contract = input.contract ?? lookupProviderReplayContract(input.callKey);
  const contractJson = canonicalJson(assertJsonValue(contract));
  sql`INSERT INTO tool_side_effects
    (call_key, task_id, status, logical_invocation_count, provider_attempt_count,
     provider_call_completed, dispatch_state, invocation_contract_json, last_attempt_at, created_at, updated_at)
    VALUES
    (${input.callKey}, ${input.taskId}, 'reserved', 1, 0,
     0, 'reserved', ${contractJson}, ${now}, ${now}, ${now})`;
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_reserve_failed");
  return state;
}

export function claimProviderAttempt(
  sql: SideEffectSql,
  input: { callKey: string; now?: string },
): { state: SideEffectState; claimed: boolean } {
  const now = input.now ?? new Date().toISOString();
  const rowsBefore = sql<ToolSideEffectRow>`SELECT * FROM tool_side_effects WHERE call_key=${input.callKey}`;
  const rowBefore = rowsBefore[0];
  if (rowBefore?.status === "retry_authorized") {
    let authority: RetryAuthorityReceipt | null = null;
    try {
      authority = rowBefore.retry_authority_json
        ? decodeRetryAuthorityReceipt(JSON.parse(rowBefore.retry_authority_json))
        : null;
    } catch {
      authority = null;
    }
    const pinnedContract = parseInvocationContract(rowBefore) ?? lookupProviderReplayContract(input.callKey);
    const validAuthority =
      authority &&
      validateRetryAuthorityForClaim({
        authority,
        callKey: input.callKey,
        pinnedContract,
      }).valid;
    if (!validAuthority) {
      // Corrupt, legacy, drifted, or otherwise invalid retry authority: fail closed.
      sql`UPDATE tool_side_effects
        SET status='uncertain', dispatch_state='dispatched', updated_at=${now}
        WHERE call_key=${input.callKey} AND status='retry_authorized'`;
      const state = loadReplayState(sql, input.callKey);
      if (!state) throw new Error("side_effect_missing_after_claim");
      return { state, claimed: false };
    }
  }
  const claimed = sql<ToolSideEffectRow>`UPDATE tool_side_effects
    SET status='started',
        dispatch_state='dispatched',
        provider_attempt_count=provider_attempt_count+1,
        provider_call_completed=0,
        response_json=NULL,
        result_status=NULL,
        error_class=NULL,
        last_attempt_at=${now},
        updated_at=${now}
    WHERE call_key=${input.callKey} AND status IN ('reserved','retry_authorized')
    RETURNING *`;
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_missing_after_claim");
  return { state, claimed: claimed.length === 1 };
}

export function markProviderDispatched(sql: SideEffectSql, input: { callKey: string; now?: string }): SideEffectState {
  const now = input.now ?? new Date().toISOString();
  sql`UPDATE tool_side_effects
    SET dispatch_state='dispatched', updated_at=${now}
    WHERE call_key=${input.callKey}`;
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_missing");
  return state;
}

export function persistTerminalReceipt(
  sql: SideEffectSql,
  input: { callKey: string; receipt: ProviderResultReceipt; now?: string },
): SideEffectState {
  const now = input.now ?? new Date().toISOString();
  const responseJson = canonicalJson(assertJsonValue(input.receipt));
  sql`UPDATE tool_side_effects
    SET status='completed',
        provider_call_completed=1,
        dispatch_state='terminal_observed',
        result_status=${input.receipt.resultStatus},
        error_class=${input.receipt.errorClass},
        response_json=${responseJson},
        updated_at=${now}
    WHERE call_key=${input.callKey}`;
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_missing");
  return state;
}

export function markDeferred(sql: SideEffectSql, input: { callKey: string; now?: string }): SideEffectState {
  const now = input.now ?? new Date().toISOString();
  sql`UPDATE tool_side_effects
    SET status='awaiting_input',
        provider_call_completed=0,
        response_json=NULL,
        result_status=NULL,
        error_class=NULL,
        updated_at=${now}
    WHERE call_key=${input.callKey} AND status='started'`;
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_missing");
  return state;
}

export function markOutcomeUnknown(sql: SideEffectSql, input: { callKey: string; now?: string }): SideEffectState {
  const now = input.now ?? new Date().toISOString();
  sql`UPDATE tool_side_effects
    SET status='uncertain',
        dispatch_state='dispatched',
        provider_call_completed=0,
        response_json=NULL,
        result_status=NULL,
        error_class=NULL,
        updated_at=${now}
    WHERE call_key=${input.callKey} AND status='started'`;
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_missing");
  return state;
}

export function markAwaitingInputExpired(
  sql: SideEffectSql,
  input: { callKey: string; now?: string },
): SideEffectState {
  const now = input.now ?? new Date().toISOString();
  const receipt = encodeProviderResultReceipt({
    resultStatus: "unserializable",
    display: safeSerializeForDisplay({ kind: "mcp_elicitation_expired" }),
  });
  const responseJson = canonicalJson(assertJsonValue(receipt));
  sql`UPDATE tool_side_effects
    SET status='failed',
        provider_call_completed=1,
        dispatch_state='terminal_observed',
        result_status=${receipt.resultStatus},
        error_class=${receipt.errorClass},
        response_json=${responseJson},
        updated_at=${now}
    WHERE call_key=${input.callKey} AND status='awaiting_input'`;
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_missing");
  return state;
}

export function markAllStartedOutcomeUnknown(
  sql: SideEffectSql,
  input: { taskId: string; now?: string },
): { count: number } {
  const now = input.now ?? new Date().toISOString();
  const changed = sql<{ call_key: string }>`UPDATE tool_side_effects
    SET status='uncertain',
        dispatch_state='dispatched',
        provider_call_completed=0,
        response_json=NULL,
        result_status=NULL,
        error_class=NULL,
        updated_at=${now}
    WHERE task_id=${input.taskId} AND status='started'
    RETURNING call_key`;
  return { count: changed.length };
}

export function markDefinitiveFailure(
  sql: SideEffectSql,
  input: { callKey: string; code: string; now?: string },
): SideEffectState {
  const now = input.now ?? new Date().toISOString();
  const receipt = encodeProviderResultReceipt({
    resultStatus: "unserializable",
    display: safeSerializeForDisplay({ kind: "definitive_tool_failure", code: input.code }),
  });
  const responseJson = canonicalJson(assertJsonValue(receipt));
  sql`UPDATE tool_side_effects
    SET status='failed',
        provider_call_completed=1,
        dispatch_state='terminal_observed',
        result_status=${receipt.resultStatus},
        error_class=${receipt.errorClass},
        response_json=${responseJson},
        updated_at=${now}
    WHERE call_key=${input.callKey} AND status='started'`;
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_missing");
  return state;
}

export function markClosedWithoutRetry(
  sql: SideEffectSql,
  input: { callKey: string; display: string; now?: string },
): SideEffectState {
  const now = input.now ?? new Date().toISOString();
  const receipt = encodeProviderResultReceipt({ resultStatus: "unserializable", display: input.display });
  const responseJson = canonicalJson(assertJsonValue(receipt));
  sql`UPDATE tool_side_effects
    SET status='failed',
        provider_call_completed=1,
        dispatch_state='terminal_observed',
        result_status=${receipt.resultStatus},
        error_class=${receipt.errorClass},
        response_json=${responseJson},
        updated_at=${now}
    WHERE call_key=${input.callKey} AND status='uncertain'`;
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_missing");
  return state;
}

export function quarantineInFlight(
  sql: SideEffectSql,
  input: { callKey: string; now?: string },
): SideEffectState {
  const now = input.now ?? new Date().toISOString();
  const rows = sql<ToolSideEffectRow>`UPDATE tool_side_effects
    SET status='quarantined', updated_at=${now}
    WHERE call_key=${input.callKey}
      AND status='started'
      AND dispatch_state='dispatched'
      AND provider_call_completed=0
    RETURNING *`;
  if (rows.length !== 1) {
    throw new Error("side_effect_quarantine_in_flight_invalid");
  }
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_missing");
  return state;
}

export function quarantinePreservingReceipt(
  sql: SideEffectSql,
  input: { callKey: string; now?: string },
): SideEffectState {
  const now = input.now ?? new Date().toISOString();
  const rows = sql<ToolSideEffectRow>`UPDATE tool_side_effects
    SET status='quarantined', updated_at=${now}
    WHERE call_key=${input.callKey}
      AND status='completed'
      AND dispatch_state='terminal_observed'
      AND provider_call_completed=1
      AND response_json IS NOT NULL
    RETURNING *`;
  if (rows.length !== 1) {
    throw new Error("side_effect_quarantine_receipt_invalid");
  }
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_missing");
  return state;
}

export function persistRetryAuthority(
  sql: SideEffectSql,
  input: { callKey: string; authority: RetryAuthorityReceipt; now?: string },
): SideEffectState {
  const authorityJson = encodeRetryAuthorityReceipt(input.authority);
  const now = input.now ?? new Date().toISOString();
  sql`UPDATE tool_side_effects
    SET retry_authority_json=${authorityJson}, updated_at=${now}
    WHERE call_key=${input.callKey}`;
  const state = loadReplayState(sql, input.callKey);
  if (!state) throw new Error("side_effect_missing");
  return state;
}

export function normalizeInFlightQuarantineForReconciliation(
  sql: SideEffectSql,
  callKey: string,
): SideEffectState | null {
  const now = new Date().toISOString();
  const rows = sql<ToolSideEffectRow>`UPDATE tool_side_effects
    SET status='uncertain', updated_at=${now}
    WHERE call_key=${callKey}
      AND status='quarantined'
      AND dispatch_state='dispatched'
      AND provider_call_completed=0
      AND response_json IS NULL
    RETURNING *`;
  if (rows.length !== 1) return null;
  const state = loadReplayState(sql, callKey);
  return state;
}

export function loadRetryAuthority(
  sql: SideEffectSql,
  callKey: string,
): RetryAuthorityReceipt | null {
  const rows = sql<{ retry_authority_json: string | null }>`SELECT retry_authority_json FROM tool_side_effects WHERE call_key=${callKey}`;
  const row = rows[0];
  if (!row?.retry_authority_json) return null;
  try {
    return decodeRetryAuthorityReceipt(JSON.parse(row.retry_authority_json));
  } catch {
    return null;
  }
}

export function consumeRetryAuthority(
  sql: SideEffectSql,
  input: { callKey: string; contractSnapshot: ProviderReplayContract; proof: RetrySafetyProof; now?: string },
): { valid: boolean; authority: RetryAuthorityReceipt | null; state: SideEffectState | null } {
  const authority = loadRetryAuthority(sql, input.callKey);
  if (!authority) return { valid: false, authority: null, state: loadReplayState(sql, input.callKey) };
  if (authority.schemaVersion !== 1) return { valid: false, authority, state: loadReplayState(sql, input.callKey) };
  if (authority.callKey !== input.callKey) return { valid: false, authority, state: loadReplayState(sql, input.callKey) };
  if (!pinnedContractMatches(input.contractSnapshot, authority.contract)) {
    return { valid: false, authority, state: loadReplayState(sql, input.callKey) };
  }
  if (canonicalJson(assertJsonValue(authority.proof)) !== canonicalJson(assertJsonValue(input.proof))) {
    return { valid: false, authority, state: loadReplayState(sql, input.callKey) };
  }
  return { valid: true, authority, state: loadReplayState(sql, input.callKey) };
}

export function authorizeRetry(
  sql: SideEffectSql,
  input: { callKey: string; contract?: ProviderReplayContract; proof: RetrySafetyProof; authorizedBy: { type: "owner" | "system"; id: string }; now?: string },
): { allowed: boolean; state: SideEffectState | null } {
  const state = loadReplayState(sql, input.callKey);
  if (!state) return { allowed: false, state: null };
  const pinnedContract = parseInvocationContract(sql<ToolSideEffectRow>`SELECT invocation_contract_json FROM tool_side_effects WHERE call_key=${input.callKey}`[0])
    ?? lookupProviderReplayContract(input.callKey);
  if (!retrySafetyAllowsRetry({ ...state, replayContract: pinnedContract, proof: input.proof })) {
    return { allowed: false, state };
  }
  const now = input.now ?? new Date().toISOString();
  const authority: RetryAuthorityReceipt = {
    schemaVersion: 1,
    callKey: input.callKey,
    contract: pinnedContract,
    proof: input.proof,
    authorizedBy: input.authorizedBy,
    authorizedAt: now,
  };
  const authorityJson = encodeRetryAuthorityReceipt(authority);
  const changed = sql<{ call_key: string }>`UPDATE tool_side_effects
    SET status='retry_authorized', retry_authority_json=${authorityJson}, updated_at=${now}
    WHERE call_key=${input.callKey} AND status='uncertain'
    RETURNING call_key`;
  if (changed.length !== 1) return { allowed: false, state: loadReplayState(sql, input.callKey) };
  const updated = loadReplayState(sql, input.callKey);
  if (!updated) throw new Error("side_effect_missing");
  return { allowed: updated.status === "retry_authorized", state: updated };
}

export function authorizeServerSideContinuation(
  sql: SideEffectSql,
  input: { callKey: string; proof: RetrySafetyProof; authorizedBy: { type: "owner" | "system"; id: string }; now?: string },
): { allowed: boolean; state: SideEffectState | null } {
  const allowedProofKinds = new Set(["mcp_elicitation_continuation", "browser_checkpoint_recovery"]);
  if (!allowedProofKinds.has(input.proof.kind)) {
    return { allowed: false, state: loadReplayState(sql, input.callKey) };
  }
  const state = loadReplayState(sql, input.callKey);
  if (!state) return { allowed: false, state: null };
  if (!["awaiting_input", "started"].includes(state.status)) return { allowed: false, state };
  const now = input.now ?? new Date().toISOString();
  const pinnedContract = parseInvocationContract(sql<ToolSideEffectRow>`SELECT invocation_contract_json FROM tool_side_effects WHERE call_key=${input.callKey}`[0])
    ?? lookupProviderReplayContract(input.callKey);
  const authority: RetryAuthorityReceipt = {
    schemaVersion: 1,
    callKey: input.callKey,
    contract: pinnedContract,
    proof: input.proof,
    authorizedBy: input.authorizedBy,
    authorizedAt: now,
  };
  const authorityJson = encodeRetryAuthorityReceipt(authority);
  const changed = sql<{ call_key: string }>`UPDATE tool_side_effects
    SET status='retry_authorized', retry_authority_json=${authorityJson}, updated_at=${now}
    WHERE call_key=${input.callKey} AND status IN ('awaiting_input','started')
    RETURNING call_key`;
  if (changed.length !== 1) return { allowed: false, state: loadReplayState(sql, input.callKey) };
  const updated = loadReplayState(sql, input.callKey);
  if (!updated) throw new Error("side_effect_missing");
  return { allowed: updated.status === "retry_authorized", state: updated };
}
