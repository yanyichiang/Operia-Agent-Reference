import type { Env } from "../types";
import type { ApprovalAction, BrowserDomainDecisionAction } from "../agent/approval";

export type AgentScope = { namespace: string; chatId: string; taskId: string; recipient: string; purpose: string; requestHash: string; ownerId: string; serviceId: string };
export type AgentTelegramCommand = "tool" | "skill" | "browser";
export type AgentTelegramCommandItem = {
  label: string;
  detail: string;
  status: string;
  id?: string;
  source?: "internal" | "external";
  executable?: boolean;
  inputSchema?: Record<string, unknown>;
};
export type AgentTelegramCommandResult = {
  title: string;
  summary: string;
  items: AgentTelegramCommandItem[];
  handoff?: {
    taskId: string;
    toolKey: string;
    arguments: Record<string, unknown>;
    result: unknown;
  };
  pending?: {
    taskId: string;
    toolKey: string;
    arguments: Record<string, unknown>;
  };
};
export type SandboxControlAuthority = {
  ownerId: string;
  chatId: string;
  threadKey: string;
  authorityBinding: "private_owner" | "agent_room_owner";
};

export type SandboxControlResult = {
  ok: boolean;
  action: string;
  nonce?: string;
  expiresAt?: string;
  alreadyPaused?: boolean;
  alreadyRunning?: boolean;
  tasksRemainPaused?: boolean;
  control: {
    paused: boolean;
    generation: number;
    activeTasks: number;
    pendingApprovals: number;
    unknownSideEffects: number;
    sandboxEnabled: boolean;
    p2ReadEnabled: boolean;
    codeModeEnabled: boolean;
  };
};
export type AgentHtmlArtifact = {
  artifactId: string;
  version: number;
  parentVersion?: number;
  title: string;
  kind: "safe_document" | "interactive_capsule";
  status: "ready" | "blocked" | "expired" | "deleted";
  contentHash: string;
  bytes: number;
  stateRevision: number;
  sensitivity: "private" | "sensitive" | "health";
  correlation: { taskId?: string; messageId?: string; sessionId?: string };
  creator: { type: "opus" | "owner"; model?: string };
  scan: { policyVersion: string; blockedCategory?: string };
  createdAt: string;
  expiresAt: string;
};

const TELEGRAM_COMMAND_PATHS: Record<AgentTelegramCommand, string> = {
  tool: "/service/telegram/tool",
  skill: "/service/telegram/skill",
  browser: "/service/telegram/browser",
};
const MAX_TELEGRAM_RESULT_ITEMS = 50;

function boundedDisplay(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function boundedServiceErrorCode(value: unknown): string {
  const code = boundedDisplay(value, 160);
  return /^[a-z0-9_.:-]+$/i.test(code) ? code : "unknown";
}

function boundedIdentifier(value: unknown): string | undefined {
  const id = boundedDisplay(value, 128);
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(id) ? id : undefined;
}

function boundedInputSchema(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).byteLength > 8 * 1024) return undefined;
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    return parsed.type === "object" && parsed.properties && typeof parsed.properties === "object" && !Array.isArray(parsed.properties)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function bearer(env: Env, approval = false): string {
  const value = (approval ? env.AGENT_APPROVAL_SERVICE_BEARER : env.AGENT_CONTEXT_SERVICE_BEARER)?.trim();
  if (!value) throw new Error(approval ? "agent_approval_auth_missing" : "agent_context_auth_missing");
  return value;
}

async function readService(env: Env, path: string): Promise<Record<string, unknown>> {
  if (!env.AGENT_SERVICE) throw new Error("agent_service_missing");
  const response = await env.AGENT_SERVICE.fetch(`https://<AGENT_SERVICE>.internal${path}`, {
    headers: { authorization: `Bearer ${bearer(env)}` },
  });
  const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) throw new Error(`agent_http_${response.status}:${boundedServiceErrorCode(payload.error)}:${boundedServiceErrorCode(payload.message)}`);
  return payload;
}

