import type { CapabilityConfig, CapabilityDefinition } from "./types";

export const CAPABILITY_REGISTRY = [
  { id: "agent.identity", domain: "runtime", label: "Agent identity", description: "Stable Durable Object identity.", defaultStatus: "enabled", configurable: false },
  { id: "agent.state", domain: "runtime", label: "SQLite runtime state", description: "Runtime metadata only; never conversation or engineering memory.", defaultStatus: "enabled", configurable: false },
  { id: "agent.http_rpc", domain: "runtime", label: "HTTP and RPC", description: "Authenticated management and internal runtime methods.", defaultStatus: "enabled", configurable: false },
  { id: "agent.websocket_sse", domain: "runtime", label: "WebSocket and SSE", description: "Realtime client transport.", defaultStatus: "disabled", configurable: true },
  { id: "agent.queue", domain: "runtime", label: "Agent queue", description: "Asynchronous queued execution.", defaultStatus: "disabled", configurable: true },
  { id: "agent.schedules", domain: "runtime", label: "Schedules", description: "One-time, interval, and cron scheduling.", defaultStatus: "disabled", configurable: true },
  { id: "agent.heartbeat", domain: "runtime", label: "Heartbeat", description: "Script-only health checks and retention without model calls.", defaultStatus: "enabled", configurable: true },
  { id: "agent.durable_fibers", domain: "runtime", label: "Durable fibers", description: "Recoverable long-running execution.", defaultStatus: "disabled", configurable: true },
  { id: "harness.direct_tools", domain: "harness", label: "Direct tool loop", description: "Small explicit tool orchestration surface.", defaultStatus: "disabled", configurable: true },
  { id: "harness.project_think", domain: "harness", label: "Project Think", description: "Cloudflare higher-level agent harness.", defaultStatus: "disabled", configurable: false },
  { id: "harness.multi_agent", domain: "harness", label: "Multi-agent handoffs", description: "Delegation between specialized agents.", defaultStatus: "disabled", configurable: true },
  { id: "tools.mcp", domain: "tools", label: "Remote MCP", description: "Deny-by-default remote MCP registry.", defaultStatus: "enabled", configurable: false },
  { id: "tools.internal", domain: "tools", label: "Internal tools", description: "Health, cancellation, and runtime administration tools.", defaultStatus: "enabled", configurable: false },
  { id: "tools.code_mode", domain: "tools", label: "Restricted Code Mode", description: "Bounded sequential CDP programs with deterministic policy and durable approval.", defaultStatus: "enabled", configurable: false },
  { id: "tools.browser", domain: "tools", label: "Browser", description: "Allowlisted read-only Browser Run quick actions.", defaultStatus: "enabled", configurable: true },
  { id: "tools.hooks", domain: "tools", label: "Lifecycle hooks", description: "Scoped built-in handlers and signed outgoing webhooks.", defaultStatus: "enabled", configurable: true },
  { id: "tools.sandbox", domain: "tools", label: "Sandbox", description: "Isolated code execution.", defaultStatus: "disabled", configurable: false },
  { id: "tools.ai_search", domain: "tools", label: "AI Search", description: "Managed retrieval outside Operia memory.", defaultStatus: "disabled", configurable: false },
  { id: "tools.payments", domain: "tools", label: "Payments", description: "Payment-capable tools.", defaultStatus: "disabled", configurable: false },
  { id: "security.approvals", domain: "security", label: "Approvals", description: "Human approval records for risky actions.", defaultStatus: "enabled", configurable: false },
  { id: "security.idempotency", domain: "security", label: "Idempotency", description: "Duplicate execution prevention.", defaultStatus: "enabled", configurable: false },
  { id: "security.cancel", domain: "security", label: "Cancellation", description: "Cancelable runtime jobs.", defaultStatus: "enabled", configurable: false },
  { id: "security.tool_allowlist", domain: "security", label: "Tool allowlist", description: "Explicit MCP server and tool authorization.", defaultStatus: "disabled", configurable: true },
  { id: "channel.telegram", domain: "channel", label: "Telegram", description: "Telegram channel client.", defaultStatus: "disabled", configurable: true },
  { id: "channel.operia_web", domain: "channel", label: "Operia Web", description: "Operia browser channel.", defaultStatus: "disabled", configurable: true },
  { id: "channel.home_assistant", domain: "channel", label: "Home Assistant", description: "Home Assistant events and tools.", defaultStatus: "disabled", configurable: true },
  { id: "channel.wechat", domain: "channel", label: "WeChat", description: "Future redesigned WeChat bridge.", defaultStatus: "disabled", configurable: true },
  { id: "channel.email", domain: "channel", label: "Email", description: "Inbound and outbound email channel.", defaultStatus: "disabled", configurable: true },
  { id: "channel.slack", domain: "channel", label: "Slack", description: "Slack channel.", defaultStatus: "disabled", configurable: true },
  { id: "channel.voice", domain: "channel", label: "Voice", description: "Experimental voice channel.", defaultStatus: "disabled", configurable: true },
  { id: "observability.audit", domain: "observability", label: "Audit log", description: "Redacted runtime action ledger.", defaultStatus: "enabled", configurable: false },
  { id: "observability.health", domain: "observability", label: "Health checks", description: "Runtime and MCP registry health snapshots.", defaultStatus: "enabled", configurable: false },
  { id: "observability.model_usage", domain: "observability", label: "Model usage", description: "Model and token telemetry.", defaultStatus: "disabled", configurable: true },
  { id: "observability.tracing", domain: "observability", label: "Tracing", description: "Detailed distributed execution traces.", defaultStatus: "disabled", configurable: true },
] as const satisfies readonly CapabilityDefinition[];

export function defaultCapabilityConfig(): CapabilityConfig {
  return Object.fromEntries(CAPABILITY_REGISTRY.map((capability) => [capability.id, capability.defaultStatus]));
}

export function capabilitySnapshot(config: CapabilityConfig, revisions: Record<string, number> = {}) {
  return CAPABILITY_REGISTRY.map((definition) => ({
    ...definition,
    status: config[definition.id] ?? definition.defaultStatus,
    revision: Number(revisions[definition.id] ?? 0),
  }));
}
