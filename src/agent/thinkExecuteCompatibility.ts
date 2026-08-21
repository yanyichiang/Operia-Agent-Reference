export type ThinkExecuteIdentityEnvelope =
  | { kind: "legacy"; requestId: string }
  | { kind: "modern"; requestId: string; thinkTaskId: string; agentCallKey: string }
  | { kind: "invalid"; error: "think_call_identity_invalid" };

const SAFE_REQUEST = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SAFE_TASK = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;

export function classifyThinkExecuteIdentityEnvelope(body: Record<string, unknown>): ThinkExecuteIdentityEnvelope {
  const requestId = typeof body.requestId === "string" && SAFE_REQUEST.test(body.requestId) ? body.requestId : null;
  const hasThinkTaskId = Object.prototype.hasOwnProperty.call(body, "thinkTaskId");
  const hasAgentCallKey = Object.prototype.hasOwnProperty.call(body, "agentCallKey");
  if (!requestId || hasThinkTaskId !== hasAgentCallKey) return { kind: "invalid", error: "think_call_identity_invalid" };
  if (!hasThinkTaskId) return { kind: "legacy", requestId };
  const thinkTaskId = typeof body.thinkTaskId === "string" && SAFE_TASK.test(body.thinkTaskId) ? body.thinkTaskId : null;
  const agentCallKey = typeof body.agentCallKey === "string" && SAFE_REQUEST.test(body.agentCallKey) ? body.agentCallKey : null;
  if (!thinkTaskId || !agentCallKey || requestId !== agentCallKey) {
    return { kind: "invalid", error: "think_call_identity_invalid" };
  }
  return { kind: "modern", requestId, thinkTaskId, agentCallKey };
}