export async function listAgentHtmlArtifacts(env: Env, after?: string): Promise<{ artifacts: AgentHtmlArtifact[]; observedAt: string }> {
  const suffix = after ? `?after=${encodeURIComponent(after)}` : "";
  const payload = await readService(env, `/service/artifacts${suffix}`);
  return {
    artifacts: Array.isArray(payload.artifacts) ? payload.artifacts as AgentHtmlArtifact[] : [],
    observedAt: typeof payload.observedAt === "string" ? payload.observedAt : new Date().toISOString(),
  };
}

export async function getAgentHtmlArtifact(env: Env, artifactId: string): Promise<{
  artifact: AgentHtmlArtifact;
  versions: AgentHtmlArtifact[];
}> {
  if (!/^art_[a-f0-9]{24}$/.test(artifactId)) throw new Error("artifact_id_invalid");
  const payload = await readService(env, `/service/artifacts/${artifactId}`);
  return { artifact: payload.artifact as AgentHtmlArtifact, versions: payload.versions as AgentHtmlArtifact[] };
}

export async function readAgentHtmlArtifactBundle(env: Env, artifactId: string, version: number): Promise<Response> {
  if (!env.AGENT_SERVICE) throw new Error("agent_service_missing");
  if (!/^art_[a-f0-9]{24}$/.test(artifactId) || !Number.isSafeInteger(version) || version < 1) throw new Error("artifact_locator_invalid");
  return env.AGENT_SERVICE.fetch(
    `https://<AGENT_SERVICE>.internal/service/artifacts/${artifactId}/versions/${version}/bundle`,
    { headers: { authorization: `Bearer ${bearer(env)}` } },
  );
}

export async function saveAgentHtmlArtifactState(
  env: Env,
  artifactId: string,
  version: number,
  revision: number,
  value: unknown,
): Promise<Record<string, unknown>> {
  if (!/^art_[a-f0-9]{24}$/.test(artifactId) || !Number.isSafeInteger(version) || version < 1) throw new Error("artifact_locator_invalid");
  return request(env, `/service/artifacts/${artifactId}/versions/${version}/state`, { revision, value });
}

export async function getAgentRuntimeSnapshot(env: Env): Promise<Record<string, unknown>> {
  return readService(env, "/service/runtime/snapshot");
}

export async function getAgentOperationsProjection(env: Env): Promise<Record<string, unknown>> {
  return readService(env, "/service/operations/projection");
}

export async function getAgentReasoningTrace(env: Env): Promise<Record<string, unknown>> {
  return readService(env, "/service/runtime/trace");
}

export async function getAgentControlProjection(env: Env): Promise<Record<string, unknown>> {
  return readService(env, "/service/control/projection");
}

export async function getAgentHeartbeatProjection(env: Env): Promise<Record<string, unknown>> {
  return readService(env, "/service/heartbeat/projection");
}

