const EVENT_FIELDS: Record<string, readonly string[]> = {
  rpc: ["method", "streaming"],
  "rpc:error": ["method"],
  "fiber:run:started": ["fiberId", "fiberName", "managed"],
  "fiber:run:completed": ["fiberId", "fiberName", "elapsedMs", "managed"],
  "fiber:run:failed": ["fiberId", "fiberName", "elapsedMs", "managed"],
  "fiber:run:interrupted": ["fiberId", "fiberName", "elapsedMs", "managed", "recoveryReason"],
  "fiber:recovery:detected": ["fiberId", "fiberName", "elapsedMs", "managed", "recoveryReason"],
  "fiber:recovery:attempt": ["fiberId", "fiberName", "managed", "recoveryReason"],
  "fiber:recovery:handled": ["fiberId", "fiberName", "status", "elapsedMs", "managed"],
  "fiber:recovery:skipped": ["fiberId", "fiberName", "elapsedMs", "managed"],
  "fiber:recovery:failed": ["fiberId", "fiberName", "elapsedMs"],
  "agent_tool:recovery:begin": ["runCount", "totalTimeoutMs"],
  "agent_tool:recovery:row": ["runId", "agentType", "status", "elapsedMs"],
  "agent_tool:recovery:deadline": ["runId", "agentType", "elapsedMs"],
  "agent_tool:recovery:reattach": ["runId", "agentType", "budgetMs"],
  "agent_tool:recovery:complete": ["runCount", "elapsedMs"],
  "agent_tool:recovery:failed": [],
  "agent_tool:detached:delivery_failed": ["runId", "kind", "status"],
  "agent_tool:detached:live_count_warning": ["liveCount", "threshold"],
  "workflow:start": ["workflowId", "workflowName"],
  "workflow:event": ["workflowId", "eventType"],
  "workflow:approved": ["workflowId"],
  "workflow:rejected": ["workflowId"],
  "workflow:terminated": ["workflowId", "workflowName"],
  "workflow:paused": ["workflowId", "workflowName"],
  "workflow:resumed": ["workflowId", "workflowName"],
  "workflow:restarted": ["workflowId", "workflowName"],
  "mcp:client:preconnect": ["serverId"],
  "mcp:client:connect": ["transport", "state"],
  "mcp:client:authorize": ["serverId"],
  "mcp:client:discover": ["state", "capability"],
  "mcp:client:close": ["transport", "state", "phase"],
};

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SENSITIVE_MARKER = /(?:api[_-]?key|bearer|cookie|credential|password|passwd|private[_-]?key|secret|session|token)/i;
const SECRET_PREFIX = /^(?:cfpat-|ghp_|github_pat_|sk-|xox[a-z]-)/i;
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const LONG_OPAQUE_SEGMENT = /[A-Za-z0-9_-]{32,}/;

type SdkObservabilityEvent = {
  type: string;
  agent?: string;
  name?: string;
  timestamp: number;
  payload: unknown;
};

export type ProjectedSdkEvent = {
  eventType: string;
  target: string | null;
  detail: Record<string, unknown>;
};

export function projectSdkObservabilityEvent(event: SdkObservabilityEvent): ProjectedSdkEvent | null {
  const allowedFields = EVENT_FIELDS[event.type];
  if (!allowedFields) return null;

  const payload: Record<string, unknown> = isRecord(event.payload) ? event.payload : {};
  const safePayload: Record<string, unknown> = {};
  for (const key of allowedFields) {
    const value = payload[key];
    const safeValue = safeScalar(value);
    if (safeValue !== undefined) safePayload[key] = safeValue;
  }

  if (typeof payload.error === "string") safePayload.errorCode = safeErrorCode(payload.error);
  if (typeof payload.reason === "string") safePayload.reasonCode = safeErrorCode(payload.reason);
  const target = firstSafeIdentifier(payload.fiberId, payload.workflowId, payload.serverId, payload.runId, payload.method);

  return {
    eventType: `sdk.${event.type}`,
    target,
    detail: {
      agent: safeIdentifier(event.agent) ?? "unknown",
      instance: safeIdentifier(event.name) ?? "unknown",
      sdkTimestamp: safeTimestamp(event.timestamp),
      ...safePayload,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return safeIdentifier(value) ?? undefined;
  return undefined;
}

function safeErrorCode(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (/(?:timeout|timed_out|deadline)/.test(normalized)) return "timeout";
  if (/(?:abort|cancel)/.test(normalized)) return "cancelled";
  if (/(?:interrupt|evict|recover)/.test(normalized)) return "interrupted";
  if (/(?:rate.?limit|quota)/.test(normalized)) return "rate_limited";
  if (/(?:unauthori[sz]ed|forbidden|permission)/.test(normalized)) return "permission_denied";
  if (/(?:not.?found|missing)/.test(normalized)) return "not_found";
  if (/(?:network|connection|socket|fetch)/.test(normalized)) return "network_error";
  return "sdk_error";
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) return null;
  if (SENSITIVE_MARKER.test(value) || SECRET_PREFIX.test(value) || JWT_SHAPE.test(value) || LONG_OPAQUE_SEGMENT.test(value)) return null;
  return value;
}

function safeTimestamp(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function firstSafeIdentifier(...values: unknown[]): string | null {
  for (const value of values) {
    const safeValue = safeIdentifier(value);
    if (safeValue) return safeValue;
  }
  return null;
}
