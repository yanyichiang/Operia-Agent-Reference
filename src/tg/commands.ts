import type { Env } from "../types";
import { getAgentHeartbeatProjection, getAgentRuntimeSnapshot, invokeAgentTelegramCommand, isAgentCommandOwner, type AgentTelegramCommandItem, type AgentTelegramCommandResult } from "./agentClient";
import { consumePendingCommand, getChatConfig, getTgSetting, recordTgEvent, setPendingCommand, setTgSetting, setVoiceMode, type TgPendingAction } from "./settings";
import { editMessageWithKeyboard, sendMessageWithKeyboard, sendMessageChunks } from "./telegram";
import { getTgMemoryControls, resetTgMemoryControl, setTgMemoryControl } from "./memoryControlClient";
import { completeToolCommandWithOpus, persistToolCommandWithOpus } from "./toolCommandContinuation";
import { controlLatestTaskForChat } from "./taskPresentation";
import { encodeMcpMenuCallback, findProviderByRef, findToolByRef, parseMcpMenuCallback, providerRef, simpleSchemaFields, toolRef, type McpSimpleField } from "./mcpMenu";
import { deliverTgSystemReceipt } from "./systemReceipt";

export const MENU_COMMANDS = [
  ["use", "选择 Operia 接下来使用的能力"],
  ["search", "下一条消息使用联网检索"],
  ["browser", "下一条消息使用网页交互"],
  ["image", "下一条消息生成或编辑图片"],
  ["voice", "下一条消息请求语音回复"],
  ["pause", "暂停当前任务树"],
  ["resume", "恢复当前暂停任务树"],
  ["cancel", "取消当前操作"]
] as const;

export type MenuCommandName = typeof MENU_COMMANDS[number][0];
type CommandHandlerName = MenuCommandName | "start" | "new" | "status" | "think" | "mcp" | "skills"
  | "model" | "memory" | "remember" | "persona" | "skill";

export interface AcceptedCommandDefinition {
  command: string;
  canonicalCommand: CommandHandlerName;
  argsPrefix?: string;
  emptyArgs?: string;
  description: string;
  visibility: "menu" | "compatibility";
}

export const ACCEPTED_COMMANDS: readonly AcceptedCommandDefinition[] = [
  ...MENU_COMMANDS.map(([command, description]) => ({ command, canonicalCommand: command, description, visibility: "menu" as const })),
  { command: "start", canonicalCommand: "start", description: "兼容：打开私人助手菜单", visibility: "compatibility" },
  { command: "new", canonicalCommand: "new", description: "兼容：开始新的短期会话", visibility: "compatibility" },
  { command: "status", canonicalCommand: "status", description: "兼容：查看运行状态", visibility: "compatibility" },
  { command: "think", canonicalCommand: "think", description: "兼容：推理展示设置", visibility: "compatibility" },
  { command: "mcp", canonicalCommand: "mcp", description: "兼容：MCP 工具目录", visibility: "compatibility" },
  { command: "skills", canonicalCommand: "skills", description: "兼容：Skills 目录", visibility: "compatibility" },
  { command: "model", canonicalCommand: "model", description: "选择 Telegram 模型", visibility: "compatibility" },
  { command: "memory", canonicalCommand: "memory", description: "查看记忆入口", visibility: "compatibility" },
  { command: "remember", canonicalCommand: "remember", description: "显式写入长期记忆", visibility: "compatibility" },
  { command: "persona", canonicalCommand: "persona", description: "查看稳定助手人格", visibility: "compatibility" },
  { command: "voice_auto", canonicalCommand: "voice", argsPrefix: "auto", description: "兼容：/voice auto", visibility: "compatibility" },
  { command: "voice_realtime", canonicalCommand: "voice", argsPrefix: "model realtime", description: "兼容：/voice model realtime", visibility: "compatibility" },
  { command: "voice_quality", canonicalCommand: "voice", argsPrefix: "model quality", description: "兼容：/voice model quality", visibility: "compatibility" },
  { command: "voice_expressive", canonicalCommand: "voice", argsPrefix: "model expressive", description: "兼容：/voice model expressive", visibility: "compatibility" },
  { command: "voice_off", canonicalCommand: "voice", argsPrefix: "off", description: "兼容：/voice off", visibility: "compatibility" },
  { command: "think_on", canonicalCommand: "think", argsPrefix: "show summary", description: "兼容：/think show summary", visibility: "compatibility" },
  { command: "think_off", canonicalCommand: "think", argsPrefix: "show off", description: "兼容：/think show off", visibility: "compatibility" },
  { command: "think_debug", canonicalCommand: "think", argsPrefix: "show debug", description: "兼容：/think show debug", visibility: "compatibility" },
  { command: "reasoning", canonicalCommand: "think", argsPrefix: "reasoning", description: "兼容：/think reasoning", visibility: "compatibility" },
  { command: "temperature", canonicalCommand: "think", argsPrefix: "temperature", description: "兼容：/think temperature", visibility: "compatibility" },
  { command: "usage", canonicalCommand: "status", argsPrefix: "usage", description: "兼容：/status usage", visibility: "compatibility" },
  { command: "tool", canonicalCommand: "mcp", argsPrefix: "run", emptyArgs: "list", description: "兼容：/mcp run", visibility: "compatibility" },
  { command: "skill", canonicalCommand: "skill", description: "兼容：/skills run", visibility: "compatibility" },
  { command: "stop", canonicalCommand: "cancel", description: "兼容：/cancel", visibility: "compatibility" },
  { command: "help", canonicalCommand: "start", description: "兼容：/start", visibility: "compatibility" },
] as const;

const ACCEPTED_COMMAND_REGISTRY = new Map(ACCEPTED_COMMANDS.map((definition) => [definition.command, definition]));

const HELP_ALIASES = new Map([
  ["think_on", "think-on"],
  ["think_off", "think-off"],
  ["think_debug", "think-debug"],
]);

export function displayCommandName(name: string): string {
  return HELP_ALIASES.get(name) || name;
}

export const TG_COMMAND_LIMITS = {
  totalArgsChars: 2048,
  toolAliasChars: 64,
  toolArgCount: 12,
  toolKeyChars: 64,
  toolValueChars: 512,
  skillNameChars: 64,
  skillArgsChars: 1000,
} as const;

export const TG_MODELS = ["companion", "opus-4.5", "opus-4.6", "fable-5"] as const;

export interface ParsedCommand { name: string; args: string }

const CODEX_COMMAND_ENVELOPE = "[Codex] ";

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  const commandText = trimmed.startsWith(CODEX_COMMAND_ENVELOPE)
    ? trimmed.slice(CODEX_COMMAND_ENVELOPE.length)
    : trimmed;
  const match = commandText.match(/^\/([a-z0-9_-]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  return match ? { name: match[1].toLowerCase().replaceAll("-", "_"), args: (match[2] || "").trim() } : null;
}

export function shouldEnqueueAsChat(text: string): boolean {
  return parseCommand(text) === null;
}

export function buildBotFatherCommands(): Array<{ command: string; description: string }> {
  return MENU_COMMANDS.map(([command, description]) => ({ command, description }));
}

export function compatibilityCommands(): AcceptedCommandDefinition[] {
  return ACCEPTED_COMMANDS.filter((definition) => definition.visibility === "compatibility").map((definition) => ({ ...definition }));
}

export function resolveAcceptedCommand(command: ParsedCommand): ParsedCommand | null {
  const definition = ACCEPTED_COMMAND_REGISTRY.get(command.name);
  if (!definition) return null;
  const args = command.args
    ? [definition.argsPrefix, command.args].filter(Boolean).join(" ")
    : definition.emptyArgs ?? definition.argsPrefix ?? "";
  return { name: definition.canonicalCommand, args };
}

const CONTROL_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const TOOL_KEY = /^[a-z][a-z0-9_.-]*$/;

export type ParsedToolControl =
  | { action: "catalog" }
  | { action: "execute"; alias: string; args: Record<string, string> };

export function parseToolControlArgs(raw: string): ParsedToolControl {
  if (raw.length > TG_COMMAND_LIMITS.totalArgsChars) throw new Error("tool_args_too_long");
  const tokens = raw.trim() ? raw.trim().split(/\s+/) : [];
  if (tokens.length === 0) return { action: "catalog" };
  const alias = tokens.shift()!.toLowerCase();
  if (alias.length > TG_COMMAND_LIMITS.toolAliasChars || !CONTROL_NAME.test(alias)) throw new Error("tool_alias_invalid");
  if (tokens.length > TG_COMMAND_LIMITS.toolArgCount) throw new Error("tool_args_too_many");
  const args: Record<string, string> = {};
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator < 1) throw new Error("tool_arg_invalid");
    const key = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1);
    if (key.length > TG_COMMAND_LIMITS.toolKeyChars || !TOOL_KEY.test(key) || value.length > TG_COMMAND_LIMITS.toolValueChars || key in args) {
      throw new Error("tool_arg_invalid");
    }
    args[key] = value;
  }
  return { action: "execute", alias, args };
}

