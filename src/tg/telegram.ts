import type { Env } from "../types";
import { TELEGRAM_REACTION_EMOJI_VALUES } from "../tools/telegramInteractionContract";

const TG_API_BASE = "https://api.telegram.org";
// Telegram sendMessage hard limit is 4096 UTF-16 code units per message.
const TG_MAX_MESSAGE_CHARS = 4096;
const TG_SEND_MAX_RETRIES = 2;
const TG_MAX_REACTIONS_PER_TURN = 8;
const TG_WEBHOOK_URL = "https://tgbot.example.com/tg/webhook";
const TG_ALLOWED_UPDATES = ["message", "callback_query", "message_reaction"] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function requireBotToken(env: Env): string {
  const token = env.TG_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("TG bot requires TG_BOT_TOKEN secret (wrangler secret put TG_BOT_TOKEN)");
  }
  return token;
}

export async function tgApi(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const token = requireBotToken(env);
  return fetch(`${TG_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}

export async function sendTelegramIntent(
  env: Env,
  chatId: string,
  payload: Record<string, unknown>,
  options: { signal?: AbortSignal; onTelegramRequestStart?:() => Promise<void> } = {},
): Promise<{ accepted: boolean; messageId?: string; error?: string }> {
  const method = typeof payload.method === "string" ? payload.method : "sendMessage";
  const cleanPayload = { ...payload };
  delete cleanPayload.method;
  delete cleanPayload.kind;
  delete cleanPayload.canonicalText;
  delete cleanPayload.fallback;
  delete cleanPayload.mediaType;
  delete cleanPayload.fileName;
  validateTelegramReplyMarkup(cleanPayload.reply_markup);
  const mediaRef = typeof cleanPayload.media_ref === "string" ? cleanPayload.media_ref : "";
  delete cleanPayload.media_ref;
  let response: Response;
  const mediaId = mediaRef.startsWith("agent-media:") ? mediaRef.slice("agent-media:".length) : "";
  if (["sendPhoto", "sendVoice", "sendAudio"].includes(method) && mediaId) {
    response = await sendAgentMediaIntent(
      env,method,chatId,mediaId,cleanPayload,options.signal,options.onTelegramRequestStart,
    );
  } else if (["sendMessage", "editMessageText", "sendPhoto", "sendVoice", "sendAudio", "sendLocation", "setMessageReaction"].includes(method)) {
    await options.onTelegramRequestStart?.();
    response = await tgApi(env, method, { chat_id: chatId, ...cleanPayload }, options.signal);
  } else {
    return { accepted: false, error: "telegram_intent_method_not_allowed" };
  }
  const text = await response.text();
  if (!response.ok) {
    // editMessageText is an idempotent recovery surface. If Telegram applied
    // the edit but its first HTTP response was lost, the exact retry returns
    // this 400 and is proof that the requested visible state already exists.
    if (method === "editMessageText" && response.status === 400 && /message is not modified/i.test(text)) {
      return { accepted: true };
    }
    return { accepted: false, error: `telegram_http_${response.status}` };
  }
  if (mediaId) {
    // Telegram acceptance is the authoritative delivery result. Cleanup must
    // never hold that result open; the Agent R2 lifecycle remains the durable
    // fallback if this best-effort request is cancelled with the invocation.
    void deleteAgentMedia(env, mediaId);
  }
  try {
    const parsed = JSON.parse(text) as { result?: { message_id?: number | string } };
    return { accepted: true, messageId: parsed.result?.message_id != null ? String(parsed.result.message_id) : undefined };
  } catch {
    return { accepted: true };
  }
}

async function sendAgentMediaIntent(
  env: Env,
  method: string,
  chatId: string,
  mediaId: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  onTelegramRequestStart?:() => Promise<void>,
): Promise<Response> {
  if (!env.AGENT_SERVICE || !env.AGENT_CONTEXT_SERVICE_BEARER?.trim()) return new Response("agent media unavailable", { status: 503 });
  let form: FormData;
  try {
    const media = await env.AGENT_SERVICE.fetch(`https://<AGENT_SERVICE>.internal/service/media/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${env.AGENT_CONTEXT_SERVICE_BEARER.trim()}` },
      signal,
    });
    if (!media.ok) return new Response("agent media unavailable", { status: 502 });
    const bytes = await media.arrayBuffer();
    form = new FormData();
    form.set("chat_id", chatId);
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null) continue;
      form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    const field = method === "sendPhoto" ? "photo" : method === "sendVoice" ? "voice" : "audio";
    const fallbackType = method === "sendPhoto" ? "image/jpeg" : "audio/ogg";
    const fileName = method === "sendPhoto" ? "generated-image" : method === "sendVoice" ? "reply.ogg" : "reply-audio";
    form.set(field, new Blob([bytes], { type: media.headers.get("content-type") || fallbackType }), fileName);
  } catch {
    // Telegram has not been contacted yet, so this outcome is safely retryable.
    return new Response("agent media unavailable", { status: 503 });
  }
  const token = requireBotToken(env);
  await onTelegramRequestStart?.();
  return fetch(`${TG_API_BASE}/bot${token}/${method}`, { method: "POST", body: form, signal });
}