export async function updateAgentHeartbeatConfig(
  env: Env,
  input: { ownerId: string; chatId: string; revision: number; config: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  return mutateService(env, "/service/heartbeat/config", "PUT", {
    ownerId: input.ownerId, chatId: input.chatId, config: input.config,
  }, { "if-match": `"${input.revision}"`, "idempotency-key": crypto.randomUUID() });
}

export async function updateAgentSkillInstallation(
  env: Env,
  input: { ownerId: string; chatId: string; skillKey: string; revision: number; enabled: boolean },
): Promise<Record<string, unknown>> {
  return mutateService(env, `/service/skills/installations/${encodeURIComponent(input.skillKey)}`, "PUT", {
    ownerId: input.ownerId, chatId: input.chatId, enabled: input.enabled,
  }, { "if-match": `"${input.revision}"` });
}

export async function updateAgentCapability(
  env: Env,
  input: { ownerId: string; chatId: string; capabilityId: string; revision: number; status: "disabled" },
): Promise<Record<string, unknown>> {
  return mutateService(env, `/service/capabilities/${encodeURIComponent(input.capabilityId)}`, "PATCH", {
    ownerId: input.ownerId, chatId: input.chatId, status: input.status,
  }, { "if-match": `"${input.revision}"`, "idempotency-key": crypto.randomUUID() });
}

export async function decideAgentHeartbeatActivation(
  env: Env,
  requestId: string,
  input: { action: "approve" | "reject"; nonce: string; ownerId: string; chatId: string },
): Promise<Record<string, unknown>> {
  if (!/^hba_[a-f0-9]{24}$/.test(requestId) || !/^[a-f0-9]{32}$/.test(input.nonce)) {
    throw new Error("heartbeat_activation_locator_invalid");
  }
  return request(env,`/service/heartbeat/activation/${encodeURIComponent(requestId)}/decision`,input);
}

export async function reportHeartbeatActivity(env: Env, input: { eventKey: string; kind: "natural_text" | "natural_voice"; chatRef: string; occurredAt: string }): Promise<Record<string, unknown>> {
  return request(env, "/service/heartbeat/activity", input);
}

export async function claimHeartbeatIntent(env: Env): Promise<Record<string, unknown>> {
  if (!env.AGENT_SERVICE) throw new Error("agent_service_missing");
  const response = await env.AGENT_SERVICE.fetch("https://<AGENT_SERVICE>.internal/service/heartbeat/intents/claim", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer(env)}` },
    body: "{}",
  });
  const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) throw new Error(`agent_http_${response.status}:${boundedServiceErrorCode(payload.error)}:${boundedServiceErrorCode(payload.message)}`);
  const leaseToken = response.headers.get("x-operia-heartbeat-lease")?.trim();
  if (payload.intent && typeof payload.intent === "object" && !Array.isArray(payload.intent)) {
    if (!leaseToken) throw new Error("heartbeat_lease_header_missing");
    payload.intent = { ...(payload.intent as Record<string, unknown>), leaseToken };
  }
  return payload;
}

export async function finishHeartbeatIntent(env: Env, intentId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request(env, `/service/heartbeat/intents/${encodeURIComponent(intentId)}/complete`, input);
}

export async function failHeartbeatIntent(env: Env, intentId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request(env, `/service/heartbeat/intents/${encodeURIComponent(intentId)}/fail`, input);
}

export async function getAgentMcpControl(env: Env): Promise<Record<string, unknown>> {
  return readService(env, "/service/mcp/control");
}

export async function updateAgentMcpTool(
  env: Env,
  input: { ownerId: string; chatId: string; provider: string; tool: string; enabled: boolean; etag: string },
): Promise<Record<string, unknown>> {
  if (!env.AGENT_SERVICE) throw new Error("agent_service_missing");
  const response = await env.AGENT_SERVICE.fetch("https://<AGENT_SERVICE>.internal/service/mcp/tools", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer(env)}`, "if-match": input.etag },
    body: JSON.stringify({ ownerId: input.ownerId, chatId: input.chatId, provider: input.provider, tool: input.tool, enabled: input.enabled }),
  });
  const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) throw new Error(`agent_http_${response.status}:${boundedServiceErrorCode(payload.error)}:${boundedServiceErrorCode(payload.message)}`);
  return payload;
}

export function isAgentCommandOwner(env: Env, chatId: string): boolean {
  const ownerChatId = env.TG_AGENT_OWNER_CHAT_ID?.trim();
  const ownerId = env.TG_AGENT_OWNER_ID?.trim();
  return Boolean(ownerChatId) && chatId === ownerChatId && (!ownerId || chatId === ownerId);
}

