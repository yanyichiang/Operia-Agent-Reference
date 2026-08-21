export type OperiaApprovalContinuationPins = {
  thinkTaskId: string;
  agentCallKey: string;
  argsHash: string;
  schemaHash: string;
  policyVersion: string;
  pauseGeneration: number;
};

const SAFE_TASK = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const SAFE_CALL_KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function approvalContinuationPins(
  presentation: Record<string, unknown>,
): OperiaApprovalContinuationPins | null {
  const thinkTaskId = typeof presentation.thinkTaskId === "string" ? presentation.thinkTaskId : "";
  const agentCallKey = typeof presentation.agentCallKey === "string" ? presentation.agentCallKey : "";
  const argsHash = typeof presentation.argsHash === "string" ? presentation.argsHash : "";
  const schemaHash = typeof presentation.schemaHash === "string" ? presentation.schemaHash : "";
  const policyVersion = typeof presentation.policyVersion === "string" ? presentation.policyVersion : "";
  const pauseGeneration = presentation.pauseGeneration;
  if (!SAFE_TASK.test(thinkTaskId) || !SAFE_CALL_KEY.test(agentCallKey) || !SHA256.test(argsHash)
    || !SHA256.test(schemaHash) || !policyVersion || policyVersion.length > 240
    || !Number.isSafeInteger(pauseGeneration) || Number(pauseGeneration) < 0) return null;
  return { thinkTaskId, agentCallKey, argsHash, schemaHash, policyVersion, pauseGeneration: Number(pauseGeneration) };
}

export function requireApprovalContinuationPins(
  approval: Partial<OperiaApprovalContinuationPins>,
): OperiaApprovalContinuationPins {
  const pins = approvalContinuationPins(approval as Record<string, unknown>);
  if (!pins) throw new Error("operia_think_approval_continuation_pins_required");
  return pins;
}

export function approvalPinsForMode(
  presentation: Record<string, unknown>,
  continuationEnabled: boolean,
): OperiaApprovalContinuationPins | null {
  const pins = approvalContinuationPins(presentation);
  if (pins) return pins;
  const completeLegacyAbsence = presentation.thinkTaskId === ""
    && presentation.agentCallKey === ""
    && presentation.argsHash === ""
    && presentation.schemaHash === ""
    && presentation.policyVersion === ""
    && presentation.pauseGeneration === -1;
  if (!continuationEnabled && completeLegacyAbsence) return null;
  throw new Error(continuationEnabled
    ? "operia_think_approval_continuation_pins_required"
    : "operia_think_approval_partial_pins_invalid");
}