function validateTelegramReplyMarkup(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("telegram_reply_markup_invalid");
  const keyboard = (value as Record<string,unknown>).inline_keyboard;
  if (!Array.isArray(keyboard) || keyboard.length > 8) throw new Error("telegram_reply_markup_invalid");
  for (const row of keyboard) {
    if (!Array.isArray(row) || row.length < 1 || row.length > 8) throw new Error("telegram_reply_markup_invalid");
    for (const raw of row) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("telegram_reply_markup_invalid");
      const button = raw as Record<string,unknown>;
      if (typeof button.text !== "string" || !button.text.trim() || button.text.length > 64) throw new Error("telegram_reply_markup_invalid");
      const modes = [button.url,button.callback_data,button.web_app].filter((item) => item !== undefined).length;
      if (modes !== 1) throw new Error("telegram_reply_markup_invalid");
      if (button.web_app !== undefined) {
        if (!button.web_app || typeof button.web_app !== "object" || Array.isArray(button.web_app)) throw new Error("telegram_web_app_button_invalid");
        const urlValue = (button.web_app as Record<string,unknown>).url;
        if (typeof urlValue !== "string") throw new Error("telegram_web_app_button_invalid");
        const url = new URL(urlValue);
        if (url.protocol !== "https:" || url.hostname !== "tgbot.example.com" || url.pathname !== "/app" || url.username || url.password || url.hash || url.port || !["calendar","health_7d","health_30d"].includes(url.searchParams.get("tgWebAppStartParam") ?? "") || [...url.searchParams.keys()].some((key) => key !== "tgWebAppStartParam")) throw new Error("telegram_web_app_button_invalid");
      }
    }
  }
}

async function deleteAgentMedia(env: Env, mediaId: string): Promise<void> {
  if (!env.AGENT_SERVICE || !env.AGENT_CONTEXT_SERVICE_BEARER?.trim()) return;
  try {
    await env.AGENT_SERVICE.fetch(`https://<AGENT_SERVICE>.internal/service/media/${encodeURIComponent(mediaId)}`, {
      method: "DELETE", headers: { authorization: `Bearer ${env.AGENT_CONTEXT_SERVICE_BEARER.trim()}` },
    });
  } catch {
    // The R2 lifecycle rule remains the cleanup fallback.
  }
}

export async function sendMessageWithKeyboard(
  env: Env,
  chatId: string,
  text: string,
  rows: Array<Array<{ text: string; callback_data?: string; url?: string }>>
): Promise<void> {
  const response = await tgApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: rows }
  });
  if (!response.ok) throw new Error(`tg sendMessage keyboard failed (${response.status})`);
}

