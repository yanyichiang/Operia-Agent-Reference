import type { Env, OpenAIChatResponse } from "../types";
import { nowIso } from "../utils/time";
import { controlAgentTask, getAgentTaskEvents, type AgentTaskSnapshot } from "./agentClient";
import { deliverTgOutbox, enqueueTgOutbox } from "./outbox";
import { getTgSetting, recordTgEvent } from "./settings";

export type TaskProgressMode = "live" | "compact" | "off";

type PresentationRow = {
  task_id: string;
  chat_id: string;
  telegram_message_id: string | null;
  mode: TaskProgressMode;
  status: string;
  last_revision: number;
  last_phase: string | null;
  last_text: string | null;
};

const TERMINAL = new Set(["completed","succeeded","failed","partial","unknown","cancelled_before_execution","cancelled","attention_required"]);
const OWNER_DECISION = new Set(["approval_required", "policy_approval_required", "attention_required"]);

export async function startTaskPresentation(env: Env, input: { taskId: string; chatId: string; continuationId?: string }): Promise<void> {
  if (env.TASK_PROGRESS_ENABLED?.trim().toLowerCase() !== "true") return;
  const mode = await getTgSetting<TaskProgressMode>(env.DB, "telegram.presentation.task_progress_mode", "live");
  if (mode === "off") return;
  const existing = await presentation(env, input.taskId);
  if (existing) return;
  const now = nowIso();
  await env.DB.prepare(`INSERT OR IGNORE INTO tg_task_presentations
    (task_id,continuation_id,chat_id,mode,status,last_revision,last_text,created_at,updated_at)
    VALUES (?,?,?,?, 'active',0,?,?,?)`).bind(input.taskId, input.continuationId ?? null, input.chatId, mode, "我开始处理这项任务了。", now, now).run();
  const outboxId = await enqueueTgOutbox(env.DB, {
    id: crypto.randomUUID(), intentKey: `tg-progress:${input.taskId}:initial`, chatId: input.chatId,
    payload: progressPayload(input.taskId, "状态：正在规划", { stop: true }),
  });
  if (await deliverTgOutbox(env, outboxId) === "sent") {
    const sent = await env.DB.prepare("SELECT telegram_message_id FROM tg_agent_outbox WHERE id=?").bind(outboxId).first<{ telegram_message_id: string | null }>();
    await env.DB.prepare("UPDATE tg_task_presentations SET telegram_message_id=?,updated_at=? WHERE task_id=?")
      .bind(sent?.telegram_message_id ?? null, nowIso(), input.taskId).run();
  }
}

