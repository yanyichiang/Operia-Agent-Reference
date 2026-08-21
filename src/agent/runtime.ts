import { Agent, type Connection, type FiberRecoveryContext, type FiberRecoveryResult } from "agents";
import { CAPABILITY_REGISTRY, capabilitySnapshot, defaultCapabilityConfig } from "./capabilities";
import { canonicalArgsHash, createContextCapsule, createContextHandle, resolveContextCapsule, resolveIssuedContextReferences } from "./contextBroker";
import { evaluateToolPolicy, sanitizeToolResult } from "./policy";
import { evaluatePolicyV3Shadow } from "./policyV3Shadow";
import { matchesThinkApprovalTaskGrant, type ThinkApprovalGrantPins } from "./thinkApprovalGrant";
import { classifyThinkExecuteIdentityEnvelope } from "./thinkExecuteCompatibility";
import { applyActionOutcomeToCheckpoint, createActionOutcomeResult, type ActionOutcome } from "./actionOutcome";
import { bearerAuthorized, json, readJsonObject, redact } from "./security";
import { assertJsonValue, canonicalJson, safeSerializeForDisplay } from "../utils/json";
import {
  createToolCatalogEntry,
  createToolCatalogSnapshotV3,
  describeToolV3,
  normalizeToolAllowlist,
  parseToolCatalog,
  searchToolCatalogV3,
  sha256Hex,
  toolCatalogNeedsRefresh,
  type ToolDescriptionV3,
  type ToolCatalogSnapshotV3,
} from "./toolCatalog";
import { DEFAULT_TOOL_PLANNER_DAILY_BUDGET, filterExplicitToolAllowlist, GLM_TOOL_MODEL, MAX_CONTINUATION_ROUNDS, MAX_TOOL_CALLS, type ToolPlannerTelemetry } from "./toolPlanner";
import { ActiveTaskCalls, assertTaskResultActive } from "./taskCancellation";
import { encodeApprovalCallback, encodeBrowserDomainCallback, newApprovalNonce, newApprovalTicketId, validateApprovalBinding, type ApprovalTicketRecord, type BrowserDomainDecisionAction } from "./approval";
import { resolveApprovalDecision } from "./approvalDecision";
import { decideFiberAttachment, deriveObservedCatalogInputs, executeToolTask, mapRecoveredCheckpoint, normalizeRecoveredCheckpoint, parseMcpToolResult, parseMcpToolsListResponse, repairFiberKey, requestedCatalogServerId } from "./taskRuntime";
import {
  classifyProviderResult,
  decodeProviderResultReceipt,
  encodeProviderResultReceipt,
  lookupProviderReplayContract,
  parseRetrySafetyProof,
  receiptToTaskResult,
  retrySafetyAllowsRetry,
  sideEffectReplayDecision,
  type RetrySafetyProof,
} from "./toolSideEffectState";
import {
  authorizeRetry,
  authorizeServerSideContinuation,
  claimProviderAttempt,
  loadReplayState,
  markAllStartedOutcomeUnknown,
  markAwaitingInputExpired,
  markClosedWithoutRetry,
  markDefinitiveFailure,
  markDeferred,
  markOutcomeUnknown,
  normalizeInFlightQuarantineForReconciliation,
  persistRetryAuthority,
  persistTerminalReceipt,
  quarantineInFlight,
  quarantinePreservingReceipt,
  reserveLogicalInvocation,
  type SideEffectSql,
} from "./toolSideEffectRepository";
import { createProviderRegistry, ProviderError } from "./providers";
import { BROWSER_FREE_DAILY_BUDGET_MS, BROWSER_FREE_MIN_INTERVAL_MS, executeBrowserQuickAction, parseBrowserDomainAllowlist, type BrowserQuickActionName } from "./browserQuickActions";
import { applyBrowserAllowlistMutation, mergeBrowserDomainInputs, normalizeBrowserDomainInput } from "./browserAllowlistControl";
import { evaluateBrowserDomainPolicy } from "./browserDomainPolicy";
import {
  allowedActionsForMode,
  browserActionRecoveryDecision,
  selectBrowserSiteProfile,
  validateBrowserLeaseAction,
  type BrowserActionDescriptor,
  type BrowserInteractionMode,
  type BrowserSiteProfile,
  type BrowserTaskLease,
} from "./browserTaskLease";
import { compileBrowserTypedAction, validateBrowserTypedTaskInput, type BrowserTypedTaskInput } from "./browserTypedTask";
import {
  BROWSER_INTERACTIVE_KEEP_ALIVE_MS,
  createInteractiveBrowserRuntime,
  isInteractiveBrowserSessionExpired,
  sanitizeBrowserEvidenceForPersistence,
  validateInteractiveBrowserInput,
  type InteractiveBrowserMode,
} from "./browserInteractive";
import { createToolResultCacheKey, createToolResultCacheRecord, hashToolResultCacheSource, resolveToolResultCacheRecord, TOOL_RESULT_CACHE_SCHEMA_VERSION, type ToolResultCacheKeyInput, type ToolResultCacheRecord } from "./toolCache";
import { AgentHookRegistry, normalizeAgentHookDefinition, type AgentHookDefinition, type AgentHookEvent } from "./hooks";
import { createDefaultSiteAdapterRegistry, createDefaultSkillsRegistry } from "./controlCatalogs";
import { createSkillRegistryEntry, resolveSkillRegistryEntry, validateSkillInput, type SkillRegistryEntry } from "./skillsRegistry";
import { advanceSkillRun, createSkillRun, type SkillRunState } from "./skillRuns";
import { fingerprintPublisherKey, verifyCommunitySkillTrust, type CommunitySkillEnvelope } from "./skillTrust";
import { evaluateSiteAdapterExecution } from "./siteAdapters";
import { createRemoteMcpClient } from "./remoteMcp";
import { CONTROL_TOPOLOGY, agentControlProjection, controlManifestFor } from "../controlRegistry";
import {
  THINK_APPROVAL_PROBE_INTENT,
  THINK_APPROVAL_PROBE_SERVER_ID,
  THINK_APPROVAL_PROBE_TOOL_NAME,
} from "../thinkApprovalProbe";
import { createGrokGatewayFetch } from "./grokGatewayFetch";
import {
  DEFAULT_HEARTBEAT_CONFIG,
  applyRealActivity,
  filterHeartbeatTools,
  initialHeartbeatRuntime,
  normalizeHeartbeatConfig,
  pulseDue,
  qualifiesAsRealActivity,
  resolveHeartbeatActivationMode,
  rollHeartbeatDay,
  warmDue,
  type HeartbeatConfig,
  type HeartbeatRuntime,
} from "./heartbeat";
import { hashMcpGatewayOwnerSnapshot, parseMcpGatewayOwnerSnapshot } from "./mcpGatewayRegistry";
import { createOperiaObservability } from "./agentObservability";
import { callStandardMcpTool, listStandardMcpTools, probeStandardMcpProvider } from "./standardMcpClient";
import {
  artifactBundleObjectKey,
  HTML_ARTIFACT_RETENTION_MS,
  HTML_ARTIFACT_STATE_MAX_BYTES,
  HTML_ARTIFACT_TOTAL_STATE_MAX_BYTES,
  htmlArtifactKindEnabled,
  scanHtmlArtifact,
  type HtmlArtifactKind,
  type HtmlArtifactSensitivity,
} from "./htmlArtifacts";
import {
  encodeMcpElicitationCallback,
  MCP_ELICITATION_HISTORY_MS,
  MCP_ELICITATION_TTL_MS,
  mcpElicitationExpired,
  newMcpElicitationTicketId,
  normalizeMcpElicitation,
  validateMcpElicitationDecision,
  type McpElicitationAction,
  type McpElicitationRequest,
} from "./mcpElicitation";
import { createOperiaReadCodeMode } from "./sandboxCodeMode";
import { renderMusicSharePoster, type MusicPosterVariant } from "./presentation/artifacts/musicSharePoster";
import { executeSourceWorkspaceRead } from "./sourceWorkspace";
import {
  createOperiaGeneralReadCodeMode,
  type OperiaCodeModeAudit,
  type OperiaCodeModePreflight,
  type OperiaCodeModeReceipt,
  type OperiaCodeModeRequest,
} from "./operiaCodeMode";
import {
  codeModeInnerReplayPolicy,
  codeModeLeaseExpiry,
  decideCodeModeExecution,
  decideCodeModeInnerCall,
  deriveCodeModeExecutionTaskId,
  deriveCodeModeInnerTaskId,
  deriveCodeModeSandboxTaskId,
  type OperiaCodeModeExecutionIdentity,
  type OperiaCodeModeExecutionRow,
  type OperiaCodeModeInnerCallRow,
} from "./codemodeDurability";
import { execute<Sandbox>Script, type SandboxWorkerEnv } from "./sandboxRuntime";
import { verifySandboxCapability, type SandboxCapabilityScope } from "./sandboxCapability";
import {
  OPERIA_OWNER_MAX_BYTES,
  OPERIA_OWNER_MAX_RESOURCES,
  OPERIA_TEST_NAMESPACE,
  OPERIA_TOMBSTONE_RETENTION_MS,
  appendOperiaResourceValue,
  evaluateOperiaReclaim,
  normalizeOperiaMutationEnvelope,
  normalizeOperiaResourceId,
  normalizeOperiaResourceType,
  operiaUndoSummary,
  serializeOperiaResourceValue,
} from "./sandboxPolicy";
import type {
  AgentEnv,
  ContextCapsule,
  ContextCapsuleInput,
  ContextCapsuleResolutionInput,
  ContextHandleRecord,
  ContextScope,
  DelegatedTaskInput,
  DeferredToolApproval,
  McpRegistryInput,
  JsonValue,
  RiskLevel,
  RuntimeState,
  ToolCatalogEntryInput,
  ToolCatalogEntry,
  ToolTaskCheckpoint,
  ToolSchema,
} from "./types";

type CountRow = { count: number };
type RuntimeRow = Record<string, string | number | null>;
type ContextCapsuleRow = {
  id: string;
  namespace: string;
  chat_id: string;
  task_id: string;
  recipient: string;
  purpose: string;
  request_hash: string;
  owner_id: string;
  service_id: string;
  created_at: string;
  expires_at: string;
  max_bytes: number;
  total_bytes: number;
  truncated: number;
  refs_json: string;
};
type ContextHandleRow = {
  handle: string;
  kind: string;
  checksum: string;
  namespace: string;
  chat_id: string;
  task_id: string;
  recipient: string;
  purpose: string;
  request_hash: string;
  owner_id: string;
  service_id: string;
  created_at: string;
  expires_at: string;
};
type BrowserExecutionRow = {
  execution_id: string;
  task_id: string;
  runtime_name: string;
  mode: InteractiveBrowserMode;
  session_key: string;
  domains_json: string;
  recording: number;
  status: string;
  pending_json: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
};
type BrowserSiteProfileRow = {
  id: string;
  label: string;
  primary_hosts_json: string;
  redirect_hosts_json: string;
  maximum_mode: BrowserInteractionMode;
  allowed_actions_json: string;
  revision: number;
  enabled: number;
  created_at: string;
  updated_at: string;
};
type BrowserTaskLeaseRow = {
  id: string;
  task_id: string;
  owner_id: string;
  service_id: string;
  channel_ref: string;
  site_profile_id: string;
  site_profile_revision: number;
  mode: BrowserInteractionMode;
  allowed_hosts_json: string;
  allowed_actions_json: string;
  max_logical_steps: number;
  used_logical_steps: number;
  deadline_at: string;
  instruction_hash: string;
  state: BrowserTaskLease["state"];
  revision: number;
  step_once: number;
  session_key: string;
  runtime_name: string;
  execution_id: string | null;
  created_at: string;
  updated_at: string;
};
type BrowserActionCheckpointRow = {
  task_id: string;
  action_index: number;
  action_kind: string;
  logical_step_cost: number;
  mutating: number;
  state: "started" | "completed" | "attention_required";
  attempt_count: number;
  result_json: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
};
type ApprovalTicketRow = {
  id: string; status: ApprovalTicketRecord["status"]; owner_id: string; chat_id: string; task_id: string;
  approval_round: number;
  think_task_id: string | null; agent_call_key: string | null; schema_hash: string | null; pause_generation: number | null;
  server_id: string; tool_name: string; args_json: string; args_hash: string; policy_version: string;
  expires_at: string; nonce: string; workflow_id: string; preview_json: string; review_json: string | null;
  decision_action: string | null; decision_scope: string | null; decision_owner_id: string | null; decision_chat_id: string | null;
  attention_error: string | null;
};
type McpElicitationTicketRow = {
  id: string; task_id: string; call_key: string; owner_id: string; service_id: string; chat_id: string;
  provider_id: string; tool_name: string; mode: "form" | "url"; request_hash: string;
  request_json: string; status: string; decision_json: string | null; expires_at: string;
  created_at: string; decided_at: string | null; consumed_at: string | null;
};
type McpElicitationResumeIntentRow = {
  ticket_id: string; task_id: string; call_key: string; status: string;
  generation: number; fiber_id: string | null; error_code: string | null;
  created_at: string; updated_at: string;
};
type BrowserDomainChallengeRow = {
  id: string; task_id: string; owner_id: string; service_id: string; chat_id: string;
  source_host: string | null; target_hosts_json: string; call_json: string; args_hash: string;
  status: string; decision_scope: string | null; expires_at: string; created_at: string;
  updated_at: string; decided_at: string | null;
};
type BrowserDomainGrantRow = {
  id: string; task_id: string; owner_id: string; chat_id: string; hostname: string;
  scope: string; status: string; uses_remaining: number | null; expires_at: string;
  created_at: string; updated_at: string;
};
type ToolCacheRow = {
  cache_key: string; scope_hash: string; request_hash: string; provider_hash: string; tool_hash: string;
  schema_hash: string; schema_version: number; result_json: string; created_at: number; expires_at: number;
};
type HtmlArtifactRow = {
  artifact_id: string;
  version: number;
  parent_version: number | null;
  owner_id: string;
  title: string;
  kind: HtmlArtifactKind;
  status: "ready" | "blocked" | "expired" | "deleted";
  content_hash: string;
  bundle_object_key: string | null;
  bundle_bytes: number;
  state_revision: number;
  sensitivity: HtmlArtifactSensitivity;
  task_id: string | null;
  source_item_id: string | null;
  session_id: string | null;
  creator_type: "opus" | "owner";
  creator_model: string | null;
  scan_policy_version: string;
  blocked_category: string | null;
  created_at: string;
  expires_at: string;
};

const TERMINAL_JOB_STATES = new Set(["completed", "failed", "cancelled"]);
const TELEGRAM_DENY_ONLY_CAPABILITIES = new Set(["agent.heartbeat", "tools.hooks", "tools.browser"]);
const RISK_LEVELS = new Set<RiskLevel>(["read", "write", "device", "message", "purchase", "delete"]);
const CURRENT_MEMORY_MCP_SERVER_ID = "<MEMORY_SERVICE>";
const OBSERVER_MCP_SERVER_ID = "operia-observer";
const GROK_PROVIDER_SERVER_ID = "grok";
const VOICE_PROVIDER_SERVER_ID = "voice";
const HOME_ASSISTANT_PROVIDER_SERVER_ID = "home-assistant";
const BROWSER_PROVIDER_SERVER_ID = "browser";
const HTML_ARTIFACT_PROVIDER_SERVER_ID = "html-artifact";
const HEALTH_PROVIDER_SERVER_ID = "health";
const CALENDAR_PROVIDER_SERVER_ID = "calendar";
const APPROVAL_PROBE_PROVIDER_SERVER_ID = THINK_APPROVAL_PROBE_SERVER_ID;
const SANDBOX_RUNTIME_PROVIDER_SERVER_ID = "sandbox-runtime";
const SANDBOX_CODEMODE_PROVIDER_SERVER_ID = "sandbox-codemode";
const SOURCE_CODE_PROVIDER_SERVER_ID = "source-code";
const BROWSER_SCHEMA_V6_SEED_DOMAINS = ["ojts.com"] as const;
const TASK_PROGRESS_SCHEMA_VERSION = 1;
const canonicalJsonStringify = (value: unknown): string => canonicalJson(assertJsonValue(value));
const EXECUTABLE_PROVIDER_SERVER_IDS = new Set([OBSERVER_MCP_SERVER_ID, GROK_PROVIDER_SERVER_ID, VOICE_PROVIDER_SERVER_ID, HOME_ASSISTANT_PROVIDER_SERVER_ID, BROWSER_PROVIDER_SERVER_ID, HTML_ARTIFACT_PROVIDER_SERVER_ID, HEALTH_PROVIDER_SERVER_ID, CALENDAR_PROVIDER_SERVER_ID, APPROVAL_PROBE_PROVIDER_SERVER_ID, SANDBOX_RUNTIME_PROVIDER_SERVER_ID, SANDBOX_CODEMODE_PROVIDER_SERVER_ID, SOURCE_CODE_PROVIDER_SERVER_ID]);
const FORBIDDEN_DELEGATED_SERVER_IDS = new Set([CURRENT_MEMORY_MCP_SERVER_ID]);
const AGENT_OWNED_MCP_SERVER_IDS = new Set([CURRENT_MEMORY_MCP_SERVER_ID, ...EXECUTABLE_PROVIDER_SERVER_IDS]);
const MCP_GATEWAY_PROBE_TTL_SECONDS = 60 * 60;
// These built-in providers expose data lookup only. Provider trust/cost risk
// remains separate from side-effect risk, so metered reads stay discoverable
// while billing/confirmation is still enforced by the Think action gate.
const MCP_GATEWAY_DATA_READ_TOOL_KEYS = new Set([
  "google-maps/google_maps_places_search",
  "google-maps/google_maps_place_details",
  "google-maps/google_maps_directions",
  "google-maps/google_maps_distance_matrix",
]);

function boundedAgentErrorCode(value: unknown, fallback = "agent_operation_failed"): string {
  const message = value instanceof Error ? value.message : String(value);
  const token = message.toLowerCase().match(
    /^(?:agent|mcp|tool|browser|skill|approval|workflow|provider|task|fiber|hook|cache|policy|uncertain|concurrent|sandbox|operia|codemode|calendar|source)_[a-z0-9_]+/
  )?.[0];
  return token?.slice(0, 120) ?? fallback;
}

function shortDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OperiaAgentRuntime extends Agent<AgentEnv, RuntimeState> {
  private readonly activeToolCalls = new ActiveTaskCalls();
  override observability = createOperiaObservability((event) => {
    try {
      this.audit(event.eventType, "cloudflare:agents-sdk", event.target, event.detail);
    } catch (error) {
      console.warn("Agent SDK audit projection unavailable", error instanceof Error ? error.message : "unknown");
    }
  });
  initialState: RuntimeState = {
    schemaVersion: 3,
    capabilities: defaultCapabilityConfig(),
    capabilityRevisions: {},
    initializedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };

  async onStart(): Promise<void> {
    this.sql`CREATE TABLE IF NOT EXISTS mcp_registry (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      risk_level TEXT NOT NULL DEFAULT 'read', tool_allowlist_json TEXT NOT NULL DEFAULT '[]',
      tool_catalog_json TEXT NOT NULL DEFAULT '[]',
      observed_tool_catalog_json TEXT NOT NULL DEFAULT '[]', observed_catalog_refreshed_at TEXT,
      auth_reference TEXT, health_status TEXT NOT NULL DEFAULT 'unknown', last_checked_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS mcp_gateway_projection (
      id TEXT PRIMARY KEY CHECK(id = 'owner'), owner_revision INTEGER NOT NULL,
      owner_version TEXT NOT NULL, etag TEXT, snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
      status TEXT NOT NULL, observed_at TEXT NOT NULL, error_code TEXT, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS mcp_gateway_execution_projection (
      provider_id TEXT PRIMARY KEY, owner_revision INTEGER NOT NULL, owner_version TEXT NOT NULL,
      catalog_json TEXT NOT NULL, status TEXT NOT NULL, observed_at TEXT NOT NULL,
      error_code TEXT, protocol_version TEXT, updated_at TEXT NOT NULL
    )`;
    this.sql`UPDATE mcp_gateway_execution_projection SET status='registered',error_code='mcp_standard_probe_required'
      WHERE status='current'`;
    this.sql`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, action TEXT NOT NULL, risk_level TEXT NOT NULL, status TEXT NOT NULL,
      request_json TEXT NOT NULL, decision_json TEXT, created_at TEXT NOT NULL, decided_at TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
      result_json TEXT, cancellation_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL, actor TEXT NOT NULL, target TEXT,
      detail_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS sandbox_control_state (
      id TEXT PRIMARY KEY CHECK(id='owner'), paused INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0, reason TEXT,
      resume_nonce_hash TEXT, resume_expires_at TEXT, updated_at TEXT NOT NULL
    )`;
    this.sql`INSERT OR IGNORE INTO sandbox_control_state
      (id,paused,generation,reason,resume_nonce_hash,resume_expires_at,updated_at)
      VALUES ('owner',0,0,NULL,NULL,NULL,${new Date().toISOString()})`;
    this.sql`CREATE TABLE IF NOT EXISTS operia_owned_resources (
      owner_id TEXT NOT NULL, namespace TEXT NOT NULL, resource_id TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT 'structured_data', schema_owner TEXT NOT NULL DEFAULT 'operia',
      schema_version TEXT NOT NULL DEFAULT 'legacy-v1', created_by TEXT NOT NULL DEFAULT 'operia',
      version INTEGER NOT NULL, status TEXT NOT NULL, value_json TEXT NOT NULL, value_bytes INTEGER NOT NULL,
      value_hash TEXT NOT NULL, deleted_by_task TEXT, delete_reason TEXT, restore_deadline TEXT,
      pinned INTEGER NOT NULL DEFAULT 0, reference_count INTEGER NOT NULL DEFAULT 0,
      legal_hold INTEGER NOT NULL DEFAULT 0, unknown_side_effect INTEGER NOT NULL DEFAULT 0,
      last_task_id TEXT, last_request_id TEXT, last_idempotency_key TEXT, policy_version TEXT NOT NULL DEFAULT 'operia-sandbox-v1',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_id,namespace,resource_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS operia_owned_resource_versions (
      owner_id TEXT NOT NULL, namespace TEXT NOT NULL, resource_id TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT 'structured_data', schema_owner TEXT NOT NULL DEFAULT 'operia',
      schema_version TEXT NOT NULL DEFAULT 'legacy-v1', created_by TEXT NOT NULL DEFAULT 'operia',
      version INTEGER NOT NULL, status TEXT NOT NULL, value_json TEXT NOT NULL, value_bytes INTEGER NOT NULL,
      value_hash TEXT NOT NULL, task_id TEXT NOT NULL, request_id TEXT, idempotency_key TEXT,
      action TEXT NOT NULL DEFAULT 'legacy_write', previous_version INTEGER, policy_version TEXT NOT NULL DEFAULT 'operia-sandbox-v1',
      reason TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(owner_id,namespace,resource_id,version)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS operia_owned_mutation_receipts (
      owner_id TEXT NOT NULL, namespace TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, action TEXT NOT NULL, resource_id TEXT NOT NULL,
      response_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(owner_id,namespace,idempotency_key)
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_operia_owned_resources_lifecycle
      ON operia_owned_resources(owner_id,namespace,status,restore_deadline)`;
    this.sql`CREATE TABLE IF NOT EXISTS sandbox_task_sessions (
      task_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, environment TEXT NOT NULL,
      sandbox_id TEXT NOT NULL, session_id TEXT NOT NULL, policy_version TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(sandbox_id,session_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS operia_codemode_executions (
      execution_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL, thread_key TEXT NOT NULL, request_id TEXT NOT NULL, code_hash TEXT NOT NULL,
      code_text TEXT NOT NULL DEFAULT '',
      catalog_revision TEXT NOT NULL, catalog_snapshot_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
      connector_versions_json TEXT NOT NULL, skill_revision TEXT NOT NULL, pause_generation INTEGER NOT NULL,
      runtime_name TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error_code TEXT,
      result_hash TEXT,
      lease_owner TEXT, lease_expires_at TEXT, recovery_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS operia_codemode_receipts (
      call_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, execution_id TEXT NOT NULL, args_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, result_hash TEXT NOT NULL, result_bytes INTEGER NOT NULL,
      classification TEXT NOT NULL, sensitivity_json TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
      policy_version TEXT NOT NULL, catalog_revision TEXT NOT NULL, connector_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_operia_codemode_receipts_execution
      ON operia_codemode_receipts(task_id,execution_id)`;
    this.sql`CREATE TABLE IF NOT EXISTS operia_codemode_inner_calls (
      call_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, execution_id TEXT NOT NULL, call_id TEXT NOT NULL,
      connector TEXT NOT NULL, method TEXT NOT NULL, args_hash TEXT NOT NULL, replay_policy TEXT NOT NULL,
      status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, recovery_generation INTEGER NOT NULL,
      result_receipt_hash TEXT, error_code TEXT, invocation_started_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_operia_codemode_inner_execution
      ON operia_codemode_inner_calls(task_id,execution_id,status)`;
    this.sql`CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY, operation TEXT NOT NULL, status TEXT NOT NULL, response_json TEXT,
      created_at TEXT NOT NULL, expires_at TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS heartbeat_config (
      id TEXT PRIMARY KEY CHECK(id='owner'), value_json TEXT NOT NULL, revision INTEGER NOT NULL,
      actor TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS heartbeat_runtime (
      id TEXT PRIMARY KEY CHECK(id='owner'), mode TEXT NOT NULL, activated_at TEXT,
      last_real_activity_at TEXT, last_warm_at TEXT, local_date TEXT NOT NULL,
      pulses_used INTEGER NOT NULL DEFAULT 0, first_pulse_dry_run_pending INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS heartbeat_activities (
      event_key TEXT PRIMARY KEY, kind TEXT NOT NULL, chat_ref TEXT NOT NULL, occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS heartbeat_intents (
      id TEXT PRIMARY KEY, intent_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, slot_key TEXT,
      due_at TEXT NOT NULL, status TEXT NOT NULL, dry_run INTEGER NOT NULL DEFAULT 0,
      config_revision INTEGER NOT NULL, lease_token TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      checkpoint_json TEXT NOT NULL DEFAULT '{}', decision_json TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_heartbeat_intents_claim ON heartbeat_intents(status,due_at,lease_until)`;
    this.sql`CREATE TABLE IF NOT EXISTS heartbeat_events (
      id TEXT PRIMARY KEY, intent_id TEXT, event_type TEXT NOT NULL, detail_json TEXT NOT NULL,
      usage_json TEXT, duration_ms INTEGER, created_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS heartbeat_activation_requests (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL, requested_mode TEXT NOT NULL,
      config_revision INTEGER NOT NULL, config_json TEXT NOT NULL, requested_by TEXT NOT NULL,
      telegram_chat_id TEXT, nonce TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
      decided_at TEXT, decided_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_heartbeat_activation_requests_status
      ON heartbeat_activation_requests(owner_id,status,expires_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS heartbeat_activation_grants (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, status TEXT NOT NULL,
      scope_json TEXT NOT NULL, budget_json TEXT NOT NULL, revision INTEGER NOT NULL,
      granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      revoked_at TEXT, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_heartbeat_activation_grants_active
      ON heartbeat_activation_grants(owner_id,status,expires_at)`;
    this.ensureHeartbeatOwnerState();
    this.sql`CREATE TABLE IF NOT EXISTS context_capsules (
      id TEXT PRIMARY KEY, namespace TEXT NOT NULL, chat_id TEXT NOT NULL, task_id TEXT NOT NULL,
      recipient TEXT NOT NULL, purpose TEXT NOT NULL, request_hash TEXT NOT NULL,
      owner_id TEXT NOT NULL, service_id TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      max_bytes INTEGER NOT NULL, total_bytes INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
      refs_json TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS context_handles (
      handle TEXT PRIMARY KEY, kind TEXT NOT NULL, checksum TEXT NOT NULL,
      namespace TEXT NOT NULL, chat_id TEXT NOT NULL, task_id TEXT NOT NULL,
      recipient TEXT NOT NULL, purpose TEXT NOT NULL, request_hash TEXT NOT NULL,
      owner_id TEXT NOT NULL, service_id TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS delegated_tasks (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, client_idempotency_key TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL DEFAULT '', service_id TEXT NOT NULL DEFAULT '', chat_id TEXT NOT NULL DEFAULT '',
      root_task_id TEXT NOT NULL DEFAULT '', parent_task_id TEXT, task_revision INTEGER NOT NULL DEFAULT 1,
      pause_generation INTEGER NOT NULL DEFAULT 0, paused_from_status TEXT, outcome TEXT, receipt_id TEXT,
      status TEXT NOT NULL, input_json TEXT NOT NULL, checkpoint_json TEXT, fiber_id TEXT,
      repair_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(owner_id,service_id,client_idempotency_key)
    )`;
    // Legacy task tables predate owner/service scoping. Add those columns
    // before any scoped index references them.
    this.ensureDelegatedTaskColumns();
    this.sql`CREATE INDEX IF NOT EXISTS idx_delegated_tasks_scope_updated
      ON delegated_tasks(owner_id,service_id,updated_at)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_delegated_tasks_scope_root
      ON delegated_tasks(owner_id,service_id,root_task_id,status)`;
    this.sql`CREATE TABLE IF NOT EXISTS tool_side_effects (
      call_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL,
      response_json TEXT, logical_invocation_count INTEGER NOT NULL DEFAULT 1,
      provider_attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT,
      provider_call_completed INTEGER NOT NULL DEFAULT 0,
      dispatch_state TEXT,
      result_status TEXT, error_class TEXT,
      invocation_contract_json TEXT,
      retry_authority_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS approval_tickets (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE, server_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL, args_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
      expires_at TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, workflow_id TEXT NOT NULL UNIQUE,
      preview_json TEXT NOT NULL, review_json TEXT, decision_json TEXT,
      decision_action TEXT, decision_scope TEXT, decision_owner_id TEXT, decision_chat_id TEXT, decided_at TEXT,
      created_at TEXT NOT NULL, consumed_at TEXT, attention_error TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS approval_ticket_calls (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      task_id TEXT NOT NULL, approval_round INTEGER NOT NULL, think_task_id TEXT, agent_call_key TEXT,
      server_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL, args_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
      schema_hash TEXT, pause_generation INTEGER,
      expires_at TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, workflow_id TEXT NOT NULL UNIQUE,
      preview_json TEXT NOT NULL, review_json TEXT, decision_json TEXT,
      decision_action TEXT, decision_scope TEXT, decision_owner_id TEXT, decision_chat_id TEXT, decided_at TEXT,
      created_at TEXT NOT NULL, consumed_at TEXT, attention_error TEXT,
      UNIQUE(task_id, approval_round, server_id, tool_name, args_hash, policy_version)
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_approval_ticket_calls_task_status
      ON approval_ticket_calls(task_id,status,created_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS approval_task_grants (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, think_task_id TEXT, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      server_id TEXT NOT NULL, tool_name TEXT NOT NULL, args_hash TEXT NOT NULL, schema_hash TEXT,
      policy_version TEXT NOT NULL, pause_generation INTEGER,
      status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(task_id,owner_id,chat_id,server_id,tool_name,args_hash,policy_version)
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_approval_task_grants_scope
      ON approval_task_grants(task_id,status,expires_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS think_action_grants (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL, thread_key TEXT NOT NULL, think_task_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
      operation_key TEXT NOT NULL, server_id TEXT NOT NULL, tool_name TEXT NOT NULL, args_json TEXT NOT NULL,
      args_hash TEXT NOT NULL, schema_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
      catalog_revision TEXT NOT NULL, catalog_snapshot_hash TEXT NOT NULL, pause_generation INTEGER NOT NULL,
      billing_class TEXT NOT NULL, expires_at TEXT NOT NULL, result_json TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(think_task_id,tool_call_id,operation_key)
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_think_action_grants_status
      ON think_action_grants(status,expires_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS mcp_elicitation_tickets (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, call_key TEXT NOT NULL, owner_id TEXT NOT NULL,
      service_id TEXT NOT NULL, chat_id TEXT NOT NULL, provider_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      mode TEXT NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL,
      decision_json TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, consumed_at TEXT,
      UNIQUE(task_id,call_key,request_hash)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS mcp_elicitation_resume_intents (
      ticket_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, call_key TEXT NOT NULL,
      status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
      fiber_id TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_mcp_elicitation_resume_intents_status
      ON mcp_elicitation_resume_intents(status,updated_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS browser_domain_challenges (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner_id TEXT NOT NULL, service_id TEXT NOT NULL,
      chat_id TEXT NOT NULL, source_host TEXT, target_hosts_json TEXT NOT NULL, call_json TEXT NOT NULL,
      args_hash TEXT NOT NULL, status TEXT NOT NULL, decision_scope TEXT, expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, decided_at TEXT
    )`;
    this.sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_domain_challenge_pending
      ON browser_domain_challenges(task_id,args_hash,status)`;
    this.sql`CREATE TABLE IF NOT EXISTS browser_domain_grants (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      hostname TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, uses_remaining INTEGER,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_browser_domain_grants_task
      ON browser_domain_grants(task_id,status,expires_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS voice_preview_grants (
      id TEXT PRIMARY KEY, generated_voice_id TEXT NOT NULL, media_type TEXT NOT NULL,
      settings_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, claimed_at TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS voice_profiles (
      voice_id TEXT PRIMARY KEY, name TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0, settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS voice_profiles_v2 (
      profile_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, provider_voice_id TEXT NOT NULL,
      kind TEXT NOT NULL, display_name TEXT NOT NULL, lifecycle_status TEXT NOT NULL,
      synthesis_defaults_json TEXT NOT NULL DEFAULT '{}', provenance_ref TEXT,
      provider_created_at TEXT, activation_deadline TEXT, selected_at TEXT,
      verification_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(provider_id,provider_voice_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS voice_jobs (
      job_id TEXT PRIMARY KEY, operation TEXT NOT NULL, provider_id TEXT NOT NULL,
      profile_id TEXT, status TEXT NOT NULL, arguments_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, approval_id TEXT, pricing_source TEXT,
      estimated_max_micro_usd INTEGER NOT NULL DEFAULT 0, reserved_micro_usd INTEGER NOT NULL DEFAULT 0,
      remote_outcome TEXT NOT NULL DEFAULT 'definitive', error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS voice_job_events (
      event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, event_type TEXT NOT NULL,
      detail_hash TEXT, created_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_voice_job_events_job ON voice_job_events(job_id,created_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS voice_provenance (
      provenance_ref TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL,
      source_type TEXT NOT NULL, rights_basis TEXT NOT NULL, attestation_text TEXT NOT NULL,
      attested_by_owner_id TEXT NOT NULL, attested_at TEXT NOT NULL, consent_version TEXT NOT NULL,
      evidence_ref TEXT, source_sha256 TEXT NOT NULL, source_media_type TEXT NOT NULL,
      source_bytes INTEGER NOT NULL, source_duration_ms INTEGER NOT NULL,
      transcript_sha256 TEXT NOT NULL, retention TEXT NOT NULL, created_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS voice_samples (
      sample_ref TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, object_key TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL, media_type TEXT NOT NULL, bytes INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, cleaned_at TEXT
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_voice_samples_expiry ON voice_samples(status,expires_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS voice_usage_log (
      usage_id TEXT PRIMARY KEY, job_id TEXT, provider_id TEXT NOT NULL, operation TEXT NOT NULL,
      model TEXT, usage_characters INTEGER, estimate_micro_usd INTEGER NOT NULL,
      pricing_status TEXT NOT NULL DEFAULT 'estimated', trace_id TEXT, created_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_voice_usage_created ON voice_usage_log(created_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS planner_usage_log (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner_id TEXT NOT NULL, service_id TEXT NOT NULL,
      chat_id TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_read_tokens INTEGER, service_tier TEXT, finish_reason TEXT,
      total_ms INTEGER NOT NULL, success INTEGER NOT NULL, error_code TEXT, created_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_planner_usage_created ON planner_usage_log(created_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS browser_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner_id TEXT NOT NULL, service_id TEXT NOT NULL,
      chat_id TEXT NOT NULL, action TEXT NOT NULL, url_host TEXT NOT NULL, status TEXT NOT NULL,
      browser_ms INTEGER NOT NULL DEFAULT 0, error_code TEXT, started_at TEXT NOT NULL, finished_at TEXT
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_browser_runs_started ON browser_runs(started_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS browser_executions (
      execution_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, runtime_name TEXT NOT NULL,
      mode TEXT NOT NULL, session_key TEXT NOT NULL, domains_json TEXT NOT NULL,
      recording INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, pending_json TEXT,
      result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_browser_executions_updated ON browser_executions(updated_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS browser_sessions (
      session_key TEXT PRIMARY KEY, owner_scope_hash TEXT NOT NULL, mode TEXT NOT NULL,
      state TEXT NOT NULL, last_url_origin TEXT, created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_browser_sessions_expiry ON browser_sessions(expires_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS browser_task_events (
      id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, task_id TEXT NOT NULL,
      event_type TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_browser_task_events_created ON browser_task_events(created_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS browser_site_profiles (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, primary_hosts_json TEXT NOT NULL,
      redirect_hosts_json TEXT NOT NULL, maximum_mode TEXT NOT NULL,
      allowed_actions_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS browser_task_leases (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, service_id TEXT NOT NULL,
      channel_ref TEXT NOT NULL, site_profile_id TEXT NOT NULL, site_profile_revision INTEGER NOT NULL,
      mode TEXT NOT NULL, allowed_hosts_json TEXT NOT NULL, allowed_actions_json TEXT NOT NULL,
      max_logical_steps INTEGER NOT NULL, used_logical_steps INTEGER NOT NULL DEFAULT 0,
      deadline_at TEXT NOT NULL, instruction_hash TEXT NOT NULL, state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, step_once INTEGER NOT NULL DEFAULT 0,
      session_key TEXT NOT NULL, runtime_name TEXT NOT NULL,
      execution_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_browser_task_leases_state
      ON browser_task_leases(state,deadline_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS browser_action_checkpoints (
      task_id TEXT NOT NULL, action_index INTEGER NOT NULL, action_kind TEXT NOT NULL,
      logical_step_cost INTEGER NOT NULL, mutating INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 1,
      result_json TEXT, started_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(task_id,action_index)
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_browser_action_checkpoints_state
      ON browser_action_checkpoints(task_id,state)`;
    this.sql`CREATE TABLE IF NOT EXISTS task_progress_events (
      task_id TEXT NOT NULL, revision INTEGER NOT NULL, event_type TEXT NOT NULL,
      safe_summary TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
      PRIMARY KEY(task_id,revision)
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_task_progress_events_created
      ON task_progress_events(created_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS tool_result_cache (
      cache_key TEXT PRIMARY KEY, scope_hash TEXT NOT NULL, owner_id TEXT NOT NULL, service_id TEXT NOT NULL,
      chat_id TEXT NOT NULL, task_id TEXT NOT NULL, purpose TEXT NOT NULL, request_hash TEXT NOT NULL,
      provider_hash TEXT NOT NULL, tool_hash TEXT NOT NULL, schema_hash TEXT NOT NULL, schema_version INTEGER NOT NULL,
      result_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_tool_result_cache_expiry ON tool_result_cache(expires_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS html_artifacts (
      artifact_id TEXT NOT NULL, version INTEGER NOT NULL, parent_version INTEGER,
      owner_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      content_hash TEXT NOT NULL, bundle_object_key TEXT, bundle_bytes INTEGER NOT NULL,
      state_revision INTEGER NOT NULL DEFAULT 0, sensitivity TEXT NOT NULL,
      task_id TEXT, source_item_id TEXT, session_id TEXT, creator_type TEXT NOT NULL,
      creator_model TEXT, scan_policy_version TEXT NOT NULL, blocked_category TEXT,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      PRIMARY KEY(artifact_id,version)
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_html_artifacts_owner_created
      ON html_artifacts(owner_id,created_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS html_artifact_state (
      artifact_id TEXT NOT NULL, version INTEGER NOT NULL, revision INTEGER NOT NULL,
      value_json TEXT NOT NULL, value_bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(artifact_id,version,revision)
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_html_artifact_state_lookup
      ON html_artifact_state(artifact_id,version,revision)`;
    this.sql`CREATE TABLE IF NOT EXISTS hook_definitions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, service_id TEXT NOT NULL, event TEXT NOT NULL,
      filter_json TEXT NOT NULL DEFAULT '{}', mode TEXT NOT NULL, failure_policy TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0, target_type TEXT NOT NULL, handler TEXT, webhook_url TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS hook_runs (
      id TEXT PRIMARY KEY, hook_id TEXT NOT NULL, event TEXT NOT NULL, status TEXT NOT NULL,
      reasons_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_hook_runs_created ON hook_runs(created_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS skill_versions (
      skill_key TEXT NOT NULL, version TEXT NOT NULL, kind TEXT NOT NULL,
      manifest_json TEXT NOT NULL, manifest_hash TEXT NOT NULL, schema_hash TEXT NOT NULL, source_hash TEXT NOT NULL,
      source_type TEXT NOT NULL, source_registry TEXT, publisher_key_id TEXT, publisher_fingerprint TEXT,
      signature TEXT, trust_status TEXT NOT NULL, published_at TEXT, installed_at TEXT NOT NULL,
      PRIMARY KEY(skill_key,version)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS skill_installations (
      skill_key TEXT PRIMARY KEY, alias TEXT NOT NULL UNIQUE, pinned_version TEXT NOT NULL,
      manifest_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, scope_json TEXT NOT NULL DEFAULT '{}',
      update_policy TEXT NOT NULL DEFAULT 'pinned', revision INTEGER NOT NULL DEFAULT 0,
      installed_by TEXT NOT NULL, disabled_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS skill_publishers (
      key_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, source_registry TEXT NOT NULL,
      public_key_base64url TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS skill_runs (
      id TEXT PRIMARY KEY, request_hash TEXT NOT NULL UNIQUE, skill_key TEXT NOT NULL, skill_version TEXT NOT NULL,
      manifest_hash TEXT NOT NULL, installation_revision INTEGER NOT NULL, owner_id TEXT NOT NULL,
      service_id TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL, input_json TEXT NOT NULL,
      permission_snapshot_json TEXT NOT NULL, status TEXT NOT NULL, state_json TEXT NOT NULL,
      planned_call_json TEXT, blocked_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_skill_runs_created ON skill_runs(created_at)`;
    this.sql`CREATE TABLE IF NOT EXISTS skill_run_events (
      id TEXT PRIMARY KEY, run_id TEXT, skill_key TEXT NOT NULL, event_type TEXT NOT NULL,
      detail_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_skill_run_events_created ON skill_run_events(created_at)`;
    this.ensureMcpRegistryColumns();
    this.ensureMcpGatewayExecutionProjectionColumns();
    this.ensureContextCapsuleColumns();
    this.ensureToolSideEffectColumns();
    this.ensureOperiaCodeModeSchema();
    this.ensureApprovalTicketSchema();
    this.ensureOperiaOwnedStorageSchema();
    this.ensurePlannerUsageColumns();
    this.ensureVoicePreviewColumns();
    if (this.state.schemaVersion < 2) {
      const now = new Date().toISOString();
      this.setState({
        ...this.state,
        schemaVersion: 2,
        capabilities: {
          ...defaultCapabilityConfig(),
          ...this.state.capabilities,
          "agent.heartbeat": "enabled",
          "tools.browser": "enabled",
          "tools.hooks": "enabled",
        },
        updatedAt: now,
      });
    }
    if (this.state.schemaVersion < 3) {
      this.setState({
        ...this.state,
        schemaVersion: 3,
        capabilities: { ...this.state.capabilities, "tools.code_mode": "enabled" },
        updatedAt: new Date().toISOString(),
      });
    }
    if (this.state.schemaVersion < 4) {
      const now = new Date().toISOString();
      const seed = normalizeBrowserDomainInput(parseBrowserDomainAllowlist(this.env.BROWSER_DOMAIN_ALLOWLIST));
      this.setState({
        ...this.state,
        schemaVersion: 4,
        browserDomainAllowlist: seed,
        browserDomainAllowlistRevision: 0,
        updatedAt: now,
      });
    }
    if (this.state.schemaVersion < 5) {
      this.setState({
        ...this.state,
        schemaVersion: 5,
        browserDomainDenylist: normalizeBrowserDomainInput(this.state.browserDomainDenylist ?? []),
        browserDomainDenylistRevision: Number(this.state.browserDomainDenylistRevision ?? 0),
        updatedAt: new Date().toISOString(),
      });
    }
    if (this.state.schemaVersion < 6) {
      const migratedDomains = mergeBrowserDomainInputs(
        this.state.browserDomainAllowlist ?? [],
        BROWSER_SCHEMA_V6_SEED_DOMAINS,
      );
      this.setState({
        ...this.state,
        schemaVersion: 6,
        browserDomainAllowlist: migratedDomains,
        browserDomainAllowlistRevision: Number(this.state.browserDomainAllowlistRevision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      });
    }
    if (this.state.schemaVersion < 7) {
      this.setState({ ...this.state, schemaVersion: 7, updatedAt: new Date().toISOString() });
    }
    if (this.state.schemaVersion < 8) {
      const now = new Date().toISOString();
      const fixtureDomains = normalizeBrowserDomainInput(parseBrowserDomainAllowlist(this.env.BROWSER_QA_FIXTURE_HOST));
      const readActions = JSON.stringify(allowedActionsForMode("read"));
      const formActions = JSON.stringify(allowedActionsForMode("form"));
      this.sql`UPDATE browser_site_profiles SET allowed_actions_json=${readActions},revision=revision+1,updated_at=${now}
        WHERE id IN ('cloudflare-docs','github-public')`;
      this.sql`UPDATE browser_site_profiles SET allowed_actions_json=${formActions},revision=revision+1,updated_at=${now}
        WHERE id='public-questionnaires'`;
      this.setState({
        ...this.state,
        schemaVersion: 8,
        browserDomainAllowlist: mergeBrowserDomainInputs(this.state.browserDomainAllowlist ?? [], fixtureDomains),
        browserDomainAllowlistRevision: Number(this.state.browserDomainAllowlistRevision ?? 0) + (fixtureDomains.length > 0 ? 1 : 0),
        updatedAt: now,
      });
    }
    this.ensureBrowserSiteProfiles();
    await this.ensureObserverProvider();
    await this.ensureDirectProviders();
    await this.ensureBuiltinSkills();
    await this.syncMcpGatewayProjection();
    await this.reconcileMcpElicitationResumeIntents();
    this.sql`DROP TRIGGER IF EXISTS reconcile_uncertain_side_effect`;
    this.sql`CREATE TRIGGER reconcile_uncertain_side_effect
      AFTER UPDATE OF status ON tool_side_effects
      WHEN OLD.status = 'uncertain' AND NEW.status IN ('retry_authorized', 'completed')
      BEGIN
        UPDATE delegated_tasks SET status = 'interrupted', fiber_id = NULL,
          checkpoint_json = json_remove(json_set(checkpoint_json, '$.status', 'interrupted'), '$.error'),
          updated_at = NEW.updated_at
          WHERE id = NEW.task_id AND status = 'attention_required';
        SELECT CASE WHEN changes() = 0 THEN RAISE(ABORT, 'task_not_attention_required') END;
      END`;

    if (this.state.initializedAt === new Date(0).toISOString()) {
      const now = new Date().toISOString();
      this.setState({ ...this.state, initializedAt: now, updatedAt: now });
    }
    if (this.heartbeatEnabled()) await this.scheduleEvery(this.heartbeatIntervalSeconds(), "agentHeartbeat", {});
  }

  private async ensureObserverProvider(): Promise<void> {
    const intended = await this.buildToolCatalog(OBSERVER_MCP_SERVER_ID, [{
      serverId: OBSERVER_MCP_SERVER_ID,
      toolName: "system_status",
      description: "Return a sanitized read-only snapshot of the Operia memory runtime.",
      riskLevel: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputByteLimit: 2048,
      enabled: true,
    }]);
    let observed: ToolCatalogEntry[] = [];
    let health = "degraded";
    try {
      const actualTools = await this.fetchProviderToolsList(OBSERVER_MCP_SERVER_ID);
      for (const input of deriveObservedCatalogInputs(OBSERVER_MCP_SERVER_ID, intended, actualTools)) {
        observed.push(await createToolCatalogEntry(input));
      }
      health = "healthy";
    } catch (error) {
      console.warn("observer provider catalog unavailable", error instanceof Error ? error.message : String(error));
    }
    const now = new Date().toISOString();
    this.sql`INSERT INTO mcp_registry (id, name, url, enabled, risk_level, tool_allowlist_json, tool_catalog_json,
      observed_tool_catalog_json, observed_catalog_refreshed_at, auth_reference, health_status, last_checked_at, created_at, updated_at)
      VALUES (${OBSERVER_MCP_SERVER_ID}, ${"Operia System Observer"}, ${"https://<MEMORY_SERVICE>.internal/agent-observer/mcp"}, 1,
        ${"read"}, ${JSON.stringify(["system_status"])}, ${JSON.stringify(intended)}, ${JSON.stringify(observed)},
        ${observed.length ? now : null}, ${"AGENT_MEMORY_MCP_BEARER"}, ${health}, ${now}, ${now}, ${now})
      ON CONFLICT(id) DO UPDATE SET enabled = 1, risk_level = ${"read"}, tool_allowlist_json = ${JSON.stringify(["system_status"])},
        tool_catalog_json = ${JSON.stringify(intended)}, observed_tool_catalog_json = ${JSON.stringify(observed)},
        observed_catalog_refreshed_at = ${observed.length ? now : null}, auth_reference = ${"AGENT_MEMORY_MCP_BEARER"},
        health_status = ${health}, last_checked_at = ${now}, updated_at = ${now}`;
  }

  private async ensureDirectProviders(): Promise<void> {
    const sourceSnapshotReady = await this.sourceCodeWorkspaceReady();
    const providers = [
      {
        id: SANDBOX_RUNTIME_PROVIDER_SERVER_ID,
        name: "Operia Task Sandbox Runtime",
        enabled: this.sandboxExecutionEnabled(),
        tools: [
          {
            serverId: SANDBOX_RUNTIME_PROVIDER_SERVER_ID,
            toolName: "execute_script",
            description: "Execute one bounded shell script inside a task-isolated ephemeral VM for code, temporary files, builds, tests, and data transformation. The VM receives no long-lived credentials or connector capability; its workspace is destroyed after the call. Public HTTPS GET/HEAD is available only when the separate P2 read flag is enabled.",
            riskLevel: "read" as const,
            inputSchema: {
              type: "object",
              properties: {
                script: { type: "string", minLength: 1, maxLength: 16000 },
                timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
              },
              required: ["script"],
              additionalProperties: false,
            },
            outputByteLimit: 64 * 1024,
            enabled: true,
          },
        ],
      },
      {
        id: SANDBOX_CODEMODE_PROVIDER_SERVER_ID,
        name: "Operia Sandbox Code Mode",
        enabled: this.sandboxCodeModeEnabled(),
        tools: [
          {
            serverId: SANDBOX_CODEMODE_PROVIDER_SERVER_ID,
            toolName: "execute_read_plan",
            description: "Execute one bounded read-only plan in an isolated Dynamic Worker. P1 exposes only synthetic echo; P2 adds only connectors whose live Service Binding and application bearer prerequisites are present. No global outbound access.",
            riskLevel: "read" as const,
            inputSchema: {
              type: "object",
              properties: { code: { type: "string", minLength: 8, maxLength: 24000 } },
              required: ["code"],
              additionalProperties: false,
            },
            outputByteLimit: 32 * 1024,
            enabled: true,
          },
        ],
      },
      {
        id: SOURCE_CODE_PROVIDER_SERVER_ID,
        name: "Operia Read-only Source Workspace",
        enabled: sourceSnapshotReady,
        tools: [
          {
            serverId: SOURCE_CODE_PROVIDER_SERVER_ID,
            toolName: "list",
            description: "List tracked text files from the pinned, sensitive-path-excluded Operia source snapshot. Returns the exact commit and tree hash; never reads a dirty working tree or arbitrary filesystem path.",
            riskLevel: "read" as const,
            inputSchema: { type: "object", properties: {
              prefix: { type: "string", maxLength: 500 },
              limit: { type: "integer", minimum: 1, maximum: 100 },
            }, additionalProperties: false },
            outputByteLimit: 32 * 1024,
            enabled: true,
          },
          {
            serverId: SOURCE_CODE_PROVIDER_SERVER_ID,
            toolName: "search",
            description: "Search source lines in the pinned read-only Operia snapshot. Use this to locate modules, functions, flags, tools, and exact call sites before reading a bounded range.",
            riskLevel: "read" as const,
            inputSchema: { type: "object", properties: {
              query: { type: "string", minLength: 1, maxLength: 200 },
              prefix: { type: "string", maxLength: 500 },
              limit: { type: "integer", minimum: 1, maximum: 40 },
            }, required: ["query"], additionalProperties: false },
            outputByteLimit: 48 * 1024,
            enabled: true,
          },
          {
            serverId: SOURCE_CODE_PROVIDER_SERVER_ID,
            toolName: "read",
            description: "Read an exact bounded line range from one tracked text file in the pinned Operia source snapshot. Returns file hash, commit SHA, tree hash, and line numbers.",
            riskLevel: "read" as const,
            inputSchema: { type: "object", properties: {
              path: { type: "string", minLength: 1, maxLength: 500 },
              start_line: { type: "integer", minimum: 1 },
              end_line: { type: "integer", minimum: 1 },
            }, required: ["path"], additionalProperties: false },
            outputByteLimit: 64 * 1024,
            enabled: true,
          },
          {
            serverId: SOURCE_CODE_PROVIDER_SERVER_ID,
            toolName: "inspect",
            description: "Search and read a bounded set of exact source ranges from one pinned Operia snapshot in one trusted operation. Returns revision pins, matches, file hashes, truncation, and a terminal-plan signal.",
            riskLevel: "read" as const,
            inputSchema: { type: "object", properties: {
              query: { type: "string", minLength: 1, maxLength: 200 },
              prefix: { type: "string", maxLength: 500 },
              max_files: { type: "integer", minimum: 1, maximum: 8 },
              max_lines: { type: "integer", minimum: 20, maximum: 400 },
            }, required: ["query"], additionalProperties: false },
            outputByteLimit: 128 * 1024,
            enabled: this.sourceCodeInspectEnabled(),
          },
        ],
      },
      {
        id: HTML_ARTIFACT_PROVIDER_SERVER_ID,
        name: "Operia HTML Artifact Runtime",
        enabled: htmlArtifactKindEnabled(this.env, "safe_document"),
        tools: [
          {
            serverId: HTML_ARTIFACT_PROVIDER_SERVER_ID,
            toolName: "create",
            description: "Create one immutable, private HTML artifact after sandbox and content policy checks. Use safe_document without JavaScript; use interactive_capsule only for a self-contained local interaction.",
            riskLevel: "write" as const,
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", minLength: 1, maxLength: 120 },
                kind: { type: "string", enum: ["safe_document", "interactive_capsule"] },
                html: { type: "string", minLength: 1, maxLength: 262144 },
                sensitivity: { type: "string", enum: ["private", "sensitive", "health"] },
                derived_health_summary: { type: "boolean" },
                parent_artifact_id: { type: "string", pattern: "^art_[a-f0-9]{24}$" },
              },
              required: ["title", "kind", "html"],
              additionalProperties: false,
            },
            outputByteLimit: 4096,
            enabled: true,
          },
        ],
      },
      {
        id: HEALTH_PROVIDER_SERVER_ID,
        name: "Operia Health Read-only Projection",
        enabled: this.healthProviderEnabled(),
        tools: [
          { serverId: HEALTH_PROVIDER_SERVER_ID, toolName: "health_summary", description: "Read a bounded owner health summary with provenance, freshness, missing-data markers, and no individual samples. Health information only; never a medical diagnosis.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: { range: { type: "string", enum: ["today", "7d", "30d"] }, group: { type: "string", enum: ["all", "activity", "sleep", "cardio", "body", "mobility", "respiratory", "vitals", "nutrition", "lifestyle", "environment", "other"] } }, additionalProperties: false }, outputByteLimit: 24 * 1024, enabled: true },
          { serverId: HEALTH_PROVIDER_SERVER_ID, toolName: "health_trends", description: "Read 7-day or 30-day aggregate health trends with source, timestamps, null gaps, and no individual samples. Health information only; never a medical diagnosis.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: { range: { type: "string", enum: ["7d", "30d"] }, group: { type: "string", enum: ["all", "activity", "sleep", "cardio", "body", "mobility", "respiratory", "vitals", "nutrition", "lifestyle", "environment", "other"] } }, required: ["range"], additionalProperties: false }, outputByteLimit: 64 * 1024, enabled: true },
        ],
      },
      {
        id: CALENDAR_PROVIDER_SERVER_ID,
        name: "Operia Calendar Read-only Projection",
        enabled: Boolean(this.env.CALENDAR_SERVICE && this.env.CALENDAR_SERVICE_BEARER?.trim()),
        tools: [
          { serverId: CALENDAR_PROVIDER_SERVER_ID, toolName: "calendar_summary", description: "Read the owner's bounded calendar status, current event, next event, remaining events today, and sync timestamps. Read-only; never creates or changes events.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputByteLimit: 24 * 1024, enabled: true },
          { serverId: CALENDAR_PROVIDER_SERVER_ID, toolName: "calendar_upcoming", description: "Read up to 20 upcoming owner calendar events from the canonical read-only projection. Read-only; never creates or changes events.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false }, outputByteLimit: 64 * 1024, enabled: true },
        ],
      },
      {
        id: APPROVAL_PROBE_PROVIDER_SERVER_ID,
        name: "Operia Approval Continuation Canary",
        enabled: this.thinkApprovalProbeEnabled(),
        tools: [
          {
            serverId: APPROVAL_PROBE_PROVIDER_SERVER_ID,
            toolName: THINK_APPROVAL_PROBE_TOOL_NAME,
            description: "Run only when the Owner explicitly asks to test approval continuation. This deterministic canary requires Telegram confirmation but performs no network request, paid tool call, external write, or resource mutation.",
            riskLevel: "read" as const,
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            outputByteLimit: 2048,
            enabled: true,
          },
        ],
      },
      {
        id: GROK_PROVIDER_SERVER_ID,
        name: "Grok Search and Image",
        enabled: this.grokProviderEnabled(),
        tools: [
          { serverId: GROK_PROVIDER_SERVER_ID, toolName: "search_web", description: "Live web search with bounded evidence.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: { query: { type: "string" }, max_sources: { type: "integer", minimum: 1, maximum: 8 } }, required: ["query"], additionalProperties: false }, outputByteLimit: 16_384, enabled: true },
          { serverId: GROK_PROVIDER_SERVER_ID, toolName: "generate_image", description: "Generate one image artifact.", riskLevel: "purchase" as const,
            inputSchema: { type: "object", properties: { prompt: { type: "string" }, aspect_ratio: { type: "string", enum: ["1:1", "3:2", "2:3", "16:9", "9:16"] }, quality: { type: "string", enum: ["standard", "quality"] }, reference_media_refs: { type: "array", items: { type: "string", pattern: "^agent-media:[0-9a-f-]{36}$" }, maxItems: 3 } }, required: ["prompt"], additionalProperties: false }, outputByteLimit: 8_192, enabled: true },
        ],
      },
      {
        id: VOICE_PROVIDER_SERVER_ID,
        name: "ElevenLabs Voice",
        enabled: this.env.VOICE_ENABLED?.trim().toLowerCase() === "true" && Boolean(this.env.ELEVENLABS_API_KEY?.trim()),
        tools: [
          { serverId: VOICE_PROVIDER_SERVER_ID, toolName: "speak", description: "Render a bounded reply with the default voice.", riskLevel: "message" as const,
            inputSchema: { type: "object", properties: { text: { type: "string" }, mode: { type: "string", enum: ["realtime", "quality", "expressive"] } }, required: ["text"], additionalProperties: false }, outputByteLimit: 2_048, enabled: true },
        ],
      },
      {
        id: HOME_ASSISTANT_PROVIDER_SERVER_ID,
        name: "Home Assistant",
        enabled: this.homeAssistantEnabled(),
        tools: [
          { serverId: HOME_ASSISTANT_PROVIDER_SERVER_ID, toolName: "call_service", description: "Call one explicitly allowlisted Home Assistant service on one explicitly allowlisted entity.", riskLevel: "device" as const,
            inputSchema: { type: "object", properties: { entity_id: { type: "string", pattern: "^[a-z0-9_]+\\.[a-z0-9_]+$" }, domain: { type: "string", pattern: "^[a-z0-9_]+$" }, service: { type: "string", pattern: "^[a-z0-9_]+$" }, data_json: { type: "string", maxLength: 8000 } }, required: ["entity_id", "domain", "service"], additionalProperties: false }, outputByteLimit: 4_096, enabled: true },
        ],
      },
      {
        id: BROWSER_PROVIDER_SERVER_ID,
        name: "Cloudflare Browser Run",
        enabled: this.browserEnabled(),
        tools: [
          { serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "browser_markdown", description: "Render one allowlisted HTTPS page as bounded Markdown.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: { url: { type: "string", format: "uri", maxLength: 2048 } }, required: ["url"], additionalProperties: false }, outputByteLimit: 64 * 1024, enabled: true },
          { serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "browser_links", description: "List links from one allowlisted HTTPS page.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: { url: { type: "string", format: "uri", maxLength: 2048 } }, required: ["url"], additionalProperties: false }, outputByteLimit: 64 * 1024, enabled: true },
          { serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "browser_scrape", description: "Read up to eight CSS selectors from one allowlisted HTTPS page.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: { url: { type: "string", format: "uri", maxLength: 2048 }, selectors: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 240 } } }, required: ["url", "selectors"], additionalProperties: false }, outputByteLimit: 64 * 1024, enabled: true },
          { serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "browser_extract", description: "Extract bounded JSON from one allowlisted HTTPS page using an explicit schema.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: { url: { type: "string", format: "uri", maxLength: 2048 }, prompt: { type: "string", minLength: 1, maxLength: 1000 }, response_schema_json: { type: "string", minLength: 2, maxLength: 8000 } }, required: ["url", "prompt", "response_schema_json"], additionalProperties: false }, outputByteLimit: 64 * 1024, enabled: true },
          { serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "site_adapter_read", description: "Run a versioned, smoke-checked read-only Site Adapter. Drift fails closed before Browser Run.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: { adapter: { type: "string", enum: ["cloudflare/docs", "github/repository"] }, url: { type: "string", format: "uri", maxLength: 2048 } }, required: ["adapter", "url"], additionalProperties: false }, outputByteLimit: 24 * 1024, enabled: true },
          { serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "browser_task", description: "Run a bounded multi-step browser task using server-owned typed actions, a versioned site profile, and a revocable task lease. Use form mode only for non-sensitive allowlisted forms.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: {
              domains: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 253 } },
              interaction_mode: { type: "string", enum: ["read", "form", "trusted"] },
              session_key: { type: "string", minLength: 1, maxLength: 96, pattern: "^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$" },
              recording: { type: "boolean" }, max_steps: { type: "integer", minimum: 1, maximum: 60 },
              timeout_ms: { type: "integer", minimum: 5000, maximum: 600000 },
              actions: { type: "array", minItems: 1, maxItems: 60, items: { type: "object", properties: {
                kind: { type: "string", enum: ["navigate", "follow_link", "next_page", "inspect", "wait_for", "scroll", "click", "fill", "select", "submit", "answer_radio_groups", "screenshot", "checkpoint"] },
                url: { type: "string", maxLength: 2048 }, selector: { type: "string", maxLength: 500 }, value: { type: "string", maxLength: 4000 },
                direction: { type: "string", enum: ["up", "down"] }, amount: { type: "integer", minimum: 1, maximum: 5000 },
                timeout_ms: { type: "integer", minimum: 100, maximum: 10000 },
                strategy: { type: "string", enum: ["first", "middle", "last", "alternating"] }, max_groups: { type: "integer", minimum: 1, maximum: 60 }, label: { type: "string", maxLength: 120 },
              }, required: ["kind"], additionalProperties: false } },
            }, required: ["domains", "actions"], additionalProperties: false }, outputByteLimit: 64 * 1024, enabled: this.browserTaskLeasesEnabled() },
          { serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "browser_execute", description: "Compatibility fallback for browser goals that server-owned typed browser_task actions cannot express. Run one bounded sequential CDP program on explicitly declared allowlisted domains. Any input or mutation must pause for owner handoff first.", riskLevel: "read" as const,
            inputSchema: { type: "object", properties: {
              code: { type: "string", minLength: 12, maxLength: 32000 },
              domains: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 253 } },
              mode: { type: "string", enum: ["one-shot", "dynamic", "reuse"] },
              session_key: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$" },
              recording: { type: "boolean" },
            }, required: ["code", "domains"], additionalProperties: false }, outputByteLimit: 64 * 1024, enabled: this.browserInteractiveEnabled() },
          { serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "browser_resume", description: "Internal approval continuation for one paused Browser execution. The planner must never select this tool directly.", riskLevel: "write" as const,
            inputSchema: { type: "object", properties: {
              execution_id: { type: "string", minLength: 8, maxLength: 160 },
              live_view_url: { type: "string", maxLength: 2048 },
              reason: { type: "string", maxLength: 500 },
              proposed_action: { type: "string", maxLength: 1000 },
            }, required: ["execution_id"], additionalProperties: false }, outputByteLimit: 64 * 1024, enabled: this.browserInteractiveEnabled() },
        ],
      },
    ];
    const now = new Date().toISOString();
    for (const provider of providers) {
      const catalog = await this.buildToolCatalog(provider.id, provider.tools);
      const health = provider.enabled ? "healthy" : "disabled";
      const allowlist = catalog.map((entry) => entry.toolName);
      const authReference = provider.id === GROK_PROVIDER_SERVER_ID
        ? "XAI_API_KEY"
        : provider.id === VOICE_PROVIDER_SERVER_ID
          ? "ELEVENLABS_API_KEY"
          : provider.id === HOME_ASSISTANT_PROVIDER_SERVER_ID ? "HOME_ASSISTANT_ACCESS_TOKEN"
            : provider.id === HEALTH_PROVIDER_SERVER_ID ? "HEALTH_SERVICE_BEARER"
              : provider.id === CALENDAR_PROVIDER_SERVER_ID ? "CALENDAR_SERVICE_BEARER" : null;
      this.sql`INSERT INTO mcp_registry (id,name,url,enabled,risk_level,tool_allowlist_json,tool_catalog_json,
        observed_tool_catalog_json,observed_catalog_refreshed_at,auth_reference,health_status,last_checked_at,created_at,updated_at)
        VALUES (${provider.id},${provider.name},${`provider://${provider.id}`},${provider.enabled ? 1 : 0},${"read"},${JSON.stringify(allowlist)},
          ${JSON.stringify(catalog)},${JSON.stringify(catalog)},${now},${authReference},${health},${now},${now},${now})
        ON CONFLICT(id) DO UPDATE SET enabled=${provider.enabled ? 1 : 0},tool_allowlist_json=${JSON.stringify(allowlist)},
          tool_catalog_json=${JSON.stringify(catalog)},observed_tool_catalog_json=${JSON.stringify(catalog)},observed_catalog_refreshed_at=${now},
          health_status=${health},last_checked_at=${now},updated_at=${now}`;
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/agents\/<AGENT_SERVICE>-runtime\/[^/]+/, "") || "/";

    try {
      if (request.method === "GET" && path === "/") return json({ service: "<AGENT_SERVICE>-runtime" });
      if (request.method === "GET" && path === "/health") return json(this.healthSnapshot());

      if (path.startsWith("/service/")) {
        if (path.startsWith("/service/think/")) {
          if (!this.thinkGatewayEnabled()) return json({ error: "not_found" }, { status: 404 });
          if (!(await bearerAuthorized(request, this.env.AGENT_THINK_SERVICE_BEARER))) {
            return json({ error: "unauthorized" }, { status: 401 });
          }
          if (request.method === "GET" && path === "/service/think/catalog") {
            const scope = this.thinkServiceScopeFromHeaders(request.headers);
            if (!scope) return json({ error: "think_scope_denied" }, { status: 403 });
            return json(await this.thinkCatalogSnapshot());
          }
          const body = await readJsonObject(request);
          const approvalReceiptMatch = /^\/service\/think\/approvals\/(apt_[a-f0-9]{24})\/receipt$/.exec(path);
          if (request.method === "POST" && approvalReceiptMatch) {
            return await this.readThinkApprovalReceipt(approvalReceiptMatch[1], body);
          }
          if (request.method === "POST" && path === "/service/think/task/complete") {
            return await this.completeThinkTask(body);
          }
          if (request.method === "POST" && path.startsWith("/service/think/codemode/")) {
            const action = path.slice("/service/think/codemode/".length);
            if (action === "resume" || action === "status" || action === "stop") {
              return await this.handleThinkCodeModeLifecycle(action, body);
            }
          }
          const scope = this.thinkServiceScope(body);
          if (!scope) return json({ error: "think_scope_denied" }, { status: 403 });
          if (request.method === "POST" && path === "/service/think/search") return await this.handleThinkSearch(body);
          if (request.method === "POST" && path === "/service/think/describe") return await this.handleThinkDescribe(body);
          if (request.method === "POST" && path === "/service/think/execute") return await this.handleThinkExecute(body, scope);
          if (request.method === "POST" && path === "/service/think/actions/preflight") {
            if (this.env.AGENT_THINK_ACTIONS_ENABLED?.trim().toLowerCase() !== "true") return json({ error: "not_found" }, { status: 404 });
            return await this.handleThinkActionPreflight(body, scope);
          }
          if (request.method === "POST" && path === "/service/think/actions/execute") {
            if (this.env.AGENT_THINK_ACTIONS_ENABLED?.trim().toLowerCase() !== "true") return json({ error: "not_found" }, { status: 404 });
            return await this.handleThinkActionExecute(body, scope, request.signal);
          }
          if (request.method === "POST" && path === "/service/think/actions/revoke") {
            if (this.env.AGENT_THINK_ACTIONS_ENABLED?.trim().toLowerCase() !== "true") return json({ error: "not_found" }, { status: 404 });
            return this.handleThinkActionRevoke(body, scope);
          }
          if (request.method === "POST" && path === "/service/think/codemode") return await this.handleThinkCodeMode(body, scope);
          if (request.method === "POST" && path === "/service/think/skills/search") return this.handleThinkSkillSearch(body);
          if (request.method === "POST" && path === "/service/think/skills/activate") return await this.handleThinkSkillActivate(body);
          return json({ error: "not_found" }, { status: 404 });
        }
        if (request.method === "GET" && path === "/service/operia/dashboard") {
          const ownerId = this.env.AGENT_CONTEXT_OWNER_ID?.trim();
          const readerBearer = this.env.AGENT_DASHBOARD_SERVICE_BEARER?.trim();
          if (!ownerId || !readerBearer || readerBearer === this.env.AGENT_CONTEXT_SERVICE_BEARER?.trim()
            || readerBearer === this.env.AGENT_ADMIN_BEARER?.trim()) {
            return json({ error: "dashboard_service_auth_misconfigured" }, { status: 503 });
          }
          if (!(await bearerAuthorized(request, readerBearer))) {
            return json({ error: "unauthorized" }, { status: 401 });
          }
          return json(await this.operiaDashboardProjection({
            ownerId,
            serviceId: this.env.AGENT_CONTEXT_SERVICE_ID?.trim() || "telegram-agent",
          }));
        }
        const binding = this.contextServiceBinding();
        if (!binding) return json({ error: "context_service_auth_misconfigured" }, { status: 503 });
        const serviceBearer = path.startsWith("/service/approvals/") || path.startsWith("/service/browser/domain-challenges/")
          || path.startsWith("/service/mcp/elicitations/")
          ? this.env.AGENT_APPROVAL_SERVICE_BEARER
          : this.env.AGENT_CONTEXT_SERVICE_BEARER;
        if (!(await bearerAuthorized(request, serviceBearer))) {
          return json({ error: "unauthorized" }, { status: 401 });
        }
        if (request.method === "POST" && path === "/service/context/handles") {
          return this.issueContextHandle(await readJsonObject(request), binding);
        }
        if (request.method === "POST" && path === "/service/context/capsules") {
          return await this.issueContextCapsule(await readJsonObject(request), binding);
        }
        if (request.method === "POST" && path === "/service/context/resolve") {
          return this.resolveCapsule(await readJsonObject(request), binding);
        }
        if (request.method === "POST" && path === "/service/catalog/refresh") {
          return await this.refreshObservedCatalog(await readJsonObject(request), binding);
        }
        if (request.method === "POST" && path === "/service/policy/evaluate") {
          return await this.evaluatePolicy(await readJsonObject(request), `context-service:${binding.serviceId}`);
        }
        if (request.method === "POST" && path === "/service/policy/sanitize") {
          return this.sanitizePolicyResult(await readJsonObject(request), `context-service:${binding.serviceId}`);
        }
        if (request.method === "GET" && path === "/service/runtime/snapshot") {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return json(this.serviceRuntimeSnapshot());
        }
        if (request.method === "GET" && path === "/service/operations/projection") {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return json(this.serviceOperationsProjection(binding));
        }
        if (request.method === "GET" && path === "/service/runtime/trace") {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return json({ events: this.serviceTrace() });
        }
        if (request.method === "GET" && path === "/service/control/projection") {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return json(await this.federatedControlProjection());
        }
        if (request.method === "GET" && path === "/service/heartbeat/projection") {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return json(this.heartbeatServiceProjection(binding));
        }
        if (request.method === "PUT" && path === "/service/heartbeat/config") {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          const body = await readJsonObject(request);
          if (!this.telegramCommandScope(body, binding)) return json({ error: "telegram_owner_scope_mismatch" }, { status: 403 });
          return this.updateHeartbeatConfig(request, { config: body.config }, "context-service:telegram-agent");
        }
        if (request.method === "POST" && path === "/service/heartbeat/activity") {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return this.recordHeartbeatActivity(await readJsonObject(request), binding);
        }
        const heartbeatActivationMatch = /^\/service\/heartbeat\/activation\/([^/]+)\/decision$/.exec(path);
        if (request.method === "POST" && heartbeatActivationMatch) {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return this.decideHeartbeatActivation(
            decodeURIComponent(heartbeatActivationMatch[1]), await readJsonObject(request), binding,
          );
        }
        if (request.method === "POST" && path === "/service/heartbeat/intents/claim") {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return this.claimHeartbeatIntent(await readJsonObject(request), binding);
        }
        const heartbeatIntentMatch = /^\/service\/heartbeat\/intents\/([^/]+)\/(complete|fail)$/.exec(path);
        if (request.method === "POST" && heartbeatIntentMatch) {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return await this.finishHeartbeatIntent(
            decodeURIComponent(heartbeatIntentMatch[1]),
            heartbeatIntentMatch[2] as "complete" | "fail",
            await readJsonObject(request),
            binding,
          );
        }
        if (request.method === "GET" && path === "/service/mcp/control") {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return json(await this.mcpGatewayControlSnapshot("telegram"));
        }
        if (request.method === "GET" && path === "/service/artifacts") {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return await this.listHtmlArtifacts(binding.ownerId, url);
        }
        const artifactMatch = /^\/service\/artifacts\/(art_[a-f0-9]{24})$/.exec(path);
        if (request.method === "GET" && artifactMatch) {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return this.getHtmlArtifact(artifactMatch[1], binding.ownerId);
        }
        const artifactBundleMatch = /^\/service\/artifacts\/(art_[a-f0-9]{24})\/versions\/(\d+)\/bundle$/.exec(path);
        if (request.method === "GET" && artifactBundleMatch) {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return await this.readHtmlArtifactBundle(artifactBundleMatch[1], Number(artifactBundleMatch[2]), binding.ownerId);
        }
        const artifactStateMatch = /^\/service\/artifacts\/(art_[a-f0-9]{24})\/versions\/(\d+)\/state$/.exec(path);
        if (request.method === "POST" && artifactStateMatch) {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          return this.saveHtmlArtifactState(
            artifactStateMatch[1], Number(artifactStateMatch[2]), binding.ownerId, await readJsonObject(request),
          );
        }
        if (request.method === "POST" && path === "/service/sandbox/control") {
          return await this.handleSandboxControl(await readJsonObject(request), binding);
        }
        if (request.method === "POST" && path === "/service/sandbox/connector") {
          return await this.handleSandboxConnector(request, await readJsonObject(request));
        }
        if (request.method === "PATCH" && path === "/service/mcp/tools") {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          const body = await readJsonObject(request);
          if (!this.telegramCommandScope(body, binding)) return json({ error: "telegram_owner_scope_mismatch" }, { status: 403 });
          return await this.updateMcpGatewayTool(request, body, "tgbot.example.com", "telegram");
        }
        const serviceSkillInstallationMatch = /^\/service\/skills\/installations\/([^/]+)$/.exec(path);
        if (request.method === "PUT" && serviceSkillInstallationMatch) {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          const body = await readJsonObject(request);
          if (!this.telegramCommandScope(body, binding)) return json({ error: "telegram_owner_scope_mismatch" }, { status: 403 });
          return this.updateSkillInstallation(
            request, decodeURIComponent(serviceSkillInstallationMatch[1]), body, "context-service:telegram-agent",
          );
        }
        const serviceCapabilityMatch = /^\/service\/capabilities\/([^/]+)$/.exec(path);
        if (request.method === "PATCH" && serviceCapabilityMatch) {
          if (binding.serviceId !== "telegram-agent") return json({ error: "forbidden" }, { status: 403 });
          const body = await readJsonObject(request);
          if (!this.telegramCommandScope(body, binding)) return json({ error: "telegram_owner_scope_mismatch" }, { status: 403 });
          return this.updateCapability(
            decodeURIComponent(serviceCapabilityMatch[1]), body, `context-service:${binding.serviceId}`, request,
          );
        }
        if (request.method === "POST" && path === "/service/telegram/tool") {
          return await this.handleTelegramToolCommand(await readJsonObject(request), binding);
        }
        if (request.method === "POST" && path === "/service/telegram/skill") {
          return await this.handleTelegramSkillCommand(await readJsonObject(request), binding);
        }
        if (request.method === "POST" && path === "/service/telegram/browser") {
          return await this.handleTelegramBrowserCommand(await readJsonObject(request), binding);
        }
        if (request.method === "POST" && path === "/service/tasks") {
          return await this.submitDelegatedTask(await readJsonObject(request), binding);
        }
        if (request.method === "POST" && path === "/service/tasks/direct") {
          return await this.submitDelegatedTask({ ...(await readJsonObject(request)), mode: "direct" }, binding);
        }
        if (request.method === "POST" && path === "/service/providers/voice/transcribe") {
          return await this.transcribeVoice(request);
        }
        if (request.method === "POST" && path === "/service/providers/voice/synthesize") {
          return await this.synthesizeVoiceService(await readJsonObject(request));
        }
        if (request.method === "POST" && path === "/service/presentation/music-poster") {
          if (binding.serviceId !== "telegram-agent") return json({ error:"forbidden" },{ status:403 });
          return await this.createMusicSharePoster(await readJsonObject(request));
        }
        const mediaMatch = /^\/service\/media\/([0-9a-f-]{36})$/i.exec(path);
        if (request.method === "GET" && mediaMatch) {
          return await this.readProviderMedia(mediaMatch[1]);
        }
        if (request.method === "DELETE" && mediaMatch) {
          await this.env.MEDIA.delete(mediaMatch[1]);
          return json({ ok: true });
        }
        if (request.method === "POST" && path === "/service/approvals/prepare") {
          return await this.prepareApproval(await readJsonObject(request), binding);
        }
        if (request.method === "POST" && /^\/service\/approvals\/[^/]+\/decision$/.test(path)) {
          return await this.forwardApprovalDecision(await readJsonObject(request), binding);
        }
        if (request.method === "POST" && /^\/service\/approvals\/[^/]+\/details$/.test(path)) {
          return this.readApprovalDetails(decodeURIComponent(path.split("/")[3]), await readJsonObject(request), binding);
        }
        if (request.method === "POST" && /^\/service\/approvals\/[^/]+\/workflow$/.test(path)) {
          return await this.applyApprovalDecision(decodeURIComponent(path.split("/")[3]), await readJsonObject(request), binding);
        }
        const elicitationDecisionMatch = /^\/service\/mcp\/elicitations\/([^/]+)\/decision$/.exec(path);
        if (request.method === "POST" && elicitationDecisionMatch) {
          return await this.decideMcpElicitation(
            decodeURIComponent(elicitationDecisionMatch[1]),
            await readJsonObject(request),
            binding,
          );
        }
        const domainDecisionMatch = /^\/service\/browser\/domain-challenges\/([^/]+)\/decision$/.exec(path);
        if (request.method === "POST" && domainDecisionMatch) {
          return await this.applyBrowserDomainDecision(decodeURIComponent(domainDecisionMatch[1]), await readJsonObject(request), binding);
        }
        if (request.method === "GET" && /^\/service\/tasks\/[^/]+$/.test(path)) {
          return this.getDelegatedTask(decodeURIComponent(path.split("/")[3]), binding);
        }
        if (request.method === "GET" && /^\/service\/tasks\/[^/]+\/events$/.test(path)) {
          return this.getTaskProgressEvents(decodeURIComponent(path.split("/")[3]), Number(url.searchParams.get("after_revision") ?? 0), binding);
        }
        if (request.method === "POST" && /^\/service\/tasks\/[^/]+\/control$/.test(path)) {
          return await this.controlDelegatedTask(decodeURIComponent(path.split("/")[3]), await readJsonObject(request), binding);
        }
        if (request.method === "POST" && /^\/service\/tasks\/[^/]+\/cancel$/.test(path)) {
          return await this.cancelDelegatedTask(decodeURIComponent(path.split("/")[3]), binding);
        }
        return json({ error: "not_found" }, { status: 404 });
      }

      if (path.startsWith("/api/agent/voice-studio")) {
        if (request.headers.get("x-agent-browser-authorized") !== "1") return json({ error: "unauthorized" }, { status: 401 });
        return await this.handleVoiceStudio(request, path);
      }

      if (path.startsWith("/api/agent/control")) {
        if (request.headers.get("x-agent-browser-authorized") !== "1") return json({ error: "unauthorized" }, { status: 401 });
        return await this.handleControlApi(request, path);
      }

      if (path.startsWith("/api/agent/skills")) {
        if (request.headers.get("x-agent-browser-authorized") !== "1") return json({ error: "unauthorized" }, { status: 401 });
        return await this.handleSkillsApi(request, path);
      }

      if (!(await bearerAuthorized(request, this.env.AGENT_ADMIN_BEARER))) return json({ error: "unauthorized" }, { status: 401 });
      if (request.method === "GET" && path === "/api/runtime/capabilities") {
        return json({ capabilities: capabilitySnapshot(this.state.capabilities, this.state.capabilityRevisions) });
      }
      if (request.method === "GET" && path === "/api/runtime/snapshot") return json(this.runtimeSnapshot());

      if (!path.startsWith("/manage/")) return json({ error: "not_found" }, { status: 404 });

      if (request.method === "PUT" && path.startsWith("/manage/capabilities/")) {
        return this.updateCapability(decodeURIComponent(path.slice("/manage/capabilities/".length)), await readJsonObject(request));
      }
      if (request.method === "GET" && path === "/manage/mcp") return json({ servers: this.listMcpServers() });
      if (request.method === "POST" && path === "/manage/mcp") return this.registerMcp(await readJsonObject(request));
      if (request.method === "POST" && /^\/manage\/mcp\/[^/]+\/catalog\/refresh$/.test(path)) {
        return this.refreshMcpCatalog(path.split("/")[3], await readJsonObject(request));
      }
      if (request.method === "DELETE" && path.startsWith("/manage/mcp/")) return this.deleteMcp(decodeURIComponent(path.slice("/manage/mcp/".length)));
      if (request.method === "POST" && path === "/manage/approvals") return this.createApproval(await readJsonObject(request));
      if (request.method === "POST" && /^\/manage\/approvals\/[^/]+\/decision$/.test(path)) {
        return this.decideApproval(path.split("/")[3], await readJsonObject(request));
      }
      if (request.method === "POST" && path === "/manage/jobs") return this.createJob(await readJsonObject(request), request.headers.get("idempotency-key"));
      if (request.method === "POST" && /^\/manage\/jobs\/[^/]+\/cancel$/.test(path)) return this.cancelJob(path.split("/")[3]);
      if (request.method === "GET" && path === "/manage/audit") return json({ events: this.listAudit() });
      if (request.method === "GET" && path === "/manage/hooks") return json({ hooks: this.listHooks(), runs: this.listHookRuns() });
      if (request.method === "POST" && path === "/manage/hooks") return this.saveHook(await readJsonObject(request), false);
      if (request.method === "PUT" && /^\/manage\/hooks\/[^/]+$/.test(path)) {
        return this.saveHook({ ...(await readJsonObject(request)), id: decodeURIComponent(path.split("/")[3]) }, true);
      }
      if (request.method === "POST" && /^\/manage\/hooks\/[^/]+\/toggle$/.test(path)) {
        return this.toggleHook(decodeURIComponent(path.split("/")[3]), await readJsonObject(request));
      }
      if (request.method === "DELETE" && /^\/manage\/hooks\/[^/]+$/.test(path)) return this.deleteHook(decodeURIComponent(path.split("/")[3]));
      if (request.method === "POST" && path === "/manage/heartbeat/run") {
        await this.agentHeartbeat();
        return json({ ok: true, heartbeat: this.latestHeartbeatSummary() });
      }
      if (request.method === "GET" && path === "/manage/tool-side-effects") return json({ sideEffects: this.listToolSideEffects() });
      if (request.method === "POST" && /^\/manage\/tool-side-effects\/[^/]+\/resolve$/.test(path)) {
        return await this.resolveToolSideEffect(decodeURIComponent(path.split("/")[3]), await readJsonObject(request));
      }
      return json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected runtime error";
      return json({ error: "bad_request", message }, { status: 400 });
    }
  }

  private htmlArtifactPresentation(row: HtmlArtifactRow): Record<string, unknown> {
    return {
      artifactId: row.artifact_id,
      version: row.version,
      ...(row.parent_version == null ? {} : { parentVersion: row.parent_version }),
      title: row.title,
      kind: row.kind,
      status: row.status,
      contentHash: row.content_hash,
      bytes: row.bundle_bytes,
      stateRevision: row.state_revision,
      sensitivity: row.sensitivity,
      correlation: {
        ...(row.task_id ? { taskId: row.task_id } : {}),
        ...(row.source_item_id ? { messageId: row.source_item_id } : {}),
        ...(row.session_id ? { sessionId: row.session_id } : {}),
      },
      creator: { type: row.creator_type, ...(row.creator_model ? { model: row.creator_model } : {}) },
      scan: { policyVersion: row.scan_policy_version, ...(row.blocked_category ? { blockedCategory: row.blocked_category } : {}) },
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  private async expireHtmlArtifacts(ownerId: string): Promise<void> {
    const now = new Date().toISOString();
    const expired = this.sql<HtmlArtifactRow>`SELECT * FROM html_artifacts
      WHERE owner_id=${ownerId} AND status='ready' AND expires_at<=${now}`;
    for (const row of expired) {
      if (row.bundle_object_key) await this.env.MEDIA.delete(row.bundle_object_key);
      this.sql`UPDATE html_artifacts SET status='expired',bundle_object_key=NULL
        WHERE artifact_id=${row.artifact_id} AND version=${row.version} AND status='ready'`;
      this.sql`DELETE FROM html_artifact_state WHERE artifact_id=${row.artifact_id} AND version=${row.version}`;
    }
  }

  private async listHtmlArtifacts(ownerId: string, url: URL): Promise<Response> {
    await this.expireHtmlArtifacts(ownerId);
    const after = url.searchParams.get("after");
    const afterIso = after && Number.isFinite(Date.parse(after)) ? new Date(after).toISOString() : "1970-01-01T00:00:00.000Z";
    const rows = this.sql<HtmlArtifactRow>`SELECT a.* FROM html_artifacts a
      WHERE a.owner_id=${ownerId} AND a.created_at>${afterIso}
      AND a.version=(SELECT MAX(b.version) FROM html_artifacts b WHERE b.artifact_id=a.artifact_id)
      ORDER BY a.created_at DESC LIMIT 50`;
    return json({ artifacts: rows.map((row) => this.htmlArtifactPresentation(row)), observedAt: new Date().toISOString() });
  }

  private getHtmlArtifact(artifactId: string, ownerId: string): Response {
    const rows = this.sql<HtmlArtifactRow>`SELECT * FROM html_artifacts
      WHERE artifact_id=${artifactId} AND owner_id=${ownerId} ORDER BY version DESC`;
    if (!rows.length) return json({ error: "artifact_not_found" }, { status: 404 });
    return json({
      artifact: this.htmlArtifactPresentation(rows[0]),
      versions: rows.map((row) => this.htmlArtifactPresentation(row)),
    });
  }

  private async readHtmlArtifactBundle(artifactId: string, version: number, ownerId: string): Promise<Response> {
    const row = this.sql<HtmlArtifactRow>`SELECT * FROM html_artifacts
      WHERE artifact_id=${artifactId} AND version=${version} AND owner_id=${ownerId}`[0];
    if (!row) return json({ error: "artifact_not_found" }, { status: 404 });
    if (row.status !== "ready" || !row.bundle_object_key || Date.parse(row.expires_at) <= Date.now()) {
      return json({ error: `artifact_${row.status === "ready" ? "expired" : row.status}` }, { status: 410 });
    }
    const object = await this.env.MEDIA.get(row.bundle_object_key);
    if (!object) return json({ error: "artifact_bundle_missing" }, { status: 503 });
    return new Response(object.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "x-artifact-content-hash": row.content_hash,
      },
    });
  }

  private saveHtmlArtifactState(
    artifactId: string,
    version: number,
    ownerId: string,
    body: Record<string, unknown>,
  ): Response {
    const row = this.sql<HtmlArtifactRow>`SELECT * FROM html_artifacts
      WHERE artifact_id=${artifactId} AND version=${version} AND owner_id=${ownerId}`[0];
    if (!row || row.status !== "ready") return json({ error: "artifact_not_ready" }, { status: 404 });
    const revision = Number(body.revision);
    if (!Number.isSafeInteger(revision) || revision !== row.state_revision + 1) {
      return json({ error: "artifact_state_revision_conflict", currentRevision: row.state_revision }, { status: 409 });
    }
    let valueJson: string;
    try { valueJson = JSON.stringify(body.value); } catch { return json({ error: "artifact_state_invalid" }, { status: 400 }); }
    if (typeof valueJson !== "string") return json({ error: "artifact_state_invalid" }, { status: 400 });
    const valueBytes = new TextEncoder().encode(valueJson).byteLength;
    if (valueBytes > HTML_ARTIFACT_STATE_MAX_BYTES || valueBytes > HTML_ARTIFACT_TOTAL_STATE_MAX_BYTES) {
      return json({ error: "artifact_state_too_large" }, { status: 413 });
    }
    const now = new Date().toISOString();
    this.sql`INSERT INTO html_artifact_state(artifact_id,version,revision,value_json,value_bytes,created_at)
      VALUES (${artifactId},${version},${revision},${valueJson},${valueBytes},${now})`;
    this.sql`DELETE FROM html_artifact_state
      WHERE artifact_id=${artifactId} AND version=${version} AND revision<${revision}`;
    this.sql`UPDATE html_artifacts SET state_revision=${revision}
      WHERE artifact_id=${artifactId} AND version=${version} AND owner_id=${ownerId}`;
    this.audit("artifact.state.saved", `context-service:telegram-agent`, artifactId, { version, revision, valueBytes });
    return json({ artifactId, version, stateRevision: revision });
  }

  private async createHtmlArtifact(args: Record<string, unknown>, taskId: string): Promise<Record<string, unknown>> {
    const input = this.delegatedTaskInput(taskId);
    if (!input) throw new Error("artifact_task_scope_missing");
    const title = typeof args.title === "string" ? args.title.trim().slice(0, 120) : "";
    const html = typeof args.html === "string" ? args.html : "";
    const kind = args.kind === "interactive_capsule" ? "interactive_capsule" : args.kind === "safe_document" ? "safe_document" : null;
    const sensitivity = args.sensitivity === "health" || args.sensitivity === "sensitive" ? args.sensitivity : "private";
    if (!title || !kind) throw new Error("artifact_arguments_invalid");
    if (!htmlArtifactKindEnabled(this.env, kind)) throw new Error(kind === "interactive_capsule" ? "interactive_artifacts_disabled" : "html_artifacts_disabled");

    const requestedParent = typeof args.parent_artifact_id === "string" && /^art_[a-f0-9]{24}$/.test(args.parent_artifact_id)
      ? args.parent_artifact_id : null;
    const parent = requestedParent
      ? this.sql<HtmlArtifactRow>`SELECT * FROM html_artifacts WHERE artifact_id=${requestedParent}
          AND owner_id=${input.ownerId} ORDER BY version DESC LIMIT 1`[0]
      : null;
    if (requestedParent && !parent) throw new Error("artifact_parent_not_found");
    const artifactId = parent?.artifact_id ?? `art_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const version = (parent?.version ?? 0) + 1;
    const scan = await scanHtmlArtifact({
      artifactId,
      version,
      kind,
      html,
      sensitivity,
      derivedHealthSummary: args.derived_health_summary === true,
    });
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + HTML_ARTIFACT_RETENTION_MS).toISOString();
    let objectKey: string | null = null;
    if (scan.ok) {
      objectKey = artifactBundleObjectKey(artifactId, version, scan.contentHash);
      await this.env.MEDIA.put(objectKey, scan.bundle, {
        httpMetadata: { contentType: "text/html; charset=utf-8", cacheControl: "private, no-store" },
        customMetadata: { artifactId, version: String(version), contentHash: scan.contentHash, policyVersion: scan.policyVersion },
      });
    }
    const status = scan.ok ? "ready" : "blocked";
    const blockedCategory = scan.ok ? null : scan.category;
    this.sql`INSERT INTO html_artifacts(
      artifact_id,version,parent_version,owner_id,title,kind,status,content_hash,bundle_object_key,bundle_bytes,
      state_revision,sensitivity,task_id,source_item_id,session_id,creator_type,creator_model,scan_policy_version,
      blocked_category,created_at,expires_at
    ) VALUES (
      ${artifactId},${version},${parent?.version ?? null},${input.ownerId},${title},${kind},${status},${scan.contentHash},
      ${objectKey},${scan.bytes},0,${sensitivity},${taskId},NULL,NULL,'opus','anthropic/claude-opus-4.6',
      ${scan.policyVersion},${blockedCategory},${createdAt},${expiresAt}
    )`;
    this.audit(`artifact.${status}`, `task:${taskId}`, artifactId, {
      version, kind, sensitivity, contentHash: scan.contentHash, bytes: scan.bytes,
      ...(blockedCategory ? { blockedCategory } : {}),
    });
    const row = this.sql<HtmlArtifactRow>`SELECT * FROM html_artifacts
      WHERE artifact_id=${artifactId} AND version=${version}`[0];
    return this.htmlArtifactPresentation(row);
  }

  private async handleVoiceStudio(request: Request, path: string): Promise<Response> {
    const base = "/api/agent/voice-studio";
    if (request.method === "GET" && path === `${base}/bootstrap`) {
      return json({
        configured: this.env.VOICE_ENABLED?.trim().toLowerCase() === "true" && Boolean(this.env.ELEVENLABS_API_KEY?.trim()),
        providers: this.voiceProviderProjection(),
        policy: {
          ownerDomain: "agent.example.com", effectiveSource: "deploy_config",
          globalEnabled: this.env.VOICE_ENABLED?.trim().toLowerCase() === "true",
          cloneEnabled: this.env.MINIMAX_VOICE_CLONE_ENABLED?.trim().toLowerCase() === "true",
          dailyBudgetMicroUsd: Math.max(0, Number(this.env.MINIMAX_VOICE_DAILY_BUDGET_MICRO_USD) || 0),
          maxSynthesisCharacters: 4000,
        },
        csrfToken: request.headers.get("x-agent-browser-csrf") ?? "",
        previews: [], voices: this.voiceProfiles(), runtime: this.serviceRuntimeSnapshot(), logs: this.voiceAuditEvents(),
      });
    }
    if (request.method === "POST" && (path === `${base}/previews` || /^\/api\/agent\/voice-studio\/previews\/[^/]+\/regenerate$/.test(path))) {
      const body = await readJsonObject(request);
      return this.withBrowserIdempotency(request, "voice.previews", body, () => this.createVoicePreviews(body), true);
    }
    const audioMatch = /^\/api\/agent\/voice-studio\/previews\/([^/]+)\/audio$/.exec(path);
    if (request.method === "GET" && audioMatch) return this.readVoicePreview(decodeURIComponent(audioMatch[1]));
    if (request.method === "POST" && path === `${base}/voices`) {
      const body = await readJsonObject(request);
      return this.withBrowserIdempotency(request, "voice.save", body, () => this.saveDesignedVoice(body));
    }
    const favoriteMatch = /^\/api\/agent\/voice-studio\/voices\/([^/]+)\/favorite$/.exec(path);
    if (request.method === "PUT" && favoriteMatch) return this.updateVoiceFavorite(decodeURIComponent(favoriteMatch[1]), await readJsonObject(request));
    const defaultMatch = /^\/api\/agent\/voice-studio\/voices\/([^/]+)\/default$/.exec(path);
    if (request.method === "PUT" && defaultMatch) return this.updateDefaultVoice(decodeURIComponent(defaultMatch[1]));
    return json({ error: "not_found" }, { status: 404 });
  }

  private async handleControlApi(request: Request, path: string): Promise<Response> {
    const base = "/api/agent/control";
    if (request.method === "GET" && path === `${base}/bootstrap`) {
      const cache = this.sql<{ entries: number; hits: number }>`SELECT COUNT(*) AS entries,COALESCE(SUM(hit_count),0) AS hits FROM tool_result_cache`[0];
      const siteAdapters = await createDefaultSiteAdapterRegistry();
      const allowlist = this.browserDomainAllowlistSnapshot();
      const denylist = this.browserDomainDenylistSnapshot();
      return json({
        csrfToken: request.headers.get("x-agent-browser-csrf") ?? "",
        runtime: this.serviceRuntimeSnapshot(),
        browser: {
          enabled: this.browserEnabled(),
          interactiveEnabled: this.browserInteractiveEnabled(),
          taskLeasesEnabled: this.browserTaskLeasesEnabled(),
          domainAllowlist: allowlist.domains,
          domainAllowlistRevision: allowlist.revision,
          domainAllowlistSource: allowlist.source,
          domainAllowlistKey: allowlist.key,
          domainDenylist: denylist.domains,
          domainDenylistRevision: denylist.revision,
          domainDenylistSource: denylist.source,
          domainDenylistKey: denylist.key,
          domainGrants: this.sql<RuntimeRow>`SELECT id,task_id,hostname,scope,status,uses_remaining,expires_at,created_at,updated_at
            FROM browser_domain_grants ORDER BY created_at DESC LIMIT 100`,
          domainChallenges: this.sql<RuntimeRow>`SELECT id,task_id,source_host,target_hosts_json,status,decision_scope,expires_at,created_at,updated_at
            FROM browser_domain_challenges ORDER BY created_at DESC LIMIT 100`,
          dailyBudgetMs: this.browserDailyBudgetMs(),
          usedTodayMs: this.browserUsageTodayMs(),
          runs: this.sql<RuntimeRow>`SELECT id,task_id,action,url_host,status,browser_ms,error_code,started_at,finished_at
            FROM browser_runs ORDER BY started_at DESC LIMIT 100`,
          providerStatus: {
            browserRun: Boolean(this.env.BROWSER), workerLoader: Boolean(this.env.LOADER),
            planner: this.plannerModel(), r2: Boolean(this.env.MEDIA),
          },
          sessions: this.sql<RuntimeRow>`SELECT session_key,mode,state,last_url_origin,last_used_at,expires_at
            FROM browser_sessions ORDER BY last_used_at DESC LIMIT 100`,
          executions: this.sql<RuntimeRow>`SELECT execution_id,task_id,mode,session_key,domains_json,recording,status,
            pending_json,created_at,updated_at,
            (SELECT id FROM approval_ticket_calls WHERE task_id=browser_executions.task_id ORDER BY created_at DESC LIMIT 1) AS approval_ticket_id,
            (SELECT status FROM approval_ticket_calls WHERE task_id=browser_executions.task_id ORDER BY created_at DESC LIMIT 1) AS approval_status
            FROM browser_executions ORDER BY updated_at DESC LIMIT 100`,
          siteProfiles: this.sql<RuntimeRow>`SELECT id,label,primary_hosts_json,redirect_hosts_json,maximum_mode,
            allowed_actions_json,revision,enabled,updated_at FROM browser_site_profiles ORDER BY id`,
          taskLeases: this.sql<RuntimeRow>`SELECT id,task_id,site_profile_id,site_profile_revision,mode,allowed_hosts_json,
            allowed_actions_json,max_logical_steps,used_logical_steps,deadline_at,state,revision,created_at,updated_at
            FROM browser_task_leases ORDER BY updated_at DESC LIMIT 100`,
          events: this.sql<RuntimeRow>`SELECT execution_id,task_id,event_type,detail_json,created_at
            FROM browser_task_events ORDER BY created_at DESC LIMIT 100`,
          plannerRuns: this.sql<RuntimeRow>`SELECT task_id,model,input_tokens,output_tokens,reasoning_tokens,
            cache_read_tokens,service_tier,finish_reason,total_ms,success,error_code,created_at
            FROM planner_usage_log ORDER BY created_at DESC LIMIT 100`,
        },
        cache: { entries: Number(cache?.entries ?? 0), hits: Number(cache?.hits ?? 0), storage: "Agent DO SQLite" },
        mcpGatewayProjection: this.mcpGatewayProjection(),
        skills: this.installedSkills(true).map(({ alias, revision, enabled, manifestHash, skill }) => ({ alias, revision, key: skill.key, version: skill.version, manifestHash, sourceHash: skill.sourceHash, kind: skill.kind, description: skill.description, enabled })),
        siteAdapters: siteAdapters.map((adapter) => ({ key: adapter.key, version: adapter.version, sourceHash: adapter.sourceHash, schemaHash: adapter.schemaHash, domains: adapter.domains, riskLevel: adapter.riskLevel, smoke: adapter.smoke, enabled: adapter.enabled })),
        hooks: this.listHooks(),
        hookRuns: this.listHookRuns(),
        heartbeat: this.latestHeartbeatSummary(),
      });
    }
    if (request.method === "GET" && path === `${base}/effective`) {
      return json({ registryVersion: CONTROL_TOPOLOGY.registryVersion, values: this.agentControlValues() });
    }
    if (request.method === "GET" && path === `${base}/heartbeat/bootstrap`) {
      return json({ csrfToken: request.headers.get("x-agent-browser-csrf") ?? "", ...this.heartbeatSnapshot() });
    }
    if (request.method === "PUT" && path === `${base}/heartbeat/config`) {
      return this.updateHeartbeatConfig(request, await readJsonObject(request));
    }
    if (request.method === "POST" && (path === `${base}/heartbeat/dry-run` || path === `${base}/heartbeat/run-now`)) {
      return this.createManualHeartbeatIntent(path.endsWith("dry-run"));
    }
    if (request.method === "GET" && path === `${base}/heartbeat/events`) {
      return json({ events: this.listHeartbeatEvents(), intents: this.listHeartbeatIntents() });
    }
    if (request.method === "GET" && path === `${base}/federation`) {
      return json(await this.federatedControlProjection());
    }
    if (request.method === "GET" && path === `${base}/mcp`) {
      return json(await this.mcpGatewayControlSnapshot("agent"));
    }
    if (request.method === "GET" && path === `${base}/mcp/elicitations`) {
      return json({ elicitations: this.listMcpElicitations() });
    }
    const elicitationDecisionMatch = /^\/api\/agent\/control\/mcp\/elicitations\/([^/]+)\/decision$/.exec(path);
    if (request.method === "POST" && elicitationDecisionMatch) {
      return await this.decideMcpElicitation(decodeURIComponent(elicitationDecisionMatch[1]), await readJsonObject(request));
    }
    if (request.method === "PATCH" && path === `${base}/mcp/tools`) {
      return await this.updateMcpGatewayTool(request, await readJsonObject(request), "agent.example.com", "agent");
    }
    if (request.method === "PUT" && path === `${base}/browser/domain-allowlist`) {
      return this.updateBrowserDomainAllowlist(request, await readJsonObject(request));
    }
    if (request.method === "PUT" && path === `${base}/browser/domain-denylist`) {
      return this.updateBrowserDomainDenylist(request, await readJsonObject(request));
    }
    const domainGrantRevokeMatch = /^\/api\/agent\/control\/browser\/domain-grants\/([^/]+)\/revoke$/.exec(path);
    if (request.method === "POST" && domainGrantRevokeMatch) {
      return this.revokeBrowserDomainGrant(decodeURIComponent(domainGrantRevokeMatch[1]));
    }
    if (request.method === "POST" && path === `${base}/heartbeat`) {
      await this.agentHeartbeat();
      return json({ ok: true, heartbeat: this.latestHeartbeatSummary() });
    }
    if (request.method === "POST" && path === `${base}/browser/smoke`) {
      return await this.runBrowserProductionSmoke();
    }
    if (request.method === "POST" && path === `${base}/browser/e2e/start`) {
      return await this.startInteractiveBrowserCanary();
    }
    if (request.method === "GET" && path === `${base}/browser/e2e/latest`) {
      return await this.latestInteractiveBrowserCanaryStatus();
    }
    const browserE2eTaskMatch = /^\/api\/agent\/control\/browser\/e2e\/([^/]+)$/.exec(path);
    if (request.method === "GET" && browserE2eTaskMatch) {
      return this.getDelegatedTask(decodeURIComponent(browserE2eTaskMatch[1]));
    }
    const browserLiveMatch = /^\/api\/agent\/control\/browser\/([^/]+)\/live$/.exec(path);
    if (request.method === "GET" && browserLiveMatch) {
      return await this.interactiveBrowserLiveView(decodeURIComponent(browserLiveMatch[1]));
    }
    const browserRejectMatch = /^\/api\/agent\/control\/browser\/([^/]+)\/reject$/.exec(path);
    if (request.method === "POST" && browserRejectMatch) {
      const executionId = decodeURIComponent(browserRejectMatch[1]);
      await this.rejectInteractiveBrowserExecution(executionId, "control_console");
      return json({ ok: true, executionId });
    }
    const browserCloseMatch = /^\/api\/agent\/control\/browser\/([^/]+)\/close-session$/.exec(path);
    if (request.method === "POST" && browserCloseMatch) {
      return await this.closeInteractiveBrowserSession(decodeURIComponent(browserCloseMatch[1]));
    }
    if (request.method === "POST" && path === `${base}/hooks`) return this.saveHook(await readJsonObject(request), false);
    if (request.method === "PUT" && /^\/api\/agent\/control\/hooks\/[^/]+$/.test(path)) {
      return this.saveHook({ ...(await readJsonObject(request)), id: decodeURIComponent(path.split("/")[5]) }, true);
    }
    if (request.method === "POST" && /^\/api\/agent\/control\/hooks\/[^/]+\/toggle$/.test(path)) {
      return this.toggleHook(decodeURIComponent(path.split("/")[5]), await readJsonObject(request));
    }
    if (request.method === "DELETE" && /^\/api\/agent\/control\/hooks\/[^/]+$/.test(path)) {
      return this.deleteHook(decodeURIComponent(path.split("/")[5]));
    }
    return json({ error: "not_found" }, { status: 404 });
  }

  private async handleSkillsApi(request: Request, path: string): Promise<Response> {
    const base = "/api/agent/skills";
    if (request.method === "GET" && path === `${base}/bootstrap`) {
      return json({ csrfToken: request.headers.get("x-agent-browser-csrf") ?? "", ...this.skillControlSnapshot() });
    }
    if (request.method === "POST" && path === `${base}/publishers`) {
      return await this.saveSkillPublisher(await readJsonObject(request));
    }
    if (request.method === "POST" && path === `${base}/install`) {
      return await this.installCommunitySkill(await readJsonObject(request));
    }
    const installationMatch = /^\/api\/agent\/skills\/installations\/([^/]+)$/.exec(path);
    if (request.method === "PUT" && installationMatch) {
      return this.updateSkillInstallation(request, decodeURIComponent(installationMatch[1]), await readJsonObject(request));
    }
    const cancelMatch = /^\/api\/agent\/skills\/runs\/([^/]+)\/cancel$/.exec(path);
    if (request.method === "POST" && cancelMatch) return this.cancelStoredSkillRun(decodeURIComponent(cancelMatch[1]));
    return json({ error: "not_found" }, { status: 404 });
  }

  private skillRegistryAllowlist(): string[] {
    return [...new Set((this.env.SKILL_REGISTRY_ALLOWLIST ?? "").split(",").map((value) => value.trim()).filter((value) => {
      try { return new URL(value).protocol === "https:"; } catch { return false; }
    }))].sort();
  }

  private async saveSkillPublisher(body: Record<string, unknown>): Promise<Response> {
    const keyId = typeof body.keyId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(body.keyId) ? body.keyId : "";
    const sourceRegistry = typeof body.sourceRegistry === "string" ? body.sourceRegistry.trim() : "";
    const publicKey = typeof body.publicKeyBase64Url === "string" ? body.publicKeyBase64Url.trim() : "";
    const status = body.status === "revoked" ? "revoked" : body.status === "active" ? "active" : "";
    if (!keyId || !sourceRegistry || !publicKey || !status) return json({ error: "skill_publisher_invalid" }, { status: 422 });
    if (!this.skillRegistryAllowlist().includes(sourceRegistry)) return json({ error: "skill_registry_not_allowlisted" }, { status: 403 });
    let fingerprint: string;
    try { fingerprint = await fingerprintPublisherKey(publicKey); } catch { return json({ error: "skill_publisher_key_invalid" }, { status: 422 }); }
    if (typeof body.fingerprint === "string" && body.fingerprint !== fingerprint) {
      return json({ error: "skill_publisher_fingerprint_mismatch" }, { status: 409 });
    }
    const now = new Date().toISOString();
    const prior = this.sql<{ fingerprint: string; public_key_base64url: string }>`SELECT fingerprint,public_key_base64url
      FROM skill_publishers WHERE key_id=${keyId}`[0];
    if (prior && (prior.fingerprint !== fingerprint || prior.public_key_base64url !== publicKey)) {
      return json({ error: "skill_publisher_key_rotation_requires_new_id" }, { status: 409 });
    }
    this.sql`INSERT INTO skill_publishers (key_id,fingerprint,source_registry,public_key_base64url,status,created_at,updated_at)
      VALUES (${keyId},${fingerprint},${sourceRegistry},${publicKey},${status},${now},${now})
      ON CONFLICT(key_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at`;
    this.recordSkillEvent(null, `publisher:${keyId}`, status === "revoked" ? "publisher.revoked" : "publisher.saved", { sourceRegistry, fingerprint });
    return json({ keyId, fingerprint, sourceRegistry, status }, { status: prior ? 200 : 201 });
  }

  private async installCommunitySkill(body: Record<string, unknown>): Promise<Response> {
    const envelope = body.envelope as CommunitySkillEnvelope | undefined;
    const alias = typeof body.alias === "string" && /^[a-z0-9][a-z0-9_]{0,63}$/.test(body.alias) ? body.alias : "";
    if (!envelope || !alias) return json({ error: "skill_install_input_invalid" }, { status: 422 });
    const publisherKeys = this.sql<{ key_id: string; fingerprint: string; public_key_base64url: string; status: "active" | "revoked" }>`
      SELECT key_id,fingerprint,public_key_base64url,status FROM skill_publishers`;
    const decision = await verifyCommunitySkillTrust({
      envelope,
      policy: {
        allowedSourceRegistries: this.skillRegistryAllowlist(),
        publisherKeys: publisherKeys.map((row) => ({
          keyId: row.key_id,
          fingerprint: row.fingerprint,
          algorithm: "Ed25519",
          publicKeyEncoding: "base64url",
          publicKeyBase64Url: row.public_key_base64url,
          status: row.status,
        })),
      },
    });
    if (!decision.trusted) return json({ error: "skill_trust_rejected", code: decision.code }, { status: 403 });
    let skill: SkillRegistryEntry;
    try { skill = await createSkillRegistryEntry(envelope.manifest); } catch (error) {
      return json({ error: "skill_manifest_invalid", code: error instanceof Error ? error.message : "invalid" }, { status: 422 });
    }
    const existingVersion = this.sql<{ manifest_hash: string }>`SELECT manifest_hash FROM skill_versions
      WHERE skill_key=${skill.key} AND version=${skill.version}`[0];
    if (existingVersion && existingVersion.manifest_hash !== decision.manifestHash) {
      return json({ error: "skill_version_hash_conflict" }, { status: 409 });
    }
    const aliasOwner = this.sql<{ skill_key: string }>`SELECT skill_key FROM skill_installations WHERE alias=${alias}`[0];
    if (aliasOwner && aliasOwner.skill_key !== skill.key) return json({ error: "skill_alias_conflict" }, { status: 409 });
    const now = new Date().toISOString();
    this.sql`INSERT INTO skill_versions
      (skill_key,version,kind,manifest_json,manifest_hash,schema_hash,source_hash,source_type,source_registry,
        publisher_key_id,publisher_fingerprint,signature,trust_status,published_at,installed_at)
      VALUES (${skill.key},${skill.version},${skill.kind},${JSON.stringify(skill)},${decision.manifestHash},${skill.schemaHash},${skill.sourceHash},
        'community_registry',${decision.sourceRegistry},${decision.publisherKeyId},${decision.publisherKeyFingerprint},
        ${JSON.stringify(envelope.signature)},'trusted',NULL,${now})
      ON CONFLICT(skill_key,version) DO NOTHING`;
    const current = this.sql<{ revision: number }>`SELECT revision FROM skill_installations WHERE skill_key=${skill.key}`[0];
    const revision = Number(current?.revision ?? 0) + 1;
    this.sql`INSERT INTO skill_installations
      (skill_key,alias,pinned_version,manifest_hash,enabled,scope_json,update_policy,revision,installed_by,disabled_reason,created_at,updated_at)
      VALUES (${skill.key},${alias},${skill.version},${decision.manifestHash},0,'{}','pinned',${revision},'browser-owner','community_review_required',${now},${now})
      ON CONFLICT(skill_key) DO UPDATE SET alias=excluded.alias,pinned_version=excluded.pinned_version,
        manifest_hash=excluded.manifest_hash,enabled=0,revision=excluded.revision,installed_by=excluded.installed_by,
        disabled_reason='community_review_required',updated_at=excluded.updated_at`;
    this.recordSkillEvent(null, skill.key, "install.verified", { version: skill.version, manifestHash: decision.manifestHash, revision, enabled: false });
    return json({ skillKey: skill.key, version: skill.version, alias, manifestHash: decision.manifestHash, revision, enabled: false }, { status: 201 });
  }

  private updateSkillInstallation(
    request: Request,
    skillKey: string,
    body: Record<string, unknown>,
    actor = "browser-owner",
  ): Response {
    if (typeof body.enabled !== "boolean") return json({ error: "skill_enabled_required" }, { status: 422 });
    const row = this.sql<{ revision: number; trust_status: string }>`SELECT i.revision,v.trust_status
      FROM skill_installations i JOIN skill_versions v
        ON v.skill_key=i.skill_key AND v.version=i.pinned_version AND v.manifest_hash=i.manifest_hash
      WHERE i.skill_key=${skillKey}`[0];
    if (!row) return json({ error: "skill_installation_not_found" }, { status: 404 });
    const ifMatch = request.headers.get("if-match")?.replace(/^W\//, "").replaceAll('"', "") ?? "";
    if (!ifMatch) return json({ error: "skill_revision_required" }, { status: 428 });
    if (Number(ifMatch) !== Number(row.revision)) return json({ error: "skill_revision_conflict", currentRevision: row.revision }, { status: 409 });
    if (body.enabled && row.trust_status !== "trusted") return json({ error: "skill_trust_required" }, { status: 409 });
    const revision = Number(row.revision) + 1;
    const now = new Date().toISOString();
    this.sql`UPDATE skill_installations SET enabled=${body.enabled ? 1 : 0},revision=${revision},
      disabled_reason=${body.enabled ? null : "disabled_by_owner"},updated_at=${now} WHERE skill_key=${skillKey}`;
    this.recordSkillEvent(null, skillKey, body.enabled ? "installation.enabled" : "installation.disabled", { revision, actor });
    return json({ skillKey, enabled: body.enabled, revision });
  }

  private cancelStoredSkillRun(runId: string): Response {
    const row = this.sql<{ skill_key: string; status: string }>`SELECT skill_key,status FROM skill_runs WHERE id=${runId}`[0];
    if (!row) return json({ error: "skill_run_not_found" }, { status: 404 });
    if (row.status !== "planned") return json({ error: "skill_run_not_planned", status: row.status }, { status: 409 });
    const now = new Date().toISOString();
    this.sql`UPDATE skill_runs SET status='cancelled',planned_call_json=NULL,updated_at=${now} WHERE id=${runId} AND status='planned'`;
    this.recordSkillEvent(runId, row.skill_key, "run.cancelled", { executorCalls: 0 });
    return json({ runId, status: "cancelled" });
  }

  private async federatedControlProjection(): Promise<Record<string, unknown>> {
    const own = { status: "ready", manifest: controlManifestFor("agent.example.com"), values: this.agentControlValues() };
    const bearer = this.env.MEMORY_CONTROL_SERVICE_BEARER?.trim();
    if (!bearer) {
      return { registryVersion: CONTROL_TOPOLOGY.registryVersion, own, memory: { status: "unavailable", reason: "service_credential_missing" } };
    }
    try {
      const response = await this.env.MEMORY_MCP.fetch("https://<MEMORY_SERVICE>.internal/service/control/effective", {
        headers: {
          authorization: `Bearer ${bearer}`,
          "x-operia-source-domain": "agent.example.com",
          "x-operia-service-id": "agent-control-projection",
        },
      });
      const payload = await response.json<Record<string, unknown>>().catch(() => ({}));
      if (!response.ok) return { registryVersion: CONTROL_TOPOLOGY.registryVersion, own, memory: { status: "unavailable", httpStatus: response.status } };
      return { registryVersion: CONTROL_TOPOLOGY.registryVersion, own, memory: { status: "ready", ...payload } };
    } catch {
      return { registryVersion: CONTROL_TOPOLOGY.registryVersion, own, memory: { status: "unavailable", reason: "service_binding_error" } };
    }
  }

  private providerRegistry() {
    const timeoutMs = Math.max(1_000, Math.min(60_000, Number(this.env.PROVIDER_TIMEOUT_MS) || 15_000));
    const providerFetch = createGrokGatewayFetch(this.env);
    return createProviderRegistry({
      xai: { enabled: this.grokProviderEnabled(), apiKey: this.env.XAI_API_KEY, timeoutMs, maxResponseBytes: 4 * 1024 * 1024 },
      elevenlabs: { enabled: this.env.VOICE_ENABLED?.trim().toLowerCase() === "true", apiKey: this.env.ELEVENLABS_API_KEY, timeoutMs, maxResponseBytes: 12 * 1024 * 1024 },
      minimax: {
        enabled: this.env.VOICE_ENABLED?.trim().toLowerCase() === "true" && this.env.MINIMAX_VOICE_ENABLED?.trim().toLowerCase() === "true",
        apiKey: this.env.MINIMAX_API_KEY, timeoutMs, maxResponseBytes: 16 * 1024 * 1024,
      },
      homeAssistant: this.homeAssistantProviderConfig(),
    }, { fetch: providerFetch });
  }

  private async createVoicePreviews(body: Record<string, unknown>): Promise<Response> {
    const settings = this.readVoiceSettings(body.settings);
    if (!settings) return json({ error: "invalid_voice_settings" }, { status: 422 });
    const result = await this.providerRegistry().invoke({ provider: "elevenlabs", operation: "voice_design", input: {
      voiceDescription: settings.description,
      ...(settings.previewText.length >= 100 && settings.previewText.length <= 1000 ? { text: settings.previewText } : {}),
      modelId: settings.model, loudness: settings.loudness, quality: settings.quality,
      guidanceScale: settings.guidance, ...(settings.seed === null ? {} : { seed: settings.seed }),
    } });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const previews = [];
    for (const preview of result.previews.slice(0, 3)) {
      const id = crypto.randomUUID();
      const bytes = this.base64ToBytes(preview.audioBase64);
      await this.env.MEDIA.put(`preview/${id}`, bytes, {
        httpMetadata: { contentType: preview.mediaType, cacheControl: "private, no-store" },
        customMetadata: { kind: "preview", expiresAt },
      });
      this.sql`INSERT INTO voice_preview_grants (id,generated_voice_id,media_type,settings_json,created_at,expires_at)
        VALUES (${id},${preview.generatedVoiceId},${preview.mediaType},${JSON.stringify(this.persistableVoiceSettings(settings))},${now.toISOString()},${expiresAt})`;
      previews.push({ id, durationSeconds: preview.durationSeconds ?? null, mediaType: preview.mediaType });
    }
    this.audit("voice.previews.created", "browser-session", null, { count: previews.length, expiresAt });
    return json({ previews, text: result.text }, { status: 201 });
  }

  private async readVoicePreview(id: string): Promise<Response> {
    const row = this.sql<{ media_type: string; expires_at: string }>`SELECT media_type,expires_at FROM voice_preview_grants WHERE id=${id}`[0];
    if (!row) return json({ error: "preview_not_found" }, { status: 404 });
    if (Date.parse(row.expires_at) <= Date.now()) return json({ error: "preview_expired" }, { status: 410 });
    const object = await this.env.MEDIA.get(`preview/${id}`);
    if (!object) return json({ error: "preview_audio_expired" }, { status: 410 });
    return new Response(object.body, { headers: { "content-type": row.media_type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }

  private async saveDesignedVoice(body: Record<string, unknown>): Promise<Response> {
    const previewId = typeof body.previewId === "string" ? body.previewId : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
    if (!previewId || !name) return json({ error: "invalid_preview_or_name" }, { status: 422 });
    const claimedAt = new Date().toISOString();
    const claimed = this.sql<{ generated_voice_id: string; settings_json: string; expires_at: string }>`UPDATE voice_preview_grants SET claimed_at=${claimedAt}
      WHERE id=${previewId} AND claimed_at IS NULL AND expires_at>${claimedAt} RETURNING generated_voice_id,settings_json,expires_at`;
    const row = claimed[0];
    if (!row) return json({ error: "preview_already_claimed_or_missing" }, { status: 409 });
    let saved: { voiceId: string };
    try {
      saved = await this.providerRegistry().invoke({ provider: "elevenlabs", operation: "voice_save", input: {
        voiceName: name, voiceDescription: "A private Operia assistant voice designed in Voice Studio.", generatedVoiceId: row.generated_voice_id,
        labels: { use_case: "assistant" },
      } });
    } catch (error) {
      const definitive = error instanceof ProviderError && (error.code === "disabled" || error.code === "not_configured" || error.code.startsWith("invalid_") || (error.status !== undefined && error.status >= 400 && error.status < 500 && ![408, 409, 425, 429].includes(error.status)));
      if (definitive) this.sql`UPDATE voice_preview_grants SET claimed_at=NULL WHERE id=${previewId} AND claimed_at=${claimedAt}`;
      this.audit(definitive ? "voice.profile.save_rejected" : "voice.profile.save_attention_required", "browser-session", previewId, { code: error instanceof ProviderError ? error.code : "unknown" });
      return json({ error: definitive ? "voice_save_rejected" : "voice_save_attention_required" }, { status: definitive ? 422 : 409 });
    }
    const now = new Date().toISOString();
    this.sql`INSERT INTO voice_profiles (voice_id,name,favorite,is_default,settings_json,created_at,updated_at)
      VALUES (${saved.voiceId},${name},0,0,${row.settings_json},${now},${now})
      ON CONFLICT(voice_id) DO UPDATE SET name=${name},settings_json=${row.settings_json},updated_at=${now}`;
    this.sql`DELETE FROM voice_preview_grants WHERE id=${previewId}`;
    await this.env.MEDIA.delete(`preview/${previewId}`);
    this.audit("voice.profile.saved", "browser-session", saved.voiceId, { name });
    return json({ voices: this.voiceProfiles() }, { status: 201 });
  }

  private updateVoiceFavorite(voiceId: string, body: Record<string, unknown>): Response {
    const changed = this.sql<{ voice_id: string }>`UPDATE voice_profiles SET favorite=${body.favorite === false ? 0 : 1},updated_at=${new Date().toISOString()}
      WHERE voice_id=${voiceId} RETURNING voice_id`;
    return changed.length ? json({ voices: this.voiceProfiles() }) : json({ error: "voice_not_found" }, { status: 404 });
  }

  private updateDefaultVoice(voiceId: string): Response {
    const exists = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM voice_profiles WHERE voice_id=${voiceId}`[0]?.count ?? 0;
    if (!exists) return json({ error: "voice_not_found" }, { status: 404 });
    this.sql`UPDATE voice_profiles SET is_default=CASE WHEN voice_id=${voiceId} THEN 1 ELSE 0 END,updated_at=${new Date().toISOString()}`;
    this.audit("voice.default.updated", "browser-session", voiceId, {});
    return json({ voices: this.voiceProfiles() });
  }

  private voiceProfiles() {
    return this.sql<{ voice_id: string; name: string; favorite: number; is_default: number; settings_json: string }>`
      SELECT voice_id,name,favorite,is_default,settings_json FROM voice_profiles ORDER BY is_default DESC,favorite DESC,updated_at DESC`.map((row) => ({
        voiceId: row.voice_id, name: row.name, favorite: row.favorite === 1, isDefault: row.is_default === 1,
        settings: this.parseJson(row.settings_json, {}),
      }));
  }

  private voiceProviderProjection() {
    const globalEnabled = this.env.VOICE_ENABLED?.trim().toLowerCase() === "true";
    const elevenConfigured = Boolean(this.env.ELEVENLABS_API_KEY?.trim());
    const minimaxEnabled = globalEnabled && this.env.MINIMAX_VOICE_ENABLED?.trim().toLowerCase() === "true";
    const minimaxConfigured = Boolean(this.env.MINIMAX_API_KEY?.trim());
    const dailyBudgetMicroUsd = Math.max(0, Number(this.env.MINIMAX_VOICE_DAILY_BUDGET_MICRO_USD) || 0);
    return [
      {
        id: "elevenlabs", ownerDomain: "agent.example.com", effectiveSource: "deploy_config",
        enabled: globalEnabled, configured: elevenConfigured, available: globalEnabled && elevenConfigured,
        capabilities: ["voice_design", "voice_save", "stt", "tts"],
      },
      {
        id: "minimax", ownerDomain: "agent.example.com", effectiveSource: "deploy_config",
        enabled: minimaxEnabled, configured: minimaxConfigured,
        available: minimaxEnabled && minimaxConfigured && dailyBudgetMicroUsd > 0,
        capabilities: ["tts", "voice_design", "voice_clone", "voice_list", "voice_delete"],
        stt: false, dailyBudgetMicroUsd,
        reason: !globalEnabled ? "voice_disabled" : !minimaxEnabled ? "provider_disabled" : !minimaxConfigured ? "missing_credentials" : dailyBudgetMicroUsd === 0 ? "budget_zero" : undefined,
      },
    ];
  }

  private readVoiceSettings(raw: unknown): null | { description: string; previewText: string; age: string; pitch: string; weight: string; breathiness: string; texture: string; accent: string; pace: string; emotion: string; intimacy: string; loudness: number; quality: number; guidance: number; seed: number | null; stability: number; similarity: number; style: number; speed: number; model: "eleven_ttv_v3" } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const input = raw as Record<string, unknown>;
    const prompt = typeof input.description === "string" ? input.description.trim() : "";
    const previewText = typeof input.previewText === "string" ? input.previewText.trim() : "";
    const option = <T extends string>(key: string, values: readonly T[]): T | null => typeof input[key] === "string" && values.includes(input[key] as T) ? input[key] as T : null;
    const age = option("age", ["youthful", "young_adult", "mature", "older"] as const);
    const pitch = option("pitch", ["low", "mid", "high"] as const);
    const weight = option("weight", ["light", "balanced", "full"] as const);
    const breathiness = option("breathiness", ["clean", "soft", "airy"] as const);
    const texture = option("texture", ["smooth", "warm", "grainy"] as const);
    const accent = option("accent", ["neutral_mandarin", "northern_mandarin", "southern_mandarin", "taiwan_mandarin", "international"] as const);
    const pace = option("pace", ["slow", "balanced", "brisk"] as const);
    const emotion = option("emotion", ["calm", "warm", "bright", "intimate", "dramatic"] as const);
    const intimacy = option("intimacy", ["reserved", "close", "very_close"] as const);
    const number = (key: string, min: number, max: number) => typeof input[key] === "number" && Number.isFinite(input[key]) && Number(input[key]) >= min && Number(input[key]) <= max ? Number(input[key]) : NaN;
    const loudness = number("loudness", -1, 1); const guidance = number("guidance", 0, 100);
    const stability = number("stability", 0, 1); const similarity = number("similarity", 0, 1); const style = number("style", 0, 1); const speed = number("speed", 0.7, 1.2);
    const seed = input.seed === null ? null : typeof input.seed === "number" && Number.isInteger(input.seed) && input.seed >= 0 && input.seed <= 2_147_483_647 ? input.seed : NaN;
    const quality = input.quality === "fast" ? 0.3 : input.quality === "high" ? 0.95 : input.quality === "balanced" ? 0.7 : NaN;
    if (prompt.length < 20 || prompt.length > 700 || (previewText.length > 0 && previewText.length < 100) || previewText.length > 1000 || !age || !pitch || !weight || !breathiness || !texture || !accent || !pace || !emotion || !intimacy || [loudness, quality, guidance, stability, similarity, style, speed].some(Number.isNaN) || (seed !== null && Number.isNaN(seed))) return null;
    const profile = [
      { youthful: "youthful", young_adult: "young adult", mature: "mature", older: "older" }[age],
      { low: "low pitch", mid: "mid pitch", high: "high pitch" }[pitch],
      { light: "light vocal weight", balanced: "balanced vocal weight", full: "full vocal weight" }[weight],
      { clean: "clean breath support", soft: "soft breathiness", airy: "pronounced airy breathiness" }[breathiness],
      { smooth: "smooth texture", warm: "warm texture", grainy: "subtle grain" }[texture],
      { neutral_mandarin: "neutral Standard Mandarin", northern_mandarin: "northern Mandarin", southern_mandarin: "southern Mandarin", taiwan_mandarin: "Taiwan Mandarin", international: "international Mandarin" }[accent],
      { slow: "unhurried pace", balanced: "natural pace", brisk: "brisk pace" }[pace],
      { calm: "calm emotion", warm: "warm emotion", bright: "bright emotion", intimate: "intimate emotion", dramatic: "dramatic emotion" }[emotion],
      { reserved: "reserved listener distance", close: "close listener distance", very_close: "very close listener distance" }[intimacy],
    ].join(", ");
    const description = `${prompt}\nVoice profile: ${profile}.`.slice(0, 1000);
    return { description, previewText, age, pitch, weight, breathiness, texture, accent, pace, emotion, intimacy, loudness, quality, guidance, seed: seed as number | null, stability, similarity, style, speed, model: "eleven_ttv_v3" };
  }

  private persistableVoiceSettings(settings: ReturnType<OperiaAgentRuntime["readVoiceSettings"]>) {
    if (!settings) return {};
    const { description: _description, previewText: _previewText, ...persistable } = settings;
    return persistable;
  }

  private async transcribeVoice(request: Request): Promise<Response> {
    if (this.env.VOICE_ENABLED?.trim().toLowerCase() !== "true") return json({ error: "voice_disabled" }, { status: 503 });
    const form = await request.formData();
    const entry = form.get("file");
    if (!entry || typeof entry !== "object" || !("arrayBuffer" in entry) || !("size" in entry) || !("type" in entry)) return json({ error: "invalid_audio" }, { status: 422 });
    const file = entry as Blob & { name?: string };
    if (file.size < 1 || file.size > 20 * 1024 * 1024) return json({ error: "invalid_audio" }, { status: 422 });
    const result = await this.providerRegistry().invoke({ provider: "elevenlabs", operation: "stt", input: {
      audio: new Uint8Array(await file.arrayBuffer()), contentType: file.type || "audio/ogg", fileName: file.name,
    } });
    return json({ text: result.text, language: result.languageCode, provider: "elevenlabs" });
  }

  private async synthesizeVoiceService(body: Record<string, unknown>): Promise<Response> {
    if (this.env.VOICE_ENABLED?.trim().toLowerCase() !== "true") return json({ error: "voice_disabled" }, { status: 503 });
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const mode = body.mode === "realtime" || body.mode === "quality" ? body.mode : "expressive";
    if (!text || text.length > 4000) return json({ error: "invalid_speech_text" }, { status: 422 });
    const voice = this.defaultVoiceProfile();
    if (!voice) return json({ error: "voice_default_not_configured" }, { status: 409 });
    const result = await this.providerRegistry().invoke({ provider: "elevenlabs", operation: "tts", input: {
      voiceId: voice.voiceId, text, modelId: this.voiceModelId(mode), outputFormat: "opus_48000_64", voiceSettings: voice.voiceSettings,
    } });
    const mediaRef = await this.storeProviderMedia(result.audio, result.contentType, "voice");
    this.audit("voice.synthesized", "context-service", null, { characters: text.length, mode });
    return json({ mediaRef, kind: "voice", contentType: result.contentType, mode });
  }

  private voiceModelId(mode: "realtime" | "quality" | "expressive"): string {
    if (mode === "realtime") return "eleven_flash_v2_5";
    if (mode === "quality") return "eleven_multilingual_v2";
    return "eleven_v3";
  }

  private async readProviderMedia(id: string): Promise<Response> {
    const object = await this.env.MEDIA.get(id);
    if (!object) return json({ error: "media_not_found" }, { status: 404 });
    const expiresAt = object.customMetadata?.expiresAt;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      await this.env.MEDIA.delete(id);
      return json({ error: "media_expired" }, { status: 410 });
    }
    const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
    object.writeHttpMetadata(headers);
    if (object.customMetadata?.kind) headers.set("x-operia-media-kind", object.customMetadata.kind);
    return new Response(object.body, { headers });
  }

  private async createMusicSharePoster(body: Record<string,unknown>): Promise<Response> {
    if (Object.keys(body).some((key) => !["coverUrl","variant","capsuleHash"].includes(key))) return json({ error:"music_poster_input_invalid" },{ status:422 });
    const coverUrl = typeof body.coverUrl === "string" ? body.coverUrl : "";
    if (body.variant !== "p1" && body.variant !== "p2") return json({ error:"music_poster_variant_invalid" },{ status:422 });
    const variant: MusicPosterVariant = body.variant;
    if (typeof body.capsuleHash !== "string" || !/^[a-f0-9]{64}$/.test(body.capsuleHash)) return json({ error:"music_poster_hash_invalid" },{ status:422 });
    let url: URL;
    try { url = new URL(coverUrl); } catch { return json({ error:"music_poster_cover_invalid" },{ status:422 }); }
    if (url.protocol !== "https:" || !/^p[1-4]\.music\.126\.net$/i.test(url.hostname) || url.username || url.password || url.port || url.hash || [...url.searchParams.keys()].some((key) => key !== "param")) {
      return json({ error:"music_poster_cover_invalid" },{ status:422 });
    }
    let response: Response;
    try { response = await fetch(url,{ redirect:"error",signal:AbortSignal.timeout(2_500) }); }
    catch { return json({ error:"music_poster_cover_unavailable" },{ status:502 }); }
    if (!response.ok) return json({ error:`music_poster_cover_http_${response.status}` },{ status:502 });
    const contentType = (response.headers.get("content-type") ?? "").split(";",1)[0].toLowerCase();
    if (!new Set(["image/jpeg","image/png","image/webp"]).has(contentType)) return json({ error:"music_poster_cover_type" },{ status:422 });
    let cover: Uint8Array;
    try { cover = await this.readBoundedBody(response,3*1024*1024,"music_poster_cover_size"); }
    catch { return json({ error:"music_poster_cover_size" },{ status:422 }); }
    const png = await renderMusicSharePoster(cover,contentType,variant);
    const mediaRef = await this.storeProviderMedia(png,"image/png","image");
    this.audit("presentation.music_poster.created","context-service:telegram-agent",body.capsuleHash.slice(0,16),{ variant,bytes:png.byteLength });
    return json({ mediaRef,kind:"image",contentType:"image/png",variant });
  }

  private base64ToBytes(value: string): Uint8Array {
    const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  private async readBoundedBody(response: Response, maximumBytes: number, errorCode: string): Promise<Uint8Array> {
    const declaredHeader = response.headers.get("content-length");
    const declared = declaredHeader === null ? null : Number(declaredHeader);
    if (declared !== null && Number.isFinite(declared) && (declared < 1 || declared > maximumBytes)) throw new Error(errorCode);
    if (!response.body) throw new Error(errorCode);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel(errorCode);
          throw new Error(errorCode);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (total < 1) throw new Error(errorCode);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  private async withBrowserIdempotency(
    request: Request,
    operation: string,
    body: Record<string, unknown>,
    action: () => Promise<Response>,
    singleFlight = false,
  ): Promise<Response> {
    const rawKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!/^[A-Za-z0-9:_-]{16,200}$/.test(rawKey)) return json({ error: "idempotency_key_required" }, { status: 400 });
    const key = `browser:${rawKey}`;
    const boundOperation = `${operation}:${await this.sha256(JSON.stringify(body))}`;
    const existing = this.sql<{ operation: string; status: string; response_json: string | null }>`SELECT operation,status,response_json FROM idempotency_keys WHERE key=${key}`[0];
    if (existing) {
      if (existing.operation !== boundOperation) return json({ error: "idempotency_key_reused" }, { status: 409 });
      if (existing.status === "completed" && existing.response_json) {
        const saved = this.parseJson<{ status: number; body: unknown }>(existing.response_json, { status: 500, body: { error: "invalid_idempotent_response" } });
        return json(saved.body, { status: saved.status });
      }
      return json({ error: "operation_in_progress" }, { status: 409 });
    }
    const now = new Date().toISOString();
    this.sql`INSERT INTO idempotency_keys (key,operation,status,created_at,expires_at)
      VALUES (${key},${boundOperation},'started',${now},${new Date(Date.now() + 24 * 60 * 60_000).toISOString()})`;
    const lockKey = `browser-lock:${boundOperation}`;
    if (singleFlight) {
      this.sql`DELETE FROM idempotency_keys WHERE key=${lockKey} AND expires_at < ${now}`;
      const lock = this.sql<{ key: string }>`INSERT OR IGNORE INTO idempotency_keys (key,operation,status,created_at,expires_at)
        VALUES (${lockKey},${boundOperation},'started',${now},${new Date(Date.now() + 2 * 60_000).toISOString()}) RETURNING key`;
      if (lock.length !== 1) {
        this.sql`DELETE FROM idempotency_keys WHERE key=${key} AND status='started'`;
        return json({ error: "equivalent_operation_in_progress" }, { status: 409 });
      }
    }
    try {
      const response = await action();
      const responseBody = await response.clone().json().catch(() => ({ error: "non_json_response" }));
      this.sql`UPDATE idempotency_keys SET status='completed',response_json=${JSON.stringify({ status: response.status, body: responseBody })} WHERE key=${key}`;
      return response;
    } catch (error) {
      this.sql`DELETE FROM idempotency_keys WHERE key=${key} AND status='started'`;
      throw error;
    } finally {
      if (singleFlight) this.sql`DELETE FROM idempotency_keys WHERE key=${lockKey}`;
    }
  }

  private async sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  override validateStateChange(_nextState: RuntimeState, source: "server" | Connection): void {
    if (source !== "server") throw new Error("client_state_mutation_forbidden");
  }

  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
    if (ctx.name !== "delegated-tool-task") return;
    const taskId = typeof ctx.metadata?.taskId === "string" ? ctx.metadata.taskId : "";
    if (!taskId) return { status: "error", error: "missing_task_id" };
    if (this.sandboxControlSnapshot().paused) {
      const current = this.readTaskCheckpoint(taskId);
      return { status: "interrupted", reason: "sandbox_global_pause_active", snapshot: current };
    }
    try {
      const uncertain = this.markStartedSideEffectsUncertain(taskId, "fiber_recovered");
      const current = this.readTaskCheckpoint(taskId);
      const recovered = normalizeRecoveredCheckpoint(current, uncertain);
      if (recovered.status === "attention_required") {
        this.persistTaskCheckpoint(recovered);
        return { status: "interrupted", reason: recovered.error ?? "uncertain_tool_side_effect", snapshot: recovered };
      }
      if (recovered.status !== current.status) this.persistTaskCheckpoint(recovered);
      const checkpoint = await this.runDelegatedTask(taskId, recovered);
      const mapped = mapRecoveredCheckpoint(checkpoint);
      return { ...mapped, snapshot: checkpoint } as FiberRecoveryResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : "task_recovery_failed";
      const current = this.readTaskCheckpoint(taskId);
      if (["failed", "cancelled", "completed", "approval_required"].includes(current.status)) {
        return { ...mapRecoveredCheckpoint(current), snapshot: current } as FiberRecoveryResult;
      }
      if (!['attention_required', 'paused'].includes(current.status)) this.failDelegatedTask(taskId, message, "interrupted");
      return { status: "error", error: message, snapshot: current };
    }
  }

  private healthSnapshot() {
    const mcp = this.sql<CountRow>`SELECT COUNT(*) AS count FROM mcp_registry WHERE enabled = 1`[0]?.count ?? 0;
    const pending = this.sql<CountRow>`SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'`[0]?.count ?? 0;
    return { ok: true, service: "<AGENT_SERVICE>-runtime", schemaVersion: this.state.schemaVersion, enabledMcpServers: mcp, pendingApprovals: pending, timestamp: new Date().toISOString() };
  }

  private runtimeSnapshot() {
    const mcpServers = this.sql<CountRow>`SELECT COUNT(*) AS count FROM mcp_registry`[0]?.count ?? 0;
    const approvals = this.sql<CountRow>`SELECT COUNT(*) AS count FROM approvals`[0]?.count ?? 0;
    const jobs = this.sql<CountRow>`SELECT COUNT(*) AS count FROM jobs`[0]?.count ?? 0;
    const auditEvents = this.sql<CountRow>`SELECT COUNT(*) AS count FROM audit_log`[0]?.count ?? 0;
    const idempotencyKeys = this.sql<CountRow>`SELECT COUNT(*) AS count FROM idempotency_keys`[0]?.count ?? 0;
    const approvalTickets = Object.fromEntries(this.sql<{ status: string; count: number }>`
      SELECT status,COUNT(*) AS count FROM approval_ticket_calls GROUP BY status`
      .map((row) => [row.status, row.count]));
    const sideEffects = Object.fromEntries(this.sql<{ status: string; count: number }>`
      SELECT status,COUNT(*) AS count FROM tool_side_effects GROUP BY status`
      .map((row) => [row.status, row.count]));
    const delegatedTasks = Object.fromEntries(this.sql<{ status: string; count: number }>`
      SELECT status,COUNT(*) AS count FROM delegated_tasks GROUP BY status`
      .map((row) => [row.status, row.count]));
    const liveTasks = this.sql<CountRow>`SELECT COUNT(*) AS count FROM delegated_tasks
      WHERE status NOT IN ('completed','failed','cancelled','attention_required')`[0]?.count ?? 0;
    const liveApprovalTickets = this.sql<CountRow>`SELECT COUNT(*) AS count FROM approval_ticket_calls
      WHERE status IN ('pending','decision_reserved','consuming')`[0]?.count ?? 0;
    const unknownSideEffects = this.sql<CountRow>`SELECT COUNT(*) AS count FROM tool_side_effects
      WHERE status IN ('uncertain','unknown')`[0]?.count ?? 0;
    return {
      identity: { name: this.name, class: "OperiaAgentRuntime" },
      state: { schemaVersion: this.state.schemaVersion, initializedAt: this.state.initializedAt, updatedAt: this.state.updatedAt },
      capabilities: capabilitySnapshot(this.state.capabilities, this.state.capabilityRevisions).map((capability) => ({
        ...capability,
        mutableHere: TELEGRAM_DENY_ONLY_CAPABILITIES.has(capability.id),
      })),
      runtimeRecords: { mcpServers, approvals, jobs, auditEvents, idempotencyKeys },
      mcp: this.listMcpServers(),
      mcpGatewayProjection: this.mcpGatewayProjection(),
      freezeState: {
        observedAt: new Date().toISOString(),
        liveTasks,
        liveApprovalTickets,
        unknownSideEffects,
        delegatedTasks,
        approvalTickets,
        sideEffects,
      },
    };
  }

  private serviceRuntimeSnapshot() {
    const providers = this.sql<{ health_status: string; count: number }>`
      SELECT health_status, COUNT(*) AS count FROM mcp_registry WHERE enabled = 1 GROUP BY health_status`;
    const tasks = this.sql<{ status: string; count: number }>`
      SELECT status, COUNT(*) AS count FROM delegated_tasks GROUP BY status`;
    const capabilities = capabilitySnapshot(this.state.capabilities, this.state.capabilityRevisions);
    const plannerToday = this.plannerUsageToday();
    const providerDetails = this.sql<{ id: string; name: string; enabled: number; health_status: string; tool_allowlist_json: string; last_checked_at: string | null }>`
      SELECT id,name,enabled,health_status,tool_allowlist_json,last_checked_at FROM mcp_registry ORDER BY name`.map((row) => ({
        id: row.id, name: row.name, enabled: row.enabled === 1, health: row.health_status,
        toolCount: this.parseJson<string[]>(row.tool_allowlist_json, []).length, lastCheckedAt: row.last_checked_at,
      }));
    return {
      configured: true,
      schemaVersion: this.state.schemaVersion,
      capabilities,
      summary: {
        enabled: capabilities.filter((item) => item.status === "enabled").length,
        disabled: capabilities.filter((item) => item.status !== "enabled").length,
      },
      providers: Object.fromEntries(providers.map((row) => [row.health_status || "unknown", row.count])),
      providerDetails,
      tasks: Object.fromEntries(tasks.map((row) => [row.status, row.count])),
      limits: {
        maxToolCalls: MAX_TOOL_CALLS,
        maxContinuationRounds: MAX_CONTINUATION_ROUNDS,
        providerTimeoutMs: Math.max(1_000, Math.min(60_000, Number(this.env.PROVIDER_TIMEOUT_MS) || 15_000)),
        maxMediaBytes: 20 * 1024 * 1024,
        mediaRetentionHours: 24,
        plannerModel: this.plannerModel(),
        plannerDailyBudget: this.plannerDailyBudget(),
        plannerCallsToday: plannerToday.calls,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  private serviceOperationsProjection(binding: { ownerId: string; serviceId: string }): Record<string, unknown> {
    const taskRows = this.sql<{ id: string; status: string; input_json: string; created_at: string; updated_at: string }>`
      SELECT id,status,input_json,created_at,updated_at FROM delegated_tasks
      WHERE owner_id=${binding.ownerId} AND service_id=${binding.serviceId}
      ORDER BY updated_at DESC LIMIT 20`;
    const tasks: Record<string, unknown>[] = [];
    for (const row of taskRows) {
      const snapshot = this.taskProgressSnapshot(row.id);
      tasks.push(snapshot ?? {
        taskId: row.id,
        status: row.status,
        updatedAt: row.updated_at,
        controls: { pause: false, resume: false, stop: !["completed", "failed", "cancelled"].includes(row.status) },
      });
    }

    const approvals = this.sql<ApprovalTicketRow & { created_at: string }>`SELECT a.* FROM approval_ticket_calls a
      JOIN delegated_tasks t ON t.id=a.task_id
      WHERE a.owner_id=${binding.ownerId} AND t.owner_id=${binding.ownerId} AND t.service_id=${binding.serviceId}
        AND a.status IN ('pending','decision_reserved','attention_required')
      ORDER BY a.created_at DESC LIMIT 30`.map((ticket) => {
        const preview = this.parseJson<Record<string, unknown>>(ticket.preview_json, {});
        return {
          ticketId: ticket.id,
          taskId: ticket.task_id,
          approvalRound: ticket.approval_round,
          status: ticket.status,
          providerId: ticket.server_id,
          toolName: ticket.tool_name,
          argsHash: ticket.args_hash,
          policyVersion: ticket.policy_version,
          riskLevel: typeof preview.riskLevel === "string" ? preview.riskLevel : "unknown",
          expiresAt: ticket.expires_at,
          createdAt: ticket.created_at,
          actionable: ticket.status === "pending" && Date.parse(ticket.expires_at) > Date.now(),
        };
      });

    const elicitations = this.sql<McpElicitationTicketRow>`SELECT * FROM mcp_elicitation_tickets
      WHERE owner_id=${binding.ownerId} AND service_id=${binding.serviceId}
        AND status IN ('pending','decision_ready','attention_required')
      ORDER BY created_at DESC LIMIT 30`.map((ticket) => {
        const request = this.parseJson<McpElicitationRequest>(ticket.request_json, { mode: ticket.mode, message: "MCP requests input." });
        const origin = request.mode === "url" && request.url ? new URL(request.url).origin : undefined;
        return {
          ticketId: ticket.id,
          taskId: ticket.task_id,
          status: ticket.status,
          providerId: ticket.provider_id,
          toolName: ticket.tool_name,
          mode: ticket.mode,
          summary: String(request.message || "MCP requests input.").replace(/\s+/g, " ").slice(0, 280),
          origin,
          expiresAt: ticket.expires_at,
          createdAt: ticket.created_at,
          actionable: ticket.status === "pending" && !mcpElicitationExpired(ticket.expires_at),
          workbenchUrl: `https://agent.example.com/tools/mcp#elicitation=${encodeURIComponent(ticket.id)}`,
        };
      });

    const skills = this.installedSkills(true).slice(0, 50).map(({ alias, revision, enabled, skill }) => ({
      alias,
      revision,
      key: skill.key,
      version: skill.version,
      kind: skill.kind,
      description: skill.description.slice(0, 280),
      enabled,
      mutableHere: true,
    }));
    const attention = [
      ...tasks.filter((task) => task.status === "attention_required").map((task) => ({
        kind: "task", id: task.taskId, status: task.status, summary: "任务需要人工检查；不会自动重放未知副作用。",
      })),
      ...approvals.filter((ticket) => ticket.status === "attention_required").map((ticket) => ({
        kind: "approval", id: ticket.ticketId, status: ticket.status, summary: "审批投递结果需要人工检查。",
      })),
      ...elicitations.filter((ticket) => ticket.status === "attention_required").map((ticket) => ({
        kind: "elicitation", id: ticket.ticketId, status: ticket.status, summary: "MCP 输入恢复需要人工检查。",
      })),
    ].slice(0, 30);

    return {
      schemaVersion: 1,
      owner: "agent.example.com",
      observedAt: new Date().toISOString(),
      tasks,
      approvals,
      elicitations,
      skills,
      capabilities: capabilitySnapshot(this.state.capabilities, this.state.capabilityRevisions).map((capability) => ({
        ...capability,
        mutableHere: TELEGRAM_DENY_ONLY_CAPABILITIES.has(capability.id),
      })),
      attention,
    };
  }

  private serviceTrace() {
    return this.sql<{ event_type: string; actor: string; target: string | null; created_at: string }>`
      SELECT event_type, actor, target, created_at FROM audit_log
      WHERE created_at >= datetime('now', '-7 days') ORDER BY created_at DESC LIMIT 100`.map((row) => ({
        eventType: row.event_type,
        actor: row.actor,
        target: row.target && row.target.includes("/") && row.target.length <= 120 ? row.target : null,
        createdAt: row.created_at,
      }));
  }

  private async readDashboardHealthProjection(signal: AbortSignal): Promise<Record<string, unknown>> {
    const service = this.env.HEALTH_SERVICE;
    const bearer = this.env.HEALTH_SERVICE_BEARER?.trim();
    if (!this.healthProviderEnabled() || !service || !bearer) throw new Error("health_service_not_configured");
    const response = await service.fetch(new Request("https://health.internal/service/health/projection?range=30", {
      method: "GET",
      signal,
      headers: { authorization: `Bearer ${bearer}`, "x-health-client": "operia-dashboard" },
    }));
    if (!response.ok) throw new Error(`health_service_http_${response.status}`);
    const bytes = await this.readBoundedBody(response, 128 * 1024, "health_projection_size");
    const projection = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (projection.ownerDomain !== "health.example.com" || projection.schemaVersion !== 1
      || projection.disclaimer !== "informational_not_medical_diagnosis" || !Array.isArray(projection.series)) {
      throw new Error("health_projection_schema_drift");
    }
    return projection;
  }

  private async readDashboardNoteProjection(ownerId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const service = this.env.NOTE_SERVICE;
    const bearer = this.env.NOTE_SERVICE_BEARER?.trim();
    if (!service || !bearer) throw new Error("note_service_not_configured");
    const headers = { authorization: `Bearer ${bearer}`, "x-operia-owner-id": ownerId, accept: "application/json" };
    const [lifeResponse, itemsResponse] = await Promise.all([
      service.fetch(new Request("https://<NOTE_SERVICE>.internal/service/note/projection/life", { signal, headers })),
      service.fetch(new Request("https://<NOTE_SERVICE>.internal/service/note/items?status=active&limit=50", { signal, headers })),
    ]);
    if (!lifeResponse.ok || !itemsResponse.ok) throw new Error(`note_service_http_${lifeResponse.status}_${itemsResponse.status}`);
    const [lifeBytes, itemBytes] = await Promise.all([
      this.readBoundedBody(lifeResponse, 64 * 1024, "note_life_projection_size"),
      this.readBoundedBody(itemsResponse, 128 * 1024, "note_items_projection_size"),
    ]);
    const projection = JSON.parse(new TextDecoder().decode(lifeBytes)) as Record<string, unknown>;
    const itemPayload = JSON.parse(new TextDecoder().decode(itemBytes)) as { data?: unknown };
    if (projection.ownerDomain !== "note.example.com" || !Array.isArray(itemPayload.data)) {
      throw new Error("note_projection_schema_drift");
    }
    const items = itemPayload.data.slice(0, 50).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      if (typeof item.id !== "string" || (item.kind !== "memo" && item.kind !== "todo") || typeof item.title !== "string") return [];
      return [{
        id: item.id,
        kind: item.kind,
        title: item.title.slice(0, 240),
        todoState: item.todoState === "open" || item.todoState === "completed" ? item.todoState : null,
        dueAt: typeof item.dueAt === "string" ? item.dueAt : null,
        position: typeof item.position === "number" ? item.position : null,
        revision: typeof item.revision === "number" ? item.revision : 0,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
      }];
    });
    return { ...projection, items };
  }

  private async readDashboardMemoryProjection(signal: AbortSignal): Promise<Record<string, unknown>> {
    const memoryBearer = this.env.AGENT_MEMORY_MCP_BEARER?.trim();
    const controlBearer = this.env.MEMORY_CONTROL_SERVICE_BEARER?.trim();
    if (!this.env.MEMORY_MCP || (!memoryBearer && !controlBearer)) throw new Error("memory_service_not_configured");

    const readJson = async (request: Request, maximumBytes: number, errorCode: string): Promise<Record<string, unknown>> => {
      const response = await this.env.MEMORY_MCP.fetch(request);
      if (!response.ok) throw new Error(`${errorCode}_http_${response.status}`);
      const bytes = await this.readBoundedBody(response, maximumBytes, `${errorCode}_size`);
      const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${errorCode}_schema_drift`);
      return value as Record<string, unknown>;
    };

    const memoriesPromise = memoryBearer
      ? readJson(new Request("https://<MEMORY_SERVICE>.internal/v1/memories?status=active&limit=50&offset=0", {
        method: "GET",
        signal,
        headers: { authorization: `Bearer ${memoryBearer}`, accept: "application/json" },
      }), 512 * 1024, "memory_items_projection")
      : Promise.reject(new Error("memory_reader_credential_missing"));
    const controlHeaders = controlBearer
      ? {
        authorization: `Bearer ${controlBearer}`,
        accept: "application/json",
        "x-operia-source-domain": "agent.example.com",
        "x-operia-service-id": "operia-dashboard-memory-projection",
      }
      : null;
    const controlPromise = controlHeaders
      ? readJson(new Request("https://<MEMORY_SERVICE>.internal/service/control/effective", {
        method: "GET", signal, headers: controlHeaders,
      }), 64 * 1024, "memory_control_projection")
      : Promise.reject(new Error("memory_control_credential_missing"));
    const cachePromise = controlHeaders
      ? readJson(new Request("https://<MEMORY_SERVICE>.internal/service/control/cache-health?hours=24", {
        method: "GET", signal, headers: controlHeaders,
      }), 128 * 1024, "memory_cache_projection")
      : Promise.reject(new Error("memory_control_credential_missing"));

    const [memoriesResult, controlResult, cacheResult] = await Promise.allSettled([
      memoriesPromise,
      controlPromise,
      cachePromise,
    ]);
    const observedAt = new Date().toISOString();
    const itemPayload = memoriesResult.status === "fulfilled" ? memoriesResult.value : null;
    const itemValues = Array.isArray(itemPayload?.data) ? itemPayload.data : [];
    const items = itemValues.slice(0, 50).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.content !== "string") return [];
      return [{
        id: item.id,
        type: typeof item.type === "string" ? item.type.slice(0, 80) : "memory",
        content: item.content.slice(0, 2_000),
        summary: typeof item.summary === "string" ? item.summary.slice(0, 600) : null,
        runtimePinned: item.runtime_pinned === true || item.pinned === true,
        displayPinned: item.display_pinned === true,
        starred: item.starred === true,
        importance: typeof item.importance === "number" ? item.importance : null,
        confidence: typeof item.confidence === "number" ? item.confidence : null,
        tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20) : [],
        source: typeof item.source === "string" ? item.source.slice(0, 120) : null,
        recallCount: typeof item.recall_count === "number" ? item.recall_count : 0,
        createdAt: typeof item.created_at === "string" ? item.created_at : null,
        updatedAt: typeof item.updated_at === "string" ? item.updated_at : null,
      }];
    });

    const controlPayload = controlResult.status === "fulfilled" ? controlResult.value : null;
    const controlValues = Array.isArray(controlPayload?.values) ? controlPayload.values : [];
    const controls = controlValues.slice(0, 20).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      if (typeof item.key !== "string") return [];
      return [{
        key: item.key.slice(0, 160),
        effectiveValue: item.effectiveValue ?? null,
        effectiveSource: typeof item.effectiveSource === "string" ? item.effectiveSource.slice(0, 120) : "unknown",
        runtimeStatus: typeof item.runtimeStatus === "string" ? item.runtimeStatus.slice(0, 120) : null,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
        deepLink: typeof item.deepLink === "string" ? item.deepLink.slice(0, 500) : null,
      }];
    });

    const cachePayload = cacheResult.status === "fulfilled" ? cacheResult.value : null;
    const numeric = (key: string) => typeof cachePayload?.[key] === "number" ? cachePayload[key] as number : 0;
    const cacheRecent = Array.isArray(cachePayload?.recent) ? cachePayload.recent.slice(0, 10).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      if (typeof row.created_at !== "string") return [];
      return [{
        createdAt: row.created_at,
        model: typeof row.model === "string" ? row.model.slice(0, 160) : "unknown",
        requestKind: typeof row.request_kind === "string" ? row.request_kind.slice(0, 80) : "unknown",
        inputTokens: typeof row.input_tokens === "number" ? row.input_tokens : 0,
        cacheCreationTokens: typeof row.cache_creation_tokens === "number" ? row.cache_creation_tokens : 0,
        cacheReadTokens: typeof row.cache_read_tokens === "number" ? row.cache_read_tokens : 0,
        clientSystemHash: typeof row.client_system_hash === "string" ? row.client_system_hash.slice(0, 24) : null,
      }];
    }) : [];
    const systemHashes = Array.isArray(cachePayload?.by_client_system_hash)
      ? cachePayload.by_client_system_hash.slice(0, 10).flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const row = value as Record<string, unknown>;
        if (typeof row.client_system_hash !== "string") return [];
        return [{
          hash: row.client_system_hash.slice(0, 24),
          requests: typeof row.requests === "number" ? row.requests : 0,
          cacheReadTokens: typeof row.cache_read_tokens === "number" ? row.cache_read_tokens : 0,
        }];
      }) : [];
    const policy = cachePayload?.policy && typeof cachePayload.policy === "object" && !Array.isArray(cachePayload.policy)
      ? cachePayload.policy as Record<string, unknown> : {};
    const sourcesReady = [itemPayload, controlPayload, cachePayload].filter(Boolean).length;

    return {
      owner: "memory.example.com",
      status: sourcesReady === 3 ? "ready" : sourcesReady > 0 ? "partial" : "unavailable",
      observedAt,
      canonicalUrl: "https://memory.example.com",
      items,
      paging: {
        count: items.length,
        hasMore: itemPayload?.paging && typeof itemPayload.paging === "object" && !Array.isArray(itemPayload.paging)
          ? (itemPayload.paging as Record<string, unknown>).has_more === true : false,
      },
      system: {
        ownerVersion: typeof controlPayload?.ownerVersion === "string" ? controlPayload.ownerVersion : null,
        observedAt: typeof controlPayload?.observedAt === "string" ? controlPayload.observedAt : null,
        request: controlPayload?.request && typeof controlPayload.request === "object" && !Array.isArray(controlPayload.request)
          ? controlPayload.request : null,
        controls,
        fingerprints: systemHashes,
      },
      context: {
        windowHours: 24,
        totalRequests: numeric("total_requests"),
        cacheHitRequests: numeric("cache_hit_requests"),
        coldStartRequests: numeric("cold_start_requests"),
        cacheCreationTokens: numeric("cache_creation_total_tokens"),
        cacheReadTokens: numeric("cache_read_total_tokens"),
        inputTokens: numeric("input_total_tokens"),
        promptTokens: numeric("prompt_token_total"),
        cacheHitRequestRate: numeric("cache_hit_request_rate"),
        cacheReadShare: numeric("cache_read_share"),
        policy: {
          promptCacheMode: typeof policy.prompt_cache_mode === "string" ? policy.prompt_cache_mode : null,
          stableTtl: typeof policy.stable_ttl === "string" ? policy.stable_ttl : null,
          conversationTtl: typeof policy.conversation_ttl === "string" ? policy.conversation_ttl : null,
          evaluationWindow: typeof policy.evaluation_window === "string" ? policy.evaluation_window : null,
        },
        recent: cacheRecent,
      },
    };
  }

  private async operiaDashboardProjection(binding: { ownerId: string; serviceId: string }): Promise<Record<string, unknown>> {
    const runtime = this.serviceRuntimeSnapshot();
    const freezeState = this.runtimeSnapshot().freezeState;
    const operations = this.serviceOperationsProjection(binding);
    const heartbeat = this.heartbeatServiceProjection(binding);
    const connectors = await this.mcpGatewayControlSnapshot("agent", { refresh: false, report: false });
    const voice = this.voiceProviderProjection();
    const providerDetails = Array.isArray(runtime.providerDetails) ? runtime.providerDetails : [];
    const connectorProviders = Array.isArray(connectors.providers) ? connectors.providers : [];
    const attention = Array.isArray(operations.attention) ? operations.attention : [];
    const approvals = Array.isArray(operations.approvals) ? operations.approvals : [];
    const [calendarResult, healthResult, noteResult, memoryResult] = await Promise.allSettled([
      this.readCalendarProjection(binding.ownerId, AbortSignal.timeout(4_000)),
      this.readDashboardHealthProjection(AbortSignal.timeout(4_000)),
      this.readDashboardNoteProjection(binding.ownerId, AbortSignal.timeout(4_000)),
      this.readDashboardMemoryProjection(AbortSignal.timeout(4_000)),
    ]);
    const unavailable = (ownerDomain: string) => ({
      ownerDomain,
      status: "unavailable",
      observedAt: new Date().toISOString(),
    });
    const calendar = calendarResult.status === "fulfilled"
      ? calendarResult.value : { ...unavailable("calendar.example.com"), upcoming: [], remainingToday: 0 };
    const health = healthResult.status === "fulfilled"
      ? healthResult.value : { ...unavailable("health.example.com"), range: 30, summary: {}, series: [], timelineEvents: [] };
    const note = noteResult.status === "fulfilled"
      ? noteResult.value : { ...unavailable("note.example.com"), revision: 0, data: { todos: [], events: [] }, items: [] };
    const memory = memoryResult.status === "fulfilled"
      ? memoryResult.value : {
        owner: "memory.example.com",
        status: "unavailable",
        observedAt: new Date().toISOString(),
        canonicalUrl: "https://memory.example.com",
        items: [],
        paging: { count: 0, hasMore: false },
        system: { ownerVersion: null, observedAt: null, request: null, controls: [], fingerprints: [] },
        context: {
          windowHours: 24, totalRequests: 0, cacheHitRequests: 0, coldStartRequests: 0,
          cacheCreationTokens: 0, cacheReadTokens: 0, inputTokens: 0, promptTokens: 0,
          cacheHitRequestRate: 0, cacheReadShare: 0,
          policy: { promptCacheMode: null, stableTtl: null, conversationTtl: null, evaluationWindow: null },
          recent: [],
        },
      };

    return {
      schemaVersion: 3,
      owner: "agent.example.com",
      observedAt: new Date().toISOString(),
      runtime: {
        status: "ready",
        schemaVersion: runtime.schemaVersion,
        capabilities: runtime.summary,
        providers: runtime.providers,
        providerDetails,
        tasks: runtime.tasks,
        limits: runtime.limits,
        freezeState,
      },
      heartbeat,
      connectors: {
        owner: connectors.owner,
        status: connectors.status,
        observedAt: connectors.observedAt,
        executable: connectors.executable,
        providers: connectorProviders,
        canonicalUrl: connectors.canonicalUrl,
      },
      memory,
      voice,
      life: { calendar, health, note },
      services: {
        calendar: {
          owner: "calendar.example.com",
          status: typeof calendar.status === "string" ? calendar.status : "unavailable",
          canonicalUrl: "https://calendar.example.com",
        },
        health: {
          owner: "health.example.com",
          status: typeof health.status === "string" ? health.status : "unavailable",
          canonicalUrl: "https://health.example.com",
        },
        note: {
          owner: "operia-note",
          status: typeof note.status === "string" ? note.status : "unavailable",
          canonicalUrl: "https://tgbot.example.com/miniapp",
        },
      },
      security: {
        liveTasks: Number(freezeState.liveTasks || 0),
        liveApprovalTickets: Number(freezeState.liveApprovalTickets || 0),
        unknownSideEffects: Number(freezeState.unknownSideEffects || 0),
        pendingApprovals: approvals.length,
        attentionRequired: attention.length,
      },
      links: {
        agent: "https://agent.example.com",
        heartbeat: "https://agent.example.com/tools/heartbeat",
        connectors: "https://mcp.example.com",
        memory: "https://memory.example.com",
      },
    };
  }

  private async ensureBuiltinSkills(): Promise<void> {
    const registry = await createDefaultSkillsRegistry();
    const now = new Date().toISOString();
    for (const skill of registry) {
      const manifestHash = await canonicalArgsHash(skill);
      const existing = this.sql<{ manifest_hash: string }>`SELECT manifest_hash FROM skill_versions
        WHERE skill_key=${skill.key} AND version=${skill.version}`[0];
      if (existing && existing.manifest_hash !== manifestHash) {
        this.sql`UPDATE skill_installations SET enabled=0,disabled_reason='builtin_manifest_drift',updated_at=${now}
          WHERE skill_key=${skill.key}`;
        this.recordSkillEvent(null, skill.key, "builtin.verify.rejected", { reason: "manifest_hash_mismatch" });
        continue;
      }
      this.sql`INSERT INTO skill_versions
        (skill_key,version,kind,manifest_json,manifest_hash,schema_hash,source_hash,source_type,source_registry,
          publisher_key_id,publisher_fingerprint,signature,trust_status,published_at,installed_at)
        VALUES (${skill.key},${skill.version},${skill.kind},${JSON.stringify(skill)},${manifestHash},${skill.schemaHash},${skill.sourceHash},
          'builtin_release',NULL,NULL,NULL,NULL,'trusted',${now},${now})
        ON CONFLICT(skill_key,version) DO NOTHING`;
      const alias = skill.key.split("/").at(-1)!.replaceAll("-", "_");
      this.sql`INSERT INTO skill_installations
        (skill_key,alias,pinned_version,manifest_hash,enabled,scope_json,update_policy,revision,installed_by,disabled_reason,created_at,updated_at)
        VALUES (${skill.key},${alias},${skill.version},${manifestHash},${skill.enabled ? 1 : 0},'{}','pinned',1,'builtin_release',NULL,${now},${now})
        ON CONFLICT(skill_key) DO NOTHING`;
    }
  }

  private installedSkills(includeDisabled = false): Array<{ alias: string; revision: number; enabled: boolean; manifestHash: string; skill: SkillRegistryEntry }> {
    const rows = includeDisabled
      ? this.sql<{ alias: string; revision: number; enabled: number; manifest_hash: string; manifest_json: string }>`
          SELECT i.alias,i.revision,i.enabled,i.manifest_hash,v.manifest_json
          FROM skill_installations i JOIN skill_versions v
            ON v.skill_key=i.skill_key AND v.version=i.pinned_version AND v.manifest_hash=i.manifest_hash
          ORDER BY i.alias`
      : this.sql<{ alias: string; revision: number; enabled: number; manifest_hash: string; manifest_json: string }>`
          SELECT i.alias,i.revision,i.enabled,i.manifest_hash,v.manifest_json
          FROM skill_installations i JOIN skill_versions v
            ON v.skill_key=i.skill_key AND v.version=i.pinned_version AND v.manifest_hash=i.manifest_hash
          WHERE i.enabled=1 ORDER BY i.alias`;
    return rows.flatMap((row) => {
      const skill = this.parseJson<SkillRegistryEntry | null>(row.manifest_json, null);
      return skill ? [{ alias: row.alias, revision: Number(row.revision), enabled: row.enabled === 1, manifestHash: row.manifest_hash, skill }] : [];
    });
  }

  private skillControlSnapshot(): Record<string, unknown> {
    return {
      installed: this.sql<RuntimeRow>`SELECT i.skill_key,i.alias,i.pinned_version,i.manifest_hash,i.enabled,i.scope_json,
        i.update_policy,i.revision,i.installed_by,i.disabled_reason,i.created_at,i.updated_at,v.kind,v.source_type,
        v.source_registry,v.publisher_key_id,v.publisher_fingerprint,v.trust_status
        FROM skill_installations i JOIN skill_versions v
          ON v.skill_key=i.skill_key AND v.version=i.pinned_version AND v.manifest_hash=i.manifest_hash
        ORDER BY i.alias`,
      publishers: this.sql<RuntimeRow>`SELECT key_id,fingerprint,source_registry,status,created_at,updated_at
        FROM skill_publishers ORDER BY key_id`,
      runs: this.sql<RuntimeRow>`SELECT id,request_hash,skill_key,skill_version,manifest_hash,installation_revision,
        owner_id,service_id,channel,chat_id,status,planned_call_json,blocked_code,created_at,updated_at
        FROM skill_runs ORDER BY created_at DESC LIMIT 100`,
      events: this.sql<RuntimeRow>`SELECT id,run_id,skill_key,event_type,detail_json,created_at
        FROM skill_run_events ORDER BY created_at DESC LIMIT 100`,
      executionCutover: "deterministic_workflows",
      executorEnabled: true,
    };
  }

  private recordSkillEvent(runId: string | null, skillKey: string, eventType: string, detail: Record<string, unknown>): void {
    this.sql`INSERT INTO skill_run_events (id,run_id,skill_key,event_type,detail_json,created_at)
      VALUES (${crypto.randomUUID()},${runId},${skillKey},${eventType},${JSON.stringify(detail)},${new Date().toISOString()})`;
  }

  private sandboxControlSnapshot(): {
    paused: boolean;
    generation: number;
    reason: string | null;
    resumeExpiresAt: string | null;
    updatedAt: string;
  } {
    const row = this.sql<{ paused: number; generation: number; reason: string | null; resume_expires_at: string | null; updated_at: string }>`
      SELECT paused,generation,reason,resume_expires_at,updated_at FROM sandbox_control_state WHERE id='owner'`[0];
    return {
      paused: row?.paused === 1,
      generation: Number(row?.generation ?? 0),
      reason: row?.reason ?? null,
      resumeExpiresAt: row?.resume_expires_at ?? null,
      updatedAt: row?.updated_at ?? new Date(0).toISOString(),
    };
  }

  private sandboxControlScope(
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
  ): { ownerId: string; chatId: string; threadKey: string; authorityBinding: "private_owner" | "agent_room_owner" } | null {
    if (binding.serviceId !== "telegram-agent") return null;
    const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    const threadKey = typeof body.threadKey === "string" ? body.threadKey : "";
    const authorityBinding = body.authorityBinding === "agent_room_owner" ? "agent_room_owner"
      : body.authorityBinding === "private_owner" ? "private_owner" : null;
    if (!ownerId || ownerId !== binding.ownerId || !authorityBinding) return null;
    if (authorityBinding === "private_owner" && chatId === ownerId && threadKey === "private") {
      return { ownerId, chatId, threadKey, authorityBinding };
    }
    const qaChatId = this.env.AGENT_SANDBOX_QA_CHAT_ID?.trim();
    const qaThreadKey = this.env.AGENT_SANDBOX_QA_THREAD_KEY?.trim();
    if (authorityBinding === "agent_room_owner" && qaChatId && qaThreadKey && chatId === qaChatId && threadKey === qaThreadKey) {
      return { ownerId, chatId, threadKey, authorityBinding };
    }
    return null;
  }

  private sandboxControlProjection() {
    const control = this.sandboxControlSnapshot();
    const activeTasks = this.sql<CountRow>`SELECT COUNT(*) AS count FROM delegated_tasks
      WHERE status IN ('accepted','planning','executing','approval_required','paused')`[0]?.count ?? 0;
    const pendingApprovals = this.sql<CountRow>`SELECT COUNT(*) AS count FROM approval_ticket_calls
      WHERE status IN ('pending','decision_reserved','consuming')`[0]?.count ?? 0;
    const unknownSideEffects = this.sql<CountRow>`SELECT COUNT(*) AS count FROM tool_side_effects
      WHERE status='uncertain'
         OR (status='quarantined' AND (provider_call_completed=0 OR response_json IS NULL))`[0]?.count ?? 0;
    return {
      ...control,
      activeTasks,
      pendingApprovals,
      unknownSideEffects,
      sandboxEnabled: this.sandboxEnabled(),
      p2ReadEnabled: this.sandboxP2ReadEnabled(),
      codeModeEnabled: this.sandboxCodeModeEnabled(),
      selfManageWriteEnabled: this.selfManageWriteEnabled(),
      resumeRequiresCallback: true,
    };
  }

  private async handleSandboxControl(
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
  ): Promise<Response> {
    const scope = this.sandboxControlScope(body, binding);
    if (!scope) return json({ error: "sandbox_control_scope_mismatch" }, { status: 403 });
    const action = String(body.action ?? "status");
    if (action === "status") return json({ ok: true, action, control: this.sandboxControlProjection() });
    if (action === "pause") {
      const current = this.sandboxControlSnapshot();
      if (current.paused) return json({ ok: true, action, alreadyPaused: true, control: this.sandboxControlProjection() });
      const now = new Date().toISOString();
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 240) : "owner_slash_pause";
      this.sql`UPDATE sandbox_control_state SET paused=1,generation=generation+1,reason=${reason},
        resume_nonce_hash=NULL,resume_expires_at=NULL,updated_at=${now} WHERE id='owner' AND paused=0`;
      const cancelledApprovals = this.sql<{ id: string }>`UPDATE approval_ticket_calls SET status='cancelled',consumed_at=${now}
        WHERE status IN ('pending','decision_reserved','consuming') RETURNING id`;
      for (const ticket of cancelledApprovals) this.scrubApprovalPayload(ticket.id);
      this.sql`UPDATE browser_domain_grants SET status='revoked',updated_at=${now} WHERE status='active'`;
      this.sql`UPDATE approval_task_grants SET status='revoked',updated_at=${now} WHERE status='active'`;
      this.sql`UPDATE browser_domain_challenges SET status='cancelled',updated_at=${now} WHERE status='pending'`;
      this.sql`UPDATE browser_task_leases SET state='paused',step_once=0,revision=revision+1,updated_at=${now} WHERE state='active'`;
      this.sql`UPDATE browser_executions SET status='paused',updated_at=${now} WHERE status='running'`;
      const startedSideEffects = this.sql<{ call_key: string }>`SELECT call_key FROM tool_side_effects
        WHERE status='started'`;
      const quarantinedSideEffects: { call_key: string }[] = [];
      for (const sideEffect of startedSideEffects) {
        try {
          const prior = loadReplayState(this.sql as unknown as SideEffectSql, sideEffect.call_key);
          if (prior?.status === "started" && prior?.dispatchState === "dispatched" && !prior?.providerCallCompleted) {
            quarantineInFlight(this.sql as unknown as SideEffectSql, { callKey: sideEffect.call_key, now });
            quarantinedSideEffects.push(sideEffect);
          } else if (prior?.providerCallCompleted && prior?.responseJson) {
            quarantinePreservingReceipt(this.sql as unknown as SideEffectSql, { callKey: sideEffect.call_key, now });
            quarantinedSideEffects.push(sideEffect);
          }
        } catch {
          // Leave the row in its current state; do not mask a quarantine failure.
        }
      }
      this.sql`UPDATE delegated_tasks SET status='paused',
        checkpoint_json=json_set(COALESCE(checkpoint_json,'{}'),'$.status','paused'),updated_at=${now}
        WHERE status IN ('accepted','planning','executing','approval_required')`;
      this.sql`UPDATE operia_codemode_inner_calls SET
        status=CASE WHEN status='reserved' OR replay_policy='safe_local' THEN 'failed' ELSE 'unknown' END,
        error_code=COALESCE(error_code,'sandbox_global_pause_active'),updated_at=${now}
        WHERE status IN ('reserved','invoking')`;
      this.sql`UPDATE operia_codemode_executions SET status='quarantined',code_text='',error_code='sandbox_global_pause_active',
        lease_owner=NULL,lease_expires_at=NULL,updated_at=${now}
        WHERE status IN ('accepted','executing')`;
      this.activeToolCalls.abortAll("owner_global_pause");
      this.audit("sandbox.global.paused", `telegram:${scope.authorityBinding}`, scope.chatId, {
        generation: current.generation + 1, threadKey: scope.threadKey, reason,
        quarantinedSideEffects: quarantinedSideEffects.length,
      });
      return json({ ok: true, action, control: this.sandboxControlProjection() }, { status: 202 });
    }
    if (action === "prepare_resume") {
      const current = this.sandboxControlSnapshot();
      if (!current.paused) return json({ ok: true, action, alreadyRunning: true, control: this.sandboxControlProjection() });
      const nonce = crypto.randomUUID().replace(/-/g, "");
      const nonceHash = await this.sha256(nonce);
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      this.sql`UPDATE sandbox_control_state SET resume_nonce_hash=${nonceHash},resume_expires_at=${expiresAt},updated_at=${new Date().toISOString()}
        WHERE id='owner' AND paused=1`;
      this.audit("sandbox.global.resume_prepared", `telegram:${scope.authorityBinding}`, scope.chatId, {
        generation: current.generation, threadKey: scope.threadKey, expiresAt,
      });
      return json({ ok: true, action, nonce, expiresAt, control: this.sandboxControlProjection() });
    }
    if (action === "confirm_resume") {
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      if (!/^[a-f0-9]{32}$/.test(nonce)) return json({ error: "sandbox_resume_nonce_invalid" }, { status: 400 });
      const row = this.sql<{ paused: number; generation: number; resume_nonce_hash: string | null; resume_expires_at: string | null }>`
        SELECT paused,generation,resume_nonce_hash,resume_expires_at FROM sandbox_control_state WHERE id='owner'`[0];
      if (!row || row.paused !== 1) return json({ error: "sandbox_not_paused" }, { status: 409 });
      if (!row.resume_nonce_hash || !row.resume_expires_at || Date.parse(row.resume_expires_at) <= Date.now()
        || await this.sha256(nonce) !== row.resume_nonce_hash) {
        return json({ error: "sandbox_resume_nonce_expired" }, { status: 409 });
      }
      const now = new Date().toISOString();
      const changed = this.sql<{ id: string }>`UPDATE sandbox_control_state SET paused=0,reason=NULL,
        resume_nonce_hash=NULL,resume_expires_at=NULL,updated_at=${now}
        WHERE id='owner' AND paused=1 AND resume_nonce_hash=${row.resume_nonce_hash} RETURNING id`;
      if (changed.length !== 1) return json({ error: "sandbox_resume_conflict" }, { status: 409 });
      this.audit("sandbox.global.resumed", `telegram:${scope.authorityBinding}`, scope.chatId, {
        generation: row.generation, threadKey: scope.threadKey, tasksRemainPaused: true,
      });
      return json({ ok: true, action, tasksRemainPaused: true, control: this.sandboxControlProjection() });
    }
    return json({ error: "sandbox_control_action_invalid" }, { status: 400 });
  }

  private async handleSandboxConnector(request: Request, body: Record<string, unknown>): Promise<Response> {
    if (!this.sandboxEnabled()) return json({ error: "sandbox_disabled" }, { status: 404 });
    const secret = this.env.SANDBOX_CAPABILITY_SIGNING_SECRET?.trim();
    const token = request.headers.get("x-sandbox-capability")?.trim();
    const sandboxId = request.headers.get("x-sandbox-id")?.trim();
    if (!secret || !token || !sandboxId) return json({ error: "sandbox_connector_auth_missing" }, { status: 401 });
    const action = String(body.action ?? "");
    const requiredScopes: Record<string, SandboxCapabilityScope> = {
      "synthetic.echo": "synthetic.echo",
      "storage.read": "storage.read",
      "storage.history": "storage.read",
      "storage.append": "storage.write",
      "storage.upsert": "storage.write",
      "storage.write": "storage.write",
      "storage.soft_delete": "storage.soft_delete",
      "storage.restore": "storage.restore",
      "storage.rollback": "storage.restore",
      "storage.purge_status": "storage.read",
      "storage.reclaim_status": "storage.read",
      "system.read": "system.read",
      "health.read": "health.read",
      "calendar.read": "calendar.read",
    };
    const requiredScope = requiredScopes[action];
    if (!requiredScope) return json({ error: "sandbox_connector_action_denied" }, { status: 403 });
    let claims;
    try { claims = await verifySandboxCapability(secret, token, { requiredScope, sandboxId }); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "sandbox_connector_denied" }, { status: 403 }); }
    const task = this.delegatedTaskInput(claims.taskId);
    if (!task || task.ownerId !== claims.ownerId) return json({ error: "sandbox_task_scope_mismatch" }, { status: 403 });
    if (this.sandboxControlSnapshot().paused) return json({ error: "sandbox_global_pause_active" }, { status: 423 });
    const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};
    try {
      let result: unknown;
      if (action === "synthetic.echo") {
        const encoded = JSON.stringify(args.value);
        if (typeof encoded !== "string" || new TextEncoder().encode(encoded).byteLength > 8 * 1024) throw new Error("sandbox_synthetic_value_too_large");
        result = { value: args.value, synthetic: true, policyVersion: "operia-sandbox-v1" };
      } else if (action.startsWith("storage.")) {
        if (
          ["storage.append", "storage.upsert", "storage.write", "storage.soft_delete", "storage.restore", "storage.rollback"].includes(action)
          && !this.selfManageWriteEnabled()
        ) {
          throw new Error("operia_self_manage_write_disabled");
        }
        result = await this.handleOperiaOwnedStorage(action, args, claims.ownerId, claims.taskId);
      } else {
        if (!this.sandboxP2ReadEnabled()) throw new Error("sandbox_p2_read_disabled");
        if (action === "system.read") result = { classification: "internal_status", snapshot: this.healthSnapshot() };
        else if (action === "health.read") result = await this.invokeHealthProvider("health_summary", args, new AbortController().signal);
        else if (action === "calendar.read") result = await this.readSandboxCalendarProjection(claims.ownerId, new AbortController().signal);
        else throw new Error("sandbox_connector_action_denied");
      }
      this.audit("sandbox.connector.completed", `sandbox:${sandboxId}`, claims.taskId, { action, scope: requiredScope });
      return json({ ok: true, action, result, policyVersion: "operia-sandbox-v1" });
    } catch (error) {
      const code = boundedAgentErrorCode(error, "sandbox_connector_failed");
      this.audit("sandbox.connector.denied", `sandbox:${sandboxId}`, claims.taskId, { action, code });
      return json({ error: code }, { status: code.endsWith("_too_large") ? 413 : 409 });
    }
  }

  private async handleOperiaOwnedStorage(
    action: string,
    args: Record<string, unknown>,
    ownerId: string,
    taskId: string,
  ): Promise<unknown> {
    if (args.namespace !== OPERIA_TEST_NAMESPACE) throw new Error("operia_namespace_denied");
    const resourceId = normalizeOperiaResourceId(args.resource_id);
    const current = this.sql<{
      resource_type: string; schema_owner: string; schema_version: string; created_by: string;
      version: number; status: "active" | "tombstoned"; value_json: string; value_bytes: number; value_hash: string;
      restore_deadline: string | null; pinned: number; reference_count: number; legal_hold: number;
      unknown_side_effect: number; created_at: string; updated_at: string;
    }>`SELECT resource_type,schema_owner,schema_version,created_by,version,status,value_json,value_bytes,value_hash,
      restore_deadline,pinned,reference_count,legal_hold,unknown_side_effect,created_at,updated_at
      FROM operia_owned_resources WHERE owner_id=${ownerId} AND namespace=${OPERIA_TEST_NAMESPACE} AND resource_id=${resourceId}`[0];
    if (action === "storage.read") {
      if (!current) throw new Error("operia_resource_not_found");
      return {
        namespace: OPERIA_TEST_NAMESPACE, resourceId, version: current.version, status: current.status,
        resourceType: current.resource_type, schemaOwner: current.schema_owner, schemaVersion: current.schema_version,
        createdBy: current.created_by,
        value: JSON.parse(current.value_json), valueHash: current.value_hash,
        restoreDeadline: current.restore_deadline, pinned: current.pinned === 1,
        referenceCount: current.reference_count, legalHold: current.legal_hold === 1,
        unknownSideEffect: current.unknown_side_effect === 1, updatedAt: current.updated_at,
      };
    }
    if (action === "storage.history") {
      if (!current) throw new Error("operia_resource_not_found");
      const requestedLimit = Number(args.limit ?? 20);
      const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 20;
      const versions = this.sql<{
        version: number; status: string; value_hash: string; value_bytes: number; action: string;
        previous_version: number | null; task_id: string; request_id: string | null; created_at: string;
      }>`SELECT version,status,value_hash,value_bytes,action,previous_version,task_id,request_id,created_at
        FROM operia_owned_resource_versions
        WHERE owner_id=${ownerId} AND namespace=${OPERIA_TEST_NAMESPACE} AND resource_id=${resourceId}
        ORDER BY version DESC LIMIT ${limit}`;
      return {
        namespace: OPERIA_TEST_NAMESPACE,
        resourceId,
        currentVersion: current.version,
        status: current.status,
        restoreDeadline: current.restore_deadline,
        versions,
      };
    }
    if (action === "storage.reclaim_status" || action === "storage.purge_status") {
      if (!current) throw new Error("operia_resource_not_found");
      const decision = evaluateOperiaReclaim({
        status: current.status, restoreDeadline: current.restore_deadline,
        pinned: current.pinned === 1, referenceCount: current.reference_count,
        legalHold: current.legal_hold === 1, unknownSideEffect: current.unknown_side_effect === 1,
      });
      return {
        ...decision,
        physicalPurgePerformed: false,
        ownerReviewRequired: decision.eligible,
        note: "Operia cannot physically purge resources.",
      };
    }

    const envelope = normalizeOperiaMutationEnvelope(args);
    const resourceType = normalizeOperiaResourceType(args.resource_type ?? current?.resource_type);
    if (current && (current.resource_type !== resourceType || current.schema_owner !== envelope.schemaOwner)) {
      throw new Error("operia_resource_classification_changed");
    }
    const requestHash = await canonicalArgsHash({ action, args });
    const replay = this.sql<{ request_hash: string; response_json: string }>`SELECT request_hash,response_json
      FROM operia_owned_mutation_receipts WHERE owner_id=${ownerId} AND namespace=${OPERIA_TEST_NAMESPACE}
        AND idempotency_key=${envelope.idempotencyKey}`[0];
    if (replay) {
      if (replay.request_hash !== requestHash) throw new Error("operia_idempotency_key_reused");
      return { ...this.parseJson<Record<string, unknown>>(replay.response_json, {}), replayed: true };
    }
    const expectedVersion = args.expected_version == null ? null : Number(args.expected_version);
    if (expectedVersion != null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion !== (current?.version ?? 0))) {
      throw new Error("operia_resource_version_conflict");
    }
    const now = new Date().toISOString();
    if (action === "storage.write" || action === "storage.upsert" || action === "storage.append") {
      if (current?.status === "tombstoned") throw new Error("operia_resource_restore_required");
      const previousVersion = current?.version ?? null;
      const nextValue = action === "storage.append"
        ? appendOperiaResourceValue(current ? this.parseJson(current.value_json, null) : undefined, args.item)
        : args.value;
      const value = serializeOperiaResourceValue(nextValue);
      this.assertOperiaOwnerQuota(ownerId, resourceId, value.bytes);
      const version = (current?.version ?? 0) + 1;
      const valueHash = await this.sha256(value.json);
      const response = {
        namespace: OPERIA_TEST_NAMESPACE, resourceId, resourceType, version, status: "active", valueHash,
        bytes: value.bytes, replayed: false,
        undo: operiaUndoSummary({
          action: action === "storage.append" ? "append" : "upsert",
          resourceId, version, previousVersion,
        }),
      };
      this.ctx.storage.transactionSync(() => {
        this.sql`INSERT INTO operia_owned_resource_versions
          (owner_id,namespace,resource_id,resource_type,schema_owner,schema_version,created_by,version,status,
            value_json,value_bytes,value_hash,task_id,request_id,idempotency_key,action,previous_version,policy_version,reason,created_at)
          VALUES (${ownerId},${OPERIA_TEST_NAMESPACE},${resourceId},${resourceType},${envelope.schemaOwner},${envelope.schemaVersion},
            'operia',${version},'active',${value.json},${value.bytes},${valueHash},${taskId},${envelope.requestId},
            ${envelope.idempotencyKey},${action === "storage.append" ? "append" : "upsert"},${previousVersion},
            'operia-sandbox-v1',NULL,${now})`;
        this.sql`INSERT INTO operia_owned_resources
          (owner_id,namespace,resource_id,resource_type,schema_owner,schema_version,created_by,version,status,
            value_json,value_bytes,value_hash,deleted_by_task,delete_reason,restore_deadline,pinned,reference_count,
            legal_hold,unknown_side_effect,last_task_id,last_request_id,last_idempotency_key,policy_version,created_at,updated_at)
          VALUES (${ownerId},${OPERIA_TEST_NAMESPACE},${resourceId},${resourceType},${envelope.schemaOwner},${envelope.schemaVersion},
            'operia',${version},'active',${value.json},${value.bytes},${valueHash},NULL,NULL,NULL,0,0,0,0,
            ${taskId},${envelope.requestId},${envelope.idempotencyKey},'operia-sandbox-v1',${current?.created_at ?? now},${now})
          ON CONFLICT(owner_id,namespace,resource_id) DO UPDATE SET version=${version},status='active',value_json=${value.json},
            value_bytes=${value.bytes},value_hash=${valueHash},schema_version=${envelope.schemaVersion},deleted_by_task=NULL,
            delete_reason=NULL,restore_deadline=NULL,last_task_id=${taskId},last_request_id=${envelope.requestId},
            last_idempotency_key=${envelope.idempotencyKey},policy_version='operia-sandbox-v1',updated_at=${now}`;
        this.saveOperiaMutationReceipt(ownerId, envelope.idempotencyKey, requestHash, action, resourceId, response, now);
      });
      this.audit("operia.resource.written", `task:${taskId}`, resourceId, {
        namespace: OPERIA_TEST_NAMESPACE, action, version, bytes: value.bytes, valueHash,
        requestId: envelope.requestId, idempotencyKey: envelope.idempotencyKey,
      });
      return response;
    }
    if (!current) throw new Error("operia_resource_not_found");
    if (action === "storage.soft_delete") {
      if (current.status === "tombstoned") throw new Error("operia_resource_already_tombstoned");
      const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 500) : "";
      if (!reason) throw new Error("operia_delete_reason_required");
      const version = current.version + 1;
      const restoreDeadline = new Date(Date.now() + OPERIA_TOMBSTONE_RETENTION_MS).toISOString();
      const response = {
        namespace: OPERIA_TEST_NAMESPACE, resourceId, version, status: "tombstoned", restoreDeadline,
        reversible: true, replayed: false,
        undo: operiaUndoSummary({ action: "soft_delete", resourceId, version, previousVersion: current.version, restoreDeadline }),
      };
      this.ctx.storage.transactionSync(() => {
        this.sql`INSERT INTO operia_owned_resource_versions
          (owner_id,namespace,resource_id,resource_type,schema_owner,schema_version,created_by,version,status,
            value_json,value_bytes,value_hash,task_id,request_id,idempotency_key,action,previous_version,policy_version,reason,created_at)
          VALUES (${ownerId},${OPERIA_TEST_NAMESPACE},${resourceId},${resourceType},'operia',${envelope.schemaVersion},'operia',
            ${version},'tombstoned',${current.value_json},${current.value_bytes},${current.value_hash},${taskId},
            ${envelope.requestId},${envelope.idempotencyKey},'soft_delete',${current.version},'operia-sandbox-v1',${reason},${now})`;
        this.sql`UPDATE operia_owned_resources SET version=${version},status='tombstoned',deleted_by_task=${taskId},delete_reason=${reason},
          restore_deadline=${restoreDeadline},schema_version=${envelope.schemaVersion},last_task_id=${taskId},
          last_request_id=${envelope.requestId},last_idempotency_key=${envelope.idempotencyKey},updated_at=${now}
          WHERE owner_id=${ownerId} AND namespace=${OPERIA_TEST_NAMESPACE} AND resource_id=${resourceId}`;
        this.saveOperiaMutationReceipt(ownerId, envelope.idempotencyKey, requestHash, action, resourceId, response, now);
      });
      this.audit("operia.resource.tombstoned", `task:${taskId}`, resourceId, { version, reason, restoreDeadline, reversible: true });
      return response;
    }
    if (action === "storage.restore") {
      if (current.status !== "tombstoned") throw new Error("operia_resource_not_tombstoned");
      if (!current.restore_deadline || Date.parse(current.restore_deadline) <= Date.now()) throw new Error("operia_restore_window_expired");
      this.assertOperiaOwnerQuota(ownerId, resourceId, current.value_bytes);
      const version = current.version + 1;
      const response = {
        namespace: OPERIA_TEST_NAMESPACE, resourceId, version, status: "active", restoredFromVersion: current.version,
        replayed: false,
        undo: operiaUndoSummary({ action: "restore", resourceId, version, previousVersion: current.version }),
      };
      this.ctx.storage.transactionSync(() => {
        this.sql`INSERT INTO operia_owned_resource_versions
          (owner_id,namespace,resource_id,resource_type,schema_owner,schema_version,created_by,version,status,
            value_json,value_bytes,value_hash,task_id,request_id,idempotency_key,action,previous_version,policy_version,reason,created_at)
          VALUES (${ownerId},${OPERIA_TEST_NAMESPACE},${resourceId},${resourceType},'operia',${envelope.schemaVersion},'operia',
            ${version},'active',${current.value_json},${current.value_bytes},${current.value_hash},${taskId},
            ${envelope.requestId},${envelope.idempotencyKey},'restore',${current.version},'operia-sandbox-v1','restore',${now})`;
        this.sql`UPDATE operia_owned_resources SET version=${version},status='active',deleted_by_task=NULL,delete_reason=NULL,
          restore_deadline=NULL,schema_version=${envelope.schemaVersion},last_task_id=${taskId},
          last_request_id=${envelope.requestId},last_idempotency_key=${envelope.idempotencyKey},updated_at=${now}
          WHERE owner_id=${ownerId} AND namespace=${OPERIA_TEST_NAMESPACE} AND resource_id=${resourceId}`;
        this.saveOperiaMutationReceipt(ownerId, envelope.idempotencyKey, requestHash, action, resourceId, response, now);
      });
      this.audit("operia.resource.restored", `task:${taskId}`, resourceId, { version, restoredFromVersion: current.version });
      return response;
    }
    if (action === "storage.rollback") {
      if (current.status !== "active") throw new Error("operia_resource_restore_required");
      const targetVersion = Number(args.target_version);
      if (!Number.isSafeInteger(targetVersion) || targetVersion < 1 || targetVersion >= current.version) {
        throw new Error("operia_rollback_target_invalid");
      }
      const target = this.sql<{ value_json: string; value_bytes: number; value_hash: string; status: string }>`
        SELECT value_json,value_bytes,value_hash,status FROM operia_owned_resource_versions
        WHERE owner_id=${ownerId} AND namespace=${OPERIA_TEST_NAMESPACE} AND resource_id=${resourceId}
          AND version=${targetVersion}`[0];
      if (!target || target.status !== "active") throw new Error("operia_rollback_target_invalid");
      this.assertOperiaOwnerQuota(ownerId, resourceId, target.value_bytes);
      const version = current.version + 1;
      const response = {
        namespace: OPERIA_TEST_NAMESPACE, resourceId, version, status: "active", rolledBackToVersion: targetVersion,
        valueHash: target.value_hash, replayed: false,
        undo: operiaUndoSummary({ action: "rollback", resourceId, version, previousVersion: current.version }),
      };
      this.ctx.storage.transactionSync(() => {
        this.sql`INSERT INTO operia_owned_resource_versions
          (owner_id,namespace,resource_id,resource_type,schema_owner,schema_version,created_by,version,status,
            value_json,value_bytes,value_hash,task_id,request_id,idempotency_key,action,previous_version,policy_version,reason,created_at)
          VALUES (${ownerId},${OPERIA_TEST_NAMESPACE},${resourceId},${resourceType},'operia',${envelope.schemaVersion},'operia',
            ${version},'active',${target.value_json},${target.value_bytes},${target.value_hash},${taskId},
            ${envelope.requestId},${envelope.idempotencyKey},'rollback',${current.version},'operia-sandbox-v1',
            ${`rollback_to:${targetVersion}`},${now})`;
        this.sql`UPDATE operia_owned_resources SET version=${version},value_json=${target.value_json},value_bytes=${target.value_bytes},
          value_hash=${target.value_hash},schema_version=${envelope.schemaVersion},last_task_id=${taskId},
          last_request_id=${envelope.requestId},last_idempotency_key=${envelope.idempotencyKey},updated_at=${now}
          WHERE owner_id=${ownerId} AND namespace=${OPERIA_TEST_NAMESPACE} AND resource_id=${resourceId}`;
        this.saveOperiaMutationReceipt(ownerId, envelope.idempotencyKey, requestHash, action, resourceId, response, now);
      });
      this.audit("operia.resource.rolled_back", `task:${taskId}`, resourceId, { version, targetVersion, valueHash: target.value_hash });
      return response;
    }
    throw new Error("sandbox_connector_action_denied");
  }

  private assertOperiaOwnerQuota(ownerId: string, resourceId: string, nextValueBytes: number): void {
    const usage = this.sql<{ count: number; bytes: number }>`SELECT COUNT(*) AS count,COALESCE(SUM(value_bytes),0) AS bytes
      FROM operia_owned_resources WHERE owner_id=${ownerId} AND namespace=${OPERIA_TEST_NAMESPACE} AND status='active'
      AND resource_id<>${resourceId}`[0];
    if (
      Number(usage?.count ?? 0) + 1 > OPERIA_OWNER_MAX_RESOURCES
      || Number(usage?.bytes ?? 0) + nextValueBytes > OPERIA_OWNER_MAX_BYTES
    ) {
      throw new Error("operia_owner_quota_exceeded");
    }
  }

  private saveOperiaMutationReceipt(
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
    action: string,
    resourceId: string,
    response: Record<string, unknown>,
    createdAt: string,
  ): void {
    this.sql`INSERT INTO operia_owned_mutation_receipts
      (owner_id,namespace,idempotency_key,request_hash,action,resource_id,response_json,created_at)
      VALUES (${ownerId},${OPERIA_TEST_NAMESPACE},${idempotencyKey},${requestHash},${action},${resourceId},
        ${JSON.stringify(response)},${createdAt})`;
  }

  private telegramCommandScope(body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): { ownerId: string; chatId: string } | null {
    const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    if (binding.serviceId !== "telegram-agent" || !ownerId || !chatId) return null;
    if (ownerId !== binding.ownerId || chatId !== ownerId) return null;
    return { ownerId, chatId };
  }

  private async handleTelegramToolCommand(body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): Promise<Response> {
    const scope = this.telegramCommandScope(body, binding);
    if (!scope) return json({ error: "telegram_owner_scope_mismatch" }, { status: 403 });
    await this.syncMcpGatewayProjection();
    const available = this.telegramToolCatalog();
    if (body.action === "catalog") {
      const byServer = new Map<string, typeof available>();
      for (const entry of available) byServer.set(entry.tool.serverId, [...(byServer.get(entry.tool.serverId) ?? []), entry]);
      const ownerSnapshot = this.currentMcpGatewayOwnerSnapshot();
      const gatewayItems = (ownerSnapshot?.providers ?? []).map((provider) => ({
        id: provider.id,
        label: provider.id,
        detail: `${provider.label} · ${byServer.get(provider.id)?.length ?? 0} read tools · owner revision ${provider.ownerRevision}`,
        status: provider.status,
        source: "external",
      }));
      const gatewayIds = new Set(gatewayItems.map((item) => item.label));
      const localItems = [...byServer.entries()].filter(([serverId]) => !gatewayIds.has(serverId)).map(([serverId, entries]) => ({
        id: serverId,
        label: serverId,
        detail: `${entries.length} read tools · Agent-owned provider`,
        status: "enabled",
        source: "internal",
      }));
      return json({
        title: "MCP 状态与 Provider",
        summary: "使用 /mcp <provider> 查看下属工具；斜杠直达仅开放 read-only 工具，其他风险等级仍由主模型进入统一审批链。",
        items: [...gatewayItems, ...localItems],
      });
    }
    if (body.action === "provider" && typeof body.serverId === "string") {
      const ownerProvider = this.currentMcpGatewayOwnerSnapshot()?.providers.find((provider) => provider.id === body.serverId);
      const tools = available.filter((entry) => entry.tool.serverId === body.serverId);
      if (!ownerProvider && tools.length === 0) return json({ error: "telegram_mcp_provider_unknown" }, { status: 404 });
      const projected = new Map(tools.map((entry) => [entry.tool.toolName, entry]));
      const items = ownerProvider
        ? ownerProvider.tools.map((ownerTool) => {
            const executable = projected.get(ownerTool.name);
            return {
              id: ownerTool.name,
              label: ownerTool.name,
              detail: ownerTool.description || executable?.tool.description || "Gateway owner tool",
              status: !ownerTool.enabled ? "disabled" : executable ? executable.tool.riskLevel : "catalog-only",
              source: "external",
              executable: Boolean(ownerTool.enabled && executable),
              ...(executable ? { inputSchema: executable.tool.inputSchema } : {}),
            };
          })
        : tools.map(({ tool }) => ({
            id: tool.toolName,
            label: tool.toolName,
            detail: tool.description,
            status: tool.riskLevel,
            source: "internal",
            executable: true,
            inputSchema: tool.inputSchema,
          }));
      return json({
        title: `MCP：${body.serverId}`,
        summary: ownerProvider
          ? `${ownerProvider.label} · ${ownerProvider.status} · owner revision ${ownerProvider.ownerRevision}`
          : "Agent-owned provider",
        items,
      });
    }
    const hierarchical = body.action === "execute" && typeof body.serverId === "string" && typeof body.toolName === "string";
    const legacy = body.action === "execute" && typeof body.alias === "string";
    if ((!hierarchical && !legacy) || !body.args || typeof body.args !== "object" || Array.isArray(body.args)) {
      return json({ error: "invalid_telegram_tool_command" }, { status: 400 });
    }
    const selected = hierarchical
      ? available.find((item) => item.tool.serverId === body.serverId && item.tool.toolName === body.toolName)
      : available.find((item) => item.alias === body.alias);
    if (!selected) return json({ error: "telegram_tool_not_allowlisted" }, { status: 403 });
    const args = Object.fromEntries(Object.entries(body.args as Record<string, unknown>).map(([key, value]) => [key, this.parseTelegramToolValue(value)]));
    const requestId = typeof body.requestId === "string" && /^[a-z0-9][a-z0-9_-]{0,95}$/i.test(body.requestId)
      ? body.requestId
      : null;
    const result = await this.executeTelegramReadTool(scope, selected.tool.serverId, selected.tool.toolName, args, requestId ? {
      taskId: `tg-command-${requestId}`,
      idempotencyKey: `tg-command:${scope.ownerId}:${requestId}`,
      purpose: "telegram_slash_command",
      durable: true,
    } : undefined);
    if ("pending" in result) {
      return json({
        title: `工具任务已创建：${selected.tool.serverId}/${selected.tool.toolName}`,
        summary: "任务已进入 durable Fiber；如工具请求补充信息，将由同一 taskId 继续。",
        items: [{ label: `${selected.tool.serverId}/${selected.tool.toolName}`, detail: result.taskId, status: result.status }],
        pending: { taskId: result.taskId, toolKey: `${selected.tool.serverId}/${selected.tool.toolName}`, arguments: args },
      }, { status: 202 });
    }
    return json({
      title: `工具已完成：${selected.tool.serverId}/${selected.tool.toolName}`,
      summary: result.payload.slice(0, 1000),
      items: [{ label: `${selected.tool.serverId}/${selected.tool.toolName}`, detail: `${result.payloadBytes} bytes`, status: result.truncated ? "truncated" : "completed" }],
      handoff: { taskId: result.taskId, toolKey: `${selected.tool.serverId}/${selected.tool.toolName}`, arguments: args, result },
    });
  }

  private async handleTelegramSkillCommand(body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): Promise<Response> {
    const scope = this.telegramCommandScope(body, binding);
    if (!scope) return json({ error: "telegram_owner_scope_mismatch" }, { status: 403 });
    const entries = this.installedSkills();
    if (body.action === "catalog") {
      return json({
        title: "Agent Skills",
        summary: "确定性 Workflow 通过 Agent 统一工具链执行；Prompt 与 Reference 作为不可信工具结果交回 Opus。",
        items: entries.map(({ alias, skill }) => ({ label: alias, detail: skill.description, status: skill.kind })),
      });
    }
    if (body.action === "detail" && typeof body.name === "string") {
      const selected = entries.find((entry) => entry.alias === body.name);
      if (!selected) return json({ error: "telegram_skill_not_allowlisted" }, { status: 404 });
      return json({
        title: `Skill：${selected.alias}`,
        summary: selected.skill.description,
        items: [
          { label: "kind", detail: selected.skill.kind, status: selected.enabled ? "enabled" : "disabled" },
          { label: "version", detail: selected.skill.version, status: `revision ${selected.revision}` },
          { label: "调用", detail: `/skills ${selected.alias} run [args]`, status: "manual fallback" },
        ],
      });
    }
    if (body.action !== "execute" || typeof body.name !== "string" || typeof body.args !== "string") {
      return json({ error: "invalid_telegram_skill_command" }, { status: 400 });
    }
    const selected = entries.find((entry) => entry.alias === body.name);
    if (!selected) return json({ error: "telegram_skill_not_allowlisted" }, { status: 403 });
    const registry = entries.map((entry) => entry.skill);
    const resolved = await resolveSkillRegistryEntry(registry, selected.skill.key);
    if (!resolved.ok) return json({ error: resolved.code }, { status: 409 });
    const skillInput = resolved.skill.kind === "prompt" && body.args.trim() && !body.args.trim().startsWith("{")
      ? { goal: body.args.trim() }
      : body.args.trim() ? this.parseJson<unknown>(body.args, null) : {};
    if (!skillInput || typeof skillInput !== "object" || Array.isArray(skillInput)) return json({ error: "telegram_skill_args_must_be_json" }, { status: 400 });
    if (!validateSkillInput(resolved.skill, skillInput as JsonValue)) return json({ error: "invalid_arguments" }, { status: 422 });
    const requestHash = await canonicalArgsHash({ ownerId: scope.ownerId, chatId: scope.chatId, skillKey: selected.skill.key, args: skillInput });
    const existing = this.sql<{ id: string; status: string; state_json: string; planned_call_json: string | null; blocked_code: string | null }>`
      SELECT id,status,state_json,planned_call_json,blocked_code FROM skill_runs WHERE request_hash=${requestHash}`[0];
    if (existing) {
      const replayState = this.parseJson<SkillRunState | Record<string, unknown> | null>(existing.state_json, null);
      if (!replayState) return json({ error: "skill_run_state_invalid" }, { status: 409 });
      return json(await this.executeTelegramSkillRun({
        name: body.name, runId: existing.id, selected, registry, state: replayState,
        skillInput: skillInput as JsonValue, scope, replayed: true,
      }));
    }

    const granted = this.loadExecutableCatalog().catalog.map((tool) => `${tool.serverId}/${tool.toolName}`);
    let state: SkillRunState | Record<string, unknown>;
    if (resolved.skill.kind === "deterministicWorkflow") {
      state = await createSkillRun({
        registry,
        skillKey: selected.skill.key,
        input: skillInput as JsonValue,
        requestHash,
        installationRevision: selected.revision,
        installationEnabled: selected.enabled,
        grantedToolKeys: granted,
      });
    } else {
      state = {
        status: "planned",
        requestHash,
        stateRevision: 0,
        pin: {
          skillKey: resolved.skill.key,
          skillVersion: resolved.skill.version,
          contentHash: resolved.skill.sourceHash,
          schemaHash: resolved.skill.schemaHash,
          installationRevision: selected.revision,
          permissionSnapshot: [],
        },
        input: skillInput,
        completedStepIds: [],
        plannedCall: resolved.skill.kind === "prompt"
          ? { kind: "model_handoff", target: resolved.skill.target }
          : { kind: "reference_handoff", mediaType: resolved.skill.mediaType },
      };
    }
    const runId = crypto.randomUUID();
    const status = String(state.status);
    const planned = status === "planned" && "plannedCall" in state ? state.plannedCall : null;
    const blockedCode = status === "blocked" && "blockedCode" in state ? String(state.blockedCode) : null;
    const permissionSnapshot = "pin" in state && state.pin && typeof state.pin === "object" && "permissionSnapshot" in state.pin
      ? (state.pin as { permissionSnapshot: unknown }).permissionSnapshot : [];
    const now = new Date().toISOString();
    this.sql`INSERT INTO skill_runs
      (id,request_hash,skill_key,skill_version,manifest_hash,installation_revision,owner_id,service_id,channel,chat_id,
        input_json,permission_snapshot_json,status,state_json,planned_call_json,blocked_code,created_at,updated_at)
      VALUES (${runId},${requestHash},${resolved.skill.key},${resolved.skill.version},${selected.manifestHash},${selected.revision},
        ${scope.ownerId},${binding.serviceId},'telegram',${scope.chatId},${JSON.stringify(skillInput)},${JSON.stringify(permissionSnapshot)},
        ${status},${JSON.stringify(state)},${planned ? JSON.stringify(planned) : null},${blockedCode},${now},${now})`;
    this.recordSkillEvent(runId, resolved.skill.key, `run.${status}`, { requestHash, executorCalls: 0 });
    return json(await this.executeTelegramSkillRun({
      name: body.name, runId, selected, registry, state,
      skillInput: skillInput as JsonValue, scope, replayed: false,
    }));
  }

  private async executeTelegramSkillRun(input: {
    name: string;
    runId: string;
    selected: { alias: string; revision: number; enabled: boolean; manifestHash: string; skill: SkillRegistryEntry };
    registry: SkillRegistryEntry[];
    state: SkillRunState | Record<string, unknown>;
    skillInput: JsonValue;
    scope: { ownerId: string; chatId: string };
    replayed: boolean;
  }): Promise<Record<string, unknown>> {
    const stored = input.state as Record<string, unknown>;
    const priorResults = Array.isArray(stored.executionResults) ? stored.executionResults : [];
    if (input.selected.skill.kind !== "deterministicWorkflow") {
      const payload = input.selected.skill.kind === "prompt"
        ? { kind: "prompt", target: input.selected.skill.target, prompt: input.selected.skill.prompt, input: input.skillInput }
        : { kind: "reference", mediaType: input.selected.skill.mediaType, reference: input.selected.skill.reference, input: input.skillInput };
      const completed = { ...stored, status: "completed", executionResults: [payload] };
      const now = new Date().toISOString();
      this.sql`UPDATE skill_runs SET status='completed',state_json=${JSON.stringify(completed)},planned_call_json=NULL,
        blocked_code=NULL,updated_at=${now} WHERE id=${input.runId}`;
      this.recordSkillEvent(input.runId, input.selected.skill.key, "run.completed", { executorCalls: 0, handoff: input.selected.skill.kind });
      return this.telegramSkillRunResponsePayload(input.name, input.runId, completed, [payload], input.skillInput, input.replayed);
    }

    let state = input.state as SkillRunState;
    const results = [...priorResults];
    const granted = this.loadExecutableCatalog().catalog.map((tool) => `${tool.serverId}/${tool.toolName}`);
    let executorCalls = 0;
    while (state.status === "planned") {
      if (executorCalls >= 16) throw new Error("skill_executor_step_limit");
      const separator = state.plannedCall.toolKey.indexOf("/");
      if (separator < 1) throw new Error("skill_tool_key_invalid");
      const serverId = state.plannedCall.toolKey.slice(0, separator);
      const toolName = state.plannedCall.toolKey.slice(separator + 1);
      const stepId = state.plannedCall.stepId;
      const result = await this.executeTelegramReadTool(input.scope, serverId, toolName, state.plannedCall.args, {
        taskId: `skill-${input.runId}-${state.stateRevision}`,
        idempotencyKey: `skill:${input.runId}:${state.stateRevision}:${stepId}`,
        purpose: "skill_workflow",
      });
      if ("pending" in result) throw new Error("skill_tool_step_requires_durable_resume");
      executorCalls += 1;
      results.push({ stepId, toolKey: state.plannedCall.toolKey, result });
      state = await advanceSkillRun({
        run: state,
        registry: input.registry,
        requestHash: await canonicalArgsHash({ runId: input.runId, stateRevision: state.stateRevision, stepId, result: result.payload }),
        installationRevision: input.selected.revision,
        installationEnabled: input.selected.enabled,
        grantedToolKeys: granted,
        completedStepIds: [...state.completedStepIds, stepId],
      });
      const persisted = { ...state, executionResults: results };
      const blockedCode = state.status === "blocked" ? state.blockedCode : null;
      const plannedCall = state.status === "planned" ? state.plannedCall : null;
      const now = new Date().toISOString();
      this.sql`UPDATE skill_runs SET status=${state.status},state_json=${JSON.stringify(persisted)},
        planned_call_json=${plannedCall ? JSON.stringify(plannedCall) : null},blocked_code=${blockedCode},updated_at=${now}
        WHERE id=${input.runId}`;
      this.recordSkillEvent(input.runId, input.selected.skill.key, `run.${state.status}`, { stepId, executorCalls });
    }
    return this.telegramSkillRunResponsePayload(input.name, input.runId, state, results, input.skillInput, input.replayed);
  }

  private telegramSkillRunResponsePayload(
    name: string,
    runId: string,
    state: SkillRunState | Record<string, unknown>,
    results: unknown[],
    skillInput: JsonValue,
    replayed: boolean,
  ) {
    const status = String(state.status ?? "blocked");
    const plan = status === "planned" && "plannedCall" in state ? state.plannedCall as Record<string, unknown> : null;
    const blockedCode = status === "blocked" && "blockedCode" in state ? String(state.blockedCode) : null;
    return {
      title: `Skill 已${status === "blocked" ? "阻断" : status === "completed" ? "完成" : "规划"}：${name}`,
      summary: status === "blocked"
        ? `计划已 fail-closed：${blockedCode ?? "blocked"}。`
        : status === "completed" ? `Durable run 已完成，共产生 ${results.length} 个受限结果。` : "Durable run 等待下一步。",
      items: [
        { label: "run", detail: runId, status: replayed ? "replayed" : status },
        { label: "next", detail: plan ? JSON.stringify(plan).slice(0, 300) : blockedCode ?? "none", status },
      ],
      ...(status === "completed" ? { handoff: {
        taskId: runId,
        toolKey: `skill/${name}`,
        arguments: skillInput,
        result: { runId, status, results },
      } } : {}),
    };
  }

  private async handleTelegramBrowserCommand(body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): Promise<Response> {
    const scope = this.telegramCommandScope(body, binding);
    if (!scope) return json({ error: "telegram_owner_scope_mismatch" }, { status: 403 });
    if (body.action !== "status") return json({ error: "invalid_telegram_browser_command" }, { status: 400 });
    const active = this.sql<CountRow>`SELECT COUNT(*) AS count FROM browser_executions WHERE status IN ('running','paused')`[0]?.count ?? 0;
    const adapters = await createDefaultSiteAdapterRegistry();
    return json({
      title: "Browser Run",
      summary: `今日 ${this.browserUsageTodayMs()} / ${this.browserDailyBudgetMs()} ms；交互执行 ${this.browserInteractiveEnabled() ? "已启用" : "未启用"}。`,
      items: [
        { label: "active executions", detail: String(active), status: active ? "active" : "idle" },
        { label: "domain allowlist", detail: this.browserDomainAllowlist().join(", "), status: "enforced" },
        { label: "site adapters", detail: adapters.map((adapter) => adapter.key).join(", "), status: "fail-closed" },
        { label: "控制台", detail: "https://agent.example.com/tools/browser", status: "private" },
      ],
    });
  }

  private thinkGatewayEnabled(): boolean {
    return this.env.AGENT_THINK_GATEWAY_ENABLED?.trim().toLowerCase() === "true"
      && this.env.AGENT_TOOL_ROUTER_V2_ENABLED?.trim().toLowerCase() === "true"
      && Boolean(this.env.AGENT_THINK_SERVICE_BEARER?.trim());
  }

  private thinkServiceScopeFromHeaders(headers: Headers): { ownerId: string; chatId: string; scopeKind: "private" | "qa_room"; threadKey: string } | null {
    return this.thinkServiceScope({
      ownerId: headers.get("x-operia-owner-id"),
      chatId: headers.get("x-operia-chat-id"),
      scopeKind: headers.get("x-operia-scope-kind"),
      threadKey: headers.get("x-operia-thread-key") ?? "",
    });
  }

  private thinkServiceScope(body: Record<string, unknown>): { ownerId: string; chatId: string; scopeKind: "private" | "qa_room"; threadKey: string } | null {
    const configuredOwner = this.env.AGENT_CONTEXT_OWNER_ID?.trim();
    const ownerId = typeof body.ownerId === "string" ? body.ownerId.trim() : "";
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
    const scopeKind = body.scopeKind === "private" || body.scopeKind === "qa_room" ? body.scopeKind : null;
    const threadKey = typeof body.threadKey === "string" ? body.threadKey.trim() : "";
    if (!configuredOwner || ownerId !== configuredOwner || !chatId || !scopeKind) return null;
    if (scopeKind === "private") {
      return chatId === configuredOwner ? { ownerId, chatId, scopeKind, threadKey: "private" } : null;
    }
    const qaChatId = this.env.AGENT_SANDBOX_QA_CHAT_ID?.trim();
    const qaThreadKey = this.env.AGENT_SANDBOX_QA_THREAD_KEY?.trim();
    return qaChatId && qaThreadKey && chatId === qaChatId && threadKey === qaThreadKey
      ? { ownerId, chatId, scopeKind, threadKey }
      : null;
  }

  private async thinkCatalogSnapshot(): Promise<ToolCatalogSnapshotV3> {
    const { catalog, observedCatalog } = this.loadExecutableCatalog();
    const forbiddenProviders = new Set([
      BROWSER_PROVIDER_SERVER_ID,
      GROK_PROVIDER_SERVER_ID,
      VOICE_PROVIDER_SERVER_ID,
      HOME_ASSISTANT_PROVIDER_SERVER_ID,
      SANDBOX_RUNTIME_PROVIDER_SERVER_ID,
      SANDBOX_CODEMODE_PROVIDER_SERVER_ID,
    ]);
    const allowed = catalog.filter((tool) => tool.riskLevel === "read" && !forbiddenProviders.has(tool.serverId));
    const keys = new Set(allowed.map((tool) => tool.catalogKey));
    const observed = observedCatalog.filter((tool) => keys.has(tool.catalogKey));
    const connectorVersions = Object.fromEntries([...new Set(allowed.map((tool) => tool.serverId))].map((id) => [id, "agent-live-v1"]));
    const gatewayBilling = new Map<string, { billingClass: "none" | "metered" | "unknown"; mayCost: boolean; requiresConfirmation: boolean; ownerRevision: number }>(
      (this.currentMcpGatewayOwnerSnapshot()?.providers ?? []).flatMap((provider) => provider.tools.map((tool) => [
        `${provider.id}/${tool.name}`,
        tool,
      ] as const)),
    );
    const metadata = Object.fromEntries(allowed.map((tool) => {
      const ownerBilling = gatewayBilling.get(tool.catalogKey);
      const approvalProbe = tool.serverId === APPROVAL_PROBE_PROVIDER_SERVER_ID && tool.toolName === THINK_APPROVAL_PROBE_TOOL_NAME;
      const explicitlyFreeAgentRead = tool.serverId === OBSERVER_MCP_SERVER_ID
        || tool.serverId === HEALTH_PROVIDER_SERVER_ID
        || tool.serverId === CALENDAR_PROVIDER_SERVER_ID
        || tool.serverId === SOURCE_CODE_PROVIDER_SERVER_ID || approvalProbe;
      const billingClass = ownerBilling?.billingClass ?? (explicitlyFreeAgentRead ? "none" : "unknown");
      const mayCost = approvalProbe ? false : ownerBilling?.mayCost ?? !explicitlyFreeAgentRead;
      const requiresConfirmation = approvalProbe || ownerBilling?.requiresConfirmation === true || mayCost;
      return [tool.catalogKey, {
        ownerDomain: ownerBilling ? "mcp.example.com" : tool.serverId,
        ownerRevision: ownerBilling ? `mcp-${ownerBilling.ownerRevision}` : "agent-live-v1",
        tags: approvalProbe ? ["read", "operia-canary", "approval-continuation"] : ["read", "operia-canary"],
        consequences: ["read_only"],
        reversibility: "none" as const,
        policyHints: ["read_only", "no_browser", "no_external_message", "no_irreversible_write"],
        requiresFreshAuth: false,
        mayCost,
        billingClass,
        requiresConfirmation,
      }];
    }));
    return await createToolCatalogSnapshotV3({
      catalog: allowed,
      observedCatalog: observed,
      catalogRevision: "agent-live-read-v1",
      policyVersion: "operia-canary-read-v1",
      connectorVersions,
      metadata,
    });
  }

  private async handleThinkSearch(body: Record<string, unknown>): Promise<Response> {
    const snapshot = await this.thinkCatalogSnapshot();
    return json({
      catalogRevision: snapshot.catalogRevision,
      catalogSnapshotHash: snapshot.snapshotHash,
      policyVersion: snapshot.policyVersion,
      connectorVersions: snapshot.connectorVersions,
      skillInstallationRevision: this.thinkSkillInstallationRevision(),
      tools: searchToolCatalogV3(snapshot, {
        query: typeof body.query === "string" ? body.query : "",
        tags: Array.isArray(body.tags) ? body.tags.filter((item): item is string => typeof item === "string") : [],
        riskClasses: ["read"],
        limit: typeof body.limit === "number" ? body.limit : 8,
        expectedCatalogRevision: String(body.catalogRevision ?? ""),
        expectedSnapshotHash: String(body.catalogSnapshotHash ?? ""),
      }),
    });
  }

  private async handleThinkDescribe(body: Record<string, unknown>): Promise<Response> {
    const snapshot = await this.thinkCatalogSnapshot();
    return json(describeToolV3(snapshot, {
      toolKey: String(body.toolKey ?? ""),
      expectedCatalogRevision: String(body.catalogRevision ?? ""),
      expectedSnapshotHash: String(body.catalogSnapshotHash ?? ""),
    }));
  }

  private async handleThinkExecute(
    body: Record<string, unknown>,
    scope: { ownerId: string; chatId: string; scopeKind: "private" | "qa_room"; threadKey: string },
  ): Promise<Response> {
    const snapshot = await this.thinkCatalogSnapshot();
    const description = describeToolV3(snapshot, {
      toolKey: String(body.toolKey ?? ""),
      expectedCatalogRevision: String(body.catalogRevision ?? ""),
      expectedSnapshotHash: String(body.catalogSnapshotHash ?? ""),
    });
    if (!description.descriptor.executable || description.descriptor.riskClass !== "read" || description.mayWrite) {
      return json({ error: "think_tool_not_read_only" }, { status: 403 });
    }
    const identity = classifyThinkExecuteIdentityEnvelope(body);
    const allowApproval = body.allowApproval !== false;
    const executionClass = body.executionClass === "free_read" ? "free_read" : "approval_capable";
    const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
    if (identity.kind === "invalid") return json({ error: identity.error }, { status: 422 });
    const approvalProbe = description.descriptor.providerId === APPROVAL_PROBE_PROVIDER_SERVER_ID
      && description.descriptor.name === THINK_APPROVAL_PROBE_TOOL_NAME;
    if (description.descriptor.providerId === SOURCE_CODE_PROVIDER_SERVER_ID && scope.scopeKind !== "private") {
      return json({ error: "source_workspace_private_scope_required", externalWrites: 0 }, { status: 403 });
    }
    if (approvalProbe && (!this.thinkApprovalProbeEnabled()
      || body.approvalProbeIntent !== THINK_APPROVAL_PROBE_INTENT)) {
      return json({ error: "approval_probe_scope_denied" }, { status: 403 });
    }
    const { requestId } = identity;
    if (description.mayCost || description.billingClass !== "none" || description.requiresConfirmation) {
      // The official Code Mode ToolSet is deliberately free-read only in S1.
      // Reject before prepareThinkToolApproval() so a sandbox plan cannot
      // manufacture an Agent task/ticket that its runtime is not allowed to
      // approve. S2 exposes confirmation-gated calls through Think Actions.
      if (executionClass === "free_read") {
        return json({ error: "think_tool_not_free_read", externalWrites: 0 }, { status: 403 });
      }
      const prepared = await this.prepareThinkToolApproval(
        scope,
        description,
        args as Record<string, unknown>,
        requestId,
        identity.kind === "modern" ? identity.thinkTaskId : null,
        identity.kind === "modern" ? identity.agentCallKey : null,
        allowApproval,
      );
      if (prepared.kind === "completed") {
        return json({
          requestId,
          toolKey: description.descriptor.toolKey,
          result: prepared.result,
          externalWrites: 0,
          approvalRequired: false,
        });
      }
      if (prepared.kind === "blocked") {
        return json({ error: "think_nested_approval_blocked", taskId: prepared.taskId, externalWrites: 0 }, { status: 409 });
      }
      return json({
        approvalRequired: true,
        billingClass: description.billingClass,
        toolKey: description.descriptor.toolKey,
        taskId: prepared.taskId,
        approval: prepared.presentation,
        externalWrites: 0,
        providerAttempts: 0,
      }, { status: 202 });
    }
    const result = await this.executeTelegramReadTool(scope, description.descriptor.providerId, description.descriptor.name, args, {
      taskId: `think-${requestId}`.slice(0, 160),
      idempotencyKey: `think:${scope.scopeKind}:${scope.chatId}:${requestId}`,
      purpose: "operia_think_canary",
    });
    if ("pending" in result) return json({ error: "think_read_unexpectedly_pending", taskId: result.taskId }, { status: 409 });
    this.audit("think.tool.completed", "memory-think", description.descriptor.toolKey, {
      requestId,
      scopeKind: scope.scopeKind,
      payloadBytes: result.payloadBytes,
      truncated: result.truncated,
    });
    return json({ requestId, toolKey: description.descriptor.toolKey, result, externalWrites: 0, approvalRequired: false });
  }

  private async handleThinkActionPreflight(
    body: Record<string, unknown>,
    scope: { ownerId: string; chatId: string; scopeKind: "private" | "qa_room"; threadKey: string },
  ): Promise<Response> {
    const thinkTaskId = typeof body.thinkTaskId === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(body.thinkTaskId)
      ? body.thinkTaskId : "";
    const toolCallId = typeof body.toolCallId === "string" && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/.test(body.toolCallId)
      ? body.toolCallId : "";
    const operationKey = typeof body.operationKey === "string" && body.operationKey.length >= 8 && body.operationKey.length <= 180
      ? body.operationKey : "";
    const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};
    if (!thinkTaskId || !toolCallId || !operationKey) return json({ error: "think_action_identity_invalid" }, { status: 422 });
    const snapshot = await this.thinkCatalogSnapshot();
    const description = describeToolV3(snapshot, {
      toolKey: String(body.toolKey ?? ""),
      expectedCatalogRevision: String(body.catalogRevision ?? ""),
      expectedSnapshotHash: String(body.catalogSnapshotHash ?? ""),
    });
    if (!description.descriptor.executable || description.descriptor.riskClass !== "read" || description.mayWrite) {
      return json({ error: "think_action_not_read_only" }, { status: 403 });
    }
    if (!description.mayCost && description.billingClass === "none" && !description.requiresConfirmation) {
      return json({ error: "think_action_plain_tool_required" }, { status: 409 });
    }
    const current = await this.evaluateCurrentToolPolicy({
      serverId: description.descriptor.providerId,
      toolName: description.descriptor.name,
      args,
    });
    if (!current.ok || current.riskLevel !== "read" || current.argsHash.length !== 64) {
      return json({ error: `think_action_policy_${current.code}` }, { status: 403 });
    }
    const pauseGeneration = this.sandboxControlSnapshot().generation;
    const grantDigest = await sha256Hex(canonicalJsonStringify({
      scope, thinkTaskId, toolCallId, operationKey, toolKey: description.descriptor.toolKey,
      argsHash: current.argsHash, schemaHash: description.descriptor.schemaHash,
      policyVersion: snapshot.policyVersion, pauseGeneration,
    }));
    const grantId = `tag_${grantDigest.slice(0, 32)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const existing = this.sql<{
      status: string; owner_id: string; chat_id: string; scope_kind: string; thread_key: string;
      server_id: string; tool_name: string; args_hash: string; schema_hash: string; policy_version: string;
      catalog_revision: string; catalog_snapshot_hash: string; pause_generation: number; expires_at: string;
    }>`SELECT status,owner_id,chat_id,scope_kind,thread_key,server_id,tool_name,args_hash,schema_hash,policy_version,
      catalog_revision,catalog_snapshot_hash,pause_generation,expires_at FROM think_action_grants WHERE id=${grantId}`[0];
    if (existing) {
      const same = existing.owner_id === scope.ownerId && existing.chat_id === scope.chatId
        && existing.scope_kind === scope.scopeKind && existing.thread_key === scope.threadKey
        && existing.server_id === description.descriptor.providerId && existing.tool_name === description.descriptor.name
        && existing.args_hash === current.argsHash && existing.schema_hash === description.descriptor.schemaHash
        && existing.policy_version === snapshot.policyVersion && existing.catalog_revision === snapshot.catalogRevision
        && existing.catalog_snapshot_hash === snapshot.snapshotHash && existing.pause_generation === pauseGeneration;
      if (!same) return json({ error: "think_action_grant_pin_drift" }, { status: 409 });
      if (existing.status !== "proposed" || Date.parse(existing.expires_at) <= Date.now()) {
        return json({ error: "think_action_grant_not_proposed", status: existing.status }, { status: 409 });
      }
    } else {
      this.sql`INSERT INTO think_action_grants
        (id,status,owner_id,chat_id,scope_kind,thread_key,think_task_id,tool_call_id,operation_key,server_id,tool_name,
         args_json,args_hash,schema_hash,policy_version,catalog_revision,catalog_snapshot_hash,pause_generation,billing_class,
         expires_at,created_at,updated_at)
        VALUES (${grantId},'proposed',${scope.ownerId},${scope.chatId},${scope.scopeKind},${scope.threadKey},${thinkTaskId},
          ${toolCallId},${operationKey},${description.descriptor.providerId},${description.descriptor.name},${JSON.stringify(args)},
          ${current.argsHash},${description.descriptor.schemaHash},${snapshot.policyVersion},${snapshot.catalogRevision},
          ${snapshot.snapshotHash},${pauseGeneration},${description.billingClass},${expiresAt},${now.toISOString()},${now.toISOString()})`;
    }
    this.audit("think.action.grant.proposed", "memory-think", grantId, {
      thinkTaskId, toolCallId, toolKey: description.descriptor.toolKey, argsHash: current.argsHash,
      billingClass: description.billingClass, pauseGeneration,
    });
    return json({
      grantId, status: "proposed", toolKey: description.descriptor.toolKey, argsHash: current.argsHash,
      schemaHash: description.descriptor.schemaHash, policyVersion: snapshot.policyVersion,
      catalogRevision: snapshot.catalogRevision, catalogSnapshotHash: snapshot.snapshotHash,
      pauseGeneration, billingClass: description.billingClass, expiresAt, externalWrites: 0,
    });
  }

  private async handleThinkActionExecute(
    body: Record<string, unknown>,
    scope: { ownerId: string; chatId: string; scopeKind: "private" | "qa_room"; threadKey: string },
    signal: AbortSignal,
  ): Promise<Response> {
    const grantId = typeof body.grantId === "string" && /^tag_[a-f0-9]{32}$/.test(body.grantId) ? body.grantId : "";
    if (!grantId) return json({ error: "think_action_grant_invalid" }, { status: 422 });
    const grant = this.sql<{
      status: string; owner_id: string; chat_id: string; scope_kind: string; thread_key: string; think_task_id: string;
      tool_call_id: string; operation_key: string; server_id: string; tool_name: string; args_json: string; args_hash: string;
      schema_hash: string; policy_version: string; catalog_revision: string; catalog_snapshot_hash: string;
      pause_generation: number; expires_at: string; result_json: string | null; error_code: string | null;
    }>`SELECT * FROM think_action_grants WHERE id=${grantId}`[0];
    if (!grant) return json({ error: "think_action_grant_missing" }, { status: 404 });
    if (grant.owner_id !== scope.ownerId || grant.chat_id !== scope.chatId || grant.scope_kind !== scope.scopeKind
      || grant.thread_key !== scope.threadKey || body.thinkTaskId !== grant.think_task_id
      || body.toolCallId !== grant.tool_call_id || body.operationKey !== grant.operation_key) {
      return json({ error: "think_action_grant_scope_mismatch" }, { status: 403 });
    }
    if (grant.status === "consumed" && grant.result_json) {
      return json({ grantId, status: "consumed", result: this.parseJson(grant.result_json, null), replayed: true, externalWrites: 0 });
    }
    if (grant.status !== "proposed") {
      return json({ error: "think_action_grant_not_executable", status: grant.status, code: grant.error_code }, { status: 409 });
    }
    if (Date.parse(grant.expires_at) <= Date.now()) {
      this.sql`UPDATE think_action_grants SET status='expired',updated_at=${new Date().toISOString()} WHERE id=${grantId} AND status='proposed'`;
      return json({ error: "think_action_grant_expired" }, { status: 410 });
    }
    const snapshot = await this.thinkCatalogSnapshot();
    const description = describeToolV3(snapshot, {
      toolKey: `${grant.server_id}/${grant.tool_name}`,
      expectedCatalogRevision: grant.catalog_revision,
      expectedSnapshotHash: grant.catalog_snapshot_hash,
    });
    const args = this.parseJson<Record<string, unknown>>(grant.args_json, {});
    const current = await this.evaluateCurrentToolPolicy({ serverId: grant.server_id, toolName: grant.tool_name, args });
    const pinsMatch = current.ok && current.riskLevel === "read" && current.argsHash === grant.args_hash
      && description.descriptor.schemaHash === grant.schema_hash && snapshot.policyVersion === grant.policy_version
      && this.sandboxControlSnapshot().generation === grant.pause_generation;
    if (!pinsMatch) {
      this.sql`UPDATE think_action_grants SET status='quarantined',error_code='think_action_grant_pin_drift',updated_at=${new Date().toISOString()}
        WHERE id=${grantId} AND status='proposed'`;
      return json({ error: "think_action_grant_pin_drift", status: "quarantined" }, { status: 409 });
    }
    // Result sanitization must use the same catalog entry that was pinned
    // before the provider effect. Reloading the live projection after a
    // successful call can turn a harmless concurrent catalog refresh into a
    // false tool failure and discard an already obtained result.
    const pinnedResultTool = await createToolCatalogEntry({
      serverId: grant.server_id,
      toolName: grant.tool_name,
      description: description.descriptor.summary,
      riskLevel: description.descriptor.riskClass,
      inputSchema: description.inputSchema,
      outputByteLimit: description.outputByteLimit,
      enabled: true,
    });
    if (pinnedResultTool.schemaHash !== grant.schema_hash) {
      this.sql`UPDATE think_action_grants SET status='quarantined',error_code='think_action_grant_pin_drift',updated_at=${new Date().toISOString()}
        WHERE id=${grantId} AND status='proposed'`;
      return json({ error: "think_action_grant_pin_drift", status: "quarantined" }, { status: 409 });
    }
    const claimedAt = new Date().toISOString();
    const claimed = this.sql<{ id: string }>`UPDATE think_action_grants SET status='consuming',updated_at=${claimedAt}
      WHERE id=${grantId} AND status='proposed' RETURNING id`;
    if (claimed.length !== 1) return json({ error: "think_action_grant_concurrent_consume" }, { status: 409 });
    const taskId = `think-action-${grantId}`;
    const input: DelegatedTaskInput = {
      mode: "direct", taskId, idempotencyKey: `think-sdk-action:${grantId}`, capsuleId: "think-sdk-action",
      thinkTaskId: grant.think_task_id, agentCallKey: grant.tool_call_id, instruction: grant.tool_name,
      directCall: { serverId: grant.server_id, toolName: grant.tool_name, args: args as JsonValue },
      namespace: "default", chatId: scope.chatId, recipient: "think-sdk-action", purpose: "operia_think_sdk_action",
      requestHash: grant.args_hash, ownerId: scope.ownerId, serviceId: "memory-think",
    };
    const initial: ToolTaskCheckpoint = { taskId, status: "executing", round: 0, callCount: 0, completedCallKeys: [], results: [] };
    const insertedAt = new Date().toISOString();
    const scopedFiberKey = this.scopedTaskFiberKey(input.ownerId, input.serviceId, input.idempotencyKey);
    this.sql`INSERT OR IGNORE INTO delegated_tasks
      (id,idempotency_key,client_idempotency_key,owner_id,service_id,chat_id,root_task_id,parent_task_id,
       task_revision,pause_generation,status,input_json,checkpoint_json,repair_generation,created_at,updated_at)
      VALUES (${taskId},${scopedFiberKey},${input.idempotencyKey},${input.ownerId},${input.serviceId},${input.chatId},
        ${input.rootTaskId || input.taskId},${input.parentTaskId ?? null},1,0,'executing',${JSON.stringify(input)},
        ${JSON.stringify(initial)},0,${insertedAt},${insertedAt})`;
    const callKey = `think-action:${grantId}`;
    try {
      const raw = await this.invokeMcpTool({ serverId: grant.server_id, toolName: grant.tool_name, args }, callKey, taskId, signal);
      const result = sanitizeToolResult({ catalog: [pinnedResultTool], serverId: grant.server_id, toolName: grant.tool_name, result: raw });
      const completed: ToolTaskCheckpoint = { ...initial, status: "completed", round: 1, callCount: 1, completedCallKeys: [callKey], results: [result] };
      this.persistThinkActionTerminalCheckpoint(completed);
      const resultJson = JSON.stringify(result);
      this.sql`UPDATE think_action_grants SET status='consumed',result_json=${resultJson},updated_at=${new Date().toISOString()}
        WHERE id=${grantId} AND status='consuming'`;
      try {
        this.audit("think.action.grant.consumed", "memory-think", grantId, { taskId, toolKey: `${grant.server_id}/${grant.tool_name}` });
      } catch (error) {
        console.warn("think_action_audit_projection_degraded", { code: boundedAgentErrorCode(error, "audit_projection_failed") });
      }
      return json({ grantId, status: "consumed", result, replayed: false, externalWrites: 0 });
    } catch (error) {
      const sideEffect = this.sql<{ status: string }>`SELECT status FROM tool_side_effects WHERE call_key=${callKey}`[0]?.status;
      const uncertain = sideEffect === "started" || sideEffect === "uncertain" || sideEffect === "quarantined";
      const code = boundedAgentErrorCode(error, uncertain ? "think_action_unknown_outcome" : "think_action_failed");
      this.sql`UPDATE think_action_grants SET status=${uncertain ? "attention_required" : "failed"},error_code=${code},updated_at=${new Date().toISOString()}
        WHERE id=${grantId} AND status='consuming'`;
      throw error;
    }
  }

  private handleThinkActionRevoke(
    body: Record<string, unknown>,
    scope: { ownerId: string; chatId: string; scopeKind: "private" | "qa_room"; threadKey: string },
  ): Response {
    const grantId = typeof body.grantId === "string" && /^tag_[a-f0-9]{32}$/.test(body.grantId) ? body.grantId : "";
    if (!grantId) return json({ error: "think_action_grant_invalid" }, { status: 422 });
    const grant = this.sql<{
      status: string; owner_id: string; chat_id: string; scope_kind: string; thread_key: string;
      think_task_id: string; tool_call_id: string; operation_key: string;
    }>`SELECT status,owner_id,chat_id,scope_kind,thread_key,think_task_id,tool_call_id,operation_key
      FROM think_action_grants WHERE id=${grantId}`[0];
    if (!grant) return json({ error: "think_action_grant_missing" }, { status: 404 });
    if (grant.owner_id !== scope.ownerId || grant.chat_id !== scope.chatId || grant.scope_kind !== scope.scopeKind
      || grant.thread_key !== scope.threadKey || body.thinkTaskId !== grant.think_task_id
      || body.toolCallId !== grant.tool_call_id || body.operationKey !== grant.operation_key) {
      return json({ error: "think_action_grant_scope_mismatch" }, { status: 403 });
    }
    if (grant.status === "revoked") return json({ grantId, status: "revoked", replayed: true, externalWrites: 0 });
    if (grant.status !== "proposed") {
      return json({ error: "think_action_grant_not_revocable", status: grant.status }, { status: 409 });
    }
    this.sql`UPDATE think_action_grants SET status='revoked',updated_at=${new Date().toISOString()}
      WHERE id=${grantId} AND status='proposed'`;
    this.audit("think.action.grant.revoked", "memory-think", grantId, {
      thinkTaskId: grant.think_task_id,
      toolCallId: grant.tool_call_id,
    });
    return json({ grantId, status: "revoked", replayed: false, externalWrites: 0 });
  }

  private async completeThinkTask(body: Record<string, unknown>): Promise<Response> {
    const thinkTaskId = typeof body.thinkTaskId === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(body.thinkTaskId)
      ? body.thinkTaskId : null;
    const authorityScopeHash = typeof body.authorityScopeHash === "string" && /^[a-f0-9]{64}$/.test(body.authorityScopeHash)
      ? body.authorityScopeHash : null;
    if (!thinkTaskId || !authorityScopeHash) return json({ error: "think_task_complete_input_invalid" }, { status: 422 });
    const grant = this.sql<{ owner_id: string; chat_id: string }>`SELECT owner_id,chat_id FROM approval_task_grants
      WHERE think_task_id=${thinkTaskId} ORDER BY created_at LIMIT 1`[0];
    if (!grant) return json({ thinkTaskId, status: "completed", revokedGrants: 0 });
    const configuredOwner = this.env.AGENT_CONTEXT_OWNER_ID?.trim() ?? "";
    const scope = grant.chat_id === configuredOwner
      ? { ownerId: configuredOwner, chatId: grant.chat_id, scopeKind: "private" as const, threadKey: "private" }
      : grant.chat_id === this.env.AGENT_SANDBOX_QA_CHAT_ID?.trim()
        ? { ownerId: configuredOwner, chatId: grant.chat_id, scopeKind: "qa_room" as const,
          threadKey: this.env.AGENT_SANDBOX_QA_THREAD_KEY?.trim() ?? "" }
        : null;
    if (!scope?.ownerId || !scope.threadKey || grant.owner_id !== scope.ownerId) {
      return json({ error: "think_task_complete_scope_mismatch" }, { status: 403 });
    }
    const expectedAuthorityScopeHash = await sha256Hex([
      "operia:think:approval-authority:v1", scope.ownerId, scope.chatId, scope.scopeKind, scope.threadKey,
    ].join("\0"));
    if (authorityScopeHash !== expectedAuthorityScopeHash) {
      return json({ error: "think_task_complete_authority_mismatch" }, { status: 403 });
    }
    const now = new Date().toISOString();
    const revoked = this.sql<{ id: string }>`UPDATE approval_task_grants SET status='task_ended',updated_at=${now}
      WHERE think_task_id=${thinkTaskId} AND owner_id=${scope.ownerId} AND chat_id=${scope.chatId}
        AND status='active' RETURNING id`;
    this.audit("think.task.completed", "memory-think", thinkTaskId, { revokedGrants: revoked.length });
    return json({ thinkTaskId, status: "completed", revokedGrants: revoked.length });
  }

  private async prepareThinkToolApproval(
    scope: { ownerId: string; chatId: string },
    description: ToolDescriptionV3,
    args: Record<string, unknown>,
    requestId: string,
    thinkTaskId: string | null,
    agentCallKey: string | null,
    allowApproval: boolean,
  ): Promise<
    | { kind: "approval"; taskId: string; presentation: Record<string, unknown> }
    | { kind: "completed"; taskId: string; result: unknown }
    | { kind: "blocked"; taskId: string }
  > {
    const taskId = `think-approval-${requestId}`.slice(0, 160);
    const idempotencyKey = `think-approval:${scope.ownerId}:${scope.chatId}:${requestId}`;
    const scopedFiberKey = this.scopedTaskFiberKey(scope.ownerId, "telegram-agent", idempotencyKey);
    const existing = this.sql<{ status: string }>`SELECT status FROM delegated_tasks
      WHERE owner_id=${scope.ownerId} AND service_id='telegram-agent' AND client_idempotency_key=${idempotencyKey}`[0];
    if (!existing) {
      const requestHash = await canonicalArgsHash(args);
      const input: DelegatedTaskInput = {
        mode: "direct",
        taskId,
        idempotencyKey,
        capsuleId: "think-paid-read",
        ...(thinkTaskId && agentCallKey ? { thinkTaskId, agentCallKey } : {}),
        instruction: description.descriptor.name,
        directCall: {
          serverId: description.descriptor.providerId,
          toolName: description.descriptor.name,
          args: args as JsonValue,
        },
        namespace: "default",
        chatId: scope.chatId,
        recipient: "telegram-think-approval",
        purpose: "operia_think_paid_read",
        requestHash,
        ownerId: scope.ownerId,
        serviceId: "telegram-agent",
      };
      const initial: ToolTaskCheckpoint = {
        taskId,
        status: "accepted",
        round: 0,
        callCount: 0,
        completedCallKeys: [],
        results: [],
      };
      const now = new Date().toISOString();
      this.sql`INSERT INTO delegated_tasks
        (id,idempotency_key,client_idempotency_key,owner_id,service_id,chat_id,root_task_id,parent_task_id,
         task_revision,pause_generation,status,input_json,checkpoint_json,repair_generation,created_at,updated_at)
        VALUES (${taskId},${scopedFiberKey},${idempotencyKey},${input.ownerId},${input.serviceId},${input.chatId},
          ${input.rootTaskId || input.taskId},${input.parentTaskId ?? null},1,0,'accepted',${JSON.stringify(input)},
          ${JSON.stringify(initial)},0,${now},${now})`;
      this.recordTaskProgress(taskId, "task.accepted", "需要确认的读取已进入审批准备", { phase: "accepted" });
      const checkpoint = await this.runDelegatedTask(taskId, initial);
      if (checkpoint.status === "completed") {
        return { kind: "completed", taskId, result: checkpoint.results.at(-1) ?? { outcome: "completed" } };
      }
      if (checkpoint.status === "approval_required" && !allowApproval) {
        const stopped = { ...checkpoint, status: "cancelled" as const, pendingCall: undefined,
          error: "think_nested_approval_blocked" };
        this.persistTaskCheckpoint(stopped);
        return { kind: "blocked", taskId };
      }
      if (checkpoint.status !== "approval_required") throw new Error("think_paid_read_did_not_stop_for_approval");
    }
    const task = this.sql<{ status: string }>`SELECT status FROM delegated_tasks WHERE id=${taskId}`[0];
    if (task?.status === "completed") {
      const checkpoint = this.readTaskCheckpoint(taskId);
      return { kind: "completed", taskId, result: checkpoint.results.at(-1) ?? { outcome: "completed" } };
    }
    if (task?.status === "approval_required" && !allowApproval) {
      const checkpoint = this.readTaskCheckpoint(taskId);
      this.persistTaskCheckpoint({ ...checkpoint, status: "cancelled", pendingCall: undefined,
        error: "think_nested_approval_blocked" });
      return { kind: "blocked", taskId };
    }
    if (task?.status !== "approval_required") throw new Error(`think_approval_task_${task?.status ?? "missing"}`);
    const prepared = await this.prepareApproval(
      { taskId },
      { ownerId: scope.ownerId, serviceId: "telegram-agent" },
      { skipAdvisory: true, legacyThinkEnvelope: !thinkTaskId && !agentCallKey },
    );
    if (!prepared.ok) throw new Error(`think_approval_prepare_http_${prepared.status}`);
    return { kind: "approval", taskId, presentation: await prepared.json<Record<string, unknown>>() };
  }

  private async readThinkApprovalReceipt(
    ticketId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const approvalRef = typeof body.approvalRef === "string" ? body.approvalRef : "";
    const toolKey = typeof body.toolKey === "string" ? body.toolKey : "";
    const authorityScopeHash = typeof body.authorityScopeHash === "string" ? body.authorityScopeHash : "";
    const thinkTaskId = typeof body.thinkTaskId === "string" ? body.thinkTaskId : "";
    const agentCallKey = typeof body.agentCallKey === "string" ? body.agentCallKey : "";
    const argsHash = typeof body.argsHash === "string" ? body.argsHash : "";
    const schemaHash = typeof body.schemaHash === "string" ? body.schemaHash : "";
    const policyVersion = typeof body.policyVersion === "string" ? body.policyVersion : "";
    const pauseGeneration = Number(body.pauseGeneration);
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(taskId)
      || !/^tap_[a-f0-9]{32}$/.test(approvalRef)
      || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{1,179}$/.test(toolKey)
      || !/^[a-f0-9]{64}$/.test(authorityScopeHash)
      || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(thinkTaskId)
      || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(agentCallKey)
      || !/^[a-f0-9]{64}$/.test(argsHash) || !/^[a-f0-9]{64}$/.test(schemaHash)
      || !policyVersion || policyVersion.length > 240
      || !Number.isSafeInteger(pauseGeneration) || pauseGeneration < 0) {
      return json({ error: "think_approval_receipt_input_invalid" }, { status: 422 });
    }
    const configuredOwner = this.env.AGENT_CONTEXT_OWNER_ID?.trim() ?? "";
    const ticket = this.sql<ApprovalTicketRow>`SELECT * FROM approval_ticket_calls WHERE id=${ticketId}`[0];
    if (!ticket) return json({ error: "think_approval_receipt_not_found" }, { status: 404 });
    const scope = ticket.chat_id === configuredOwner
      ? { ownerId: configuredOwner, chatId: ticket.chat_id, scopeKind: "private" as const, threadKey: "private" }
      : ticket.chat_id === this.env.AGENT_SANDBOX_QA_CHAT_ID?.trim()
        ? { ownerId: configuredOwner, chatId: ticket.chat_id, scopeKind: "qa_room" as const,
          threadKey: this.env.AGENT_SANDBOX_QA_THREAD_KEY?.trim() ?? "" }
        : null;
    if (!scope?.ownerId || !scope.threadKey || ticket.owner_id !== scope.ownerId) {
      return json({ error: "think_approval_receipt_scope_mismatch" }, { status: 403 });
    }
    const expectedAuthorityScopeHash = await sha256Hex([
      "operia:think:approval-authority:v1",
      scope.ownerId,
      scope.chatId,
      scope.scopeKind,
      scope.threadKey,
    ].join("\0"));
    if (authorityScopeHash !== expectedAuthorityScopeHash) {
      return json({ error: "think_approval_receipt_authority_mismatch" }, { status: 403 });
    }
    const input = this.delegatedTaskInput(ticket.task_id);
    const expectedToolKey = `${ticket.server_id}/${ticket.tool_name}`;
    if (!input || input.purpose !== "operia_think_paid_read" || input.ownerId !== scope.ownerId
      || input.chatId !== scope.chatId || ticket.owner_id !== scope.ownerId || ticket.chat_id !== scope.chatId
      || ticket.task_id !== taskId || toolKey !== expectedToolKey) {
      return json({ error: "think_approval_receipt_scope_mismatch" }, { status: 403 });
    }
    const pinsMatch = ticket.think_task_id === thinkTaskId
      && ticket.agent_call_key === agentCallKey
      && ticket.args_hash === argsHash
      && ticket.schema_hash === schemaHash
      && ticket.policy_version === policyVersion
      && ticket.pause_generation === pauseGeneration;
    const currentPauseGeneration = this.sandboxControlSnapshot().generation;
    if (!pinsMatch || currentPauseGeneration !== pauseGeneration) {
      this.sql`UPDATE approval_ticket_calls SET status='quarantined',attention_error='think_approval_receipt_pin_drift'
        WHERE id=${ticketId} AND status NOT IN ('cancelled','expired')`;
      return json({ ticketId, taskId, toolKey, status: "quarantined" }, { status: 409 });
    }
    if (ticket.status === "quarantined") {
      return json({ ticketId, taskId, toolKey, status: "quarantined" }, { status: 409 });
    }
    const checkpoint = this.readTaskCheckpoint(taskId);
    if (["pending", "decision_reserved", "consuming"].includes(ticket.status)
      || ["accepted", "planning", "executing", "approval_required", "interrupted", "paused"].includes(checkpoint.status)) {
      return json({ ticketId, taskId, toolKey, status: "pending" }, {
        status: 202,
        headers: { "retry-after": "1" },
      });
    }
    if (["attention_required", "failed", "cancelled"].includes(checkpoint.status)
      || ticket.status === "attention_required") {
      const status = checkpoint.status === "cancelled" ? "cancelled" : "attention_required";
      return json({ ticketId, taskId, toolKey, status }, { status: 409 });
    }
    if (checkpoint.status !== "completed" || !["approved", "rejected", "expired", "cancelled"].includes(ticket.status)) {
      return json({ error: "think_approval_receipt_state_invalid" }, { status: 409 });
    }
    const result = checkpoint.results.at(-1) ?? {
      outcome: ticket.status === "approved" ? "completed" : "action_denied",
    };
    const resultJson = canonicalJsonStringify(result);
    if (new TextEncoder().encode(resultJson).byteLength > 64 * 1024) {
      return json({ error: "think_approval_receipt_too_large" }, { status: 413 });
    }
    const status = ticket.status === "approved" ? "completed" : "rejected";
    const receipt = {
      version: 1,
      approvalRef,
      taskId,
      thinkTaskId,
      ticketId,
      toolKey,
      authorityScopeHash,
      agentCallKey,
      argsHash,
      schemaHash,
      policyVersion,
      pauseGeneration,
      status,
      result,
    };
    const receiptHash = await sha256Hex(canonicalJsonStringify(receipt));
    this.audit("think.approval.receipt.read", "memory-think", ticketId, {
      taskId,
      toolKey,
      status,
      authorityScopeHash: authorityScopeHash.slice(0, 12),
    });
    return json({ ...receipt, receiptHash });
  }

  private async handleThinkCodeMode(
    body: Record<string, unknown>,
    scope: { ownerId: string; chatId: string; scopeKind: "private" | "qa_room"; threadKey: string },
  ): Promise<Response> {
    if (!this.sandboxCodeModeEnabled()) return json({ error: "think_codemode_disabled" }, { status: 404 });
    const requestId = typeof body.requestId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(body.requestId)
      ? body.requestId
      : null;
    const code = typeof body.code === "string" ? body.code : "";
    if (!requestId || code.length < 1 || code.length > 32_000) return json({ error: "think_codemode_input_invalid" }, { status: 422 });
    const memoryRequestedV2 = body.codeModeV2Requested === true;
    if (memoryRequestedV2 && this.env.AGENT_CODEMODE_V2_ENABLED?.trim().toLowerCase() === "true") {
      return await this.handleThinkCodeModeV2(requestId, code, scope, "start");
    }
    const result = await this.executeTelegramReadTool(scope, SANDBOX_CODEMODE_PROVIDER_SERVER_ID, "execute_read_plan", { code }, {
      taskId: `think-code-${requestId}`.slice(0, 160),
      idempotencyKey: `think-code:${scope.scopeKind}:${scope.chatId}:${requestId}`,
      purpose: "operia_think_codemode_canary",
    });
    if ("pending" in result) return json({ error: "think_codemode_unexpectedly_pending", taskId: result.taskId }, { status: 409 });
    this.audit("think.codemode.completed", "memory-think", requestId, { scopeKind: scope.scopeKind, payloadBytes: result.payloadBytes });
    return json({ kind: "codemode_immediate", requestId, status: "completed", result, externalWrites: 0, approvalRequired: false });
  }

  private async handleThinkCodeModeV2(
    requestId: string,
    code: string,
    scope: { ownerId: string; chatId: string; scopeKind: "private" | "qa_room"; threadKey: string },
    mode: "start" | "resume" = "resume",
  ): Promise<Response> {
    if (!this.env.LOADER) return json({ error: "think_codemode_v2_loader_missing" }, { status: 503 });
    const snapshot = await this.thinkCatalogSnapshot();
    const taskId = await deriveCodeModeExecutionTaskId({ ...scope, requestId });
    const executionId = `cmxe_${await sha256Hex(`operia:codemode:execution-id:v1\0${taskId}`)}`;
    const runtimeName = `operia-general-${executionId.slice(-48)}`;
    const codeHash = await sha256Hex(code);
    const skillRevision = this.thinkSkillInstallationRevision();
    const skillConnectorVersion = `skills-${(await sha256Hex(skillRevision)).slice(0, 24)}`;
    const control = this.sandboxControlSnapshot();
    if (control.paused) return json({ error: "sandbox_global_pause_active" }, { status: 423 });
    const connectorVersionsJson = canonicalJsonStringify(snapshot.connectorVersions);
    const identity: OperiaCodeModeExecutionIdentity = {
      taskId,
      executionId,
      ownerId: scope.ownerId,
      chatId: scope.chatId,
      scopeKind: scope.scopeKind,
      threadKey: scope.threadKey,
      requestId,
      codeHash,
      catalogRevision: snapshot.catalogRevision,
      catalogSnapshotHash: snapshot.snapshotHash,
      policyVersion: snapshot.policyVersion,
      connectorVersionsJson,
      skillRevision,
      pauseGeneration: control.generation,
    };
    const now = new Date().toISOString();
    const loadExecution = (): OperiaCodeModeExecutionRow | null => {
      const row = this.sql<RuntimeRow>`SELECT * FROM operia_codemode_executions WHERE task_id=${taskId}`[0];
      if (!row) return null;
      return {
        taskId: String(row.task_id), executionId: String(row.execution_id), ownerId: String(row.owner_id), chatId: String(row.chat_id),
        scopeKind: String(row.scope_kind) as "private" | "qa_room", threadKey: String(row.thread_key), requestId: String(row.request_id),
        codeHash: String(row.code_hash), catalogRevision: String(row.catalog_revision), catalogSnapshotHash: String(row.catalog_snapshot_hash),
        policyVersion: String(row.policy_version), connectorVersionsJson: String(row.connector_versions_json), skillRevision: String(row.skill_revision),
        pauseGeneration: Number(row.pause_generation), status: String(row.status), resultJson: row.result_json ? String(row.result_json) : null,
        leaseOwner: row.lease_owner ? String(row.lease_owner) : null, leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
        recoveryGeneration: Number(row.recovery_generation ?? 0),
      };
    };
    let execution = loadExecution();
    if (!execution) {
      this.sql`INSERT INTO operia_codemode_executions
        (execution_id,task_id,owner_id,chat_id,scope_kind,thread_key,request_id,code_hash,code_text,catalog_revision,
          catalog_snapshot_hash,policy_version,connector_versions_json,skill_revision,pause_generation,runtime_name,status,
          lease_owner,lease_expires_at,recovery_generation,created_at,updated_at)
        VALUES (${executionId},${taskId},${scope.ownerId},${scope.chatId},${scope.scopeKind},${scope.threadKey},${requestId},
          ${codeHash},${code},${snapshot.catalogRevision},${snapshot.snapshotHash},${snapshot.policyVersion},${connectorVersionsJson},
          ${skillRevision},${control.generation},${runtimeName},'accepted',NULL,NULL,0,${now},${now})`;
      execution = loadExecution();
    }
    if (!execution) return json({ error: "think_codemode_v2_execution_missing" }, { status: 500 });
    let decision;
    try {
      decision = decideCodeModeExecution(execution, identity, Date.now());
    } catch (error) {
      const errorCode = boundedAgentErrorCode(error, "codemode_execution_identity_drift");
      this.sql`UPDATE operia_codemode_executions SET status='quarantined',code_text='',error_code=${errorCode},lease_owner=NULL,
        lease_expires_at=NULL,updated_at=${new Date().toISOString()} WHERE execution_id=${executionId} AND status<>'completed'`;
      return json({ kind: "codemode_terminal", error: errorCode, requestId, executionId,
        status: "quarantined", externalWrites: 0 }, { status: 409 });
    }
    if (decision.kind === "completed") {
      this.sql`UPDATE operia_codemode_executions SET code_text='' WHERE execution_id=${executionId} AND status='completed'`;
      return json(this.parseJson(decision.resultJson, {}));
    }
    if (decision.kind === "terminal") {
      if (decision.status === "attention_required") {
        this.sql`UPDATE operia_codemode_executions SET status='attention_required',code_text='',error_code=${decision.errorCode},lease_owner=NULL,
          lease_expires_at=NULL,updated_at=${new Date().toISOString()} WHERE execution_id=${executionId} AND status<>'completed'`;
      }
      this.sql`UPDATE operia_codemode_executions SET code_text='',updated_at=${new Date().toISOString()}
        WHERE execution_id=${executionId} AND status IN ('completed','failed','quarantined','attention_required')`;
      return json({ kind: "codemode_terminal", error: decision.errorCode, requestId, executionId,
        status: decision.status, externalWrites: 0 }, { status: 409 });
    }
    if (decision.kind === "pending") {
      return json({ kind: "codemode_pending", requestId, executionId, status: "executing", pending: true, recoveryGeneration: decision.recoveryGeneration,
        retryAfterMs: decision.retryAfterMs, externalWrites: 0 }, {
        status: 202,
        headers: { "retry-after": String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))) },
      });
    }
    if (mode === "start") {
      return json({ kind: "codemode_pending", requestId, executionId, status: "accepted", pending: true,
        recoveryGeneration: execution.recoveryGeneration, retryAfterMs: 250, externalWrites: 0 }, {
        status: 202,
        headers: { "retry-after": "1" },
      });
    }
    const leaseOwner = crypto.randomUUID();
    const leaseExpiresAt = codeModeLeaseExpiry(Date.now());
    const claimed = this.sql<{ recovery_generation: number }>`UPDATE operia_codemode_executions
      SET status='executing',lease_owner=${leaseOwner},lease_expires_at=${leaseExpiresAt},
        recovery_generation=recovery_generation+1,error_code=NULL,updated_at=${new Date().toISOString()}
      WHERE execution_id=${executionId} AND recovery_generation=${execution.recoveryGeneration}
        AND (status='accepted' OR (status='executing' AND (lease_expires_at IS NULL OR lease_expires_at<=${new Date().toISOString()})))
      RETURNING recovery_generation`[0];
    if (!claimed) {
      const winner = loadExecution();
      const retryAt = winner?.leaseExpiresAt ? Date.parse(winner.leaseExpiresAt) : Date.now() + 1_000;
      return json({ kind: "codemode_pending", requestId, executionId, status: winner?.status ?? "executing", pending: true,
        recoveryGeneration: winner?.recoveryGeneration ?? execution.recoveryGeneration, retryAfterMs: Math.max(250, retryAt - Date.now()),
        externalWrites: 0 }, { status: 202, headers: { "retry-after": "1" } });
    }
    const recoveryGeneration = Number(claimed.recovery_generation);

    const gatewayProviderIds = new Set((this.currentMcpGatewayOwnerSnapshot()?.providers ?? []).map((provider) => provider.id));
    const assertLiveGeneration = () => {
      const current = this.sandboxControlSnapshot();
      if (current.paused || current.generation !== control.generation) throw new Error("sandbox_global_pause_active");
    };
    const renewExecutionLease = () => {
      assertLiveGeneration();
      const renewed = this.sql<{ execution_id: string }>`UPDATE operia_codemode_executions SET lease_expires_at=${codeModeLeaseExpiry(Date.now())},
        updated_at=${new Date().toISOString()} WHERE execution_id=${executionId} AND status='executing'
        AND lease_owner=${leaseOwner} AND recovery_generation=${recoveryGeneration} RETURNING execution_id`[0];
      if (!renewed) throw new Error("codemode_execution_lease_lost");
    };
    const record = (value: unknown, code: string): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
      return value as Record<string, unknown>;
    };
    const requiredText = (value: unknown, code: string): string => {
      if (typeof value !== "string" || !value) throw new Error(code);
      return value;
    };
    const assertCatalogPins = (args: Record<string, unknown>) => {
      if (args.catalogRevision !== snapshot.catalogRevision || args.catalogSnapshotHash !== snapshot.snapshotHash) {
        throw new Error("codemode_catalog_pin_drift");
      }
    };
    const pinnedTool = (request: OperiaCodeModeRequest) => {
      const taskPin = record(request.args.taskPin, "codemode_task_pin_invalid");
      const executionPin = record(request.args.executionPin, "codemode_execution_pin_invalid");
      if (taskPin.catalogRevision !== snapshot.catalogRevision || taskPin.catalogSnapshotHash !== snapshot.snapshotHash
        || taskPin.policyVersion !== snapshot.policyVersion
        || canonicalJsonStringify(taskPin.connectorVersions) !== canonicalJsonStringify(snapshot.connectorVersions)
        || taskPin.skillInstallationRevision !== skillRevision) throw new Error("codemode_task_pin_drift");
      const toolKey = requiredText(request.args.toolKey, "codemode_tool_key_invalid");
      const description = describeToolV3(snapshot, {
        toolKey,
        expectedCatalogRevision: snapshot.catalogRevision,
        expectedSnapshotHash: snapshot.snapshotHash,
      });
      if (executionPin.toolKey !== toolKey || executionPin.schemaHash !== description.descriptor.schemaHash
        || executionPin.ownerRevision !== description.ownerRevision
        || executionPin.catalogRevision !== snapshot.catalogRevision || executionPin.catalogSnapshotHash !== snapshot.snapshotHash
        || executionPin.policyVersion !== snapshot.policyVersion
        || executionPin.connectorVersion !== description.descriptor.connectorVersion) throw new Error("codemode_execution_pin_drift");
      if (!description.descriptor.executable || description.descriptor.riskClass !== "read" || description.mayWrite
        || description.mayCost || description.billingClass !== "none" || description.requiresConfirmation || description.requiresFreshAuth) {
        throw new Error("codemode_tool_approval_required");
      }
      const gatewayOwned = gatewayProviderIds.has(description.descriptor.providerId);
      if ((request.connector === "mcp") !== gatewayOwned) throw new Error("codemode_connector_owner_mismatch");
      return description;
    };
    const pinnedSkill = (request: OperiaCodeModeRequest) => {
      if (request.args.installationRevision !== skillRevision) throw new Error("codemode_skill_revision_drift");
      const skillKey = requiredText(request.args.skillKey, "codemode_skill_key_invalid");
      const entry = this.installedSkills().find(({ alias, skill }) => alias === skillKey || skill.key === skillKey);
      if (!entry || entry.skill.key.includes("browser")) throw new Error("codemode_skill_unavailable");
      if (request.args.schemaHash !== entry.skill.schemaHash || request.args.sourceHash !== entry.skill.sourceHash) {
        throw new Error("codemode_skill_pin_drift");
      }
      return entry;
    };
    const host = {
      preflight: async (request: OperiaCodeModeRequest): Promise<OperiaCodeModePreflight> => {
        renewExecutionLease();
        let classification = "metadata";
        let sensitivity: string[] = [];
        let outputByteLimit = 64 * 1024;
        let connectorVersion = `codemode-v2-${request.connector}`;
        if (request.method === "catalog.search" || request.method === "catalog.describe") assertCatalogPins(request.args);
        else if (request.method === "mcp.call" || request.method === "direct.call") {
          const description = pinnedTool(request);
          classification = request.method === "mcp.call" ? "mcp_read" : "direct_read";
          sensitivity = [...description.descriptor.sensitivity];
          outputByteLimit = description.outputByteLimit;
          connectorVersion = description.descriptor.connectorVersion;
        } else if (request.method.startsWith("skill.")) {
          if (request.method === "skill.metadata") {
            if (request.args.installationRevision !== skillRevision) throw new Error("codemode_skill_revision_drift");
          } else pinnedSkill(request);
          classification = "skill_metadata";
          connectorVersion = skillConnectorVersion;
        } else if (request.method === "sandbox.run") {
          if (!this.sandboxExecutionEnabled() || !this.sandboxP2ReadEnabled()) throw new Error("sandbox_p2_read_disabled");
          classification = "sandbox_output";
          connectorVersion = "operia-sandbox-v1";
        } else throw new Error("codemode_method_denied");
        return {
          allowed: true, riskClass: "read", requiresApproval: false, mayWrite: false, mayCost: false, billingClass: "none",
          policyVersion: snapshot.policyVersion, catalogRevision: snapshot.catalogRevision, connectorVersion,
          classification, sensitivity, outputByteLimit,
        };
      },
      invoke: async (request: OperiaCodeModeRequest): Promise<unknown> => {
        renewExecutionLease();
        const replayPolicy = codeModeInnerReplayPolicy(request.method);
        let call = this.sql<RuntimeRow>`SELECT * FROM operia_codemode_inner_calls WHERE call_key=${request.callKey}`[0];
        if (!call) {
          const createdAt = new Date().toISOString();
          this.sql`INSERT INTO operia_codemode_inner_calls
            (call_key,task_id,execution_id,call_id,connector,method,args_hash,replay_policy,status,attempt_count,
              recovery_generation,created_at,updated_at)
            VALUES (${request.callKey},${taskId},${executionId},${request.callId},${request.connector},${request.method},
              ${request.argsHash},${replayPolicy},'reserved',0,${recoveryGeneration},${createdAt},${createdAt})`;
          call = this.sql<RuntimeRow>`SELECT * FROM operia_codemode_inner_calls WHERE call_key=${request.callKey}`[0];
        }
        if (!call || String(call.task_id) !== taskId || String(call.execution_id) !== executionId
          || String(call.call_id) !== request.callId || String(call.connector) !== request.connector
          || String(call.method) !== request.method || String(call.args_hash) !== request.argsHash) {
          throw new Error("codemode_inner_identity_drift");
        }
        const innerRow: OperiaCodeModeInnerCallRow = {
          status: String(call.status) as OperiaCodeModeInnerCallRow["status"],
          replayPolicy: String(call.replay_policy) as OperiaCodeModeInnerCallRow["replayPolicy"],
          attemptCount: Number(call.attempt_count),
          recoveryGeneration: Number(call.recovery_generation),
        };
        const innerDecision = decideCodeModeInnerCall(innerRow, replayPolicy, recoveryGeneration);
        if (innerDecision.kind === "receipt") throw new Error("codemode_inner_receipt_missing");
        if (innerDecision.kind === "pending") throw new Error("codemode_inner_in_progress");
        if (innerDecision.kind === "failed" || innerDecision.kind === "unknown") {
          this.sql`UPDATE operia_codemode_inner_calls SET status=${innerDecision.kind === "unknown" ? "unknown" : "failed"},
            error_code=${innerDecision.errorCode},updated_at=${new Date().toISOString()} WHERE call_key=${request.callKey}`;
          throw new Error(innerDecision.errorCode);
        }
        const invocationStartedAt = new Date().toISOString();
        const claimedCall = this.sql<{ call_key: string }>`UPDATE operia_codemode_inner_calls SET status='invoking',
          attempt_count=attempt_count+1,recovery_generation=${recoveryGeneration},invocation_started_at=${invocationStartedAt},
          error_code=NULL,updated_at=${invocationStartedAt} WHERE call_key=${request.callKey}
          AND ((status='reserved') OR (status='invoking' AND recovery_generation<>${recoveryGeneration})) RETURNING call_key`[0];
        if (!claimedCall) throw new Error("codemode_inner_claim_lost");
        try {
          if (request.method === "catalog.search") return searchToolCatalogV3(snapshot, {
            query: typeof request.args.query === "string" ? request.args.query : "",
            tags: Array.isArray(request.args.tags) ? request.args.tags.filter((item): item is string => typeof item === "string") : [],
            ownerDomain: typeof request.args.ownerDomain === "string" ? request.args.ownerDomain : undefined,
            limit: typeof request.args.limit === "number" ? request.args.limit : 8,
            expectedCatalogRevision: snapshot.catalogRevision, expectedSnapshotHash: snapshot.snapshotHash,
          });
          if (request.method === "catalog.describe") return describeToolV3(snapshot, {
            toolKey: requiredText(request.args.toolKey, "codemode_tool_key_invalid"),
            expectedCatalogRevision: snapshot.catalogRevision, expectedSnapshotHash: snapshot.snapshotHash,
          });
          if (request.method === "mcp.call" || request.method === "direct.call") {
            const description = pinnedTool(request);
            const result = await this.executeTelegramReadTool(scope, description.descriptor.providerId, description.descriptor.name,
              record(request.args.args, "codemode_tool_args_invalid"), {
                taskId: await deriveCodeModeInnerTaskId({ outerTaskId: taskId, executionId, callKey: request.callKey }),
                idempotencyKey: `codemode:${request.callKey}`,
                purpose: "operia_think_codemode_v2",
              });
            if ("pending" in result) throw new Error("codemode_downstream_result_unknown");
            return result;
          }
          if (request.method === "skill.metadata") {
            const query = typeof request.args.query === "string" ? request.args.query.toLowerCase() : "";
            return this.installedSkills().filter(({ skill }) => !skill.key.includes("browser"))
              .filter(({ alias, skill }) => !query || `${alias} ${skill.key} ${skill.description}`.toLowerCase().includes(query))
              .slice(0, typeof request.args.limit === "number" ? request.args.limit : 8)
              .map(({ alias, revision, skill }) => ({ alias, revision, key: skill.key, version: skill.version,
                schemaHash: skill.schemaHash, sourceHash: skill.sourceHash, kind: skill.kind, description: skill.description }));
          }
          if (request.method === "skill.activate" || request.method === "skill.readResource") {
            const entry = pinnedSkill(request);
            const input = request.args.input as JsonValue;
            if (!validateSkillInput(entry.skill, input)) throw new Error("invalid_arguments");
            if (request.method === "skill.readResource" && entry.skill.kind !== "reference") throw new Error("codemode_skill_not_reference");
            return entry.skill.kind === "prompt"
              ? { kind: "prompt", target: entry.skill.target, prompt: entry.skill.prompt, input }
              : entry.skill.kind === "reference"
                ? { kind: "reference", mediaType: entry.skill.mediaType, reference: entry.skill.reference, input }
                : { kind: "deterministicWorkflow", allowedToolKeys: entry.skill.allowedToolKeys, steps: entry.skill.steps, input };
          }
          if (request.method === "sandbox.run") {
            return await execute<Sandbox>Script(this.env as SandboxWorkerEnv, {
              ownerId: scope.ownerId,
              taskId: await deriveCodeModeSandboxTaskId({ outerTaskId: taskId, executionId, callKey: request.callKey }),
              environment: this.env.AGENT_SANDBOX_CANARY_ENABLED?.trim().toLowerCase() === "true" ? "qa" : "production",
              args: { script: request.args.script, timeout_ms: request.args.timeoutMs },
            }, new AbortController().signal);
          }
          throw new Error("codemode_method_denied");
        } catch (error) {
          const errorCode = boundedAgentErrorCode(error, "codemode_inner_failed");
          const knownFailure = replayPolicy === "safe_local" || errorCode.includes("policy_denied") || errorCode.includes("pin_drift");
          this.sql`UPDATE operia_codemode_inner_calls SET status=${knownFailure ? "failed" : "unknown"},error_code=${errorCode},
            updated_at=${new Date().toISOString()} WHERE call_key=${request.callKey} AND status='invoking'
            AND recovery_generation=${recoveryGeneration}`;
          throw error;
        }
      },
      loadReceipt: async (callKey: string): Promise<OperiaCodeModeReceipt | null> => {
        const row = this.sql<RuntimeRow>`SELECT * FROM operia_codemode_receipts WHERE call_key=${callKey}`[0];
        if (!row) return null;
        return {
          callKey: String(row.call_key), argsHash: String(row.args_hash), result: this.parseJson(String(row.result_json), null),
          resultHash: String(row.result_hash), resultBytes: Number(row.result_bytes), classification: String(row.classification),
          sensitivity: this.parseJson(String(row.sensitivity_json), []), truncated: Number(row.truncated) === 1,
          policyVersion: String(row.policy_version), catalogRevision: String(row.catalog_revision), connectorVersion: String(row.connector_version),
        };
      },
      saveReceipt: async (receipt: OperiaCodeModeReceipt): Promise<void> => {
        renewExecutionLease();
        this.ctx.storage.transactionSync(() => {
          this.sql`INSERT INTO operia_codemode_receipts
            (call_key,task_id,execution_id,args_hash,result_json,result_hash,result_bytes,classification,sensitivity_json,truncated,
              policy_version,catalog_revision,connector_version,created_at)
            VALUES (${receipt.callKey},${taskId},${executionId},${receipt.argsHash},${canonicalJsonStringify(receipt.result)},${receipt.resultHash},
              ${receipt.resultBytes},${receipt.classification},${canonicalJsonStringify(receipt.sensitivity)},${receipt.truncated ? 1 : 0},
              ${receipt.policyVersion},${receipt.catalogRevision},${receipt.connectorVersion},${new Date().toISOString()})`;
          const completedCall = this.sql<{ call_key: string }>`UPDATE operia_codemode_inner_calls SET status='completed',
            result_receipt_hash=${receipt.resultHash},error_code=NULL,updated_at=${new Date().toISOString()}
            WHERE call_key=${receipt.callKey} AND status='invoking' AND recovery_generation=${recoveryGeneration} RETURNING call_key`[0];
          if (!completedCall) throw new Error("codemode_inner_completion_claim_lost");
        });
      },
      audit: async (event: OperiaCodeModeAudit): Promise<void> => {
        this.audit(event.event, `think:${taskId}`, event.callKey, { ...event, argsHash: event.argsHash, externalWrites: 0 });
      },
    };
    try {
      const mode = createOperiaGeneralReadCodeMode({ ctx: this.ctx, loader: this.env.LOADER, runtimeName, taskId, host });
      const result = await mode.execute(code);
      renewExecutionLease();
      if (result.status !== "completed") throw new Error(result.status === "error"
        ? `codemode_v2_error:${String(result.error ?? "failed").slice(0, 160)}` : "codemode_v2_unexpected_pause");
      const receipt = { version: 1, requestId, executionId, status: result.status, result: result.result, externalWrites: 0 };
      const receiptHash = await sha256Hex(canonicalJsonStringify(receipt));
      const response = { kind: "codemode_completed", ...receipt, receiptHash, approvalRequired: false };
      const completed = this.sql<{ execution_id: string }>`UPDATE operia_codemode_executions SET status='completed',code_text='',
        result_json=${canonicalJsonStringify(response)},result_hash=${receiptHash},error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=${new Date().toISOString()}
        WHERE execution_id=${executionId} AND status='executing' AND lease_owner=${leaseOwner}
          AND recovery_generation=${recoveryGeneration} RETURNING execution_id`[0];
      if (!completed) throw new Error("codemode_execution_completion_claim_lost");
      return json(response);
    } catch (error) {
      const errorCode = boundedAgentErrorCode(error, "codemode_v2_failed");
      if (errorCode === "codemode_execution_lease_lost" || errorCode === "codemode_execution_completion_claim_lost") {
        return json({ kind: "codemode_pending", requestId, executionId, status: "executing", pending: true, retryAfterMs: 1_000, externalWrites: 0 },
          { status: 202, headers: { "retry-after": "1" } });
      }
      const current = this.sandboxControlSnapshot();
      this.sql`UPDATE operia_codemode_inner_calls SET
        status=CASE WHEN status='reserved' OR replay_policy='safe_local' THEN 'failed' ELSE 'unknown' END,
        error_code=COALESCE(error_code,${errorCode}),updated_at=${new Date().toISOString()}
        WHERE execution_id=${executionId} AND status IN ('reserved','invoking') AND recovery_generation=${recoveryGeneration}`;
      const unknownInnerCalls = Number(this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM operia_codemode_inner_calls
        WHERE execution_id=${executionId} AND status='unknown'`[0]?.count ?? 0);
      const status = current.paused || current.generation !== control.generation
        ? "quarantined"
        : errorCode.includes("_drift")
          ? "quarantined"
          : unknownInnerCalls > 0 || errorCode.includes("unknown") || errorCode.includes("in_progress")
          ? "attention_required"
          : "failed";
      this.sql`UPDATE operia_codemode_executions SET status=${status},code_text='',error_code=${errorCode},lease_owner=NULL,
        lease_expires_at=NULL,updated_at=${new Date().toISOString()} WHERE execution_id=${executionId} AND status='executing'
        AND lease_owner=${leaseOwner} AND recovery_generation=${recoveryGeneration}`;
      return json({ error: errorCode, requestId, executionId, status, externalWrites: 0 }, { status: status === "quarantined" ? 423 : 409 });
    }
  }

  private async handleThinkCodeModeLifecycle(
    action: "resume" | "status" | "stop",
    body: Record<string, unknown>,
  ): Promise<Response> {
    const executionId = typeof body.executionId === "string" && /^cmxe_[a-f0-9]{64}$/.test(body.executionId)
      ? body.executionId : null;
    const authorityScopeHash = typeof body.authorityScopeHash === "string" && /^[a-f0-9]{64}$/.test(body.authorityScopeHash)
      ? body.authorityScopeHash : null;
    if (!executionId || !authorityScopeHash) return json({ error: "think_codemode_lifecycle_input_invalid" }, { status: 422 });
    const row = this.sql<RuntimeRow>`SELECT * FROM operia_codemode_executions WHERE execution_id=${executionId}`[0];
    if (!row) return json({ error: "think_codemode_execution_not_found" }, { status: 404 });
    const scope = {
      ownerId: String(row.owner_id),
      chatId: String(row.chat_id),
      scopeKind: String(row.scope_kind) as "private" | "qa_room",
      threadKey: String(row.thread_key),
    };
    const expectedAuthorityHash = await sha256Hex([
      "operia:think:approval-authority:v1",
      scope.ownerId,
      scope.chatId,
      scope.scopeKind,
      scope.threadKey,
    ].join("\0"));
    if (expectedAuthorityHash !== authorityScopeHash) return json({ error: "think_codemode_authority_scope_mismatch" }, { status: 403 });
    const status = String(row.status);
    if (["completed", "failed", "quarantined", "attention_required"].includes(status) && String(row.code_text ?? "")) {
      this.sql`UPDATE operia_codemode_executions SET code_text='' WHERE execution_id=${executionId}`;
    }
    if (action === "status") {
      if (status === "completed") return json(this.parseJson(String(row.result_json ?? "{}"), {}));
      if (["failed", "quarantined", "attention_required"].includes(status)) {
        return json({ kind: "codemode_terminal", executionId, requestId: String(row.request_id), status,
          error: String(row.error_code ?? `codemode_${status}`), externalWrites: 0 }, { status: status === "quarantined" ? 423 : 409 });
      }
      const retryAt = row.lease_expires_at ? Date.parse(String(row.lease_expires_at)) : Date.now() + 250;
      return json({ kind: "codemode_pending", executionId, requestId: String(row.request_id), status, pending: true,
        recoveryGeneration: Number(row.recovery_generation ?? 0), retryAfterMs: Math.max(250, retryAt - Date.now()), externalWrites: 0 }, {
        status: 202, headers: { "retry-after": "1" },
      });
    }
    if (action === "stop") {
      if (status === "completed") return json(this.parseJson(String(row.result_json ?? "{}"), {}));
      if (["failed", "quarantined", "attention_required"].includes(status)) {
        return json({ kind: "codemode_terminal", executionId, requestId: String(row.request_id), status,
          error: String(row.error_code ?? `codemode_${status}`), externalWrites: 0 }, { status: 202 });
      }
      const now = new Date().toISOString();
      this.sql`UPDATE operia_codemode_inner_calls SET
        status=CASE WHEN status='reserved' OR replay_policy='safe_local' THEN 'failed' ELSE 'unknown' END,
        error_code=COALESCE(error_code,'codemode_owner_stopped'),updated_at=${now}
        WHERE execution_id=${executionId} AND status IN ('reserved','invoking')`;
      this.sql`UPDATE operia_codemode_executions SET status='quarantined',code_text='',error_code='codemode_owner_stopped',
        lease_owner=NULL,lease_expires_at=NULL,updated_at=${now}
        WHERE execution_id=${executionId} AND status IN ('accepted','executing')`;
      return json({ kind: "codemode_terminal", executionId, requestId: String(row.request_id), status: "quarantined",
        error: "codemode_owner_stopped", externalWrites: 0 }, { status: 202 });
    }
    if (status === "completed") return json(this.parseJson(String(row.result_json ?? "{}"), {}));
    if (["failed", "quarantined", "attention_required"].includes(status)) {
      return json({ kind: "codemode_terminal", executionId, requestId: String(row.request_id), status,
        error: String(row.error_code ?? `codemode_${status}`), externalWrites: 0 }, { status: status === "quarantined" ? 423 : 409 });
    }
    const code = String(row.code_text ?? "");
    if (!code) return json({ error: "think_codemode_code_missing" }, { status: 409 });
    return this.handleThinkCodeModeV2(String(row.request_id), code, scope, "resume");
  }

  private handleThinkSkillSearch(body: Record<string, unknown>): Response {
    const query = typeof body.query === "string" ? body.query.trim().toLowerCase() : "";
    const skills = this.installedSkills()
      .filter(({ skill }) => !skill.key.includes("browser"))
      .filter(({ alias, skill }) => !query || `${alias} ${skill.key} ${skill.description}`.toLowerCase().includes(query))
      .slice(0, 8)
      .map(({ alias, revision, skill }) => ({ alias, key: skill.key, version: skill.version, revision, kind: skill.kind, description: skill.description }));
    return json({ installationRevision: this.thinkSkillInstallationRevision(), skills });
  }

  private async handleThinkSkillActivate(body: Record<string, unknown>): Promise<Response> {
    const key = typeof body.skillKey === "string" ? body.skillKey : "";
    const entry = this.installedSkills().find(({ alias, skill }) => (alias === key || skill.key === key) && !skill.key.includes("browser"));
    if (!entry) return json({ error: "think_skill_unavailable" }, { status: 404 });
    const resolved = await resolveSkillRegistryEntry(this.installedSkills().map((item) => item.skill), entry.skill.key);
    if (!resolved.ok) return json({ error: resolved.code }, { status: 409 });
    const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as JsonValue : {};
    if (!validateSkillInput(resolved.skill, input)) return json({ error: "invalid_arguments" }, { status: 422 });
    const content = resolved.skill.kind === "prompt"
      ? { kind: "prompt", target: resolved.skill.target, prompt: resolved.skill.prompt, input }
      : resolved.skill.kind === "reference"
        ? { kind: "reference", mediaType: resolved.skill.mediaType, reference: resolved.skill.reference, input }
        : { kind: "deterministicWorkflow", allowedToolKeys: resolved.skill.allowedToolKeys, steps: resolved.skill.steps, input };
    this.audit("think.skill.activated", "memory-think", resolved.skill.key, { kind: resolved.skill.kind, revision: entry.revision });
    return json({ skillKey: resolved.skill.key, version: resolved.skill.version, installationRevision: this.thinkSkillInstallationRevision(), content });
  }

  private thinkSkillInstallationRevision(): string {
    return this.installedSkills().map(({ alias, revision, manifestHash }) => `${alias}:${revision}:${manifestHash.slice(0, 12)}`).join("|") || "skills-empty";
  }

  private telegramToolCatalog(): Array<{ alias: string; tool: ToolCatalogEntry }> {
    const { catalog } = this.loadExecutableCatalog();
    return catalog
      .filter((tool) => tool.riskLevel === "read" && tool.toolName !== "browser_execute")
      .map((tool) => ({
        alias: tool.serverId === OBSERVER_MCP_SERVER_ID && tool.toolName === "system_status"
          ? "status"
          : `${tool.serverId.replace(/[^a-z0-9]+/gi, "_")}_${tool.toolName.replace(/[^a-z0-9]+/gi, "_")}`.toLowerCase().slice(0, 64),
        tool,
      }));
  }

  private parseTelegramToolValue(value: unknown): unknown {
    if (typeof value !== "string") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
    if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
      return this.parseJson(value, value);
    }
    return value;
  }

  private async executeTelegramReadTool(
    scope: { ownerId: string; chatId: string },
    serverId: string,
    toolName: string,
    args: unknown,
    execution?: { taskId: string; idempotencyKey: string; purpose: string; durable?: boolean },
  ) {
    const { catalog, observedCatalog, allowlists } = this.loadExecutableCatalog();
    const decision = await evaluateToolPolicy({ catalog, observedCatalog, allowlist: allowlists.get(serverId) ?? [], serverId, toolName, args });
    if (!decision.ok || decision.requiresApproval || decision.riskLevel !== "read") throw new Error("telegram_tool_policy_denied");
    const taskId = execution?.taskId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const requestHash = await canonicalArgsHash(args);
    const idempotencyKey = execution?.idempotencyKey ?? `tg-command:${scope.chatId}:${taskId}`;
    const scopedFiberKey = this.scopedTaskFiberKey(scope.ownerId, "telegram-agent", idempotencyKey);
    const replay = this.sql<{ id: string; status: string; checkpoint_json: string | null }>`SELECT id,status,checkpoint_json FROM delegated_tasks
      WHERE owner_id=${scope.ownerId} AND service_id='telegram-agent' AND client_idempotency_key=${idempotencyKey}`[0];
    if (replay?.status === "completed" && replay.checkpoint_json) {
      const checkpoint = this.parseJson<ToolTaskCheckpoint | null>(replay.checkpoint_json, null);
      const result = checkpoint?.results?.[0];
      if (result) return { ...result, taskId };
    }
    if (replay) return { pending: true as const, taskId: replay.id, status: replay.status };
    const input: DelegatedTaskInput = {
      mode: "direct",
      taskId,
      idempotencyKey,
      capsuleId: "telegram-command",
      instruction: toolName,
      directCall: { serverId, toolName, args: args as never },
      namespace: "default",
      chatId: scope.chatId,
      recipient: "telegram-command",
      purpose: execution?.purpose ?? "telegram_slash_command",
      requestHash,
      ownerId: scope.ownerId,
      serviceId: "telegram-agent",
    };
    const durable = execution?.durable === true;
    const initial: ToolTaskCheckpoint = { taskId, status: durable ? "accepted" : "executing", round: 0, callCount: 0, completedCallKeys: [], results: [] };
    this.sql`INSERT INTO delegated_tasks
      (id,idempotency_key,client_idempotency_key,owner_id,service_id,chat_id,root_task_id,parent_task_id,
       task_revision,pause_generation,status,input_json,checkpoint_json,repair_generation,created_at,updated_at)
      VALUES (${taskId},${scopedFiberKey},${input.idempotencyKey},${input.ownerId},${input.serviceId},${input.chatId},
        ${input.rootTaskId || input.taskId},${input.parentTaskId ?? null},1,0,${durable ? "accepted" : "executing"},
        ${JSON.stringify(input)},${JSON.stringify(initial)},0,${now},${now})`;
    if (!durable) {
      const callKey = `${taskId}:${serverId}:${toolName}:${requestHash}`;
      const raw = await this.invokeMcpTool({ serverId, toolName, args }, callKey, taskId, new AbortController().signal);
      if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).kind === "deferred_tool_approval") {
        this.persistTaskCheckpoint({ ...initial, status: "approval_required", callCount: 1, pendingCall: { serverId, toolName, args: args as never } });
        return { pending: true as const, taskId, status: "approval_required" as const };
      }
      const result = sanitizeToolResult({ catalog, serverId, toolName, result: raw });
      this.persistTaskCheckpoint({ ...initial, status: "completed", round: 1, callCount: 1, completedCallKeys: [callKey], results: [result] });
      return { ...result, taskId };
    }
    this.recordTaskProgress(taskId, "task.accepted", "斜杠命令工具任务已接收", { phase: "accepted" });
    const receipt = await this.startDelegatedFiber(input, initial, scopedFiberKey);
    this.audit("telegram.command.tool.accepted", "context-service:telegram-agent", `${serverId}/${toolName}`, {
      taskId, fiberId: receipt.fiberId, accepted: receipt.accepted,
    });
    return { pending: true as const, taskId, status: "accepted" as const };
  }

  private hooksEnabled(): boolean {
    return (this.state.capabilities["tools.hooks"] ?? "enabled") === "enabled"
      && this.env.HOOKS_ENABLED?.trim().toLowerCase() === "true";
  }

  private heartbeatEnabled(): boolean {
    return (this.state.capabilities["agent.heartbeat"] ?? "enabled") === "enabled"
      && this.env.HEARTBEAT_ENABLED?.trim().toLowerCase() === "true";
  }

  private heartbeatIntervalSeconds(): number {
    const configured = Number(this.env.HEARTBEAT_INTERVAL_SECONDS);
    return Number.isSafeInteger(configured) && configured >= 60 && configured <= 3_600 ? configured : 300;
  }

  private listHooks(): RuntimeRow[] {
    return this.sql<RuntimeRow>`SELECT id,owner_id,service_id,event,filter_json,mode,failure_policy,enabled,
      target_type,handler,webhook_url,created_at,updated_at FROM hook_definitions ORDER BY created_at DESC`;
  }

  private listHookRuns(): RuntimeRow[] {
    return this.sql<RuntimeRow>`SELECT id,hook_id,event,status,reasons_json,created_at FROM hook_runs ORDER BY created_at DESC LIMIT 100`;
  }

  private saveHook(body: Record<string, unknown>, replacing: boolean): Response {
    const id = typeof body.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(body.id) ? body.id : crypto.randomUUID();
    const existing = this.sql<CountRow>`SELECT COUNT(*) AS count FROM hook_definitions WHERE id=${id}`[0]?.count ?? 0;
    if (!replacing && existing > 0) return json({ error: "hook_already_exists" }, { status: 409 });
    if (replacing && existing === 0) return json({ error: "hook_not_found" }, { status: 404 });
    const target = body.target;
    if (!target || typeof target !== "object" || Array.isArray(target)) return json({ error: "hook_target_required" }, { status: 422 });
    const targetRecord = target as Record<string, unknown>;
    if ("secret" in targetRecord || "token" in targetRecord || "authorization" in targetRecord) {
      return json({ error: "hook_secret_must_be_wrangler_secret" }, { status: 422 });
    }
    const targetType = targetRecord.type;
    const handler = targetType === "builtin" && typeof targetRecord.handler === "string" ? targetRecord.handler : undefined;
    const webhookUrl = targetType === "webhook" && typeof targetRecord.url === "string" ? targetRecord.url : undefined;
    if (handler && !["builtin:noop", "builtin:allow", "builtin:deny"].includes(handler)) {
      return json({ error: "hook_builtin_not_allowed" }, { status: 422 });
    }
    if (!handler && !webhookUrl) return json({ error: "hook_target_invalid" }, { status: 422 });
    const secret = this.env.AGENT_HOOK_WEBHOOK_SECRET?.trim();
    if (webhookUrl && !secret) return json({ error: "hook_webhook_secret_not_configured" }, { status: 503 });
    const ownerId = typeof body.ownerId === "string" ? body.ownerId : this.env.AGENT_CONTEXT_OWNER_ID ?? "";
    const serviceId = typeof body.serviceId === "string" ? body.serviceId : this.env.AGENT_CONTEXT_SERVICE_ID ?? "";
    let normalized;
    try {
      normalized = normalizeAgentHookDefinition({
        id,
        scope: { ownerId, serviceId },
        event: body.event,
        filter: body.filter,
        mode: body.mode,
        failurePolicy: body.failurePolicy,
        enabled: body.enabled,
        ...(handler ? { handler } : { webhook: { url: webhookUrl!, secret: secret! } }),
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "invalid_hook" }, { status: 422 });
    }
    const now = new Date().toISOString();
    this.sql`INSERT INTO hook_definitions (id,owner_id,service_id,event,filter_json,mode,failure_policy,enabled,
      target_type,handler,webhook_url,created_at,updated_at)
      VALUES (${id},${normalized.scope.ownerId},${normalized.scope.serviceId},${normalized.event},${JSON.stringify(normalized.filter ?? {})},
        ${normalized.mode},${normalized.failurePolicy},${normalized.enabled ? 1 : 0},${handler ? "builtin" : "webhook"},
        ${handler ?? null},${webhookUrl ?? null},${now},${now})
      ON CONFLICT(id) DO UPDATE SET owner_id=${normalized.scope.ownerId},service_id=${normalized.scope.serviceId},event=${normalized.event},
        filter_json=${JSON.stringify(normalized.filter ?? {})},mode=${normalized.mode},failure_policy=${normalized.failurePolicy},
        enabled=${normalized.enabled ? 1 : 0},target_type=${handler ? "builtin" : "webhook"},handler=${handler ?? null},
        webhook_url=${webhookUrl ?? null},updated_at=${now}`;
    this.audit("hook.saved", "management-api", id, { event: normalized.event, mode: normalized.mode, enabled: normalized.enabled, targetType });
    return json({ hook: this.listHooks().find((row) => row.id === id) }, { status: replacing ? 200 : 201 });
  }

  private deleteHook(id: string): Response {
    const existing = this.sql<CountRow>`SELECT COUNT(*) AS count FROM hook_definitions WHERE id=${id}`[0]?.count ?? 0;
    if (!existing) return json({ error: "hook_not_found" }, { status: 404 });
    this.sql`DELETE FROM hook_definitions WHERE id=${id}`;
    this.audit("hook.deleted", "management-api", id, {});
    return json({ ok: true });
  }

  private toggleHook(id: string, body: Record<string, unknown>): Response {
    if (typeof body.enabled !== "boolean") return json({ error: "hook_enabled_boolean_required" }, { status: 422 });
    const now = new Date().toISOString();
    const updated = this.sql<RuntimeRow>`UPDATE hook_definitions SET enabled=${body.enabled ? 1 : 0},updated_at=${now}
      WHERE id=${id} RETURNING id,owner_id,service_id,event,filter_json,mode,failure_policy,enabled,
        target_type,handler,webhook_url,created_at,updated_at`[0];
    if (!updated) return json({ error: "hook_not_found" }, { status: 404 });
    this.audit("hook.toggled", "management-api", id, { enabled: body.enabled });
    return json({ hook: updated });
  }

  private hookRegistry(): AgentHookRegistry {
    const registry = new AgentHookRegistry({ enabled: this.hooksEnabled() });
    registry.registerHandler("runtime:webhook-secret-missing", () => { throw new Error("hook_webhook_secret_missing"); });
    const secret = this.env.AGENT_HOOK_WEBHOOK_SECRET?.trim();
    const rows = this.sql<{ id: string; owner_id: string; service_id: string; event: AgentHookEvent; filter_json: string;
      mode: "advisory" | "gate"; failure_policy: "fail-open" | "fail-closed"; enabled: number;
      target_type: string; handler: string | null; webhook_url: string | null }>`
      SELECT id,owner_id,service_id,event,filter_json,mode,failure_policy,enabled,target_type,handler,webhook_url FROM hook_definitions`;
    for (const row of rows) {
      const definition: AgentHookDefinition = {
        id: row.id,
        scope: { ownerId: row.owner_id, serviceId: row.service_id },
        event: row.event,
        filter: this.parseJson(row.filter_json, {}),
        mode: row.mode,
        failurePolicy: row.failure_policy,
        enabled: row.enabled === 1,
        ...(row.target_type === "webhook" && row.webhook_url && secret
          ? { webhook: { url: row.webhook_url, secret } }
          : { handler: row.target_type === "webhook" ? "runtime:webhook-secret-missing" : row.handler ?? "builtin:noop" }),
      };
      try { registry.register(definition); } catch (error) {
        console.warn("invalid persisted hook", row.id, error instanceof Error ? error.message : String(error));
      }
    }
    return registry;
  }

  private async dispatchHooks(event: AgentHookEvent, input: Pick<DelegatedTaskInput, "ownerId" | "serviceId">, payload: unknown, throwOnDenied = true): Promise<void> {
    const result = await this.hookRegistry().dispatch({ ownerId: input.ownerId, serviceId: input.serviceId, event, payload });
    const now = new Date().toISOString();
    for (const outcome of result.outcomes) {
      this.sql`INSERT INTO hook_runs (id,hook_id,event,status,reasons_json,created_at)
        VALUES (${crypto.randomUUID()},${outcome.hookId},${event},${outcome.status},${JSON.stringify(outcome.reasons)},${now})`;
    }
    if (throwOnDenied && !result.allowed) throw new Error(`hook_gate_denied:${event}`);
  }

  private ensureHeartbeatOwnerState(): void {
    const now = new Date();
    const nowIso = now.toISOString();
    const config = DEFAULT_HEARTBEAT_CONFIG;
    const runtime = initialHeartbeatRuntime(now, config);
    this.sql`INSERT OR IGNORE INTO heartbeat_config (id,value_json,revision,actor,created_at,updated_at)
      VALUES ('owner',${JSON.stringify(config)},1,'migration:heartbeat-studio',${nowIso},${nowIso})`;
    this.sql`INSERT OR IGNORE INTO heartbeat_runtime
      (id,mode,activated_at,last_real_activity_at,last_warm_at,local_date,pulses_used,first_pulse_dry_run_pending,updated_at)
      VALUES ('owner',${runtime.mode},NULL,NULL,NULL,${runtime.localDate},0,1,${nowIso})`;
    const stored = this.sql<{ value_json: string; revision: number }>`SELECT value_json,revision FROM heartbeat_config WHERE id='owner'`[0];
    if (stored) {
      const normalized = normalizeHeartbeatConfig(this.parseJson(stored.value_json, {}));
      const safe = normalized.mode === "active" && !this.hasActiveHeartbeatGrant(nowIso)
        ? { ...normalized, mode: "observe" as const } : normalized;
      if (JSON.stringify(safe) !== stored.value_json) {
        this.sql`UPDATE heartbeat_config SET value_json=${JSON.stringify(safe)},revision=revision+1,
          actor='migration:heartbeat-observe-active-grant-v1',updated_at=${nowIso} WHERE id='owner'`;
      }
    }
    this.sql`UPDATE heartbeat_runtime SET mode='observe',activated_at=NULL,updated_at=${nowIso}
      WHERE id='owner' AND (mode='armed' OR (mode='active' AND NOT EXISTS (
        SELECT 1 FROM heartbeat_activation_grants
        WHERE owner_id=${this.env.AGENT_CONTEXT_OWNER_ID?.trim() ?? ""} AND status='active' AND expires_at>${nowIso}
      )))`;
  }

  private hasActiveHeartbeatGrant(now = new Date().toISOString()): boolean {
    const ownerId = this.env.AGENT_CONTEXT_OWNER_ID?.trim() ?? "";
    return Boolean(ownerId && this.sql<CountRow>`SELECT COUNT(*) AS count FROM heartbeat_activation_grants
      WHERE owner_id=${ownerId} AND status='active' AND expires_at>${now}`[0]?.count);
  }

  private heartbeatConfigRow(): { config: HeartbeatConfig; revision: number; updatedAt: string } {
    const row = this.sql<{ value_json: string; revision: number; updated_at: string }>`
      SELECT value_json,revision,updated_at FROM heartbeat_config WHERE id='owner'`[0];
    if (!row) throw new Error("heartbeat_config_missing");
    let config = normalizeHeartbeatConfig(this.parseJson(row.value_json, {}));
    if (config.mode === "active" && !this.hasActiveHeartbeatGrant()) {
      const now = new Date().toISOString();
      config = { ...config, mode: "observe" };
      this.sql`UPDATE heartbeat_config SET value_json=${JSON.stringify(config)},revision=revision+1,
        actor='runtime:heartbeat-grant-expired',updated_at=${now} WHERE id='owner' AND revision=${row.revision}`;
      this.sql`UPDATE heartbeat_runtime SET mode='observe',activated_at=NULL,updated_at=${now} WHERE id='owner'`;
      this.sql`UPDATE heartbeat_activation_grants SET status='expired',updated_at=${now}
        WHERE status='active' AND expires_at<=${now}`;
      this.sql`UPDATE heartbeat_intents SET status='cancelled_off',lease_token=NULL,lease_until=NULL,
        error_code='heartbeat_grant_inactive',updated_at=${now} WHERE status IN ('scheduled','leased')`;
      return { config, revision: Number(row.revision) + 1, updatedAt: now };
    }
    return { config, revision: Number(row.revision), updatedAt: row.updated_at };
  }

  private heartbeatRuntime(): HeartbeatRuntime {
    const row = this.sql<{ mode: string; activated_at: string | null; last_real_activity_at: string | null; last_warm_at: string | null;
      local_date: string; pulses_used: number; first_pulse_dry_run_pending: number }>`
      SELECT mode,activated_at,last_real_activity_at,last_warm_at,local_date,pulses_used,first_pulse_dry_run_pending
      FROM heartbeat_runtime WHERE id='owner'`[0];
    if (!row) throw new Error("heartbeat_runtime_missing");
    return {
      mode: row.mode === "active" || row.mode === "off" ? row.mode : "observe",
      activatedAt: row.activated_at,
      lastRealActivityAt: row.last_real_activity_at,
      lastWarmAt: row.last_warm_at,
      localDate: row.local_date,
      pulsesUsed: Number(row.pulses_used),
      firstPulseDryRunPending: row.first_pulse_dry_run_pending === 1,
    };
  }

  private saveHeartbeatRuntime(runtime: HeartbeatRuntime): void {
    this.sql`UPDATE heartbeat_runtime SET mode=${runtime.mode},activated_at=${runtime.activatedAt},
      last_real_activity_at=${runtime.lastRealActivityAt},last_warm_at=${runtime.lastWarmAt},local_date=${runtime.localDate},
      pulses_used=${runtime.pulsesUsed},first_pulse_dry_run_pending=${runtime.firstPulseDryRunPending ? 1 : 0},
      updated_at=${new Date().toISOString()} WHERE id='owner'`;
  }

  private heartbeatSnapshot(): Record<string, unknown> {
    const owner = this.heartbeatConfigRow();
    const runtime = rollHeartbeatDay(this.heartbeatRuntime(), owner.config, new Date());
    this.saveHeartbeatRuntime(runtime);
    return {
      owner: "agent.example.com",
      ownerVersion: `heartbeat-${owner.revision}`,
      revision: owner.revision,
      source: "owner_store",
      updatedAt: owner.updatedAt,
      config: owner.config,
      runtime,
      status: {
        scheduled: Number(this.sql<CountRow>`SELECT COUNT(*) AS count FROM heartbeat_intents WHERE status='scheduled'`[0]?.count ?? 0),
        leased: Number(this.sql<CountRow>`SELECT COUNT(*) AS count FROM heartbeat_intents WHERE status='leased'`[0]?.count ?? 0),
      },
      activation: {
        grantActive: this.hasActiveHeartbeatGrant(),
        pending: this.sql<{ id: string; expires_at: string; created_at: string }>`SELECT id,expires_at,created_at
          FROM heartbeat_activation_requests WHERE status='pending' AND expires_at>${new Date().toISOString()}
          ORDER BY created_at DESC LIMIT 1`[0] ?? null,
      },
      links: { canonical: "https://agent.example.com/tools/heartbeat", telegram: "https://tgbot.example.com/admin#heartbeat" },
    };
  }

  private heartbeatServiceProjection(binding: { ownerId: string; serviceId: string }): Record<string, unknown> {
    const pending = this.sql<{ id: string; nonce: string; expires_at: string; config_revision: number; created_at: string }>`
      SELECT id,nonce,expires_at,config_revision,created_at FROM heartbeat_activation_requests
      WHERE owner_id=${binding.ownerId} AND status='pending' AND expires_at>${new Date().toISOString()}
      ORDER BY created_at DESC LIMIT 10`;
    return { ...this.heartbeatSnapshot(), activationRequests: pending.map((row) => ({
      requestId: row.id, nonce: row.nonce, expiresAt: row.expires_at,
      configRevision: Number(row.config_revision), createdAt: row.created_at,
    })) };
  }

  private recordHeartbeatActivity(body: Record<string, unknown>, binding: { serviceId: string }): Response {
    const eventKey = typeof body.eventKey === "string" ? body.eventKey.trim() : "";
    const kind = typeof body.kind === "string" ? body.kind : "";
    const chatRef = typeof body.chatRef === "string" ? body.chatRef.trim() : "";
    if (!/^[A-Za-z0-9:_-]{8,200}$/.test(eventKey) || !qualifiesAsRealActivity(kind) || !chatRef || chatRef.length > 160) {
      return json({ error: "heartbeat_activity_invalid" }, { status: 422 });
    }
    const at = typeof body.occurredAt === "string" ? new Date(body.occurredAt) : new Date();
    if (!Number.isFinite(at.getTime()) || Math.abs(Date.now() - at.getTime()) > 24 * 60 * 60_000) {
      return json({ error: "heartbeat_activity_time_invalid" }, { status: 422 });
    }
    const now = new Date().toISOString();
    const inserted = this.sql<{ event_key: string }>`INSERT OR IGNORE INTO heartbeat_activities
      (event_key,kind,chat_ref,occurred_at,created_at) VALUES (${eventKey},${kind},${chatRef},${at.toISOString()},${now}) RETURNING event_key`;
    if (inserted.length === 0) return json({ ok: true, duplicate: true, mode: this.heartbeatRuntime().mode });
    const owner = this.heartbeatConfigRow();
    const runtime = applyRealActivity(this.heartbeatRuntime(), owner.config, at);
    this.saveHeartbeatRuntime(runtime);
    this.sql`INSERT INTO heartbeat_events (id,intent_id,event_type,detail_json,created_at)
      VALUES (${crypto.randomUUID()},NULL,'heartbeat.activity.accepted',${JSON.stringify({ kind, serviceId: binding.serviceId, mode: runtime.mode })},${now})`;
    return json({ ok: true, duplicate: false, mode: runtime.mode, activatedAt: runtime.activatedAt });
  }

  private scheduleHeartbeatIntents(now: Date): void {
    const owner = this.heartbeatConfigRow();
    let runtime = rollHeartbeatDay(this.heartbeatRuntime(), owner.config, now);
    this.saveHeartbeatRuntime(runtime);
    const nowIso = now.toISOString();
    if (warmDue(runtime, owner.config, now) && runtime.lastRealActivityAt) {
      const interval = owner.config.warmIntervalMinutes * 60_000;
      const slot = Math.floor(now.getTime() / interval);
      const key = `prefix-warm:${runtime.lastRealActivityAt}:${slot}`;
      this.sql`INSERT OR IGNORE INTO heartbeat_intents
        (id,intent_key,kind,slot_key,due_at,status,dry_run,config_revision,created_at,updated_at)
        VALUES (${crypto.randomUUID()},${key},'prefix_warm',${String(slot)},${nowIso},'scheduled',0,${owner.revision},${nowIso},${nowIso})`;
    }
    const pulse = pulseDue(runtime, owner.config, now);
    if (pulse.due && pulse.slotKey) {
      const key = `companion-pulse:${pulse.slotKey}:r${owner.revision}`;
      this.sql`INSERT OR IGNORE INTO heartbeat_intents
        (id,intent_key,kind,slot_key,due_at,status,dry_run,config_revision,created_at,updated_at)
        VALUES (${crypto.randomUUID()},${key},'companion_pulse',${pulse.slotKey},${nowIso},'scheduled',${pulse.dryRun ? 1 : 0},${owner.revision},${nowIso},${nowIso})`;
    }
  }

  private async claimHeartbeatIntent(_body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): Promise<Response> {
    // Scheduling and lease issuance always use the Durable Object's clock.
    // Fake-clock coverage belongs in the pure heartbeat state machine tests;
    // callers must not be able to backdate or fast-forward production intents.
    const now = new Date();
    if (!Number.isFinite(now.getTime())) return json({ error: "heartbeat_claim_time_invalid" }, { status: 422 });
    this.scheduleHeartbeatIntents(now);
    const nowIso = now.toISOString();
    const ownerBeforeClaim = this.heartbeatConfigRow();
    const runtimeBeforeClaim = this.heartbeatRuntime();
    if (ownerBeforeClaim.config.mode === "off" || runtimeBeforeClaim.mode === "off") {
      const cancelled = this.sql<{ id: string }>`UPDATE heartbeat_intents
        SET status='cancelled_off',lease_token=NULL,lease_until=NULL,error_code='heartbeat_off',updated_at=${nowIso}
        WHERE status IN ('scheduled','leased') RETURNING id`;
      return json({ intent: null, blocked: "off", cancelled: cancelled.length, projection: this.heartbeatSnapshot() });
    }
    this.sql`UPDATE heartbeat_intents SET status='scheduled',lease_token=NULL,lease_until=NULL,
      updated_at=${nowIso} WHERE status='leased' AND lease_until < ${nowIso}`;
    const candidate = this.sql<{ id: string }>`SELECT id FROM heartbeat_intents
      WHERE status='scheduled' AND due_at <= ${nowIso} ORDER BY due_at,id LIMIT 1`[0];
    if (!candidate) return json({ intent: null, projection: this.heartbeatSnapshot() });
    const token = crypto.randomUUID();
    const leaseUntil = new Date(now.getTime() + 15 * 60_000).toISOString();
    const row = this.sql<RuntimeRow>`UPDATE heartbeat_intents SET status='leased',lease_token=${token},lease_until=${leaseUntil},
      attempts=attempts+1,updated_at=${nowIso} WHERE id=${candidate.id} AND status='scheduled'
      RETURNING id,intent_key,kind,slot_key,due_at,dry_run,config_revision,attempts,checkpoint_json`[0];
    if (!row) return json({ intent: null });
    if (Number(row.attempts) > 1) {
      this.sql`UPDATE heartbeat_intents SET status='attention_required',lease_token=NULL,lease_until=NULL,
        error_code='heartbeat_paid_retry_blocked',updated_at=${nowIso} WHERE id=${candidate.id}`;
      this.sql`INSERT INTO heartbeat_events (id,intent_id,event_type,detail_json,created_at)
        VALUES (${crypto.randomUUID()},${candidate.id},'heartbeat.retry.blocked',
          ${JSON.stringify({ attempts: Number(row.attempts), reason: "paid inference is at-most-once" })},${nowIso})`;
      return json({ intent: null, blocked: "paid_retry_limit", projection: this.heartbeatSnapshot() });
    }
    const owner = this.heartbeatConfigRow();
    if (row.kind === "companion_pulse") {
      let runtime = rollHeartbeatDay(this.heartbeatRuntime(), owner.config, now);
      const priorCheckpoint = this.parseJson<Record<string, unknown>>(String(row.checkpoint_json ?? ""), {});
      const quotaAlreadyReserved = priorCheckpoint.quotaReserved === true;
      if (Number(row.dry_run) !== 1 && !quotaAlreadyReserved) {
        if (runtime.pulsesUsed >= owner.config.dailyLimit) {
          this.sql`UPDATE heartbeat_intents SET status='blocked_budget',lease_token=NULL,lease_until=NULL,updated_at=${nowIso} WHERE id=${candidate.id}`;
          return json({ intent: null, blocked: "daily_limit" });
        }
        runtime = { ...runtime, pulsesUsed: runtime.pulsesUsed + 1 };
        this.saveHeartbeatRuntime(runtime);
        this.sql`UPDATE heartbeat_intents SET checkpoint_json=${JSON.stringify({ ...priorCheckpoint, quotaReserved: true, localDate: runtime.localDate })} WHERE id=${candidate.id}`;
      }
      try {
        await this.dispatchHooks("before_companion_pulse", binding, { intentId: candidate.id, dryRun: Number(row.dry_run) === 1, budget: { used: runtime.pulsesUsed, maximum: owner.config.dailyLimit } });
      } catch (error) {
        if (Number(row.dry_run) !== 1) {
          const rolled = rollHeartbeatDay(this.heartbeatRuntime(), owner.config, now);
          this.saveHeartbeatRuntime({ ...rolled, pulsesUsed: Math.max(0, rolled.pulsesUsed - 1) });
        }
        this.sql`UPDATE heartbeat_intents SET status='blocked_hook',lease_token=NULL,lease_until=NULL,error_code='before_companion_pulse_denied',updated_at=${nowIso} WHERE id=${candidate.id}`;
        return json({ intent: null, blocked: "hook" });
      }
    }
    const catalogRows = this.sql<{ id: string; risk_level: string; observed_tool_catalog_json: string }>`
      SELECT id,risk_level,observed_tool_catalog_json FROM mcp_registry WHERE enabled=1`;
    const rawTools = catalogRows.flatMap((server) => this.parseJson<Array<Record<string, unknown>>>(server.observed_tool_catalog_json, []).map((tool) => ({
      serverId: server.id,
      toolName: String(tool.toolName ?? ""),
      riskLevel: String(tool.riskLevel ?? server.risk_level),
      requiresApproval: Boolean(tool.requiresApproval),
      requiresElicitation: Boolean(tool.requiresElicitation),
    })));
    const safeTools = filterHeartbeatTools(rawTools, owner.config);
    return json({
      intent: { ...row, leaseUntil },
      capsule: {
        schemaVersion: 1,
        prompt: owner.config.prompt,
        clock: { now: nowIso, timezone: owner.config.timezone },
        budget: { localDate: this.heartbeatRuntime().localDate, used: this.heartbeatRuntime().pulsesUsed, maximum: owner.config.dailyLimit },
        safeTools,
        policy: { maxToolTasks: 1, browserMaxSteps: owner.config.browserMaxSteps, browserDeadlineMs: owner.config.browserTimeoutSeconds * 1_000 },
      },
    }, { headers: { "x-operia-heartbeat-lease": token } });
  }

  private async finishHeartbeatIntent(id: string, action: "complete" | "fail", body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): Promise<Response> {
    const leaseToken = typeof body.leaseToken === "string" ? body.leaseToken : "";
    const row = this.sql<{ kind: string; slot_key: string | null; dry_run: number; status: string; lease_token: string | null }>`
      SELECT kind,slot_key,dry_run,status,lease_token FROM heartbeat_intents WHERE id=${id}`[0];
    if (!row) return json({ error: "heartbeat_intent_not_found" }, { status: 404 });
    if (row.status !== "leased" || !leaseToken || row.lease_token !== leaseToken) return json({ error: "heartbeat_lease_mismatch" }, { status: 409 });
    const now = new Date().toISOString();
    const decision = body.decision && typeof body.decision === "object" ? body.decision : null;
    const usage = body.usage && typeof body.usage === "object" ? body.usage : null;
    const durationMs = Number.isFinite(Number(body.durationMs)) ? Math.max(0, Math.min(600_000, Number(body.durationMs))) : null;
    if (action === "fail") {
      const retryable = body.retryable === true;
      const status = retryable ? "scheduled" : "attention_required";
      this.sql`UPDATE heartbeat_intents SET status=${status},lease_token=NULL,lease_until=NULL,error_code=${String(body.errorCode ?? "heartbeat_intent_failed").slice(0,160)},updated_at=${now}
        WHERE id=${id} AND status='leased' AND lease_token=${leaseToken}`;
      return json({ ok: true, status });
    }
    this.sql`UPDATE heartbeat_intents SET status='completed',lease_token=NULL,lease_until=NULL,
      decision_json=${decision ? JSON.stringify(decision) : null},checkpoint_json=${JSON.stringify(body.checkpoint ?? {})},updated_at=${now}
      WHERE id=${id} AND status='leased' AND lease_token=${leaseToken}`;
    let runtime = this.heartbeatRuntime();
    if (row.kind === "prefix_warm") runtime = { ...runtime, lastWarmAt: now };
    if (row.kind === "companion_pulse") {
      runtime = { ...runtime, firstPulseDryRunPending: row.dry_run === 1 && row.slot_key !== "manual" ? false : runtime.firstPulseDryRunPending };
      await this.dispatchHooks("after_companion_pulse", { ownerId: binding.ownerId, serviceId: binding.serviceId }, {
        intentId: id, dryRun: row.dry_run === 1, decision: decision && "kind" in decision ? decision.kind : "unknown", durationMs,
      }, false);
    }
    this.saveHeartbeatRuntime(runtime);
    this.sql`INSERT INTO heartbeat_events (id,intent_id,event_type,detail_json,usage_json,duration_ms,created_at)
      VALUES (${crypto.randomUUID()},${id},${row.kind === "prefix_warm" ? "prefix_warm.completed" : "companion_pulse.completed"},
        ${JSON.stringify({ dryRun: row.dry_run === 1, decision: decision && "kind" in decision ? decision.kind : null })},
        ${usage ? JSON.stringify(usage) : null},${durationMs},${now})`;
    return json({ ok: true, status: "completed", runtime });
  }

  private updateHeartbeatConfig(request: Request, body: Record<string, unknown>, actor = "agent-console"): Response {
    const match = request.headers.get("if-match")?.replaceAll('"', "");
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!match) return json({ error: "if_match_required" }, { status: 428 });
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) return json({ error: "idempotency_key_required" }, { status: 428 });
    const current = this.heartbeatConfigRow();
    if (Number(match) !== current.revision) return json({ error: "revision_conflict", revision: current.revision }, { status: 409 });
    let config: HeartbeatConfig;
    try { config = normalizeHeartbeatConfig(body.config ?? body); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "heartbeat_config_invalid" }, { status: 422 }); }
    const existing = this.sql<{ response_json: string | null }>`SELECT response_json FROM idempotency_keys WHERE key=${idempotencyKey} AND operation='heartbeat.config.update'`[0];
    if (existing?.response_json) return json(this.parseJson(existing.response_json, {}));
    const now = new Date().toISOString();
    const revision = current.revision + 1;
    const activeGrant = this.hasActiveHeartbeatGrant(now);
    const activation = resolveHeartbeatActivationMode(config.mode, activeGrant);
    const activationRequested = activation.activationRequired;
    const activationOwnerId = activationRequested ? this.env.AGENT_CONTEXT_OWNER_ID?.trim() : undefined;
    if (activationRequested && !activationOwnerId) {
      return json({ error: "heartbeat_activation_owner_missing" }, { status: 503 });
    }
    const persistedConfig: HeartbeatConfig = { ...config, mode: activation.effectiveMode };
    const changed = this.sql<{ revision: number }>`UPDATE heartbeat_config SET value_json=${JSON.stringify(persistedConfig)},revision=${revision},
      actor=${actor},updated_at=${now} WHERE id='owner' AND revision=${current.revision} RETURNING revision`;
    if (changed.length !== 1) return json({ error: "revision_conflict" }, { status: 409 });
    let runtime = this.heartbeatRuntime();
    runtime = { ...runtime, mode: persistedConfig.mode,
      ...(persistedConfig.mode === "off" ? { activatedAt: null, lastRealActivityAt: null }
        : persistedConfig.mode === "observe" ? { activatedAt: null } : {}) };
    this.saveHeartbeatRuntime(runtime);
    const cancelled = persistedConfig.mode === "off"
      ? this.sql<{ id: string }>`UPDATE heartbeat_intents
          SET status='cancelled_off',lease_token=NULL,lease_until=NULL,error_code='heartbeat_off',updated_at=${now}
          WHERE status IN ('scheduled','leased') RETURNING id`.length
      : 0;
    if (persistedConfig.mode !== "active") {
      this.sql`UPDATE heartbeat_activation_grants SET status='revoked',revoked_at=${now},updated_at=${now}
        WHERE status='active'`;
    }
    if (!activationRequested) {
      this.sql`UPDATE heartbeat_activation_requests SET status='superseded',updated_at=${now}
        WHERE status='pending'`;
    }
    let activationRequest: Record<string, unknown> | null = null;
    if (activationRequested) {
      const requestId = `hba_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const nonce = crypto.randomUUID().replaceAll("-", "");
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      this.sql`UPDATE heartbeat_activation_requests SET status='superseded',updated_at=${now}
        WHERE owner_id=${activationOwnerId!} AND status='pending'`;
      this.sql`INSERT INTO heartbeat_activation_requests
        (id,owner_id,status,requested_mode,config_revision,config_json,requested_by,nonce,expires_at,created_at,updated_at)
        VALUES (${requestId},${activationOwnerId!},'pending','active',${revision},${JSON.stringify(config)},${actor},
          ${nonce},${expiresAt},${now},${now})`;
      activationRequest = {
        requestId, expiresAt,
        telegramDeepLink: `https://t.me/<OWNER_BOT_USERNAME>?start=${encodeURIComponent(`hb_${requestId}`)}`,
        status: "pending_telegram_authorization",
      };
    }
    const response = { ok: true, revision, config: persistedConfig, runtime, cancelledIntents: cancelled,
      activationRequest };
    this.sql`INSERT INTO idempotency_keys (key,operation,status,response_json,created_at,expires_at)
      VALUES (${idempotencyKey},'heartbeat.config.update','completed',${JSON.stringify(response)},${now},${new Date(Date.now() + 24 * 60 * 60_000).toISOString()})`;
    this.audit("heartbeat.config.updated", actor, "agent.heartbeat", {
      revision, requestedMode: config.mode, effectiveMode: persistedConfig.mode, activationRequested,
    });
    return json(response, { status: activationRequested ? 202 : 200 });
  }

  private decideHeartbeatActivation(
    requestId: string,
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
  ): Response {
    const action = body.action === "approve" || body.action === "reject" ? body.action : null;
    const nonce = typeof body.nonce === "string" ? body.nonce : "";
    const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
    if (!action || !/^[a-f0-9]{32}$/.test(nonce) || ownerId !== binding.ownerId || !chatId || chatId.length > 160) {
      return json({ error: "heartbeat_activation_decision_invalid" }, { status: 422 });
    }
    const row = this.sql<{ status: string; owner_id: string; nonce: string; expires_at: string; config_json: string;
      config_revision: number }>`SELECT status,owner_id,nonce,expires_at,config_json,config_revision
      FROM heartbeat_activation_requests WHERE id=${requestId} AND owner_id=${binding.ownerId}`[0];
    if (!row) return json({ error: "heartbeat_activation_not_found" }, { status: 404 });
    if (row.status !== "pending") return json({ requestId, status: row.status, replayed: true });
    const now = new Date().toISOString();
    if (row.nonce !== nonce || Date.parse(row.expires_at) <= Date.now()) {
      this.sql`UPDATE heartbeat_activation_requests SET status='expired',updated_at=${now}
        WHERE id=${requestId} AND status='pending'`;
      return json({ error: "heartbeat_activation_expired" }, { status: 409 });
    }
    const currentBeforeDecision = this.heartbeatConfigRow();
    if (currentBeforeDecision.revision !== Number(row.config_revision)
      || currentBeforeDecision.config.mode !== "observe") {
      this.sql`UPDATE heartbeat_activation_requests SET status='superseded',updated_at=${now}
        WHERE id=${requestId} AND status='pending'`;
      return json({ error: "heartbeat_activation_stale", revision: currentBeforeDecision.revision }, { status: 409 });
    }
    const reserved = this.sql<{ id: string }>`UPDATE heartbeat_activation_requests
      SET status=${action === "approve" ? "approved" : "rejected"},telegram_chat_id=${chatId},
        decided_at=${now},decided_by=${`telegram:${chatId}`},updated_at=${now}
      WHERE id=${requestId} AND status='pending' AND nonce=${nonce} RETURNING id`;
    if (reserved.length !== 1) return json({ error: "heartbeat_activation_conflict" }, { status: 409 });
    if (action === "reject") {
      this.audit("heartbeat.activation.rejected", `context-service:${binding.serviceId}`, requestId, { chatId });
      return json({ requestId, status: "rejected", mode: "observe" });
    }
    const requested = normalizeHeartbeatConfig(this.parseJson(row.config_json, {}));
    const active: HeartbeatConfig = { ...requested, mode: "active" };
    const current = currentBeforeDecision;
    const revision = current.revision + 1;
    this.sql`UPDATE heartbeat_config SET value_json=${JSON.stringify(active)},revision=${revision},
      actor=${`telegram:${chatId}`},updated_at=${now} WHERE id='owner' AND revision=${current.revision}`;
    const grantId = `hbg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
    this.sql`UPDATE heartbeat_activation_grants SET status='revoked',revoked_at=${now},updated_at=${now}
      WHERE owner_id=${binding.ownerId} AND status='active'`;
    this.sql`INSERT INTO heartbeat_activation_grants
      (id,request_id,owner_id,status,scope_json,budget_json,revision,granted_by,granted_at,expires_at,updated_at)
      VALUES (${grantId},${requestId},${binding.ownerId},'active',${JSON.stringify({ channel: "telegram", chatId })},
        ${JSON.stringify({ dailyLimit: active.dailyLimit, pulseHours: active.pulseHours })},1,${`telegram:${chatId}`},
        ${now},${expiresAt},${now})`;
    const runtime = { ...this.heartbeatRuntime(), mode: "active" as const, activatedAt: now };
    this.saveHeartbeatRuntime(runtime);
    this.audit("heartbeat.activation.approved", `context-service:${binding.serviceId}`, requestId,
      { grantId, chatId, revision, expiresAt });
    return json({ requestId, grantId, status: "approved", mode: "active", revision, expiresAt });
  }

  private createManualHeartbeatIntent(dryRun: boolean): Response {
    const owner = this.heartbeatConfigRow();
    const runtime = this.heartbeatRuntime();
    if (runtime.mode !== "active" || owner.config.mode === "off") return json({ error: "heartbeat_not_active" }, { status: 409 });
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.sql`INSERT INTO heartbeat_intents (id,intent_key,kind,slot_key,due_at,status,dry_run,config_revision,created_at,updated_at)
      VALUES (${id},${`manual:${dryRun ? "dry" : "run"}:${id}`},'companion_pulse','manual',${now},'scheduled',${dryRun ? 1 : 0},${owner.revision},${now},${now})`;
    return json({ ok: true, intentId: id, dryRun });
  }

  private listHeartbeatEvents(): RuntimeRow[] {
    return this.sql<RuntimeRow>`SELECT intent_id,event_type,detail_json,usage_json,duration_ms,created_at
      FROM heartbeat_events ORDER BY created_at DESC LIMIT 100`;
  }

  private listHeartbeatIntents(): RuntimeRow[] {
    return this.sql<RuntimeRow>`SELECT id,intent_key,kind,slot_key,due_at,status,dry_run,config_revision,attempts,
      error_code,created_at,updated_at FROM heartbeat_intents ORDER BY created_at DESC LIMIT 100`;
  }

  async agentHeartbeat(): Promise<void> {
    if (!this.heartbeatEnabled()) return;
    const gatewayProjectionAge = this.sql<{ age_seconds: number | null }>`
      SELECT CAST((julianday('now') - julianday(observed_at)) * 86400 AS INTEGER) AS age_seconds
      FROM mcp_gateway_projection WHERE id='owner'`[0]?.age_seconds;
    if (gatewayProjectionAge == null || gatewayProjectionAge >= 45 * 60) {
      await this.syncMcpGatewayProjection();
    }
    const now = Date.now();
    const expiredCache = this.sql<CountRow>`SELECT COUNT(*) AS count FROM tool_result_cache WHERE expires_at <= ${now}`[0]?.count ?? 0;
    this.sql`DELETE FROM tool_result_cache WHERE expires_at <= ${now}`;
    this.sql`UPDATE browser_runs SET status='failed',error_code='heartbeat_stale_run',finished_at=${new Date().toISOString()}
      WHERE status='running' AND started_at < datetime('now','-90 seconds')`;
    this.sql`DELETE FROM hook_runs WHERE created_at < datetime('now','-30 days')`;
    this.sql`DELETE FROM planner_usage_log WHERE created_at < datetime('now','-30 days')`;
    const browserSweep = await this.sweepInteractiveBrowser();
    const elicitationResumes = await this.reconcileMcpElicitationResumeIntents();
    const staleTasks = this.sql<CountRow>`SELECT COUNT(*) AS count FROM delegated_tasks
      WHERE status NOT IN ('completed','failed','cancelled','approval_required','attention_required') AND updated_at < datetime('now','-15 minutes')`[0]?.count ?? 0;
    const sweepNow = new Date().toISOString();
    const expiredApprovalRows = this.sql<ApprovalTicketRow>`UPDATE approval_ticket_calls
      SET status='expired',consumed_at=${sweepNow}
      WHERE status='pending' AND expires_at < ${sweepNow} RETURNING *`;
    for (const ticket of expiredApprovalRows) {
      try {
        await this.rejectInteractiveBrowserApproval(ticket);
        this.scrubApprovalPayload(ticket.id);
        await this.continueTaskAfterActionOutcome(ticket.task_id, {
          serverId: ticket.server_id,
          toolName: ticket.tool_name,
          argsHash: ticket.args_hash,
        }, "action_expired", "approval_timeout", ticket.id, "agent-schedule");
      } catch (error) {
        this.markTaskAttention(ticket.task_id, boundedAgentErrorCode(error, "approval_timeout_resume_failed"));
      }
    }
    const expiredDomainChallenges = this.sql<{ id: string; task_id: string; args_hash: string }>`UPDATE browser_domain_challenges
      SET status='expired',updated_at=${sweepNow},decided_at=${sweepNow}
      WHERE status='pending' AND expires_at < ${sweepNow} RETURNING id,task_id,args_hash`;
    for (const challenge of expiredDomainChallenges) {
      const checkpoint = this.readTaskCheckpoint(challenge.task_id);
      if (checkpoint.status === "approval_required" && checkpoint.pendingCall) {
        try {
          await this.continueTaskAfterActionOutcome(challenge.task_id, {
            serverId: checkpoint.pendingCall.serverId,
            toolName: checkpoint.pendingCall.toolName,
            argsHash: challenge.args_hash,
          }, "action_expired", "browser_domain_challenge_expired", challenge.id, "agent-schedule");
        } catch (error) {
          this.markTaskAttention(challenge.task_id, boundedAgentErrorCode(error, "browser_domain_expiry_resume_failed"));
        }
      }
    }
    const expiredDomainGrants = this.sql<CountRow>`SELECT COUNT(*) AS count FROM browser_domain_grants
      WHERE status='active' AND expires_at < datetime('now')`[0]?.count ?? 0;
    this.sql`UPDATE browser_domain_grants SET status='expired',updated_at=${new Date().toISOString()}
      WHERE status='active' AND expires_at < datetime('now')`;
    const expiredTaskGrants = this.sql<CountRow>`SELECT COUNT(*) AS count FROM approval_task_grants
      WHERE status='active' AND expires_at < ${sweepNow}`[0]?.count ?? 0;
    this.sql`UPDATE approval_task_grants SET status='expired',updated_at=${sweepNow}
      WHERE status='active' AND expires_at < ${sweepNow}`;
    const unhealthyProviders = this.sql<CountRow>`SELECT COUNT(*) AS count FROM mcp_registry
      WHERE enabled=1 AND health_status NOT IN ('healthy','unknown')`[0]?.count ?? 0;
    const summary = { staleTasks, expiredApprovals: expiredApprovalRows.length, expiredDomainChallenges: expiredDomainChallenges.length,
      expiredDomainGrants, expiredTaskGrants, elicitationResumes,
      unhealthyProviders, expiredCacheDeleted: expiredCache, browserMsToday: this.browserUsageTodayMs(), browserSweep, plannerCallsToday: this.plannerUsageToday().calls };
    this.audit("heartbeat.completed", "agent-schedule", this.name, summary);
    const binding = this.contextServiceBinding();
    if (binding) await this.dispatchHooks("on_heartbeat", binding, summary, false);
  }

  private latestHeartbeatSummary(): unknown {
    const row = this.sql<{ detail_json: string; created_at: string }>`SELECT detail_json,created_at FROM audit_log
      WHERE event_type='heartbeat.completed' ORDER BY created_at DESC LIMIT 1`[0];
    return row ? { ...this.parseJson<Record<string, unknown>>(row.detail_json, {}), createdAt: row.created_at } : null;
  }

  private async sweepInteractiveBrowser(): Promise<{ checked: number; expired: number; sessionsSwept: number }> {
    if (!this.browserInteractiveEnabled()) return { checked: 0, expired: 0, sessionsSwept: 0 };
    const rows = this.sql<BrowserExecutionRow>`SELECT execution_id,task_id,runtime_name,mode,session_key,domains_json,recording,status,
      pending_json,result_json,created_at,updated_at FROM browser_executions
      WHERE status IN ('paused','running') ORDER BY updated_at ASC LIMIT 25`;
    let expired = 0;
    let sessionsSwept = 0;
    for (const row of rows) {
      try {
        const browserRuntime = this.browserRuntimeForRow(row);
        const ids = await browserRuntime.runtime.expirePaused({ maxAgeMs: 20 * 60_000 });
        if (ids.includes(row.execution_id)) {
          expired += 1;
          this.sql`UPDATE browser_executions SET status='expired',pending_json=NULL,updated_at=${new Date().toISOString()}
            WHERE execution_id=${row.execution_id} AND status IN ('paused','running')`;
          this.recordBrowserEvent(row.execution_id, row.task_id, "execution.expired", {});
        }
        const swept = await browserRuntime.connector.sweep({ maxIdleMs: 60 * 60_000, maxExecIdleMs: 24 * 60 * 60_000 });
        sessionsSwept += swept.swept.length;
        await browserRuntime.runtime.pruneExecutions(50);
      } catch (error) {
        this.audit("browser.sweep.failed", "agent-schedule", row.execution_id, {
          error: error instanceof Error ? error.message : "browser_sweep_failed",
        });
      }
    }
    this.sql`DELETE FROM browser_task_events WHERE created_at < datetime('now','-30 days')`;
    this.sql`DELETE FROM browser_sessions WHERE state IN ('closed','expired') AND last_used_at < datetime('now','-7 days')`;
    this.sql`UPDATE browser_sessions SET state='expired',last_used_at=${new Date().toISOString()}
      WHERE state='active' AND expires_at < datetime('now')`;
    return { checked: rows.length, expired, sessionsSwept };
  }

  private updateCapability(id: string, body: Record<string, unknown>, actor = "management-api", request?: Request): Response {
    const definition = CAPABILITY_REGISTRY.find((item) => item.id === id);
    if (!definition) return json({ error: "unknown_capability" }, { status: 404 });
    if (!definition.configurable) return json({ error: "capability_is_fixed" }, { status: 409 });
    if (body.status !== "enabled" && body.status !== "disabled") return json({ error: "invalid_status" }, { status: 400 });
    const currentRevision = Number(this.state.capabilityRevisions?.[id] ?? 0);
    let idempotencyKey: string | null = null;
    let operation: string | null = null;
    if (request) {
      if (!TELEGRAM_DENY_ONLY_CAPABILITIES.has(id)) return json({ error: "capability_not_delegated" }, { status: 403 });
      if (body.status !== "disabled") return json({ error: "capability_can_only_narrow" }, { status: 409 });
      const match = request.headers.get("if-match")?.replace(/^W\//, "").replaceAll('"', "").trim() ?? "";
      const rawKey = request.headers.get("idempotency-key")?.trim() ?? "";
      if (!match) return json({ error: "if_match_required" }, { status: 428 });
      if (!/^[A-Za-z0-9:_-]{16,200}$/.test(rawKey)) return json({ error: "idempotency_key_required" }, { status: 428 });
      const expectedRevision = Number(match);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return json({ error: "invalid_revision" }, { status: 422 });
      idempotencyKey = `capability:${rawKey}`;
      operation = `capability.update:${id}:${body.status}:${expectedRevision}`;
      const existing = this.sql<{ operation: string; response_json: string | null }>`SELECT operation,response_json FROM idempotency_keys WHERE key=${idempotencyKey}`[0];
      if (existing) {
        if (existing.operation !== operation) return json({ error: "idempotency_key_reused" }, { status: 409 });
        if (existing.response_json) return json(this.parseJson(existing.response_json, {}));
        return json({ error: "operation_in_progress" }, { status: 409 });
      }
      if (expectedRevision !== currentRevision) {
        return json({ error: "revision_conflict", revision: currentRevision }, { status: 409 });
      }
    }
    const now = new Date().toISOString();
    const revision = currentRevision + 1;
    this.setState({
      ...this.state,
      capabilities: { ...this.state.capabilities, [id]: body.status },
      capabilityRevisions: { ...this.state.capabilityRevisions, [id]: revision },
      updatedAt: now,
    });
    const response = {
      ok: true,
      capability: capabilitySnapshot(this.state.capabilities, this.state.capabilityRevisions).find((item) => item.id === id),
    };
    if (idempotencyKey && operation) {
      this.sql`INSERT INTO idempotency_keys (key,operation,status,response_json,created_at,expires_at)
        VALUES (${idempotencyKey},${operation},'completed',${JSON.stringify(response)},${now},${new Date(Date.now() + 24 * 60 * 60_000).toISOString()})`;
    }
    this.audit("capability.updated", actor, id, { status: body.status, revision });
    return json(response);
  }

  private listMcpServers(): RuntimeRow[] {
    return this.sql<RuntimeRow>`SELECT id, name, url, enabled, risk_level, tool_allowlist_json, tool_catalog_json,
      observed_catalog_refreshed_at, auth_reference, health_status, last_checked_at, created_at, updated_at
      FROM mcp_registry ORDER BY name`;
  }

  private currentMcpGatewayOwnerSnapshot(): ReturnType<typeof parseMcpGatewayOwnerSnapshot> | null {
    const row = this.sql<{ snapshot_json: string; status: string; observed_at: string }>`
      SELECT snapshot_json,status,observed_at FROM mcp_gateway_projection WHERE id='owner'`[0];
    if (!row || row.status !== "current" || Date.now() - Date.parse(row.observed_at) >= 60 * 60_000) return null;
    try {
      return parseMcpGatewayOwnerSnapshot(this.parseJson(row.snapshot_json, null));
    } catch {
      return null;
    }
  }

  private mcpGatewayProjection(): Record<string, unknown> | null {
    const row = this.sql<{ owner_revision: number; owner_version: string; etag: string | null; snapshot_json: string;
      snapshot_hash: string; status: string; observed_at: string; error_code: string | null; updated_at: string }>`
      SELECT owner_revision,owner_version,etag,snapshot_json,snapshot_hash,status,observed_at,error_code,updated_at
      FROM mcp_gateway_projection WHERE id='owner'`[0];
    if (!row) return null;
    const snapshot = this.parseJson<{ cutoverState?: string } | null>(row.snapshot_json, null);
    const executableProviders = this.sql<CountRow>`SELECT COUNT(*) AS count FROM mcp_gateway_execution_projection
      WHERE status='connected' AND julianday(observed_at) >= julianday('now','-1 hour')`[0]?.count ?? 0;
    return {
      owner: "mcp.example.com",
      ownerRevision: row.owner_revision,
      ownerVersion: row.owner_version,
      etag: row.etag,
      snapshotHash: row.snapshot_hash,
      status: row.status,
      observedAt: row.observed_at,
      errorCode: row.error_code,
      updatedAt: row.updated_at,
      snapshot,
      executable: row.status === "current" && snapshot?.cutoverState === "executor_ready" && executableProviders > 0,
      executableProviders,
    };
  }

  private async syncMcpGatewayProjection(): Promise<void> {
    const bearer = this.env.MCP_GATEWAY_OWNER_BEARER?.trim();
    if (!bearer || !this.env.MCP_GATEWAY) {
      this.markMcpGatewayProjectionStale("mcp_gateway_projection_auth_misconfigured");
      return;
    }
    try {
      const current = this.sql<{ etag: string | null; snapshot_json: string }>`SELECT etag,snapshot_json FROM mcp_gateway_projection WHERE id='owner'`[0];
      const headers = new Headers({ authorization: `Bearer ${bearer}`, accept: "application/json" });
      if (current?.etag) headers.set("if-none-match", current.etag);
      const response = await this.env.MCP_GATEWAY.fetch("https://mcp-gateway.internal/service/owner/mcp-registry", { headers });
      const observedAt = new Date().toISOString();
      if (response.status === 304 && current) {
        this.sql`UPDATE mcp_gateway_projection SET status='current',error_code=NULL,observed_at=${observedAt},updated_at=${observedAt}
          WHERE id='owner'`;
        const snapshot = parseMcpGatewayOwnerSnapshot(this.parseJson(current.snapshot_json, null));
        await this.syncMcpGatewayExecutionProjection(snapshot);
        return;
      }
      if (!response.ok) throw new Error(`mcp_gateway_projection_http_${response.status}`);
      const snapshot = parseMcpGatewayOwnerSnapshot(await response.json());
      const snapshotHash = await hashMcpGatewayOwnerSnapshot(snapshot);
      const etag = response.headers.get("etag");
      this.sql`INSERT INTO mcp_gateway_projection
        (id,owner_revision,owner_version,etag,snapshot_json,snapshot_hash,status,observed_at,error_code,updated_at)
        VALUES ('owner',${snapshot.revision},${snapshot.ownerVersion},${etag},${JSON.stringify(snapshot)},${snapshotHash},'current',${observedAt},NULL,${observedAt})
        ON CONFLICT(id) DO UPDATE SET owner_revision=excluded.owner_revision,owner_version=excluded.owner_version,
          etag=excluded.etag,snapshot_json=excluded.snapshot_json,snapshot_hash=excluded.snapshot_hash,status='current',
          observed_at=excluded.observed_at,error_code=NULL,updated_at=excluded.updated_at`;
      this.audit("mcp.gateway.projection.synced", "service:mcp-gateway", "mcp.example.com", {
        ownerRevision: snapshot.revision,
        providerCount: snapshot.providers.length,
        executable: snapshot.cutoverState === "executor_ready",
      });
      await this.syncMcpGatewayExecutionProjection(snapshot);
    } catch (error) {
      const code = error instanceof Error ? error.message : "mcp_gateway_projection_failed";
      console.warn("MCP Gateway projection unavailable", code);
      this.markMcpGatewayProjectionStale(code);
    }
  }

  private async mcpGatewayControlSnapshot(
    consumerId: "agent" | "telegram",
    options: { refresh?: boolean; report?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    if (options.refresh !== false) await this.syncMcpGatewayProjection();
    const projection = this.mcpGatewayProjection();
    const snapshot = this.currentMcpGatewayOwnerSnapshot();
    const executable = new Map<string, Set<string>>();
    const providerHealth = new Map<string, { status: string; observedAt: string; errorCode: string | null; protocolVersion: string | null }>();
    for (const row of this.sql<{ provider_id: string; catalog_json: string; status: string; observed_at: string; error_code: string | null; protocol_version: string | null }>`
      SELECT provider_id,catalog_json,status,observed_at,error_code,protocol_version FROM mcp_gateway_execution_projection`) {
      const expired = Date.now() - Date.parse(row.observed_at) >= MCP_GATEWAY_PROBE_TTL_SECONDS * 1_000;
      const status = expired && (row.status === "connected" || row.status === "degraded") ? "stale" : row.status;
      providerHealth.set(row.provider_id, { status, observedAt: row.observed_at, errorCode: row.error_code, protocolVersion: row.protocol_version });
      if (row.status !== "connected" || Date.now() - Date.parse(row.observed_at) >= MCP_GATEWAY_PROBE_TTL_SECONDS * 1_000) continue;
      executable.set(row.provider_id, new Set(parseToolCatalog(this.parseJson(row.catalog_json, [])).map((tool) => tool.toolName)));
    }
    const providers = (snapshot?.providers ?? []).map((provider) => {
      const health = providerHealth.get(provider.id);
      const status = provider.status === "disabled" ? "disabled" : health?.status ?? "registered";
      return {
        id: provider.id,
        label: provider.label,
        status,
        registrationStatus: provider.status,
        kind: provider.kind,
        sourceType: provider.sourceType,
        risk: provider.risk,
        ownerRevision: provider.ownerRevision,
        observedAt: health?.observedAt ?? null,
        errorCode: health?.errorCode ?? null,
        protocolVersion: health?.protocolVersion ?? null,
        tools: provider.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          enabled: tool.enabled,
          defaultEnabled: tool.defaultEnabled,
          ownerRevision: tool.ownerRevision,
          risk: tool.risk ?? provider.risk,
          requiresConfirmation: tool.requiresConfirmation ?? false,
          agentCallable: executable.get(provider.id)?.has(tool.name) ?? false,
        })),
      };
    });
    const status = snapshot && projection?.status === "current" ? "current" : projection?.status === "stale" ? "stale" : "unavailable";
    if (snapshot && options.report !== false) await this.reportMcpConsumerStatus(consumerId, snapshot.revision, status, {
      transport: consumerId === "telegram" ? "telegram-service-binding" : "agent-service-binding",
      executableProviders: Number(projection?.executableProviders ?? 0),
    });
    return {
      owner: "mcp.example.com",
      ownerVersion: snapshot?.ownerVersion ?? projection?.ownerVersion ?? null,
      revision: snapshot?.revision ?? projection?.ownerRevision ?? null,
      etag: projection?.etag ?? null,
      status,
      observedAt: projection?.observedAt ?? null,
      executable: projection?.executable === true,
      providers,
      canonicalUrl: "https://mcp.example.com/admin",
      consumerId,
    };
  }

  private async reportMcpConsumerStatus(
    consumerId: string,
    observedOwnerRevision: number,
    status: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const bearer = this.env.MCP_GATEWAY_OWNER_BEARER?.trim();
    if (!bearer || !this.env.MCP_GATEWAY) return;
    try {
      await this.env.MCP_GATEWAY.fetch(
        `https://mcp-gateway.internal/service/owner/mcp-registry/consumers/${encodeURIComponent(consumerId)}`,
        {
          method: "PUT",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({ observedOwnerRevision, status, detail: JSON.stringify(detail).slice(0, 280) }),
        },
      );
    } catch {
      // Consumer telemetry must never block catalog reads or tool execution.
    }
  }

  private async updateMcpGatewayTool(
    request: Request,
    body: Record<string, unknown>,
    actorDomain: "agent.example.com" | "tgbot.example.com",
    consumerId: "agent" | "telegram",
  ): Promise<Response> {
    const provider = typeof body.provider === "string" ? body.provider : "";
    const tool = typeof body.tool === "string" ? body.tool : "";
    if (!provider || !tool || typeof body.enabled !== "boolean") return json({ error: "mcp_tool_mutation_invalid" }, { status: 422 });
    const bearer = this.env.MCP_GATEWAY_OWNER_BEARER?.trim();
    if (!bearer || !this.env.MCP_GATEWAY) return json({ error: "mcp_gateway_owner_unavailable" }, { status: 503 });
    await this.syncMcpGatewayProjection();
    const projection = this.mcpGatewayProjection();
    const ifMatch = request.headers.get("if-match")?.trim();
    if (!ifMatch || !projection?.etag || ifMatch !== projection.etag) {
      return json({ error: "mcp_owner_revision_conflict", currentEtag: projection?.etag ?? null }, { status: 412 });
    }
    const response = await this.env.MCP_GATEWAY.fetch("https://mcp-gateway.internal/service/owner/mcp-registry/tools", {
      method: "PATCH",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "if-match": ifMatch },
      body: JSON.stringify({ provider, tool, enabled: body.enabled, actorDomain, consumerId }),
    });
    const payload = await response.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) return json({ error: payload.error ?? "mcp_gateway_mutation_failed", message: payload.message }, { status: response.status });
    await this.syncMcpGatewayProjection();
    this.audit("mcp.gateway.tool.updated", `control:${actorDomain}`, `${provider}/${tool}`, { enabled: body.enabled });
    return json(await this.mcpGatewayControlSnapshot(consumerId));
  }

  private markMcpGatewayProjectionStale(code: string): void {
    const now = new Date().toISOString();
    this.sql`UPDATE mcp_gateway_projection SET status='stale',error_code=${code.slice(0, 160)},updated_at=${now}
      WHERE id='owner'`;
    this.sql`UPDATE mcp_gateway_execution_projection SET status='stale',error_code=${code.slice(0, 160)},updated_at=${now}
      WHERE status != 'disabled'`;
  }

  private async syncMcpGatewayExecutionProjection(snapshot: ReturnType<typeof parseMcpGatewayOwnerSnapshot>): Promise<void> {
    const bearer = this.env.MCP_GATEWAY_EXECUTOR_BEARER?.trim();
    if (snapshot.cutoverState !== "executor_ready" || !snapshot.executionTransport || !bearer) {
      this.sql`UPDATE mcp_gateway_execution_projection SET status='stale',error_code='mcp_gateway_executor_not_ready',updated_at=${new Date().toISOString()}
        WHERE status != 'disabled'`;
      return;
    }
    const active = new Set<string>();
    for (const provider of snapshot.providers) {
      active.add(provider.id);
      if (provider.status === "disabled" || provider.status === "pending") {
        const status = provider.status === "disabled" ? "disabled" : "registered";
        const now = new Date().toISOString();
        this.sql`INSERT INTO mcp_gateway_execution_projection
          (provider_id,owner_revision,owner_version,catalog_json,status,observed_at,error_code,updated_at)
          VALUES (${provider.id},${provider.ownerRevision},${snapshot.ownerVersion},'[]',${status},${now},NULL,${now})
          ON CONFLICT(provider_id) DO UPDATE SET owner_revision=excluded.owner_revision,owner_version=excluded.owner_version,
            status=excluded.status,error_code=NULL,updated_at=excluded.updated_at`;
        continue;
      }
      try {
        let observed;
        let status: "registered" | "connected";
        let protocolVersion: string | null = null;
        if (provider.kind === "custom") {
          const signal = AbortSignal.timeout(60_000);
          if (provider.readOnlyHealthProbe) {
            const probe = await probeStandardMcpProvider({
              gateway: this.env.MCP_GATEWAY,
              executorBearer: bearer,
              providerId: provider.id,
              signal,
              probe: provider.readOnlyHealthProbe,
            });
            observed = parseMcpToolsListResponse({ result: { tools: probe.tools } });
            protocolVersion = probe.protocolVersion;
            status = "connected";
          } else {
            const listed = await listStandardMcpTools({
              gateway: this.env.MCP_GATEWAY,
              executorBearer: bearer,
              providerId: provider.id,
              signal,
            });
            observed = parseMcpToolsListResponse({ result: { tools: listed.tools } });
            protocolVersion = listed.protocolVersion;
            status = "registered";
          }
        } else {
          observed = parseMcpToolsListResponse(await this.invokeMcpGatewayRpc(provider.id, "tools/list", {}, `catalog:${snapshot.revision}:${provider.id}`));
          status = "connected";
        }
        const ownerTools = new Map(provider.tools.filter((tool) => tool.enabled).map((tool) => [tool.name, tool]));
        const catalog = await Promise.all(observed.flatMap((tool) => {
          const ownerTool = ownerTools.get(tool.name);
          if (!ownerTool) return [];
          const knownDataRead = provider.kind === "built-in"
            && MCP_GATEWAY_DATA_READ_TOOL_KEYS.has(`${provider.id}/${tool.name}`);
          const ownerDeclaredRead = provider.kind === "built-in"
            && ownerTool.risk === "low"
            && ownerTool.billingClass === "none"
            && ownerTool.mayCost === false
            && !ownerTool.requiresConfirmation;
          const riskLevel: RiskLevel = knownDataRead || ownerDeclaredRead ? "read"
            : ownerTool.requiresConfirmation || ownerTool.risk === "medium" || ownerTool.risk === "high"
              || provider.risk === "medium" || provider.risk === "high" ? "write" : "read";
          return [createToolCatalogEntry({
            serverId: provider.id,
            toolName: tool.name,
            description: ownerTool.description || tool.description,
            riskLevel,
            inputSchema: tool.inputSchema as ToolSchema,
            outputByteLimit: 64 * 1024,
            enabled: true,
          })];
        }));
        const now = new Date().toISOString();
        this.sql`INSERT INTO mcp_gateway_execution_projection
          (provider_id,owner_revision,owner_version,catalog_json,status,observed_at,error_code,updated_at)
          VALUES (${provider.id},${provider.ownerRevision},${snapshot.ownerVersion},${JSON.stringify(catalog)},${status},${now},NULL,${now})
          ON CONFLICT(provider_id) DO UPDATE SET owner_revision=excluded.owner_revision,owner_version=excluded.owner_version,
            catalog_json=excluded.catalog_json,status=excluded.status,observed_at=excluded.observed_at,error_code=NULL,updated_at=excluded.updated_at`;
        this.sql`UPDATE mcp_gateway_execution_projection SET protocol_version=${protocolVersion}
          WHERE provider_id=${provider.id}`;
      } catch (error) {
        const now = new Date().toISOString();
        const code = (error instanceof Error ? error.message : "mcp_gateway_catalog_failed").slice(0, 160);
        const previous = this.sql<{ catalog_json: string; observed_at: string; status: string }>`SELECT catalog_json,observed_at,status
          FROM mcp_gateway_execution_projection WHERE provider_id=${provider.id}`[0];
        if (!previous || previous.status === "registered" || parseToolCatalog(this.parseJson(previous.catalog_json, [])).length === 0) {
          this.sql`INSERT INTO mcp_gateway_execution_projection
            (provider_id,owner_revision,owner_version,catalog_json,status,observed_at,error_code,updated_at)
            VALUES (${provider.id},${provider.ownerRevision},${snapshot.ownerVersion},'[]','registered',${now},${code},${now})
            ON CONFLICT(provider_id) DO UPDATE SET owner_revision=excluded.owner_revision,owner_version=excluded.owner_version,
              status='registered',error_code=excluded.error_code,updated_at=excluded.updated_at`;
        } else {
          const ageSeconds = Math.max(0, (Date.now() - Date.parse(previous.observed_at)) / 1_000);
          const failedStatus = ageSeconds >= MCP_GATEWAY_PROBE_TTL_SECONDS ? "stale" : "degraded";
          this.sql`UPDATE mcp_gateway_execution_projection SET status=${failedStatus},error_code=${code},updated_at=${now}
            WHERE provider_id=${provider.id}`;
        }
      }
    }
    for (const row of this.sql<{ provider_id: string }>`SELECT provider_id FROM mcp_gateway_execution_projection`) {
      if (!active.has(row.provider_id)) this.sql`DELETE FROM mcp_gateway_execution_projection WHERE provider_id=${row.provider_id}`;
    }
  }

  private async invokeMcpGatewayRpc(
    providerId: string,
    method: "tools/list" | "tools/call",
    params: Record<string, unknown>,
    id: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const bearer = this.env.MCP_GATEWAY_EXECUTOR_BEARER?.trim();
    if (!bearer) throw new Error("mcp_gateway_executor_auth_misconfigured");
    const response = await this.env.MCP_GATEWAY.fetch(
      `https://mcp-gateway.internal/service/executor/${encodeURIComponent(providerId)}/mcp`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) throw new Error(`mcp_gateway_executor_http_${response.status}`);
    return await response.json();
  }

  private async registerMcp(body: Record<string, unknown>): Promise<Response> {
    const input = body as McpRegistryInput;
    if (typeof input.id !== "string" || !AGENT_OWNED_MCP_SERVER_IDS.has(input.id)) {
      return json({ error: "mcp_registry_owned_by_gateway", owner: "mcp.example.com" }, { status: 409 });
    }
    if (typeof input.name !== "string" || typeof input.url !== "string") return json({ error: "name_and_url_required" }, { status: 400 });
    const parsedUrl = new URL(input.url);
    if (parsedUrl.protocol !== "https:") return json({ error: "mcp_url_must_use_https" }, { status: 400 });
    const id = input.id;
    const risk = input.riskLevel ?? "read";
    if (!RISK_LEVELS.has(risk)) return json({ error: "unknown_risk_level" }, { status: 400 });
    const allowlist = normalizeToolAllowlist(input.toolAllowlist);
    if (!Array.isArray(input.tools) || input.tools.length === 0) {
      return json({ error: "tool_catalog_refresh_required" }, { status: 409 });
    }
    const toolCatalog = await this.buildToolCatalog(id, input.tools);
    const now = new Date().toISOString();
    this.sql`INSERT INTO mcp_registry (id, name, url, enabled, risk_level, tool_allowlist_json, tool_catalog_json, auth_reference, created_at, updated_at)
      VALUES (${id}, ${input.name}, ${parsedUrl.toString()}, ${input.enabled ? 1 : 0}, ${risk}, ${JSON.stringify(allowlist)}, ${JSON.stringify(toolCatalog)}, ${input.authReference ?? null}, ${now}, ${now})
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, enabled = excluded.enabled,
      risk_level = excluded.risk_level, tool_allowlist_json = excluded.tool_allowlist_json,
      tool_catalog_json = excluded.tool_catalog_json, observed_tool_catalog_json = '[]', observed_catalog_refreshed_at = NULL,
      auth_reference = excluded.auth_reference, updated_at = excluded.updated_at`;
    this.audit("mcp.registered", "management-api", id, {
      name: input.name,
      enabled: Boolean(input.enabled),
      riskLevel: risk,
      allowlistSize: allowlist.length,
      toolCount: toolCatalog.length,
    });
    return json({ server: this.sql<RuntimeRow>`SELECT * FROM mcp_registry WHERE id = ${id}`[0] }, { status: 201 });
  }

  private async refreshMcpCatalog(id: string, body: Record<string, unknown>): Promise<Response> {
    if (!AGENT_OWNED_MCP_SERVER_IDS.has(id)) {
      return json({ error: "mcp_registry_owned_by_gateway", owner: "mcp.example.com" }, { status: 409 });
    }
    const row = this.sql<{ id: string }>`SELECT id FROM mcp_registry WHERE id = ${id}`[0];
    if (!row) return json({ error: "mcp_not_found" }, { status: 404 });
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return json({ error: "complete_tool_catalog_required" }, { status: 400 });
    }
    const catalog = await this.buildToolCatalog(id, body.tools as ToolCatalogEntryInput[]);
    const now = new Date().toISOString();
    this.sql`UPDATE mcp_registry SET tool_catalog_json = ${JSON.stringify(catalog)}, observed_tool_catalog_json = '[]',
      observed_catalog_refreshed_at = NULL, updated_at = ${now} WHERE id = ${id}`;
    this.audit("mcp.catalog.refreshed", "management-api", id, { catalogVersion: 2, toolCount: catalog.length });
    return json({ id, catalogVersion: 2, toolCount: catalog.length });
  }

  private async refreshObservedCatalog(
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
  ): Promise<Response> {
    const serverId = requestedCatalogServerId(body, CURRENT_MEMORY_MCP_SERVER_ID);
    if (!AGENT_OWNED_MCP_SERVER_IDS.has(serverId)) {
      return json({ error: "mcp_registry_owned_by_gateway", owner: "mcp.example.com" }, { status: 409 });
    }
    if (FORBIDDEN_DELEGATED_SERVER_IDS.has(serverId) && serverId !== CURRENT_MEMORY_MCP_SERVER_ID) {
      return json({ error: "unsupported_catalog_server" }, { status: 409 });
    }
    const row = this.sql<{ id: string; enabled: number; tool_catalog_json: string }>`
      SELECT id, enabled, tool_catalog_json FROM mcp_registry WHERE id = ${serverId}`[0];
    if (!row || Number(row.enabled) !== 1) return json({ error: "mcp_not_available" }, { status: 404 });
    const intendedRaw = this.parseJson<unknown>(row.tool_catalog_json, null);
    if (toolCatalogNeedsRefresh(intendedRaw)) return json({ error: "tool_catalog_refresh_required" }, { status: 409 });
    const intendedCatalog = parseToolCatalog(intendedRaw);
    const actualTools = await this.fetchProviderToolsList(serverId);
    const observedCatalog: ToolCatalogEntry[] = [];
    for (const observedInput of deriveObservedCatalogInputs(serverId, intendedCatalog, actualTools)) {
      observedCatalog.push(await createToolCatalogEntry(observedInput));
    }
    const now = new Date().toISOString();
    this.sql`UPDATE mcp_registry SET observed_tool_catalog_json = ${JSON.stringify(observedCatalog)},
      observed_catalog_refreshed_at = ${now}, updated_at = ${now} WHERE id = ${serverId}`;
    this.audit("mcp.catalog.observed", `context-service:${binding.serviceId}`, serverId, {
      catalogVersion: 2,
      toolCount: observedCatalog.length,
    });
    return json({ serverId, catalogVersion: 2, toolCount: observedCatalog.length, observedAt: now });
  }

  private async fetchMemoryMcpToolsList() {
    return this.fetchProviderToolsList(CURRENT_MEMORY_MCP_SERVER_ID);
  }

  private async fetchProviderToolsList(serverId: string) {
    if (serverId !== CURRENT_MEMORY_MCP_SERVER_ID && serverId !== OBSERVER_MCP_SERVER_ID) {
      const remote = this.remoteMcpRegistry(serverId);
      const payload = await createRemoteMcpClient({ endpoint: remote.url, bearerToken: this.remoteMcpBearer(remote.auth_reference) }).listTools();
      return parseMcpToolsListResponse(payload);
    }
    const bearer = this.env.AGENT_MEMORY_MCP_BEARER?.trim();
    if (!bearer) throw new Error("memory_mcp_auth_misconfigured");
    const path = serverId === OBSERVER_MCP_SERVER_ID ? "/agent-observer/mcp" : "/mcp";
    const response = await this.env.MEMORY_MCP.fetch(`https://<MEMORY_SERVICE>.internal${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        "x-operia-mcp-server-id": CURRENT_MEMORY_MCP_SERVER_ID,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `catalog-refresh:${serverId}`,
        method: "tools/list",
        params: { _meta: { serverId } },
      }),
    });
    if (!response.ok) throw new Error(`provider_catalog_http_${response.status}`);
    return parseMcpToolsListResponse(await response.json());
  }

  private deleteMcp(id: string): Response {
    if (!AGENT_OWNED_MCP_SERVER_IDS.has(id)) {
      return json({ error: "mcp_registry_owned_by_gateway", owner: "mcp.example.com" }, { status: 409 });
    }
    this.sql`DELETE FROM mcp_registry WHERE id = ${id}`;
    this.audit("mcp.deleted", "management-api", id, {});
    return json({ ok: true });
  }

  private createApproval(body: Record<string, unknown>): Response {
    const action = typeof body.action === "string" ? body.action : "unknown";
    const risk = typeof body.riskLevel === "string" && RISK_LEVELS.has(body.riskLevel as RiskLevel) ? body.riskLevel : "write";
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sql`INSERT INTO approvals (id, action, risk_level, status, request_json, created_at)
      VALUES (${id}, ${action}, ${risk}, 'pending', ${JSON.stringify(body.request ?? {})}, ${now})`;
    this.audit("approval.created", "management-api", id, { action, riskLevel: risk });
    return json({ id, status: "pending" }, { status: 201 });
  }

  private decideApproval(id: string, body: Record<string, unknown>): Response {
    if (body.decision !== "approved" && body.decision !== "rejected") return json({ error: "invalid_decision" }, { status: 400 });
    const now = new Date().toISOString();
    const updated = this.sql<{ status: string }>`UPDATE approvals SET status = ${body.decision}, decision_json = ${JSON.stringify(body)}, decided_at = ${now}
      WHERE id = ${id} AND status = 'pending' RETURNING status`[0];
    const existing = updated ? undefined : this.sql<{ status: string }>`SELECT status FROM approvals WHERE id = ${id}`[0];
    const resolved = resolveApprovalDecision(body.decision, updated?.status, existing?.status);
    switch (resolved.kind) {
      case "first": {
        this.audit("approval.decided", "management-api", id, { decision: resolved.status });
        return json({ id, status: resolved.status });
      }
      case "missing":
        return json({ error: "approval_not_found", id }, { status: 404 });
      case "replay":
        return json({ id, status: resolved.status, replayed: true });
      case "conflict":
        return json({ error: "approval_already_decided", id, status: resolved.status }, { status: 409 });
    }
  }

  private createJob(body: Record<string, unknown>, idempotencyKey: string | null): Response {
    const operation = typeof body.kind === "string" ? body.kind : "internal";
    if (idempotencyKey) {
      const prior = this.sql<{ response_json: string | null }>`SELECT response_json FROM idempotency_keys WHERE key = ${idempotencyKey}`[0];
      if (prior?.response_json) return json(JSON.parse(prior.response_json), { status: 200 });
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const response = { id, kind: operation, status: "pending" };
    this.sql`INSERT INTO jobs (id, kind, status, payload_json, created_at, updated_at)
      VALUES (${id}, ${operation}, 'pending', ${JSON.stringify(body.payload ?? {})}, ${now}, ${now})`;
    if (idempotencyKey) this.sql`INSERT INTO idempotency_keys (key, operation, status, response_json, created_at)
      VALUES (${idempotencyKey}, ${operation}, 'accepted', ${JSON.stringify(response)}, ${now})`;
    this.audit("job.created", "management-api", id, { kind: operation });
    return json(response, { status: 202 });
  }

  private cancelJob(id: string): Response {
    const row = this.sql<{ status: string }>`SELECT status FROM jobs WHERE id = ${id}`[0];
    if (!row) return json({ error: "job_not_found" }, { status: 404 });
    if (TERMINAL_JOB_STATES.has(row.status)) return json({ error: "job_already_terminal", status: row.status }, { status: 409 });
    const now = new Date().toISOString();
    this.sql`UPDATE jobs SET status = 'cancelled', cancellation_requested = 1, updated_at = ${now} WHERE id = ${id}`;
    this.audit("job.cancelled", "management-api", id, {});
    return json({ id, status: "cancelled" });
  }

  private listAudit(): RuntimeRow[] {
    return this.sql<RuntimeRow>`SELECT id, event_type, actor, target, detail_json, created_at FROM audit_log ORDER BY created_at DESC LIMIT 200`;
  }

  private voiceAuditEvents(): RuntimeRow[] {
    return this.sql<RuntimeRow>`SELECT id, event_type, actor, target, detail_json, created_at FROM audit_log
      WHERE event_type LIKE 'voice.%' ORDER BY created_at DESC LIMIT 50`;
  }

  private listToolSideEffects(): RuntimeRow[] {
    return this.sql<RuntimeRow>`SELECT call_key, task_id, status, logical_invocation_count,
      provider_attempt_count, last_attempt_at, created_at, updated_at
      FROM tool_side_effects
      WHERE status='uncertain'
         OR (status='quarantined' AND (provider_call_completed=0 OR response_json IS NULL))
      ORDER BY updated_at DESC LIMIT 200`;
  }

  private async resolveToolSideEffect(callKey: string, body: Record<string, unknown>): Promise<Response> {
    const meta = this.sql<{ task_id: string; task_status: string }>`SELECT s.task_id, t.status AS task_status FROM tool_side_effects s
      JOIN delegated_tasks t ON t.id = s.task_id WHERE s.call_key = ${callKey}`[0];
    if (!meta) return json({ error: "side_effect_not_found" }, { status: 404 });
    let taskStatus = meta.task_status;
    let state = loadReplayState(this.sql as unknown as SideEffectSql, callKey);
    if (!state) return json({ error: "side_effect_not_found" }, { status: 404 });
    // Receipt-backed quarantine is replay-only and must not be normalized to uncertain.
    if (
      state.status === "quarantined" &&
      state.providerCallCompleted &&
      state.dispatchState === "terminal_observed" &&
      state.responseJson
    ) {
      return json({ error: "side_effect_not_reconcilable", status: state.status, taskStatus }, { status: 409 });
    }
    // In-flight quarantine converges into reconciliation by normalizing to uncertain.
    if (
      state.status === "quarantined" &&
      !state.providerCallCompleted &&
      state.dispatchState === "dispatched" &&
      !state.responseJson
    ) {
      const normalized = normalizeInFlightQuarantineForReconciliation(this.sql as unknown as SideEffectSql, callKey);
      if (!normalized) {
        return json({ error: "side_effect_not_reconcilable", status: state.status, taskStatus }, { status: 409 });
      }
      state = normalized;
      if (taskStatus !== "attention_required") {
        const now = new Date().toISOString();
        this.sql`UPDATE delegated_tasks SET status='attention_required',fiber_id=NULL,
          checkpoint_json=json_set(COALESCE(checkpoint_json,'{}'),'$.status','attention_required','$.error','uncertain_tool_side_effect'),
          updated_at=${now} WHERE id=${meta.task_id}`;
        taskStatus = "attention_required";
      }
    }
    if (state.status !== "uncertain" || taskStatus !== "attention_required") {
      return json({ error: "side_effect_not_reconcilable", status: state.status, taskStatus }, { status: 409 });
    }
    if (body.resolution === "close_without_retry") {
      const outcome = String(body.outcome ?? "");
      const evidence = typeof body.evidence === "string" ? body.evidence.trim().slice(0, 500) : "";
      const allowedOutcomes = new Set([
        "not_applied",
        "failed_no_usable_result",
        "remote_outcome_unknown_read_only",
      ]);
      if (!allowedOutcomes.has(outcome) || !evidence || body.noRetry !== true) {
        return json({ error: "verified_failure_evidence_required" }, { status: 400 });
      }
      const now = new Date().toISOString();
      const display = safeSerializeForDisplay({
        kind: "manual_side_effect_reconciliation",
        outcome,
        evidence,
        noRetry: true,
        providerAttemptCount: state.providerAttemptCount,
        reconciledAt: now,
      });
      markClosedWithoutRetry(this.sql as unknown as SideEffectSql, { callKey, display, now });
      this.sql`UPDATE delegated_tasks SET status='failed',fiber_id=NULL,
        checkpoint_json=json_set(COALESCE(checkpoint_json,'{}'),'$.status','failed','$.error',${`side_effect_closed:${outcome}`}),
        updated_at=${now} WHERE id=${meta.task_id} AND status='attention_required'`;
      this.audit("tool.side_effect.closed_without_retry", "management-api", callKey, {
        taskId: meta.task_id,
        outcome,
        evidence,
        noRetry: true,
        providerAttemptCount: state.providerAttemptCount,
      });
      return json({ callKey, taskId: meta.task_id, status: "failed", taskStatus: "failed", outcome, noRetry: true });
    }
    if (body.resolution === "authorize_retry") {
      let proof: RetrySafetyProof;
      try {
        proof = parseRetrySafetyProof(body.proof, { source: "client" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "retry_proof_invalid";
        return json({ error: message }, { status: 422 });
      }
      const taskScope = this.sql<{ owner_id: string; service_id: string }>`SELECT owner_id, service_id FROM delegated_tasks WHERE id=${meta.task_id}`[0];
      const actorId = taskScope ? `${taskScope.owner_id}:${taskScope.service_id}` : "management-api";
      const { allowed } = authorizeRetry(this.sql as unknown as SideEffectSql, {
        callKey,
        proof,
        authorizedBy: { type: "owner", id: actorId },
      });
      if (!allowed) {
        return json({ error: "provider_retry_safety_not_proven" }, { status: 409 });
      }
      const taskInput = this.delegatedTaskInput(meta.task_id);
      if (!taskInput) return json({ error: "invalid_persisted_task" }, { status: 500 });
      const checkpoint = this.readTaskCheckpoint(meta.task_id);
      const { receipt, generation } = await this.startRepairFiber(taskInput, checkpoint);
      this.audit("tool.side_effect.retry_authorized", "management-api", callKey, { taskId: meta.task_id, generation });
      return json({ callKey, status: "retry_authorized", generation, fiberId: receipt.fiberId }, { status: 202 });
    }
    if (body.resolution === "confirm_completed") {
      if (!("result" in body)) return json({ error: "verified_result_required" }, { status: 400 });
      const now = new Date().toISOString();
      let receipt: import("./toolSideEffectState").ProviderResultReceipt;
      try {
        receipt = encodeProviderResultReceipt({ resultStatus: "serializable", value: body.result });
      } catch {
        receipt = encodeProviderResultReceipt({ resultStatus: "unserializable", display: safeSerializeForDisplay(body.result) });
      }
      persistTerminalReceipt(this.sql as unknown as SideEffectSql, { callKey, receipt, now });
      const taskInput = this.delegatedTaskInput(meta.task_id);
      if (!taskInput) return json({ error: "invalid_persisted_task" }, { status: 500 });
      const checkpoint = this.readTaskCheckpoint(meta.task_id);
      const { receipt: fiberReceipt, generation } = await this.startRepairFiber(taskInput, checkpoint);
      this.audit("tool.side_effect.reconciled", "management-api", callKey, { taskId: meta.task_id, generation });
      return json({ callKey, status: "completed", generation, fiberId: fiberReceipt.fiberId }, { status: 202 });
    }
    return json({ error: "invalid_side_effect_resolution", status: state.status }, { status: 409 });
  }

  private issueContextHandle(body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): Response {
    const scope = this.parseContextScope(body, binding);
    if (
      !scope ||
      (body.kind !== "memory" && body.kind !== "artifact" && body.kind !== "tool_result") ||
      typeof body.checksum !== "string" ||
      typeof body.ttlMs !== "number"
    ) {
      return json({ error: "invalid_context_handle_request" }, { status: 400 });
    }
    const handle = createContextHandle({
      ...scope,
      kind: body.kind,
      checksum: body.checksum,
      ttlMs: body.ttlMs,
      serverNow: new Date(),
    });
    this.sql`INSERT INTO context_handles (handle, kind, checksum, namespace, chat_id, task_id, recipient, purpose, request_hash, owner_id, service_id, created_at, expires_at)
      VALUES (${handle.handle}, ${handle.kind}, ${handle.checksum}, ${handle.namespace}, ${handle.chatId}, ${handle.taskId}, ${handle.recipient}, ${handle.purpose}, ${handle.requestHash}, ${handle.ownerId}, ${handle.serviceId}, ${handle.createdAt}, ${handle.expiresAt})`;
    this.audit("context.handle.issued", `context-service:${binding.serviceId}`, handle.handle, {
      kind: handle.kind,
      ownerId: handle.ownerId,
      serviceId: handle.serviceId,
      expiresAt: handle.expiresAt,
    });
    return json({ ref: { handle: handle.handle }, expiresAt: handle.expiresAt }, { status: 201 });
  }

  private async issueContextCapsule(
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
  ): Promise<Response> {
    const input = await this.parseContextCapsuleInput(body, binding);
    if (!input) return json({ error: "invalid_context_capsule_request" }, { status: 400 });
    const capsule = createContextCapsule(input);
    this.sql`INSERT INTO context_capsules (id, namespace, chat_id, task_id, recipient, purpose, request_hash, owner_id, service_id, created_at, expires_at, max_bytes, total_bytes, truncated, refs_json)
      VALUES (${capsule.capsuleId}, ${capsule.namespace}, ${capsule.chatId}, ${capsule.taskId}, ${capsule.recipient}, ${capsule.purpose}, ${capsule.requestHash}, ${capsule.ownerId}, ${capsule.serviceId}, ${capsule.createdAt}, ${capsule.expiresAt}, ${capsule.maxBytes}, ${capsule.totalBytes}, ${capsule.truncated ? 1 : 0}, ${JSON.stringify(capsule.refs)})`;
    this.audit("context.capsule.issued", `context-service:${binding.serviceId}`, capsule.capsuleId, {
      namespace: capsule.namespace,
      chatId: capsule.chatId,
      taskId: capsule.taskId,
      recipient: capsule.recipient,
      purpose: capsule.purpose,
      requestHash: capsule.requestHash,
      ownerId: capsule.ownerId,
      serviceId: capsule.serviceId,
      maxBytes: capsule.maxBytes,
      totalBytes: capsule.totalBytes,
      truncated: capsule.truncated,
      refCount: capsule.refs.length,
      expiresAt: capsule.expiresAt,
    });
    return json({ capsule }, { status: 201 });
  }

  private resolveCapsule(body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): Response {
    const capsuleId = typeof body.capsuleId === "string" ? body.capsuleId : "";
    const input = this.parseContextResolutionInput(body, binding);
    if (!capsuleId || !input) return json({ error: "invalid_context_resolution_request" }, { status: 400 });
    const row = this.sql<ContextCapsuleRow>`SELECT id, namespace, chat_id, task_id, recipient, purpose, request_hash, owner_id, service_id, created_at, expires_at, max_bytes, total_bytes, truncated, refs_json
      FROM context_capsules WHERE id = ${capsuleId}`[0];
    if (!row) return json({ error: "capsule_not_found" }, { status: 404 });
    const capsule = this.rowToContextCapsule(row);
    const result = resolveContextCapsule(capsule, input);
    this.audit(result.ok ? "context.capsule.resolved" : "context.capsule.denied", `context-service:${binding.serviceId}`, capsuleId, {
      namespace: capsule.namespace,
      chatId: capsule.chatId,
      taskId: capsule.taskId,
      recipient: capsule.recipient,
      purpose: capsule.purpose,
      requestHash: capsule.requestHash,
      ownerId: capsule.ownerId,
      serviceId: capsule.serviceId,
      code: result.ok ? "resolved" : result.code,
    });
    return json(result.ok ? { capsule: result.capsule } : result, {
      status: result.ok ? 200 : result.code === "capsule_expired" ? 410 : result.code === "invalid_server_clock" ? 503 : 409,
    });
  }

  private async evaluatePolicy(body: Record<string, unknown>, actor: string): Promise<Response> {
    const serverId = typeof body.serverId === "string" ? body.serverId : "";
    const toolName = typeof body.toolName === "string" ? body.toolName : "";
    if (!serverId || !toolName) return json({ error: "server_id_and_tool_name_required" }, { status: 400 });
    const row = this.sql<{
      enabled: number;
      tool_allowlist_json: string;
      tool_catalog_json: string;
      observed_tool_catalog_json: string;
    }>`SELECT enabled, tool_allowlist_json, tool_catalog_json, observed_tool_catalog_json FROM mcp_registry WHERE id = ${serverId}`[0];
    if (!row || Number(row.enabled) !== 1) return json({ error: "mcp_not_available" }, { status: 404 });
    const rawCatalog = this.parseJson<unknown>(row.tool_catalog_json, null);
    if (toolCatalogNeedsRefresh(rawCatalog)) return json({ error: "tool_catalog_refresh_required" }, { status: 409 });
    const catalog = parseToolCatalog(rawCatalog);
    const rawObservedCatalog = this.parseJson<unknown>(row.observed_tool_catalog_json, null);
    if (toolCatalogNeedsRefresh(rawObservedCatalog)) return json({ error: "observed_catalog_refresh_required" }, { status: 409 });
    const observedCatalog = parseToolCatalog(rawObservedCatalog);

    const decision = await evaluateToolPolicy({
      catalog,
      observedCatalog,
      allowlist: this.parseJson(row.tool_allowlist_json, []),
      serverId,
      toolName,
      args: body.args ?? {},
      policyVersion: typeof body.policyVersion === "string" ? body.policyVersion : undefined,
    });

    this.audit(decision.ok ? "tool.policy.allowed" : "tool.policy.denied", actor, `${serverId}/${toolName}`, {
      code: decision.code,
      argsHash: decision.argsHash,
      policyVersion: decision.policyVersion,
      riskLevel: decision.ok ? decision.riskLevel : null,
      requiresApproval: decision.ok ? decision.requiresApproval : null,
    });

    return json({ decision }, { status: decision.ok ? 200 : 409 });
  }

  private sanitizePolicyResult(body: Record<string, unknown>, actor: string): Response {
    const serverId = typeof body.serverId === "string" ? body.serverId : "";
    const toolName = typeof body.toolName === "string" ? body.toolName : "";
    if (!serverId || !toolName) return json({ error: "server_id_and_tool_name_required" }, { status: 400 });
    const row = this.sql<{ enabled: number; tool_catalog_json: string }>`SELECT enabled, tool_catalog_json FROM mcp_registry WHERE id = ${serverId}`[0];
    if (!row || Number(row.enabled) !== 1) return json({ error: "mcp_not_available" }, { status: 404 });
    const rawCatalog = this.parseJson<unknown>(row.tool_catalog_json, null);
    if (toolCatalogNeedsRefresh(rawCatalog)) return json({ error: "tool_catalog_refresh_required" }, { status: 409 });
    const result = sanitizeToolResult({
      catalog: parseToolCatalog(rawCatalog),
      serverId,
      toolName,
      result: body.result,
    });
    this.audit("tool.result.sanitized", actor, toolName, {
      payloadBytes: result.payloadBytes,
      sourceBytes: result.sourceBytes,
      truncated: result.truncated,
    });
    return json({ result });
  }

  private async prepareApproval(
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
    options: { skipAdvisory?: boolean; legacyThinkEnvelope?: boolean } = {},
  ): Promise<Response> {
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (!taskId) return json({ error: "task_id_required" }, { status: 400 });
    const task = this.sql<{ input_json: string; status: string }>`SELECT input_json, status FROM delegated_tasks WHERE id = ${taskId}`[0];
    if (!task) return json({ error: "task_not_found" }, { status: 404 });
    const input = this.parseJson<DelegatedTaskInput | null>(task.input_json, null);
    const checkpoint = this.readTaskCheckpoint(taskId);
    const call = checkpoint.pendingCall;
    if (!input || task.status !== "approval_required" || checkpoint.status !== "approval_required" || !call) {
      return json({ error: "task_not_waiting_for_approval" }, { status: 409 });
    }
    if (input.ownerId !== binding.ownerId || input.serviceId !== binding.serviceId) {
      return json({ error: "approval_scope_mismatch" }, { status: 403 });
    }
    const elicitation = this.pendingMcpElicitation(taskId);
    if (elicitation) return json(this.mcpElicitationPresentation(elicitation));
    const domain = this.browserDomainDecisionForCall(call, taskId);
    if (domain?.decision.status === "approval_required") {
      return await this.prepareBrowserDomainChallenge(input, call, domain.sourceHost, domain.decision.unknownHosts);
    }
    if (domain?.decision.status === "denied") {
      return json({ error: "browser_domain_denied", code: domain.decision.denyCode }, { status: 409 });
    }
    const decision = await this.evaluateTaskToolPolicy(call, taskId);
    if (!decision.ok || !decision.requiresApproval) return json({ error: "approval_policy_denied", code: decision.code }, { status: 409 });
    const thinkTaskId = input.purpose === "operia_think_paid_read" ? input.thinkTaskId : undefined;
    const agentCallKey = input.purpose === "operia_think_paid_read" ? input.agentCallKey : undefined;
    const schemaHash = decision.tool.schemaHash;
    const pauseGeneration = this.sandboxControlSnapshot().generation;
    if (input.purpose === "operia_think_paid_read" && options.legacyThinkEnvelope
      && (thinkTaskId !== undefined || agentCallKey !== undefined)) {
      return json({ error: "think_approval_legacy_envelope_invalid" }, { status: 409 });
    }
    if (input.purpose === "operia_think_paid_read" && !options.legacyThinkEnvelope
      && (!thinkTaskId || !agentCallKey || !/^[a-f0-9]{64}$/.test(schemaHash))) {
      return json({ error: "think_approval_pin_invalid" }, { status: 409 });
    }
    const approvalRound = checkpoint.round;
    if (!Number.isSafeInteger(approvalRound) || approvalRound < 0) {
      return json({ error: "approval_round_invalid" }, { status: 409 });
    }
    const existing = this.sql<ApprovalTicketRow>`SELECT * FROM approval_ticket_calls
      WHERE task_id=${taskId} AND approval_round=${approvalRound} AND server_id=${call.serverId}
        AND tool_name=${call.toolName} AND args_hash=${decision.argsHash} AND policy_version=${decision.policyVersion}`[0];
    if (existing) {
      await this.ensureApprovalWorkflow(existing);
      return json(this.approvalPresentation(existing, { legacyThinkEnvelope: options.legacyThinkEnvelope === true }));
    }

    const id = newApprovalTicketId();
    const workflowId = crypto.randomUUID();
    const nonce = newApprovalNonce();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const preview = { taskId, serverId: call.serverId, toolName: call.toolName, args: call.args, riskLevel: decision.riskLevel };
    const review = options.skipAdvisory
      ? { advisoryOnly: true, skipped: true, reason: "think_paid_read_no_model_preflight" }
      : await this.reviewApprovalAdvisory(preview);
    const inserted = this.sql<{ id: string }>`INSERT INTO approval_ticket_calls
      (id, status, owner_id, chat_id, task_id, approval_round, think_task_id, agent_call_key,
      server_id, tool_name, args_json, args_hash, schema_hash, policy_version, pause_generation,
      expires_at, nonce, workflow_id, preview_json, review_json, created_at)
      VALUES (${id}, 'pending', ${input.ownerId}, ${input.chatId}, ${taskId}, ${approvalRound}, ${thinkTaskId ?? null}, ${agentCallKey ?? null},
      ${call.serverId}, ${call.toolName}, ${JSON.stringify(call.args)}, ${decision.argsHash}, ${schemaHash},
      ${decision.policyVersion}, ${pauseGeneration}, ${expiresAt}, ${nonce}, ${workflowId},
      ${JSON.stringify(preview)}, ${JSON.stringify(review)}, ${now.toISOString()})
      ON CONFLICT(task_id, approval_round, server_id, tool_name, args_hash, policy_version) DO NOTHING
      RETURNING id`;
    const ticket = inserted.length === 1
      ? this.sql<ApprovalTicketRow>`SELECT * FROM approval_ticket_calls WHERE id=${id}`[0]
      : this.sql<ApprovalTicketRow>`SELECT * FROM approval_ticket_calls
          WHERE task_id=${taskId} AND approval_round=${approvalRound} AND server_id=${call.serverId}
            AND tool_name=${call.toolName} AND args_hash=${decision.argsHash} AND policy_version=${decision.policyVersion}`[0];
    if (!ticket) return json({ error: "approval_prepare_conflict" }, { status: 409 });
    await this.ensureApprovalWorkflow(ticket);
    if (inserted.length !== 1) {
      return json(this.approvalPresentation(ticket, { legacyThinkEnvelope: options.legacyThinkEnvelope === true }));
    }
    this.audit("approval.ticket.prepared", `context-service:${binding.serviceId}`, id, { taskId, approvalRound, expiresAt, reviewAdvisoryOnly: true });
    await this.dispatchHooks("on_approval", binding, { ticketId: id, taskId, approvalRound, status: "pending", serverId: call.serverId, toolName: call.toolName, expiresAt }, false);
    return json(this.approvalPresentation(ticket, { legacyThinkEnvelope: options.legacyThinkEnvelope === true }), { status: 201 });
  }

  private async forwardApprovalDecision(body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): Promise<Response> {
    const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
    const stop = body.action === "stop";
    const approvalScope = body.action === "once" || body.action === "task" ? body.action : null;
    const action = body.action === "reject" ? "reject" : approvalScope ? "approve" : null;
    const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    if (!ticketId || (!action && !stop) || !ownerId || !chatId) return json({ error: "invalid_approval_callback" }, { status: 400 });
    if (ownerId !== binding.ownerId) return json({ error: "approval_owner_mismatch" }, { status: 403 });
    const ticket = this.sql<ApprovalTicketRow>`SELECT * FROM approval_ticket_calls WHERE id = ${ticketId}`[0];
    if (!ticket) return json({ error: "approval_missing" }, { status: 404 });
    if (ticket.owner_id !== ownerId || ticket.chat_id !== chatId) return json({ error: "approval_scope_mismatch" }, { status: 403 });
    if (stop) {
      const cancelled = await this.cancelDelegatedTask(ticket.task_id);
      if (!cancelled.ok) {
        const payload: Record<string, unknown> = await cancelled.clone().json<Record<string, unknown>>().catch(() => ({}));
        if (cancelled.status !== 409 || payload.status !== "cancelled") return cancelled;
      }
      this.audit("approval.task.stopped", `context-service:${binding.serviceId}`, ticket.id, { taskId: ticket.task_id });
      return json({ ticketId: ticket.id, taskId: ticket.task_id, status: "cancelled" }, { status: 202 });
    }
    if (Date.parse(ticket.expires_at) <= Date.now()) {
      const expiredAt = new Date().toISOString();
      const expired = this.sql<{ id: string }>`UPDATE approval_ticket_calls SET status='expired',consumed_at=${expiredAt}
        WHERE id=${ticketId} AND status='pending' RETURNING id`;
      if (expired.length === 1) {
        await this.rejectInteractiveBrowserApproval(ticket);
        this.scrubApprovalPayload(ticketId);
        await this.continueTaskAfterActionOutcome(ticket.task_id, {
          serverId: ticket.server_id,
          toolName: ticket.tool_name,
          argsHash: ticket.args_hash,
        }, "action_expired", "approval_expired", ticketId, `context-service:${binding.serviceId}`);
      }
      return json({ error: "approval_expired" }, { status: 410 });
    }
    const now = new Date().toISOString();
    let reserved = this.sql<{ id: string }>`UPDATE approval_ticket_calls SET status = 'decision_reserved', decision_action = ${action},
      decision_scope = ${approvalScope ?? "reject"},
      decision_owner_id = ${ownerId}, decision_chat_id = ${chatId}, decided_at = ${now}
      WHERE id = ${ticketId} AND status = 'pending' AND expires_at > ${now} RETURNING id`;
    if (reserved.length !== 1) {
      const current = this.sql<ApprovalTicketRow>`SELECT * FROM approval_ticket_calls WHERE id = ${ticketId}`[0];
      const sameDecision = current && current.decision_action === action && current.decision_scope === (approvalScope ?? "reject")
        && current.decision_owner_id === ownerId && current.decision_chat_id === chatId;
      if (!sameDecision || !["decision_reserved", "attention_required"].includes(current.status)) {
        return json({ error: "approval_replay_denied", status: current?.status ?? ticket.status }, { status: 409 });
      }
      if (current.status === "attention_required") {
        reserved = this.sql<{ id: string }>`UPDATE approval_ticket_calls SET status = 'decision_reserved', attention_error = NULL
          WHERE id = ${ticketId} AND status = 'attention_required' AND decision_action = ${action}
          AND decision_scope = ${approvalScope ?? "reject"}
          AND decision_owner_id = ${ownerId} AND decision_chat_id = ${chatId} RETURNING id`;
        if (reserved.length !== 1) return json({ error: "approval_delivery_retry_conflict" }, { status: 409 });
      }
    }
    try {
      await this.ensureApprovalWorkflow(ticket);
      const workflow = await this.env.APPROVAL_WORKFLOW.get(ticket.workflow_id);
      await workflow.sendEvent({ type: "telegram-decision", payload: {
        action, approvalScope: approvalScope ?? "reject", ownerId, chatId,
      } });
    } catch (error) {
      this.sql`UPDATE approval_ticket_calls SET status = 'attention_required', attention_error = ${boundedAgentErrorCode(error, "workflow_event_failed")}
        WHERE id = ${ticketId} AND status = 'decision_reserved'`;
      return json({ error: "approval_event_attention_required" }, { status: 503 });
    }
    this.audit("approval.callback.forwarded", `context-service:${binding.serviceId}`, ticket.id, { action });
    return json({ ticketId: ticket.id, status: "decision_forwarded" }, { status: 202 });
  }

  private readApprovalDetails(
    ticketId: string,
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
  ): Response {
    const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    const ticket = this.sql<ApprovalTicketRow>`SELECT * FROM approval_ticket_calls WHERE id=${ticketId}`[0];
    if (!ticket) return json({ error: "approval_missing" }, { status: 404 });
    const input = this.delegatedTaskInput(ticket.task_id);
    if (!input || ownerId !== binding.ownerId || input.serviceId !== binding.serviceId
      || ticket.owner_id !== ownerId || ticket.chat_id !== chatId) {
      return json({ error: "approval_scope_mismatch" }, { status: 403 });
    }
    const preview = this.parseJson<Record<string, unknown>>(ticket.preview_json, {});
    const risk = typeof preview.riskLevel === "string" ? preview.riskLevel.slice(0, 24) : "unknown";
    const summary = [
      `Operia 调用了 ${ticket.server_id}/${ticket.tool_name}`,
      `风险：${risk}`,
      `任务：${ticket.task_id}`,
      `参数指纹：${ticket.args_hash.slice(0, 16)}…`,
      `策略版本：${ticket.policy_version.slice(0, 80)}`,
      `状态：${ticket.status}`,
      `有效期至：${ticket.expires_at}`,
      "详情不包含原始参数、凭据或 Think 执行 ID。",
    ].join("\n").slice(0, 900);
    this.audit("approval.details.read", `context-service:${binding.serviceId}`, ticketId, { taskId: ticket.task_id });
    return json({ ticketId, status: ticket.status, summary });
  }

  private async applyApprovalDecision(ticketId: string, body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): Promise<Response> {
    const ticket = this.sql<ApprovalTicketRow>`SELECT * FROM approval_ticket_calls WHERE id = ${ticketId}`[0];
    if (!ticket) return json({ error: "approval_missing" }, { status: 404 });
    if (["approved", "rejected", "expired", "cancelled"].includes(ticket.status)) return json({ ticketId, status: ticket.status });
    if (body.nonce !== ticket.nonce) return json({ error: "approval_workflow_nonce_mismatch" }, { status: 403 });
    const action = body.action;
    if (action === "timeout" && ticket.status === "pending") {
      const now = new Date().toISOString();
      const changed = this.sql<{ id: string }>`UPDATE approval_ticket_calls SET status = 'expired', consumed_at = ${now}
        WHERE id = ${ticketId} AND status = 'pending' RETURNING id`;
      if (changed.length !== 1) return json({ error: "approval_not_pending" }, { status: 409 });
      await this.rejectInteractiveBrowserApproval(ticket);
      this.scrubApprovalPayload(ticketId);
      const resumed = await this.continueTaskAfterActionOutcome(ticket.task_id, {
        serverId: ticket.server_id,
        toolName: ticket.tool_name,
        argsHash: ticket.args_hash,
      }, "action_expired", "approval_timeout", ticketId, `approval-workflow:${ticket.workflow_id}`);
      await this.dispatchHooks("on_approval", binding, { ticketId, taskId: ticket.task_id, status: "expired", action }, false);
      return json({ ticketId, status: "expired", task: resumed });
    }
    const approvalScope = body.approvalScope === "once" || body.approvalScope === "task" || body.approvalScope === "reject"
      ? body.approvalScope : null;
    const reservedMatches = ticket.decision_action === action && ticket.decision_scope === approvalScope
      && ticket.decision_owner_id === body.ownerId && ticket.decision_chat_id === body.chatId;
    if (!reservedMatches) return json({ error: "approval_reserved_decision_mismatch" }, { status: 409 });
    if (action === "reject") {
      const status = "rejected";
      const now = new Date().toISOString();
      const changed = this.sql<{ id: string }>`UPDATE approval_ticket_calls SET status = ${status}, decision_json = ${JSON.stringify(body)}, consumed_at = ${now}
        WHERE id = ${ticketId} AND status = 'decision_reserved' RETURNING id`;
      if (changed.length !== 1) return json({ error: "approval_not_pending" }, { status: 409 });
      await this.rejectInteractiveBrowserApproval(ticket);
      this.scrubApprovalPayload(ticketId);
      const resumed = await this.continueTaskAfterActionOutcome(ticket.task_id, {
        serverId: ticket.server_id,
        toolName: ticket.tool_name,
        argsHash: ticket.args_hash,
      }, "action_denied", "approval_reject", ticketId, `approval-workflow:${ticket.workflow_id}`);
      await this.dispatchHooks("on_approval", binding, { ticketId, taskId: ticket.task_id, status, action }, false);
      return json({ ticketId, status, task: resumed });
    }
    if (action !== "approve" || (approvalScope !== "once" && approvalScope !== "task")
      || body.ownerId !== ticket.owner_id || body.chatId !== ticket.chat_id || body.ownerId !== binding.ownerId) {
      return json({ error: "approval_scope_mismatch" }, { status: 403 });
    }
    const args = this.parseJson<unknown>(ticket.args_json, null);
    if (this.isTaskCancelled(ticket.task_id)) return json({ error: "task_cancelled" }, { status: 409 });
    if (ticket.status === "decision_reserved") {
      const checkpoint = this.readTaskCheckpoint(ticket.task_id);
      const pendingCall = checkpoint.pendingCall;
      const pendingArgsHash = pendingCall ? await canonicalArgsHash(pendingCall.args) : "";
      if (checkpoint.status !== "approval_required" || checkpoint.round !== ticket.approval_round || !pendingCall
        || pendingCall.serverId !== ticket.server_id || pendingCall.toolName !== ticket.tool_name
        || pendingArgsHash !== ticket.args_hash) {
        return json({ error: "approval_task_call_changed" }, { status: 409 });
      }
    }
    const callKey = ticket.agent_call_key ?? `${ticket.task_id}:${ticket.server_id}:${ticket.tool_name}:${ticket.args_hash}`;
    if (Date.parse(ticket.expires_at) <= Date.now()) {
      const sideEffect = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM tool_side_effects WHERE call_key = ${callKey}`[0]?.count ?? 0;
      if (sideEffect === 0) {
        this.sql`UPDATE approval_ticket_calls SET status = 'expired' WHERE id = ${ticketId} AND status IN ('decision_reserved', 'consuming')`;
        this.scrubApprovalPayload(ticketId);
        await this.continueTaskAfterActionOutcome(ticket.task_id, {
          serverId: ticket.server_id,
          toolName: ticket.tool_name,
          argsHash: ticket.args_hash,
        }, "action_expired", "approval_expired", ticketId, `approval-workflow:${ticket.workflow_id}`);
        return json({ error: "approval_expired" }, { status: 410 });
      }
    }
    {
      const validated = await validateApprovalBinding({ ...this.rowToApprovalTicket(ticket), status: "pending" }, {
        ownerId: ticket.owner_id, chatId: ticket.chat_id, taskId: ticket.task_id, serverId: ticket.server_id,
        toolName: ticket.tool_name, policyVersion: ticket.policy_version, args, now: new Date(),
      });
      if (!validated.ok) return json({ error: validated.code }, { status: validated.code === "approval_expired" ? 410 : 409 });
    }
    const call = { serverId: ticket.server_id, toolName: ticket.tool_name, args };
    const currentPolicy = await this.evaluateTaskToolPolicy(call, ticket.task_id);
    if (!currentPolicy.ok || !currentPolicy.requiresApproval || currentPolicy.argsHash !== ticket.args_hash || currentPolicy.policyVersion !== ticket.policy_version) {
      return json({ error: "approval_policy_changed" }, { status: 409 });
    }
    const approvalTaskInput = this.delegatedTaskInput(ticket.task_id);
    if (!approvalTaskInput) return json({ error: "invalid_persisted_task" }, { status: 409 });
    const currentPauseGeneration = this.sandboxControlSnapshot().generation;
    const legacyThinkApproval = approvalTaskInput.purpose === "operia_think_paid_read"
      && !approvalTaskInput.thinkTaskId && !approvalTaskInput.agentCallKey;
    const modernThinkApproval = approvalTaskInput.purpose === "operia_think_paid_read"
      && Boolean(approvalTaskInput.thinkTaskId) && Boolean(approvalTaskInput.agentCallKey);
    const malformedThinkApproval = approvalTaskInput.purpose === "operia_think_paid_read"
      && !legacyThinkApproval && !modernThinkApproval;
    if (malformedThinkApproval || (legacyThinkApproval && (ticket.think_task_id !== null || ticket.agent_call_key !== null))
      || (modernThinkApproval && (!ticket.think_task_id || !ticket.agent_call_key || !ticket.schema_hash
        || ticket.think_task_id !== approvalTaskInput.thinkTaskId
        || ticket.agent_call_key !== approvalTaskInput.agentCallKey
        || ticket.schema_hash !== currentPolicy.tool.schemaHash
        || ticket.pause_generation !== currentPauseGeneration))) {
      this.sql`UPDATE approval_ticket_calls SET status='quarantined',attention_error='approval_pin_drift'
        WHERE id=${ticketId} AND status IN ('decision_reserved','consuming')`;
      return json({ error: "approval_pin_drift", status: "quarantined" }, { status: 409 });
    }
    const now = new Date().toISOString();
    if (ticket.status === "decision_reserved") {
      const consumed = this.sql<{ id: string }>`UPDATE approval_ticket_calls SET status = 'consuming', decision_json = ${JSON.stringify(body)}, consumed_at = ${now}
        WHERE id = ${ticketId} AND status = 'decision_reserved' RETURNING id`;
      if (consumed.length !== 1) return json({ error: "approval_replay_denied" }, { status: 409 });
    } else if (ticket.status !== "consuming") {
      return json({ error: "approval_not_pending", status: ticket.status }, { status: 409 });
    }
    try {
      if (this.isTaskCancelled(ticket.task_id)) return json({ error: "task_cancelled" }, { status: 409 });
      const raw = await this.invokeMcpTool(call, callKey, ticket.task_id, new AbortController().signal);
      const { catalog } = this.loadExecutableCatalog();
      const sanitized = sanitizeToolResult({ catalog, serverId: call.serverId, toolName: call.toolName, result: raw });
      if (this.isTaskCancelled(ticket.task_id)) throw new Error("task_cancelled_after_tool_result");
      const taskInput = approvalTaskInput;
      if (approvalScope === "task") {
        const grantId = `atg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const grantExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
        this.sql`INSERT INTO approval_task_grants
          (id,task_id,think_task_id,owner_id,chat_id,server_id,tool_name,args_hash,schema_hash,policy_version,
           pause_generation,status,expires_at,created_at,updated_at)
          VALUES (${grantId},${ticket.task_id},${ticket.think_task_id},${ticket.owner_id},${ticket.chat_id},${ticket.server_id},${ticket.tool_name},
            ${ticket.args_hash},${ticket.schema_hash},${ticket.policy_version},${ticket.pause_generation},'active',${grantExpiresAt},${now},${now})
          ON CONFLICT(task_id,owner_id,chat_id,server_id,tool_name,args_hash,policy_version)
          DO UPDATE SET status='active',expires_at=${grantExpiresAt},updated_at=${now}`;
      }
      const checkpoint = this.readTaskCheckpoint(ticket.task_id);
      const resumed: ToolTaskCheckpoint = {
        ...checkpoint, status: "interrupted", pendingCall: undefined, callCount: checkpoint.callCount + 1,
        completedCallKeys: [...checkpoint.completedCallKeys, callKey], results: [...checkpoint.results, sanitized],
      };
      this.persistTaskCheckpoint(resumed);
      await this.startDelegatedFiber(taskInput, resumed, `${taskInput.idempotencyKey}:approval:${ticketId}`);
      this.sql`UPDATE approval_ticket_calls SET status = 'approved' WHERE id = ${ticketId} AND status = 'consuming'`;
      this.scrubApprovalPayload(ticketId);
      await this.dispatchHooks("on_approval", binding, { ticketId, taskId: ticket.task_id, status: "approved", action }, false);
      return json({ ticketId, status: "approved", taskId: ticket.task_id });
    } catch (error) {
      this.sql`UPDATE approval_task_grants SET status='revoked',updated_at=${new Date().toISOString()}
        WHERE task_id=${ticket.task_id} AND server_id=${ticket.server_id} AND tool_name=${ticket.tool_name}
          AND args_hash=${ticket.args_hash} AND policy_version=${ticket.policy_version} AND status='active'`;
      this.sql`UPDATE approval_ticket_calls SET status = 'attention_required' WHERE id = ${ticketId} AND status = 'consuming'`;
      throw error;
    }
  }

  private async evaluateCurrentToolPolicy(call: { serverId: string; toolName: string; args: unknown }) {
    const { catalog, observedCatalog, allowlists } = this.loadExecutableCatalog();
    return evaluateToolPolicy({ catalog, observedCatalog, allowlist: allowlists.get(call.serverId) ?? [], ...call });
  }

  private async evaluateTaskToolPolicy(call: { serverId: string; toolName: string; args: unknown }, taskId: string) {
    const base = await this.evaluateCurrentToolPolicy(call);
    let decision = base;
    const taskInput = this.delegatedTaskInput(taskId);
    if (base.ok && taskInput?.purpose === "operia_think_paid_read") {
      const snapshot = await this.thinkCatalogSnapshot();
      const billing = snapshot.descriptions[`${call.serverId}/${call.toolName}`];
      if (!billing || billing.mayCost || billing.billingClass !== "none" || billing.requiresConfirmation) {
        decision = {
          ...base,
          code: "approval_required" as const,
          requiresApproval: true,
          policyVersion: `${base.policyVersion}:think-billing-v1`,
        };
      }
    }
    if (decision.ok && decision.requiresApproval && taskInput) {
      const thinkTaskId = taskInput.thinkTaskId ?? taskId;
      const candidates = this.sql<{
        think_task_id: string | null; owner_id: string; chat_id: string; server_id: string; tool_name: string;
        args_hash: string; schema_hash: string | null; policy_version: string; pause_generation: number | null;
      }>`SELECT think_task_id,owner_id,chat_id,server_id,tool_name,args_hash,schema_hash,policy_version,pause_generation
        FROM approval_task_grants
        WHERE (think_task_id=${thinkTaskId} OR (think_task_id IS NULL AND task_id=${taskId}))
          AND owner_id=${taskInput.ownerId} AND chat_id=${taskInput.chatId}
          AND server_id=${call.serverId} AND tool_name=${call.toolName}
          AND status='active' AND expires_at>${new Date().toISOString()}`;
      const callPins: ThinkApprovalGrantPins = {
        thinkTaskId,
        ownerId: taskInput.ownerId,
        chatId: taskInput.chatId,
        serverId: call.serverId,
        toolName: call.toolName,
        argsHash: decision.argsHash,
        schemaHash: decision.tool.schemaHash,
        policyVersion: decision.policyVersion,
        pauseGeneration: this.sandboxControlSnapshot().generation,
      };
      const grant = candidates.find((candidate) => matchesThinkApprovalTaskGrant({
        thinkTaskId: candidate.think_task_id ?? taskId,
        ownerId: candidate.owner_id,
        chatId: candidate.chat_id,
        serverId: candidate.server_id,
        toolName: candidate.tool_name,
        argsHash: candidate.args_hash,
        schemaHash: candidate.schema_hash ?? "",
        policyVersion: candidate.policy_version,
        pauseGeneration: Number(candidate.pause_generation ?? -1),
      }, callPins));
      if (grant) decision = { ...decision, code: "allowed" as const, requiresApproval: false };
    }
    if (taskInput?.purpose === "companion-pulse-read-only") {
      if (!base.ok || base.requiresApproval || base.riskLevel !== "read") decision = base.ok
        ? { ok: false as const, code: "invalid_arguments" as const, argsHash: base.argsHash, policyVersion: `${base.policyVersion}:heartbeat-v1` }
        : base;
      const key = `${call.serverId}/${call.toolName}`;
      if (/(generate_image|speak|call_service|memory.*(?:write|set|upsert|delete)|email|mail|approval|elicitation)/i.test(key)
        || (call.serverId === BROWSER_PROVIDER_SERVER_ID && ["browser_execute", "browser_resume"].includes(call.toolName))) {
        decision = { ok: false as const, code: "invalid_arguments" as const, argsHash: base.argsHash, policyVersion: `${base.policyVersion}:heartbeat-v1` };
      }
    }
    if (decision.ok && call.serverId === BROWSER_PROVIDER_SERVER_ID) {
      const domain = this.browserDomainDecisionForCall(call, taskId);
      if (domain?.decision.status === "denied") {
        decision = { ok: false as const, code: "invalid_arguments" as const, argsHash: base.argsHash, policyVersion: `${base.policyVersion}:browser-domain-v1` };
      } else if (domain?.decision.status === "approval_required") {
        decision = {
          ...decision,
          code: "approval_required" as const,
          requiresApproval: true,
          policyVersion: `${base.policyVersion}:browser-domain-v1`,
        };
      }
    }
    this.recordPolicyV3Shadow(call, taskId, decision, base.ok ? base.tool : undefined);
    return decision;
  }

  private recordPolicyV3Shadow(
    call: { serverId: string; toolName: string; args: unknown },
    taskId: string,
    staticDecision: Awaited<ReturnType<typeof evaluateToolPolicy>>,
    tool?: ToolCatalogEntry,
  ): void {
    if (this.env.AGENT_POLICY_V3_SHADOW_ENABLED?.trim().toLowerCase() !== "true") return;
    try {
      const shadow = evaluatePolicyV3Shadow({ ...call, staticDecision, ...(tool ? { tool } : {}) });
      this.audit("tool.policy_v3.shadow", "agent-policy", `${call.serverId}/${call.toolName}`, {
        taskId,
        argsHash: staticDecision.argsHash,
        enforcedPolicyVersion: staticDecision.policyVersion,
        ...shadow,
        enforcement: false,
      });
    } catch (error) {
      console.error("agent: policy v3 shadow evaluation failed", {
        taskId,
        code: boundedAgentErrorCode(error, "policy_v3_shadow_failed"),
      });
    }
  }

  private browserDomainDecisionForCall(
    call: { serverId: string; toolName: string; args: unknown },
    taskId: string,
  ): { decision: ReturnType<typeof evaluateBrowserDomainPolicy>; sourceHost: string | null; targetHosts: string[] } | null {
    if (call.serverId !== BROWSER_PROVIDER_SERVER_ID) return null;
    const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {};
    let targetUrls: string[] = [];
    if (["browser_markdown", "browser_links", "browser_scrape", "browser_extract", "site_adapter_read"].includes(call.toolName)) {
      targetUrls = [String(args.url ?? "")];
    } else if (call.toolName === "browser_execute" || call.toolName === "browser_task") {
      targetUrls = Array.isArray(args.domains) ? args.domains.map((host) => `https://${String(host)}`) : [];
    } else if (call.toolName === "browser_resume") {
      const executionId = typeof args.execution_id === "string" ? args.execution_id : "";
      const execution = this.browserExecution(executionId);
      targetUrls = execution && execution.task_id === taskId
        ? this.parseJson<string[]>(execution.domains_json, []).map((host) => `https://${host}`)
        : [];
    } else {
      return null;
    }
    const sourceUrl = this.browserSourceUrlForTask(taskId);
    const decision = evaluateBrowserDomainPolicy({
      sourceUrl,
      targetUrls,
      ownerDeniedHosts: this.browserDomainDenylistSnapshot().domains,
      permanentAllowedHosts: this.browserDomainAllowlist(),
      taskGrantedHosts: this.activeBrowserGrantHosts(taskId),
    });
    const targetHosts = targetUrls.flatMap((raw) => {
      try { return [new URL(raw).hostname.toLowerCase()]; } catch { return []; }
    });
    return {
      decision,
      sourceHost: sourceUrl ? new URL(sourceUrl).hostname.toLowerCase() : null,
      targetHosts: [...new Set(targetHosts)],
    };
  }

  private browserSourceUrlForTask(taskId: string): string | null {
    const row = this.sql<{ last_url_origin: string | null }>`SELECT s.last_url_origin FROM browser_executions e
      LEFT JOIN browser_sessions s ON s.session_key=e.session_key
      WHERE e.task_id=${taskId} ORDER BY e.created_at DESC LIMIT 1`[0];
    if (row?.last_url_origin) return row.last_url_origin;
    const execution = this.browserExecutionForTask(taskId);
    const first = execution ? this.parseJson<string[]>(execution.domains_json, [])[0] : null;
    return first ? `https://${first}` : null;
  }

  private activeBrowserGrantHosts(taskId: string): string[] {
    const input = this.delegatedTaskInput(taskId);
    if (!input) return [];
    const now = new Date().toISOString();
    return this.sql<{ hostname: string }>`SELECT DISTINCT hostname FROM browser_domain_grants
      WHERE task_id=${taskId} AND owner_id=${input.ownerId} AND chat_id=${input.chatId}
      AND status='active' AND expires_at>${now} AND (uses_remaining IS NULL OR uses_remaining>0)`
      .map((row) => row.hostname);
  }

  private async prepareBrowserDomainChallenge(
    input: DelegatedTaskInput,
    call: { serverId: string; toolName: string; args: unknown },
    sourceHost: string | null,
    unknownHosts: string[],
  ): Promise<Response> {
    const argsHash = await canonicalArgsHash(call.args);
    let challenge = this.sql<BrowserDomainChallengeRow>`SELECT * FROM browser_domain_challenges
      WHERE task_id=${input.taskId} AND args_hash=${argsHash} AND status='pending'
      ORDER BY created_at DESC LIMIT 1`[0];
    let created = false;
    if (!challenge) {
      const now = new Date();
      const id = `bdc_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
      this.sql`INSERT INTO browser_domain_challenges
        (id,task_id,owner_id,service_id,chat_id,source_host,target_hosts_json,call_json,args_hash,status,expires_at,created_at,updated_at)
        VALUES (${id},${input.taskId},${input.ownerId},${input.serviceId},${input.chatId},${sourceHost},
          ${JSON.stringify(unknownHosts)},${JSON.stringify(call)},${argsHash},'pending',${expiresAt},${now.toISOString()},${now.toISOString()})`;
      challenge = this.sql<BrowserDomainChallengeRow>`SELECT * FROM browser_domain_challenges WHERE id=${id}`[0];
      created = true;
      this.audit("browser.domain_challenge.created", `context-service:${input.serviceId}`, id, {
        taskId: input.taskId, sourceHost, targetHosts: unknownHosts, argsHash, expiresAt,
      });
    }
    const targets = this.parseJson<string[]>(challenge.target_hosts_json, []);
    const source = challenge.source_host ?? "new browser session";
    const callbacks = {
      once: encodeBrowserDomainCallback("once", challenge.id),
      task: encodeBrowserDomainCallback("task", challenge.id),
      reject: encodeBrowserDomainCallback("reject", challenge.id),
    };
    return json({
      kind: "browser_domain_challenge",
      challengeId: challenge.id,
      taskId: challenge.task_id,
      status: challenge.status,
      summary: `Browser 请求跨域：${source} -> ${targets.join(", ")}。请选择仅一次、本任务或拒绝当前动作。永久策略只能在 Admin 控制面修改。`,
      preview: { sourceHost: challenge.source_host, targetHosts: targets, toolName: call.toolName, expiresAt: challenge.expires_at },
      callbacks,
    }, { status: created ? 201 : 200 });
  }

  private async applyBrowserDomainDecision(
    challengeId: string,
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
  ): Promise<Response> {
    const action = body.action === "once" || body.action === "task" || body.action === "reject"
      ? body.action as BrowserDomainDecisionAction
      : null;
    const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    if (!action || !ownerId || !chatId || (body.challengeId && body.challengeId !== challengeId)) {
      return json({ error: "invalid_browser_domain_callback" }, { status: 400 });
    }
    const challenge = this.sql<BrowserDomainChallengeRow>`SELECT * FROM browser_domain_challenges WHERE id=${challengeId}`[0];
    if (!challenge) return json({ error: "browser_domain_challenge_missing" }, { status: 404 });
    if (challenge.owner_id !== ownerId || challenge.chat_id !== chatId || ownerId !== binding.ownerId || challenge.service_id !== binding.serviceId) {
      return json({ error: "browser_domain_challenge_scope_mismatch" }, { status: 403 });
    }
    if (challenge.status !== "pending") {
      if (challenge.decision_scope === action && ["approved", "rejected"].includes(challenge.status)) {
        return json({ challengeId, status: challenge.status, action });
      }
      return json({ error: "browser_domain_challenge_replay_denied", status: challenge.status }, { status: 409 });
    }
    const taskRow = this.sql<{ input_json: string; status: string }>`SELECT input_json,status FROM delegated_tasks WHERE id=${challenge.task_id}`[0];
    const input = taskRow ? this.parseJson<DelegatedTaskInput | null>(taskRow.input_json, null) : null;
    const checkpoint = taskRow ? this.readTaskCheckpoint(challenge.task_id) : null;
    if (!input || !checkpoint?.pendingCall || taskRow?.status !== "approval_required" || checkpoint.status !== "approval_required") {
      return json({ error: "browser_domain_task_not_waiting" }, { status: 409 });
    }
    const pendingHash = await canonicalArgsHash(checkpoint.pendingCall.args);
    if (pendingHash !== challenge.args_hash) return json({ error: "browser_domain_args_mismatch" }, { status: 409 });

    if (Date.parse(challenge.expires_at) <= Date.now()) {
      const now = new Date().toISOString();
      const expired = this.sql<{ id: string }>`UPDATE browser_domain_challenges SET status='expired',updated_at=${now},decided_at=${now}
        WHERE id=${challengeId} AND status='pending' RETURNING id`;
      if (expired.length === 1) {
        await this.continueTaskAfterActionOutcome(challenge.task_id, {
          serverId: checkpoint.pendingCall.serverId,
          toolName: checkpoint.pendingCall.toolName,
          argsHash: challenge.args_hash,
        }, "action_expired", "browser_domain_challenge_expired", challengeId, `context-service:${binding.serviceId}`);
      }
      return json({ error: "browser_domain_challenge_expired" }, { status: 410 });
    }

    const now = new Date().toISOString();
    const finalStatus = action === "reject" ? "rejected" : "approved";
    const reserved = this.sql<{ id: string }>`UPDATE browser_domain_challenges SET status=${finalStatus},decision_scope=${action},
      updated_at=${now},decided_at=${now} WHERE id=${challengeId} AND status='pending' RETURNING id`;
    if (reserved.length !== 1) return json({ error: "browser_domain_challenge_conflict" }, { status: 409 });

    if (action === "reject") {
      const resumed = await this.continueTaskAfterActionOutcome(challenge.task_id, {
        serverId: checkpoint.pendingCall.serverId,
        toolName: checkpoint.pendingCall.toolName,
        argsHash: challenge.args_hash,
      }, "action_denied", "browser_domain_rejected", challengeId, `context-service:${binding.serviceId}`);
      this.audit("browser.domain_challenge.rejected", `context-service:${binding.serviceId}`, challengeId, { taskId: challenge.task_id });
      return json({ challengeId, status: "rejected", action, task: resumed });
    }

    const hosts = this.parseJson<string[]>(challenge.target_hosts_json, []);
    const expiresAt = new Date(Date.now() + (action === "once" ? 15 * 60_000 : 2 * 60 * 60_000)).toISOString();
    for (const hostname of hosts) {
      const grantId = `bdg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      this.sql`INSERT INTO browser_domain_grants
        (id,task_id,owner_id,chat_id,hostname,scope,status,uses_remaining,expires_at,created_at,updated_at)
        VALUES (${grantId},${challenge.task_id},${ownerId},${chatId},${hostname},${action},'active',
          ${action === "once" ? 1 : null},${expiresAt},${now},${now})`;
    }

    const resumed: ToolTaskCheckpoint = { ...checkpoint, status: "interrupted", error: undefined };
    this.persistTaskCheckpoint(resumed);
    const receipt = await this.startDelegatedFiber(input, resumed, `${input.idempotencyKey}:domain:${challengeId}`);
    this.audit("browser.domain_challenge.approved", `context-service:${binding.serviceId}`, challengeId, {
      taskId: challenge.task_id, action, targetHosts: hosts, fiberId: receipt.fiberId,
    });
    return json({ challengeId, status: "approved", action, taskId: challenge.task_id, fiberId: receipt.fiberId }, { status: 202 });
  }

  private async ensureApprovalWorkflow(ticket: ApprovalTicketRow): Promise<void> {
    let instance: WorkflowInstance;
    try {
      instance = await this.env.APPROVAL_WORKFLOW.get(ticket.workflow_id);
    } catch {
      try {
        instance = await this.env.APPROVAL_WORKFLOW.create({
          id: ticket.workflow_id,
          params: { ticketId: ticket.id, runtimeName: this.name, nonce: ticket.nonce },
        });
      } catch (createError) {
        try {
          // A concurrent request may have created the same instance first.
          instance = await this.env.APPROVAL_WORKFLOW.get(ticket.workflow_id);
        } catch {
          const detail = createError instanceof Error ? `:${createError.message.slice(0, 180)}` : "";
          throw new Error(`approval_workflow_create_failed${detail}`);
        }
      }
    }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const state = await instance.status();
      if (["queued", "running", "waiting", "paused", "waitingForPause"].includes(state.status)) return;
      if (ticket.status === "attention_required" && ["errored", "terminated", "complete"].includes(state.status)) {
        await instance.restart();
        await shortDelay(250);
        continue;
      }
      if (state.status !== "unknown") {
        const detail = state.error?.message ? `:${state.error.message.slice(0, 180)}` : "";
        throw new Error(`approval_workflow_${state.status}${detail}`);
      }
      await shortDelay(250);
    }
    throw new Error("approval_workflow_create_failed");
  }

  private async reviewApprovalAdvisory(preview: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const model = this.plannerModel();
      const response = await this.env.AI.run(model, {
        messages: [{ role: "system", content: "Review this proposed tool action for risk. Advisory only. Never approve it. Return concise JSON." }, { role: "user", content: JSON.stringify(preview) }],
        response_format: { type: "json_object" }, max_tokens: 500,
      } as never) as Record<string, unknown>;
      return { advisoryOnly: true, model, response };
    } catch (error) {
      return { advisoryOnly: true, unavailable: true, error: error instanceof Error ? error.message.slice(0, 200) : "review_unavailable" };
    }
  }

  private approvalPresentation(ticket: ApprovalTicketRow, options: { legacyThinkEnvelope?: boolean } = {}) {
    return {
      ticketId: ticket.id, approvalRound: ticket.approval_round, status: ticket.status, expiresAt: ticket.expires_at,
      ...(options.legacyThinkEnvelope ? {} : {
        thinkTaskId: ticket.think_task_id,
        agentCallKey: ticket.agent_call_key,
        argsHash: ticket.args_hash,
        schemaHash: ticket.schema_hash,
        policyVersion: ticket.policy_version,
        pauseGeneration: ticket.pause_generation,
      }),
      preview: this.parseJson(ticket.preview_json, {}), review: this.parseJson(ticket.review_json ?? "null", null),
      summary: `Operia 调用了 ${ticket.server_id}/${ticket.tool_name}。请选择本次允许、本任务允许，或只拒绝当前动作。`,
      callbacks: {
        once: encodeApprovalCallback("once", ticket.id),
        task: encodeApprovalCallback("task", ticket.id),
        reject: encodeApprovalCallback("reject", ticket.id),
        details: encodeApprovalCallback("details", ticket.id),
        stop: encodeApprovalCallback("stop", ticket.id),
      },
    };
  }

  private scrubApprovalPayload(ticketId: string): void {
    this.sql`UPDATE approval_ticket_calls SET args_json='{"redacted":true}',preview_json='{"redacted":true}',
      review_json='{"redacted":true}',decision_json=NULL WHERE id=${ticketId}
      AND status IN ('approved','rejected','expired','cancelled')`;
    this.sql`UPDATE approval_tickets SET
      status=(SELECT status FROM approval_ticket_calls WHERE id=${ticketId}),
      consumed_at=(SELECT consumed_at FROM approval_ticket_calls WHERE id=${ticketId}),
      args_json='{"redacted":true}',preview_json='{"redacted":true}',review_json='{"redacted":true}',decision_json=NULL
      WHERE id=${ticketId} AND EXISTS (
        SELECT 1 FROM approval_ticket_calls WHERE id=${ticketId}
          AND status IN ('approved','rejected','expired','cancelled')
      )`;
  }

  private rowToApprovalTicket(row: ApprovalTicketRow): ApprovalTicketRecord {
    return { id: row.id, status: row.status, ownerId: row.owner_id, chatId: row.chat_id, taskId: row.task_id,
      serverId: row.server_id, toolName: row.tool_name, argsHash: row.args_hash, policyVersion: row.policy_version,
      expiresAt: row.expires_at, nonce: row.nonce };
  }

  private async submitDelegatedTask(
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
  ): Promise<Response> {
    const input = this.parseDelegatedTaskInput(body, binding);
    if (!input) return json({ error: "invalid_delegated_task" }, { status: 400 });
    if (input.parentTaskId) {
      const parent = this.sql<{ root_task_id: string; chat_id: string }>`SELECT root_task_id,chat_id FROM delegated_tasks
        WHERE id=${input.parentTaskId} AND owner_id=${input.ownerId} AND service_id=${input.serviceId}`[0];
      if (!parent || parent.chat_id !== input.chatId || input.rootTaskId !== parent.root_task_id) {
        return json({ error: "task_parent_scope_invalid" }, { status: 409 });
      }
    } else if (input.rootTaskId !== input.taskId) {
      return json({ error: "task_root_requires_parent" }, { status: 409 });
    }
    const scopedFiberKey = this.scopedTaskFiberKey(input.ownerId, input.serviceId, input.idempotencyKey);
    const existing = this.sql<{ id: string; input_json: string }>`SELECT id,input_json FROM delegated_tasks
      WHERE owner_id=${input.ownerId} AND service_id=${input.serviceId}
        AND client_idempotency_key=${input.idempotencyKey}`[0];
    if (existing) {
      const persisted = this.parseJson<DelegatedTaskInput | null>(existing.input_json, null);
      if (!persisted || await canonicalArgsHash(persisted) !== await canonicalArgsHash(input)) {
        this.audit("task.idempotency_conflict", `context-service:${binding.serviceId}`, existing.id, {});
        return json({ error: "idempotency_conflict", taskId: existing.id }, { status: 409 });
      }
      return await this.reconcileExistingTask(existing.id, scopedFiberKey);
    }
    const capsule = this.sql<ContextCapsuleRow>`SELECT id, namespace, chat_id, task_id, recipient, purpose, request_hash,
      owner_id, service_id, created_at, expires_at, max_bytes, total_bytes, truncated, refs_json
      FROM context_capsules WHERE id = ${input.capsuleId}`[0];
    if (!capsule) return json({ error: "capsule_not_found" }, { status: 404 });
    const resolved = resolveContextCapsule(this.rowToContextCapsule(capsule), { ...input, serverNow: new Date() });
    if (!resolved.ok) return json({ error: resolved.code }, { status: 409 });

    const now = new Date().toISOString();
    const initial: ToolTaskCheckpoint = {
      taskId: input.taskId,
      status: "accepted",
      round: 0,
      callCount: 0,
      completedCallKeys: [],
      results: [],
    };
    this.sql`INSERT INTO delegated_tasks
      (id,idempotency_key,client_idempotency_key,owner_id,service_id,chat_id,root_task_id,parent_task_id,
       task_revision,pause_generation,status,input_json,checkpoint_json,repair_generation,created_at,updated_at)
      VALUES (${input.taskId},${scopedFiberKey},${input.idempotencyKey},${input.ownerId},${input.serviceId},${input.chatId},
        ${input.rootTaskId || input.taskId},${input.parentTaskId ?? null},1,0,'accepted',${JSON.stringify(input)},
        ${JSON.stringify(initial)},0,${now},${now})`;
    this.recordTaskProgress(input.taskId, "task.accepted", "任务已接收，正在准备执行", { phase: "accepted" });
    const receipt = await this.startDelegatedFiber(input, initial, scopedFiberKey);
    this.audit("task.accepted", `context-service:${binding.serviceId}`, input.taskId, {
      fiberId: receipt.fiberId,
      accepted: receipt.accepted,
    });
    return json({ taskId: input.taskId, status: "accepted", fiberId: receipt.fiberId, accepted: receipt.accepted }, { status: 202 });
  }

  private async startDelegatedFiber(input: DelegatedTaskInput, initial: ToolTaskCheckpoint, fiberKey: string) {
    const receipt = await this.startFiber(
      "delegated-tool-task",
      async (ctx) => {
        try {
          const checkpoint = await this.runDelegatedTask(input.taskId, initial, ctx.signal, (value) => ctx.stash(value));
          if (checkpoint.status === "failed") throw new Error(checkpoint.error ?? "task_failed");
        } catch (error) {
          const message = error instanceof Error ? error.message : "task_failed";
          const current = this.readTaskCheckpoint(input.taskId);
          if (!["failed", "cancelled", "attention_required", "paused"].includes(current.status)) this.failDelegatedTask(input.taskId, message);
          throw error;
        }
      },
      { idempotencyKey: fiberKey, metadata: { taskId: input.taskId, originalIdempotencyKey: input.idempotencyKey } },
    );
    this.sql`UPDATE delegated_tasks SET fiber_id = ${receipt.fiberId}, updated_at = ${new Date().toISOString()} WHERE id = ${input.taskId}`;
    return receipt;
  }

  private async continueTaskAfterActionOutcome(
    taskId: string,
    expected: { serverId: string; toolName: string; argsHash: string },
    outcome: ActionOutcome,
    reason: string,
    correlationId: string,
    actor: string,
  ): Promise<{ taskId: string; status: ToolTaskCheckpoint["status"]; fiberId?: string }> {
    const input = this.delegatedTaskInput(taskId);
    if (!input) throw new Error("invalid_persisted_task");
    const checkpoint = this.readTaskCheckpoint(taskId);
    const call = checkpoint.pendingCall;
    if (checkpoint.status !== "approval_required" || !call) throw new Error("task_not_waiting_for_action_outcome");
    const argsHash = await canonicalArgsHash(call.args);
    if (call.serverId !== expected.serverId || call.toolName !== expected.toolName || argsHash !== expected.argsHash) {
      throw new Error("action_outcome_task_call_changed");
    }
    const callKey = `${taskId}:${call.serverId}:${call.toolName}:${argsHash}`;
    const result = createActionOutcomeResult(call, outcome, boundedAgentErrorCode(reason, outcome));
    const next = applyActionOutcomeToCheckpoint(checkpoint, callKey, result, input.mode === "direct");
    this.persistTaskCheckpoint(next);
    this.audit("task.action_not_executed", actor, taskId, {
      outcome,
      reason: boundedAgentErrorCode(reason, outcome),
      serverId: call.serverId,
      toolName: call.toolName,
      argsHash,
      enforcement: true,
    });
    if (input.mode === "direct") return { taskId, status: next.status };
    try {
      const receipt = await this.startDelegatedFiber(input, next,
        `${this.scopedTaskFiberKey(input.ownerId, input.serviceId, input.idempotencyKey)}:action-outcome:${correlationId}`);
      return { taskId, status: next.status, fiberId: receipt.fiberId };
    } catch (error) {
      this.markTaskAttention(taskId, boundedAgentErrorCode(error, "action_outcome_resume_failed"));
      throw error;
    }
  }

  private async startRepairFiber(input: DelegatedTaskInput, checkpoint: ToolTaskCheckpoint) {
    const { generation, marker } = this.reserveRepairGeneration(input.taskId);
    try {
      const receipt = await this.startDelegatedFiber(input, checkpoint,
        repairFiberKey(this.scopedTaskFiberKey(input.ownerId, input.serviceId, input.idempotencyKey), input.taskId, generation));
      return { receipt, generation };
    } catch (error) {
      this.sql`UPDATE delegated_tasks SET fiber_id=NULL,updated_at=${new Date().toISOString()}
        WHERE id=${input.taskId} AND fiber_id=${marker}`;
      throw error;
    }
  }

  private async reconcileExistingTask(taskId: string, idempotencyKey: string): Promise<Response> {
    const row = this.sql<{ status: ToolTaskCheckpoint["status"]; fiber_id: string | null; input_json: string; repair_generation: number }>`
      SELECT status, fiber_id, input_json, repair_generation FROM delegated_tasks WHERE id = ${taskId}`[0];
    if (!row) return json({ error: "task_not_found" }, { status: 404 });
    if (row.fiber_id?.startsWith("repair-starting:")) {
      return json({ taskId, status: "interrupted", accepted: false, repairStarting: true }, { status: 202 });
    }
    const byKey = await this.inspectFiberByKey(idempotencyKey);
    const byStoredId = row.fiber_id ? await this.inspectFiber(row.fiber_id) : null;
    const fiber = byStoredId ?? byKey;
    const action = decideFiberAttachment(row.status, fiber?.status ?? null);
    if (action === "return_terminal") return this.getDelegatedTask(taskId);
    if (action === "attach" && fiber) {
      this.sql`UPDATE delegated_tasks SET fiber_id = ${fiber.fiberId}, updated_at = ${new Date().toISOString()} WHERE id = ${taskId}`;
      return json({ taskId, status: row.status, fiberId: fiber.fiberId, accepted: false });
    }
    if (action === "recover" && fiber) {
      try {
        const uncertain = this.markStartedSideEffectsUncertain(taskId, "fiber_reconciled");
        const current = this.readTaskCheckpoint(taskId);
        const recovered = normalizeRecoveredCheckpoint(current, uncertain);
        if (recovered.status === "attention_required") {
          this.persistTaskCheckpoint(recovered);
          return this.getDelegatedTask(taskId);
        }
        if (recovered.status !== current.status) this.persistTaskCheckpoint(recovered);
        const checkpoint = await this.runDelegatedTask(taskId, recovered);
        await this.resolveFiber(fiber.fiberId, { ...mapRecoveredCheckpoint(checkpoint), snapshot: checkpoint } as FiberRecoveryResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : "task_recovery_failed";
        const current = this.readTaskCheckpoint(taskId);
        if (!["cancelled", "attention_required", "paused"].includes(current.status)) this.failDelegatedTask(taskId, message, "interrupted");
      }
      return this.getDelegatedTask(taskId);
    }
    const input = this.parseJson<DelegatedTaskInput | null>(row.input_json, null);
    if (!input) return json({ error: "invalid_persisted_task" }, { status: 500 });
    const checkpoint = this.readTaskCheckpoint(taskId);
    if (row.status === "accepted" && !fiber) {
      const receipt = await this.startDelegatedFiber(input, checkpoint, idempotencyKey);
      return json({ taskId, status: row.status, fiberId: receipt.fiberId, accepted: receipt.accepted }, { status: 202 });
    }
    const { receipt, generation } = await this.startRepairFiber(input, checkpoint);
    return json({ taskId, status: row.status, fiberId: receipt.fiberId, accepted: receipt.accepted, generation }, { status: 202 });
  }

  private taskInScope(taskId: string, binding: { ownerId: string; serviceId: string }): boolean {
    return Boolean(this.sql<CountRow>`SELECT COUNT(*) AS count FROM delegated_tasks
      WHERE id=${taskId} AND owner_id=${binding.ownerId} AND service_id=${binding.serviceId}`[0]?.count);
  }

  private getDelegatedTask(taskId: string, binding?: { ownerId: string; serviceId: string }): Response {
    if (binding && !this.taskInScope(taskId, binding)) return json({ error: "task_not_found" }, { status: 404 });
    const row = this.sql<RuntimeRow>`SELECT id,status,checkpoint_json,fiber_id,repair_generation,progress_revision,progress_state,
      progress_phase,progress_json,progress_updated_at,owner_id,service_id,chat_id,root_task_id,parent_task_id,
      task_revision,pause_generation,outcome,receipt_id,created_at,updated_at
      FROM delegated_tasks WHERE id = ${taskId}`[0];
    if (!row) return json({ error: "task_not_found" }, { status: 404 });
    const sideEffects = this.sql<RuntimeRow>`SELECT call_key,status,logical_invocation_count,provider_attempt_count,last_attempt_at,created_at,updated_at
      FROM tool_side_effects WHERE task_id=${taskId} ORDER BY created_at`;
    const elicitations = this.sql<RuntimeRow>`SELECT id,provider_id,tool_name,mode,status,expires_at,created_at,decided_at,consumed_at
      FROM mcp_elicitation_tickets WHERE task_id=${taskId} ORDER BY created_at`;
    const resumeIntents = this.sql<RuntimeRow>`SELECT ticket_id,status,generation,fiber_id,error_code,created_at,updated_at
      FROM mcp_elicitation_resume_intents WHERE task_id=${taskId} ORDER BY created_at`;
    const browserExecutions = this.sql<RuntimeRow>`SELECT execution_id,mode,status,created_at,updated_at
      FROM browser_executions WHERE task_id=${taskId} ORDER BY created_at`;
    const browserActions = this.sql<RuntimeRow>`SELECT action_index,action_kind,logical_step_cost,mutating,state,attempt_count,started_at,completed_at,updated_at
      FROM browser_action_checkpoints WHERE task_id=${taskId} ORDER BY action_index`;
    return json({
      task: row,
      snapshot: this.taskProgressSnapshot(taskId),
      evidence: { sideEffects, elicitations, resumeIntents, browserExecutions, browserActions },
    });
  }

  private getTaskProgressEvents(taskId: string, afterRevision: number, binding?: { ownerId: string; serviceId: string }): Response {
    if (binding ? !this.taskInScope(taskId, binding)
      : !this.sql<CountRow>`SELECT COUNT(*) AS count FROM delegated_tasks WHERE id=${taskId}`[0]?.count) {
      return json({ error: "task_not_found" }, { status: 404 });
    }
    const after = Number.isSafeInteger(afterRevision) && afterRevision >= 0 ? afterRevision : 0;
    const events = this.sql<RuntimeRow>`SELECT task_id,revision,event_type,safe_summary,detail_json,created_at
      FROM task_progress_events WHERE task_id=${taskId} AND revision>${after} ORDER BY revision LIMIT 100`;
    return json({ taskId, snapshot: this.taskProgressSnapshot(taskId), events });
  }

  private async controlDelegatedTask(
    taskId: string,
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
  ): Promise<Response> {
    const row = this.sql<{ status: string; input_json: string }>`SELECT status,input_json FROM delegated_tasks
      WHERE id=${taskId} AND owner_id=${binding.ownerId} AND service_id=${binding.serviceId}`[0];
    if (!row) return json({ error: "task_not_found" }, { status: 404 });
    const input = this.parseJson<DelegatedTaskInput | null>(row.input_json, null);
    if (!input || input.ownerId !== binding.ownerId || input.serviceId !== binding.serviceId) return json({ error: "forbidden" }, { status: 403 });
    const actorOwnerId = typeof body.ownerId === "string" ? body.ownerId : "";
    const actorChatId = typeof body.chatId === "string" ? body.chatId : "";
    if (actorOwnerId !== binding.ownerId || actorOwnerId !== input.ownerId || actorChatId !== input.chatId) {
      return json({ error: "task_control_scope_mismatch" }, { status: 403 });
    }
    const action = String(body.action ?? "");
    if (action === "stop") return await this.cancelDelegatedTask(taskId, binding);
    if (["completed", "failed", "cancelled", "attention_required"].includes(row.status)) {
      return json({ error: "task_already_terminal", status: row.status }, { status: 409 });
    }
    const root = this.sql<{ root_task_id: string }>`SELECT root_task_id FROM delegated_tasks WHERE id=${taskId}`[0]?.root_task_id || taskId;
    const tree = this.sql<{ id: string; status: ToolTaskCheckpoint["status"]; fiber_id: string | null; idempotency_key: string }>`
      SELECT id,status,fiber_id,idempotency_key FROM delegated_tasks
      WHERE owner_id=${binding.ownerId} AND service_id=${binding.serviceId} AND root_task_id=${root}`;
    const lease = this.browserTaskLease(taskId);
    const now = new Date().toISOString();
    if (action === "pause") {
      const pausable = tree.filter((task) => ["accepted", "planning", "executing", "approval_required", "interrupted"].includes(task.status));
      if (pausable.length === 0) return json({ error: "task_tree_not_pausable" }, { status: 409 });
      const ids = new Set(pausable.map((task) => task.id));
      const placeholders = [...ids];
      for (const task of pausable) {
        this.sql`UPDATE delegated_tasks SET paused_from_status=${task.status},status='paused',pause_generation=pause_generation+1,
          task_revision=task_revision+1,checkpoint_json=json_set(COALESCE(checkpoint_json,'{}'),'$.status','paused'),updated_at=${now}
          WHERE id=${task.id} AND owner_id=${binding.ownerId} AND service_id=${binding.serviceId}
            AND status=${task.status}`;
        this.sql`UPDATE browser_task_leases SET state='paused',step_once=0,revision=revision+1,updated_at=${now}
          WHERE task_id=${task.id} AND state='active'`;
        const taskStartedSideEffects = this.sql<{ call_key: string }>`SELECT call_key FROM tool_side_effects
          WHERE task_id=${task.id} AND status='started'`;
        for (const sideEffect of taskStartedSideEffects) {
          try {
            const prior = loadReplayState(this.sql as unknown as SideEffectSql, sideEffect.call_key);
            if (prior?.status === "started" && prior?.dispatchState === "dispatched" && !prior?.providerCallCompleted) {
              quarantineInFlight(this.sql as unknown as SideEffectSql, { callKey: sideEffect.call_key, now });
            } else if (prior?.providerCallCompleted && prior?.responseJson) {
              quarantinePreservingReceipt(this.sql as unknown as SideEffectSql, { callKey: sideEffect.call_key, now });
            }
          } catch {
            // Leave the row in its current state; do not mask a quarantine failure.
          }
        }
        this.sql`UPDATE approval_ticket_calls SET status='cancelled',consumed_at=${now}
          WHERE task_id=${task.id} AND status IN ('pending','decision_reserved','consuming')`;
        this.sql`UPDATE approval_task_grants SET status='revoked',updated_at=${now}
          WHERE task_id=${task.id} AND status='active'`;
        this.activeToolCalls.abortTask(task.id);
        const fiber = task.fiber_id ? await this.inspectFiber(task.fiber_id) : await this.inspectFiberByKey(task.idempotency_key);
        if (fiber) await this.cancelFiber(fiber.fiberId, "task_tree_paused");
        this.recordTaskProgress(task.id, "task.paused", "当前任务树已暂停", { phase: "paused", rootTaskId: root });
      }
      this.audit("task.tree.paused", `context-service:${binding.serviceId}`, root, { taskIds: placeholders });
      return json({ taskId, rootTaskId: root, action, pausedTaskIds: placeholders,
        snapshot: this.taskProgressSnapshot(taskId) }, { status: 202 });
    } else if (action === "resume") {
      const paused = tree.filter((task) => task.status === "paused");
      if (paused.length === 0) return json({ error: "task_tree_not_paused" }, { status: 409 });
      const unsafe = Number(this.sql<CountRow>`SELECT COUNT(*) AS count FROM tool_side_effects s
        JOIN delegated_tasks t ON t.id=s.task_id
        WHERE t.owner_id=${binding.ownerId} AND t.service_id=${binding.serviceId} AND t.root_task_id=${root}
          AND (s.status IN ('started','uncertain','unknown')
            OR (s.status='quarantined' AND (s.provider_call_completed=0 OR s.response_json IS NULL)))`[0]?.count ?? 0);
      if (unsafe > 0) return json({ error: "task_resume_requires_attention", rootTaskId: root, unknownSideEffects: unsafe }, { status: 409 });
      const resumed: Array<{ taskId: string; fiberId?: string }> = [];
      for (const task of paused) {
        const checkpoint = this.readTaskCheckpoint(task.id);
        const inputForTask = this.delegatedTaskInput(task.id);
        if (!inputForTask) {
          this.markTaskAttention(task.id, "invalid_persisted_task");
          continue;
        }
        const next: ToolTaskCheckpoint = { ...checkpoint, status: "interrupted", error: "task_resumed_from_checkpoint" };
        this.sql`UPDATE delegated_tasks SET status='interrupted',paused_from_status=NULL,task_revision=task_revision+1,
          checkpoint_json=${JSON.stringify(next)},fiber_id=NULL,updated_at=${now}
          WHERE id=${task.id} AND status='paused'`;
        this.sql`UPDATE browser_task_leases SET state='active',step_once=0,revision=revision+1,updated_at=${now}
          WHERE task_id=${task.id} AND state='paused'`;
        try {
          const repair = await this.startRepairFiber(inputForTask, next);
          resumed.push({ taskId: task.id, fiberId: repair.receipt.fiberId });
          this.recordTaskProgress(task.id, "task.resumed", "当前任务已从安全检查点继续", { phase: "interrupted", rootTaskId: root });
        } catch (error) {
          this.markTaskAttention(task.id, boundedAgentErrorCode(error, "task_resume_failed"));
        }
      }
      this.audit("task.tree.resumed", `context-service:${binding.serviceId}`, root, { taskIds: resumed.map((item) => item.taskId) });
      return json({ taskId, rootTaskId: root, action, resumed, snapshot: this.taskProgressSnapshot(taskId) }, { status: 202 });
    } else if (action === "step") {
      if (!lease) return json({ error: "task_control_not_supported" }, { status: 409 });
      this.sql`UPDATE browser_task_leases SET state='active',step_once=1,revision=revision+1,updated_at=${now} WHERE id=${lease.id} AND state='paused'`;
      this.setTaskStatusOnly(taskId, "executing");
      this.recordTaskProgress(taskId, "task.step", "我会执行下一个动作后再次暂停", { phase: "browser" });
    } else if (action === "read_only") {
      if (!lease) return json({ error: "task_control_not_supported" }, { status: 409 });
      this.sql`UPDATE browser_task_leases SET mode='read',allowed_actions_json=${JSON.stringify(allowedActionsForMode("read"))},
        revision=revision+1,updated_at=${now} WHERE id=${lease.id} AND state IN ('active','paused')`;
      this.recordTaskProgress(taskId, "task.read_only", "浏览器任务已收紧为只读模式", { phase: "browser", mode: "read" });
    } else {
      return json({ error: "task_control_action_invalid" }, { status: 400 });
    }
    this.audit("task.control", `context-service:${binding.serviceId}`, taskId, { action, rootTaskId: root });
    return json({ taskId, action, snapshot: this.taskProgressSnapshot(taskId) }, { status: 202 });
  }

  private async cancelDelegatedTask(taskId: string, binding?: { ownerId: string; serviceId: string }): Promise<Response> {
    const row = binding
      ? this.sql<{ status: string; fiber_id: string | null; idempotency_key: string }>`SELECT status,fiber_id,idempotency_key
          FROM delegated_tasks WHERE id=${taskId} AND owner_id=${binding.ownerId} AND service_id=${binding.serviceId}`[0]
      : this.sql<{ status: string; fiber_id: string | null; idempotency_key: string }>`SELECT status,fiber_id,idempotency_key
          FROM delegated_tasks WHERE id=${taskId}`[0];
    if (!row) return json({ error: "task_not_found" }, { status: 404 });
    if (["completed", "failed", "cancelled"].includes(row.status)) return json({ error: "task_already_terminal", status: row.status }, { status: 409 });
    const taskInput = this.delegatedTaskInput(taskId);
    const checkpoint = this.readTaskCheckpoint(taskId);
    const now = new Date().toISOString();
    this.markStartedSideEffectsUncertain(taskId, "task_cancel_requested");
    const unknownCount = Number(this.sql<CountRow>`SELECT COUNT(*) AS count FROM tool_side_effects
      WHERE task_id=${taskId}
        AND (status IN ('started','uncertain','unknown')
          OR (status='quarantined' AND (provider_call_completed=0 OR response_json IS NULL)))`[0]?.count ?? 0);
    const completedCount = Number(this.sql<CountRow>`SELECT COUNT(*) AS count FROM tool_side_effects
      WHERE task_id=${taskId} AND status='completed'`[0]?.count ?? 0);
    const outcome = unknownCount > 0 ? "Unknown" : completedCount > 0 ? "Partial" : "CancelledBeforeExecution";
    const status: ToolTaskCheckpoint["status"] = outcome === "CancelledBeforeExecution" ? "cancelled" : "attention_required";
    const next = { ...checkpoint, status, pendingCall: undefined,
      error: outcome === "Unknown" ? "task_cancelled_external_outcome_unknown"
        : outcome === "Partial" ? "task_cancelled_after_partial_execution" : "task_cancelled" };
    this.sql`UPDATE delegated_tasks SET status=${status},outcome=${outcome},task_revision=task_revision+1,
      checkpoint_json=${JSON.stringify(next)},updated_at=${now} WHERE id=${taskId}`;
    const cancelledApprovals = this.sql<{ id: string }>`UPDATE approval_ticket_calls SET status = 'cancelled', consumed_at = ${now}
      WHERE task_id = ${taskId} AND status IN ('pending', 'decision_reserved', 'consuming') RETURNING id`;
    for (const ticket of cancelledApprovals) this.scrubApprovalPayload(ticket.id);
    this.sql`UPDATE browser_task_leases SET state='revoked',step_once=0,revision=revision+1,updated_at=${now}
      WHERE task_id=${taskId} AND state IN ('active','paused')`;
    this.sql`UPDATE approval_task_grants SET status='task_ended',updated_at=${now}
      WHERE (task_id=${taskId} OR think_task_id=${taskInput?.thinkTaskId ?? taskId}) AND status='active'`;
    await this.rejectInteractiveBrowserExecutionsForTask(taskId);
    await this.closeTypedBrowserTaskSession(taskId);
    this.activeToolCalls.abortTask(taskId);
    const fiber = row.fiber_id ? await this.inspectFiber(row.fiber_id) : await this.inspectFiberByKey(row.idempotency_key);
    if (fiber) await this.cancelFiber(fiber.fiberId, "service_cancelled");
    this.audit(outcome === "CancelledBeforeExecution" ? "task.cancelled" : "task.cancel.attention_required",
      binding ? `context-service:${binding.serviceId}` : "context-service", taskId,
      { outcome, unknownSideEffects: unknownCount, completedSideEffects: completedCount });
    this.recordTaskProgress(taskId,
      outcome === "CancelledBeforeExecution" ? "task.cancelled" : "task.cancel.attention_required",
      outcome === "Unknown" ? "任务已停止继续执行，但已有外部调用的结果需要检查"
        : outcome === "Partial" ? "任务已停止继续执行；部分步骤已经完成" : "任务已在执行前取消",
      { phase: status, outcome, unknownSideEffects: unknownCount, completedSideEffects: completedCount });
    return json({ taskId, status, outcome, unknownSideEffects: unknownCount, completedSideEffects: completedCount });
  }

  private async runDelegatedTask(
    taskId: string,
    recovered?: ToolTaskCheckpoint | null,
    signal = new AbortController().signal,
    stash: (value: ToolTaskCheckpoint) => void = () => {},
  ): Promise<ToolTaskCheckpoint> {
    const row = this.sql<{ input_json: string; status: string }>`SELECT input_json, status FROM delegated_tasks WHERE id = ${taskId}`[0];
    if (!row) throw new Error("task_not_found");
    if (row.status === "cancelled") return { ...this.readTaskCheckpoint(taskId), status: "cancelled" };
    const input = this.parseJson<DelegatedTaskInput | null>(row.input_json, null);
    if (!input) throw new Error("invalid_persisted_task");
    if (input.mode !== "direct") {
      await this.dispatchHooks("before_plan", input, { taskId, purpose: input.purpose, instructionBytes: new TextEncoder().encode(input.instruction).byteLength });
    }
    const { catalog, observedCatalog: trustedObservedTools, allowlists } = this.loadExecutableCatalog();
    // Direct tasks never need the planner. Keeping this branch independent of
    // the AI binding lets the isolated canary prove the no-model path without
    // attaching a model-capable binding to the staging Worker.
    const aiRun = input.mode === "direct"
      ? async () => { throw new Error("planner_disabled_for_direct_task"); }
      : this.env.AI.run.bind(this.env.AI) as unknown as (model: string, request: Record<string, unknown>) => Promise<unknown>;
    const plannerReservations: string[] = [];
    const checkpoint = await executeToolTask(taskId, {
      ai: {
        run: async (model, request) => {
          plannerReservations.push(this.reservePlannerCall(input, model));
          return await aiRun(model, request);
        },
      },
      instruction: input.instruction,
      capsuleId: input.capsuleId,
      catalog,
      plannerCatalog: catalog.filter((entry) => !(entry.serverId === BROWSER_PROVIDER_SERVER_ID && entry.toolName === "browser_resume")),
      observedCatalog: trustedObservedTools,
      allowlists,
      evaluatePolicy: (call) => this.evaluateTaskToolPolicy(call, taskId),
      signal,
      isCancelled: () => this.isTaskCancelled(taskId),
      invoke: (call, callKey, taskSignal) => this.invokeMcpTool(call, callKey, taskId, taskSignal),
      directCall: input.mode === "direct" ? input.directCall : undefined,
      plannerModel: this.plannerModel(),
      onPlannerTelemetry: (telemetry) => this.recordPlannerTelemetry(input, telemetry, plannerReservations.shift()),
      checkpoint: (value) => {
        this.persistTaskCheckpoint(value);
        stash(value);
      },
    }, recovered ?? this.readTaskCheckpoint(taskId));
    return checkpoint;
  }

  private plannerModel(): string {
    const configured = this.env.TOOL_PLANNER_MODEL?.trim();
    return configured || GLM_TOOL_MODEL;
  }

  private plannerDailyBudget(): number {
    const configured = Number(this.env.TOOL_PLANNER_DAILY_BUDGET);
    return Number.isSafeInteger(configured) && configured >= 1 && configured <= 1_000
      ? configured
      : DEFAULT_TOOL_PLANNER_DAILY_BUDGET;
  }

  private plannerUsageToday(): { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number } {
    const row = this.sql<{ calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number }>`
      SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens
      FROM planner_usage_log WHERE created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')`[0];
    return {
      calls: Number(row?.calls ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
    };
  }

  private assertPlannerBudget(): void {
    if (this.plannerUsageToday().calls >= this.plannerDailyBudget()) throw new Error("planner_daily_budget_exhausted");
  }

  private reservePlannerCall(input: DelegatedTaskInput, model: string): string {
    this.assertPlannerBudget();
    const id = crypto.randomUUID();
    this.sql`INSERT INTO planner_usage_log (id,task_id,owner_id,service_id,chat_id,model,input_tokens,output_tokens,
      reasoning_tokens,cache_read_tokens,service_tier,finish_reason,total_ms,success,error_code,created_at)
      VALUES (${id},${input.taskId},${input.ownerId},${input.serviceId},${input.chatId},${model},0,0,0,0,NULL,NULL,0,0,'reserved',${new Date().toISOString()})`;
    return id;
  }

  private recordPlannerTelemetry(input: DelegatedTaskInput, telemetry: ToolPlannerTelemetry, reservationId?: string): void {
    if (reservationId) {
      this.sql`UPDATE planner_usage_log SET model=${telemetry.model},input_tokens=${telemetry.inputTokens},
        output_tokens=${telemetry.outputTokens},reasoning_tokens=${telemetry.reasoningTokens},cache_read_tokens=${telemetry.cacheReadTokens},
        service_tier=${telemetry.serviceTier},finish_reason=${telemetry.finishReason},
        total_ms=${telemetry.totalMs},success=${telemetry.success ? 1 : 0},error_code=${telemetry.errorCode}
        WHERE id=${reservationId}`;
      return;
    }
    this.sql`INSERT INTO planner_usage_log (id,task_id,owner_id,service_id,chat_id,model,input_tokens,output_tokens,
      reasoning_tokens,cache_read_tokens,service_tier,finish_reason,total_ms,success,error_code,created_at)
      VALUES (${crypto.randomUUID()},${input.taskId},${input.ownerId},${input.serviceId},${input.chatId},${telemetry.model},
      ${telemetry.inputTokens},${telemetry.outputTokens},${telemetry.reasoningTokens},${telemetry.cacheReadTokens},${telemetry.serviceTier},${telemetry.finishReason},
      ${telemetry.totalMs},${telemetry.success ? 1 : 0},${telemetry.errorCode},${new Date().toISOString()})`;
  }

  private loadExecutableCatalog(): {
    catalog: ToolCatalogEntry[];
    observedCatalog: ToolCatalogEntry[];
    allowlists: Map<string, string[]>;
  } {
    const rows = this.sql<{ id: string; tool_catalog_json: string; observed_tool_catalog_json: string; tool_allowlist_json: string }>`
      SELECT id, tool_catalog_json, observed_tool_catalog_json, tool_allowlist_json FROM mcp_registry
      WHERE enabled = 1`;
    const catalog: ToolCatalogEntry[] = [];
    const observedCatalog: ToolCatalogEntry[] = [];
    const allowlists = new Map<string, string[]>();
    const configuredAllowlist = normalizeToolAllowlist(
      [
        `${OBSERVER_MCP_SERVER_ID}/system_status`,
        `${HTML_ARTIFACT_PROVIDER_SERVER_ID}/create`,
        `${HEALTH_PROVIDER_SERVER_ID}/health_summary`,
        `${HEALTH_PROVIDER_SERVER_ID}/health_trends`,
        `${CALENDAR_PROVIDER_SERVER_ID}/calendar_summary`,
        `${CALENDAR_PROVIDER_SERVER_ID}/calendar_upcoming`,
        `${APPROVAL_PROBE_PROVIDER_SERVER_ID}/${THINK_APPROVAL_PROBE_TOOL_NAME}`,
        `${SANDBOX_RUNTIME_PROVIDER_SERVER_ID}/execute_script`,
        `${SANDBOX_CODEMODE_PROVIDER_SERVER_ID}/execute_read_plan`,
        `${SOURCE_CODE_PROVIDER_SERVER_ID}/list`,
        `${SOURCE_CODE_PROVIDER_SERVER_ID}/search`,
        `${SOURCE_CODE_PROVIDER_SERVER_ID}/read`,
        `${SOURCE_CODE_PROVIDER_SERVER_ID}/inspect`,
        `${GROK_PROVIDER_SERVER_ID}/search_web`,
        `${GROK_PROVIDER_SERVER_ID}/generate_image`,
        `${VOICE_PROVIDER_SERVER_ID}/speak`,
        `${HOME_ASSISTANT_PROVIDER_SERVER_ID}/call_service`,
        `${BROWSER_PROVIDER_SERVER_ID}/browser_markdown`,
        `${BROWSER_PROVIDER_SERVER_ID}/browser_links`,
        `${BROWSER_PROVIDER_SERVER_ID}/browser_scrape`,
        `${BROWSER_PROVIDER_SERVER_ID}/browser_extract`,
        `${BROWSER_PROVIDER_SERVER_ID}/site_adapter_read`,
        `${BROWSER_PROVIDER_SERVER_ID}/browser_task`,
        `${BROWSER_PROVIDER_SERVER_ID}/browser_execute`,
        `${BROWSER_PROVIDER_SERVER_ID}/browser_resume`,
        ...(this.env.AGENT_DELEGATED_TOOL_ALLOWLIST ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      ],
    );
    const executableServerIds = new Set(EXECUTABLE_PROVIDER_SERVER_IDS);
    for (const key of configuredAllowlist) {
      const separator = key.indexOf("/");
      if (separator > 0) executableServerIds.add(key.slice(0, separator));
    }
    for (const row of rows) {
      if (!AGENT_OWNED_MCP_SERVER_IDS.has(row.id)) continue;
      const storedRaw = this.parseJson<unknown>(row.tool_catalog_json, null);
      const observedRaw = this.parseJson<unknown>(row.observed_tool_catalog_json, null);
      if (toolCatalogNeedsRefresh(storedRaw) || toolCatalogNeedsRefresh(observedRaw)) continue;
      catalog.push(...filterExplicitToolAllowlist(parseToolCatalog(storedRaw), configuredAllowlist, executableServerIds, FORBIDDEN_DELEGATED_SERVER_IDS));
      observedCatalog.push(...filterExplicitToolAllowlist(parseToolCatalog(observedRaw), configuredAllowlist, executableServerIds, FORBIDDEN_DELEGATED_SERVER_IDS));
      allowlists.set(row.id, configuredAllowlist
        .filter((key) => key.startsWith(`${row.id}/`))
        .map((key) => key.slice(row.id.length + 1)));
    }
    const gatewayRows = this.sql<{ provider_id: string; catalog_json: string }>`
      SELECT provider_id,catalog_json FROM mcp_gateway_execution_projection
      WHERE status='connected' AND julianday(observed_at) >= julianday('now','-1 hour')`;
    for (const row of gatewayRows) {
      const projected = parseToolCatalog(this.parseJson(row.catalog_json, []));
      // Gateway owner enablement is the canonical allowlist for Gateway-owned MCP tools.
      // Agent still applies risk policy, approval, idempotency and result sanitization at execution time.
      catalog.push(...projected);
      observedCatalog.push(...projected);
      allowlists.set(row.provider_id, projected.map((tool) => tool.toolName));
    }
    if (catalog.length === 0) throw new Error("empty_tool_catalog");
    return { catalog, observedCatalog, allowlists };
  }

  private async invokeMcpTool(call: { serverId: string; toolName: string; args: unknown }, callKey: string, taskId: string, signal: AbortSignal): Promise<unknown> {
    const hookInput = this.delegatedTaskInput(taskId);
    if (!hookInput) throw new Error("task_scope_missing");
    const pauseSafeRead = this.isGlobalPauseSafeRead(call);
    const controlBefore = this.sandboxControlSnapshot();
    if (controlBefore.paused && !pauseSafeRead) throw new Error("sandbox_global_pause_active");
    const priorState = loadReplayState(this.sql as unknown as SideEffectSql, callKey);
    const priorReceipt = priorState?.responseJson
      ? decodeProviderResultReceipt(this.parseJson(priorState.responseJson, null))
      : null;
    const replayAction = sideEffectReplayDecision({
      status: priorState?.status ?? null,
      providerCallCompleted: priorState?.providerCallCompleted ?? false,
      dispatchState: priorState?.dispatchState ?? null,
      hasReceipt: priorReceipt !== null,
    });
    if (replayAction === "reuse") {
      if (priorReceipt) return receiptToTaskResult(priorReceipt);
      // Provider call was recorded as completed, but the serialized result is missing.
      // We cannot safely re-invoke a mutating provider, so require operator attention.
      this.markTaskAttention(taskId, "uncertain_tool_side_effect");
      throw new Error("uncertain_tool_side_effect");
    }
    if (replayAction === "attention_required") {
      if (call.serverId === BROWSER_PROVIDER_SERVER_ID && call.toolName === "browser_resume") {
        const recovered = this.recoverCompletedBrowserResume(call);
        if (recovered.ok) {
          const receipt = encodeProviderResultReceipt({ resultStatus: "serializable", value: recovered.value });
          persistTerminalReceipt(this.sql as unknown as SideEffectSql, { callKey, receipt });
          return recovered.value;
        }
      }
      this.markTaskAttention(taskId, "uncertain_tool_side_effect");
      throw new Error("uncertain_tool_side_effect");
    }
    await this.dispatchHooks("before_tool", hookInput, { taskId, tool: { serverId: call.serverId, name: call.toolName }, args: call.args });
    const cached = await this.readToolResultCache(call, taskId);
    if (cached.hit) {
      await this.dispatchHooks("after_tool", hookInput, { taskId, tool: { serverId: call.serverId, name: call.toolName }, status: "cache_hit" }, false);
      return cached.value;
    }
    const now = new Date().toISOString();
    if (!priorState) {
      const contract = lookupProviderReplayContract(callKey);
      reserveLogicalInvocation(this.sql as unknown as SideEffectSql, { callKey, taskId, contract, now });
      const { claimed } = claimProviderAttempt(this.sql as unknown as SideEffectSql, { callKey, now });
      if (!claimed) {
        this.markTaskAttention(taskId, "concurrent_tool_invocation_denied");
        throw new Error("concurrent_tool_invocation_denied");
      }
    } else if (priorState.status === "reserved" || priorState.status === "retry_authorized") {
      const { claimed } = claimProviderAttempt(this.sql as unknown as SideEffectSql, { callKey, now });
      if (!claimed) {
        this.markTaskAttention(taskId, "concurrent_tool_invocation_denied");
        throw new Error("concurrent_tool_invocation_denied");
      }
    } else {
      this.markTaskAttention(taskId, "side_effect_not_invokable");
      throw new Error("side_effect_not_invokable");
    }
    const activeCall = this.activeToolCalls.register(taskId, signal);
    try {
      if (this.isTaskCancelled(taskId)) throw new DOMException("Task cancelled", "AbortError");
      const parsed = call.serverId === OBSERVER_MCP_SERVER_ID
        ? await this.invokeObserver(call, callKey, activeCall.signal)
        : EXECUTABLE_PROVIDER_SERVER_IDS.has(call.serverId)
          ? await this.invokeDirectProvider(call, activeCall.signal, taskId)
          : await this.invokeRemoteMcp(call, activeCall.signal, taskId, callKey);
      const deferred = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && (parsed as Record<string, unknown>).kind === "deferred_tool_approval";
      if (deferred && this.pendingMcpElicitation(taskId, callKey)) {
        markDeferred(this.sql as unknown as SideEffectSql, { callKey, now: new Date().toISOString() });
        await this.dispatchHooks("after_tool", hookInput, {
          taskId, tool: { serverId: call.serverId, name: call.toolName }, status: "awaiting_input",
        }, false);
        return parsed;
      }
      // Terminal Provider result: persist the durable receipt *before* any post-call gate
      // (pause, generation change, cancellation, quarantine, projection, hooks, cache).
      const classification = classifyProviderResult(parsed);
      const receipt = encodeProviderResultReceipt(classification.receiptInput);
      persistTerminalReceipt(this.sql as unknown as SideEffectSql, { callKey, receipt, now: new Date().toISOString() });
      const controlAfter = this.sandboxControlSnapshot();
      if ((!pauseSafeRead && controlAfter.paused) || controlAfter.generation !== controlBefore.generation) {
        quarantinePreservingReceipt(this.sql as unknown as SideEffectSql, { callKey, now: new Date().toISOString() });
        this.audit("sandbox.result.quarantined", "agent-runtime", taskId, {
          serverId: call.serverId, toolName: call.toolName,
          generationBefore: controlBefore.generation, generationAfter: controlAfter.generation,
        });
        throw new Error("sandbox_global_pause_changed");
      }
      assertTaskResultActive(this.isTaskCancelled(taskId), activeCall.signal);
      if (call.serverId === BROWSER_PROVIDER_SERVER_ID) this.consumeOnceBrowserDomainGrants(call, taskId);
      if (receipt.resultStatus === "serializable") {
        await this.writeToolResultCache(call, taskId, receipt.value);
      }
      await this.dispatchHooks("after_tool", hookInput, {
        taskId, tool: { serverId: call.serverId, name: call.toolName }, status: "completed",
      }, false).catch((error) => {
        console.warn("after_tool_hook_projection_degraded", { code: boundedAgentErrorCode(error, "after_tool_hook_failed") });
      });
      return receiptToTaskResult(receipt);
    } catch (error) {
      const code = boundedAgentErrorCode(error, "uncertain_tool_side_effect");
      const currentState = loadReplayState(this.sql as unknown as SideEffectSql, callKey);
      const quarantined = currentState?.status === "quarantined";
      const globallyPaused = this.sandboxControlSnapshot().paused;
      if (quarantined || globallyPaused) {
        await this.dispatchHooks("on_error", hookInput, {
          taskId, tool: { serverId: call.serverId, name: call.toolName }, code: quarantined ? "sandbox_result_quarantined" : "sandbox_global_pause_active",
        }, false);
        throw error;
      }
      const definitive = this.isDefinitiveToolFailure(code);
      if (definitive) {
        markDefinitiveFailure(this.sql as unknown as SideEffectSql, { callKey, code, now: new Date().toISOString() });
      } else {
        markOutcomeUnknown(this.sql as unknown as SideEffectSql, { callKey, now: new Date().toISOString() });
        this.markTaskAttention(taskId, code);
      }
      await this.dispatchHooks("on_error", hookInput, {
        taskId, tool: { serverId: call.serverId, name: call.toolName }, code,
      }, false);
      throw error;
    } finally {
      activeCall.release();
    }
  }

  private isGlobalPauseSafeRead(call: { serverId: string; toolName: string }): boolean {
    return (call.serverId === OBSERVER_MCP_SERVER_ID && call.toolName === "system_status")
      || (call.serverId === SOURCE_CODE_PROVIDER_SERVER_ID && ["list", "search", "read", "inspect"].includes(call.toolName))
      || (call.serverId === APPROVAL_PROBE_PROVIDER_SERVER_ID && call.toolName === THINK_APPROVAL_PROBE_TOOL_NAME);
  }

  private async readToolResultCache(
    call: { serverId: string; toolName: string; args: unknown },
    taskId: string,
  ): Promise<{ hit: true; value: unknown } | { hit: false }> {
    const context = await this.toolCacheContext(call, taskId);
    if (!context || context.ttlMs <= 0) return { hit: false };
    const key = await createToolResultCacheKey(context.keyInput);
    const row = this.sql<ToolCacheRow>`SELECT cache_key,scope_hash,request_hash,provider_hash,tool_hash,schema_hash,
      schema_version,result_json,created_at,expires_at FROM tool_result_cache WHERE cache_key=${key}`[0];
    const record: ToolResultCacheRecord | null = row ? {
      cacheKey: row.cache_key, scopeHash: row.scope_hash, requestHash: row.request_hash,
      providerHash: row.provider_hash, toolHash: row.tool_hash, schemaHash: row.schema_hash,
      schemaVersion: row.schema_version, resultJson: row.result_json, createdAt: row.created_at, expiresAt: row.expires_at,
    } : null;
    const resolved = await resolveToolResultCacheRecord(record, { ...context.keyInput, serverNow: new Date() });
    if (resolved.status === "hit") {
      const now = Date.now();
      this.sql`UPDATE tool_result_cache SET hit_count=hit_count+1,last_hit_at=${now} WHERE cache_key=${key}`;
      this.audit("tool.cache.hit", `context-service:${context.input.serviceId}`, `${call.serverId}/${call.toolName}`, { taskId });
      return { hit: true, value: resolved.value };
    }
    if (resolved.status === "stale") this.sql`DELETE FROM tool_result_cache WHERE cache_key=${key}`;
    return { hit: false };
  }

  private async writeToolResultCache(
    call: { serverId: string; toolName: string; args: unknown },
    taskId: string,
    value: unknown,
  ): Promise<void> {
    const context = await this.toolCacheContext(call, taskId);
    if (!context || context.ttlMs <= 0) return;
    try {
      const record = await createToolResultCacheRecord({
        ...context.keyInput,
        riskLevel: context.tool.riskLevel,
        cacheable: true,
        success: true,
        ttlMs: context.ttlMs,
        result: value,
        serverNow: new Date(),
      });
      if (!record) return;
      this.sql`INSERT INTO tool_result_cache (cache_key,scope_hash,owner_id,service_id,chat_id,task_id,purpose,request_hash,
        provider_hash,tool_hash,schema_hash,schema_version,result_json,created_at,expires_at)
        VALUES (${record.cacheKey},${record.scopeHash},${context.input.ownerId},${context.input.serviceId},${context.input.chatId},
          ${taskId},${context.input.purpose},${record.requestHash},${record.providerHash},${record.toolHash},${record.schemaHash},
          ${record.schemaVersion},${record.resultJson},${record.createdAt},${record.expiresAt})
        ON CONFLICT(cache_key) DO UPDATE SET result_json=${record.resultJson},created_at=${record.createdAt},expires_at=${record.expiresAt}`;
      this.audit("tool.cache.write", `context-service:${context.input.serviceId}`, `${call.serverId}/${call.toolName}`, { taskId, ttlMs: context.ttlMs });
    } catch (error) {
      this.audit("tool.cache.bypass", `context-service:${context.input.serviceId}`, `${call.serverId}/${call.toolName}`, {
        taskId, code: error instanceof Error ? error.message : "cache_write_failed",
      });
    }
  }

  private async toolCacheContext(call: { serverId: string; toolName: string; args: unknown }, taskId: string): Promise<{
    input: DelegatedTaskInput; tool: ToolCatalogEntry; ttlMs: number; keyInput: ToolResultCacheKeyInput;
  } | null> {
    const task = this.sql<{ input_json: string }>`SELECT input_json FROM delegated_tasks WHERE id=${taskId}`[0];
    const input = task ? this.parseJson<DelegatedTaskInput | null>(task.input_json, null) : null;
    const registry = this.sql<{ tool_catalog_json: string }>`SELECT tool_catalog_json FROM mcp_registry WHERE id=${call.serverId} AND enabled=1`[0];
    if (!input || !registry) return null;
    const tool = parseToolCatalog(this.parseJson(registry.tool_catalog_json, [])).find((entry) => entry.toolName === call.toolName && entry.enabled);
    if (!tool || tool.riskLevel !== "read") return null;
    const ttlMs = this.toolCacheTtlMs(call.serverId, call.toolName);
    if (ttlMs <= 0) return null;
    const hashes = await hashToolResultCacheSource({
      provider: { serverId: call.serverId },
      tool: { serverId: call.serverId, toolName: call.toolName },
      schema: tool.inputSchema,
    });
    const argsHash = await canonicalArgsHash(call.args);
    return {
      input,
      tool,
      ttlMs,
      keyInput: {
        schemaVersion: TOOL_RESULT_CACHE_SCHEMA_VERSION,
        ownerId: input.ownerId,
        serviceId: input.serviceId,
        chatId: input.chatId,
        taskId: input.taskId,
        purpose: input.purpose,
        requestHash: argsHash,
        ...hashes,
      },
    };
  }

  private toolCacheTtlMs(serverId: string, toolName: string): number {
    if (serverId === OBSERVER_MCP_SERVER_ID && toolName === "system_status") return 15_000;
    if (serverId === BROWSER_PROVIDER_SERVER_ID && ["browser_markdown", "browser_links", "browser_scrape", "browser_extract", "site_adapter_read"].includes(toolName)) return 5 * 60_000;
    if (serverId === GROK_PROVIDER_SERVER_ID && toolName === "search_web") return 2 * 60_000;
    if (serverId === HEALTH_PROVIDER_SERVER_ID && ["health_summary", "health_trends"].includes(toolName)) return 5 * 60_000;
    if (serverId === CALENDAR_PROVIDER_SERVER_ID && ["calendar_summary", "calendar_upcoming"].includes(toolName)) return 60_000;
    if (!EXECUTABLE_PROVIDER_SERVER_IDS.has(serverId) && !FORBIDDEN_DELEGATED_SERVER_IDS.has(serverId)) return 5 * 60_000;
    return 0;
  }

  private remoteMcpRegistry(serverId: string): { url: string; auth_reference: string | null } {
    if (!AGENT_OWNED_MCP_SERVER_IDS.has(serverId)) throw new Error("remote_mcp_execution_not_cut_over");
    if (!serverId || FORBIDDEN_DELEGATED_SERVER_IDS.has(serverId) || EXECUTABLE_PROVIDER_SERVER_IDS.has(serverId)) {
      throw new Error("remote_mcp_server_forbidden");
    }
    const row = this.sql<{ url: string; auth_reference: string | null }>`SELECT url,auth_reference FROM mcp_registry
      WHERE id=${serverId} AND enabled=1`[0];
    if (!row) throw new Error("remote_mcp_not_available");
    return row;
  }

  private remoteMcpBearer(reference: string | null): string | undefined {
    if (!reference) return undefined;
    if (!/^AGENT_REMOTE_MCP_[A-Z0-9_]{1,80}$/.test(reference)) throw new Error("remote_mcp_auth_reference_forbidden");
    const value = (this.env as unknown as Record<string, unknown>)[reference];
    if (typeof value !== "string" || !value.trim()) throw new Error("remote_mcp_auth_misconfigured");
    return value.trim();
  }

  private async invokeRemoteMcp(
    call: { serverId: string; toolName: string; args: unknown },
    signal: AbortSignal,
    taskId: string,
    callKey: string,
  ): Promise<unknown> {
    if (signal.aborted) throw new DOMException("Task cancelled", "AbortError");
    const gateway = this.sql<{ owner_version: string }>`SELECT owner_version FROM mcp_gateway_execution_projection
      WHERE provider_id=${call.serverId} AND status='connected'
      AND julianday(observed_at) >= julianday('now','-1 hour')`[0];
    if (gateway) {
      const provider = this.currentMcpGatewayOwnerSnapshot()?.providers.find((entry) => entry.id === call.serverId);
      if (provider?.kind === "custom") {
        const bearer = this.env.MCP_GATEWAY_EXECUTOR_BEARER?.trim();
        if (!bearer) throw new Error("mcp_gateway_executor_auth_misconfigured");
        let result: unknown;
        try {
          result = await callStandardMcpTool({
            gateway: this.env.MCP_GATEWAY,
            executorBearer: bearer,
            providerId: call.serverId,
            toolName: call.toolName,
            args: call.args as Record<string, unknown>,
            callKey,
            signal,
            onElicitation: async (params) => this.handleMcpElicitation(taskId, callKey, call, params),
          });
        } catch (error) {
          if (!this.pendingMcpElicitation(taskId, callKey)) throw error;
          result = null;
        }
        if (this.pendingMcpElicitation(taskId, callKey)) {
          return {
            kind: "deferred_tool_approval",
            pendingCall: { ...call, args: call.args as JsonValue },
          } satisfies DeferredToolApproval;
        }
        this.consumeMcpElicitationDecision(taskId, callKey);
        return result;
      }
      const payload = await this.invokeMcpGatewayRpc(call.serverId, "tools/call", {
        name: call.toolName,
        arguments: call.args,
      }, `call:${gateway.owner_version}:${crypto.randomUUID()}`, signal);
      if (signal.aborted) throw new DOMException("Task cancelled", "AbortError");
      return parseMcpToolResult(payload);
    }
    if (!AGENT_OWNED_MCP_SERVER_IDS.has(call.serverId)) throw new Error("remote_mcp_execution_not_cut_over");
    const registry = this.remoteMcpRegistry(call.serverId);
    const client = createRemoteMcpClient({ endpoint: registry.url, bearerToken: this.remoteMcpBearer(registry.auth_reference) });
    const payload = await client.callTool(call.toolName, call.args as Record<string, unknown>);
    if (signal.aborted) throw new DOMException("Task cancelled", "AbortError");
    return parseMcpToolResult(payload);
  }

  private async handleMcpElicitation(
    taskId: string,
    callKey: string,
    call: { serverId: string; toolName: string; args: unknown },
    params: unknown,
  ): Promise<{ action: McpElicitationAction; content?: Record<string, string | number | boolean | string[]> }> {
    if (this.gatewayMcpToolRiskLevel(call.serverId, call.toolName) !== "read") {
      throw new Error("mcp_elicitation_read_only_required");
    }
    const normalized = await normalizeMcpElicitation(params);
    const existing = this.sql<McpElicitationTicketRow>`SELECT * FROM mcp_elicitation_tickets
      WHERE task_id=${taskId} AND call_key=${callKey} AND request_hash=${normalized.requestHash}`[0];
    if (existing && mcpElicitationExpired(existing.expires_at)) {
      this.expireMcpElicitationTicket(existing);
      return { action: "cancel" };
    }
    if (existing?.status === "decision_ready" && existing.decision_json) {
      return this.parseJson(existing.decision_json, { action: "cancel" });
    }
    if (existing) return { action: "cancel" };
    const input = this.delegatedTaskInput(taskId);
    if (!input) throw new Error("mcp_elicitation_task_scope_missing");
    const id = newMcpElicitationTicketId();
    const now = new Date();
    this.sql`INSERT INTO mcp_elicitation_tickets
      (id,task_id,call_key,owner_id,service_id,chat_id,provider_id,tool_name,mode,request_hash,request_json,status,expires_at,created_at)
      VALUES (${id},${taskId},${callKey},${input.ownerId},${input.serviceId},${input.chatId},${call.serverId},${call.toolName},
        ${normalized.request.mode},${normalized.requestHash},${JSON.stringify(normalized.request)},'pending',
        ${new Date(now.getTime() + MCP_ELICITATION_TTL_MS).toISOString()},${now.toISOString()})`;
    this.audit("mcp.elicitation.requested", `provider:${call.serverId}`, id, {
      taskId, providerId: call.serverId, toolName: call.toolName, mode: normalized.request.mode,
    });
    return { action: "cancel" };
  }

  private pendingMcpElicitation(taskId: string, callKey?: string): McpElicitationTicketRow | null {
    const now = new Date().toISOString();
    this.expireMcpElicitations(now);
    const rows = callKey
      ? this.sql<McpElicitationTicketRow>`SELECT * FROM mcp_elicitation_tickets
          WHERE task_id=${taskId} AND call_key=${callKey} AND status='pending' AND expires_at>${now} ORDER BY created_at DESC LIMIT 1`
      : this.sql<McpElicitationTicketRow>`SELECT * FROM mcp_elicitation_tickets
          WHERE task_id=${taskId} AND status='pending' AND expires_at>${now} ORDER BY created_at DESC LIMIT 1`;
    return rows[0] ?? null;
  }

  private consumeMcpElicitationDecision(taskId: string, callKey: string): void {
    const now = new Date().toISOString();
    this.sql`UPDATE mcp_elicitation_tickets SET
      status=CASE json_extract(decision_json,'$.action')
        WHEN 'accept' THEN 'accepted' WHEN 'decline' THEN 'declined' WHEN 'cancel' THEN 'cancelled'
        ELSE 'attention_required' END,
      consumed_at=${now}
      WHERE task_id=${taskId} AND call_key=${callKey} AND status='decision_ready'`;
  }

  private mcpElicitationPresentation(ticket: McpElicitationTicketRow): Record<string, unknown> {
    const request = this.parseJson<McpElicitationRequest>(ticket.request_json, { mode: ticket.mode, message: "MCP requests input." });
    const origin = request.mode === "url" && request.url ? new URL(request.url).origin : undefined;
    return {
      kind: "mcp_elicitation",
      ticketId: ticket.id,
      status: ticket.status,
      expiresAt: ticket.expires_at,
      summary: origin ? `${request.message}\n目标：${origin}` : request.message,
      elicitation: {
        mode: request.mode,
        openUrl: `https://agent.example.com/tools/mcp#elicitation=${ticket.id}`,
        providerId: ticket.provider_id,
        toolName: ticket.tool_name,
        origin,
      },
      callbacks: {
        accept: encodeMcpElicitationCallback("accept", ticket.id),
        decline: encodeMcpElicitationCallback("decline", ticket.id),
        cancel: encodeMcpElicitationCallback("cancel", ticket.id),
      },
    };
  }

  private listMcpElicitations(): Record<string, unknown>[] {
    const now = new Date().toISOString();
    this.expireMcpElicitations(now);
    const historyCutoff = new Date(Date.now() - MCP_ELICITATION_HISTORY_MS).toISOString();
    return this.sql<McpElicitationTicketRow>`SELECT * FROM mcp_elicitation_tickets
      WHERE created_at>=${historyCutoff} ORDER BY created_at DESC LIMIT 100`.map((ticket) => {
        const request = this.parseJson<McpElicitationRequest>(ticket.request_json, { mode: ticket.mode, message: "MCP requests input." });
        const actionable = ["pending", "decision_ready"].includes(ticket.status) && !mcpElicitationExpired(ticket.expires_at);
        return {
          id: ticket.id,
          taskId: ticket.task_id,
          providerId: ticket.provider_id,
          toolName: ticket.tool_name,
          mode: ticket.mode,
          message: request.mode === "url" && request.url
            ? `${request.message} · ${new URL(request.url).origin}`
            : request.message,
          requestedSchema: request.mode === "form" ? request.requestedSchema : undefined,
          url: request.mode === "url" ? request.url : undefined,
          origin: request.mode === "url" && request.url ? new URL(request.url).origin : undefined,
          status: ticket.status,
          actionable,
          expiresAt: ticket.expires_at,
          createdAt: ticket.created_at,
        };
      });
  }

  private async decideMcpElicitation(
    ticketId: string,
    body: Record<string, unknown>,
    binding?: { ownerId: string; serviceId: string },
  ): Promise<Response> {
    const ticket = this.sql<McpElicitationTicketRow>`SELECT * FROM mcp_elicitation_tickets WHERE id=${ticketId}`[0];
    if (!ticket) return json({ error: "mcp_elicitation_not_found" }, { status: 404 });
    if (binding) {
      if (ticket.owner_id !== binding.ownerId || ticket.service_id !== binding.serviceId
        || body.ownerId !== ticket.owner_id || body.chatId !== ticket.chat_id) {
        return json({ error: "mcp_elicitation_scope_mismatch" }, { status: 403 });
      }
    }
    if (mcpElicitationExpired(ticket.expires_at)) {
      this.expireMcpElicitationTicket(ticket);
      return json({ error: "mcp_elicitation_expired" }, { status: 410 });
    }
    const action = body.action as McpElicitationAction;
    if (!(["accept", "decline", "cancel"] as const).includes(action)) {
      return json({ error: "mcp_elicitation_action_invalid" }, { status: 422 });
    }
    const request = this.parseJson<McpElicitationRequest>(ticket.request_json, { mode: ticket.mode, message: "MCP requests input." });
    let decision: ReturnType<typeof validateMcpElicitationDecision>;
    try {
      decision = validateMcpElicitationDecision(request, action, body.content);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "mcp_elicitation_content_invalid" }, { status: 422 });
    }
    if (["accepted", "declined", "cancelled"].includes(ticket.status)) {
      const storedDecision = this.parseJson<ReturnType<typeof validateMcpElicitationDecision> | null>(ticket.decision_json ?? "null", null);
      if (!storedDecision || await canonicalArgsHash(storedDecision) !== await canonicalArgsHash(decision)) {
        return json({ error: "mcp_elicitation_decision_conflict" }, { status: 409 });
      }
      return json({ ticketId, status: ticket.status, taskId: ticket.task_id });
    }
    if (ticket.status === "decision_ready") {
      const storedDecision = this.parseJson<ReturnType<typeof validateMcpElicitationDecision> | null>(ticket.decision_json ?? "null", null);
      if (!storedDecision || await canonicalArgsHash(storedDecision) !== await canonicalArgsHash(decision)) {
        return json({ error: "mcp_elicitation_decision_conflict" }, { status: 409 });
      }
      return json({ ticketId, status: ticket.status, taskId: ticket.task_id });
    }
    if (ticket.status !== "pending") return json({ error: "mcp_elicitation_not_pending", status: ticket.status }, { status: 409 });
    const now = new Date().toISOString();
    const changed = this.sql<{ id: string }>`UPDATE mcp_elicitation_tickets SET status='decision_ready',decision_json=${JSON.stringify(decision)},
      decided_at=${now} WHERE id=${ticketId} AND status='pending' RETURNING id`;
    if (changed.length !== 1) return json({ error: "mcp_elicitation_replay_denied" }, { status: 409 });
    const actorId = binding ? `${binding.ownerId}:${binding.serviceId}` : "browser-owner";
    const { allowed: continuationAllowed, state: continuationState } = authorizeServerSideContinuation(
      this.sql as unknown as SideEffectSql,
      {
        callKey: ticket.call_key,
        proof: { kind: "mcp_elicitation_continuation" },
        authorizedBy: { type: "system", id: `mcp-elicitation:${actorId}` },
        now,
      },
    );
    if (!continuationAllowed || continuationState?.status !== "retry_authorized") {
      this.sql`UPDATE mcp_elicitation_tickets SET status='attention_required' WHERE id=${ticketId}`;
      return json({ error: "mcp_elicitation_side_effect_state_invalid" }, { status: 409 });
    }
    const checkpoint = this.readTaskCheckpoint(ticket.task_id);
    const taskInput = this.delegatedTaskInput(ticket.task_id);
    if (!taskInput || checkpoint.status !== "approval_required" || !checkpoint.pendingCall) {
      this.sql`UPDATE mcp_elicitation_tickets SET status='attention_required' WHERE id=${ticketId}`;
      return json({ error: "mcp_elicitation_task_state_invalid" }, { status: 409 });
    }
    const resumed = { ...checkpoint, status: "interrupted" as const, error: undefined };
    this.persistTaskCheckpoint(resumed);
    this.sql`INSERT INTO mcp_elicitation_resume_intents
      (ticket_id,task_id,call_key,status,generation,fiber_id,error_code,created_at,updated_at)
      VALUES (${ticketId},${ticket.task_id},${ticket.call_key},'pending',0,NULL,NULL,${now},${now})
      ON CONFLICT(ticket_id) DO NOTHING`;
    const resumedIntent = await this.resumeMcpElicitationIntent(ticketId);
    this.audit("mcp.elicitation.decided", binding ? `context-service:${binding.serviceId}` : "browser-owner", ticketId, {
      action, taskId: ticket.task_id, providerId: ticket.provider_id, toolName: ticket.tool_name, generation: resumedIntent.generation,
    });
    return json({ ticketId, status: "decision_ready", taskId: ticket.task_id, fiberId: resumedIntent.fiberId, generation: resumedIntent.generation }, { status: 202 });
  }

  private async reconcileMcpElicitationResumeIntents(): Promise<{ pending: number; resumed: number; completed: number }> {
    const now = new Date().toISOString();
    this.sql`INSERT OR IGNORE INTO mcp_elicitation_resume_intents
      (ticket_id,task_id,call_key,status,generation,fiber_id,error_code,created_at,updated_at)
      SELECT e.id,e.task_id,e.call_key,'pending',0,NULL,NULL,${now},${now}
      FROM mcp_elicitation_tickets e JOIN tool_side_effects s
        ON s.task_id=e.task_id AND s.call_key=e.call_key
      WHERE e.status='decision_ready' AND s.status='retry_authorized'`;
    const terminal = this.sql<{ ticket_id: string }>`UPDATE mcp_elicitation_resume_intents SET status='completed',updated_at=${now}
      WHERE status='started' AND task_id IN (
        SELECT id FROM delegated_tasks WHERE status IN ('completed','failed','cancelled','attention_required')
      ) RETURNING ticket_id`;
    const rows = this.sql<McpElicitationResumeIntentRow>`SELECT * FROM mcp_elicitation_resume_intents
      WHERE status IN ('pending','starting') ORDER BY created_at LIMIT 20`;
    let resumed = 0;
    for (const row of rows) {
      try {
        await this.resumeMcpElicitationIntent(row.ticket_id);
        resumed += 1;
      } catch (error) {
        const code = error instanceof Error ? error.message.slice(0, 180) : "mcp_elicitation_resume_failed";
        this.sql`UPDATE mcp_elicitation_resume_intents SET status='pending',error_code=${code},updated_at=${new Date().toISOString()}
          WHERE ticket_id=${row.ticket_id} AND status='starting'`;
      }
    }
    return { pending: rows.length, resumed, completed: terminal.length };
  }

  private async resumeMcpElicitationIntent(ticketId: string): Promise<{ fiberId: string; generation: number }> {
    let intent = this.sql<McpElicitationResumeIntentRow>`SELECT * FROM mcp_elicitation_resume_intents WHERE ticket_id=${ticketId}`[0];
    if (!intent) throw new Error("mcp_elicitation_resume_intent_missing");
    if (intent.status === "started" && intent.fiber_id) return { fiberId: intent.fiber_id, generation: Number(intent.generation) };
    if (!["pending", "starting"].includes(intent.status)) throw new Error(`mcp_elicitation_resume_${intent.status}`);
    if (intent.generation < 1) {
      const reserved = this.sql<{ repair_generation: number }>`UPDATE delegated_tasks
        SET repair_generation=repair_generation+1,updated_at=${new Date().toISOString()}
        WHERE id=${intent.task_id} RETURNING repair_generation`[0];
      if (!reserved) throw new Error("mcp_elicitation_resume_task_missing");
      this.sql`UPDATE mcp_elicitation_resume_intents SET generation=${reserved.repair_generation},status='starting',error_code=NULL,
        updated_at=${new Date().toISOString()} WHERE ticket_id=${ticketId}`;
      intent = this.sql<McpElicitationResumeIntentRow>`SELECT * FROM mcp_elicitation_resume_intents WHERE ticket_id=${ticketId}`[0];
    } else {
      this.sql`UPDATE mcp_elicitation_resume_intents SET status='starting',error_code=NULL,updated_at=${new Date().toISOString()}
        WHERE ticket_id=${ticketId} AND status='pending'`;
    }
    const taskInput = this.delegatedTaskInput(intent.task_id);
    if (!taskInput) throw new Error("invalid_persisted_task");
    const current = this.readTaskCheckpoint(intent.task_id);
    if (!["approval_required", "interrupted"].includes(current.status)) throw new Error("mcp_elicitation_resume_checkpoint_invalid");
    const checkpoint = current.status === "interrupted" ? current : { ...current, status: "interrupted" as const, error: undefined };
    if (checkpoint !== current) this.persistTaskCheckpoint(checkpoint);
    const generation = Number(intent.generation);
    const receipt = await this.startFiber(
      "delegated-tool-task",
      async (ctx) => {
        try {
          const result = await this.runDelegatedTask(intent.task_id, checkpoint, ctx.signal, (value) => ctx.stash(value));
          if (result.status === "failed") throw new Error(result.error ?? "task_failed");
        } catch (error) {
          const message = error instanceof Error ? error.message : "task_failed";
          const latest = this.readTaskCheckpoint(intent.task_id);
          if (!["failed", "cancelled", "attention_required", "paused"].includes(latest.status)) this.failDelegatedTask(intent.task_id, message);
          throw error;
        }
      },
      { idempotencyKey: `mcp-elicitation-resume:${ticketId}:${generation}`, metadata: { taskId: intent.task_id, ticketId, generation } },
    );
    const updatedAt = new Date().toISOString();
    this.sql`UPDATE delegated_tasks SET fiber_id=${receipt.fiberId},updated_at=${updatedAt} WHERE id=${intent.task_id}`;
    this.sql`UPDATE mcp_elicitation_resume_intents SET status='started',fiber_id=${receipt.fiberId},error_code=NULL,updated_at=${updatedAt}
      WHERE ticket_id=${ticketId} AND generation=${generation}`;
    return { fiberId: receipt.fiberId, generation };
  }

  private gatewayMcpToolRiskLevel(serverId: string, toolName: string): RiskLevel | null {
    const row = this.sql<{ catalog_json: string }>`SELECT catalog_json FROM mcp_gateway_execution_projection
      WHERE provider_id=${serverId} AND status='connected'
      AND julianday(observed_at) >= julianday('now','-1 hour')`[0];
    if (!row) return null;
    return parseToolCatalog(this.parseJson(row.catalog_json, []))
      .find((tool) => tool.enabled && tool.toolName === toolName)?.riskLevel ?? null;
  }

  private expireMcpElicitations(now = new Date().toISOString()): void {
    const expired = this.sql<McpElicitationTicketRow>`SELECT * FROM mcp_elicitation_tickets
      WHERE status IN ('pending','decision_ready') AND expires_at<=${now}`;
    for (const ticket of expired) this.expireMcpElicitationTicket(ticket, now);
  }

  private expireMcpElicitationTicket(ticket: McpElicitationTicketRow, now = new Date().toISOString()): void {
    const changed = this.sql<{ id: string }>`UPDATE mcp_elicitation_tickets SET status='expired'
      WHERE id=${ticket.id} AND status IN ('pending','decision_ready') RETURNING id`;
    if (changed.length !== 1) return;
    const expiredSideEffect = markAwaitingInputExpired(this.sql as unknown as SideEffectSql, { callKey: ticket.call_key, now });
    if (expiredSideEffect.status === "failed") {
      const checkpoint = this.readTaskCheckpoint(ticket.task_id);
      if (checkpoint.status === "approval_required") {
        this.persistTaskCheckpoint({ ...checkpoint, status: "failed", pendingCall: undefined, error: "mcp_elicitation_expired" });
      }
    }
    this.audit("mcp.elicitation.expired", "agent-runtime", ticket.id, {
      taskId: ticket.task_id, providerId: ticket.provider_id, toolName: ticket.tool_name,
    });
  }

  private async invokeObserver(call: { serverId: string; toolName: string; args: unknown }, callKey: string, signal: AbortSignal): Promise<unknown> {
    const bearer = this.env.AGENT_MEMORY_MCP_BEARER?.trim();
    if (!bearer) throw new Error("memory_mcp_auth_misconfigured");
    const response = await this.env.MEMORY_MCP.fetch("https://<MEMORY_SERVICE>.internal/agent-observer/mcp", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, "x-operia-mcp-server-id": call.serverId },
      body: JSON.stringify({ jsonrpc: "2.0", id: callKey, method: "tools/call", params: { name: call.toolName, arguments: call.args, _meta: { serverId: call.serverId } } }), signal,
    });
    if (!response.ok) throw new Error(`memory_mcp_http_${response.status}`);
    const result = parseMcpToolResult(await response.json());
    if (call.toolName !== "system_status" || !result || typeof result !== "object" || Array.isArray(result)) return result;
    return { ...result, agent_sandbox_control: this.sandboxControlProjection() };
  }

  private async invokeDirectProvider(call: { serverId: string; toolName: string; args: unknown }, signal: AbortSignal, taskId: string): Promise<unknown> {
    const timeoutMs = Math.max(1_000, Math.min(60_000, Number(this.env.PROVIDER_TIMEOUT_MS) || 15_000));
    const providerFetch = createGrokGatewayFetch(this.env);
    const registry = createProviderRegistry({
      xai: { enabled: this.grokProviderEnabled(), apiKey: this.env.XAI_API_KEY, timeoutMs, maxResponseBytes: 4 * 1024 * 1024, signal },
      elevenlabs: { enabled: this.env.VOICE_ENABLED?.trim().toLowerCase() === "true", apiKey: this.env.ELEVENLABS_API_KEY, timeoutMs, maxResponseBytes: 12 * 1024 * 1024, signal },
      minimax: {
        enabled: this.env.VOICE_ENABLED?.trim().toLowerCase() === "true" && this.env.MINIMAX_VOICE_ENABLED?.trim().toLowerCase() === "true",
        apiKey: this.env.MINIMAX_API_KEY, timeoutMs, maxResponseBytes: 16 * 1024 * 1024, signal,
      },
      homeAssistant: this.homeAssistantProviderConfig(signal),
    }, { fetch: providerFetch });
    const args = call.args as Record<string, unknown>;
    if (call.serverId === APPROVAL_PROBE_PROVIDER_SERVER_ID && call.toolName === THINK_APPROVAL_PROBE_TOOL_NAME) {
      if (!this.thinkApprovalProbeEnabled()) throw new Error("approval_probe_disabled");
      const input = this.delegatedTaskInput(taskId);
      if (input?.purpose !== "operia_think_paid_read") throw new Error("approval_probe_scope_denied");
      if (signal.aborted) throw new DOMException("Task cancelled", "AbortError");
      return {
        kind: "approval_continuation_probe",
        probeId: input.thinkTaskId ?? input.taskId,
        approved: true,
        billingClass: "none",
        providerAttempts: 0,
        networkCalls: 0,
        externalWrites: 0,
      };
    }
    if (call.serverId === SANDBOX_RUNTIME_PROVIDER_SERVER_ID && call.toolName === "execute_script") {
      return await this.invokeSandboxExecution(args, taskId, signal);
    }
    if (call.serverId === SANDBOX_CODEMODE_PROVIDER_SERVER_ID && call.toolName === "execute_read_plan") {
      return await this.invokeSandboxReadCodeMode(args, taskId, signal);
    }
    if (call.serverId === SOURCE_CODE_PROVIDER_SERVER_ID) {
      if (signal.aborted) throw new DOMException("Task cancelled", "AbortError");
      if (!this.sourceCodeWorkspaceEnabled() || !this.env.SOURCE_SNAPSHOTS) {
        throw new Error("source_workspace_not_configured");
      }
      if (call.toolName === "inspect" && !this.sourceCodeInspectEnabled()) {
        throw new Error("source_workspace_inspect_disabled");
      }
      return await executeSourceWorkspaceRead(this.env.SOURCE_SNAPSHOTS, call.toolName, args);
    }
    if (call.serverId === HEALTH_PROVIDER_SERVER_ID) return await this.invokeHealthProvider(call.toolName, args, signal);
    if (call.serverId === CALENDAR_PROVIDER_SERVER_ID) return await this.invokeCalendarProvider(call.toolName, args, taskId, signal);
    if (call.serverId === HTML_ARTIFACT_PROVIDER_SERVER_ID && call.toolName === "create") {
      if (signal.aborted) throw new DOMException("Task cancelled", "AbortError");
      return await this.createHtmlArtifact(args, taskId);
    }
    if (call.serverId === BROWSER_PROVIDER_SERVER_ID) {
      if (call.toolName === "browser_task") return await this.invokeBrowserTypedTask(args, taskId, signal);
      if (call.toolName === "browser_execute") return await this.invokeInteractiveBrowser(args, taskId);
      if (call.toolName === "browser_resume") return await this.resumeInteractiveBrowser(args, taskId);
      if (call.toolName === "site_adapter_read") return await this.invokeSiteAdapterRead(args, taskId);
      return await this.invokeBrowserQuickAction(call.toolName as BrowserQuickActionName, args, taskId);
    }
    if (call.serverId === GROK_PROVIDER_SERVER_ID && call.toolName === "search_web") {
      const result = await registry.invoke({ provider: "xai", operation: "search_web", input: { query: String(args.query ?? "") } });
      const maximum = Math.max(1, Math.min(8, Number(args.max_sources) || 5));
      return { ...result, sources: result.sources.slice(0, maximum) };
    }
    if (call.serverId === GROK_PROVIDER_SERVER_ID && call.toolName === "generate_image") {
      const referenceMediaRefs = Array.isArray(args.reference_media_refs) ? args.reference_media_refs : [];
      const referenceImages = await this.loadImageReferences(referenceMediaRefs);
      const generated = await registry.invoke({ provider: "xai", operation: "generate_image", input: {
        prompt: String(args.prompt ?? ""), aspectRatio: typeof args.aspect_ratio === "string" ? args.aspect_ratio : undefined,
        model: referenceImages.length || args.quality !== "standard" ? "grok-imagine-image-quality" : "grok-imagine-image",
        ...(referenceImages.length ? { referenceImages } : {}),
      } });
      const source = generated.images[0]?.url;
      if (!source) throw new Error("generated_image_missing");
      const url = new URL(source);
      if (url.protocol !== "https:" || url.hostname !== "imgen.x.ai") throw new Error("generated_image_host_not_allowed");
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`generated_image_download_${response.status}`);
      const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
      if (!contentType.startsWith("image/")) throw new Error("generated_image_content_type");
      const bytes = await this.readBoundedBody(response, 20 * 1024 * 1024, "generated_image_size");
      const mediaRef = await this.storeProviderMedia(bytes, contentType, "image");
      return { mediaRef, kind: "image", contentType, provider: generated.provider };
    }
    if (call.serverId === VOICE_PROVIDER_SERVER_ID && call.toolName === "speak") {
      const voice = this.defaultVoiceProfile();
      if (!voice) throw new Error("voice_default_not_configured");
      const result = await registry.invoke({ provider: "elevenlabs", operation: "tts", input: {
        voiceId: voice.voiceId, text: String(args.text ?? ""), modelId: this.voiceModelId(args.mode === "realtime" || args.mode === "quality" ? args.mode : "expressive"), outputFormat: "opus_48000_64", voiceSettings: voice.voiceSettings,
      } });
      const mediaRef = await this.storeProviderMedia(result.audio, result.contentType, "voice");
      return { mediaRef, kind: "voice", contentType: result.contentType };
    }
    if (call.serverId === HOME_ASSISTANT_PROVIDER_SERVER_ID && call.toolName === "call_service") {
      const data = this.parseHomeAssistantData(args.data_json);
      return await registry.invoke({ provider: "home_assistant", operation: "call_service", input: {
        entityId: String(args.entity_id ?? ""), domain: String(args.domain ?? ""), service: String(args.service ?? ""), data,
      } });
    }
    throw new Error("provider_gateway_not_available");
  }

  private sandboxEnabled(): boolean {
    return this.env.AGENT_SANDBOX_ENABLED?.trim().toLowerCase() === "true";
  }

  private sourceCodeWorkspaceEnabled(): boolean {
    return this.env.AGENT_CODE_WORKSPACE_ENABLED?.trim().toLowerCase() === "true"
      && Boolean(this.env.SOURCE_SNAPSHOTS);
  }

  private sourceCodeInspectEnabled(): boolean {
    return this.sourceCodeWorkspaceEnabled()
      && this.env.AGENT_CODE_INSPECT_ENABLED?.trim().toLowerCase() === "true";
  }

  private async sourceCodeWorkspaceReady(): Promise<boolean> {
    if (!this.sourceCodeWorkspaceEnabled() || !this.env.SOURCE_SNAPSHOTS) return false;
    try {
      const listed = await executeSourceWorkspaceRead(this.env.SOURCE_SNAPSHOTS, "list", { limit: 1 });
      if (!listed || typeof listed !== "object" || Array.isArray(listed)) throw new Error("source_workspace_probe_list_invalid");
      const listEnvelope = listed as Record<string, unknown>;
      const files = Array.isArray(listEnvelope.files) ? listEnvelope.files : [];
      const first = files[0];
      if (!first || typeof first !== "object" || Array.isArray(first)) throw new Error("source_workspace_probe_file_missing");
      const file = first as Record<string, unknown>;
      if (typeof file.path !== "string" || typeof file.sha256 !== "string") throw new Error("source_workspace_probe_file_invalid");
      const read = await executeSourceWorkspaceRead(this.env.SOURCE_SNAPSHOTS, "read", {
        path: file.path,
        start_line: 1,
        end_line: 1,
      });
      if (!read || typeof read !== "object" || Array.isArray(read)) throw new Error("source_workspace_probe_read_invalid");
      const readEnvelope = read as Record<string, unknown>;
      if (readEnvelope.fileSha256 !== file.sha256 || readEnvelope.commitSha !== listEnvelope.commitSha
        || readEnvelope.treeHash !== listEnvelope.treeHash) {
        throw new Error("source_workspace_probe_file_hash_mismatch");
      }
      const searched = await executeSourceWorkspaceRead(this.env.SOURCE_SNAPSHOTS, "search", {
        query: "__operia_source_workspace_readiness_no_match__",
        limit: 1,
      });
      if (!searched || typeof searched !== "object" || Array.isArray(searched)) throw new Error("source_workspace_probe_search_invalid");
      const searchEnvelope = searched as Record<string, unknown>;
      if (searchEnvelope.commitSha !== listEnvelope.commitSha || searchEnvelope.treeHash !== listEnvelope.treeHash) {
        throw new Error("source_workspace_probe_search_revision_mismatch");
      }
      return true;
    } catch (error) {
      console.warn("source_workspace_probe_degraded", { code: boundedAgentErrorCode(error, "source_workspace_probe_failed") });
      return false;
    }
  }

  private thinkApprovalProbeEnabled(): boolean {
    return this.env.AGENT_THINK_APPROVAL_PROBE_ENABLED?.trim().toLowerCase() === "true";
  }

  private sandboxExecutionEnabled(): boolean {
    return this.sandboxEnabled() && Boolean(this.env.OPERIA_SANDBOX);
  }

  private sandboxP2ReadEnabled(): boolean {
    return this.sandboxEnabled() && this.env.AGENT_SANDBOX_P2_READ_ENABLED?.trim().toLowerCase() === "true";
  }

  private sandboxCodeModeEnabled(): boolean {
    return this.sandboxEnabled()
      && this.env.AGENT_CODEMODE_ENABLED?.trim().toLowerCase() === "true"
      && Boolean(this.env.LOADER);
  }

  private selfManageWriteEnabled(): boolean {
    return this.env.AGENT_SELF_MANAGE_WRITE_ENABLED?.trim().toLowerCase() === "true";
  }

  private async invokeSandboxExecution(args: Record<string, unknown>, taskId: string, signal: AbortSignal): Promise<unknown> {
    if (!this.sandboxExecutionEnabled()) throw new Error("sandbox_execution_disabled");
    const input = this.delegatedTaskInput(taskId);
    if (!input) throw new Error("sandbox_task_scope_missing");
    const environment = this.env.AGENT_SANDBOX_CANARY_ENABLED?.trim().toLowerCase() === "true" ? "qa" : "production";
    this.audit("sandbox.execution.started", `task:${taskId}`, taskId, {
      environment,
      connectorCapabilityExposed: false,
    });
    try {
      const result = await execute<Sandbox>Script(this.env as SandboxWorkerEnv, {
        ownerId: input.ownerId,
        taskId,
        environment,
        args,
      }, signal);
      this.audit("sandbox.execution.completed", `task:${taskId}`, taskId, {
        environment,
        success: result.success,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputTruncated: result.outputTruncated,
        cleanup: result.cleanup,
      });
      return result;
    } catch (error) {
      this.audit("sandbox.execution.failed", `task:${taskId}`, taskId, {
        environment,
        code: boundedAgentErrorCode(error, "sandbox_execution_failed"),
      });
      throw error;
    }
  }

  private async invokeSandboxReadCodeMode(args: Record<string, unknown>, taskId: string, signal: AbortSignal): Promise<unknown> {
    if (!this.sandboxCodeModeEnabled() || !this.env.LOADER) throw new Error("sandbox_codemode_disabled");
    const input = this.delegatedTaskInput(taskId);
    if (!input) throw new Error("sandbox_task_scope_missing");
    const runtimeName = `operia-read-${taskId.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 80)}`;
    const mode = createOperiaReadCodeMode({
      ctx: this.ctx,
      loader: this.env.LOADER,
      runtimeName,
      p2Enabled: this.sandboxP2ReadEnabled(),
      healthEnabled: this.healthProviderEnabled(),
      calendarEnabled: Boolean(this.env.CALENDAR_SERVICE && this.env.CALENDAR_SERVICE_BEARER?.trim()),
      dispatch: async (action, toolArgs) => {
        if (signal.aborted) throw new DOMException("Task cancelled", "AbortError");
        if (this.sandboxControlSnapshot().paused) throw new Error("sandbox_global_pause_active");
        if (action === "synthetic.echo") return { value: toolArgs.value, policyVersion: "operia-sandbox-v1", synthetic: true };
        if (!this.sandboxP2ReadEnabled()) throw new Error("sandbox_p2_read_disabled");
        if (action === "system.read") return { classification: "internal_status", snapshot: this.healthSnapshot() };
        if (action === "health.read") return await this.invokeHealthProvider("health_summary", toolArgs, signal);
        if (action === "calendar.read") return await this.readSandboxCalendarProjection(input.ownerId, signal);
        throw new Error("sandbox_connector_action_denied");
      },
    });
    const result = await mode.execute(String(args.code ?? ""));
    if (result.status !== "completed") {
      throw new Error(result.status === "error" ? `sandbox_codemode_error:${String(result.error ?? "failed").slice(0, 160)}` : "sandbox_codemode_unexpected_pause");
    }
    // Staging-only race amplifier. The tool result already exists, but the
    // caller has not crossed invokeMcpTool's generation fence yet. A canary
    // pause during this bounded delay must quarantine the result.
    if (
      this.env.AGENT_SANDBOX_CANARY_ENABLED?.trim().toLowerCase() === "true"
      && taskId.startsWith("canary-quarantine-")
    ) {
      const configured = Number(this.env.AGENT_SANDBOX_CANARY_DELAY_MS);
      const delayMs = Number.isFinite(configured) ? Math.max(500, Math.min(10_000, Math.trunc(configured))) : 2_500;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    return { status: result.status, result: result.result, policyVersion: "operia-sandbox-v1" };
  }

  private async readSandboxCalendarProjection(ownerId: string, signal: AbortSignal): Promise<unknown> {
    const projection = await this.readCalendarProjection(ownerId, signal);
    return { classification: "calendar_sensitive", speciallyMarked: true, projection };
  }

  private async readCalendarProjection(ownerId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const service = this.env.CALENDAR_SERVICE;
    const bearer = this.env.CALENDAR_SERVICE_BEARER?.trim();
    if (!service || !bearer) throw new Error("calendar_service_not_configured");
    const response = await service.fetch(new Request("https://calendar.internal/service/calendar/projection", {
      method: "GET",
      signal,
      headers: { authorization: `Bearer ${bearer}`, "x-calendar-owner-id": ownerId },
    }));
    if (!response.ok) throw new Error(`calendar_service_http_${response.status}`);
    const bytes = await this.readBoundedBody(response, 64 * 1024, "calendar_projection_size");
    const projection = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (projection.ownerDomain !== "calendar.example.com" || !Array.isArray(projection.upcoming)) {
      throw new Error("calendar_projection_schema_drift");
    }
    return projection;
  }

  private async invokeCalendarProvider(toolName: string, args: Record<string, unknown>, taskId: string, signal: AbortSignal): Promise<unknown> {
    if (!["calendar_summary", "calendar_upcoming"].includes(toolName)) throw new Error("calendar_tool_not_available");
    const input = this.delegatedTaskInput(taskId);
    if (!input) throw new Error("calendar_task_scope_missing");
    const projection = await this.readCalendarProjection(input.ownerId, signal);
    const base = {
      classification: "calendar_sensitive",
      speciallyMarked: true,
      ownerDomain: projection.ownerDomain,
      status: projection.status,
      observedAt: projection.observedAt,
      staleAfter: projection.staleAfter,
      lastSyncAt: projection.lastSyncAt,
      lastSyncStatus: projection.lastSyncStatus,
      accountLabel: projection.accountLabel,
    };
    if (toolName === "calendar_summary") {
      return {
        ...base,
        current: projection.current,
        next: projection.next,
        remainingToday: projection.remainingToday,
      };
    }
    const limit = Math.max(1, Math.min(20, Math.trunc(Number(args.limit) || 10)));
    return {
      ...base,
      upcoming: (projection.upcoming as unknown[]).slice(0, limit),
      remainingToday: projection.remainingToday,
    };
  }

  private healthProviderEnabled(): boolean {
    return this.env.HEALTH_ENABLED?.trim().toLowerCase() === "true"
      && Boolean(this.env.HEALTH_SERVICE)
      && Boolean(this.env.HEALTH_SERVICE_BEARER?.trim());
  }

  private async invokeHealthProvider(toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!this.healthProviderEnabled() || !this.env.HEALTH_SERVICE) throw new Error("health_service_not_configured");
    if (!["health_summary", "health_trends"].includes(toolName)) throw new Error("health_tool_not_available");
    const rawRange = String(args.range || "7d");
    const range = rawRange === "30d" ? 30 : 7;
    const rawGroup = String(args.group || "all");
    const group = ["all", "activity", "sleep", "cardio", "body", "mobility", "respiratory", "vitals", "nutrition", "lifestyle", "environment", "other"].includes(rawGroup) ? rawGroup : "all";
    const response = await this.env.HEALTH_SERVICE.fetch(new Request(
      `https://health.internal/service/health/tool/query?range=${range}&group=${encodeURIComponent(group)}`,
      { method: "POST", signal, headers: { authorization: `Bearer ${this.env.HEALTH_SERVICE_BEARER?.trim()}`, "x-health-client": "<AGENT_SERVICE>-opus" } },
    ));
    if (!response.ok) throw new Error(`health_service_http_${response.status}`);
    const bytes = await this.readBoundedBody(response, 64 * 1024, "health_projection_size");
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (value.disclaimer !== "informational_not_medical_diagnosis" || value.ownerDomain !== "health.example.com") throw new Error("health_projection_invalid");
    if (toolName === "health_summary") {
      return {
        ownerDomain: value.ownerDomain,
        status: value.status,
        range: rawRange === "today" ? "today" : `${range}d`,
        observedAt: value.observedAt,
        lastSyncedAt: value.lastSyncedAt,
        lastSourceAt: value.lastSourceAt,
        freshness: value.freshness,
        summary: value.summary,
        timelineEvents: Array.isArray(value.timelineEvents) ? value.timelineEvents.slice(0, 5) : [],
        source: value.source,
        missingData: value.missingData,
        disclaimer: value.disclaimer,
      };
    }
    return value;
  }

  private browserEnabled(): boolean {
    const capability = this.state.capabilities["tools.browser"] ?? "enabled";
    return capability === "enabled" && this.env.BROWSER_ENABLED?.trim().toLowerCase() === "true" && Boolean(this.env.BROWSER);
  }

  private browserDomainAllowlistSnapshot(): {
    key: "agent.browser.domain_allowlist";
    domains: string[];
    revision: number;
    source: "owner_store" | "owner_env";
    updatedAt: string;
  } {
    const stored = this.state.browserDomainAllowlist;
    const domains = normalizeBrowserDomainInput(Array.isArray(stored) ? stored : []);
    const revision = Number.isSafeInteger(this.state.browserDomainAllowlistRevision) && Number(this.state.browserDomainAllowlistRevision) >= 0
      ? Number(this.state.browserDomainAllowlistRevision)
      : 0;
    return {
      key: "agent.browser.domain_allowlist",
      domains,
      revision,
      source: "owner_store",
      updatedAt: this.state.updatedAt,
    };
  }

  private browserDomainAllowlist(): string[] {
    return this.browserDomainAllowlistSnapshot().domains;
  }

  private browserDomainDenylistSnapshot(): {
    key: "agent.browser.domain_denylist";
    domains: string[];
    revision: number;
    source: "owner_store";
    updatedAt: string;
  } {
    return {
      key: "agent.browser.domain_denylist",
      domains: normalizeBrowserDomainInput(this.state.browserDomainDenylist ?? []),
      revision: Number.isSafeInteger(this.state.browserDomainDenylistRevision) && Number(this.state.browserDomainDenylistRevision) >= 0
        ? Number(this.state.browserDomainDenylistRevision)
        : 0,
      source: "owner_store",
      updatedAt: this.state.updatedAt,
    };
  }

  private agentControlValues() {
    const allowlist = this.browserDomainAllowlistSnapshot();
    const denylist = this.browserDomainDenylistSnapshot();
    const skills = this.skillControlSnapshot() as { installed: unknown[]; publishers: unknown[]; runs: unknown[] };
    const heartbeat = this.heartbeatConfigRow();
    return agentControlProjection(this.env, {
      browserDomainAllowlist: allowlist.domains,
      browserDomainAllowlistRevision: allowlist.revision,
      browserDomainAllowlistUpdatedAt: allowlist.updatedAt,
      browserDomainDenylist: denylist.domains,
      browserDomainDenylistRevision: denylist.revision,
      browserDomainDenylistUpdatedAt: denylist.updatedAt,
      skillInstallations: skills.installed,
      skillTrustRoots: skills.publishers,
      skillRuns: skills.runs,
      heartbeatConfig: heartbeat.config as unknown as Record<string, unknown>,
      heartbeatRevision: heartbeat.revision,
      heartbeatUpdatedAt: heartbeat.updatedAt,
    });
  }

  private updateBrowserDomainAllowlist(request: Request, body: Record<string, unknown>): Response {
    const current = this.browserDomainAllowlistSnapshot();
    const result = applyBrowserAllowlistMutation(current.revision, request.headers.get("if-match"), body.domains);
    if (!result.ok) {
      return json(
        { error: result.error, currentRevision: result.currentRevision, domains: current.domains },
        { status: result.status, headers: { etag: `"${result.currentRevision}"` } },
      );
    }
    const now = new Date().toISOString();
    const before = new Set(current.domains);
    const after = new Set(result.domains);
    this.setState({
      ...this.state,
      schemaVersion: 8,
      browserDomainAllowlist: result.domains,
      browserDomainAllowlistRevision: result.revision,
      updatedAt: now,
    });
    this.audit("browser.domain_allowlist.updated", "browser-session", current.key, {
      previousRevision: current.revision,
      revision: result.revision,
      added: result.domains.filter((domain) => !before.has(domain)),
      removed: current.domains.filter((domain) => !after.has(domain)),
    });
    return json(
      { ok: true, key: current.key, domains: result.domains, revision: result.revision, source: "owner_store", updatedAt: now },
      { headers: { etag: `"${result.revision}"` } },
    );
  }

  private updateBrowserDomainDenylist(request: Request, body: Record<string, unknown>): Response {
    const current = this.browserDomainDenylistSnapshot();
    const result = applyBrowserAllowlistMutation(current.revision, request.headers.get("if-match"), body.domains);
    if (!result.ok) {
      return json(
        { error: result.error, currentRevision: result.currentRevision, domains: current.domains },
        { status: result.status, headers: { etag: `"${result.currentRevision}"` } },
      );
    }
    const now = new Date().toISOString();
    this.setState({
      ...this.state,
      schemaVersion: 8,
      browserDomainDenylist: result.domains,
      browserDomainDenylistRevision: result.revision,
      updatedAt: now,
    });
    this.audit("browser.domain_denylist.updated", "browser-session", current.key, {
      previousRevision: current.revision,
      revision: result.revision,
      domains: result.domains,
    });
    return json(
      { ok: true, key: current.key, domains: result.domains, revision: result.revision, source: "owner_store", updatedAt: now },
      { headers: { etag: `"${result.revision}"` } },
    );
  }

  private revokeBrowserDomainGrant(grantId: string): Response {
    const now = new Date().toISOString();
    const changed = this.sql<{ id: string }>`UPDATE browser_domain_grants SET status='revoked',updated_at=${now}
      WHERE id=${grantId} AND status='active' RETURNING id`;
    if (changed.length !== 1) return json({ error: "browser_domain_grant_not_active" }, { status: 404 });
    this.audit("browser.domain_grant.revoked", "browser-session", grantId, {});
    return json({ ok: true, grantId, status: "revoked" });
  }

  private browserInteractiveEnabled(): boolean {
    return this.browserEnabled()
      && this.env.BROWSER_INTERACTIVE_ENABLED?.trim().toLowerCase() === "true"
      && Boolean(this.env.LOADER);
  }

  private browserTaskLeasesEnabled(): boolean {
    return this.browserInteractiveEnabled() && this.env.BROWSER_TASK_LEASES_ENABLED?.trim().toLowerCase() === "true";
  }

  private taskProgressEnabled(): boolean {
    return this.env.TASK_PROGRESS_ENABLED?.trim().toLowerCase() === "true";
  }

  private browserDailyBudgetMs(): number {
    const configured = Number(this.env.BROWSER_DAILY_BUDGET_MS);
    return Number.isSafeInteger(configured) && configured >= 1_000 && configured <= BROWSER_FREE_DAILY_BUDGET_MS
      ? configured
      : BROWSER_FREE_DAILY_BUDGET_MS;
  }

  private browserUsageTodayMs(): number {
    const row = this.sql<{ total: number }>`SELECT COALESCE(SUM(browser_ms),0) AS total FROM browser_runs
      WHERE started_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')`[0];
    return Number(row?.total ?? 0);
  }

  private assertBrowserFreeBudget(): void {
    if (!this.browserEnabled() || !this.env.BROWSER) throw new Error("browser_disabled");
    if (this.browserUsageTodayMs() >= this.browserDailyBudgetMs()) throw new Error("browser_daily_budget_exhausted");
    const running = this.sql<CountRow>`SELECT COUNT(*) AS count FROM browser_runs
      WHERE status = 'running' AND started_at >= datetime('now','-90 seconds')`[0]?.count ?? 0;
    if (running > 0) throw new Error("browser_single_concurrency_limit");
    const latest = this.sql<{ started_at: string }>`SELECT started_at FROM browser_runs ORDER BY started_at DESC LIMIT 1`[0];
    if (latest && Date.now() - Date.parse(latest.started_at) < BROWSER_FREE_MIN_INTERVAL_MS) throw new Error("browser_free_rate_limit");
  }

  private async invokeSiteAdapterRead(args: Record<string, unknown>, taskId: string): Promise<unknown> {
    const registry = await createDefaultSiteAdapterRegistry();
    const key = typeof args.adapter === "string" ? args.adapter : "";
    const adapter = registry.find((entry) => entry.key === key);
    if (!adapter) throw new Error("site_adapter_unknown");
    const decision = await evaluateSiteAdapterExecution({
      registry,
      key,
      url: String(args.url ?? ""),
      observed: {
        version: adapter.version,
        schemaHash: adapter.schemaHash,
        sourceHash: adapter.sourceHash,
        smokeStatus: adapter.smoke.status,
      },
    });
    if (!decision.ok) throw new Error(`site_adapter_denied:${decision.code}`);
    const result = await this.invokeBrowserQuickAction("browser_markdown", { url: decision.url.toString() }, taskId);
    return { adapter: adapter.key, version: adapter.version, sourceHash: adapter.sourceHash, result };
  }

  private async invokeBrowserQuickAction(action: BrowserQuickActionName, args: Record<string, unknown>, taskId: string): Promise<unknown> {
    this.assertBrowserFreeBudget();
    const task = this.sql<{ input_json: string }>`SELECT input_json FROM delegated_tasks WHERE id = ${taskId}`[0];
    const input = task ? this.parseJson<DelegatedTaskInput | null>(task.input_json, null) : null;
    if (!input) throw new Error("browser_task_scope_missing");
    await this.dispatchHooks("before_browser_action", input, { taskId, action, url: String(args.url ?? "") });
    const allowlist = this.browserAllowlistForCall({ serverId: BROWSER_PROVIDER_SERVER_ID, toolName: action, args }, taskId);
    if (allowlist.length === 0) throw new Error("browser_domain_allowlist_empty");
    let responseSchema: unknown;
    if (action === "browser_extract") {
      responseSchema = this.parseJson(String(args.response_schema_json ?? ""), null);
      if (!responseSchema) throw new Error("browser_extract_schema_invalid");
    }
    const url = String(args.url ?? "");
    const host = (() => { try { return new URL(url).hostname.slice(0, 253); } catch { return "invalid"; } })();
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    this.sql`INSERT INTO browser_runs (id,task_id,owner_id,service_id,chat_id,action,url_host,status,started_at)
      VALUES (${runId},${taskId},${input.ownerId},${input.serviceId},${input.chatId},${action},${host},'running',${startedAt})`;
    const started = Date.now();
    try {
      const result = await executeBrowserQuickAction(this.env.BROWSER!, {
        action,
        url,
        selectors: Array.isArray(args.selectors) ? args.selectors.map(String) : undefined,
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        responseSchema,
      }, allowlist);
      const finishedAt = new Date().toISOString();
      this.sql`UPDATE browser_runs SET status='completed',browser_ms=${result.browserMsUsed},finished_at=${finishedAt} WHERE id=${runId}`;
      this.audit("browser.quick_action.completed", `context-service:${input.serviceId}`, taskId, {
        action, host: new URL(result.url).hostname, browserMs: result.browserMsUsed, wallMs: Date.now() - started,
      });
      return { action: result.action, url: result.url, result: result.value, browserMsUsed: result.browserMsUsed };
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 160) : "browser_action_failed";
      this.sql`UPDATE browser_runs SET status='failed',error_code=${code},finished_at=${new Date().toISOString()} WHERE id=${runId}`;
      this.audit("browser.quick_action.failed", `context-service:${input.serviceId}`, taskId, { action, host, code });
      throw error;
    }
  }

  private browserSiteProfiles(): BrowserSiteProfile[] {
    return this.sql<BrowserSiteProfileRow>`SELECT * FROM browser_site_profiles WHERE enabled=1 ORDER BY id`.map((row) => ({
      id: row.id,
      label: row.label,
      primaryHosts: this.parseJson<string[]>(row.primary_hosts_json, []),
      redirectHosts: this.parseJson<string[]>(row.redirect_hosts_json, []),
      maximumMode: row.maximum_mode,
      allowedActions: this.parseJson<BrowserSiteProfile["allowedActions"]>(row.allowed_actions_json, []),
      revision: Number(row.revision),
      enabled: row.enabled === 1,
    }));
  }

  private browserTaskLease(taskId: string): BrowserTaskLeaseRow | null {
    return this.sql<BrowserTaskLeaseRow>`SELECT * FROM browser_task_leases WHERE task_id=${taskId}`[0] ?? null;
  }

  private rowToBrowserTaskLease(row: BrowserTaskLeaseRow): BrowserTaskLease {
    return {
      id: row.id,
      taskId: row.task_id,
      siteProfileId: row.site_profile_id,
      siteProfileRevision: Number(row.site_profile_revision),
      mode: row.mode,
      allowedHosts: this.parseJson<string[]>(row.allowed_hosts_json, []),
      allowedActions: this.parseJson<BrowserTaskLease["allowedActions"]>(row.allowed_actions_json, []),
      maxLogicalSteps: Number(row.max_logical_steps),
      usedLogicalSteps: Number(row.used_logical_steps),
      deadlineAt: row.deadline_at,
      instructionHash: row.instruction_hash,
      state: row.state,
      revision: Number(row.revision),
      stepOnce: row.step_once === 1,
    };
  }

  private async issueBrowserTaskLease(taskId: string, input: DelegatedTaskInput, task: BrowserTypedTaskInput): Promise<BrowserTaskLeaseRow> {
    const existing = this.browserTaskLease(taskId);
    const instructionHash = await this.sha256(JSON.stringify(task));
    if (existing) {
      if (existing.instruction_hash !== instructionHash) throw new Error("browser_task_lease_instruction_mismatch");
      return existing;
    }
    const profile = selectBrowserSiteProfile(this.browserSiteProfiles(), task.domains, task.interactionMode);
    if (!profile) throw new Error("browser_site_profile_required");
    const allowedActions = allowedActionsForMode(task.interactionMode).filter((action) => profile.allowedActions.includes(action));
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const executionId = `typed-${crypto.randomUUID()}`;
    const ownerScopeHash = await this.sha256(JSON.stringify({ ownerId: input.ownerId, serviceId: input.serviceId, chatId: input.chatId }));
    const sessionKey = `operia:${ownerScopeHash.slice(0, 24)}:${task.sessionKey}`;
    const runtimeName = `operia-browser-task-${id}`;
    const deadlineAt = new Date(Date.now() + task.deadlineMs).toISOString();
    this.sql`INSERT INTO browser_task_leases (id,task_id,owner_id,service_id,channel_ref,site_profile_id,site_profile_revision,
      mode,allowed_hosts_json,allowed_actions_json,max_logical_steps,used_logical_steps,deadline_at,instruction_hash,state,
      revision,step_once,session_key,runtime_name,execution_id,created_at,updated_at)
      VALUES (${id},${taskId},${input.ownerId},${input.serviceId},${input.chatId},${profile.id},${profile.revision},${task.interactionMode},
        ${JSON.stringify(task.domains)},${JSON.stringify(allowedActions)},${task.maxLogicalSteps},0,${deadlineAt},${instructionHash},'active',
        1,0,${sessionKey},${runtimeName},${executionId},${now},${now})`;
    this.sql`INSERT INTO browser_executions (execution_id,task_id,runtime_name,mode,session_key,domains_json,recording,status,pending_json,result_json,created_at,updated_at)
      VALUES (${executionId},${taskId},${runtimeName},'dynamic',${sessionKey},${JSON.stringify(task.domains)},${task.recording ? 1 : 0},'running',NULL,NULL,${now},${now})`;
    this.sql`INSERT INTO browser_sessions (session_key,owner_scope_hash,mode,state,last_url_origin,created_at,last_used_at,expires_at)
      VALUES (${sessionKey},${ownerScopeHash},'dynamic','active',${`https://${task.domains[0]}`},${now},${now},${deadlineAt})
      ON CONFLICT(session_key) DO UPDATE SET state='active',last_used_at=${now},expires_at=${deadlineAt}`;
    this.recordTaskProgress(taskId, "browser.lease_issued", "浏览器任务已取得受限租约", {
      phase: "browser", profile: profile.id, mode: task.interactionMode, stepBudget: task.maxLogicalSteps,
    });
    return this.browserTaskLease(taskId)!;
  }

  private async awaitBrowserLeaseAction(
    taskId: string,
    descriptor: BrowserActionDescriptor,
    signal: AbortSignal,
  ): Promise<{ lease: BrowserTaskLeaseRow; stepOnce: boolean }> {
    let announcedPause = false;
    for (;;) {
      if (signal.aborted || this.isTaskCancelled(taskId)) throw new DOMException("Task cancelled", "AbortError");
      const row = this.browserTaskLease(taskId);
      if (!row) throw new Error("browser_task_lease_missing");
      if (row.state === "paused") {
        if (!announcedPause) {
          announcedPause = true;
          this.setTaskStatusOnly(taskId, "paused", "browser_task_paused");
          this.recordTaskProgress(taskId, "browser.paused", "浏览器任务已暂停，可继续、单步或停止", { phase: "paused" });
        }
        if (Date.parse(row.deadline_at) <= Date.now()) {
          this.sql`UPDATE browser_task_leases SET state='expired',revision=revision+1,updated_at=${new Date().toISOString()} WHERE id=${row.id}`;
          throw new Error("browser_task_lease_expired");
        }
        await shortDelay(500);
        continue;
      }
      const lease = this.rowToBrowserTaskLease(row);
      validateBrowserLeaseAction(lease, descriptor);
      if (announcedPause) this.setTaskStatusOnly(taskId, "executing");
      return { lease: row, stepOnce: row.step_once === 1 };
    }
  }

  private beginBrowserAction(
    taskId: string,
    index: number,
    actionKind: string,
    logicalStepCost: number,
    mutating: boolean,
  ): { replay: boolean; completedDetail?: string } {
    const existing = this.sql<BrowserActionCheckpointRow>`SELECT * FROM browser_action_checkpoints
      WHERE task_id=${taskId} AND action_index=${index}`[0] ?? null;
    if (existing) {
      if (existing.action_kind !== actionKind || Number(existing.logical_step_cost) !== logicalStepCost || (existing.mutating === 1) !== mutating) {
        throw new Error("browser_action_checkpoint_mismatch");
      }
      const recovery = browserActionRecoveryDecision(existing.state, existing.mutating === 1);
      if (recovery === "reuse") {
        return { replay: false, ...(existing.result_json ? { completedDetail: existing.result_json } : {}) };
      }
      if (recovery === "attention_required") {
        this.sql`UPDATE browser_action_checkpoints SET state='attention_required',updated_at=${new Date().toISOString()}
          WHERE task_id=${taskId} AND action_index=${index}`;
        throw new Error("browser_action_outcome_unknown");
      }
      this.sql`UPDATE browser_action_checkpoints SET attempt_count=attempt_count+1,updated_at=${new Date().toISOString()}
        WHERE task_id=${taskId} AND action_index=${index} AND state='started'`;
      return { replay: true };
    }
    const lease = this.browserTaskLease(taskId);
    if (!lease || Number(lease.used_logical_steps) + logicalStepCost > Number(lease.max_logical_steps)) {
      throw new Error("browser_task_lease_step_limit");
    }
    const now = new Date().toISOString();
    this.sql`INSERT INTO browser_action_checkpoints
      (task_id,action_index,action_kind,logical_step_cost,mutating,state,attempt_count,result_json,started_at,completed_at,updated_at)
      VALUES (${taskId},${index},${actionKind},${logicalStepCost},${mutating ? 1 : 0},'started',1,NULL,${now},NULL,${now})`;
    return { replay: true };
  }

  private commitBrowserAction(taskId: string, index: number, detail: string | undefined): void {
    const now = new Date().toISOString();
    const changed = this.sql<{ action_index: number }>`UPDATE browser_action_checkpoints
      SET state='completed',result_json=${detail ?? null},completed_at=${now},updated_at=${now}
      WHERE task_id=${taskId} AND action_index=${index} AND state='started' RETURNING action_index`;
    if (changed.length !== 1) throw new Error("browser_action_commit_conflict");
    this.sql`UPDATE browser_task_leases SET
      used_logical_steps=(SELECT COALESCE(SUM(logical_step_cost),0) FROM browser_action_checkpoints
        WHERE task_id=${taskId} AND state='completed'),
      revision=revision+1,updated_at=${now}
      WHERE task_id=${taskId} AND state='active'`;
  }

  private async invokeBrowserTypedTask(args: Record<string, unknown>, taskId: string, signal: AbortSignal): Promise<unknown> {
    if (!this.browserTaskLeasesEnabled() || !this.env.BROWSER || !this.env.LOADER) throw new Error("browser_task_leases_disabled");
    this.assertBrowserFreeBudget();
    const input = this.delegatedTaskInput(taskId);
    if (!input) throw new Error("browser_task_scope_missing");
    const globalAllowlist = this.browserAllowlistForCall({ serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "browser_task", args }, taskId);
    const heartbeatTask = input.purpose === "companion-pulse-read-only";
    const boundedArgs = heartbeatTask ? {
      ...args,
      interaction_mode: "read",
      max_logical_steps: Math.min(8, Number(args.max_logical_steps) || 8),
      timeout_ms: Math.min(90_000, Number(args.timeout_ms) || 90_000),
    } : args;
    const task = validateBrowserTypedTaskInput(boundedArgs, globalAllowlist);
    await this.dispatchHooks("before_browser_action", input, { taskId, action: "browser_task", domains: task.domains, mode: task.interactionMode });
    let leaseRow = await this.issueBrowserTaskLease(taskId, input, task);
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    this.sql`INSERT INTO browser_runs (id,task_id,owner_id,service_id,chat_id,action,url_host,status,started_at)
      VALUES (${runId},${taskId},${input.ownerId},${input.serviceId},${input.chatId},'browser_task',${task.domains[0]},'running',${startedAt})`;
    const runtime = createInteractiveBrowserRuntime({
      ctx: this.ctx, browser: this.env.BROWSER, loader: this.env.LOADER, runtimeName: leaseRow.runtime_name,
      domainAllowlist: task.domains,
      session: { mode: "dynamic", key: leaseRow.session_key, recording: task.recording },
    });
    const evidence: Array<{ action: string; status: string; detail?: string }> = [];
    const started = Date.now();
    try {
      for (let index = 0; index < task.actions.length; index += 1) {
        const compiled = compileBrowserTypedAction(task.actions[index]);
        const committed = this.sql<BrowserActionCheckpointRow>`SELECT * FROM browser_action_checkpoints
          WHERE task_id=${taskId} AND action_index=${index} AND state='completed'`[0] ?? null;
        if (committed) {
          if (committed.action_kind !== compiled.action.kind || Number(committed.logical_step_cost) !== compiled.logicalStepCost
            || (committed.mutating === 1) !== compiled.descriptor.mutating) throw new Error("browser_action_checkpoint_mismatch");
          evidence.push({ action: compiled.action.kind, status: "completed", ...(committed.result_json ? { detail: committed.result_json } : {}) });
          continue;
        }
        const gate = await this.awaitBrowserLeaseAction(taskId, compiled.descriptor, signal);
        leaseRow = gate.lease;
        const checkpoint = this.beginBrowserAction(
          taskId, index, compiled.action.kind, compiled.logicalStepCost, compiled.descriptor.mutating,
        );
        if (!checkpoint.replay) {
          evidence.push({ action: compiled.action.kind, status: "completed", ...(checkpoint.completedDetail ? { detail: checkpoint.completedDetail } : {}) });
          continue;
        }
        this.recordTaskProgress(taskId, "browser.action_started", this.browserActionProgressSummary(compiled.action.kind, index, task.actions.length), {
          phase: "browser", action: compiled.action.kind, step: index + 1, total: task.actions.length,
        });
        let detail: string | undefined;
        if (compiled.code) {
          const output = await runtime.execute(compiled.code);
          if (output.status === "error") throw new Error(`browser_task_action_error:${output.error.slice(0, 200)}`);
          if (output.status !== "completed") throw new Error("browser_task_unexpected_handoff");
          detail = this.boundedBrowserActionResult(output.result);
        }
        this.commitBrowserAction(taskId, index, detail);
        evidence.push({ action: compiled.action.kind, status: "completed", ...(detail ? { detail } : {}) });
        this.recordTaskProgress(taskId, "browser.action_completed", `已完成第 ${index + 1}/${task.actions.length} 个浏览器动作`, {
          phase: "browser", action: compiled.action.kind, step: index + 1, total: task.actions.length,
        });
        const current = this.browserTaskLease(taskId);
        if (gate.stepOnce && current?.state === "active") {
          this.sql`UPDATE browser_task_leases SET state='paused',step_once=0,revision=revision+1,updated_at=${new Date().toISOString()} WHERE id=${current.id}`;
        }
      }
      const now = new Date().toISOString();
      const elapsed = Math.max(1, Date.now() - started);
      this.sql`UPDATE browser_task_leases SET state='completed',step_once=0,revision=revision+1,updated_at=${now} WHERE id=${leaseRow.id}`;
      this.sql`UPDATE browser_executions SET status='completed',result_json=${JSON.stringify({ actions: evidence })},updated_at=${now} WHERE execution_id=${leaseRow.execution_id}`;
      this.sql`UPDATE browser_runs SET status='completed',browser_ms=${elapsed},finished_at=${now} WHERE id=${runId}`;
      await runtime.connector.closeSession().catch(() => undefined);
      this.sql`UPDATE browser_sessions SET state='closed',last_used_at=${now} WHERE session_key=${leaseRow.session_key}`;
      this.recordBrowserEvent(leaseRow.execution_id ?? leaseRow.id, taskId, "typed_task.completed", { status: "completed", mode: task.interactionMode, domains: task.domains, wallMs: elapsed });
      return {
        status: "completed",
        summary: `Completed ${evidence.length} typed browser actions under site profile ${leaseRow.site_profile_id}.`,
        facts: evidence.map((item) => ({ claim: `${item.action}: ${item.status}${item.detail ? ` - ${item.detail}` : ""}`, source: `https://${task.domains[0]}` })),
        artifacts: [], state_delta: [{ kind: "browser_task", target: task.domains[0] }], approval: null,
        cache: { status: "bypass", key_prefix: "browser.task" }, timing: { total_ms: elapsed, browser_ms: elapsed }, warnings: [],
        execution_id: leaseRow.execution_id,
      };
    } catch (error) {
      const now = new Date().toISOString();
      const code = error instanceof Error ? error.message.slice(0, 200) : "browser_task_failed";
      const globallyPaused = this.sandboxControlSnapshot().paused;
      const cancelled = !globallyPaused && (signal.aborted || this.isTaskCancelled(taskId));
      const uncertainMutation = this.sql<CountRow>`SELECT COUNT(*) AS count FROM browser_action_checkpoints
        WHERE task_id=${taskId} AND state='started' AND mutating=1`[0]?.count ?? 0;
      if (uncertainMutation > 0) {
        this.sql`UPDATE browser_action_checkpoints SET state='attention_required',updated_at=${now}
          WHERE task_id=${taskId} AND state='started' AND mutating=1`;
      }
      this.sql`UPDATE browser_task_leases SET state=${globallyPaused ? "paused" : cancelled ? "revoked" : uncertainMutation > 0 ? "paused" : "expired"},revision=revision+1,updated_at=${now} WHERE id=${leaseRow.id} AND state<>'completed'`;
      this.sql`UPDATE browser_executions SET status=${globallyPaused ? "paused" : cancelled ? "cancelled" : "failed"},updated_at=${now} WHERE execution_id=${leaseRow.execution_id}`;
      this.sql`UPDATE browser_runs SET status=${globallyPaused ? "paused" : cancelled ? "cancelled" : "failed"},error_code=${code},browser_ms=${Math.max(1, Date.now() - started)},finished_at=${now} WHERE id=${runId}`;
      await runtime.connector.closeSession().catch(() => undefined);
      this.sql`UPDATE browser_sessions SET state=${globallyPaused ? "closed" : cancelled ? "revoked" : "closed"},last_used_at=${now} WHERE session_key=${leaseRow.session_key}`;
      throw error;
    }
  }

  private browserActionProgressSummary(kind: string, index: number, total: number): string {
    const labels: Record<string, string> = { navigate: "正在打开页面", follow_link: "正在跟随页面链接", next_page: "正在翻到下一页", inspect: "正在读取页面", wait_for: "正在等待页面就绪", scroll: "正在滚动页面", click: "正在点选页面", fill: "正在填写表单", select: "正在选择选项", submit: "正在提交表单", answer_radio_groups: "正在逐题作答", screenshot: "正在截取页面", checkpoint: "正在核对进度" };
    return `${labels[kind] ?? "正在执行浏览器动作"}（${index + 1}/${total}）`;
  }

  private boundedBrowserActionResult(value: unknown): string | undefined {
    try {
      const serialized = JSON.stringify(sanitizeBrowserEvidenceForPersistence(value));
      if (!serialized || serialized === "null" || serialized === "{}") return undefined;
      return serialized.slice(0, 4_000);
    } catch {
      return "[unserializable result]";
    }
  }

  private async invokeInteractiveBrowser(args: Record<string, unknown>, taskId: string): Promise<unknown> {
    if (!this.browserInteractiveEnabled() || !this.env.BROWSER || !this.env.LOADER) throw new Error("browser_interactive_disabled");
    this.assertBrowserFreeBudget();
    const input = this.delegatedTaskInput(taskId);
    if (!input) throw new Error("browser_task_scope_missing");
    const globalAllowlist = this.browserAllowlistForCall({ serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "browser_execute", args }, taskId);
    const validated = validateInteractiveBrowserInput({
      code: String(args.code ?? ""),
      domains: Array.isArray(args.domains) ? args.domains.map(String) : [],
      mode: typeof args.mode === "string" ? args.mode as InteractiveBrowserMode : undefined,
      sessionKey: typeof args.session_key === "string" ? args.session_key : undefined,
      recording: args.recording === true,
    }, globalAllowlist);
    await this.dispatchHooks("before_browser_action", input, {
      taskId, action: "browser_execute", domains: validated.domains, mode: validated.mode,
    });

    const runId = crypto.randomUUID();
    const runtimeName = `operia-browser-${runId}`;
    const ownerScopeHash = await this.sha256(JSON.stringify({ ownerId: input.ownerId, serviceId: input.serviceId, chatId: input.chatId }));
    const sessionKey = `operia:${ownerScopeHash.slice(0, 24)}:${validated.sessionKey}`;
    const startedAt = new Date().toISOString();
    this.sql`INSERT INTO browser_runs (id,task_id,owner_id,service_id,chat_id,action,url_host,status,started_at)
      VALUES (${runId},${taskId},${input.ownerId},${input.serviceId},${input.chatId},${"browser_execute"},${validated.domains[0]},'running',${startedAt})`;
    const browserRuntime = createInteractiveBrowserRuntime({
      ctx: this.ctx,
      browser: this.env.BROWSER,
      loader: this.env.LOADER,
      runtimeName,
      domainAllowlist: validated.domains,
      session: { mode: validated.mode, key: sessionKey, recording: validated.recording },
    });
    if (validated.mode !== "one-shot") {
      const expiresAt = new Date(Date.now() + BROWSER_INTERACTIVE_KEEP_ALIVE_MS).toISOString();
      this.sql`INSERT INTO browser_sessions (session_key,owner_scope_hash,mode,state,last_url_origin,created_at,last_used_at,expires_at)
        VALUES (${sessionKey},${ownerScopeHash},${validated.mode},'active',${`https://${validated.domains[0]}`},${startedAt},${startedAt},${expiresAt})
        ON CONFLICT(session_key) DO UPDATE SET mode=${validated.mode},state='active',last_url_origin=${`https://${validated.domains[0]}`},
          last_used_at=${startedAt},expires_at=${expiresAt}`;
    }
    const started = Date.now();
    try {
      const output = await browserRuntime.execute(validated.code);
      const elapsed = Math.max(1, Date.now() - started);
      const now = new Date().toISOString();
      this.sql`UPDATE browser_runs SET status=${output.status === "paused" ? "paused" : output.status},browser_ms=${elapsed},
        error_code=${output.status === "error" ? output.error.slice(0, 160) : null},finished_at=${now} WHERE id=${runId}`;
      const evidence = output.status === "completed" ? this.completedBrowserResult(output, elapsed, validated.domains) : null;
      const safePending = output.status === "paused" ? this.sanitizeBrowserPending(output.pending) : null;
      this.sql`INSERT INTO browser_executions (execution_id,task_id,runtime_name,mode,session_key,domains_json,recording,status,
        pending_json,result_json,created_at,updated_at)
        VALUES (${output.executionId},${taskId},${runtimeName},${validated.mode},${sessionKey},${JSON.stringify(validated.domains)},
          ${validated.recording ? 1 : 0},${output.status},${safePending ? JSON.stringify(safePending) : null},
          ${evidence ? JSON.stringify(evidence) : null},${startedAt},${now})
        ON CONFLICT(execution_id) DO UPDATE SET status=${output.status},pending_json=${safePending ? JSON.stringify(safePending) : null},
          result_json=${evidence ? JSON.stringify(evidence) : null},updated_at=${now}`;
      this.recordBrowserEvent(output.executionId, taskId, `execution.${output.status}`, {
        status: output.status, mode: validated.mode, domains: validated.domains, wallMs: elapsed,
        pendingCount: output.status === "paused" ? output.pending.length : 0,
      });
      if (output.status === "error") throw new Error(`browser_execution_error:${output.error.slice(0, 240)}`);
      if (output.status === "paused") return this.deferredBrowserApproval(output.executionId, safePending ?? []);
      this.audit("browser.interactive.completed", `context-service:${input.serviceId}`, taskId, {
        executionId: output.executionId, domains: validated.domains, mode: validated.mode, wallMs: elapsed,
      });
      return evidence;
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 160) : "browser_execution_failed";
      this.sql`UPDATE browser_runs SET status='failed',error_code=${code},finished_at=${new Date().toISOString()} WHERE id=${runId} AND status='running'`;
      this.audit("browser.interactive.failed", `context-service:${input.serviceId}`, taskId, { domains: validated.domains, code });
      throw error;
    }
  }

  private async runBrowserProductionSmoke(): Promise<Response> {
    if (!this.browserEnabled() || !this.env.BROWSER) return json({ error: "browser_disabled" }, { status: 503 });
    this.assertBrowserFreeBudget();
    const url = "https://developers.cloudflare.com/agents/tools/browser/";
    const allowlist = this.browserDomainAllowlist();
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    this.sql`INSERT INTO browser_runs (id,task_id,owner_id,service_id,chat_id,action,url_host,status,started_at)
      VALUES (${runId},'control-smoke','control-owner','agent-console','control-chat','browser_markdown','developers.cloudflare.com','running',${startedAt})`;
    try {
      const result = await executeBrowserQuickAction(this.env.BROWSER, { action: "browser_markdown", url }, allowlist);
      const text = typeof result.value === "string" ? result.value : JSON.stringify(result.value);
      this.sql`UPDATE browser_runs SET status='completed',browser_ms=${result.browserMsUsed},finished_at=${new Date().toISOString()} WHERE id=${runId}`;
      this.audit("browser.production_smoke.completed", "agent-console", runId, { host: "developers.cloudflare.com", browserMs: result.browserMsUsed });
      return json({ ok: true, runId, host: "developers.cloudflare.com", browserMs: result.browserMsUsed, outputBytes: new TextEncoder().encode(text).byteLength });
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 160) : "browser_smoke_failed";
      this.sql`UPDATE browser_runs SET status='failed',error_code=${code},finished_at=${new Date().toISOString()} WHERE id=${runId}`;
      return json({ error: code, runId }, { status: 502 });
    }
  }

  private browserControlBinding(): { ownerId: string; serviceId: string } | null {
    const ownerId = this.env.AGENT_CONTEXT_OWNER_ID?.trim();
    const serviceId = this.env.AGENT_CONTEXT_SERVICE_ID?.trim() || "telegram-agent";
    return ownerId ? { ownerId, serviceId } : null;
  }

  private async startInteractiveBrowserCanary(): Promise<Response> {
    const binding = this.browserControlBinding();
    if (!binding) return json({ error: "browser_e2e_owner_not_configured" }, { status: 503 });
    const taskId = `browser-e2e-${crypto.randomUUID()}`;
    const args = {
      code: `async () => {
  const { targetId } = await cdp.send({ method: "Target.createTarget", params: { url: "https://developers.cloudflare.com/agents/tools/browser/" } });
  const harmlessText = "process globalThis fetch() Function() cdp.humanHandoff";
  await cdp.humanHandoff({ reason: "Read-only production browser_execute E2E: " + harmlessText, proposedAction: "Resume, evaluate a harmless static string length, and return a marker; no click, input, submit, or further navigation." });
  const evaluated = await cdp.send({ method: "Runtime.evaluate", params: { expression: "(() => { const label = 'process globalThis fetch() Function()'; return label.length; })()", returnByValue: true } });
  return { e2e: "browser_execute_resume_ok", evaluated };
}`,
      domains: ["developers.cloudflare.com"],
      mode: "dynamic",
      session_key: `control-e2e-${Date.now()}`,
      recording: false,
    };
    const input: DelegatedTaskInput = {
      mode: "direct",
      taskId,
      idempotencyKey: `control-browser-e2e:${taskId}`,
      capsuleId: "control-browser-e2e",
      instruction: "Run the fixed read-only interactive browser production canary.",
      directCall: { serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "browser_execute", args },
      namespace: "default",
      chatId: taskId,
      recipient: "browser-control",
      purpose: "browser_interactive_production_e2e",
      requestHash: await canonicalArgsHash(args),
      ownerId: binding.ownerId,
      serviceId: binding.serviceId,
    };
    const checkpoint: ToolTaskCheckpoint = {
      taskId, status: "executing", round: 0, callCount: 0, completedCallKeys: [], results: [],
    };
    const now = new Date().toISOString();
    const scopedFiberKey = this.scopedTaskFiberKey(input.ownerId, input.serviceId, input.idempotencyKey);
    this.sql`INSERT INTO delegated_tasks
      (id,idempotency_key,client_idempotency_key,owner_id,service_id,chat_id,root_task_id,parent_task_id,
       task_revision,pause_generation,status,input_json,checkpoint_json,repair_generation,created_at,updated_at)
      VALUES (${taskId},${scopedFiberKey},${input.idempotencyKey},${input.ownerId},${input.serviceId},${input.chatId},
        ${input.rootTaskId || input.taskId},${input.parentTaskId ?? null},1,0,'executing',${JSON.stringify(input)},
        ${JSON.stringify(checkpoint)},0,${now},${now})`;
    try {
      const raw = await this.invokeMcpTool(input.directCall, `${taskId}:browser:browser_execute:${input.requestHash}`, taskId, new AbortController().signal);
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as Record<string, unknown>).kind !== "deferred_tool_approval") {
        throw new Error("browser_e2e_handoff_missing");
      }
      const pendingCall = (raw as unknown as DeferredToolApproval).pendingCall;
      this.persistTaskCheckpoint({ ...checkpoint, status: "approval_required", pendingCall });
      const prepared = await this.prepareApproval({ taskId }, binding);
      const payload = await prepared.json<Record<string, unknown>>().catch(() => ({}));
      return json({ ...payload, taskId }, { status: prepared.status });
    } catch (error) {
      this.failDelegatedTask(taskId, error instanceof Error ? error.message : "browser_e2e_failed");
      throw error;
    }
  }

  private async decideBrowserControlApproval(ticketId: string, body: Record<string, unknown>): Promise<Response> {
    const binding = this.browserControlBinding();
    if (!binding) return json({ error: "browser_e2e_owner_not_configured" }, { status: 503 });
    const action = body.action === "approve" || body.action === "reject" ? body.action : null;
    if (!action) return json({ error: "invalid_browser_approval_action" }, { status: 422 });
    const ticket = this.sql<ApprovalTicketRow>`SELECT * FROM approval_ticket_calls WHERE id=${ticketId}`[0];
    if (!ticket || ticket.server_id !== BROWSER_PROVIDER_SERVER_ID || ticket.tool_name !== "browser_resume") {
      return json({ error: "browser_approval_not_found" }, { status: 404 });
    }
    const task = this.sql<{ input_json: string }>`SELECT input_json FROM delegated_tasks WHERE id=${ticket.task_id}`[0];
    const input = task ? this.parseJson<DelegatedTaskInput | null>(task.input_json, null) : null;
    if (input?.purpose !== "browser_interactive_production_e2e") {
      return json({ error: "browser_control_approval_forbidden" }, { status: 403 });
    }
    return await this.forwardApprovalDecision({
      ticketId, action: action === "approve" ? "once" : "reject", ownerId: ticket.owner_id, chatId: ticket.chat_id,
    }, binding);
  }

  private async approveLatestInteractiveBrowserCanary(): Promise<Response> {
    const rows = this.sql<ApprovalTicketRow>`SELECT * FROM approval_ticket_calls
      WHERE server_id=${BROWSER_PROVIDER_SERVER_ID} AND tool_name='browser_resume' AND status IN ('pending','attention_required')
      ORDER BY created_at DESC LIMIT 10`;
    for (const ticket of rows) {
      const task = this.sql<{ input_json: string }>`SELECT input_json FROM delegated_tasks WHERE id=${ticket.task_id}`[0];
      const input = task ? this.parseJson<DelegatedTaskInput | null>(task.input_json, null) : null;
      if (input?.purpose === "browser_interactive_production_e2e") {
        return await this.decideBrowserControlApproval(ticket.id, { action: "approve" });
      }
    }
    return json({ error: "pending_browser_e2e_not_found" }, { status: 404 });
  }

  private async latestInteractiveBrowserCanaryStatus(): Promise<Response> {
    const tickets = this.sql<ApprovalTicketRow>`SELECT * FROM approval_ticket_calls
      WHERE server_id=${BROWSER_PROVIDER_SERVER_ID} AND tool_name='browser_resume'
      ORDER BY created_at DESC LIMIT 10`;
    for (const ticket of tickets) {
      const task = this.sql<{ input_json: string; checkpoint_json: string | null; status: string }>`SELECT input_json,checkpoint_json,status
        FROM delegated_tasks WHERE id=${ticket.task_id}`[0];
      const input = task ? this.parseJson<DelegatedTaskInput | null>(task.input_json, null) : null;
      if (input?.purpose !== "browser_interactive_production_e2e") continue;
      let workflowStatus: unknown = null;
      try { workflowStatus = await (await this.env.APPROVAL_WORKFLOW.get(ticket.workflow_id)).status(); } catch { workflowStatus = { status: "unavailable" }; }
      const approvalArgs = this.parseJson<Record<string, unknown>>(ticket.args_json, {});
      const executionId = typeof approvalArgs.execution_id === "string" ? approvalArgs.execution_id : "";
      const browserExecution = executionId ? this.browserExecution(executionId) : this.browserExecutionForTask(ticket.task_id);
      let codemodeExecution: { status: string; error?: string } | null = null;
      if (browserExecution) {
        try {
          const runtime = this.browserRuntimeForRow(browserExecution).runtime;
          const state = (await runtime.executions(20)).find((item) => item.id === browserExecution.execution_id);
          if (state) codemodeExecution = { status: state.status, ...(state.error ? { error: state.error.slice(0, 240) } : {}) };
        } catch (error) {
          codemodeExecution = { status: "unavailable", error: error instanceof Error ? error.message.slice(0, 240) : "codemode_status_failed" };
        }
      }
      const callKey = `${ticket.task_id}:${ticket.server_id}:${ticket.tool_name}:${ticket.args_hash}`;
      const sideEffect = this.sql<{ status: string }>`SELECT status FROM tool_side_effects WHERE call_key=${callKey}`[0] ?? null;
      return json({
        taskId: ticket.task_id,
        taskStatus: task?.status ?? "missing",
        ticketId: ticket.id,
        ticketStatus: ticket.status,
        attentionError: ticket.attention_error,
        workflowStatus,
        browserExecutionStatus: browserExecution?.status ?? "missing",
        codemodeExecution,
        sideEffectStatus: sideEffect?.status ?? "missing",
        checkpoint: task?.checkpoint_json ? this.parseJson(task.checkpoint_json, null) : null,
      });
    }
    return json({ error: "browser_e2e_not_found" }, { status: 404 });
  }

  private async resumeInteractiveBrowser(args: Record<string, unknown>, taskId: string): Promise<unknown> {
    const executionId = typeof args.execution_id === "string" ? args.execution_id : "";
    const row = this.browserExecution(executionId);
    if (!row || row.task_id !== taskId) throw new Error("browser_execution_scope_mismatch");
    this.browserAllowlistForCall({ serverId: BROWSER_PROVIDER_SERVER_ID, toolName: "browser_resume", args }, taskId);
    if (row.status === "completed" && row.result_json) return this.parseJson(row.result_json, {});
    if (row.status !== "paused") throw new Error("browser_execution_not_paused");
    const browserRuntime = this.browserRuntimeForRow(row);
    const started = Date.now();
    let output: Awaited<ReturnType<typeof browserRuntime.runtime.approve>>;
    try {
      output = await browserRuntime.runtime.approve({ executionId });
    } catch (error) {
      if (isInteractiveBrowserSessionExpired(error)) {
        this.markInteractiveBrowserExecutionExpired(row);
        throw new Error("browser_session_expired_retry_required");
      }
      throw error;
    }
    if (output.status === "error" && isInteractiveBrowserSessionExpired(output.error)) {
      this.markInteractiveBrowserExecutionExpired(row);
      throw new Error("browser_session_expired_retry_required");
    }
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + BROWSER_INTERACTIVE_KEEP_ALIVE_MS).toISOString();
    const domains = this.parseJson<string[]>(row.domains_json, []);
    const evidence = output.status === "completed" ? this.completedBrowserResult(output, Math.max(1, Date.now() - started), domains) : null;
    const safePending = output.status === "paused" ? this.sanitizeBrowserPending(output.pending) : null;
    this.sql`UPDATE browser_executions SET status=${output.status},pending_json=${safePending ? JSON.stringify(safePending) : null},
      result_json=${evidence ? JSON.stringify(evidence) : null},updated_at=${now} WHERE execution_id=${executionId}`;
    this.sql`UPDATE browser_sessions SET state=${output.status === "completed" ? "active" : output.status},last_used_at=${now},expires_at=${expiresAt}
      WHERE session_key=${row.session_key}`;
    this.recordBrowserEvent(executionId, taskId, `approval.${output.status}`, {
      status: output.status, mode: row.mode, pendingCount: output.status === "paused" ? output.pending.length : 0,
    });
    if (output.status === "error") throw new Error(`browser_resume_error:${output.error.slice(0, 240)}`);
    if (output.status === "paused") throw new Error("browser_second_approval_forbidden");
    return evidence;
  }

  private markInteractiveBrowserExecutionExpired(row: BrowserExecutionRow): void {
    const now = new Date().toISOString();
    this.sql`UPDATE browser_executions SET status='expired',pending_json=NULL,updated_at=${now}
      WHERE execution_id=${row.execution_id}`;
    this.sql`UPDATE browser_sessions SET state='expired',last_used_at=${now} WHERE session_key=${row.session_key}`;
    this.sql`UPDATE browser_runs SET status='failed',error_code='browser_session_expired_retry_required',finished_at=${now}
      WHERE task_id=${row.task_id} AND action='browser_execute' AND status='paused'`;
    this.recordBrowserEvent(row.execution_id, row.task_id, "execution.expired", { reason: "browser_rendering_gone" });
    this.audit("browser.interactive.expired", "agent-runtime", row.execution_id, { taskId: row.task_id });
  }

  private browserExecution(executionId: string): BrowserExecutionRow | null {
    if (!executionId || executionId.length > 160) return null;
    return this.sql<BrowserExecutionRow>`SELECT execution_id,task_id,runtime_name,mode,session_key,domains_json,recording,status,
      pending_json,result_json,created_at,updated_at FROM browser_executions WHERE execution_id=${executionId}`[0] ?? null;
  }

  private browserExecutionForTask(taskId: string): BrowserExecutionRow | null {
    return this.sql<BrowserExecutionRow>`SELECT execution_id,task_id,runtime_name,mode,session_key,domains_json,recording,status,
      pending_json,result_json,created_at,updated_at FROM browser_executions WHERE task_id=${taskId}
      ORDER BY created_at DESC LIMIT 1`[0] ?? null;
  }

  private browserRuntimeForRow(row: BrowserExecutionRow) {
    if (!this.browserInteractiveEnabled() || !this.env.BROWSER || !this.env.LOADER) throw new Error("browser_interactive_disabled");
    const domains = this.parseJson<string[]>(row.domains_json, []);
    if (domains.length === 0) throw new Error("browser_execution_domains_missing");
    return createInteractiveBrowserRuntime({
      ctx: this.ctx,
      browser: this.env.BROWSER,
      loader: this.env.LOADER,
      runtimeName: row.runtime_name,
      domainAllowlist: domains,
      session: { mode: row.mode, key: row.session_key, recording: row.recording === 1 },
    });
  }

  private browserAllowlistForCall(call: { serverId: string; toolName: string; args: unknown }, taskId: string): string[] {
    const domain = this.browserDomainDecisionForCall(call, taskId);
    if (!domain) return this.browserDomainAllowlist();
    if (domain.decision.status === "approval_required") throw new Error(`browser_domain_approval_required:${domain.decision.unknownHosts.join(",")}`);
    if (domain.decision.status === "denied") throw new Error(`browser_domain_denied:${domain.decision.denyCode ?? "policy"}`);
    return mergeBrowserDomainInputs(
      this.browserDomainAllowlist(),
      this.activeBrowserGrantHosts(taskId),
      domain.targetHosts,
    );
  }

  private consumeOnceBrowserDomainGrants(call: { serverId: string; toolName: string; args: unknown }, taskId: string): void {
    const domain = this.browserDomainDecisionForCall(call, taskId);
    if (!domain || domain.decision.status !== "allowed") return;
    const now = new Date().toISOString();
    for (const hostname of domain.targetHosts) {
      const grant = this.sql<BrowserDomainGrantRow>`SELECT * FROM browser_domain_grants
        WHERE task_id=${taskId} AND hostname=${hostname} AND scope='once' AND status='active'
        AND expires_at>${now} AND uses_remaining>0 ORDER BY created_at DESC LIMIT 1`[0];
      if (!grant) continue;
      this.sql`UPDATE browser_domain_grants SET uses_remaining=uses_remaining-1,
        status=CASE WHEN uses_remaining<=1 THEN 'consumed' ELSE status END,updated_at=${now}
        WHERE id=${grant.id} AND status='active' AND uses_remaining>0`;
    }
  }

  private isDefinitiveToolFailure(code: string): boolean {
    return /^(policy_denied:|source_|sandbox_execution_|browser_task_initial_navigation_required|browser_(?:domain_|cross_domain_|interactive_|invalid_|url_|host_|execution_scope|execution_not_paused|session_expired)|site_adapter_denied:|invalid_|schema_)/.test(code);
  }

  private deferredBrowserApproval(executionId: string, pending: unknown[]): DeferredToolApproval {
    const action = pending[0] && typeof pending[0] === "object" ? pending[0] as Record<string, unknown> : {};
    const actionArgs = action.args && typeof action.args === "object" && !Array.isArray(action.args)
      ? action.args as Record<string, unknown>
      : {};
    return {
      kind: "deferred_tool_approval",
      pendingCall: {
        serverId: BROWSER_PROVIDER_SERVER_ID,
        toolName: "browser_resume",
        args: {
          execution_id: executionId,
          reason: typeof actionArgs.reason === "string" ? actionArgs.reason : "Browser action needs owner handoff",
          proposed_action: typeof actionArgs.proposedAction === "string" ? actionArgs.proposedAction : "Resume the paused browser execution",
        },
      },
    };
  }

  private sanitizeBrowserPending(pending: unknown[]): unknown[] {
    return pending.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const action = structuredClone(item) as Record<string, unknown>;
      if (action.args && typeof action.args === "object" && !Array.isArray(action.args)) {
        (action.args as Record<string, unknown>).liveViewUrl = "https://agent.example.com/tools/browser";
      }
      return action;
    });
  }

  private completedBrowserResult(output: unknown, browserMs = 0, domains: string[] = []): unknown {
    if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("browser_execution_result_invalid");
    const record = output as Record<string, unknown>;
    if (record.status !== "completed" || typeof record.executionId !== "string") throw new Error("browser_execution_not_completed");
    const serialized = JSON.stringify(redact(record.result ?? null));
    const bounded = serialized.length > 16_000 ? `${serialized.slice(0, 16_000)}...[truncated]` : serialized;
    return {
      status: "completed",
      summary: "Cloud browser execution completed within the declared domain and step budgets.",
      facts: [{ claim: bounded, source: domains[0] ? `https://${domains[0]}` : "browser-session" }],
      artifacts: [],
      state_delta: [{ kind: "none", target: domains[0] ?? "browser-session" }],
      approval: null,
      cache: { status: "bypass", key_prefix: "browser.interactive" },
      timing: { total_ms: browserMs, browser_ms: browserMs },
      warnings: serialized.length > 16_000 ? ["result_truncated"] : [],
      execution_id: record.executionId,
    };
  }

  private recoverCompletedBrowserResume(call: { args: unknown }): { ok: true; value: unknown } | { ok: false } {
    const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {};
    const row = this.browserExecution(typeof args.execution_id === "string" ? args.execution_id : "");
    if (!row || row.status !== "completed" || !row.result_json) return { ok: false };
    return { ok: true, value: this.parseJson(row.result_json, {}) };
  }

  private recordBrowserEvent(executionId: string, taskId: string, eventType: string, detail: unknown): void {
    const input = detail && typeof detail === "object" && !Array.isArray(detail) ? detail as Record<string, unknown> : {};
    const safeDetail = {
      status: typeof input.status === "string" ? input.status : undefined,
      mode: typeof input.mode === "string" ? input.mode : undefined,
      domains: Array.isArray(input.domains) ? input.domains.map(String).slice(0, 8) : undefined,
      wallMs: typeof input.wallMs === "number" ? input.wallMs : undefined,
      pendingCount: typeof input.pendingCount === "number" ? input.pendingCount : undefined,
      reason: typeof input.reason === "string" ? input.reason.slice(0, 120) : undefined,
      source: typeof input.source === "string" ? input.source.slice(0, 80) : undefined,
    };
    this.sql`INSERT INTO browser_task_events (id,execution_id,task_id,event_type,detail_json,created_at)
      VALUES (${crypto.randomUUID()},${executionId},${taskId},${eventType},${JSON.stringify(safeDetail)},${new Date().toISOString()})`;
  }

  private async rejectInteractiveBrowserApproval(ticket: ApprovalTicketRow): Promise<void> {
    if (ticket.server_id !== BROWSER_PROVIDER_SERVER_ID || ticket.tool_name !== "browser_resume") return;
    const args = this.parseJson<Record<string, unknown>>(ticket.args_json, {});
    const executionId = typeof args.execution_id === "string" ? args.execution_id : "";
    await this.rejectInteractiveBrowserExecution(executionId, "outer_approval_rejected");
  }

  private async rejectInteractiveBrowserExecutionsForTask(taskId: string): Promise<void> {
    const rows = this.sql<{ execution_id: string }>`SELECT execution_id FROM browser_executions WHERE task_id=${taskId} AND status='paused'`;
    for (const row of rows) await this.rejectInteractiveBrowserExecution(row.execution_id, "task_cancelled");
  }

  private async closeTypedBrowserTaskSession(taskId: string): Promise<void> {
    const lease = this.browserTaskLease(taskId);
    if (!lease || !lease.execution_id || !this.browserInteractiveEnabled()) return;
    const execution = this.browserExecution(lease.execution_id);
    if (!execution) return;
    try {
      await this.browserRuntimeForRow(execution).connector.closeSession();
      this.sql`UPDATE browser_sessions SET state='revoked',last_used_at=${new Date().toISOString()} WHERE session_key=${lease.session_key}`;
      this.sql`UPDATE browser_executions SET status='cancelled',updated_at=${new Date().toISOString()}
        WHERE execution_id=${lease.execution_id} AND status='running'`;
    } catch (error) {
      this.audit("browser.typed_session.close_failed", "agent-runtime", lease.execution_id, {
        error: error instanceof Error ? error.message : "browser_close_failed",
      });
    }
  }

  private async rejectInteractiveBrowserExecution(executionId: string, reason: string): Promise<void> {
    const row = this.browserExecution(executionId);
    if (!row || row.status !== "paused") return;
    try {
      const browserRuntime = this.browserRuntimeForRow(row);
      const pending = await browserRuntime.runtime.pending(executionId);
      const action = pending[0];
      if (action) await browserRuntime.runtime.reject({ executionId, seq: action.seq });
      this.sql`UPDATE browser_executions SET status='rejected',pending_json=NULL,updated_at=${new Date().toISOString()}
        WHERE execution_id=${executionId} AND status='paused'`;
      this.sql`UPDATE browser_sessions SET state='rejected',last_used_at=${new Date().toISOString()} WHERE session_key=${row.session_key}`;
      this.recordBrowserEvent(executionId, row.task_id, "execution.rejected", { reason });
    } catch (error) {
      this.audit("browser.execution.reject_failed", "agent-runtime", executionId, {
        reason, error: error instanceof Error ? error.message : "browser_reject_failed",
      });
    }
  }

  private async interactiveBrowserLiveView(executionId: string): Promise<Response> {
    const row = this.browserExecution(executionId);
    if (!row) return json({ error: "browser_execution_not_found" }, { status: 404 });
    const pending = row.pending_json ? this.parseJson<unknown[]>(row.pending_json, []) : [];
    let live: unknown = null;
    if (row.mode !== "one-shot") {
      try { live = await this.browserRuntimeForRow(row).connector.liveView({ mode: "tab" }); } catch { live = null; }
    }
    return json({ executionId, status: row.status, mode: row.mode, pending, live });
  }

  private async closeInteractiveBrowserSession(executionId: string): Promise<Response> {
    const row = this.browserExecution(executionId);
    if (!row) return json({ error: "browser_execution_not_found" }, { status: 404 });
    if (row.status === "paused") await this.rejectInteractiveBrowserExecution(executionId, "session_closed");
    const current = this.browserExecution(executionId) ?? row;
    await this.browserRuntimeForRow(current).connector.closeSession();
    this.sql`UPDATE browser_sessions SET state='closed',last_used_at=${new Date().toISOString()} WHERE session_key=${current.session_key}`;
    this.recordBrowserEvent(executionId, row.task_id, "session.closed", { source: "control_console" });
    return json({ ok: true, executionId });
  }

  private delegatedTaskInput(taskId: string): DelegatedTaskInput | null {
    const row = this.sql<{ input_json: string }>`SELECT input_json FROM delegated_tasks WHERE id=${taskId}`[0];
    return row ? this.parseJson<DelegatedTaskInput | null>(row.input_json, null) : null;
  }

  private defaultVoiceProfile(): { voiceId: string; voiceSettings?: { stability?: number; similarityBoost?: number; style?: number; speed?: number } } | null {
    const stored = this.sql<{ voice_id: string; settings_json: string }>`SELECT voice_id,settings_json FROM voice_profiles WHERE is_default=1 LIMIT 1`[0];
    if (stored) {
      const settings = this.parseJson<Record<string, unknown>>(stored.settings_json, {});
      return { voiceId: stored.voice_id, voiceSettings: {
        stability: typeof settings.stability === "number" ? settings.stability : undefined,
        similarityBoost: typeof settings.similarity === "number" ? settings.similarity : undefined,
        style: typeof settings.style === "number" ? settings.style : undefined,
        speed: typeof settings.speed === "number" ? settings.speed : undefined,
      } };
    }
    const fallback = this.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim();
    return fallback ? { voiceId: fallback } : null;
  }

  private async loadImageReferences(raw: unknown[]): Promise<string[]> {
    if (raw.length > 3) throw new Error("too_many_reference_images");
    const result: string[] = [];
    let totalBytes = 0;
    for (const value of raw) {
      if (typeof value !== "string" || !/^agent-media:[0-9a-f-]{36}$/i.test(value)) throw new Error("invalid_reference_media_ref");
      const id = value.slice("agent-media:".length);
      const object = await this.env.MEDIA.get(id);
      if (!object) throw new Error("reference_media_not_found");
      const expiresAt = object.customMetadata?.expiresAt;
      if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
        await this.env.MEDIA.delete(id);
        throw new Error("reference_media_expired");
      }
      const contentType = object.httpMetadata?.contentType?.split(";", 1)[0].toLowerCase() ?? "";
      if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(contentType)) throw new Error("invalid_reference_media_type");
      if (object.size < 1 || object.size > 5 * 1024 * 1024 || totalBytes + object.size > 12 * 1024 * 1024) throw new Error("reference_media_size");
      const bytes = new Uint8Array(await object.arrayBuffer());
      totalBytes += bytes.byteLength;
      result.push(`data:${contentType};base64,${this.bytesToBase64(bytes)}`);
    }
    return result;
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
    }
    return btoa(binary);
  }

  private grokProviderEnabled(): boolean {
    return this.env.GROK_ENABLED?.trim().toLowerCase() === "true" &&
      Boolean(this.env.XAI_API_KEY?.trim() && this.env.MEMORY_GATEWAY_BROKER_BEARER?.trim());
  }

  private homeAssistantEnabled(): boolean {
    return this.env.HOME_ASSISTANT_ENABLED?.trim().toLowerCase() === "true" &&
      Boolean(this.env.HOME_ASSISTANT_BASE_URL?.trim() && this.env.HOME_ASSISTANT_ACCESS_TOKEN?.trim()) &&
      this.csv(this.env.HOME_ASSISTANT_ENTITY_ALLOWLIST).length > 0 && this.csv(this.env.HOME_ASSISTANT_SERVICE_ALLOWLIST).length > 0;
  }

  private homeAssistantProviderConfig(signal?: AbortSignal) {
    return {
      enabled: this.homeAssistantEnabled(), baseUrl: this.env.HOME_ASSISTANT_BASE_URL, accessToken: this.env.HOME_ASSISTANT_ACCESS_TOKEN,
      entityAllowlist: this.csv(this.env.HOME_ASSISTANT_ENTITY_ALLOWLIST), serviceAllowlist: this.csv(this.env.HOME_ASSISTANT_SERVICE_ALLOWLIST),
      timeoutMs: Math.max(1_000, Math.min(60_000, Number(this.env.PROVIDER_TIMEOUT_MS) || 15_000)), signal,
    };
  }

  private csv(value?: string): string[] {
    return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
  }

  private parseHomeAssistantData(value: unknown): Record<string, unknown> {
    if (value === undefined || value === "") return {};
    if (typeof value !== "string" || value.length > 8_000) throw new Error("invalid_home_assistant_data");
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 32) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error("invalid_home_assistant_data");
    }
  }

  private async storeProviderMedia(bytes: Uint8Array, contentType: string, kind: "image" | "voice"): Promise<string> {
    const id = crypto.randomUUID();
    await this.env.MEDIA.put(id, bytes, {
      httpMetadata: { contentType, cacheControl: "private, no-store" },
      customMetadata: { kind, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() },
    });
    return `agent-media:${id}`;
  }

  private persistTaskCheckpoint(checkpoint: ToolTaskCheckpoint): void {
    const now = new Date().toISOString();
    this.sql`UPDATE delegated_tasks SET status=${checkpoint.status},checkpoint_json=${JSON.stringify(checkpoint)},
      task_revision=task_revision+1,updated_at=${now} WHERE id=${checkpoint.taskId} AND status<>'cancelled'`;
    if (["completed", "failed", "cancelled"].includes(checkpoint.status)) {
      this.sql`UPDATE browser_domain_grants SET status='task_ended',updated_at=${now}
        WHERE task_id=${checkpoint.taskId} AND status='active'`;
      this.sql`UPDATE approval_task_grants SET status='task_ended',updated_at=${now}
        WHERE task_id=${checkpoint.taskId} AND think_task_id IS NULL AND status='active'`;
      this.sql`UPDATE browser_domain_challenges SET status='cancelled',updated_at=${now},decided_at=${now}
        WHERE task_id=${checkpoint.taskId} AND status='pending'`;
    }
    const pending = checkpoint.pendingCall;
    const summary = checkpoint.status === "planning" ? "正在规划下一步"
      : checkpoint.status === "executing" ? `正在调用 ${pending?.serverId ?? "工具"}/${pending?.toolName ?? "执行器"}`
      : checkpoint.status === "approval_required" ? "调用已进入审批步骤"
      : checkpoint.status === "attention_required" ? "任务需要检查后才能继续"
      : checkpoint.status === "completed" ? "任务已完成"
      : checkpoint.status === "failed" ? "任务执行失败"
      : checkpoint.status === "cancelled" ? "任务已停止"
      : checkpoint.status === "paused" ? "任务已暂停"
      : "任务状态已更新";
    this.recordTaskProgress(checkpoint.taskId, `task.${checkpoint.status}`, summary, {
      phase: checkpoint.status, tool: pending ? `${pending.serverId}/${pending.toolName}` : undefined,
      round: checkpoint.round, callCount: checkpoint.callCount,
    });
  }

  private persistThinkActionTerminalCheckpoint(checkpoint: ToolTaskCheckpoint): void {
    const now = new Date().toISOString();
    const updated = this.sql<{ id:string }>`UPDATE delegated_tasks SET status=${checkpoint.status},
      checkpoint_json=${JSON.stringify(checkpoint)},updated_at=${now}
      WHERE id=${checkpoint.taskId} AND status<>'cancelled' RETURNING id`;
    if (updated.length !== 1) throw new Error("think_action_checkpoint_terminal_write_failed");
    try {
      this.recordTaskProgress(checkpoint.taskId,`task.${checkpoint.status}`,"任务已完成",{
        phase:checkpoint.status,round:checkpoint.round,callCount:checkpoint.callCount,
      });
    } catch (error) {
      console.warn("think_action_checkpoint_progress_degraded",{
        code:boundedAgentErrorCode(error,"checkpoint_progress_failed"),
      });
    }
  }

  private setTaskStatusOnly(taskId: string, status: ToolTaskCheckpoint["status"], error?: string): void {
    const checkpoint = this.readTaskCheckpoint(taskId);
    const next = { ...checkpoint, status, ...(error ? { error } : { error: undefined }) };
    this.sql`UPDATE delegated_tasks SET status=${status},checkpoint_json=${JSON.stringify(next)},updated_at=${new Date().toISOString()}
      WHERE id=${taskId} AND status NOT IN ('completed','failed','cancelled')`;
  }

  private recordTaskProgress(taskId: string, eventType: string, safeSummary: string, detail: Record<string, unknown> = {}): void {
    if (!this.taskProgressEnabled()) return;
    const safeDetail = {
      schemaVersion: TASK_PROGRESS_SCHEMA_VERSION,
      phase: typeof detail.phase === "string" ? detail.phase.slice(0, 40) : undefined,
      tool: typeof detail.tool === "string" ? detail.tool.slice(0, 120) : undefined,
      action: typeof detail.action === "string" ? detail.action.slice(0, 60) : undefined,
      profile: typeof detail.profile === "string" ? detail.profile.slice(0, 80) : undefined,
      mode: typeof detail.mode === "string" ? detail.mode.slice(0, 20) : undefined,
      step: typeof detail.step === "number" ? detail.step : undefined,
      total: typeof detail.total === "number" ? detail.total : undefined,
      stepBudget: typeof detail.stepBudget === "number" ? detail.stepBudget : undefined,
      round: typeof detail.round === "number" ? detail.round : undefined,
      callCount: typeof detail.callCount === "number" ? detail.callCount : undefined,
    };
    const now = new Date().toISOString();
    const changed = this.sql<{ progress_revision: number }>`UPDATE delegated_tasks SET progress_revision=progress_revision+1,
      progress_state=${eventType},progress_phase=${safeDetail.phase ?? null},progress_json=${JSON.stringify(safeDetail)},progress_updated_at=${now}
      WHERE id=${taskId} RETURNING progress_revision`[0];
    if (!changed) return;
    this.sql`INSERT INTO task_progress_events (task_id,revision,event_type,safe_summary,detail_json,created_at)
      VALUES (${taskId},${changed.progress_revision},${eventType},${safeSummary.slice(0, 500)},${JSON.stringify(safeDetail)},${now})`;
  }

  private taskProgressSnapshot(taskId: string): Record<string, unknown> | null {
    const row = this.sql<RuntimeRow>`SELECT status,progress_revision,progress_state,progress_phase,progress_json,progress_updated_at,
      root_task_id,pause_generation,outcome
      FROM delegated_tasks WHERE id=${taskId}`[0];
    if (!row) return null;
    const lease = this.browserTaskLease(taskId);
    return {
      taskId,
      status: row.status,
      revision: Number(row.progress_revision ?? 0),
      eventType: row.progress_state,
      phase: row.progress_phase,
      detail: typeof row.progress_json === "string" ? this.parseJson(row.progress_json, {}) : {},
      updatedAt: row.progress_updated_at,
      controls: {
        pause: ["accepted", "planning", "executing", "approval_required", "interrupted"].includes(String(row.status)),
        resume: row.status === "paused",
        step: lease?.state === "paused",
        readOnly: Boolean(lease && lease.mode !== "read" && ["active", "paused"].includes(lease.state)),
        stop: !["completed", "failed", "cancelled", "attention_required"].includes(String(row.status)),
      },
      rootTaskId: row.root_task_id,
      pauseGeneration: Number(row.pause_generation ?? 0),
      outcome: row.outcome,
      browserLease: lease ? {
        id: lease.id, state: lease.state, mode: lease.mode, profileId: lease.site_profile_id,
        usedSteps: Number(lease.used_logical_steps), maxSteps: Number(lease.max_logical_steps), deadlineAt: lease.deadline_at,
      } : null,
    };
  }

  private isTaskCancelled(taskId: string): boolean {
    return this.sql<{ status: string }>`SELECT status FROM delegated_tasks WHERE id = ${taskId}`[0]?.status === "cancelled";
  }

  private markTaskAttention(taskId: string, error: string): void {
    const current = this.readTaskCheckpoint(taskId);
    if (["completed", "failed", "cancelled"].includes(current.status)) return;
    this.persistTaskCheckpoint({
      ...current,
      status: "attention_required",
      error: boundedAgentErrorCode(error, "agent_attention_required")
    });
  }

  private reserveRepairGeneration(taskId: string): { generation: number; marker: string } {
    const current = this.sql<{ repair_generation: number; fiber_id: string | null }>`SELECT repair_generation,fiber_id
      FROM delegated_tasks WHERE id=${taskId}`[0];
    if (!current || current.fiber_id?.startsWith("repair-starting:")) throw new Error("repair_already_starting");
    const previous = Number(current.repair_generation);
    const generation = previous + 1;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("repair_generation_reservation_failed");
    const marker = `repair-starting:${generation}`;
    const changed = this.sql<{ repair_generation: number }>`UPDATE delegated_tasks
      SET repair_generation=${generation},fiber_id=${marker},updated_at=${new Date().toISOString()}
      WHERE id=${taskId} AND repair_generation=${previous}
        AND ((${current.fiber_id} IS NULL AND fiber_id IS NULL) OR fiber_id=${current.fiber_id})
      RETURNING repair_generation`;
    if (changed.length !== 1) throw new Error("repair_already_starting");
    return { generation, marker };
  }

  private readTaskCheckpoint(taskId: string): ToolTaskCheckpoint {
    const row = this.sql<{ checkpoint_json: string | null }>`SELECT checkpoint_json FROM delegated_tasks WHERE id = ${taskId}`[0];
    const checkpoint = row?.checkpoint_json ? this.parseJson<ToolTaskCheckpoint | null>(row.checkpoint_json, null) : null;
    if (!checkpoint) throw new Error("task_checkpoint_missing");
    return checkpoint;
  }

  private failDelegatedTask(taskId: string, error: string, status: "failed" | "interrupted" = "failed"): void {
    const checkpoint = this.readTaskCheckpoint(taskId);
    this.persistTaskCheckpoint({
      ...checkpoint,
      status,
      error: boundedAgentErrorCode(error, status === "interrupted" ? "task_interrupted" : "task_failed")
    });
  }

  private markStartedSideEffectsUncertain(taskId: string, reason: string): number {
    const now = new Date().toISOString();
    const checkpoint = this.readTaskCheckpoint(taskId);
    const pending = checkpoint.pendingCall;
    if (pending?.serverId === BROWSER_PROVIDER_SERVER_ID && pending.toolName === "browser_task") {
      const lease = this.browserTaskLease(taskId);
      const unsafeActions = this.sql<CountRow>`SELECT COUNT(*) AS count FROM browser_action_checkpoints
        WHERE task_id=${taskId} AND (state='attention_required' OR (state='started' AND mutating=1))`[0]?.count ?? 0;
      if (lease && ["active", "paused", "completed"].includes(lease.state) && unsafeActions === 0) {
        const startedCallKeys = this.sql<{ call_key: string }>`SELECT call_key FROM tool_side_effects
          WHERE task_id=${taskId} AND status='started' AND provider_call_completed=0`;
        const authorized: string[] = [];
        for (const { call_key: callKey } of startedCallKeys) {
          const { allowed } = authorizeServerSideContinuation(
            this.sql as unknown as SideEffectSql,
            {
              callKey,
              proof: { kind: "browser_checkpoint_recovery" },
              authorizedBy: { type: "system", id: `browser-checkpoint:${taskId}` },
              now,
            },
          );
          if (allowed) authorized.push(callKey);
        }
        if (authorized.length > 0) {
          this.audit("browser.task.recovery_authorized", "cloudflare:agents-sdk", taskId, {
            reason, completedActions: this.sql<CountRow>`SELECT COUNT(*) AS count FROM browser_action_checkpoints
              WHERE task_id=${taskId} AND state='completed'`[0]?.count ?? 0,
          });
        }
      }
    }
    const changed = markAllStartedOutcomeUnknown(this.sql as unknown as SideEffectSql, { taskId, now });
    const uncertain = Number(this.sql<CountRow>`SELECT COUNT(*) AS count FROM tool_side_effects
      WHERE task_id=${taskId} AND status='uncertain'`[0]?.count ?? 0);
    if (changed.count > 0) {
      this.audit("tool.side_effects.recovery_frozen", "cloudflare:agents-sdk", taskId, {
        reason,
        count: uncertain,
      });
    }
    return uncertain;
  }

  private parseDelegatedTaskInput(body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): DelegatedTaskInput | null {
    const scope = this.parseContextScope(body, binding);
    if (
      !scope ||
      typeof body.taskId !== "string" || body.taskId !== scope.taskId ||
      typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 200 ||
      typeof body.capsuleId !== "string" ||
      typeof body.instruction !== "string" || body.instruction.length < 1 || body.instruction.length > 8000
    ) return null;
    const rootTaskId = typeof body.rootTaskId === "string" && /^[A-Za-z0-9:_-]{1,200}$/.test(body.rootTaskId)
      ? body.rootTaskId : body.taskId;
    const parentTaskId = body.parentTaskId === undefined ? undefined
      : typeof body.parentTaskId === "string" && /^[A-Za-z0-9:_-]{1,200}$/.test(body.parentTaskId)
        ? body.parentTaskId : null;
    if (parentTaskId === null || parentTaskId === body.taskId) return null;
    const base = { ...scope, taskId: body.taskId, idempotencyKey: body.idempotencyKey, capsuleId: body.capsuleId,
      instruction: body.instruction, rootTaskId, ...(parentTaskId ? { parentTaskId } : {}) };
    if (body.mode !== "direct") return base;
    const rawCall = body.directCall;
    if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) return null;
    const call = rawCall as Record<string, unknown>;
    if (typeof call.serverId !== "string" || typeof call.toolName !== "string" || !call.args || typeof call.args !== "object" || Array.isArray(call.args)) return null;
    const allowedDirectTools = new Set(["browser/browser_markdown", "grok/search_web", "grok/generate_image", "voice/speak"]);
    if (this.env.AGENT_SANDBOX_CANARY_ENABLED?.trim().toLowerCase() === "true") {
      allowedDirectTools.add(`${SANDBOX_RUNTIME_PROVIDER_SERVER_ID}/execute_script`);
      allowedDirectTools.add(`${SANDBOX_CODEMODE_PROVIDER_SERVER_ID}/execute_read_plan`);
    }
    if (!allowedDirectTools.has(`${call.serverId}/${call.toolName}`)) return null;
    return { ...base, mode: "direct", directCall: { serverId: call.serverId, toolName: call.toolName, args: call.args as never } };
  }

  private audit(eventType: string, actor: string, target: string | null, detail: unknown): void {
    this.sql`INSERT INTO audit_log (id, event_type, actor, target, detail_json, created_at)
      VALUES (${crypto.randomUUID()}, ${eventType}, ${actor}, ${target}, ${JSON.stringify(redact(detail))}, ${new Date().toISOString()})`;
  }

  private ensureMcpRegistryColumns(): void {
    const columns = new Set(this.sql<{ name: string }>`PRAGMA table_info(mcp_registry)`.map((row) => row.name));
    if (!columns.has("tool_catalog_json")) this.sql`ALTER TABLE mcp_registry ADD COLUMN tool_catalog_json TEXT NOT NULL DEFAULT '[]'`;
    if (!columns.has("observed_tool_catalog_json")) {
      this.sql`ALTER TABLE mcp_registry ADD COLUMN observed_tool_catalog_json TEXT NOT NULL DEFAULT '[]'`;
    }
    if (!columns.has("observed_catalog_refreshed_at")) this.sql`ALTER TABLE mcp_registry ADD COLUMN observed_catalog_refreshed_at TEXT`;
  }

  private ensureMcpGatewayExecutionProjectionColumns(): void {
    const columns = new Set(this.sql<{ name: string }>`PRAGMA table_info(mcp_gateway_execution_projection)`.map((row) => row.name));
    if (!columns.has("protocol_version")) this.sql`ALTER TABLE mcp_gateway_execution_projection ADD COLUMN protocol_version TEXT`;
  }

  private ensureContextCapsuleColumns(): void {
    const columns = new Set(this.sql<{ name: string }>`PRAGMA table_info(context_capsules)`.map((row) => row.name));
    if (!columns.has("owner_id")) this.sql`ALTER TABLE context_capsules ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`;
    if (!columns.has("service_id")) this.sql`ALTER TABLE context_capsules ADD COLUMN service_id TEXT NOT NULL DEFAULT ''`;
  }

  private ensureDelegatedTaskColumns(): void {
    const columns = new Set(this.sql<{ name: string }>`PRAGMA table_info(delegated_tasks)`.map((row) => row.name));
    if (!columns.has("repair_generation")) {
      this.sql`ALTER TABLE delegated_tasks ADD COLUMN repair_generation INTEGER NOT NULL DEFAULT 0`;
    }
    if (!columns.has("progress_revision")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN progress_revision INTEGER NOT NULL DEFAULT 0`;
    if (!columns.has("progress_state")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN progress_state TEXT`;
    if (!columns.has("progress_phase")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN progress_phase TEXT`;
    if (!columns.has("progress_json")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN progress_json TEXT`;
    if (!columns.has("progress_updated_at")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN progress_updated_at TEXT`;
    if (!columns.has("client_idempotency_key")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN client_idempotency_key TEXT NOT NULL DEFAULT ''`;
    if (!columns.has("owner_id")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`;
    if (!columns.has("service_id")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN service_id TEXT NOT NULL DEFAULT ''`;
    if (!columns.has("chat_id")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''`;
    if (!columns.has("root_task_id")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN root_task_id TEXT NOT NULL DEFAULT ''`;
    if (!columns.has("parent_task_id")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN parent_task_id TEXT`;
    if (!columns.has("task_revision")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN task_revision INTEGER NOT NULL DEFAULT 1`;
    if (!columns.has("pause_generation")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN pause_generation INTEGER NOT NULL DEFAULT 0`;
    if (!columns.has("paused_from_status")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN paused_from_status TEXT`;
    if (!columns.has("outcome")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN outcome TEXT`;
    if (!columns.has("receipt_id")) this.sql`ALTER TABLE delegated_tasks ADD COLUMN receipt_id TEXT`;

    const rows = this.sql<{ id: string; idempotency_key: string; client_idempotency_key: string; owner_id: string;
      service_id: string; chat_id: string; root_task_id: string; parent_task_id: string | null; input_json: string }>`
      SELECT id,idempotency_key,client_idempotency_key,owner_id,service_id,chat_id,root_task_id,parent_task_id,input_json
      FROM delegated_tasks`;
    for (const row of rows) {
      const input = this.parseJson<DelegatedTaskInput | null>(row.input_json, null);
      if (!input?.ownerId || !input.serviceId || !input.chatId) {
        this.sql`UPDATE delegated_tasks SET status='attention_required',outcome='Unknown',
          checkpoint_json=json_set(COALESCE(checkpoint_json,'{}'),'$.status','attention_required','$.error','task_scope_backfill_failed')
          WHERE id=${row.id}`;
        continue;
      }
      const clientKey = row.client_idempotency_key || input.idempotencyKey;
      const physicalKey = this.scopedTaskFiberKey(input.ownerId, input.serviceId, clientKey);
      this.sql`UPDATE delegated_tasks SET owner_id=${input.ownerId},service_id=${input.serviceId},chat_id=${input.chatId},
        root_task_id=${input.rootTaskId || input.taskId},parent_task_id=${input.parentTaskId ?? null},
        client_idempotency_key=${clientKey},idempotency_key=${physicalKey}
        WHERE id=${row.id}`;
    }
    this.sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_delegated_tasks_scope_idempotency
      ON delegated_tasks(owner_id,service_id,client_idempotency_key)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_delegated_tasks_scope_updated
      ON delegated_tasks(owner_id,service_id,updated_at)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_delegated_tasks_scope_root
      ON delegated_tasks(owner_id,service_id,root_task_id,status)`;
  }

  private scopedTaskFiberKey(ownerId: string, serviceId: string, idempotencyKey: string): string {
    return `task-scope:${JSON.stringify([ownerId, serviceId, idempotencyKey])}`;
  }

  private ensureToolSideEffectColumns(): void {
    const columns = new Set(this.sql<{ name: string }>`PRAGMA table_info(tool_side_effects)`.map((row) => row.name));
    if (!columns.has("logical_invocation_count")) {
      this.sql`ALTER TABLE tool_side_effects ADD COLUMN logical_invocation_count INTEGER NOT NULL DEFAULT 1`;
    }
    if (!columns.has("provider_attempt_count")) {
      this.sql`ALTER TABLE tool_side_effects ADD COLUMN provider_attempt_count INTEGER NOT NULL DEFAULT 0`;
    }
    if (!columns.has("last_attempt_at")) this.sql`ALTER TABLE tool_side_effects ADD COLUMN last_attempt_at TEXT`;
    if (!columns.has("provider_call_completed")) {
      this.sql`ALTER TABLE tool_side_effects ADD COLUMN provider_call_completed INTEGER NOT NULL DEFAULT 0`;
    }
    if (!columns.has("result_status")) this.sql`ALTER TABLE tool_side_effects ADD COLUMN result_status TEXT`;
    if (!columns.has("error_class")) this.sql`ALTER TABLE tool_side_effects ADD COLUMN error_class TEXT`;
    if (!columns.has("invocation_contract_json")) this.sql`ALTER TABLE tool_side_effects ADD COLUMN invocation_contract_json TEXT`;
    if (!columns.has("retry_authority_json")) this.sql`ALTER TABLE tool_side_effects ADD COLUMN retry_authority_json TEXT`;
    if (!columns.has("dispatch_state")) {
      // Legacy rows predate explicit dispatch tracking. Fail closed: assume anything
      // that was not already terminal may have reached the Provider boundary.
      this.sql`ALTER TABLE tool_side_effects ADD COLUMN dispatch_state TEXT`;
      this.sql`UPDATE tool_side_effects SET dispatch_state = CASE
        WHEN status = 'completed' AND provider_call_completed = 1 THEN 'terminal_observed'
        WHEN status = 'awaiting_input' THEN 'reserved'
        ELSE 'dispatched'
        END
        WHERE dispatch_state IS NULL`;
    }
  }

  private ensureOperiaCodeModeSchema(): void {
    const columns = new Set(this.sql<{ name: string }>`PRAGMA table_info(operia_codemode_executions)`.map((row) => row.name));
    if (!columns.has("code_text")) this.sql`ALTER TABLE operia_codemode_executions ADD COLUMN code_text TEXT NOT NULL DEFAULT ''`;
    if (!columns.has("lease_owner")) this.sql`ALTER TABLE operia_codemode_executions ADD COLUMN lease_owner TEXT`;
    if (!columns.has("lease_expires_at")) this.sql`ALTER TABLE operia_codemode_executions ADD COLUMN lease_expires_at TEXT`;
    if (!columns.has("result_hash")) this.sql`ALTER TABLE operia_codemode_executions ADD COLUMN result_hash TEXT`;
    if (!columns.has("recovery_generation")) {
      this.sql`ALTER TABLE operia_codemode_executions ADD COLUMN recovery_generation INTEGER NOT NULL DEFAULT 0`;
    }
    this.sql`UPDATE operia_codemode_executions SET code_text=''
      WHERE status IN ('completed','failed','quarantined','attention_required') AND code_text<>''`;
  }

  private ensureOperiaOwnedStorageSchema(): void {
    const resourceColumns = new Set(this.sql<{ name: string }>`PRAGMA table_info(operia_owned_resources)`.map((row) => row.name));
    if (!resourceColumns.has("resource_type")) this.sql`ALTER TABLE operia_owned_resources ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'structured_data'`;
    if (!resourceColumns.has("schema_owner")) this.sql`ALTER TABLE operia_owned_resources ADD COLUMN schema_owner TEXT NOT NULL DEFAULT 'operia'`;
    if (!resourceColumns.has("schema_version")) this.sql`ALTER TABLE operia_owned_resources ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'legacy-v1'`;
    if (!resourceColumns.has("created_by")) this.sql`ALTER TABLE operia_owned_resources ADD COLUMN created_by TEXT NOT NULL DEFAULT 'operia'`;
    if (!resourceColumns.has("legal_hold")) this.sql`ALTER TABLE operia_owned_resources ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0`;
    if (!resourceColumns.has("unknown_side_effect")) this.sql`ALTER TABLE operia_owned_resources ADD COLUMN unknown_side_effect INTEGER NOT NULL DEFAULT 0`;
    if (!resourceColumns.has("last_task_id")) this.sql`ALTER TABLE operia_owned_resources ADD COLUMN last_task_id TEXT`;
    if (!resourceColumns.has("last_request_id")) this.sql`ALTER TABLE operia_owned_resources ADD COLUMN last_request_id TEXT`;
    if (!resourceColumns.has("last_idempotency_key")) this.sql`ALTER TABLE operia_owned_resources ADD COLUMN last_idempotency_key TEXT`;
    if (!resourceColumns.has("policy_version")) this.sql`ALTER TABLE operia_owned_resources ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'operia-sandbox-v1'`;

    const versionColumns = new Set(this.sql<{ name: string }>`PRAGMA table_info(operia_owned_resource_versions)`.map((row) => row.name));
    if (!versionColumns.has("resource_type")) this.sql`ALTER TABLE operia_owned_resource_versions ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'structured_data'`;
    if (!versionColumns.has("schema_owner")) this.sql`ALTER TABLE operia_owned_resource_versions ADD COLUMN schema_owner TEXT NOT NULL DEFAULT 'operia'`;
    if (!versionColumns.has("schema_version")) this.sql`ALTER TABLE operia_owned_resource_versions ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'legacy-v1'`;
    if (!versionColumns.has("created_by")) this.sql`ALTER TABLE operia_owned_resource_versions ADD COLUMN created_by TEXT NOT NULL DEFAULT 'operia'`;
    if (!versionColumns.has("request_id")) this.sql`ALTER TABLE operia_owned_resource_versions ADD COLUMN request_id TEXT`;
    if (!versionColumns.has("idempotency_key")) this.sql`ALTER TABLE operia_owned_resource_versions ADD COLUMN idempotency_key TEXT`;
    if (!versionColumns.has("action")) this.sql`ALTER TABLE operia_owned_resource_versions ADD COLUMN action TEXT NOT NULL DEFAULT 'legacy_write'`;
    if (!versionColumns.has("previous_version")) this.sql`ALTER TABLE operia_owned_resource_versions ADD COLUMN previous_version INTEGER`;
    if (!versionColumns.has("policy_version")) this.sql`ALTER TABLE operia_owned_resource_versions ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'operia-sandbox-v1'`;
  }

  private ensureBrowserSiteProfiles(): void {
    const columns = new Set(this.sql<{ name: string }>`PRAGMA table_info(browser_task_leases)`.map((row) => row.name));
    if (!columns.has("step_once")) this.sql`ALTER TABLE browser_task_leases ADD COLUMN step_once INTEGER NOT NULL DEFAULT 0`;
    const now = new Date().toISOString();
    const readActions = JSON.stringify(allowedActionsForMode("read"));
    const formActions = JSON.stringify(allowedActionsForMode("form"));
    this.sql`INSERT INTO browser_site_profiles (id,label,primary_hosts_json,redirect_hosts_json,maximum_mode,allowed_actions_json,revision,enabled,created_at,updated_at)
      VALUES ('cloudflare-docs','Cloudflare Docs',${JSON.stringify(["developers.cloudflare.com"])},'[]','read',${readActions},1,1,${now},${now})
      ON CONFLICT(id) DO NOTHING`;
    this.sql`INSERT INTO browser_site_profiles (id,label,primary_hosts_json,redirect_hosts_json,maximum_mode,allowed_actions_json,revision,enabled,created_at,updated_at)
      VALUES ('github-public','GitHub public pages',${JSON.stringify(["github.com"])},'[]','read',${readActions},1,1,${now},${now})
      ON CONFLICT(id) DO NOTHING`;
    this.sql`INSERT INTO browser_site_profiles (id,label,primary_hosts_json,redirect_hosts_json,maximum_mode,allowed_actions_json,revision,enabled,created_at,updated_at)
      VALUES ('public-questionnaires','Public questionnaires',${JSON.stringify(["openpsychometrics.org"])},${JSON.stringify(["ojts.com"])},'form',${formActions},1,1,${now},${now})
      ON CONFLICT(id) DO NOTHING`;
    const fixtureHosts = normalizeBrowserDomainInput(parseBrowserDomainAllowlist(this.env.BROWSER_QA_FIXTURE_HOST));
    if (fixtureHosts.length > 0) {
      this.sql`INSERT INTO browser_site_profiles (id,label,primary_hosts_json,redirect_hosts_json,maximum_mode,allowed_actions_json,revision,enabled,created_at,updated_at)
        VALUES ('operia-browser-qa','Operia Browser QA fixture',${JSON.stringify(fixtureHosts)},'[]','form',${formActions},1,1,${now},${now})
        ON CONFLICT(id) DO UPDATE SET primary_hosts_json=excluded.primary_hosts_json,allowed_actions_json=excluded.allowed_actions_json,
          revision=browser_site_profiles.revision+1,enabled=1,updated_at=excluded.updated_at
        WHERE browser_site_profiles.primary_hosts_json<>excluded.primary_hosts_json
          OR browser_site_profiles.allowed_actions_json<>excluded.allowed_actions_json
          OR browser_site_profiles.enabled<>1`;
    }
  }

  private ensureApprovalTicketSchema(): void {
    const legacyColumns = new Set(this.sql<{ name: string }>`PRAGMA table_info(approval_tickets)`.map((row) => row.name));
    if (!legacyColumns.has("decision_action")) this.sql`ALTER TABLE approval_tickets ADD COLUMN decision_action TEXT`;
    if (!legacyColumns.has("decision_scope")) this.sql`ALTER TABLE approval_tickets ADD COLUMN decision_scope TEXT`;
    if (!legacyColumns.has("decision_owner_id")) this.sql`ALTER TABLE approval_tickets ADD COLUMN decision_owner_id TEXT`;
    if (!legacyColumns.has("decision_chat_id")) this.sql`ALTER TABLE approval_tickets ADD COLUMN decision_chat_id TEXT`;
    if (!legacyColumns.has("decided_at")) this.sql`ALTER TABLE approval_tickets ADD COLUMN decided_at TEXT`;
    if (!legacyColumns.has("attention_error")) this.sql`ALTER TABLE approval_tickets ADD COLUMN attention_error TEXT`;
    const callColumns = new Set(this.sql<{ name: string }>`PRAGMA table_info(approval_ticket_calls)`.map((row) => row.name));
    if (!callColumns.has("decision_scope")) this.sql`ALTER TABLE approval_ticket_calls ADD COLUMN decision_scope TEXT`;
    if (!callColumns.has("think_task_id")) this.sql`ALTER TABLE approval_ticket_calls ADD COLUMN think_task_id TEXT`;
    if (!callColumns.has("agent_call_key")) this.sql`ALTER TABLE approval_ticket_calls ADD COLUMN agent_call_key TEXT`;
    if (!callColumns.has("schema_hash")) this.sql`ALTER TABLE approval_ticket_calls ADD COLUMN schema_hash TEXT`;
    if (!callColumns.has("pause_generation")) this.sql`ALTER TABLE approval_ticket_calls ADD COLUMN pause_generation INTEGER`;
    const grantColumns = new Set(this.sql<{ name: string }>`PRAGMA table_info(approval_task_grants)`.map((row) => row.name));
    if (!grantColumns.has("think_task_id")) this.sql`ALTER TABLE approval_task_grants ADD COLUMN think_task_id TEXT`;
    if (!grantColumns.has("schema_hash")) this.sql`ALTER TABLE approval_task_grants ADD COLUMN schema_hash TEXT`;
    if (!grantColumns.has("pause_generation")) this.sql`ALTER TABLE approval_task_grants ADD COLUMN pause_generation INTEGER`;
    this.sql`INSERT OR IGNORE INTO approval_ticket_calls
      (id,status,owner_id,chat_id,task_id,approval_round,server_id,tool_name,args_json,args_hash,policy_version,
       expires_at,nonce,workflow_id,preview_json,review_json,decision_json,decision_action,decision_scope,decision_owner_id,
       decision_chat_id,decided_at,created_at,consumed_at,attention_error)
      SELECT id,status,owner_id,chat_id,task_id,0,server_id,tool_name,args_json,args_hash,policy_version,
       expires_at,nonce,workflow_id,preview_json,review_json,decision_json,decision_action,decision_scope,decision_owner_id,
       decision_chat_id,decided_at,created_at,consumed_at,attention_error
      FROM approval_tickets`;
  }

  private ensurePlannerUsageColumns(): void {
    const columns = new Set(this.sql<{ name: string }>`PRAGMA table_info(planner_usage_log)`.map((row) => row.name));
    if (!columns.has("reasoning_tokens")) this.sql`ALTER TABLE planner_usage_log ADD COLUMN reasoning_tokens INTEGER`;
    if (!columns.has("finish_reason")) this.sql`ALTER TABLE planner_usage_log ADD COLUMN finish_reason TEXT`;
  }

  private ensureVoicePreviewColumns(): void {
    const columns = new Set(this.sql<{ name: string }>`PRAGMA table_info(voice_preview_grants)`.map((row) => row.name));
    if (!columns.has("claimed_at")) this.sql`ALTER TABLE voice_preview_grants ADD COLUMN claimed_at TEXT`;
  }

  private contextServiceBinding(): { ownerId: string; serviceId: string } | null {
    const ownerId = this.env.AGENT_CONTEXT_OWNER_ID?.trim();
    const serviceId = this.env.AGENT_CONTEXT_SERVICE_ID?.trim();
    const serviceBearer = this.env.AGENT_CONTEXT_SERVICE_BEARER?.trim();
    if (!ownerId || !serviceId || !serviceBearer || serviceBearer === this.env.AGENT_ADMIN_BEARER?.trim()) return null;
    return { ownerId, serviceId };
  }

  private async buildToolCatalog(serverId: string, inputTools: ToolCatalogEntryInput[]) {
    const catalog = [];
    for (const input of inputTools) {
      if (
        typeof input?.toolName !== "string" ||
        input.toolName.trim().length === 0 ||
        typeof input.riskLevel !== "string" ||
        !RISK_LEVELS.has(input.riskLevel) ||
        typeof input.enabled !== "boolean" ||
        this.parseToolSchema(input.inputSchema) === null
      ) {
        throw new Error("incomplete_tool_catalog_entry");
      }
      catalog.push(
        await createToolCatalogEntry({
          serverId,
          toolName: this.normalizeToolName(input.toolName),
          description: input.description,
          riskLevel: input.riskLevel,
          inputSchema: input.inputSchema,
          outputByteLimit: input.outputByteLimit,
          enabled: input.enabled,
        }),
      );
    }
    return catalog;
  }

  private normalizeToolName(value: string): string {
    return value.includes("/") ? value.split("/").slice(-1)[0] : value;
  }

  private async parseContextCapsuleInput(
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
  ): Promise<ContextCapsuleInput | null> {
    const scope = this.parseContextScope(body, binding);
    if (
      !scope ||
      typeof body.ttlMs !== "number" ||
      typeof body.maxBytes !== "number" ||
      !Array.isArray(body.refs)
    ) {
      return null;
    }
    const serverNow = new Date();
    try {
      const refs = await resolveIssuedContextReferences(
        body.refs,
        { ...scope, serverNow },
        async (handle) => this.lookupContextHandle(handle),
      );
      return { ...scope, ttlMs: body.ttlMs, maxBytes: body.maxBytes, refs, serverNow };
    } catch {
      return null;
    }
  }

  private parseContextResolutionInput(
    body: Record<string, unknown>,
    binding: { ownerId: string; serviceId: string },
  ): ContextCapsuleResolutionInput | null {
    const scope = this.parseContextScope(body, binding);
    return scope ? { ...scope, serverNow: new Date() } : null;
  }

  private parseContextScope(body: Record<string, unknown>, binding: { ownerId: string; serviceId: string }): ContextScope | null {
    if (
      typeof body.namespace !== "string" ||
      typeof body.chatId !== "string" ||
      typeof body.taskId !== "string" ||
      typeof body.recipient !== "string" ||
      typeof body.purpose !== "string" ||
      typeof body.requestHash !== "string"
    ) {
      return null;
    }
    return {
      namespace: body.namespace,
      chatId: body.chatId,
      taskId: body.taskId,
      recipient: body.recipient,
      purpose: body.purpose,
      requestHash: body.requestHash,
      ownerId: binding.ownerId,
      serviceId: binding.serviceId,
    };
  }

  private lookupContextHandle(handle: string): ContextHandleRecord | null {
    const row = this.sql<ContextHandleRow>`SELECT handle, kind, checksum, namespace, chat_id, task_id, recipient, purpose,
      request_hash, owner_id, service_id, created_at, expires_at FROM context_handles WHERE handle = ${handle}`[0];
    if (!row || (row.kind !== "memory" && row.kind !== "artifact" && row.kind !== "tool_result")) return null;
    return {
      handle: row.handle,
      kind: row.kind,
      checksum: row.checksum,
      namespace: row.namespace,
      chatId: row.chat_id,
      taskId: row.task_id,
      recipient: row.recipient,
      purpose: row.purpose,
      requestHash: row.request_hash,
      ownerId: row.owner_id,
      serviceId: row.service_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  private rowToContextCapsule(row: ContextCapsuleRow): ContextCapsule {
    return {
      capsuleId: row.id,
      namespace: row.namespace,
      chatId: row.chat_id,
      taskId: row.task_id,
      recipient: row.recipient,
      purpose: row.purpose,
      requestHash: row.request_hash,
      ownerId: row.owner_id,
      serviceId: row.service_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      maxBytes: Number(row.max_bytes),
      totalBytes: Number(row.total_bytes),
      truncated: Number(row.truncated) === 1,
      refs: this.parseJson(row.refs_json, []),
    };
  }

  private parseJson<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private parseToolSchema(value: unknown): ToolSchema | null {
    if (typeof value === "boolean") return value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as ToolSchema;
  }
}