export async function editMessageWithKeyboard(
  env: Env,
  chatId: string,
  messageId: string,
  text: string,
  rows: Array<Array<{ text: string; callback_data?: string; url?: string }>>
): Promise<void> {
  const response = await tgApi(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: rows }
  });
  if (response.ok) return;
  const body = await response.text();
  if (response.status === 400 && body.includes("message is not modified")) return;
  throw new Error(`tg editMessageText keyboard failed (${response.status}): ${body.slice(0, 160)}`);
}

export async function answerCallbackQuery(env: Env, callbackQueryId: string, text?: string): Promise<void> {
  const response = await tgApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false
  });
  if (!response.ok) console.warn("tg: answerCallbackQuery failed", { status: response.status });
}

type BotCommandScope =
  | { type: "default" }
  | { type: "all_private_chats" }
  | { type: "chat"; chat_id: string };

interface BotCommandSyncTarget {
  scope: BotCommandScope;
  languageCode: "" | "zh" | "en";
  label: string;
}

const COMMAND_SYNC_LANGUAGES = ["", "zh", "en"] as const;
const EXPECTED_MENU_COMMAND_COUNT = 8;

export interface BotCommandSyncResult {
  verifiedCount: number;
  verifiedTargets: Array<{ label: string; count: number }>;
  bot: { id: string; username: string };
  webhook: { pendingUpdateCount: number; lastErrorDate: number | null; allowedUpdates: string[] };
  menuButton: "commands" | "web_app";
}

type OwnerMenuButton =
  | { type: "commands" }
  | { type: "web_app"; text: string; web_app: { url: string } };

export function ownerMenuButton(env: Env): OwnerMenuButton {
  if (env.TG_MINIAPP_ENABLED?.trim().toLowerCase() !== "true") return { type: "commands" };
  const configuredUrl = env.TG_MINIAPP_URL?.trim();
  let url: URL;
  try {
    url = new URL(configuredUrl || "");
  } catch {
    throw new Error("miniapp_menu_url_invalid");
  }
  if (
    url.protocol !== "https:" || url.hostname !== "tgbot.example.com" ||
    url.port || url.pathname !== "/app" || url.search || url.hash || url.username || url.password
  ) throw new Error("miniapp_menu_url_invalid");
  return { type: "web_app", text: "打开 Operia", web_app: { url: url.toString() } };
}

export function buildBotCommandSyncTargets(chatId: string): BotCommandSyncTarget[] {
  const normalizedChatId = chatId.trim();
  if (!normalizedChatId) throw new Error("command_menu_chat_id_required");
  const scopes: Array<{ scope: BotCommandScope; label: string }> = [
    { scope: { type: "default" }, label: "default" },
    { scope: { type: "all_private_chats" }, label: "all_private_chats" },
    { scope: { type: "chat", chat_id: normalizedChatId }, label: "owner_chat" },
  ];
  return scopes.flatMap(({ scope, label }) => COMMAND_SYNC_LANGUAGES.map((languageCode) => ({
    scope,
    languageCode,
    label: `${label}:${languageCode || "fallback"}`,
  })));
}

export function validateBotCommandMenu(commands: Array<{ command: string; description: string }>): void {
  if (commands.length !== EXPECTED_MENU_COMMAND_COUNT) throw new Error("command_menu_definition_count_invalid");
  const names = new Set<string>();
  for (const { command, description } of commands) {
    if (!/^[a-z0-9_]{1,32}$/.test(command) || names.has(command)) throw new Error("command_menu_definition_command_invalid");
    if (!description.trim() || description.length > 256) throw new Error("command_menu_definition_description_invalid");
    names.add(command);
  }
}

function commandsMatch(
  actual: Array<{ command?: string; description?: string }>,
  expected: Array<{ command: string; description: string }>
): boolean {
  return actual.length === expected.length && expected.every((command, index) => (
    actual[index]?.command === command.command && actual[index]?.description === command.description
  ));
}

