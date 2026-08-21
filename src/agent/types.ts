export type CapabilityStatus = "enabled" | "disabled";

export type CapabilityDefinition = {
  id: string;
  domain: "runtime" | "harness" | "tools" | "security" | "channel" | "observability";
  label: string;
  description: string;
  defaultStatus: CapabilityStatus;
  configurable: boolean;
};

export type CapabilityConfig = Record<string, CapabilityStatus>;

export type RuntimeState = {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  capabilities: CapabilityConfig;
  capabilityRevisions?: Record<string, number>;
  browserDomainAllowlist?: string[];
  browserDomainAllowlistRevision?: number;
  browserDomainDenylist?: string[];
  browserDomainDenylistRevision?: number;
  initializedAt: string;
  updatedAt: string;
};

export type AgentEnv = {
  AGENT_ADMIN_BEARER?: string;
  AGENT_DASHBOARD_SERVICE_BEARER?: string;
  AGENT_CONTEXT_SERVICE_BEARER?: string;
  AGENT_APPROVAL_SERVICE_BEARER?: string;
  AGENT_THINK_SERVICE_BEARER?: string;
  AGENT_CONTEXT_OWNER_ID?: string;
  AGENT_CONTEXT_SERVICE_ID?: string;
  AGENT_MEMORY_MCP_BEARER?: string;
  MEMORY_GATEWAY_BROKER_BEARER?: string;
  MEMORY_CONTROL_SERVICE_BEARER?: string;
  MCP_GATEWAY_OWNER_BEARER?: string;
  MCP_GATEWAY_EXECUTOR_BEARER?: string;
  SKILL_REGISTRY_ALLOWLIST?: string;
  AGENT_DELEGATED_TOOL_ALLOWLIST?: string;
  AI: Ai;
  MEMORY_MCP: Fetcher;
  MCP_GATEWAY: Fetcher;
  HEALTH_SERVICE?: Fetcher;
  HEALTH_SERVICE_BEARER?: string;
  HEALTH_ENABLED?: string;
  CALENDAR_SERVICE?: Fetcher;
  CALENDAR_SERVICE_BEARER?: string;
  NOTE_SERVICE?: Fetcher;
  NOTE_SERVICE_BEARER?: string;
  APPROVAL_WORKFLOW: Workflow<{ ticketId: string; runtimeName: string; nonce: string }>;
  OPERIA_SESSION_SECRET?: string;
  ADMIN_EMAIL_ALLOWLIST?: string;
  XAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  GROK_ENABLED?: string;
  VOICE_ENABLED?: string;
  MINIMAX_VOICE_ENABLED?: string;
  MINIMAX_VOICE_CLONE_ENABLED?: string;
  MINIMAX_VOICE_DAILY_BUDGET_MICRO_USD?: string;
  HOME_ASSISTANT_ENABLED?: string;
  HOME_ASSISTANT_BASE_URL?: string;
  HOME_ASSISTANT_ACCESS_TOKEN?: string;
  HOME_ASSISTANT_ENTITY_ALLOWLIST?: string;
  HOME_ASSISTANT_SERVICE_ALLOWLIST?: string;
  ELEVENLABS_DEFAULT_VOICE_ID?: string;
  PROVIDER_TIMEOUT_MS?: string;
  TOOL_PLANNER_MODEL?: string;
  TOOL_PLANNER_DAILY_BUDGET?: string;
  BROWSER?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    quickAction(action: string, options: unknown): Promise<Response>;
  };
  LOADER?: WorkerLoader;
  BROWSER_ENABLED?: string;
  BROWSER_INTERACTIVE_ENABLED?: string;
  BROWSER_TASK_LEASES_ENABLED?: string;
  TASK_PROGRESS_ENABLED?: string;
  AGENT_TOOL_ROUTER_V2_ENABLED?: string;
  AGENT_THINK_GATEWAY_ENABLED?: string;
  AGENT_THINK_ACTIONS_ENABLED?: string;
  AGENT_THINK_APPROVAL_PROBE_ENABLED?: string;
  AGENT_POLICY_V3_SHADOW_ENABLED?: string;
  AGENT_POLICY_V3_ENFORCE?: string;
  AGENT_SANDBOX_ENABLED?: string;
  AGENT_SANDBOX_P2_READ_ENABLED?: string;
  AGENT_CODEMODE_ENABLED?: string;
  AGENT_CODEMODE_V2_ENABLED?: string;
  AGENT_CODE_WORKSPACE_ENABLED?: string;
  AGENT_CODE_INSPECT_ENABLED?: string;
  AGENT_SELF_MANAGE_WRITE_ENABLED?: string;
  AGENT_SANDBOX_QA_CHAT_ID?: string;
  AGENT_SANDBOX_QA_THREAD_KEY?: string;
  AGENT_SANDBOX_CANARY_ENABLED?: string;
  AGENT_SANDBOX_CANARY_DELAY_MS?: string;
  AGENT_SANDBOX_RUNTIME_NAME?: string;
  SANDBOX_CAPABILITY_SIGNING_SECRET?: string;
  SANDBOX_TRANSPORT?: string;
  OPERIA_SANDBOX?: DurableObjectNamespace;
  BROWSER_DOMAIN_ALLOWLIST?: string;
  BROWSER_QA_FIXTURE_HOST?: string;
  BROWSER_DAILY_BUDGET_MS?: string;
  HOOKS_ENABLED?: string;
  AGENT_HOOK_WEBHOOK_SECRET?: string;
  HEARTBEAT_ENABLED?: string;
  HEARTBEAT_INTERVAL_SECONDS?: string;
  AGENT_HTML_ARTIFACTS_ENABLED?: string;
  AGENT_INTERACTIVE_ARTIFACTS_ENABLED?: string;
  AGENT_RESULT_CAPSULE_ENABLED?: string;
  MEDIA: R2Bucket;
  SOURCE_SNAPSHOTS?: R2Bucket;
};

