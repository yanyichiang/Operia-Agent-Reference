import { canonicalArgsHash } from "./contextBroker";
import { sideEffectReplayDecision } from "./toolSideEffectState";
import { evaluateToolPolicy, sanitizeToolResult } from "./policy";
import { MAX_CONTINUATION_ROUNDS, MAX_TOOL_CALLS, planToolRound, type ToolPlannerTelemetry } from "./toolPlanner";
import type { DeferredToolApproval, PlannedToolCall, ToolCatalogEntry, ToolCatalogEntryInput, ToolPolicyDecision, ToolTaskCheckpoint } from "./types";

export type ToolTaskDeps = {
  ai: Parameters<typeof planToolRound>[0]["ai"];
  instruction: string;
  capsuleId: string;
  catalog: ToolCatalogEntry[];
  plannerCatalog?: ToolCatalogEntry[];
  observedCatalog: ToolCatalogEntry[];
  allowlists: Map<string, string[]>;
  evaluatePolicy?: (call: PlannedToolCall) => Promise<ToolPolicyDecision>;
  invoke: (call: PlannedToolCall, callKey: string, signal: AbortSignal) => Promise<unknown>;
  checkpoint: (value: ToolTaskCheckpoint) => void;
  signal: AbortSignal;
  isCancelled: () => boolean | Promise<boolean>;
  directCall?: PlannedToolCall;
  plannerModel?: string;
  onPlannerTelemetry?: (telemetry: ToolPlannerTelemetry) => void | Promise<void>;
};

type FiberLedgerStatus = "pending" | "running" | "completed" | "aborted" | "interrupted" | "error" | null;

export function decideFiberAttachment(taskStatus: ToolTaskCheckpoint["status"], fiberStatus: FiberLedgerStatus): "start" | "attach" | "recover" | "return_terminal" {
  if (["completed", "failed", "cancelled", "paused", "approval_required", "attention_required"].includes(taskStatus)) return "return_terminal";
  if (fiberStatus === "pending" || fiberStatus === "running") return "attach";
  if (fiberStatus === "interrupted") return "recover";
  return "start";
}

export function mapRecoveredCheckpoint(checkpoint: { status: ToolTaskCheckpoint["status"]; error?: string }):
  | { status: "completed" }
  | { status: "error"; error: string }
  | { status: "aborted"; reason: string }
  | { status: "interrupted"; reason: string } {
  if (checkpoint.status === "completed" || checkpoint.status === "approval_required") return { status: "completed" };
  if (checkpoint.status === "cancelled") return { status: "aborted", reason: "cancelled" };
  if (checkpoint.status === "failed") return { status: "error", error: checkpoint.error ?? "task_failed" };
  return { status: "interrupted", reason: "task_not_terminal" };
}

export function sideEffectReplayAction(status: string | null, providerCallCompleted?: boolean): "invoke" | "reuse" | "attention_required" {
  // The exported legacy shim preserves the prior contract for callers that do not have
  // receipt availability: completed rows (and started rows already marked completed by
  // the provider) are treated as reusable. Production replay paths call
  // sideEffectReplayDecision directly with actual hasReceipt.
  const completedLike = status === "completed" || (status === "started" && (providerCallCompleted ?? false));
  return sideEffectReplayDecision({
    status,
    providerCallCompleted: providerCallCompleted ?? false,
    dispatchState: providerCallCompleted ? "terminal_observed" : null,
    hasReceipt: completedLike,
  });
}

export function canReconcileSideEffect(taskStatus: ToolTaskCheckpoint["status"], sideEffectStatus: string): boolean {
  return taskStatus === "attention_required" && sideEffectStatus === "uncertain";
}

export function repairFiberKey(idempotencyKey: string, taskId: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid_repair_generation");
  return `${idempotencyKey}:repair:${taskId}:${generation}`;
}

export function normalizeRecoveredCheckpoint(checkpoint: ToolTaskCheckpoint, uncertainSideEffects: number): ToolTaskCheckpoint {
  if (!Number.isSafeInteger(uncertainSideEffects) || uncertainSideEffects < 0) {
    throw new Error("invalid_uncertain_side_effect_count");
  }
  if (uncertainSideEffects > 0) {
    return { ...checkpoint, status: "attention_required", error: "uncertain_tool_side_effect" };
  }
  if (checkpoint.status === "executing" && checkpoint.pendingCall) {
    return { ...checkpoint, status: "interrupted", error: undefined };
  }
  return checkpoint;
}