export async function syncBotCommands(
  env: Env,
  commands: Array<{ command: string; description: string }>,
  chatId: string
): Promise<BotCommandSyncResult> {
  validateBotCommandMenu(commands);
  const expectedMenuButton = ownerMenuButton(env);
  const targets = buildBotCommandSyncTargets(chatId);
  if (targets.length !== 9 || new Set(targets.map((target) => target.label)).size !== 9) {
    throw new Error("command_menu_projection_definition_invalid");
  }
  const identityResponse = await tgApi(env, "getMe", {});
  if (!identityResponse.ok) throw new Error(`tg getMe failed (${identityResponse.status})`);
  const identityPayload = await identityResponse.json() as { result?: { id?: number | string; username?: string } };
  const botId = identityPayload.result?.id;
  const username = identityPayload.result?.username?.trim();
  if (botId == null || !username) throw new Error("command_menu_bot_identity_invalid");

  const webhookSecret = env.TG_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) throw new Error("telegram_webhook_secret_missing");
  const setWebhookResponse = await tgApi(env, "setWebhook", {
    url: TG_WEBHOOK_URL,
    secret_token: webhookSecret,
    allowed_updates: TG_ALLOWED_UPDATES,
  });
  if (!setWebhookResponse.ok) throw new Error(`tg setWebhook failed (${setWebhookResponse.status})`);

  const webhookResponse = await tgApi(env, "getWebhookInfo", {});
  if (!webhookResponse.ok) throw new Error(`tg getWebhookInfo failed (${webhookResponse.status})`);
  const webhookPayload = await webhookResponse.json() as {
    result?: { url?: string; pending_update_count?: number; last_error_date?: number; allowed_updates?: string[] };
  };
  let webhookUrl: URL;
  try {
    webhookUrl = new URL(webhookPayload.result?.url || "");
  } catch {
    throw new Error("command_menu_webhook_invalid");
  }
  if (webhookUrl.protocol !== "https:" || webhookUrl.hostname !== "tgbot.example.com" || webhookUrl.pathname !== "/tg/webhook") {
    throw new Error("command_menu_webhook_mismatch");
  }
  const allowedUpdates = Array.isArray(webhookPayload.result?.allowed_updates) ? webhookPayload.result.allowed_updates : [];
  if (!TG_ALLOWED_UPDATES.every((update) => allowedUpdates.includes(update))) {
    throw new Error("telegram_webhook_allowed_updates_mismatch");
  }

  const verifiedTargets: Array<{ label: string; count: number }> = [];
  for (const target of targets) {
    const request = { commands, scope: target.scope, language_code: target.languageCode };
    const response = await tgApi(env, "setMyCommands", request);
    if (!response.ok) throw new Error(`tg setMyCommands failed (${response.status}:${target.label})`);
    const verification = await tgApi(env, "getMyCommands", { scope: target.scope, language_code: target.languageCode });
    if (!verification.ok) throw new Error(`tg getMyCommands failed (${verification.status}:${target.label})`);
    const payload = await verification.json() as { result?: Array<{ command?: string; description?: string }> };
    const actual = Array.isArray(payload.result) ? payload.result : [];
    if (!commandsMatch(actual, commands)) throw new Error(`command_menu_verification_failed:${target.label}`);
    verifiedTargets.push({ label: target.label, count: actual.length });
  }

  const menuResponse = await tgApi(env, "setChatMenuButton", {
    chat_id: chatId,
    menu_button: expectedMenuButton,
  });
  if (!menuResponse.ok) throw new Error(`tg setChatMenuButton failed (${menuResponse.status})`);
  const menuVerification = await tgApi(env, "getChatMenuButton", { chat_id: chatId });
  if (!menuVerification.ok) throw new Error(`tg getChatMenuButton failed (${menuVerification.status})`);
  const menuPayload = await menuVerification.json() as {
    result?: { type?: string; text?: string; web_app?: { url?: string } };
  };
  const actualMenuButton = menuPayload.result;
  const menuMatches = expectedMenuButton.type === "commands"
    ? actualMenuButton?.type === "commands"
    : actualMenuButton?.type === "web_app" && actualMenuButton.text === expectedMenuButton.text &&
      actualMenuButton.web_app?.url === expectedMenuButton.web_app.url;
  if (!menuMatches) throw new Error("command_menu_button_verification_failed");

  return {
    verifiedCount: commands.length,
    verifiedTargets,
    bot: { id: String(botId), username },
    webhook: {
      pendingUpdateCount: Math.max(0, Number(webhookPayload.result?.pending_update_count) || 0),
      lastErrorDate: Number.isFinite(webhookPayload.result?.last_error_date) ? Number(webhookPayload.result?.last_error_date) : null,
      allowedUpdates,
    },
    menuButton: expectedMenuButton.type,
  };
}

