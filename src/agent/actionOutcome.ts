import { byteLengthOf } from "./toolCatalog";
import type { PlannedToolCall, SanitizedToolResult, ToolTaskCheckpoint } from "./types";

export type ActionOutcome = "action_denied" | "action_expired";

export function createActionOutcomeResult(
  call: Pick<PlannedToolCall, "toolName">,
  outcome: ActionOutcome,
  reason: string,
): SanitizedToolResult {
  const payload = JSON.stringify({
    ok: false,
    outcome,
    reason,
    executed: false,
    retryable: false,
  });
  const bytes = byteLengthOf(payload);
  return {
    kind: "untrusted_tool_result",
    toolName: call.toolName,
    mimeType: "application/json",
    note: "System policy outcome. The requested external action was not executed.",
    warnings: ["action_not_executed"],
    payload,
    payloadBytes: bytes,
    sourceBytes: bytes,
    truncated: false,
    resultStatus: "serializable",
  };
}

export function applyActionOutcomeToCheckpoint(
  checkpoint: ToolTaskCheckpoint,
  callKey: string,
  result: SanitizedToolResult,
  direct: boolean,
): ToolTaskCheckpoint {
  return {
    ...checkpoint,
    status: direct ? "completed" : "interrupted",
    pendingCall: undefined,
    error: undefined,
    callCount: checkpoint.callCount + 1,
    completedCallKeys: checkpoint.completedCallKeys.includes(callKey)
      ? checkpoint.completedCallKeys
      : [...checkpoint.completedCallKeys, callKey],
    results: [...checkpoint.results, result],
  };
}