export type ParsedSkillControl =
  | { action: "catalog" }
  | { action: "execute"; name: string; args: string };

export function parseSkillControlArgs(raw: string): ParsedSkillControl {
  if (raw.length > TG_COMMAND_LIMITS.totalArgsChars) throw new Error("skill_args_too_long");
  const match = raw.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return { action: "catalog" };
  const name = match[1].toLowerCase();
  const args = (match[2] || "").trim();
  if (name.length > TG_COMMAND_LIMITS.skillNameChars || !CONTROL_NAME.test(name)) throw new Error("skill_name_invalid");
  if (args.length > TG_COMMAND_LIMITS.skillArgsChars) throw new Error("skill_args_too_long");
  return { action: "execute", name, args };
}

export type ParsedMcpHub =
  | { action: "catalog" }
  | { action: "provider"; provider: string }
  | { action: "execute"; provider: string; tool: string; args: Record<string, string> }
  | { action: "legacy_execute"; toolArgs: string };

const MCP_IDENTIFIER = /^[a-z0-9][a-z0-9_.:-]*$/;

function parseMcpIdentifier(value: string, code: string): string {
  const normalized = value.toLowerCase();
  if (!normalized || normalized.length > 128 || !MCP_IDENTIFIER.test(normalized)) throw new Error(code);
  return normalized;
}

function parseMcpKeyValueArgs(tokens: string[]): Record<string, string> {
  if (tokens.length > TG_COMMAND_LIMITS.toolArgCount) throw new Error("tool_args_too_many");
  const args: Record<string, string> = {};
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator < 1) throw new Error("tool_arg_invalid");
    const key = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1);
    if (key.length > TG_COMMAND_LIMITS.toolKeyChars || !TOOL_KEY.test(key) || value.length > TG_COMMAND_LIMITS.toolValueChars || key in args) {
      throw new Error("tool_arg_invalid");
    }
    args[key] = value;
  }
  return args;
}

export function parseMcpHubArgs(raw: string): ParsedMcpHub {
  if (raw.length > TG_COMMAND_LIMITS.totalArgsChars) throw new Error("tool_args_too_long");
  const tokens = raw.trim() ? raw.trim().split(/\s+/) : [];
  if (tokens.length === 0) return { action: "catalog" };
  const subcommand = tokens.shift()!.toLowerCase();
  if (subcommand === "list" || subcommand === "status") {
    if (tokens.length !== 0) throw new Error("mcp_subcommand_invalid");
    return { action: "catalog" };
  }
  if (subcommand === "run") {
    if (tokens.length === 0) throw new Error("mcp_subcommand_invalid");
    return { action: "legacy_execute", toolArgs: tokens.join(" ") };
  }
  const provider = parseMcpIdentifier(subcommand, "mcp_provider_invalid");
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0].toLowerCase() === "status")) return { action: "provider", provider };
  const tool = parseMcpIdentifier(tokens.shift()!, "mcp_tool_invalid");
  return { action: "execute", provider, tool, args: parseMcpKeyValueArgs(tokens) };
}

export type ParsedSkillsHub =
  | { action: "catalog" }
  | { action: "detail"; name: string }
  | { action: "execute"; name: string; args: string };

function parseSkillNameOnly(raw: string): string {
  const parsed = parseSkillControlArgs(raw);
  if (parsed.action !== "execute") throw new Error("skill_name_invalid");
  return parsed.name;
}

export function parseSkillHubArgs(raw: string): ParsedSkillsHub {
  if (raw.length > TG_COMMAND_LIMITS.totalArgsChars) throw new Error("skill_args_too_long");
  const [first = "", ...rest] = raw.trim().split(/\s+/);
  if (!first) return { action: "catalog" };
  const subcommand = first.toLowerCase();
  if ((subcommand === "list" || subcommand === "status") && rest.length === 0) return { action: "catalog" };
  if (subcommand === "run") {
    if (rest.length === 0) throw new Error("skill_subcommand_invalid");
    const name = parseSkillNameOnly(rest.join(" "));
    const args = rest.slice(1).join(" ");
    return { action: "execute", name, args };
  }
  const name = parseSkillNameOnly(subcommand);
  if (rest.length === 0) return { action: "detail", name };
  if (rest[0].toLowerCase() !== "run") throw new Error("skill_subcommand_invalid");
  return { action: "execute", name, args: rest.slice(1).join(" ") };
}

function renderAgentCommandResult(result: AgentTelegramCommandResult): string {
  const lines = [result.title];
  if (result.summary) lines.push("", result.summary);
  if (result.items.length) lines.push("", ...result.items.map((item) => `- ${item.label}${item.detail ? `：${item.detail}` : ""}${item.status ? ` [${item.status}]` : ""}`));
  return lines.join("\n");
}

function agentCommandError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code.startsWith("agent_http_404")) return "Agent 端尚未提供这个受限命令 API。";
  if (code.startsWith("agent_http_403")) return "Agent 拒绝了这个命令的 owner 或 allowlist 范围。";
  if (code.includes(":xai:timeout")) return "Grok 搜索超过 Agent 当前等待上限，请稍后重试。";
  if (code.includes(":xai:network_error")) return "Agent 暂时无法连接 xAI，请稍后重试。";
  if (code.includes(":xai:upstream_error")) return "xAI 暂时拒绝了这次请求，请查看 Agent 控制台日志。";
  if (code.startsWith("tool_continuation_") || code === "tool_handoff_missing") return "工具已经执行，但 Opus 暂时没能整理结果，请稍后重试。";
  if (code === "agent_service_missing" || code === "agent_context_auth_missing") return "Agent Service Binding 尚未配置完整。";
  return "Agent 命令暂时不可用，请稍后查看控制台状态。";
}

function formatMetric(value: number | null, suffix = ""): string {
  return value == null ? "未记录" : `${value}${suffix}`;
}