export async function invokeAgentTelegramCommand(
  env: Env,
  command: AgentTelegramCommand,
  input: Record<string, unknown>,
): Promise<AgentTelegramCommandResult> {
  const payload = await request(env, TELEGRAM_COMMAND_PATHS[command], input);
  const rawItems = Array.isArray(payload.items) ? payload.items.slice(0, MAX_TELEGRAM_RESULT_ITEMS) : [];
  const items = rawItems.map((raw) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const id = boundedIdentifier(item.id);
    const source: AgentTelegramCommandItem["source"] = item.source === "external" || item.source === "internal" ? item.source : undefined;
    const inputSchema = boundedInputSchema(item.inputSchema);
    return {
      label: boundedDisplay(item.label ?? item.name, 120) || "未命名项",
      detail: boundedDisplay(item.detail ?? item.description, 300),
      status: boundedDisplay(item.status, 32),
      ...(id ? { id } : {}),
      ...(source ? { source } : {}),
      ...(typeof item.executable === "boolean" ? { executable: item.executable } : {}),
      ...(inputSchema ? { inputSchema } : {}),
    };
  });
  const rawHandoff = payload.handoff && typeof payload.handoff === "object" && !Array.isArray(payload.handoff)
    ? payload.handoff as Record<string, unknown>
    : null;
  const taskId = boundedDisplay(rawHandoff?.taskId, 128);
  const toolKey = boundedDisplay(rawHandoff?.toolKey, 160);
  const handoffArguments = rawHandoff?.arguments && typeof rawHandoff.arguments === "object" && !Array.isArray(rawHandoff.arguments)
    ? rawHandoff.arguments as Record<string, unknown>
    : null;
  let handoffResult: unknown;
  let handoffResultBytes = Number.POSITIVE_INFINITY;
  try {
    handoffResult = rawHandoff?.result;
    handoffResultBytes = new TextEncoder().encode(JSON.stringify(handoffResult)).byteLength;
  } catch {
    handoffResult = undefined;
  }
  const handoff = taskId && /^[a-z0-9_-]+$/i.test(taskId) && /^[a-z0-9][a-z0-9_.:-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(toolKey) && handoffArguments && handoffResultBytes <= 32 * 1024
    ? { taskId, toolKey, arguments: handoffArguments, result: handoffResult }
    : undefined;
  const rawPending = payload.pending && typeof payload.pending === "object" && !Array.isArray(payload.pending)
    ? payload.pending as Record<string, unknown>
    : null;
  const pendingTaskId = boundedDisplay(rawPending?.taskId, 128);
  const pendingToolKey = boundedDisplay(rawPending?.toolKey, 160);
  const pendingArguments = rawPending?.arguments && typeof rawPending.arguments === "object" && !Array.isArray(rawPending.arguments)
    ? rawPending.arguments as Record<string, unknown>
    : null;
  const pending = pendingTaskId && /^[a-z0-9_-]+$/i.test(pendingTaskId)
    && /^[a-z0-9][a-z0-9_.:-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(pendingToolKey) && pendingArguments
    ? { taskId: pendingTaskId, toolKey: pendingToolKey, arguments: pendingArguments }
    : undefined;
  return {
    title: boundedDisplay(payload.title, 120) || `/${command}`,
    summary: boundedDisplay(payload.summary, 1000),
    items,
    ...(handoff ? { handoff } : {}),
    ...(pending ? { pending } : {}),
  };
}

export async function controlAgentSandbox(
  env: Env,
  authority: SandboxControlAuthority,
  action: "status" | "pause" | "prepare_resume" | "confirm_resume",
  input: { nonce?: string; reason?: string } = {},
): Promise<SandboxControlResult> {
  const payload = await request(env, "/service/sandbox/control", { ...authority, action, ...input });
  const control = payload.control && typeof payload.control === "object" && !Array.isArray(payload.control)
    ? payload.control as Record<string, unknown> : {};
  return {
    ok: payload.ok === true,
    action: boundedDisplay(payload.action, 40) || action,
    ...(typeof payload.nonce === "string" && /^[a-f0-9]{32}$/.test(payload.nonce) ? { nonce: payload.nonce } : {}),
    ...(typeof payload.expiresAt === "string" ? { expiresAt: payload.expiresAt } : {}),
    ...(payload.alreadyPaused === true ? { alreadyPaused: true } : {}),
    ...(payload.alreadyRunning === true ? { alreadyRunning: true } : {}),
    ...(payload.tasksRemainPaused === true ? { tasksRemainPaused: true } : {}),
    control: {
      paused: control.paused === true,
      generation: Number(control.generation ?? 0),
      activeTasks: Number(control.activeTasks ?? 0),
      pendingApprovals: Number(control.pendingApprovals ?? 0),
      unknownSideEffects: Number(control.unknownSideEffects ?? 0),
      sandboxEnabled: control.sandboxEnabled === true,
      p2ReadEnabled: control.p2ReadEnabled === true,
      codeModeEnabled: control.codeModeEnabled === true,
    },
  };
}

async function request(env: Env, path: string, body: unknown, approval = false): Promise<Record<string, unknown>> {
  if (!env.AGENT_SERVICE) throw new Error("agent_service_missing");
  const response = await env.AGENT_SERVICE.fetch(`https://<AGENT_SERVICE>.internal${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer(env, approval)}` }, body: JSON.stringify(body),
  });
  const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) throw new Error(`agent_http_${response.status}:${boundedServiceErrorCode(payload.error)}:${boundedServiceErrorCode(payload.message)}`);
  return payload;
}