export type DelegatedTaskStatus =
  | "accepted"
  | "planning"
  | "executing"
  | "approval_required"
  | "attention_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused"
  | "interrupted";

type BaseTaskInput = ContextScope & {
  taskId: string;
  idempotencyKey: string;
  capsuleId: string;
  rootTaskId?: string;
  parentTaskId?: string;
  thinkTaskId?: string;
  agentCallKey?: string;
};

export type DelegatedTaskInput = BaseTaskInput & {
  mode?: "delegated";
  instruction: string;
} | BaseTaskInput & {
  mode: "direct";
  instruction: string;
  directCall: PlannedToolCall;
};

export type PlannedToolCall = {
  serverId: string;
  toolName: string;
  args: JsonValue;
};

export type ToolTaskCheckpoint = {
  taskId: string;
  status: DelegatedTaskStatus;
  round: number;
  callCount: number;
  completedCallKeys: string[];
  results: SanitizedToolResult[];
  pendingCall?: PlannedToolCall;
  error?: string;
};

export type DeferredToolApproval = {
  kind: "deferred_tool_approval";
  pendingCall: PlannedToolCall;
};

export type RiskLevel = "read" | "write" | "device" | "message" | "purchase" | "delete";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ToolSchema = boolean | { [key: string]: unknown };

export type ContextReferenceKind = "memory" | "artifact" | "tool_result";

export type ContextReference = {
  handle: string;
};

export type ContextScope = {
  namespace: string;
  chatId: string;
  taskId: string;
  recipient: string;
  purpose: string;
  requestHash: string;
  ownerId: string;
  serviceId: string;
};

export type ContextHandleInput = ContextScope & {
  kind: ContextReferenceKind;
  checksum: string;
  ttlMs: number;
  serverNow: Date;
};

export type ContextHandleRecord = ContextScope & {
  handle: string;
  kind: ContextReferenceKind;
  checksum: string;
  createdAt: string;
  expiresAt: string;
};

export type ContextHandleResolutionInput = ContextScope & {
  serverNow: Date;
};

export type ContextCapsuleInput = ContextScope & {
  ttlMs: number;
  maxBytes: number;
  refs: ReadonlyArray<ContextReference>;
  serverNow: Date;
};

export type ContextCapsule = {
  capsuleId: string;
  namespace: string;
  chatId: string;
  taskId: string;
  recipient: string;
  purpose: string;
  requestHash: string;
  ownerId: string;
  serviceId: string;
  createdAt: string;
  expiresAt: string;
  maxBytes: number;
  totalBytes: number;
  truncated: boolean;
  refs: ContextReference[];
};

export type ContextCapsuleResolutionInput = ContextScope & {
  serverNow: Date;
};

export type ContextCapsuleResolutionResult =
  | { ok: true; capsule: ContextCapsule }
  | { ok: false; code: "capsule_scope_mismatch" | "capsule_expired" | "invalid_server_clock" };

export type ToolCatalogEntryInput = {
  serverId: string;
  toolName: string;
  description?: string;
  riskLevel: RiskLevel;
  inputSchema: ToolSchema;
  outputByteLimit?: number;
  enabled: boolean;
};

export type ToolCatalogEntry = {
  catalogVersion: 2;
  serverId: string;
  toolName: string;
  catalogKey: string;
  description: string;
  riskLevel: RiskLevel;
  inputSchema: ToolSchema;
  schemaHash: string;
  outputByteLimit: number;
  enabled: boolean;
};

export type ToolPolicyRequest = {
  catalog: ReadonlyArray<unknown>;
  observedCatalog: ReadonlyArray<unknown>;
  allowlist: ReadonlyArray<string>;
  serverId?: string;
  toolName: string;
  args: unknown;
  policyVersion?: string;
};

export type ToolPolicyDecision =
  | {
      ok: true;
      code: "allowed" | "approval_required";
      requiresApproval: boolean;
      argsHash: string;
      riskLevel: RiskLevel;
      policyVersion: string;
      tool: ToolCatalogEntry;
    }
  | {
      ok: false;
      code:
        | "empty_allowlist"
        | "unknown_tool"
        | "tool_not_allowlisted"
        | "unknown_risk"
        | "schema_drift"
        | "unsupported_schema"
        | "invalid_arguments";
      argsHash: string;
      policyVersion: string;
    };

export type SanitizeToolResultInput = {
  catalog: ReadonlyArray<unknown>;
  serverId?: string;
  toolName: string;
  result: unknown;
};

export type SanitizedToolResult = {
  kind: "untrusted_tool_result";
  toolName: string;
  mimeType: "application/json" | "text/plain";
  note: string;
  warnings: string[];
  payload: string;
  payloadBytes: number;
  sourceBytes: number;
  truncated: boolean;
  resultStatus: "serializable" | "unserializable";
};

export type McpRegistryInput = {
  id?: string;
  name: string;
  url: string;
  enabled?: boolean;
  riskLevel?: RiskLevel;
  toolAllowlist?: string[];
  authReference?: string | null;
  tools?: ToolCatalogEntryInput[];
};