export type ObservedMcpTool = { name: string; description: string; inputSchema: Record<string, unknown> | boolean };

export function requestedCatalogServerId(body: Record<string, unknown>, currentServerId: string): string {
  return typeof body.serverId === "string" ? body.serverId : currentServerId;
}

export function deriveObservedCatalogInputs(
  serverId: string,
  intendedCatalog: ReadonlyArray<ToolCatalogEntry>,
  actualTools: ReadonlyArray<ObservedMcpTool>,
): ToolCatalogEntryInput[] {
  return actualTools.flatMap((actual) => {
    const intended = intendedCatalog.find((entry) => entry.serverId === serverId && entry.toolName === actual.name);
    return intended ? [{
      serverId,
      toolName: actual.name,
      description: actual.description,
      riskLevel: intended.riskLevel,
      inputSchema: actual.inputSchema,
      outputByteLimit: intended.outputByteLimit,
      enabled: intended.enabled,
    }] : [];
  });
}

export function parseMcpToolsListResponse(payload: unknown): ObservedMcpTool[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid_mcp_tools_list");
  const result = (payload as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid_mcp_tools_list");
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) throw new Error("invalid_mcp_tools_list");
  return tools.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_mcp_tools_list");
    const tool = raw as Record<string, unknown>;
    const schema = tool.inputSchema;
    if (
      typeof tool.name !== "string" || tool.name.length === 0 ||
      !((typeof schema === "object" && schema !== null && !Array.isArray(schema)) || typeof schema === "boolean")
    ) throw new Error("invalid_mcp_tools_list");
    return { name: tool.name, description: typeof tool.description === "string" ? tool.description : "", inputSchema: schema as Record<string, unknown> | boolean };
  });
}

export async function executeToolTask(taskId: string, deps: ToolTaskDeps, restored?: ToolTaskCheckpoint): Promise<ToolTaskCheckpoint> {
  let state: ToolTaskCheckpoint = restored ?? {
    taskId,
    status: "planning",
    round: 0,
    callCount: 0,
    completedCallKeys: [],
    results: [],
  };
  if (["completed", "failed", "cancelled", "paused", "approval_required", "attention_required"].includes(state.status)) return state;
  await publish(deps, state);

  if (restored?.status === "interrupted" && restored.pendingCall) {
    return resumeAuthorizedPendingCall(taskId, deps, state, restored.pendingCall);
  }

  if (deps.directCall) {
    if (state.results.length > 0 && !state.pendingCall) {
      state = { ...state, status: "completed", round: Math.max(1, state.round) };
      await publish(deps, state);
      return state;
    }
    return executeDirectCall(taskId, deps, state, deps.directCall);
  }

  let plannerRepairsRemaining = 1;
  planningRounds: for (let round = state.round; round < MAX_CONTINUATION_ROUNDS; round += 1) {
    await assertActive(deps);
    state = { ...state, status: "planning", round, pendingCall: undefined };
    await publish(deps, state);
    await assertActive(deps);
    const plan = await planToolRound({
      ai: deps.ai,
      instruction: deps.instruction,
      capsuleId: deps.capsuleId,
      tools: deps.plannerCatalog ?? deps.catalog,
      results: state.results,
      round,
      remainingCalls: MAX_TOOL_CALLS - state.callCount,
      model: deps.plannerModel,
      onTelemetry: deps.onPlannerTelemetry,
    });
    if (plan.kind === "complete") {
      state = { ...state, status: "completed", round: round + 1 };
      await publish(deps, state);
      return state;
    }

    let executedInRound = false;
    for (const call of plan.calls) {
      await assertActive(deps);
      if (state.callCount >= MAX_TOOL_CALLS) throw new Error("tool_call_limit");
      const argsHash = await canonicalArgsHash(call.args);
      const callKey = `${taskId}:${call.serverId}:${call.toolName}:${argsHash}`;
      if (state.completedCallKeys.includes(callKey)) continue;
      await assertActive(deps);
      const decision = await taskPolicy(deps, call);
      if (!decision.ok) throw new Error(`policy_denied:${decision.code}`);
      if (decision.requiresApproval) {
        state = { ...state, status: "approval_required", pendingCall: call };
        await publish(deps, state);
        return state;
      }
      state = { ...state, status: "executing", pendingCall: call };
      await publish(deps, state);
      await assertActive(deps);
      let raw: unknown;
      try {
        raw = await deps.invoke(call, callKey, deps.signal);
      } catch (error) {
        const recoverableCode = recoverablePlannerToolError(call, error);
        if (!recoverableCode) throw error;
        const sanitized = sanitizeToolResult({
          catalog: deps.catalog,
          serverId: call.serverId,
          toolName: call.toolName,
          result: { ok: false, error: recoverableCode, retryable: true },
        });
        state = {
          ...state,
          callCount: state.callCount + 1,
          results: [...state.results, sanitized],
          pendingCall: undefined,
        };
        executedInRound = true;
        await publish(deps, state);
        if (plannerRepairsRemaining > 0) {
          plannerRepairsRemaining -= 1;
          round -= 1;
          continue planningRounds;
        }
        continue;
      }
      await assertActive(deps);
      if (isDeferredToolApproval(raw)) {
        state = {
          ...state,
          status: "approval_required",
          callCount: state.callCount + 1,
          completedCallKeys: [...state.completedCallKeys, callKey],
          pendingCall: raw.pendingCall,
        };
        await publish(deps, state);
        return state;
      }
      const sanitized = sanitizeToolResult({ catalog: deps.catalog, serverId: call.serverId, toolName: call.toolName, result: raw });
      state = {
        ...state,
        callCount: state.callCount + 1,
        completedCallKeys: [...state.completedCallKeys, callKey],
        results: [...state.results, sanitized],
        pendingCall: undefined,
      };
      executedInRound = true;
      await publish(deps, state);
    }
    if (!executedInRound && state.results.length > 0) {
      state = { ...state, status: "completed", round: round + 1 };
      await publish(deps, state);
      return state;
    }
  }
  state = { ...state, status: "failed", round: MAX_CONTINUATION_ROUNDS, error: "continuation_round_limit" };
  await publish(deps, state);
  return state;
}