async function mutateService(
  env: Env,
  path: string,
  method: "PUT" | "PATCH",
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  if (!env.AGENT_SERVICE) throw new Error("agent_service_missing");
  const response = await env.AGENT_SERVICE.fetch(`https://<AGENT_SERVICE>.internal${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer(env)}`, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) throw new Error(`agent_http_${response.status}:${boundedServiceErrorCode(payload.error)}:${boundedServiceErrorCode(payload.message)}`);
  return payload;
}

export function tgAgentEnabledForChat(env: Env, chatId: string): boolean {
  return env.TG_AGENT_ENABLED?.trim().toLowerCase() === "true" && Boolean(env.TG_AGENT_OWNER_CHAT_ID?.trim()) && chatId === env.TG_AGENT_OWNER_CHAT_ID?.trim();
}

export function shouldUseAgentForResponse(env: Env, chatId: string, response: { choices?: Array<{ message?: { tool_calls?: unknown } }> }): boolean {
  if (!tgAgentEnabledForChat(env, chatId)) return false;
  const calls = response.choices?.[0]?.message?.tool_calls;
  return Array.isArray(calls) && calls.some((call) => Boolean(call && typeof call === "object" &&
    (call as { type?: string }).type === "function" &&
    ["request_context", "delegate_action", "browse_web", "browser_markdown", "search_web", "generate_image", "speak", "react_to_message", "reply_to_message"].includes(
      String((call as { function?: { name?: string } }).function?.name ?? "")
    )));
}

export function agentScope(env: Env, chatId: string, taskId: string, purpose: string, requestHash: string): AgentScope {
  return { namespace: "default", chatId, taskId, recipient: "glm-planner", purpose, requestHash,
    ownerId: env.TG_AGENT_OWNER_ID?.trim() || chatId, serviceId: env.TG_AGENT_SERVICE_ID?.trim() || "telegram-agent" };
}

export async function createAgentCapsule(env: Env, scope: AgentScope): Promise<string> {
  const payload = await request(env, "/service/context/capsules", { ...scope, ttlMs: 15 * 60_000, maxBytes: 4096, refs: [] });
  const capsule = payload.capsule as Record<string, unknown> | undefined;
  if (typeof capsule?.capsuleId !== "string") throw new Error("agent_capsule_missing");
  return capsule.capsuleId;
}