export async function trackTaskPresentation(env: Env, taskId: string, maxMs = 52_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const done = await refreshTaskPresentation(env, taskId);
    if (done) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

export async function refreshActiveTaskPresentations(env: Env, limit = 10): Promise<number> {
  const rows = await env.DB.prepare("SELECT task_id FROM tg_task_presentations WHERE status='active' ORDER BY updated_at LIMIT ?")
    .bind(limit).all<{ task_id: string }>();
  for (const row of rows.results ?? []) await refreshTaskPresentation(env, row.task_id);
  return rows.results?.length ?? 0;
}

export async function refreshTaskPresentation(env: Env, taskId: string): Promise<boolean> {
  const row = await presentation(env, taskId);
  if (!row || row.status !== "active") return true;
  let current;
  try { current = await getAgentTaskEvents(env, taskId, row.last_revision); }
  catch { return false; }
  const snapshot = current.snapshot;
  const terminal = TERMINAL.has(String(snapshot?.status ?? ""));
  const newest = current.events.at(-1);
  const revision = Number(newest?.revision ?? snapshot?.revision ?? row.last_revision);
  const phase = String(snapshot?.phase ?? newest?.event_type ?? "executing");
  const shouldUpdate = terminal || (revision > row.last_revision && (row.mode === "live" || phase !== row.last_phase));
  if (!shouldUpdate) return terminal;
  const safeSummary = String(newest?.safe_summary || terminalSummary(String(snapshot?.status ?? ""))).slice(0, 500);
  const text = deterministicProgressText(safeSummary, snapshot);
  const tool = progressTool(snapshot, current.events);
  await editPresentation(env, row, text, snapshot, tool);
  await env.DB.prepare(`UPDATE tg_task_presentations SET last_revision=?,last_phase=?,last_text=?,last_narrated_at=?,
    status=?,updated_at=? WHERE task_id=?`).bind(revision, phase, text, nowIso(), terminal ? "terminal" : "active", nowIso(), taskId).run();
  return terminal;
}

export async function handleTaskControlCallback(
  env: Env,
  input: { taskId: string; action: "pause" | "resume" | "step" | "read_only" | "stop"; ownerId: string; chatId: string },
): Promise<string> {
  const snapshot = await controlAgentTask(env, input.taskId, input.action, { ownerId: input.ownerId, chatId: input.chatId });
  await refreshTaskPresentation(env, input.taskId);
  await recordTgEvent(env.DB, { chatId: input.chatId, eventType: "task.control", status: input.action,
    metadata: { taskId: input.taskId, ownerId: input.ownerId } });
  return input.action === "pause" ? "当前任务树的暂停请求已提交" : input.action === "resume" ? "当前任务树的恢复请求已提交"
    : input.action === "step" ? "将单步执行" : input.action === "read_only" ? "已切为只读"
      : snapshot?.status === "cancelled_before_execution" ? "任务在执行前已取消"
        : "停止请求已提交；外部动作结果以最终 Receipt 为准";
}

export async function controlLatestTaskForChat(
  env: Env,
  chatId: string,
  action: "pause" | "resume" | "step" | "read_only" | "stop",
): Promise<{ status: "not_found" | "controlled"; taskId?: string; message?: string }> {
  const row = await env.DB.prepare("SELECT task_id FROM tg_task_presentations WHERE chat_id=? AND status='active' ORDER BY updated_at DESC LIMIT 1")
    .bind(chatId).first<{ task_id: string }>();
  if (!row) return { status: "not_found" };
  const ownerId = env.TG_AGENT_OWNER_ID?.trim() || chatId;
  const message = await handleTaskControlCallback(env, { taskId: row.task_id, action, ownerId, chatId });
  return { status: "controlled", taskId: row.task_id, message };
}

export function responseStatusPayload(text: string, response: OpenAIChatResponse, toolSummary: string, enabled: boolean): Record<string, unknown> {
  if (!enabled) return { text };
  const usage = response.usage ?? {};
  const model = String(response.model ?? "unknown");
  const tier = String(response.service_tier ?? "未返回");
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
  const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
  const think = response.operia_think;
  const modelCalls = think && typeof think === "object" && !Array.isArray(think)
    ? Number((think as Record<string,unknown>).model_calls ?? 0)
    : 0;
  const status = `<blockquote expandable><b>状态</b>\n${escapeHtml(toolSummary || "Tools: no tool")}\nmodel / tier: ${escapeHtml(model)} / ${escapeHtml(tier)}\nmodel calls: ${modelCalls}\ninput / output（本任务累计）: ${input} / ${output}\ncache read / create（本任务累计）: ${cacheRead} / ${cacheCreate}</blockquote>`;
  return { text: `${text ? `${escapeHtml(text)}\n\n` : ""}${status}`, parse_mode: "HTML" };
}

async function editPresentation(env: Env, row: PresentationRow, text: string, snapshot: AgentTaskSnapshot | null, tool?: string): Promise<void> {
  if (!row.telegram_message_id) return;
  const controls = OWNER_DECISION.has(String(snapshot?.status ?? ""))
    ? { stop: snapshot?.controls?.stop !== false }
    : snapshot?.controls ?? {};
  const id = await enqueueTgOutbox(env.DB, {
    id: crypto.randomUUID(), intentKey: `tg-progress:${row.task_id}:r${snapshot?.revision ?? row.last_revision + 1}`, chatId: row.chat_id,
    payload: { method: "editMessageText", message_id: row.telegram_message_id, ...progressPayload(row.task_id, text, controls, tool) },
  });
  await deliverTgOutbox(env, id);
}

function progressPayload(taskId: string, text: string, controls: AgentTaskSnapshot["controls"], tool?: string): Record<string, unknown> {
  const buttons = [
    controls?.pause ? { text: "暂停", callback_data: `taskctl:pause:${taskId}` } : null,
    controls?.resume ? { text: "继续", callback_data: `taskctl:resume:${taskId}` } : null,
    controls?.step ? { text: "单步", callback_data: `taskctl:step:${taskId}` } : null,
    controls?.readOnly ? { text: "只读", callback_data: `taskctl:read_only:${taskId}` } : null,
    controls?.stop ? { text: "停止", callback_data: `taskctl:stop:${taskId}` } : null,
  ].filter(Boolean);
  const title = tool ? `Operia 调用了 ${displayTool(tool)}` : "Operia 正在处理任务";
  return { text: `${title}\n${taskId}\n\n${text}`, ...(buttons.length ? { reply_markup: { inline_keyboard: [buttons] } } : { reply_markup: { inline_keyboard: [] } }) };
}

function deterministicProgressText(safeSummary: string, snapshot: AgentTaskSnapshot | null): string {
  const status = String(snapshot?.status ?? snapshot?.phase ?? "executing");
  if (status === "planning" || status === "accepted") return "状态：正在规划";
  if (status === "executing") return "状态：正在执行";
  if (status === "approval_required" || status === "policy_approval_required") return "状态：审批步骤";
  if (status === "paused") return "状态：已暂停";
  if (status === "completed") return "状态：已完成";
  if (status === "succeeded") return "状态：已完成";
  if (status === "partial") return "状态：部分完成，需要核对";
  if (status === "unknown") return "状态：外部结果未知，需要检查";
  if (status === "cancelled_before_execution") return "状态：执行前已取消";
  if (status === "cancelled") return "状态：旧任务已停止；请核对是否存在外部副作用";
  if (status === "attention_required") return "状态：需要检查";
  if (status === "failed") return "状态：执行失败";
  return safeSummary;
}

function progressTool(
  snapshot: AgentTaskSnapshot | null,
  events: Array<{ detail_json: string }>,
): string | undefined {
  if (snapshot?.detail?.tool) return snapshot.detail.tool;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    try {
      const detail = JSON.parse(events[index].detail_json) as { tool?: unknown };
      if (typeof detail.tool === "string" && detail.tool.trim()) return detail.tool.trim().slice(0, 120);
    } catch {
      // Progress detail is optional and untrusted; a malformed row must not block status delivery.
    }
  }
  return undefined;
}