/**
 * Split reply text into bubbles: a blank line (two or more newlines) is an
 * explicit bubble boundary the model is instructed to emit. Any single bubble
 * still over the Telegram limit gets hard-split at the last newline/space
 * before the limit.
 */
export function splitIntoBubbles(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const sections: string[] = [];
  let cursor = 0;
  for (const match of normalized.matchAll(/```[^\n]*\n?([\s\S]*?)```/g)) {
    const index = match.index ?? 0;
    if (index > cursor) sections.push(normalized.slice(cursor, index));
    if (match[1]?.trim()) sections.push(match[1].trim());
    cursor = index + match[0].length;
  }
  if (cursor < normalized.length) sections.push(normalized.slice(cursor));
  if (sections.length === 0) sections.push(normalized);

  const bubbles = sections.flatMap((section) => section
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0));

  const chunks: string[] = [];
  for (const bubble of bubbles) {
    let rest = bubble;
    while (rest.length > TG_MAX_MESSAGE_CHARS) {
      const window = rest.slice(0, TG_MAX_MESSAGE_CHARS);
      const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
      const at = cut > 0 ? cut : TG_MAX_MESSAGE_CHARS;
      chunks.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest.length > 0) chunks.push(rest);
  }
  return chunks;
}

/**
 * Peel only paragraphs that the model has terminated with a blank line.
 * Blank lines inside an open fenced-code block are not delivery boundaries.
 *
 * The completed prefix is passed through splitIntoBubbles so incremental and
 * canonical-final delivery use exactly the same Telegram size/code handling.
 */