export async function submitAgentTask(env: Env, scope: AgentScope, capsuleId: string, instruction: string): Promise<{ taskId: string }> {
  const payload = await request(env, "/service/tasks", { ...scope, capsuleId, instruction, idempotencyKey: `tg:${scope.chatId}:${scope.taskId}` });
  if (typeof payload.taskId !== "string") throw new Error("agent_task_missing");
  return { taskId: payload.taskId };
}

export async function submitDirectAgentTask(
  env: Env,
  scope: AgentScope,
  capsuleId: string,
  call: { serverId: "browser" | "grok" | "voice"; toolName: "browser_markdown" | "search_web" | "generate_image" | "speak"; args: Record<string, unknown> },
): Promise<{ taskId: string }> {
  const payload = await request(env, "/service/tasks/direct", {
    ...scope, capsuleId, instruction: call.toolName, directCall: call,
    idempotencyKey: `tg:${scope.chatId}:${scope.taskId}`,
  });
  if (typeof payload.taskId !== "string") throw new Error("agent_task_missing");
  return { taskId: payload.taskId };
}

export async function synthesizeAgentVoice(env: Env, text: string, mode: "realtime" | "quality" | "expressive" = "expressive"): Promise<Record<string, unknown>> {
  return request(env, "/service/providers/voice/synthesize", { text, mode });
}

export type AgentTaskSnapshot = {
  taskId?: string;
  status?: string;
  revision?: number;
  eventType?: string;
  phase?: string;
  detail?: { tool?: string; action?: string; mode?: string; step?: number; total?: number; round?: number; callCount?: number };
  updatedAt?: string;
  controls?: { pause?: boolean; resume?: boolean; step?: boolean; readOnly?: boolean; stop?: boolean };
  browserLease?: { state?: string; mode?: string; profileId?: string; usedSteps?: number; maxSteps?: number; deadlineAt?: string } | null;
};

export async function getAgentTask(env: Env, taskId: string): Promise<{ status: string; checkpoint: Record<string, unknown> | null; snapshot: AgentTaskSnapshot | null }> {
  if (!env.AGENT_SERVICE) throw new Error("agent_service_missing");
  const response = await env.AGENT_SERVICE.fetch(`https://<AGENT_SERVICE>.internal/service/tasks/${encodeURIComponent(taskId)}`, { headers: { authorization: `Bearer ${bearer(env)}` } });
  const payload = await response.json<Record<string, unknown>>();
  if (!response.ok) throw new Error(`agent_task_http_${response.status}`);
  const task = payload.task as Record<string, unknown>;
  let checkpoint: Record<string, unknown> | null = null;
  try { checkpoint = typeof task.checkpoint_json === "string" ? JSON.parse(task.checkpoint_json) : null; } catch { checkpoint = null; }
  const snapshot = payload.snapshot && typeof payload.snapshot === "object" && !Array.isArray(payload.snapshot)
    ? payload.snapshot as AgentTaskSnapshot : null;
  return { status: String(task.status ?? "unknown"), checkpoint, snapshot };
}

export async function getAgentTaskEvents(env: Env, taskId: string, afterRevision = 0): Promise<{
  snapshot: AgentTaskSnapshot | null;
  events: Array<{ revision: number; event_type: string; safe_summary: string; detail_json: string; created_at: string }>;
}> {
  const payload = await readService(env, `/service/tasks/${encodeURIComponent(taskId)}/events?after_revision=${Math.max(0, Math.floor(afterRevision))}`);
  return {
    snapshot: payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot as AgentTaskSnapshot : null,
    events: Array.isArray(payload.events) ? payload.events as Array<{ revision: number; event_type: string; safe_summary: string; detail_json: string; created_at: string }> : [],
  };
}

export async function controlAgentTask(
  env: Env,
  taskId: string,
  action: "pause" | "resume" | "step" | "read_only" | "stop",
  authority: { ownerId: string; chatId: string },
): Promise<AgentTaskSnapshot | null> {
  const payload = await request(env, `/service/tasks/${encodeURIComponent(taskId)}/control`, { action, ...authority });
  return payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot as AgentTaskSnapshot : null;
}

