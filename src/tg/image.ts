import type { Env, OpenAIChatRequest } from "../types";

export const TG_IMAGE_MAX_COUNT = 4;
export const TG_IMAGE_HARD_MAX_BYTES = 20 * 1024 * 1024;
export const TG_IMAGE_TIMEOUT_MS = 15_000;

export interface TelegramImageAttachment {
  kind: "image";
  fileId: string;
  uniqueId: string;
  mimeType: string;
  fileSize?: number;
  width?: number;
  height?: number;
  fileName: string;
}

export interface PreparedTelegramImages {
  request: OpenAIChatRequest;
  count: number;
  omitted: number;
  totalBytes: number;
  mimeTypes: string[];
}

type TelegramImageMedia = {
  file_id?: unknown;
  file_unique_id?: unknown;
  mime_type?: unknown;
  file_size?: unknown;
  file_name?: unknown;
  width?: unknown;
  height?: unknown;
};

type TelegramImageMessage = {
  photo?: TelegramImageMedia[];
  document?: TelegramImageMedia;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ALLOWED_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const EXTENSIONS_BY_TYPE: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function cleanMimeType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mimeType = value.split(";", 1)[0].trim().toLowerCase();
  return mimeType || undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeFileName(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const leaf = value.trim().split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160);
  return leaf || fallback;
}

function allowedMimeType(value: unknown): string | null {
  const mimeType = cleanMimeType(value);
  return mimeType && ALLOWED_IMAGE_TYPES.has(mimeType) ? mimeType : null;
}

function validImageMedia(media: TelegramImageMedia | undefined): media is TelegramImageMedia & { file_id: string } {
  return typeof media?.file_id === "string" && Boolean(media.file_id.trim());
}

function photoRank(media: TelegramImageMedia): [number, number] {
  const fileSize = finiteNonNegative(media.file_size) ?? -1;
  const area = (finiteNonNegative(media.width) ?? 0) * (finiteNonNegative(media.height) ?? 0);
  return [fileSize, area];
}

function toAttachment(media: TelegramImageMedia, mimeType: string): TelegramImageAttachment {
  const fileId = String(media.file_id).trim();
  return {
    kind: "image",
    fileId,
    uniqueId: typeof media.file_unique_id === "string" ? media.file_unique_id : "",
    mimeType,
    fileSize: finiteNonNegative(media.file_size),
    width: finiteNonNegative(media.width),
    height: finiteNonNegative(media.height),
    fileName: safeFileName(media.file_name, `${fileId}.${EXTENSIONS_BY_TYPE[mimeType] ?? "image"}`),
  };
}

export function getTelegramImage(message: TelegramImageMessage | null | undefined): TelegramImageAttachment | null {
  const photos = Array.isArray(message?.photo) ? message.photo.filter(validImageMedia) : [];
  if (photos.length > 0) {
    const selected = [...photos].sort((a, b) => {
      const [aBytes, aArea] = photoRank(a);
      const [bBytes, bArea] = photoRank(b);
      return bBytes - aBytes || bArea - aArea;
    })[0];
    return toAttachment(selected, "image/jpeg");
  }

  const document = message?.document;
  const mimeType = allowedMimeType(document?.mime_type);
  if (!validImageMedia(document) || !mimeType) return null;
  return toAttachment(document, mimeType);
}

export function hasUnsupportedTelegramImageDocument(message: TelegramImageMessage | null | undefined): boolean {
  const document = message?.document;
  if (!validImageMedia(document)) return false;
  const mimeType = cleanMimeType(document.mime_type);
  return Boolean(mimeType?.startsWith("image/") && !ALLOWED_IMAGE_TYPES.has(mimeType));
}

function boundedConfiguredBytes(env: Pick<Env, "TG_MEDIA_MAX_BYTES">): number {
  const configured = Number(env.TG_MEDIA_MAX_BYTES);
  if (!Number.isFinite(configured) || configured <= 0) return TG_IMAGE_HARD_MAX_BYTES;
  return Math.min(Math.floor(configured), TG_IMAGE_HARD_MAX_BYTES);
}

