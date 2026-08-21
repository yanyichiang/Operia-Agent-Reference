import type {
  ControlManifest,
  ControlParameterDefinition,
  ControlTopology,
  ControlValue,
} from "./control/index";
import type { AgentEnv } from "./agent/types";
import type { AgentHealthSummaryEnv } from "./agent/healthSummaryContracts";
import type { CalendarEnv } from "./calendar/types";
import type { HealthEnv } from "./health/types";
import type { Env } from "./types";

export const CONTROL_REGISTRY_VERSION = "2026-08-09.1";
const GENERATED_AT = "2026-08-09T00:00:00.000Z";

export const CONTROL_TOPOLOGY: ControlTopology = {
  topologyVersion: 1,
  registryVersion: CONTROL_REGISTRY_VERSION,
  generatedAt: GENERATED_AT,
  domains: [
    { domain: "memory.example.com", title: "Memory", manifestPath: "/api/control/manifest", routeTemplateIds: ["memory-config"] },
    { domain: "mcp.example.com", title: "MCP", manifestPath: "/api/control/manifest", routeTemplateIds: ["mcp-config"] },
    { domain: "agent.example.com", title: "Agent", manifestPath: "/api/control/manifest", routeTemplateIds: ["agent-config", "agent-browser-config", "agent-skills-config", "agent-heartbeat-config", "agent-voice-config"] },
    { domain: "calendar.example.com", title: "Calendar", manifestPath: "/api/control/manifest", routeTemplateIds: ["calendar-config"] },
    { domain: "health.example.com", title: "Health", manifestPath: "/api/control/manifest", routeTemplateIds: ["health-config"] },
    { domain: "tgbot.example.com", title: "Telegram", manifestPath: "/api/control/manifest", routeTemplateIds: ["telegram-config"] },
    { domain: "operia.example.com", title: "Operia", manifestPath: "/api/control/manifest", routeTemplateIds: ["operia-session"] },
    { domain: "xiaozhi.example.com", title: "Xiaozhi", manifestPath: "/api/control/manifest", routeTemplateIds: ["xiaozhi-device"] },
    { domain: "ops.example.com", title: "Ops", manifestPath: "/api/control/manifest", routeTemplateIds: ["ops-run"] },
  ],
  routeTemplates: [
    { id: "memory-config", ownerDomain: "memory.example.com", template: "https://memory.example.com/admin?config_key={config_key}", allowedLocators: ["config_key"] },
    { id: "mcp-config", ownerDomain: "mcp.example.com", template: "https://mcp.example.com/admin?config_key={config_key}", allowedLocators: ["config_key"] },
    { id: "agent-config", ownerDomain: "agent.example.com", template: "https://agent.example.com/?config_key={config_key}", allowedLocators: ["config_key"] },
    { id: "agent-browser-config", ownerDomain: "agent.example.com", template: "https://agent.example.com/tools/browser?config_key={config_key}", allowedLocators: ["config_key"] },
    { id: "agent-skills-config", ownerDomain: "agent.example.com", template: "https://agent.example.com/tools/skills?config_key={config_key}", allowedLocators: ["config_key"] },
    { id: "agent-heartbeat-config", ownerDomain: "agent.example.com", template: "https://agent.example.com/tools/heartbeat?config_key={config_key}", allowedLocators: ["config_key"] },
    { id: "agent-voice-config", ownerDomain: "agent.example.com", template: "https://agent.example.com/tools/voice?config_key={config_key}", allowedLocators: ["config_key"] },
    { id: "calendar-config", ownerDomain: "calendar.example.com", template: "https://calendar.example.com/?config_key={config_key}", allowedLocators: ["config_key"] },
    { id: "health-config", ownerDomain: "health.example.com", template: "https://health.example.com/?config_key={config_key}", allowedLocators: ["config_key"] },
    { id: "telegram-config", ownerDomain: "tgbot.example.com", template: "https://tgbot.example.com/admin?config_key={config_key}", allowedLocators: ["config_key"] },
    { id: "operia-session", ownerDomain: "operia.example.com", template: "https://operia.example.com/?session_id={session_id}", allowedLocators: ["session_id"] },
    { id: "xiaozhi-device", ownerDomain: "xiaozhi.example.com", template: "https://xiaozhi.example.com/app?session_id={session_id}", allowedLocators: ["session_id"] },
    { id: "ops-run", ownerDomain: "ops.example.com", template: "https://ops.example.com/?run_id={run_id}", allowedLocators: ["run_id"] },
  ],
};

const common = {
  schemaVersion: 1,
  sensitivity: "private" as const,
  auditClass: "preference" as const,
};