export async function waitForAgentTask(env: Env, taskId: string): Promise<{ status: string; result: unknown }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = await getAgentTask(env, taskId);
    if (["completed", "failed", "cancelled", "approval_required", "policy_approval_required", "attention_required"].includes(task.status)) {
      return { status: task.status, result: task.checkpoint };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { status: "pending", result: { taskId } };
}

export async function prepareAgentApproval(env: Env, taskId: string): Promise<Record<string, unknown>> {
  return request(env, "/service/approvals/prepare", { taskId }, true);
}

export async function forwardApprovalToAgent(env: Env, input: { ticketId: string; action: ApprovalAction | "stop"; ownerId: string; chatId: string }): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    await request(env, `/service/approvals/${input.ticketId}/decision`, input, true);
    return { ok: true, status: 202, message: input.action === "stop" ? "已停止任务。" : input.action === "reject" ? "已拒绝当前动作。" : input.action === "task" ? "本任务内已允许这项调用。" : "已允许这一次调用。" };
  } catch (error) {
    const text = String(error); const status = Number(/agent_http_(\d+)/.exec(text)?.[1] ?? 503);
    return { ok: false, status, message: status === 409 ? "这个审批已经处理或失效。" : "审批暂时无法处理。" };
  }
}

export async function wakeThinkApprovalContinuation(env: Env, input: {
  ticketId: string;
  decisionScope: "once" | "task" | "reject";
  ownerId: string;
  chatId: string;
  scopeKind: "private" | "qa_room";
  threadKey: string;
}): Promise<{ found: boolean; status: number }> {
  const key = env.TG_CHAT_API_KEY?.trim();
  if (!env.MEMORY_SERVICE || !key) throw new Error("think_approval_memory_service_missing");
  const response = await env.MEMORY_SERVICE.fetch("https://<MEMORY_SERVICE>.internal/service/think/approval-wake", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 404) return { found: false, status: 404 };
  if (response.status === 409) return { found: true, status: 409 };
  if (!response.ok) throw new Error(`think_approval_wake_http_${response.status}`);
  return { found: true, status: response.status };
}

export async function resolveThinkSdkActionFromTelegram(env: Env, input: {
  approvalRef: string;
  decision: "approve" | "reject";
  ownerId: string;
  chatId: string;
  scopeKind: "private" | "qa_room";
  threadKey: string;
}): Promise<{ ok: boolean; status: number; message: string }> {
  const key = env.TG_CHAT_API_KEY?.trim();
  if (!env.MEMORY_SERVICE || !key) throw new Error("think_sdk_action_memory_service_missing");
  const response = await env.MEMORY_SERVICE.fetch("https://<MEMORY_SERVICE>.internal/service/think/sdk-action-decision", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.ok) return { ok: true, status: response.status,
    message: input.decision === "approve" ? "已允许这一次调用，Operia 会自动继续回复。" : "已拒绝当前动作，Operia 会继续处理。" };
  const payload = await response.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const state = typeof payload.status === "string" ? payload.status : "unknown";
  const message = response.status === 410 || state === "expired"
    ? "这个审批已经过期，请重新发起请求。"
    : response.status === 403
      ? "这张审批卡不属于当前会话，已拒绝处理。"
      : response.status === 404 || state === "missing"
        ? "没有找到这张审批卡，请重新发起请求。"
        : state === "decision_pending"
          ? "允许已收到，任务正在后台队列中等待执行；不用重复点击。"
          : state === "resolving"
          ? "允许已收到，正在开始执行；不用重复点击。"
          : state === "continuing"
            ? "允许已经生效，Operia 正在继续处理；不用重复点击。"
            : state === "completed"
              ? "这张审批卡已经结束；如果同一请求中选择了另一项，本动作没有执行。请等待系统结果。"
              : state === "attention_required"
                ? "这次调用需要人工检查；不会自动重试。"
                : state === "pending_approval"
                  ? "审批尚未进入执行队列，本次没有执行。请稍后重新点击这张卡。"
                  : "审批暂时无法处理。";
  return { ok: false, status: response.status,
    message };
}