function assertAllowedSize(value: number | undefined, maxBytes: number): void {
  if (value != null && value > maxBytes) throw new Error("telegram_image_too_large");
}

function encodeTelegramPath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

async function runWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("telegram_image_timeout");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new Error("telegram_image_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function remainingTimeoutMs(deadlineMs: number): number {
  return Math.max(0, Math.floor(deadlineMs - Date.now()));
}

function normalizeTelegramImageError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "telegram_bot_token_missing"
    || /^telegram_image_[a-z_]+(?::[0-9]{3})?$/.test(message)) {
    return new Error(message);
  }
  // Runtime transport errors may contain a token-bearing URL, Telegram path,
  // response body, or platform internals. Keep the terminal code stable and
  // content-free instead of persisting the original exception in D1/events.
  return new Error("telegram_image_transport_failed");
}

async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!body) throw new Error("telegram_image_download_empty");
  const reader = body.getReader();
  const abort = () => { void reader.cancel("telegram_image_timeout"); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("telegram_image_too_large");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (total === 0) throw new Error("telegram_image_download_empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return btoa(binary);
}

async function downloadTelegramImage(
  env: Pick<Env, "TG_BOT_TOKEN">,
  attachment: TelegramImageAttachment,
  options: { fetch: FetchLike; deadlineMs: number; maxBytes: number },
): Promise<{ dataUrl: string; mimeType: string; byteLength: number }> {
  const token = env.TG_BOT_TOKEN?.trim();
  if (!token) throw new Error("telegram_bot_token_missing");
  if (!ALLOWED_IMAGE_TYPES.has(attachment.mimeType)) throw new Error("telegram_image_type_not_allowed");
  assertAllowedSize(attachment.fileSize, options.maxBytes);

  const { response: getFileResponse, payload: getFilePayload } = await runWithTimeout(async (signal) => {
    const response = await options.fetch(`https://api.telegram.org/bot${token}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: attachment.fileId }),
      signal,
    });
    let payload: unknown = {};
    try { payload = await response.json(); } catch (error) { if (signal.aborted) throw error; }
    return { response, payload };
  }, remainingTimeoutMs(options.deadlineMs)) as { response: Response; payload: {
    ok?: boolean;
    description?: string;
    result?: { file_path?: string; file_size?: number };
  } };
  if (!getFileResponse.ok || getFilePayload.ok !== true) {
    throw new Error(`telegram_image_get_file_failed:${getFileResponse.status}`);
  }
  const filePath = getFilePayload.result?.file_path?.trim();
  if (!filePath) throw new Error("telegram_image_file_path_missing");
  assertAllowedSize(finiteNonNegative(getFilePayload.result?.file_size), options.maxBytes);

  const downloadResponse = await runWithTimeout((signal) => options.fetch(
    `https://api.telegram.org/file/bot${token}/${encodeTelegramPath(filePath)}`,
    { method: "GET", signal },
  ), remainingTimeoutMs(options.deadlineMs));
  if (!downloadResponse.ok) throw new Error(`telegram_image_download_failed:${downloadResponse.status}`);
  const contentLength = Number(downloadResponse.headers.get("content-length"));
  assertAllowedSize(Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : undefined, options.maxBytes);
  const responseType = cleanMimeType(downloadResponse.headers.get("content-type"));
  const mimeType = responseType && responseType !== "application/octet-stream" ? allowedMimeType(responseType) : attachment.mimeType;
  if (!mimeType) throw new Error("telegram_image_type_not_allowed");
  const bytes = await runWithTimeout(
    (signal) => readBoundedBody(downloadResponse.body, options.maxBytes, signal),
    remainingTimeoutMs(options.deadlineMs),
  );
  return { dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`, mimeType, byteLength: bytes.byteLength };
}

function parseAttachment(payloadJson: string): TelegramImageAttachment {
  let value: unknown;
  try { value = JSON.parse(payloadJson); } catch { throw new Error("telegram_image_payload_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("telegram_image_payload_invalid");
  const payload = value as Record<string, unknown>;
  const fileId = typeof payload.fileId === "string" ? payload.fileId.trim() : "";
  const mimeType = allowedMimeType(payload.mimeType);
  if (!fileId || !mimeType) throw new Error("telegram_image_payload_invalid");
  return {
    kind: "image",
    fileId,
    uniqueId: typeof payload.uniqueId === "string" ? payload.uniqueId : "",
    mimeType,
    fileSize: finiteNonNegative(payload.fileSize),
    width: finiteNonNegative(payload.width),
    height: finiteNonNegative(payload.height),
    fileName: safeFileName(payload.fileName, `${fileId}.${EXTENSIONS_BY_TYPE[mimeType] ?? "image"}`),
  };
}

function appendImageParts(request: OpenAIChatRequest, images: Array<{ dataUrl: string }>, omitted: number): OpenAIChatRequest {
  const messages = request.messages.map((message) => ({ ...message }));
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") { userIndex = index; break; }
  }
  if (userIndex < 0) throw new Error("telegram_image_user_message_missing");
  const current = messages[userIndex];
  const text = typeof current.content === "string" ? current.content : "[你发送了图片]";
  current.content = [
    { type: "text", text: omitted > 0 ? `${text}\n[另有 ${omitted} 张图片超过本轮最多 ${TG_IMAGE_MAX_COUNT} 张的限制，未送入视觉模型。]` : text },
    ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
  ];
  return { ...request, messages };
}

export async function prepareTelegramImageRequest(
  env: Pick<Env, "DB" | "TG_BOT_TOKEN" | "TG_MEDIA_MAX_BYTES">,
  inboxIds: number[],
  request: OpenAIChatRequest,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<PreparedTelegramImages | null> {
  const ids = inboxIds.filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return null;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT id,payload_json FROM tg_inbox WHERE kind='image' AND id IN (${placeholders}) ORDER BY id`)
    .bind(...ids).all<{ id: number; payload_json: string }>();
  const attachments = (rows.results ?? []).map((row) => parseAttachment(row.payload_json));
  if (attachments.length === 0) return null;

  const maxBytes = boundedConfiguredBytes(env);
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Math.floor(Number(options.timeoutMs))
    : TG_IMAGE_TIMEOUT_MS;
  // Cloudflare runtime methods require their original receiver. Passing the
  // bare global fetch as `options.fetch` and later invoking it as an object
  // method throws `Illegal invocation`; keep the injectable test seam while
  // calling the production global with its correct receiver.
  const fetcher: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const deadlineMs = Date.now() + timeoutMs;
  const selected = attachments.slice(0, TG_IMAGE_MAX_COUNT);
  const downloaded: Array<{ dataUrl: string; mimeType: string; byteLength: number }> = [];
  let totalBytes = 0;
  for (const attachment of selected) {
    const remaining = maxBytes - totalBytes;
    if (remaining <= 0) throw new Error("telegram_image_total_too_large");
    let image: Awaited<ReturnType<typeof downloadTelegramImage>>;
    try {
      image = await downloadTelegramImage(env, attachment, { fetch: fetcher, deadlineMs, maxBytes: remaining });
    } catch (error) {
      throw normalizeTelegramImageError(error);
    }
    totalBytes += image.byteLength;
    downloaded.push(image);
  }

  return {
    request: appendImageParts(request, downloaded, Math.max(0, attachments.length - selected.length)),
    count: downloaded.length,
    omitted: Math.max(0, attachments.length - selected.length),
    totalBytes,
    mimeTypes: [...new Set(downloaded.map((image) => image.mimeType))].sort(),
  };
}