export const CONTROL_DEFINITIONS: readonly ControlParameterDefinition[] = [
  {
    ...common, key: "memory.inference.chat_model", ownerDomain: "memory.example.com", category: "inference",
    label: "Primary conversation model", description: "Canonical primary model used by the Memory inference pipeline.",
    valueSchema: { type: "string", minLength: 1, maxLength: 200 }, allowedScopes: ["global", "channel", "chat", "next_turn"],
    resolutionStrategy: "replace_within_envelope", mutableFrom: ["memory.example.com", "tgbot.example.com"],
    routeTemplateId: "memory-config", legacyLocations: ["wrangler.toml:CHAT_MODEL", "wrangler.tgbot.toml:CHAT_MODEL", "tg_chat_config.model"],
  },
  {
    ...common, key: "memory.inference.reasoning.enabled", ownerDomain: "memory.example.com", category: "reasoning",
    label: "Reasoning enabled", description: "Whether the primary inference model may request provider-exposed reasoning.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global", "channel", "chat", "next_turn"],
    resolutionStrategy: "replace_within_envelope", mutableFrom: ["memory.example.com", "tgbot.example.com"],
    routeTemplateId: "memory-config", legacyLocations: ["wrangler.toml:ANTHROPIC_THINKING_ENABLED"],
  },
  {
    ...common, key: "memory.inference.reasoning.effort", ownerDomain: "memory.example.com", category: "reasoning",
    label: "Reasoning effort", description: "Opus 4.6 adaptive-thinking effort and overall response eagerness.",
    valueSchema: { type: "string", enum: ["low", "medium", "high", "max"] }, defaultValue: "medium",
    allowedScopes: ["global", "channel", "chat", "next_turn"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["memory.example.com", "tgbot.example.com"], routeTemplateId: "memory-config",
    legacyLocations: ["request.reasoning_effort", "Anthropic API default:high"],
  },
  {
    ...common, key: "memory.inference.sampling.temperature", ownerDomain: "memory.example.com", category: "sampling",
    label: "Temperature", description: "Sampling temperature used only while adaptive thinking is disabled.",
    valueSchema: { type: "number", minimum: 0, maximum: 1 }, defaultValue: 1,
    allowedScopes: ["global", "channel", "chat", "next_turn"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["memory.example.com", "tgbot.example.com"], routeTemplateId: "memory-config",
    legacyLocations: ["request.temperature"],
  },
  {
    ...common, key: "memory.inference.reasoning.legacy_budget_tokens", ownerDomain: "memory.example.com", category: "reasoning",
    label: "Legacy reasoning budget", description: "Deprecated manual budget retained only for migration and rollback.",
    valueSchema: { type: "number", minimum: 1024 }, defaultValue: 1024, allowedScopes: ["global"],
    resolutionStrategy: "numeric_min", mutableFrom: ["memory.example.com"], auditClass: "policy",
    routeTemplateId: "memory-config", legacyLocations: ["wrangler.toml:ANTHROPIC_THINKING_BUDGET"],
  },
  {
    ...common, key: "memory.inference.prompt_cache.enabled", ownerDomain: "memory.example.com", category: "cache",
    label: "Prompt cache", description: "Provider prompt cache policy for primary inference.", valueSchema: { type: "boolean" },
    defaultValue: true, allowedScopes: ["global"], resolutionStrategy: "deny_only", hardLimit: true,
    mutableFrom: ["memory.example.com"], routeTemplateId: "memory-config", legacyLocations: ["wrangler.toml:ANTHROPIC_CACHE_ENABLED"],
  },
  {
    ...common, key: "memory.inference.code_read.enabled", ownerDomain: "memory.example.com", category: "tools",
    label: "Think source-code reads", description: "Deny-by-default exposure of Agent-owned, revision-pinned read-only source tools to Think.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: [], routeTemplateId: "memory-config", auditClass: "policy",
    legacyLocations: ["wrangler.toml:MEMORY_THINK_CODE_READ_ENABLED"],
  },
  {
    ...common, key: "memory.inference.telegram_draft.enabled", ownerDomain: "memory.example.com", category: "presentation",
    label: "Think Telegram draft producer", description: "Retired fail-closed: pre-final model text deltas are never exposed because providers may encode intermediate work as ordinary text.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: [], routeTemplateId: "memory-config", auditClass: "policy",
    legacyLocations: ["wrangler.toml:MEMORY_THINK_TG_DRAFT_ENABLED"],
  },
  {
    ...common, key: "memory.conversation_import.summary.enabled", ownerDomain: "memory.example.com", category: "memory_import",
    label: "Historical summary derivation", description: "Deny-by-default paid derivation of archived owner conversations.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["memory.example.com"], routeTemplateId: "memory-config", auditClass: "dangerous",
    legacyLocations: ["wrangler.toml:CONVERSATION_IMPORT_SUMMARY_ENABLED"],
  },
  {
    ...common, key: "memory.conversation_import.free_summary.mode", ownerDomain: "memory.example.com", category: "memory_import",
    label: "Free historical-summary lane", description: "Pause, shadow-canary, or run the bounded Workers AI historical-summary lane.",
    valueSchema: { type: "string", enum: ["off", "armed", "active"] }, defaultValue: "off", allowedScopes: ["global"],
    resolutionStrategy: "replace_within_envelope", hardLimit: true, mutableFrom: ["memory.example.com"],
    routeTemplateId: "memory-config", auditClass: "policy", legacyLocations: ["wrangler.toml:CONVERSATION_IMPORT_FREE_SUMMARY_MODE"],
  },
  {
    ...common, key: "memory.conversation_import.free_summary.daily_neurons", ownerDomain: "memory.example.com", category: "memory_import",
    label: "Daily free-summary Neurons", description: "Per-UTC-day ceiling reserved for imported-history summarization; hard capped at 2,000.",
    valueSchema: { type: "number", minimum: 1, maximum: 2000 }, defaultValue: 2000, allowedScopes: ["global"],
    resolutionStrategy: "numeric_min", hardLimit: true, mutableFrom: ["memory.example.com"],
    routeTemplateId: "memory-config", auditClass: "policy", legacyLocations: ["wrangler.toml:CONVERSATION_IMPORT_FREE_SUMMARY_DAILY_NEURONS"],
  },
  {
    ...common, key: "memory.recall.whitebox_policy", ownerDomain: "memory.example.com", category: "memory_recall",
    label: "White-box recall policy", description: "Versioned lexical, vector, fusion, hydration and final-selection policy exposed through Recall Inspector traces.",
    valueSchema: { type: "object" }, allowedScopes: ["global"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["memory.example.com"], routeTemplateId: "memory-config", auditClass: "policy",
    legacyLocations: ["src/memory/v2/recall.ts", "src/memory/episodic.ts"],
  },
  {
    ...common, key: "memory.subject.self_core", ownerDomain: "memory.example.com", category: "subject_core",
    label: "Operia Self Core", description: "Owner-approved, versioned atomic claims describing who Operia is; model calls may only create review proposals.",
    valueSchema: { type: "object" }, allowedScopes: ["global"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["memory.example.com"], routeTemplateId: "memory-config", auditClass: "dangerous",
    legacyLocations: ["persona"],
  },
  {
    ...common, key: "memory.subject.owner_core", ownerDomain: "memory.example.com", category: "subject_core",
    label: "Owner Core", description: "Owner-approved, versioned atomic claims describing the person in front of Operia.",
    valueSchema: { type: "object" }, allowedScopes: ["global"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["memory.example.com"], routeTemplateId: "memory-config", auditClass: "dangerous",
    legacyLocations: ["persona"],
  },
  {
    ...common, key: "memory.subject.relationship_core", ownerDomain: "memory.example.com", category: "subject_core",
    label: "Relationship Core", description: "Owner-approved, versioned atomic claims describing the Operia-Owner relationship; protected status requires an explicit approval action.",
    valueSchema: { type: "object" }, allowedScopes: ["global"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["memory.example.com"], routeTemplateId: "memory-config", auditClass: "dangerous",
    legacyLocations: ["persona"],
  },
  {
    ...common, key: "calendar.google.write.enabled", ownerDomain: "calendar.example.com", category: "calendar_write",
    label: "Google Calendar writeback", description: "Deny-by-default owner gate for primary-calendar event mutations.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["calendar.example.com"], routeTemplateId: "calendar-config", auditClass: "dangerous",
    legacyLocations: ["wrangler.calendar.jsonc:CALENDAR_WRITE_ENABLED"],
  },
  {
    ...common, key: "calendar.google.watch.enabled", ownerDomain: "calendar.example.com", category: "calendar_sync",
    label: "Google Calendar watch", description: "Deny-by-default push-invalidation gate; scheduled reconciliation remains independent.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["calendar.example.com"], routeTemplateId: "calendar-config", auditClass: "policy",
    legacyLocations: ["wrangler.calendar.jsonc:CALENDAR_PUSH_SYNC_ENABLED"],
  },
  {
    ...common, key: "health.corrections.enabled", ownerDomain: "health.example.com", category: "health_corrections",
    label: "Health correction overlay", description: "Deny-by-default append-only corrections and undo over immutable Health aggregates.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["health.example.com"], routeTemplateId: "health-config", auditClass: "dangerous",
    legacyLocations: ["wrangler.health.jsonc:HEALTH_CORRECTIONS_ENABLED"],
  },
  {
    ...common, key: "health.references.enabled", ownerDomain: "health.example.com", category: "health_references",
    label: "Health general references", description: "Deny-by-default display of reviewed, versioned and non-diagnostic public references.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["health.example.com"], routeTemplateId: "health-config", auditClass: "policy",
    legacyLocations: ["wrangler.health.jsonc:HEALTH_REFERENCES_ENABLED"],
  },
  {
    ...common, key: "health.summary.enabled", ownerDomain: "health.example.com", category: "health_summary",
    label: "Health deterministic summary", description: "Deny-by-default deterministic summary pipeline; this gate never authorizes a model call.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["health.example.com"], routeTemplateId: "health-config", auditClass: "policy",
    legacyLocations: ["wrangler.health.jsonc:HEALTH_SUMMARY_ENABLED"],
  },
  {
    ...common, key: "agent.planner.model", ownerDomain: "agent.example.com", category: "planner",
    label: "Tool planner model", description: "Model used for delegated tool planning.", valueSchema: { type: "string", minLength: 1 },
    allowedScopes: ["global"], resolutionStrategy: "replace_within_envelope", mutableFrom: ["agent.example.com"],
    routeTemplateId: "agent-config", legacyLocations: ["wrangler.agent.toml:TOOL_PLANNER_MODEL"],
  },
  {
    ...common, key: "agent.heartbeat.mode", ownerDomain: "agent.example.com", category: "heartbeat",
    label: "Heartbeat mode", description: "Hard off, armed awaiting real activity, or active after real activity.",
    valueSchema: { type: "string", enum: ["off", "armed", "active"] }, defaultValue: "armed", allowedScopes: ["global"],
    resolutionStrategy: "replace_within_envelope", mutableFrom: ["agent.example.com"], routeTemplateId: "agent-heartbeat-config", auditClass: "policy", legacyLocations: [],
  },
  {
    ...common, key: "agent.heartbeat.prompt", ownerDomain: "agent.example.com", category: "heartbeat",
    label: "Companion prompt", description: "Untrusted style preference that cannot expand capabilities.",
    valueSchema: { type: "string", maxLength: 4000 }, defaultValue: "", allowedScopes: ["global"],
    resolutionStrategy: "replace_within_envelope", mutableFrom: ["agent.example.com"], routeTemplateId: "agent-heartbeat-config", legacyLocations: [],
  },
  {
    ...common, key: "agent.heartbeat.schedule", ownerDomain: "agent.example.com", category: "heartbeat",
    label: "Heartbeat schedule", description: "Timezone, quiet hours, pulse slots, deterministic jitter and prefix-warm window.",
    valueSchema: { type: "object" }, allowedScopes: ["global"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["agent.example.com"], routeTemplateId: "agent-heartbeat-config", auditClass: "policy", legacyLocations: [],
  },
  {
    ...common, key: "agent.heartbeat.daily_limit", ownerDomain: "agent.example.com", category: "budget",
    label: "Companion daily limit", description: "Hard maximum number of non-dry-run companion model pulses per local day.",
    valueSchema: { type: "number", minimum: 0, maximum: 3 }, defaultValue: 3, hardLimit: 3, allowedScopes: ["global"],
    resolutionStrategy: "numeric_min", mutableFrom: ["agent.example.com"], routeTemplateId: "agent-heartbeat-config", auditClass: "policy", legacyLocations: [],
  },
  {
    ...common, key: "agent.heartbeat.capabilities", ownerDomain: "agent.example.com", category: "policy",
    label: "Heartbeat capabilities", description: "Deny-only autonomous capability switches; hard denials remain non-overridable.",
    valueSchema: { type: "object" }, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    mutableFrom: ["agent.example.com"], routeTemplateId: "agent-heartbeat-config", auditClass: "policy", legacyLocations: [],
  },
  {
    ...common, key: "agent.heartbeat.browser_budget", ownerDomain: "agent.example.com", category: "policy",
    label: "Heartbeat Browser budget", description: "Heartbeat-only server clamp for read Browser steps and absolute deadline.",
    valueSchema: { type: "object" }, allowedScopes: ["global"], resolutionStrategy: "numeric_min",
    mutableFrom: ["agent.example.com"], routeTemplateId: "agent-heartbeat-config", auditClass: "policy", legacyLocations: [],
  },
  {
    ...common, key: "agent.heartbeat.dry_run", ownerDomain: "agent.example.com", category: "heartbeat",
    label: "Heartbeat dry run", description: "Record decisions without sending or executing tools.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["agent.example.com"], routeTemplateId: "agent-heartbeat-config", auditClass: "policy", legacyLocations: [],
  },
  {
    ...common, key: "agent.planner.daily_budget", ownerDomain: "agent.example.com", category: "budget",
    label: "Planner daily budget", description: "Hard daily planner-call ceiling.", valueSchema: { type: "number", minimum: 0 },
    allowedScopes: ["global", "channel"], resolutionStrategy: "numeric_min", mutableFrom: ["agent.example.com"],
    routeTemplateId: "agent-config", auditClass: "policy", legacyLocations: ["wrangler.agent.toml:TOOL_PLANNER_DAILY_BUDGET"],
  },
  {
    ...common, key: "agent.health_summary.model.enabled", ownerDomain: "agent.example.com", category: "health_summary",
    label: "Health summary model wording", description: "Deny-by-default model wording gate; Health remains the facts and projection owner.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["agent.example.com"], routeTemplateId: "agent-config", auditClass: "policy",
    legacyLocations: ["wrangler.agent.toml:AGENT_HEALTH_SUMMARY_MODEL_ENABLED"],
  },
  {
    ...common, key: "agent.health_summary.daily_call_limit", ownerDomain: "agent.example.com", category: "budget",
    label: "Health summary daily model limit", description: "Per-owner local-day model-call ceiling; zero denies all calls and 24 is the future hard maximum.",
    valueSchema: { type: "integer", minimum: 0, maximum: 24 }, defaultValue: 0, hardLimit: 24,
    allowedScopes: ["global"], resolutionStrategy: "numeric_min", mutableFrom: ["agent.example.com"],
    routeTemplateId: "agent-config", auditClass: "policy", legacyLocations: ["wrangler.agent.toml:AGENT_HEALTH_SUMMARY_DAILY_CALL_LIMIT"],
  },
  {
    ...common, key: "agent.browser.enabled", ownerDomain: "agent.example.com", category: "browser",
    label: "Browser enabled", description: "Global browser execution gate.", valueSchema: { type: "boolean" }, defaultValue: false,
    allowedScopes: ["global", "channel"], resolutionStrategy: "deny_only", hardLimit: true, mutableFrom: ["agent.example.com"],
    routeTemplateId: "agent-config", auditClass: "policy", legacyLocations: ["wrangler.agent.toml:BROWSER_ENABLED"],
  },
  {
    ...common, key: "agent.code_workspace.enabled", ownerDomain: "agent.example.com", category: "source_code",
    label: "Read-only source workspace", description: "Deny-by-default access to the dedicated R2 source snapshot; it never grants writes, credentials, or deployment.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: [], routeTemplateId: "agent-config", auditClass: "policy",
    legacyLocations: ["wrangler.agent.toml:AGENT_CODE_WORKSPACE_ENABLED"],
  },
  {
    ...common, key: "agent.browser.domain_allowlist", ownerDomain: "agent.example.com", category: "browser",
    label: "Browser domain allowlist", description: "Canonical HTTPS hostname scope available to Agent Browser execution.",
    valueSchema: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", maxLength: 253 } },
    defaultValue: [], allowedScopes: ["global"], resolutionStrategy: "set_intersection",
    mutableFrom: ["agent.example.com"], routeTemplateId: "agent-browser-config", auditClass: "policy",
    legacyLocations: ["wrangler.agent.toml:BROWSER_DOMAIN_ALLOWLIST"],
  },
  {
    ...common, key: "agent.browser.domain_denylist", ownerDomain: "agent.example.com", category: "browser",
    label: "Browser domain denylist", description: "Canonical exact-host deny override for Agent Browser execution.",
    valueSchema: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", maxLength: 253 } },
    defaultValue: [], allowedScopes: ["global"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["agent.example.com"], routeTemplateId: "agent-browser-config", auditClass: "policy",
    legacyLocations: [],
  },
  {
    ...common, key: "agent.voice.provider.enabled", ownerDomain: "agent.example.com", category: "voice",
    label: "Voice provider", description: "Whether the shared Agent voice provider is available.", valueSchema: { type: "boolean" }, defaultValue: false,
    allowedScopes: ["global", "channel"], resolutionStrategy: "deny_only", hardLimit: true, mutableFrom: ["agent.example.com"],
    routeTemplateId: "agent-voice-config", auditClass: "policy", legacyLocations: ["wrangler.agent.toml:VOICE_ENABLED"],
  },
  {
    ...common, key: "agent.voice.providers.minimax.enabled", ownerDomain: "agent.example.com", category: "voice",
    label: "MiniMax Voice provider", description: "Provider-specific kill switch beneath the shared Voice hard gate.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["agent.example.com"], routeTemplateId: "agent-voice-config", auditClass: "policy",
    legacyLocations: ["wrangler.agent.toml:MINIMAX_VOICE_ENABLED"],
  },
  {
    ...common, key: "agent.voice.default_provider", ownerDomain: "agent.example.com", category: "voice",
    label: "Default Voice provider", description: "Provider selected for new channel-independent synthesis requests.",
    valueSchema: { type: "string", enum: ["elevenlabs", "minimax"] }, defaultValue: "elevenlabs",
    allowedScopes: ["global", "channel"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["agent.example.com"], routeTemplateId: "agent-voice-config", legacyLocations: ["Agent runtime: ElevenLabs hard-coded"],
  },
  {
    ...common, key: "agent.voice.default_profile_id", ownerDomain: "agent.example.com", category: "voice",
    label: "Default Voice profile", description: "Internal provider-neutral Voice profile locator.",
    valueSchema: { type: ["string", "null"], pattern: "^voice-profile:[0-9a-f-]{36}$" }, defaultValue: null,
    allowedScopes: ["global", "channel"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["agent.example.com"], routeTemplateId: "agent-voice-config", legacyLocations: ["voice_profiles.is_default", "ELEVENLABS_DEFAULT_VOICE_ID"],
  },
  {
    ...common, key: "agent.voice.clone.enabled", ownerDomain: "agent.example.com", category: "voice",
    label: "Voice clone", description: "Dangerous upload and clone gate; consent and per-operation approval remain mandatory.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["agent.example.com"], routeTemplateId: "agent-voice-config", auditClass: "dangerous",
    legacyLocations: ["wrangler.agent.toml:MINIMAX_VOICE_CLONE_ENABLED"],
  },
  {
    ...common, key: "agent.voice.budget.daily_micro_usd", ownerDomain: "agent.example.com", category: "budget",
    label: "Voice daily budget", description: "Hard daily Voice spend ceiling in integer micro-USD; zero denies paid calls.",
    valueSchema: { type: "integer", minimum: 0 }, defaultValue: 0, allowedScopes: ["global", "channel"],
    resolutionStrategy: "numeric_min", mutableFrom: ["agent.example.com"], routeTemplateId: "agent-voice-config", auditClass: "policy",
    legacyLocations: ["wrangler.agent.toml:MINIMAX_VOICE_DAILY_BUDGET_MICRO_USD"],
  },
  {
    ...common, key: "agent.voice.max_synthesis_characters", ownerDomain: "agent.example.com", category: "budget",
    label: "Voice synthesis character limit", description: "Per-call Operia hard limit below provider limits.",
    valueSchema: { type: "integer", minimum: 1, maximum: 4000 }, defaultValue: 4000, hardLimit: 4000,
    allowedScopes: ["global", "channel"], resolutionStrategy: "numeric_min", mutableFrom: ["agent.example.com"],
    routeTemplateId: "agent-voice-config", auditClass: "policy", legacyLocations: ["synthesizeVoiceService:4000"],
  },
  {
    ...common, key: "mcp.gateway.provider_registry", ownerDomain: "mcp.example.com", category: "mcp",
    label: "MCP provider registry", description: "Canonical Gateway-owned provider registry and monotonic owner revision.",
    valueSchema: { type: "object" }, allowedScopes: ["global"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["mcp.example.com"], routeTemplateId: "mcp-config", auditClass: "policy",
    legacyLocations: ["agent DO:mcp_registry (legacy readonly)"],
  },
  {
    ...common, key: "mcp.gateway.tool_catalog", ownerDomain: "mcp.example.com", category: "mcp",
    label: "MCP tool catalog", description: "Gateway-owned tool enablement catalog; registry-only projection is not executable.",
    valueSchema: { type: "array" }, allowedScopes: ["global"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["mcp.example.com"], routeTemplateId: "mcp-config", auditClass: "policy", legacyLocations: [],
  },
  {
    ...common, key: "agent.skills.installations", ownerDomain: "agent.example.com", category: "skills",
    label: "Skill installations", description: "Pinned immutable Skill versions and owner-controlled enabled state.",
    valueSchema: { type: "array" }, allowedScopes: ["global", "channel"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["agent.example.com"], routeTemplateId: "agent-skills-config", auditClass: "policy", legacyLocations: ["createDefaultSkillsRegistry"],
  },
  {
    ...common, key: "agent.skills.trust_roots", ownerDomain: "agent.example.com", category: "skills",
    label: "Skill trust roots", description: "Exact registry allowlist and Ed25519 publisher trust roots.",
    valueSchema: { type: "array" }, allowedScopes: ["global"], resolutionStrategy: "set_intersection",
    mutableFrom: ["agent.example.com"], routeTemplateId: "agent-skills-config", auditClass: "credential", legacyLocations: [],
  },
  {
    ...common, key: "agent.skills.runs", ownerDomain: "agent.example.com", category: "skills",
    label: "Skill durable runs", description: "Planned, blocked, cancelled and completed Skill checkpoints.",
    valueSchema: { type: "array" }, allowedScopes: ["global", "channel", "chat"], resolutionStrategy: "replace_within_envelope",
    mutableFrom: ["agent.example.com"], routeTemplateId: "agent-skills-config", auditClass: "policy", legacyLocations: [],
  },
  {
    ...common, key: "telegram.miniapp.calendar_write.enabled", ownerDomain: "tgbot.example.com", category: "miniapp",
    label: "Mini App Calendar write UI", description: "Telegram presentation gate; it cannot override the Calendar owner write gate.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["tgbot.example.com"], routeTemplateId: "telegram-config", auditClass: "policy",
    legacyLocations: ["wrangler.tgbot.toml:TG_MINIAPP_CALENDAR_WRITE_ENABLED"],
  },
  {
    ...common, key: "telegram.miniapp.health_corrections.enabled", ownerDomain: "tgbot.example.com", category: "miniapp",
    label: "Mini App Health correction UI", description: "Telegram presentation gate; it cannot override the Health owner correction gate.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["tgbot.example.com"], routeTemplateId: "telegram-config", auditClass: "policy",
    legacyLocations: ["wrangler.tgbot.toml:TG_MINIAPP_HEALTH_CORRECTIONS_ENABLED"],
  },
  {
    ...common, key: "telegram.ambient.health.enabled", ownerDomain: "tgbot.example.com", category: "ambient_context",
    label: "Health volatile context", description: "Deny-by-default Telegram gate for bounded Health wording in per-turn volatile context.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global", "channel", "chat"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["tgbot.example.com"], routeTemplateId: "telegram-config", auditClass: "policy",
    legacyLocations: ["wrangler.tgbot.toml:TG_AMBIENT_HEALTH_CONTEXT_ENABLED"],
  },
  {
    ...common, key: "telegram.presentation.reasoning_mode", ownerDomain: "tgbot.example.com", category: "presentation",
    label: "Reasoning presentation", description: "Telegram-only display mode for provider-exposed reasoning summaries and execution trace.",
    valueSchema: { type: "string", enum: ["off", "summary", "debug_trace"] }, defaultValue: "off", allowedScopes: ["global", "channel", "chat"],
    resolutionStrategy: "replace_within_envelope", mutableFrom: ["tgbot.example.com"], routeTemplateId: "telegram-config",
    legacyLocations: ["tg_settings.reasoning_mode"],
  },
  {
    ...common, key: "telegram.agent_rooms.enabled", ownerDomain: "tgbot.example.com", category: "policy",
    label: "Agent QA rooms", description: "Global deny-by-default runtime gate for owner-controlled Telegram Agent QA rooms.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: ["tgbot.example.com"], routeTemplateId: "telegram-config", auditClass: "policy",
    legacyLocations: ["wrangler.tgbot.toml:TG_AGENT_ROOMS_ENABLED"],
  },
  {
    ...common, key: "telegram.agent_rooms.wake_policy", ownerDomain: "tgbot.example.com", category: "policy",
    label: "Agent room wake policy", description: "Per-room CAS-controlled wake policy; off always wins during rollback.",
    valueSchema: { type: "string", enum: ["off", "mention_or_reply"] }, defaultValue: "off", allowedScopes: ["chat"],
    resolutionStrategy: "replace_within_envelope", mutableFrom: ["tgbot.example.com"], routeTemplateId: "telegram-config",
    auditClass: "policy", legacyLocations: ["tg_agent_rooms.wake_policy"],
  },
  {
    ...common, key: "telegram.presentation.task_progress_mode", ownerDomain: "tgbot.example.com", category: "presentation",
    label: "Task progress", description: "Telegram-only live task narration mode; audit and terminal delivery remain enabled when presentation is off.",
    valueSchema: { type: "string", enum: ["live", "compact", "off"] }, defaultValue: "live", allowedScopes: ["global", "channel", "chat"],
    resolutionStrategy: "replace_within_envelope", mutableFrom: ["tgbot.example.com"], routeTemplateId: "telegram-config",
    legacyLocations: ["tg_settings.task_progress_mode"],
  },
  {
    ...common, key: "telegram.presentation.expandable_response_status", ownerDomain: "tgbot.example.com", category: "presentation",
    label: "Expandable response status", description: "Attach one sanitized tool, model, tier, token and cache status block to each final model response.",
    valueSchema: { type: "boolean" }, defaultValue: true, allowedScopes: ["global", "channel", "chat"],
    resolutionStrategy: "replace_within_envelope", mutableFrom: ["tgbot.example.com"], routeTemplateId: "telegram-config",
    legacyLocations: ["tg_settings.expandable_response_status"],
  },
  {
    ...common, key: "telegram.presentation.expandable_usage", ownerDomain: "tgbot.example.com", category: "presentation",
    label: "Expandable usage", description: "Whether Telegram exposes token and cache metrics in an expandable presentation block.",
    valueSchema: { type: "boolean" }, defaultValue: true, allowedScopes: ["global", "channel", "chat"],
    resolutionStrategy: "replace_within_envelope", mutableFrom: ["tgbot.example.com"], routeTemplateId: "telegram-config",
    legacyLocations: ["tg_settings.expandable_usage"],
  },
  {
    ...common, key: "telegram.presentation.expandable_tool_trace", ownerDomain: "tgbot.example.com", category: "presentation",
    label: "Expandable tool trace", description: "Whether Telegram exposes the sanitized tool-stage trace in an expandable presentation block.",
    valueSchema: { type: "boolean" }, defaultValue: true, allowedScopes: ["global", "channel", "chat"],
    resolutionStrategy: "replace_within_envelope", mutableFrom: ["tgbot.example.com"], routeTemplateId: "telegram-config",
    legacyLocations: ["tg_settings.expandable_tool_trace"],
  },
  {
    ...common, key: "telegram.presentation.draft_preview.enabled", ownerDomain: "tgbot.example.com", category: "presentation",
    label: "Private-chat draft preview", description: "Deny-by-default Telegram sendMessageDraft consumer. Preview failure never retries or affects the canonical durable final response.",
    valueSchema: { type: "boolean" }, defaultValue: false, allowedScopes: ["global"], resolutionStrategy: "deny_only",
    hardLimit: true, mutableFrom: [], routeTemplateId: "telegram-config", auditClass: "policy",
    legacyLocations: ["wrangler.tgbot.toml:TG_DRAFT_PREVIEW_ENABLED"],
  },
  {
    ...common, key: "telegram.voice.delivery_mode", ownerDomain: "tgbot.example.com", category: "voice",
    label: "Telegram voice delivery", description: "When Telegram sends a voice response; it does not configure the shared voice provider.",
    valueSchema: { type: "string", enum: ["off", "once", "auto"] }, defaultValue: "off", allowedScopes: ["global", "channel", "chat", "next_turn"],
    resolutionStrategy: "replace_within_envelope", mutableFrom: ["tgbot.example.com"], routeTemplateId: "telegram-config",
    legacyLocations: ["tg_chat_config.voice_policy", "tg_chat_config.voice_once"],
  },
];

export function controlDefinitionsFor(ownerDomain: string): ControlParameterDefinition[] {
  return CONTROL_DEFINITIONS.filter((definition) => definition.ownerDomain === ownerDomain).map((definition) => ({ ...definition }));
}

export function resolveControlLocator(
  ownerDomain: string,
  key: string | null,
  routeTemplateIds: readonly string[],
): ControlParameterDefinition | null {
  if (!key) return null;
  const definition = CONTROL_DEFINITIONS.find((item) =>
    item.ownerDomain === ownerDomain &&
    item.key === key &&
    routeTemplateIds.includes(item.routeTemplateId));
  return definition ? { ...definition } : null;
}

export function controlManifestFor(domain: string, capabilities: ControlManifest["capabilities"] = []): ControlManifest {
  const entry = CONTROL_TOPOLOGY.domains.find((item) => item.domain === domain);
  if (!entry) throw new Error(`unknown_control_domain:${domain}`);
  const ownedDefinitions = controlDefinitionsFor(domain);
  const consumes = domain === "agent.example.com"
    ? [{ ownerDomain: "memory.example.com", keys: ["memory.inference.*"] }, { ownerDomain: "mcp.example.com", keys: ["mcp.gateway.*"] }, { ownerDomain: "health.example.com", keys: ["health.summary.*"] }]
    : domain === "tgbot.example.com"
      ? [{ ownerDomain: "memory.example.com", keys: ["memory.inference.*"] }, { ownerDomain: "agent.example.com", keys: ["agent.*"] }, { ownerDomain: "mcp.example.com", keys: ["mcp.gateway.*"] }, { ownerDomain: "calendar.example.com", keys: ["calendar.*"] }, { ownerDomain: "health.example.com", keys: ["health.*"] }]
      : [];
  return {
    manifestVersion: 1,
    registryVersion: CONTROL_REGISTRY_VERSION,
    domain,
    title: entry.title,
    owns: ownedDefinitions.map((definition) => definition.key),
    consumes,
    sections: entry.routeTemplateIds.map((routeTemplateId) => ({ id: routeTemplateId, title: entry.title, routeTemplateId })),
    capabilities,
    schemaVersions: { control: 1 },
    generatedAt: GENERATED_AT,
  };
}

export type ControlProjection = {
  definition: ControlParameterDefinition;
  current: ControlValue;
  source: "owner_env" | "owner_store" | "legacy_store";
  migration: "canonical" | "compatibility_read" | "planned_owner_transfer";
};

export function staticControlValue(key: string, value: unknown, ownerVersion = CONTROL_REGISTRY_VERSION): ControlValue {
  return { key, value, revision: 0, ownerVersion, updatedAt: GENERATED_AT, actor: { type: "migration", id: "control-registry" } };
}

function projection(ownerDomain: string, key: string, value: unknown, source: ControlProjection["source"] = "owner_env"): ControlProjection {
  const definition = CONTROL_DEFINITIONS.find((item) => item.ownerDomain === ownerDomain && item.key === key);
  if (!definition) throw new Error(`unknown_control_key:${key}`);
  return { definition: { ...definition }, current: staticControlValue(key, value), source, migration: source === "legacy_store" ? "compatibility_read" : "canonical" };
}

export function memoryControlProjection(env: Env): ControlProjection[] {
  return [
    projection("memory.example.com", "memory.inference.chat_model", env.CHAT_MODEL?.trim() || env.DEFAULT_UPSTREAM_MODEL?.trim() || "unconfigured"),
    projection("memory.example.com", "memory.inference.reasoning.enabled", env.ANTHROPIC_THINKING_ENABLED?.trim().toLowerCase() === "true"),
    projection("memory.example.com", "memory.inference.reasoning.effort", "medium"),
    projection("memory.example.com", "memory.inference.sampling.temperature", 1),
    projection("memory.example.com", "memory.inference.reasoning.legacy_budget_tokens", Math.max(1024, Number(env.ANTHROPIC_THINKING_BUDGET) || 1024)),
    projection("memory.example.com", "memory.inference.prompt_cache.enabled", env.ANTHROPIC_CACHE_ENABLED?.trim().toLowerCase() !== "false"),
    projection("memory.example.com", "memory.inference.code_read.enabled", env.MEMORY_THINK_CODE_READ_ENABLED?.trim().toLowerCase() === "true"),
    projection("memory.example.com", "memory.inference.telegram_draft.enabled", env.MEMORY_THINK_TG_DRAFT_ENABLED?.trim().toLowerCase() === "true"),
    projection("memory.example.com", "memory.conversation_import.summary.enabled", env.CONVERSATION_IMPORT_SUMMARY_ENABLED?.trim().toLowerCase() === "true"),
    projection("memory.example.com", "memory.conversation_import.free_summary.mode",
      ["armed", "active"].includes(env.CONVERSATION_IMPORT_FREE_SUMMARY_MODE?.trim().toLowerCase() || "")
        ? env.CONVERSATION_IMPORT_FREE_SUMMARY_MODE?.trim().toLowerCase() : "off"),
    projection("memory.example.com", "memory.conversation_import.free_summary.daily_neurons",
      Math.min(2000, Math.max(1, Math.trunc(Number(env.CONVERSATION_IMPORT_FREE_SUMMARY_DAILY_NEURONS) || 2000)))),
  ];
}

export function calendarControlProjection(env: CalendarEnv): ControlProjection[] {
  return [
    projection("calendar.example.com", "calendar.google.write.enabled", env.CALENDAR_WRITE_ENABLED?.trim().toLowerCase() === "true"),
    projection("calendar.example.com", "calendar.google.watch.enabled", env.CALENDAR_PUSH_SYNC_ENABLED?.trim().toLowerCase() === "true"),
  ];
}

export function healthControlProjection(env: HealthEnv): ControlProjection[] {
  return [
    projection("health.example.com", "health.corrections.enabled", env.HEALTH_CORRECTIONS_ENABLED?.trim().toLowerCase() === "true"),
    projection("health.example.com", "health.references.enabled", env.HEALTH_REFERENCES_ENABLED?.trim().toLowerCase() === "true"),
    projection("health.example.com", "health.summary.enabled", env.HEALTH_SUMMARY_ENABLED?.trim().toLowerCase() === "true"),
  ];
}

export function telegramCalendarHealthControlProjection(env: Env): ControlProjection[] {
  return [
    projection("tgbot.example.com", "telegram.miniapp.calendar_write.enabled", env.TG_MINIAPP_CALENDAR_WRITE_ENABLED?.trim().toLowerCase() === "true"),
    projection("tgbot.example.com", "telegram.miniapp.health_corrections.enabled", env.TG_MINIAPP_HEALTH_CORRECTIONS_ENABLED?.trim().toLowerCase() === "true"),
    projection("tgbot.example.com", "telegram.ambient.health.enabled", env.TG_AMBIENT_HEALTH_CONTEXT_ENABLED?.trim().toLowerCase() === "true"),
    projection("tgbot.example.com", "telegram.presentation.draft_preview.enabled", env.TG_DRAFT_PREVIEW_ENABLED?.trim().toLowerCase() === "true"),
  ];
}

export function agentControlProjection(
  env: AgentEnv & AgentHealthSummaryEnv,
  runtime?: {
    browserDomainAllowlist: string[]; browserDomainAllowlistRevision: number; browserDomainAllowlistUpdatedAt?: string;
    browserDomainDenylist?: string[]; browserDomainDenylistRevision?: number; browserDomainDenylistUpdatedAt?: string;
    skillInstallations?: unknown[]; skillTrustRoots?: unknown[]; skillRuns?: unknown[];
    heartbeatConfig?: Record<string, unknown>; heartbeatRevision?: number; heartbeatUpdatedAt?: string;
  },
): ControlProjection[] {
  const browserDomainAllowlist = runtime?.browserDomainAllowlist
    ?? (env.BROWSER_DOMAIN_ALLOWLIST ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const allowlistProjection = projection(
    "agent.example.com",
    "agent.browser.domain_allowlist",
    browserDomainAllowlist,
    runtime ? "owner_store" : "owner_env",
  );
  if (runtime) allowlistProjection.current = {
    ...allowlistProjection.current,
    revision: runtime.browserDomainAllowlistRevision,
    ownerVersion: `agent-control-${runtime.browserDomainAllowlistRevision}`,
    updatedAt: runtime.browserDomainAllowlistUpdatedAt ?? allowlistProjection.current.updatedAt,
  };
  const denylistProjection = projection(
    "agent.example.com",
    "agent.browser.domain_denylist",
    runtime?.browserDomainDenylist ?? [],
    "owner_store",
  );
  if (runtime) denylistProjection.current = {
    ...denylistProjection.current,
    revision: runtime.browserDomainDenylistRevision ?? 0,
    ownerVersion: `agent-control-deny-${runtime.browserDomainDenylistRevision ?? 0}`,
    updatedAt: runtime.browserDomainDenylistUpdatedAt ?? denylistProjection.current.updatedAt,
  };
  const heartbeat = runtime?.heartbeatConfig ?? {};
  const heartbeatValue = (key: string, value: unknown) => {
    const item = projection("agent.example.com", key, value, "owner_store");
    item.current = { ...item.current, revision: runtime?.heartbeatRevision ?? 0, ownerVersion: `heartbeat-${runtime?.heartbeatRevision ?? 0}`, updatedAt: runtime?.heartbeatUpdatedAt ?? item.current.updatedAt };
    return item;
  };
  return [
    projection("agent.example.com", "agent.planner.model", env.TOOL_PLANNER_MODEL?.trim() || "@cf/zai-org/glm-4.7-flash"),
    projection("agent.example.com", "agent.planner.daily_budget", Math.max(0, Number(env.TOOL_PLANNER_DAILY_BUDGET) || 0)),
    projection("agent.example.com", "agent.health_summary.model.enabled", env.AGENT_HEALTH_SUMMARY_MODEL_ENABLED?.trim().toLowerCase() === "true"),
    projection("agent.example.com", "agent.health_summary.daily_call_limit", Math.min(24, Math.max(0, Math.trunc(Number(env.AGENT_HEALTH_SUMMARY_DAILY_CALL_LIMIT) || 0)))),
    projection("agent.example.com", "agent.browser.enabled", env.BROWSER_ENABLED?.trim().toLowerCase() === "true"),
    projection("agent.example.com", "agent.code_workspace.enabled", env.AGENT_CODE_WORKSPACE_ENABLED?.trim().toLowerCase() === "true"),
    allowlistProjection,
    denylistProjection,
    projection("agent.example.com", "agent.voice.provider.enabled", env.VOICE_ENABLED?.trim().toLowerCase() === "true"),
    projection("agent.example.com", "agent.voice.providers.minimax.enabled", env.MINIMAX_VOICE_ENABLED?.trim().toLowerCase() === "true"),
    projection("agent.example.com", "agent.voice.default_provider", "elevenlabs"),
    projection("agent.example.com", "agent.voice.default_profile_id", null),
    projection("agent.example.com", "agent.voice.clone.enabled", env.MINIMAX_VOICE_CLONE_ENABLED?.trim().toLowerCase() === "true"),
    projection("agent.example.com", "agent.voice.budget.daily_micro_usd", Math.max(0, Number(env.MINIMAX_VOICE_DAILY_BUDGET_MICRO_USD) || 0)),
    projection("agent.example.com", "agent.voice.max_synthesis_characters", 4000),
    heartbeatValue("agent.heartbeat.mode", heartbeat.mode ?? "armed"),
    heartbeatValue("agent.heartbeat.prompt", heartbeat.prompt ?? ""),
    heartbeatValue("agent.heartbeat.schedule", { timezone: heartbeat.timezone, quietHours: heartbeat.quietHours, pulseHours: heartbeat.pulseHours, jitterMinutes: heartbeat.jitterMinutes, warmWindowMinutes: heartbeat.warmWindowMinutes, warmIntervalMinutes: heartbeat.warmIntervalMinutes }),
    heartbeatValue("agent.heartbeat.daily_limit", heartbeat.dailyLimit ?? 3),
    heartbeatValue("agent.heartbeat.capabilities", heartbeat.capabilities ?? {}),
    heartbeatValue("agent.heartbeat.browser_budget", { maxSteps: heartbeat.browserMaxSteps ?? 8, timeoutSeconds: heartbeat.browserTimeoutSeconds ?? 90 }),
    heartbeatValue("agent.heartbeat.dry_run", heartbeat.dryRun === true),
    projection("agent.example.com", "agent.skills.installations", runtime?.skillInstallations ?? [], "owner_store"),
    projection("agent.example.com", "agent.skills.trust_roots", runtime?.skillTrustRoots ?? [], "owner_store"),
    projection("agent.example.com", "agent.skills.runs", runtime?.skillRuns ?? [], "owner_store"),
  ];
}

export function controlNavigationLinks(): Array<{ id: string; title: string; description: string; url: string; sortOrder: number; enabled: boolean }> {
  const descriptions: Record<string, string> = {
    "agent.example.com": "通用 Agent、工具、浏览器与媒体",
    "memory.example.com": "记忆、人格与主推理",
    "mcp.example.com": "Provider、工具目录与域会话",
    "calendar.example.com": "日程投影、同步与写回合同",
    "health.example.com": "健康数据、纠错与摘要合同",
    "tgbot.example.com": "Telegram 渠道控制",
    "operia.example.com": "主要对话入口",
    "xiaozhi.example.com": "设备与语音入口",
    "ops.example.com": "基础设施与全域拓扑",
  };
  return CONTROL_TOPOLOGY.domains.map((entry, index) => ({
    id: entry.domain.split(".")[0], title: entry.title, description: descriptions[entry.domain] ?? entry.title,
    url: `https://${entry.domain}${entry.domain === "memory.example.com" || entry.domain === "mcp.example.com" || entry.domain === "tgbot.example.com" ? "/admin" : entry.domain === "xiaozhi.example.com" ? "/app" : ""}`,
    sortOrder: index * 10, enabled: true,
  }));
}