export async function stopThinkApprovalContinuationFromTelegram(env: Env, input: {
  taskId?: string;
  ticketId?: string;
  ownerId: string;
  chatId: string;
  scopeKind: "private" | "qa_room";
  threadKey: string;
}): Promise<{ found: boolean; status: number }> {
  const key = env.TG_CHAT_API_KEY?.trim();
  if (!env.MEMORY_SERVICE || !key) throw new Error("think_approval_memory_service_missing");
  const response = await env.MEMORY_SERVICE.fetch("https://<MEMORY_SERVICE>.internal/service/think/approval-wake", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...input, action: "stop" }),
  });
  if (response.status === 404) return { found: false, status: 404 };
  if (!response.ok) throw new Error(`think_approval_stop_http_${response.status}`);
  return { found: true, status: response.status };
}

export async function stopThinkCodeModeContinuationFromTelegram(env: Env, input: {
  codemodeRef: string;
  ownerId: string;
  chatId: string;
  scopeKind: "private" | "qa_room";
  threadKey: string;
}): Promise<{ found: boolean; status: number }> {
  const key = env.TG_CHAT_API_KEY?.trim();
  if (!env.MEMORY_SERVICE || !key) throw new Error("think_codemode_memory_service_missing");
  const response = await env.MEMORY_SERVICE.fetch("https://<MEMORY_SERVICE>.internal/service/think/codemode-wake", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...input, action: "stop" }),
  });
  if (response.status === 404) return { found: false, status: 404 };
  if (!response.ok) throw new Error(`think_codemode_stop_http_${response.status}`);
  return { found: true, status: response.status };
}

export async function readApprovalDetailsFromAgent(
  env: Env,
  input: { ticketId: string; ownerId: string; chatId: string },
): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    const payload = await request(env, `/service/approvals/${input.ticketId}/details`, input, true);
    return { ok: true, status: 200, message: boundedDisplay(payload.summary, 900) || "审批详情暂不可用。" };
  } catch (error) {
    const text = String(error); const status = Number(/agent_http_(\d+)/.exec(text)?.[1] ?? 503);
    return { ok: false, status, message: status === 409 ? "这个审批已经处理或失效。" : "审批详情暂时无法读取。" };
  }
}

export async function forwardBrowserDomainDecision(env: Env, input: { challengeId: string; action: BrowserDomainDecisionAction; ownerId: string; chatId: string }): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    await request(env, `/service/browser/domain-challenges/${encodeURIComponent(input.challengeId)}/decision`, input, true);
    return { ok: true, status: 202, message: "已记录你的域名访问决定。" };
  } catch (error) {
    const text = String(error); const status = Number(/agent_http_(\d+)/.exec(text)?.[1] ?? 503);
    return { ok: false, status, message: status === 409 ? "这个域名挑战已经处理或失效。" : "域名访问决定暂时无法处理。" };
  }
}

export async function forwardMcpElicitationDecision(env: Env, input: {
  ticketId: string;
  action: "accept" | "decline" | "cancel";
  ownerId: string;
  chatId: string;
}): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    await request(env, `/service/mcp/elicitations/${encodeURIComponent(input.ticketId)}/decision`, input, true);
    return { ok: true, status: 202, message: input.action === "accept" ? "已继续 MCP 任务。" : "已记录你的决定。" };
  } catch (error) {
    const text = String(error); const status = Number(/agent_http_(\d+)/.exec(text)?.[1] ?? 503);
    return {
      ok: false,
      status,
      message: status === 422 ? "这个请求需要先在 MCP 工作台填写表单。" : status === 409 ? "这个请求已经处理或失效。" : "MCP 请求暂时无法处理。",
    };
  }
}