const RECOVERABLE_BROWSER_PLAN_ERRORS = new Set([
  "browser_interactive_code_invalid",
  "browser_interactive_async_arrow_required",
  "browser_interactive_forbidden_global",
  "browser_interactive_cdp_alias_forbidden",
  "browser_interactive_literal_cdp_method_required",
  "browser_interactive_literal_navigation_url_required",
  "browser_interactive_single_handoff_required",
  "browser_interactive_handoff_required",
  "browser_interactive_step_limit",
  "browser_interactive_tab_limit",
  "browser_interactive_screenshot_limit",
]);

const RECOVERABLE_BROWSER_TASK_PLAN_ERRORS = new Set([
  "browser_task_initial_navigation_required",
]);

export function recoverablePlannerToolError(call: PlannedToolCall, error: unknown): string | null {
  if (call.serverId !== "browser" || !(error instanceof Error)) return null;
  const code = error.message.split(":", 1)[0];
  if (call.toolName === "browser_execute") return RECOVERABLE_BROWSER_PLAN_ERRORS.has(code) ? code : null;
  if (call.toolName === "browser_task") return RECOVERABLE_BROWSER_TASK_PLAN_ERRORS.has(code) ? code : null;
  return null;
}

async function executeDirectCall(
  taskId: string,
  deps: ToolTaskDeps,
  state: ToolTaskCheckpoint,
  call: PlannedToolCall,
): Promise<ToolTaskCheckpoint> {
  await assertActive(deps);
  const argsHash = await canonicalArgsHash(call.args);
  const callKey = `${taskId}:${call.serverId}:${call.toolName}:${argsHash}`;
  if (state.completedCallKeys.includes(callKey)) {
    const completed = { ...state, status: "completed" as const, round: 1, pendingCall: undefined };
    await publish(deps, completed);
    return completed;
  }
  const decision = await taskPolicy(deps, call);
  if (!decision.ok) throw new Error(`policy_denied:${decision.code}`);
  if (decision.requiresApproval) {
    const pending = { ...state, status: "approval_required" as const, pendingCall: call };
    await publish(deps, pending);
    return pending;
  }
  const executing = { ...state, status: "executing" as const, pendingCall: call };
  await publish(deps, executing);
  const raw = await deps.invoke(call, callKey, deps.signal);
  await assertActive(deps);
  if (isDeferredToolApproval(raw)) {
    const pending = {
      ...executing,
      status: "approval_required" as const,
      round: 1,
      callCount: executing.callCount + 1,
      completedCallKeys: [...executing.completedCallKeys, callKey],
      pendingCall: raw.pendingCall,
    };
    await publish(deps, pending);
    return pending;
  }
  const sanitized = sanitizeToolResult({ catalog: deps.catalog, serverId: call.serverId, toolName: call.toolName, result: raw });
  const completed = {
    ...executing,
    status: "completed" as const,
    round: 1,
    callCount: executing.callCount + 1,
    completedCallKeys: [...executing.completedCallKeys, callKey],
    results: [...executing.results, sanitized],
    pendingCall: undefined,
  };
  await publish(deps, completed);
  return completed;
}