async function sendLatestUsage(env: Env, chatId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT u.model,u.service_tier,u.ttft_ms,u.total_ms,
    u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_creation_tokens
    FROM usage_logs u JOIN messages m ON m.id=u.message_id
    WHERE m.source='telegram' ORDER BY u.created_at DESC LIMIT 1`).first<{
      model: string | null; service_tier: string | null; ttft_ms: number | null; total_ms: number | null;
      input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_creation_tokens: number | null;
    }>();
  if (!row) {
    await sendMessageWithKeyboard(env, chatId, "暂无 Telegram usage 记录。", [[
      { text: "费用摘要入口", url: "https://tgbot.example.com/admin#usage" }
    ]]);
    return;
  }
  await sendMessageWithKeyboard(env, chatId, [
    "最近一次 Telegram 请求",
    "",
    `model / tier：${row.model || "未记录"} / ${row.service_tier || "未返回"}`,
    `TTFT / total：${formatMetric(row.ttft_ms, " ms")} / ${formatMetric(row.total_ms, " ms")}`,
    `input / output：${row.input_tokens ?? 0} / ${row.output_tokens ?? 0}`,
    `cache read / create：${row.cache_read_tokens ?? 0} / ${row.cache_creation_tokens ?? 0}`,
  ].join("\n"), [[{ text: "费用摘要入口", url: "https://tgbot.example.com/admin#usage" }]]);
}

async function recordAgentCommandEvent(env: Env, chatId: string, command: string, status: "ok" | "error", metadata: Record<string, unknown>): Promise<void> {
  try {
    await recordTgEvent(env.DB, { chatId, eventType: `command.${command}`, status, metadata });
  } catch (error) {
    console.error("tg: agent command event write failed", { command, status, error: String(error).slice(0, 160) });
  }
}

async function sendAgentCommandMessage(
  env: Env,
  chatId: string,
  command: string,
  text: string,
  input: { requestId?: string; outcome: "Succeeded" | "Failed"; errorCode?: string; rootTaskId?: string },
): Promise<{ receiptId: string; deliveryStatus: "Sent" | "AttentionRequired" }> {
  const actionId = input.requestId || `tg-command-${crypto.randomUUID()}`;
  const receipt = await deliverTgSystemReceipt(env,chatId,{
    idempotencyKey: `telegram.command:${chatId}:${actionId}:${command}`,
    actionId,
    ownerDomain: ["mcp","skills","tool","skill","browser"].includes(command)
      ? "agent.example.com" : "tgbot.example.com",
    actorId: chatId,
    requester: chatId,
    authorizedBy: chatId,
    operation: `telegram.command.${command}`,
    outcome: input.outcome,
    target: { type: "telegram_command", id: command },
    text,
    ...(input.rootTaskId ? { rootTaskId: input.rootTaskId } : {}),
    ...(input.outcome === "Succeeded" ? { completed: ["command_result_recorded"] }
      : { unexecuted: ["command_not_completed"], errorCode: input.errorCode || "command_failed" }),
    nextStep: input.outcome === "Failed" ? "检查 Agent 状态后使用新的命令请求重试。" : undefined,
    canonicalLink: "https://agent.example.com/control",
  });
  return { receiptId: receipt.receiptId, deliveryStatus: receipt.deliveryStatus };
}

async function runAgentControlCommand(
  env: Env,
  chatId: string,
  command: "tool" | "skill" | "browser",
  args: string,
  publicCommand: string = command,
  requestId?: string,
  parsedInput?: Record<string, unknown> & { action: string },
): Promise<void> {
  if (!isAgentCommandOwner(env, chatId)) {
    await sendMessageChunks(env, chatId, "此命令仅对配置的 Telegram Agent owner 开放。");
    return;
  }
  try {
    const ownerId = env.TG_AGENT_OWNER_ID?.trim() || chatId;
    const input = parsedInput ?? (command === "tool"
      ? parseToolControlArgs(args)
      : command === "skill"
        ? parseSkillControlArgs(args)
        : args ? (() => { throw new Error("browser_args_not_allowed"); })() : { action: "status" as const });
    const result = await invokeAgentTelegramCommand(env, command, { ownerId, chatId, ...(requestId ? { requestId } : {}), ...input });
    let text: string;
    let rootTaskId: string | undefined;
    if ((command === "tool" || command === "skill") && input.action === "execute") {
      const prompt = `/${publicCommand}${args ? ` ${args}` : ""}`;
      if (result.pending) {
        rootTaskId = result.pending.taskId;
        await persistToolCommandWithOpus(env, chatId, prompt, result.pending,requestId);
        text = `工具任务已创建。\ntaskId：${result.pending.taskId}\n完成或需要补充信息时，我会继续更新同一任务。`;
      } else {
        if (!result.handoff) throw new Error("tool_handoff_missing");
        rootTaskId = result.handoff.taskId;
        const scheduled = await completeToolCommandWithOpus(env,chatId,prompt,result.handoff,requestId);
        if (scheduled.kind === "historical_compatibility") {
          await recordAgentCommandEvent(env,chatId,publicCommand,"ok",{
            action:input.action,contract:command,compatibilityReason:scheduled.reason,
            delivery:"historical_publication_already_owned",
          });
          return;
        }
        await recordAgentCommandEvent(env,chatId,publicCommand,"ok",{
          action:input.action,contract:command,publicationBatchKey:scheduled.batchKey,
          delivery:"native_inference_scheduled",
        });
        return;
      }
    } else {
      text = renderAgentCommandResult(result);
    }
    const delivery = await sendAgentCommandMessage(env,chatId,publicCommand,text,{
      requestId,outcome:"Succeeded",...(rootTaskId ? { rootTaskId } : {}),
    });
    await recordAgentCommandEvent(env, chatId, publicCommand, "ok", {
      action: input.action, contract: command, receiptId: delivery.receiptId, deliveryStatus: delivery.deliveryStatus,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    const usage = command === "tool"
      ? publicCommand === "mcp" ? "用法：/mcp [status | <provider> [status | <tool> key=value ...]]" : "用法：/tool [alias key=value ...]"
      : command === "skill"
        ? publicCommand === "skills" ? "用法：/skills [status | <name> [run [args]] | run <name> [args]]" : "用法：/skill [name [args]]"
        : "用法：/browser [status]";
    const localValidation = code.startsWith(`${command}_`) || code === "tool_args_too_long" || code === "skill_args_too_long";
    const delivery = await sendAgentCommandMessage(env,chatId,publicCommand,
      localValidation ? usage : agentCommandError(error),{ requestId,outcome:"Failed",errorCode:code.slice(0,160) });
    await recordAgentCommandEvent(env, chatId, publicCommand, "error", {
      code: code.slice(0, 160), contract: command, receiptId: delivery.receiptId, deliveryStatus: delivery.deliveryStatus,
    });
  }
}

const mainMenu = [
  [{ text: "联网检索", callback_data: "cap:search" }, { text: "网页交互", callback_data: "cap:browser" }],
  [{ text: "图片", callback_data: "cap:image" }, { text: "语音回复", callback_data: "cap:voice" }]
];

function pendingCallback(action: string, pending: TgPendingAction): string {
  return `pac:${action}:${pending.actionId}:${pending.nonce}:${pending.revision}`;
}

async function selectNextTurnCapability(env: Env,chatId: string,capability: "search" | "browser" | "image" | "voice"): Promise<void> {
  const pending = await setPendingCommand(env.DB,chatId,`capability:${capability}`);
  if (!pending) throw new Error("pending_capability_create_failed");
  const labels = { search:"联网检索",browser:"网页交互",image:"图片生成或编辑",voice:"语音回复" } as const;
  await sendMessageWithKeyboard(env,chatId,
    `已选择${labels[capability]}。请在 10 分钟内发送下一条普通消息；它只会被消费一次。`,[[
      { text:"取消选择",callback_data:pendingCallback("cancel",pending) },
    ]]);
}

function voiceEnabled(env: Env): boolean {
  return env.VOICE_ENABLED?.trim().toLowerCase() === "true";
}

async function sendStatusOverview(env: Env, chatId: string): Promise<void> {
  const config = await getChatConfig(env.DB, chatId);
  await sendMessageChunks(env, chatId, `Bot 在线\n\n模型：${config.model}\n语音：${config.voicePolicy}${config.voiceOnce ? "+once" : ""} / ${config.voiceModel}\n记忆：Operia default namespace`);
}

async function showHeartbeatActivationRequest(env: Env,chatId: string,requestId: string): Promise<void> {
  if (!isAgentCommandOwner(env,chatId) || !/^hba_[a-f0-9]{24}$/.test(requestId)) {
    await sendMessageChunks(env,chatId,"这个 Heartbeat 授权请求无效或不属于当前 Owner。");
    return;
  }
  try {
    const projection = await getAgentHeartbeatProjection(env);
    const requests = Array.isArray(projection.activationRequests) ? projection.activationRequests : [];
    const pending = requests.find((value) => value && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string,unknown>).requestId === requestId) as Record<string,unknown> | undefined;
    if (!pending || typeof pending.expiresAt !== "string") {
      await sendMessageChunks(env,chatId,"这个 Heartbeat 授权请求已过期、已处理或已被更新版本替代。");
      return;
    }
    await sendMessageWithKeyboard(env,chatId,
      `Heartbeat 请求进入 Active。批准后会建立可撤销、最长 30 天的 standing grant；预算和时段以 Agent 当前配置为准。\n\n请求过期：${pending.expiresAt}`,[
        [{ text:"批准 Active",callback_data:`hba:a:${requestId}` },{ text:"保持 Observe",callback_data:`hba:r:${requestId}` }],
      ]);
  } catch (error) {
    await sendMessageChunks(env,chatId,agentCommandError(error));
  }
}

function countLines(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([key, count]) => `- ${key}：${Number(count) || 0}`);
}

async function sendAgentStatusSection(env: Env, chatId: string, section: "tasks" | "health"): Promise<void> {
  if (!isAgentCommandOwner(env, chatId)) {
    await sendMessageChunks(env, chatId, "Agent 任务与健康状态仅对配置的 Telegram Agent owner 开放。");
    return;
  }
  try {
    const snapshot = await getAgentRuntimeSnapshot(env);
    if (section === "tasks") {
      const lines = countLines(snapshot.tasks);
      await sendMessageChunks(env, chatId, ["Agent 前台任务", "", ...(lines.length ? lines : ["当前没有已记录任务。"]), "", "详情：https://agent.example.com/control"].join("\n"));
      return;
    }
    const summary = snapshot.summary && typeof snapshot.summary === "object" ? snapshot.summary as Record<string, unknown> : {};
    const providers = countLines(snapshot.providers);
    await sendMessageChunks(env, chatId, [
      "Agent 健康状态",
      "",
      `能力：${Number(summary.enabled) || 0} enabled / ${Number(summary.disabled) || 0} disabled`,
      ...(providers.length ? ["Providers", ...providers] : ["Providers：暂无状态"]),
      "",
      "Heartbeat / Hooks：https://agent.example.com/tools/hooks",
    ].join("\n"));
  } catch (error) {
    await sendMessageChunks(env, chatId, agentCommandError(error));
  }
}

async function handleStatusHub(env: Env, chatId: string, args: string): Promise<void> {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [subcommand = "", section = "", value = "", ...extra] = tokens;
  if (!subcommand) return sendStatusOverview(env, chatId);
  if (subcommand === "usage" && tokens.length === 1) return sendLatestUsage(env, chatId);
  if ((subcommand === "tasks" || subcommand === "health") && tokens.length === 1) return sendAgentStatusSection(env, chatId, subcommand);
  if (subcommand === "progress" && tokens.length === 2 && ["live", "compact", "off"].includes(section)) {
    await setTgSetting(env.DB, "telegram.presentation.task_progress_mode", section);
    await sendMessageChunks(env, chatId, `任务进度展示已设为 ${section}。执行审计与必要的审批、失败和最终结果通知不受影响。`);
    return;
  }
  if (subcommand === "blocks" && extra.length === 0) {
    const key = section === "usage"
      ? "telegram.presentation.expandable_usage"
      : section === "tools"
        ? "telegram.presentation.expandable_tool_trace"
        : "telegram.presentation.expandable_response_status";
    const mode = section === "usage" || section === "tools" ? value : section;
    if ((section === "usage" || section === "tools" ? tokens.length === 3 : tokens.length === 2) && ["on", "off"].includes(mode)) {
      await setTgSetting(env.DB, key, mode === "on");
      await sendMessageChunks(env, chatId, `回复状态块${section === "usage" ? " usage 区段" : section === "tools" ? " tools 区段" : ""}已${mode === "on" ? "开启" : "关闭"}。`);
      return;
    }
  }
  await sendMessageChunks(env, chatId, "用法：/status [tasks|usage|health|progress live|compact|off|blocks on|off|blocks usage on|off|blocks tools on|off]");
}

async function handleVoiceHub(env: Env, chatId: string, args: string): Promise<void> {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [subcommand = "status", value = "", ...extra] = tokens;
  if ((!args.trim() || subcommand === "status") && extra.length === 0 && !value) {
    const config = await getChatConfig(env.DB, chatId);
    await sendMessageWithKeyboard(env, chatId, `语音：${config.voiceOnce ? "once" : config.voicePolicy} / ${config.voiceModel}\nProvider：${voiceEnabled(env) ? "已启用" : "未配置"}`, [
      [
        { text: "下一次发语音", callback_data: "voice:once" },
        { text: "允许偶尔发声", callback_data: "voice:auto" },
        { text: "关闭主动语音", callback_data: "voice:off" },
      ],
      [
        { text: "低延迟", callback_data: "voice:model:realtime" },
        { text: "高质量", callback_data: "voice:model:quality" },
        { text: "高表现力", callback_data: "voice:model:expressive" },
      ],
      [{ text: "Voice Studio", url: "https://agent.example.com/tools/voice" }],
    ]);
    return;
  }
  const validMutation = (subcommand === "off" || subcommand === "once" || subcommand === "auto") && tokens.length === 1
    || subcommand === "model" && tokens.length === 2 && ["realtime", "quality", "expressive"].includes(value);
  if (!validMutation) {
    await sendMessageChunks(env, chatId, "用法：/voice [once|auto|off|model realtime|quality|expressive|status]");
    return;
  }
  if (subcommand === "off" && tokens.length === 1) {
    await setVoiceMode(env.DB, chatId, "off");
    await sendMessageChunks(env, chatId, "主动语音已关闭，语音输入仍可单独使用。");
    return;
  }
  if (!voiceEnabled(env)) {
    await sendMessageChunks(env, chatId, "语音服务尚未配置，当前不会改变语音设置。");
    return;
  }
  if (subcommand === "once" && tokens.length === 1) {
    await setVoiceMode(env.DB, chatId, "once");
    await sendMessageChunks(env, chatId, "下一次回复会在文字之后附带语音。");
    return;
  }
  if (subcommand === "auto" && tokens.length === 1) {
    await setVoiceMode(env.DB, chatId, "auto");
    await sendMessageChunks(env, chatId, "已允许助手在合适的时候偶尔附带语音。");
    return;
  }
  if (subcommand === "model" && tokens.length === 2 && ["realtime", "quality", "expressive"].includes(value)) {
    const voiceModel = value as "realtime" | "quality" | "expressive";
    await setVoiceMode(env.DB, chatId, "auto", voiceModel);
    const label = voiceModel === "realtime" ? "低延迟" : voiceModel === "quality" ? "稳定高质量" : "高表现力";
    await sendMessageChunks(env, chatId, `语音已切到${label}模式，并允许助手在合适时偶尔发声。`);
    return;
  }
}

async function setReasoningDisplay(env: Env, chatId: string, mode: string): Promise<void> {
  if (mode === "summary") {
    await setTgSetting(env.DB, "reasoning_mode", "summary");
    await sendMessageChunks(env, chatId, "Provider 可读 thinking 已开启。模型返回 reasoning_content 时，会以 💭 可展开块直接放在正文前；没有返回时不会生成或推断。");
    return;
  }
  if (mode === "off") {
    await setTgSetting(env.DB, "reasoning_mode", "off");
    await sendMessageChunks(env, chatId, "Reasoning 信息展示已关闭。");
    return;
  }
  if (mode === "debug") {
    await setTgSetting(env.DB, "reasoning_mode", "debug_trace");
    await sendMessageChunks(env, chatId, "Reasoning debug trace 已开启，只显示 Agent 主动公开且经过脱敏的事件，不包含或恢复隐藏思维链。");
    return;
  }
  await sendMessageChunks(env, chatId, "用法：/think show off|summary|debug");
}

async function setReasoningPresentation(env: Env, chatId: string, mode: string): Promise<void> {
  if (mode === "on") return setReasoningDisplay(env, chatId, "summary");
  if (mode === "off") return setReasoningDisplay(env, chatId, "off");
  if (mode === "once") {
    await setTgSetting(env.DB, `reasoning_once:${chatId}`, true);
    await sendMessageChunks(env, chatId, "下一次有 Provider 可读 thinking 时，会在正文前显示 💭 可展开块。");
    return;
  }
  await sendMessageChunks(env, chatId, "用法：/think on|off|once|status");
}

async function setReasoningExecution(env: Env, chatId: string, mode: string): Promise<void> {
  if (!["off", "low", "medium", "high", "max", "reset"].includes(mode)) {
    await sendMessageChunks(env, chatId, "用法：/think reasoning off|low|medium|high|max|reset");
    return;
  }
  try {
    if (mode === "reset") {
      await resetTgMemoryControl(env, chatId, "memory.inference.reasoning.enabled");
      const result = await resetTgMemoryControl(env, chatId, "memory.inference.reasoning.effort");
      await sendMessageChunks(env, chatId, `已恢复 Memory 继承值：${result.request.thinking ? "Adaptive Thinking 开启" : "Thinking 关闭"} / effort ${result.request.effort}。`);
      return;
    }
    if (mode === "off") {
      const result = await setTgMemoryControl(env, chatId, "memory.inference.reasoning.enabled", false);
      await sendMessageChunks(env, chatId, `Opus Adaptive Thinking 已关闭。Effort 仍为 ${result.request.effort}，继续控制回答和工具调用投入。`);
      return;
    }
    await setTgMemoryControl(env, chatId, "memory.inference.reasoning.effort", mode);
    const result = await setTgMemoryControl(env, chatId, "memory.inference.reasoning.enabled", true);
    await sendMessageChunks(env, chatId, `Opus Adaptive Thinking 已开启，effort = ${result.request.effort}。`);
  } catch (error) {
    console.error("tg reasoning mutation failed", { chatId, error: String(error).slice(0, 180) });
    await sendMessageChunks(env, chatId, "Memory reasoning owner 暂时无法保存设置，请查看控制台状态。");
  }
}

async function setTemperature(env: Env, chatId: string, raw: string): Promise<void> {
  try {
    if (!raw) {
      const snapshot = await getTgMemoryControls(env, chatId);
      const entry = snapshot.values.find((item) => item.key === "memory.inference.sampling.temperature");
      await sendMessageChunks(env, chatId, `当前 temperature = ${entry?.effectiveValue ?? "未知"}${snapshot.request.thinking ? "；因 Adaptive Thinking 开启，当前已保存但不发送给 Provider。" : "。"}`);
      return;
    }
    if (raw === "reset") {
      const result = await resetTgMemoryControl(env, chatId, "memory.inference.sampling.temperature");
      const entry = result.values.find((item) => item.key === "memory.inference.sampling.temperature");
      await sendMessageChunks(env, chatId, `Temperature 已恢复继承值 ${entry?.effectiveValue ?? "1"}。`);
      return;
    }
    const temperature = Number(raw);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
      await sendMessageChunks(env, chatId, "用法：/think temperature 0..1|reset");
      return;
    }
    const result = await setTgMemoryControl(env, chatId, "memory.inference.sampling.temperature", temperature);
    await sendMessageChunks(env, chatId, result.request.thinking
      ? `Temperature ${temperature} 已保存；当前因 Adaptive Thinking 暂不生效，关闭 Thinking 后自动恢复。`
      : `Temperature 已设为 ${temperature}。`);
  } catch (error) {
    console.error("tg temperature mutation failed", { chatId, error: String(error).slice(0, 180) });
    await sendMessageChunks(env, chatId, raw ? "Memory temperature owner 暂时无法保存设置。" : "暂时无法读取 temperature。");
  }
}

async function handleThinkHub(env: Env, chatId: string, args: string): Promise<void> {
  const [subcommand = "status", ...rest] = args.trim().toLowerCase().split(/\s+/);
  if (!args.trim() || subcommand === "status") {
    const display = await getTgSetting(env.DB, "reasoning_mode", "off");
    try {
      const snapshot = await getTgMemoryControls(env, chatId);
      await sendMessageChunks(env, chatId, `Reasoning 展示：${display}\n执行：${snapshot.request.thinking ? "on" : "off"} / effort ${snapshot.request.effort}\nTemperature：${snapshot.request.temperature ?? "Provider 当前不接收"}`);
    } catch {
      await sendMessageChunks(env, chatId, `Reasoning 展示：${display}\nMemory owner 执行状态暂不可用。`);
    }
    return;
  }
  if (subcommand === "on" || subcommand === "off" || subcommand === "once") return setReasoningPresentation(env, chatId, subcommand);
  if (subcommand === "show") return setReasoningDisplay(env, chatId, rest.join(" "));
  if (subcommand === "reasoning") return setReasoningExecution(env, chatId, rest.join(" "));
  if (subcommand === "temperature") return setTemperature(env, chatId, rest.join(" "));
  await sendMessageChunks(env, chatId, "用法：/think [on|off|once|status | show off|summary|debug | reasoning off|low|medium|high|max|reset | temperature 0..1|reset]");
}

type McpWizardState = {
  version: 1;
  providerId: string;
  toolName: string;
  fields: McpSimpleField[];
  fieldIndex: number;
  args: Record<string, unknown>;
  requestId: string;
  createdAt: string;
};

type McpNaturalSelection = {
  version: 1;
  providerId: string;
  toolName: string;
  inputSchema: Record<string, unknown>;
  createdAt: string;
};

const MCP_MENU_IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MCP_PENDING_MAX_AGE_MS = 15 * 60_000;

function safeMcpRequestId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
  return `mcp-${normalized || crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function parsePendingJson<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function isFreshPending(createdAt: unknown): boolean {
  return typeof createdAt === "string" && Number.isFinite(Date.parse(createdAt)) && Date.now() - Date.parse(createdAt) <= MCP_PENDING_MAX_AGE_MS;
}

async function putMcpMenu(
  env: Env,
  chatId: string,
  text: string,
  rows: Array<Array<{ text: string; callback_data?: string; url?: string }>>,
  messageId?: string,
): Promise<void> {
  if (messageId) {
    try {
      await editMessageWithKeyboard(env, chatId, messageId, text, rows);
      return;
    } catch (error) {
      console.warn("tg: MCP menu edit failed; sending a new menu", { error: String(error).slice(0, 160) });
    }
  }
  await sendMessageWithKeyboard(env, chatId, text, rows);
}

export async function showMcpRootMenu(env: Env, chatId: string, messageId?: string): Promise<void> {
  await setPendingCommand(env.DB, chatId, null);
  await putMcpMenu(env, chatId, "选择工具来源：", [
    [
      { text: "内置工具", callback_data: encodeMcpMenuCallback({ action: "root", section: "internal" }) },
      { text: "外置 MCP", callback_data: encodeMcpMenuCallback({ action: "root", section: "external" }) },
    ],
    [{ text: "MCP 控制台", url: "https://mcp.example.com/admin" }],
  ], messageId);
}

async function showMcpInternalMenu(env: Env, chatId: string, messageId?: string): Promise<void> {
  await putMcpMenu(env, chatId, "内置工具\n\n这些能力由 Operia 自身的 canonical owner 管理。", [
    [
      { text: "声音", callback_data: encodeMcpMenuCallback({ action: "internal", tool: "voice" }) },
      { text: "记忆", callback_data: encodeMcpMenuCallback({ action: "internal", tool: "memory" }) },
    ],
    [{ text: "返回工具来源", callback_data: encodeMcpMenuCallback({ action: "home" }) }],
  ], messageId);
}

async function loadExternalMcpProviders(env: Env, chatId: string): Promise<AgentTelegramCommandItem[]> {
  if (!isAgentCommandOwner(env, chatId)) throw new Error("telegram_owner_scope_mismatch");
  const ownerId = env.TG_AGENT_OWNER_ID?.trim() || chatId;
  const result = await invokeAgentTelegramCommand(env, "tool", { action: "catalog", ownerId, chatId });
  return result.items.filter((item) => item.source === "external" && item.id);
}

function itemLabel(item: AgentTelegramCommandItem): string {
  const state = item.status === "enabled" || item.executable ? "" : ` · ${item.status || "不可用"}`;
  return `${item.label}${state}`.slice(0, 54);
}

async function showMcpExternalMenu(env: Env, chatId: string, messageId?: string): Promise<void> {
  const providers = await loadExternalMcpProviders(env, chatId);
  const buttons = await Promise.all(providers.map(async (item) => ({
    text: itemLabel(item),
    callback_data: encodeMcpMenuCallback({ action: "provider", providerRef: await providerRef(item.id!) }),
  })));
  const rows = buttons.reduce<Array<Array<{ text: string; callback_data: string }>>>((acc, button, index) => {
    if (index % 2 === 0) acc.push([button]); else acc.at(-1)!.push(button);
    return acc;
  }, []);
  rows.push([{ text: "返回工具来源", callback_data: encodeMcpMenuCallback({ action: "home" }) }]);
  await putMcpMenu(env, chatId, providers.length
    ? `外置 MCP\n\n来自 mcp.example.com 的实时目录，共 ${providers.length} 个 Provider。灰色状态项仍可查看，但不会绕过 Agent 执行策略。`
    : "外置 MCP\n\nMCP owner 当前没有返回 Provider。请在控制台检查 Gateway 状态。", rows, messageId);
}

async function loadMcpProviderByRef(env: Env, chatId: string, ref: string): Promise<AgentTelegramCommandItem | null> {
  return findProviderByRef(await loadExternalMcpProviders(env, chatId), ref);
}

async function loadMcpTools(env: Env, chatId: string, providerId: string): Promise<AgentTelegramCommandResult> {
  const ownerId = env.TG_AGENT_OWNER_ID?.trim() || chatId;
  return invokeAgentTelegramCommand(env, "tool", { action: "provider", ownerId, chatId, serverId: providerId });
}

async function showMcpProviderMenu(
  env: Env,
  chatId: string,
  provider: AgentTelegramCommandItem,
  providerLocator: string,
  messageId?: string,
): Promise<void> {
  const result = await loadMcpTools(env, chatId, provider.id!);
  const buttons = await Promise.all(result.items.filter((item) => item.id).map(async (item) => ({
    text: `${item.executable ? "" : "只读目录 · "}${item.label}`.slice(0, 54),
    callback_data: encodeMcpMenuCallback({ action: "tool", providerRef: providerLocator, toolRef: await toolRef(provider.id!, item.id!) }),
  })));
  const rows = buttons.map((button) => [button]);
  rows.push([{ text: "返回 Provider", callback_data: encodeMcpMenuCallback({ action: "root", section: "external" }) }]);
  await putMcpMenu(env, chatId, `${result.title}\n\n${result.summary || provider.detail}\n\n点选工具后，系统会按 schema 决定一键执行、参数选项或交给 Opus。`, rows, messageId);
}

function wizardChoiceLabel(value: unknown): string {
  if (value === true) return "是";
  if (value === false) return "否";
  return String(value).slice(0, 48);
}

async function showMcpWizardField(env: Env, chatId: string, state: McpWizardState, messageId?: string): Promise<void> {
  const field = state.fields[state.fieldIndex];
  if (!field) {
    await setPendingCommand(env.DB, chatId, null);
    await runAgentControlCommand(env, chatId, "tool", "", "mcp", state.requestId, {
      action: "execute", serverId: state.providerId, toolName: state.toolName, args: state.args,
    });
    return;
  }
  const pending = await setPendingCommand(env.DB, chatId, "mcp:wizard", JSON.stringify(state));
  if (!pending) throw new Error("mcp_wizard_pending_failed");
  const rows = field.values.map((value, index) => [{
    text: wizardChoiceLabel(value),
    callback_data: encodeMcpMenuCallback({ action: "wizard", choice: index,
      actionId:pending.actionId,nonce:pending.nonce,revision:pending.revision }),
  }]);
  if (!field.required) rows.push([{ text: "跳过此项", callback_data: encodeMcpMenuCallback({ action: "wizard_skip",
    actionId:pending.actionId,nonce:pending.nonce,revision:pending.revision }) }]);
  rows.push([{ text: "取消", callback_data: pendingCallback("cancel",pending) }]);
  await putMcpMenu(env, chatId, `参数 ${state.fieldIndex + 1}/${state.fields.length}\n\n${field.name}${field.required ? "（必填）" : "（可选）"}\n\n请选择：`, rows, messageId);
}

async function startMcpToolSelection(
  env: Env,
  chatId: string,
  provider: AgentTelegramCommandItem,
  tool: AgentTelegramCommandItem,
  providerLocator: string,
  toolLocator: string,
  requestId: string,
  messageId?: string,
): Promise<void> {
  if (!tool.executable || !tool.inputSchema) {
    await putMcpMenu(env, chatId, `${provider.label} / ${tool.label}\n\n状态：${tool.status || "catalog-only"}\n${tool.detail || "此工具当前只存在于 MCP owner 目录，尚未进入 Agent 可执行投影。"}`, [
      [{ text: "MCP 控制台", url: `https://mcp.example.com/admin?provider_id=${encodeURIComponent(provider.id!)}` }],
      [{ text: "返回工具", callback_data: encodeMcpMenuCallback({ action: "provider", providerRef: providerLocator }) }],
    ], messageId);
    return;
  }
  const schema = tool.inputSchema;
  const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [];
  if (required.length === 0) {
    await setPendingCommand(env.DB, chatId, null);
    await runAgentControlCommand(env, chatId, "tool", "", "mcp", requestId, {
      action: "execute", serverId: provider.id!, toolName: tool.id!, args: {},
    });
    return;
  }
  const { fields, hasRequiredComplexField } = simpleSchemaFields(schema);
  if (!hasRequiredComplexField) {
    await showMcpWizardField(env, chatId, {
      version: 1,
      providerId: provider.id!,
      toolName: tool.id!,
      fields,
      fieldIndex: 0,
      args: {},
      requestId,
      createdAt: new Date().toISOString(),
    }, messageId);
    return;
  }
  await putMcpMenu(env, chatId, `${provider.label} / ${tool.label}\n\n${tool.detail}\n\n这个工具包含自然语言或复杂结构参数。你不需要填写字段名：选择“交给 Opus”后，下一条只需正常说想做什么。`, [
    [{ text: "交给 Opus 组装参数", callback_data: encodeMcpMenuCallback({ action: "opus", providerRef: providerLocator, toolRef: toolLocator }) }],
    [{ text: "返回工具", callback_data: encodeMcpMenuCallback({ action: "provider", providerRef: providerLocator }) }],
  ], messageId);
}

export async function handleMcpMenuCallback(
  env: Env,
  chatId: string,
  data: string,
  callbackQueryId: string,
  messageId?: string,
): Promise<boolean> {
  const callback = parseMcpMenuCallback(data);
  if (!callback) return false;
  if (!isAgentCommandOwner(env, chatId)) {
    await sendMessageChunks(env, chatId, "此菜单仅对配置的 Telegram Agent owner 开放。");
    return true;
  }
  if (callback.action === "home") {
    await showMcpRootMenu(env, chatId, messageId);
    return true;
  }
  if (callback.action === "root") {
    if (callback.section === "internal") await showMcpInternalMenu(env, chatId, messageId);
    else await showMcpExternalMenu(env, chatId, messageId);
    return true;
  }
  if (callback.action === "internal") {
    await handleCommand(env, chatId, { name: callback.tool, args: "" }, safeMcpRequestId(callbackQueryId));
    return true;
  }
  if (callback.action === "wizard" || callback.action === "wizard_skip") {
    const config = await getChatConfig(env.DB, chatId);
    const state = config.pendingCommand === "mcp:wizard" ? parsePendingJson<McpWizardState>(config.pendingPayload) : null;
    const field = state?.fields?.[state.fieldIndex];
    if (!state || state.version !== 1 || !isFreshPending(state.createdAt) || !field || !MCP_MENU_IDENTIFIER.test(state.providerId) || !MCP_MENU_IDENTIFIER.test(state.toolName)) {
      await setPendingCommand(env.DB, chatId, null);
      await sendMessageChunks(env, chatId, "这个参数菜单已经失效，请重新打开 /mcp。");
      return true;
    }
    const claimed = config.pendingActionId === callback.actionId && config.pendingNonce === callback.nonce
      && config.pendingRevision === callback.revision
      ? await consumePendingCommand(env.DB,chatId,{
          command:"mcp:wizard",actionId:callback.actionId,nonce:callback.nonce,
          revision:callback.revision,payload:config.pendingPayload,expiresAt:config.pendingExpiresAt ?? undefined,
        })
      : null;
    if (!claimed) {
      await sendMessageChunks(env,chatId,"这个参数选择已被消费或已经过期，请重新打开 /mcp。");
      return true;
    }
    if (callback.action === "wizard_skip") {
      if (field.required) {
        await sendMessageChunks(env, chatId, "必填参数不能跳过。");
        return true;
      }
    } else {
      if (!Number.isInteger(callback.choice) || callback.choice < 0 || callback.choice >= field.values.length) {
        await sendMessageChunks(env, chatId, "这个参数选项已经失效，请重新选择工具。");
        return true;
      }
      state.args[field.name] = field.values[callback.choice];
    }
    state.fieldIndex += 1;
    await showMcpWizardField(env, chatId, state, messageId);
    return true;
  }
  const provider = await loadMcpProviderByRef(env, chatId, callback.providerRef);
  if (!provider) {
    await sendMessageChunks(env, chatId, "MCP 目录已经变化，这个按钮已失效。请重新打开 /mcp。");
    return true;
  }
  if (callback.action === "provider") {
    await showMcpProviderMenu(env, chatId, provider, callback.providerRef, messageId);
    return true;
  }
  const tools = await loadMcpTools(env, chatId, provider.id!);
  const tool = await findToolByRef(provider.id!, tools.items, callback.toolRef);
  if (!tool) {
    await sendMessageChunks(env, chatId, "MCP 工具目录已经变化，这个按钮已失效。请重新选择 Provider。");
    return true;
  }
  if (callback.action === "opus") {
    if (!tool.executable || !tool.inputSchema) {
      await sendMessageChunks(env, chatId, "这个工具当前不可执行，已保留为只读目录项。");
      return true;
    }
    const selection: McpNaturalSelection = {
      version: 1,
      providerId: provider.id!,
      toolName: tool.id!,
      inputSchema: tool.inputSchema,
      createdAt: new Date().toISOString(),
    };
    const pending = await setPendingCommand(env.DB, chatId, "mcp:natural", JSON.stringify(selection));
    if (!pending) throw new Error("mcp_natural_pending_failed");
    await putMcpMenu(env, chatId, `已选择 ${provider.label} / ${tool.label}。\n\n下一条直接用自然语言说这次想做什么；Opus 会按工具 schema 填写参数，不需要字段名或 key=value。`, [
      [{ text: "取消选择", callback_data: pendingCallback("cancel",pending) }],
    ], messageId);
    return true;
  }
  await startMcpToolSelection(env, chatId, provider, tool, callback.providerRef, callback.toolRef, safeMcpRequestId(callbackQueryId), messageId);
  return true;
}

export async function applyPendingMcpNaturalSelection(env: Env, chatId: string, text: string): Promise<string> {
  const config = await getChatConfig(env.DB, chatId);
  if (config.pendingCommand !== "mcp:natural") return text;
  const selection = parsePendingJson<McpNaturalSelection>(config.pendingPayload);
  const claimed = config.pendingActionId && config.pendingNonce
    ? await consumePendingCommand(env.DB,chatId,{
        command:"mcp:natural",actionId:config.pendingActionId,nonce:config.pendingNonce,
        revision:config.pendingRevision,payload:config.pendingPayload,expiresAt:config.pendingExpiresAt ?? undefined,
      })
    : null;
  if (!claimed) return text;
  if (!selection || selection.version !== 1 || !isFreshPending(selection.createdAt)
    || !MCP_MENU_IDENTIFIER.test(selection.providerId) || !MCP_MENU_IDENTIFIER.test(selection.toolName)) return text;
  const schema = JSON.stringify(selection.inputSchema).slice(0, 8 * 1024);
  return `${text}\n\n[Telegram 工具菜单选择：用户已明确选择外置 MCP ${selection.providerId}/${selection.toolName}。请根据上面的自然语言意图和当前对话，按以下 JSON Schema 组装参数并通过 Agent 的统一 MCP 工具链调用；不要要求用户填写字段名或 key=value。若语义仍不足，只询问必要的自然语言信息。Schema: ${schema}]`;
}

export async function applyPendingCapabilitySelection(env: Env,chatId: string,text: string): Promise<string> {
  const config = await getChatConfig(env.DB,chatId);
  const match = /^capability:(search|browser|image|voice)$/.exec(config.pendingCommand || "");
  if (!match || !config.pendingActionId || !config.pendingNonce) return text;
  const claimed = await consumePendingCommand(env.DB,chatId,{
    command:config.pendingCommand!,actionId:config.pendingActionId,nonce:config.pendingNonce,
    revision:config.pendingRevision,payload:config.pendingPayload,expiresAt:config.pendingExpiresAt ?? undefined,
  });
  if (!claimed) return text;
  const capability = match[1];
  const instruction = capability === "search"
    ? "使用 canonical 搜索能力核验最新资料，并给出来源。"
    : capability === "browser"
      ? "这是明确的网页交互请求；只有需要渲染、导航、点击或表单时才使用 Browser，能力不可用时如实说明。"
      : capability === "image"
        ? "使用 canonical 图片生成或编辑能力；不要把普通网页图片搜索冒充生成结果。"
        : "用户明确要求本轮在文字结果之外使用已配置的语音回复能力；服务不可用时只返回真实状态。";
  return `${text}\n\n[Telegram next-turn capability: ${capability}. ${instruction}]`;
}

async function handleMcpHub(env: Env, chatId: string, args: string, requestId?: string): Promise<void> {
  try {
    const parsed = parseMcpHubArgs(args);
    if (parsed.action === "catalog") {
      await showMcpRootMenu(env, chatId);
      return;
    }
    if (parsed.action === "legacy_execute") {
      await runAgentControlCommand(env, chatId, "tool", parsed.toolArgs, "mcp", requestId);
      return;
    }
    const input = parsed.action === "provider"
        ? { action: "provider" as const, serverId: parsed.provider }
        : { action: "execute" as const, serverId: parsed.provider, toolName: parsed.tool, args: parsed.args };
    await runAgentControlCommand(env, chatId, "tool", args, "mcp", requestId, input);
  } catch {
    await sendMessageChunks(env, chatId, "用法：/mcp [status | <provider> [status | <tool> key=value ...]]");
  }
}

async function handleSkillHub(env: Env, chatId: string, args: string, requestId?: string): Promise<void> {
  try {
    const parsed = parseSkillHubArgs(args);
    const input = parsed.action === "catalog"
      ? { action: "catalog" as const }
      : parsed.action === "detail"
        ? { action: "detail" as const, name: parsed.name }
        : { action: "execute" as const, name: parsed.name, args: parsed.args };
    await runAgentControlCommand(env, chatId, "skill", args, "skills", requestId, input);
  } catch {
    await sendMessageChunks(env, chatId, "用法：/skills [status | <name> [run [args]] | run <name> [args]]");
  }
}

export interface ActiveTaskCancellationResult {
  status: "not_connected" | "requested";
  taskId?: string;
}

export async function requestActiveTaskCancellation(env: Env, chatId: string): Promise<ActiveTaskCancellationResult> {
  const result = await controlLatestTaskForChat(env, chatId, "stop");
  return result.status === "controlled" ? { status: "requested", taskId: result.taskId } : { status: "not_connected" };
}

async function handleCancel(env: Env, chatId: string): Promise<void> {
  await setPendingCommand(env.DB, chatId, null);
  const active = await requestActiveTaskCancellation(env, chatId);
  await sendMessageChunks(env, chatId, active.status === "requested"
    ? "已清除待处理命令，并向当前任务树提交停止请求。已经发出的外部动作不会被描述为已撤销；最终结果请以任务 Receipt 为准。"
    : "已清除待处理命令。当前没有可停止的前台任务树。");
}

export async function handleCommand(env: Env, chatId: string, command: ParsedCommand, requestId?: string): Promise<void> {
  const requestedName = command.name;
  const resolved = resolveAcceptedCommand(command);
  if (!resolved) {
    await sendMessageChunks(env, chatId, "未知命令。使用 /start 查看可用入口。");
    await recordTgEvent(env.DB, { chatId, eventType: "command", status: "unknown", metadata: { name: requestedName } });
    return;
  }
  command = resolved;
  switch (command.name) {
    case "use":
      if (command.args) {
        const capability = command.args.toLowerCase();
        if (["search","browser","image","voice"].includes(capability)) {
          await selectNextTurnCapability(env,chatId,capability as "search" | "browser" | "image" | "voice");
          return;
        }
        await sendMessageChunks(env,chatId,"用法：/use [search|browser|image|voice]");
        return;
      }
      await sendMessageWithKeyboard(env,chatId,"选择下一条普通消息使用的能力。选择将在 10 分钟后失效。",mainMenu);
      return;
    case "search":
    case "image":
      if (command.args) {
        await sendMessageChunks(env,chatId,`请先单独发送 /${command.name}，再发送具体请求。`);
        return;
      }
      await selectNextTurnCapability(env,chatId,command.name);
      return;
    case "start":
      if (/^hb_hba_[a-f0-9]{24}$/.test(command.args)) {
        await showHeartbeatActivationRequest(env,chatId,command.args.slice(3));
        return;
      }
      await sendMessageWithKeyboard(env, chatId, "Operia 私人助手已连接。", mainMenu);
      return;
    case "new":
      {
      const pending = await setPendingCommand(env.DB, chatId, "new");
      if (!pending) throw new Error("pending_new_create_failed");
      await sendMessageWithKeyboard(env, chatId, "确认清空 Telegram 短期会话？长期记忆不会删除。", [[
        { text: "确认", callback_data: pendingCallback("new",pending) },
        { text: "取消", callback_data: pendingCallback("cancel",pending) }
      ]]);
      return;
      }
    case "status":
      await handleStatusHub(env, chatId, command.args);
      return;
    case "model":
      await sendMessageWithKeyboard(env, chatId, "选择 Telegram 默认模型：", [
        TG_MODELS.map((model) => ({ text: model, callback_data: `model:${model}` }))
      ]);
      return;
    case "memory":
      await sendMessageWithKeyboard(env, chatId, "长期记忆由 Operia 统一管理。", [[
        { text: "打开 Operia Admin", url: "https://memory.example.com/admin" }
      ]]);
      return;
    case "remember":
      if (!command.args) {
        await sendMessageChunks(env, chatId, "用法：/remember 要长期记住的内容");
        return;
      }
      {
      const pending = await setPendingCommand(env.DB, chatId, "remember", command.args);
      if (!pending) throw new Error("pending_remember_create_failed");
      await sendMessageWithKeyboard(env, chatId, `确认写入长期记忆？\n\n${command.args}`, [[
        { text: "确认写入", callback_data: pendingCallback("remember",pending) },
        { text: "取消", callback_data: pendingCallback("cancel",pending) }
      ]]);
      return;
      }
    case "persona":
      await sendMessageWithKeyboard(env, chatId, "Telegram 直接使用 Operia 稳定助手人格。", [[
        { text: "编辑稳定人格", url: "https://memory.example.com/admin" }
      ]]);
      return;
    case "voice":
      if (!command.args) {
        await selectNextTurnCapability(env,chatId,"voice");
        return;
      }
      await handleVoiceHub(env, chatId, command.args);
      return;
    case "think":
      await handleThinkHub(env, chatId, command.args);
      return;
    case "mcp":
      await handleMcpHub(env, chatId, command.args, requestId);
      return;
    case "skills":
      await handleSkillHub(env, chatId, command.args, requestId);
      return;
    case "pause": {
      if (command.args) {
        await sendMessageChunks(env, chatId, "用法：/pause");
        return;
      }
      const result = await controlLatestTaskForChat(env,chatId,"pause");
      await sendMessageChunks(env,chatId,result.status === "controlled"
        ? result.message || "当前任务树的暂停请求已提交。"
        : "当前没有可暂停的前台任务树。全局紧急闸门请从 Security 控制面操作。");
      return;
    }
    case "resume": {
      if (command.args) {
        await sendMessageChunks(env, chatId, "用法：/resume");
        return;
      }
      const result = await controlLatestTaskForChat(env,chatId,"resume");
      await sendMessageChunks(env,chatId,result.status === "controlled"
        ? result.message || "当前暂停任务树的恢复请求已提交。"
        : "当前没有可恢复的前台任务树。");
      return;
    }
    case "skill":
      await runAgentControlCommand(env, chatId, "skill", command.args, "skill", requestId);
      return;
    case "browser":
      if (["pause", "resume", "step", "read_only", "readonly", "stop"].includes(command.args)) {
        const action = command.args === "readonly" ? "read_only" : command.args as "pause" | "resume" | "step" | "read_only" | "stop";
        const result = await controlLatestTaskForChat(env, chatId, action);
        await sendMessageChunks(env, chatId, result.status === "controlled" ? result.message || "任务控制已提交。" : "当前没有可控制的浏览器任务。");
        return;
      }
      if (command.args) {
        await sendMessageChunks(env,chatId,"请先单独发送 /browser，再发送需要网页交互的具体请求。");
        return;
      }
      await selectNextTurnCapability(env,chatId,"browser");
      return;
    case "cancel":
      await handleCancel(env, chatId);
      return;
    default:
      await sendMessageChunks(env, chatId, "这个兼容命令暂时不可用。");
  }
}