function displayTool(tool: string): string {
  const [serverId, toolName] = tool.split("/", 2);
  if (serverId === "sandbox-runtime" && toolName === "execute_script") return "Sandbox · execute_script";
  if (serverId === "browser") return `Browser${toolName ? ` · ${toolName}` : ""}`;
  if (serverId === "grok") return `联网工具${toolName ? ` · ${toolName}` : ""}`;
  if (serverId === "voice") return `语音工具${toolName ? ` · ${toolName}` : ""}`;
  if (serverId === "home-assistant") return `Home Assistant${toolName ? ` · ${toolName}` : ""}`;
  return tool;
}

async function presentation(env: Env, taskId: string): Promise<PresentationRow | null> {
  return env.DB.prepare("SELECT task_id,chat_id,telegram_message_id,mode,status,last_revision,last_phase,last_text FROM tg_task_presentations WHERE task_id=?")
    .bind(taskId).first<PresentationRow>();
}

function terminalSummary(status: string): string {
  return status === "completed" || status === "succeeded" ? "任务已经完成。"
    : status === "cancelled_before_execution" ? "任务在执行前已取消。"
      : status === "partial" ? "任务部分完成，需要核对剩余步骤。"
        : status === "unknown" || status === "cancelled" ? "任务的外部结果无法完全确认，需要检查 Receipt。"
          : status === "attention_required" ? "任务需要你的注意。" : "任务没有完成。";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] || character);
}