async function resumeAuthorizedPendingCall(
  taskId: string,
  deps: ToolTaskDeps,
  state: ToolTaskCheckpoint,
  call: PlannedToolCall,
): Promise<ToolTaskCheckpoint> {
  await assertActive(deps);
  const argsHash = await canonicalArgsHash(call.args);
  const callKey = `${taskId}:${call.serverId}:${call.toolName}:${argsHash}`;
  const decision = await taskPolicy(deps, call);
  if (!decision.ok) throw new Error(`policy_denied:${decision.code}`);
  if (decision.requiresApproval) {
    const pending = { ...state, status: "approval_required" as const, pendingCall: call };
    await publish(deps, pending);
    return pending;
  }
  const executing = { ...state, status: "executing" as const, pendingCall: call, error: undefined };
  await publish(deps, executing);
  const raw = await deps.invoke(call, callKey, deps.signal);
  await assertActive(deps);
  if (isDeferredToolApproval(raw)) {
    const pending = {
      ...executing,
      status: "approval_required" as const,
      callCount: executing.callCount + 1,
      completedCallKeys: [...new Set([...executing.completedCallKeys, callKey])],
      pendingCall: raw.pendingCall,
    };
    await publish(deps, pending);
    return pending;
  }
  const sanitized = sanitizeToolResult({ catalog: deps.catalog, serverId: call.serverId, toolName: call.toolName, result: raw });
  const resumed = {
    ...executing,
    status: deps.directCall ? "completed" as const : "planning" as const,
    callCount: executing.callCount + 1,
    completedCallKeys: [...new Set([...executing.completedCallKeys, callKey])],
    results: [...executing.results, sanitized],
    pendingCall: undefined,
  };
  await publish(deps, resumed);
  return deps.directCall ? resumed : executeToolTask(taskId, deps, resumed);
}

function taskPolicy(deps: ToolTaskDeps, call: PlannedToolCall): Promise<ToolPolicyDecision> {
  if (deps.evaluatePolicy) return deps.evaluatePolicy(call);
  return evaluateToolPolicy({
    catalog: deps.catalog,
    observedCatalog: deps.observedCatalog,
    allowlist: deps.allowlists.get(call.serverId) ?? [],
    serverId: call.serverId,
    toolName: call.toolName,
    args: call.args,
  });
}

export function isDeferredToolApproval(value: unknown): value is DeferredToolApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const deferred = value as Partial<DeferredToolApproval>;
  const call = deferred.pendingCall;
  return deferred.kind === "deferred_tool_approval" && Boolean(
    call &&
    typeof call.serverId === "string" &&
    typeof call.toolName === "string" &&
    call.args &&
    typeof call.args === "object" &&
    !Array.isArray(call.args),
  );
}

export function parseMcpToolResult(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") throw new Error("invalid_mcp_response");
  const response = payload as Record<string, unknown>;
  if (response.error) throw new Error(mcpToolErrorCode(response.error));
  const result = response.result as Record<string, unknown> | undefined;
  if (result?.isError === true) throw new Error("mcp_tool_error:is_error");
  return result ?? null;
}

function mcpToolErrorCode(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "mcp_tool_error";
  const error = value as Record<string, unknown>;
  const data = error.data && typeof error.data === "object" && !Array.isArray(error.data)
    ? error.data as Record<string, unknown>
    : null;
  // Preserve only machine codes. Provider messages can echo request content or
  // other sensitive material and must not cross the Agent -> Memory boundary.
  const candidate = data?.code ?? error.code;
  const code = typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120)
    : "";
  return code ? `mcp_tool_error:${code}` : "mcp_tool_error";
}

async function publish(deps: ToolTaskDeps, state: ToolTaskCheckpoint): Promise<void> {
  await assertActive(deps);
  deps.checkpoint(structuredClone(state));
}

async function assertActive(deps: ToolTaskDeps): Promise<void> {
  if (deps.signal.aborted || await deps.isCancelled()) throw new DOMException("Task cancelled", "AbortError");
}