export function takeCompletedTelegramBubbles(text: string): { bubbles: string[]; remainder: string } {
  const normalized = text.replace(/\r\n?/g, "\n");
  let fenced = false;
  let completedAt = 0;
  let lineStart = 0;
  while (lineStart < normalized.length) {
    const newline = normalized.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? normalized.length : newline;
    const line = normalized.slice(lineStart, lineEnd);
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && line.trim().length === 0 && newline !== -1) {
      completedAt = newline + 1;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (completedAt === 0) return { bubbles: [], remainder: normalized };
  return {
    bubbles: splitIntoBubbles(normalized.slice(0, completedAt)),
    remainder: normalized.slice(completedAt),
  };
}

const ALLOWED_REACTION_EMOJI = new Set<string>(TELEGRAM_REACTION_EMOJI_VALUES);

export function validateReactionIntent(
  args: Record<string, unknown>,
  allowedMessageIds: readonly number[],
): { messageId: number; emoji: string } {
  const messageId = args.message_id;
  const emoji = args.emoji === "❤️" ? "❤" : args.emoji;
  if (!Number.isInteger(messageId) || !allowedMessageIds.includes(messageId as number)) {
    throw new Error("tg_reaction_message_not_in_current_batch");
  }
  if (typeof emoji !== "string" || !ALLOWED_REACTION_EMOJI.has(emoji)) {
    throw new Error("tg_reaction_emoji_not_allowed");
  }
  return { messageId: messageId as number, emoji };
}

export function validateReplyTarget(args: Record<string, unknown>, allowedMessageIds: readonly number[]): number {
  const messageId = args.message_id;
  if (!Number.isInteger(messageId) || !allowedMessageIds.includes(messageId as number)) {
    throw new Error("tg_reply_message_not_in_current_batch");
  }
  return messageId as number;
}

export function telegramActionBatchError(
  calls: ReadonlyArray<{ function: { name: string; arguments: string } }>,
  allowedMessageIds: readonly number[],
  alreadyReactedMessageIds: ReadonlySet<number> = new Set<number>(),
): string | null {
  const isInteraction = (name: string) => name === "react_to_message" || name === "reply_to_message";
  const contextCalls = calls.filter((call) => call.function.name === "request_context");
  const actions = calls.filter((call) => call.function.name !== "request_context");
  const interactions = actions.filter((call) => isInteraction(call.function.name));
  const expensiveActions = actions.filter((call) => !isInteraction(call.function.name));
  if (interactions.length === 0) return actions.length > 1 ? "one_action_per_round_required" : null;
  if (contextCalls.length > 0 || expensiveActions.length > 0) return "telegram_interactions_cannot_mix_with_context_or_expensive_action";
  const replyCalls = interactions.filter((call) => call.function.name === "reply_to_message");
  const reactionCalls = interactions.filter((call) => call.function.name === "react_to_message");
  if (replyCalls.length > 1) return "one_reply_target_per_round_required";
  if (reactionCalls.length > TG_MAX_REACTIONS_PER_TURN) return "too_many_reactions_per_turn";
  const plannedReactionIds = new Set(alreadyReactedMessageIds);
  try {
    for (const call of reactionCalls) {
      const reaction = validateReactionIntent(JSON.parse(call.function.arguments) as Record<string, unknown>, allowedMessageIds);
      if (plannedReactionIds.has(reaction.messageId)) return "tg_reaction_duplicate_in_turn";
      plannedReactionIds.add(reaction.messageId);
    }
    for (const call of replyCalls) {
      validateReplyTarget(JSON.parse(call.function.arguments) as Record<string, unknown>, allowedMessageIds);
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

export function withReplyToFirstPayload(
  payloads: Record<string, unknown>[],
  messageId: number | null | undefined,
): Record<string, unknown>[] {
  if (!Number.isInteger(messageId) || payloads.length === 0) return payloads;
  return payloads.map((payload, index) => index === 0 ? {
    ...payload,
    reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
  } : payload);
}

async function sendOneMessage(env: Env, chatId: string, text: string): Promise<void> {
  for (let attempt = 0; attempt <= TG_SEND_MAX_RETRIES; attempt += 1) {
    const response = await tgApi(env, "sendMessage", { chat_id: chatId, text });
    if (response.ok) return;

    const body = await response.text();
    if (response.status === 429 && attempt < TG_SEND_MAX_RETRIES) {
      let retryAfterSec = 3;
      try {
        const parsed = JSON.parse(body) as { parameters?: { retry_after?: number } };
        if (typeof parsed.parameters?.retry_after === "number") {
          retryAfterSec = parsed.parameters.retry_after;
        }
      } catch {
        // keep default backoff when the 429 body is not JSON
      }
      await delay(retryAfterSec * 1000);
      continue;
    }

    throw new Error(`tg sendMessage failed (${response.status}): ${body.slice(0, 300)}`);
  }
}

/**
 * Send a full model reply as sequential bubbles. A bubble that keeps failing
 * after retries is logged and skipped so the rest of the reply still goes out.
 */
export async function sendMessageChunks(env: Env, chatId: string, text: string): Promise<void> {
  const chunks = splitIntoBubbles(text);
  if (chunks.length === 0) chunks.push("（空回复）");

  for (const chunk of chunks) {
    try {
      await sendOneMessage(env, chatId, chunk);
    } catch (error) {
      console.error("tg: bubble send failed, skipping", { chatId, error: String(error) });
    }
  }
}

export async function sendChatAction(env: Env, chatId: string, action = "typing"): Promise<void> {
  try {
    await tgApi(env, "sendChatAction", { chat_id: chatId, action });
  } catch (error) {
    // typing indicator is cosmetic; never let it break the reply path
    console.warn("tg: sendChatAction failed", { chatId, error: String(error) });
  }
}
