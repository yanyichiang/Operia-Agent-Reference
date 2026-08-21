export const TG_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
export const TG_VOICE_TIMEOUT_MS = 15_000;

export type VoiceMode = "off" | "once" | "auto";
export type TelegramAudioKind = "voice" | "audio";

export interface TelegramAudioAttachment {
  kind: TelegramAudioKind;
  fileId: string;
  uniqueId: string;
  durationSeconds?: number;
  mimeType?: string;
  fileSize?: number;
  fileName: string;
}

export interface VoiceServiceEnv {
  TG_BOT_TOKEN?: string;
  AGENT_SERVICE?: Fetcher;
  AGENT_CONTEXT_SERVICE_BEARER?: string;
}

export interface VoiceTranscription {
  text: string;
  language?: string;
  provider?: string;
}

export interface AudioOutboxPayload {
  kind: "audio";
  method: "sendAudio";
  audio: string;
  caption: string;
  mediaType?: string;
  fileName?: string;
  canonicalText: string;
  fallback: { kind: "text"; method: "sendMessage"; text: string };
}

type TelegramMedia = {
  file_id?: unknown;
  file_unique_id?: unknown;
  duration?: unknown;
  mime_type?: unknown;
  file_size?: unknown;
  file_name?: unknown;
};

type TelegramMessage = { voice?: TelegramMedia; audio?: TelegramMedia };
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ALLOWED_AUDIO_TYPES = new Set([
  "application/ogg",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
  "video/ogg",
]);

const EXTENSIONS_BY_TYPE: Record<string, string> = {
  "application/ogg": "ogg",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a",
  "audio/x-wav": "wav",
  "video/ogg": "ogg",
};

const TYPES_BY_EXTENSION: Record<string, string> = {
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
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

function inferredMimeType(fileName: string): string | undefined {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? TYPES_BY_EXTENSION[extension] : undefined;
}

function toAttachment(kind: TelegramAudioKind, media: TelegramMedia | undefined): TelegramAudioAttachment | null {
  const fileId = typeof media?.file_id === "string" ? media.file_id.trim() : "";
  if (!fileId) return null;
  const mimeType = cleanMimeType(media?.mime_type) ?? (kind === "voice" ? "audio/ogg" : undefined);
  const extension = mimeType ? EXTENSIONS_BY_TYPE[mimeType] : undefined;
  const fileName = safeFileName(media?.file_name, `${fileId}.${extension ?? "audio"}`);
  return {
    kind,
    fileId,
    uniqueId: typeof media?.file_unique_id === "string" ? media.file_unique_id : "",
    durationSeconds: finiteNonNegative(media?.duration),
    mimeType: mimeType ?? inferredMimeType(fileName),
    fileSize: finiteNonNegative(media?.file_size),
    fileName,
  };
}

export function getTelegramAudio(message: TelegramMessage | null | undefined): TelegramAudioAttachment | null {
  return toAttachment("voice", message?.voice) ?? toAttachment("audio", message?.audio);
}

export function normalizeVoiceMode(value: unknown): VoiceMode {
  if (typeof value !== "string") return "off";
  const normalized = value.trim().toLowerCase();
  if (normalized === "once") return "once";
  if (normalized === "auto" || normalized === "automatic") return "auto";
  return "off";
}

export function consumeVoiceMode(value: unknown): { sendAudio: boolean; nextMode: VoiceMode } {
  const mode = normalizeVoiceMode(value);
  if (mode === "once") return { sendAudio: true, nextMode: "off" };
  return { sendAudio: mode === "auto", nextMode: mode };
}

export function buildAudioOutboxPayload(input: {
  audio: string;
  text: string;
  caption?: string;
  mediaType?: string;
  fileName?: string;
}): AudioOutboxPayload {
  const audio = input.audio?.trim();
  if (!audio) throw new Error("audio_reference_required");
  const canonicalText = input.text?.trim();
  if (!canonicalText) throw new Error("canonical_text_required");
  const caption = (input.caption?.trim() || canonicalText).slice(0, 1024);
  return {
    kind: "audio",
    method: "sendAudio",
    audio,
    caption,
    ...(input.mediaType?.trim() ? { mediaType: cleanMimeType(input.mediaType) } : {}),
    ...(input.fileName?.trim() ? { fileName: safeFileName(input.fileName, "reply-audio") } : {}),
    canonicalText,
    fallback: { kind: "text", method: "sendMessage", text: canonicalText },
  };
}

async function runWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new Error("telegram_voice_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertAllowedAudio(mimeType: string | undefined): string {
  if (!mimeType || !ALLOWED_AUDIO_TYPES.has(mimeType)) throw new Error("telegram_audio_type_not_allowed");
  return mimeType;
}

function assertAllowedSize(value: number | undefined): void {
  if (value != null && value > TG_AUDIO_MAX_BYTES) throw new Error("telegram_audio_too_large");
}

function encodeTelegramPath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

export async function transcribeTelegramAudio(
  env: VoiceServiceEnv,
  attachment: TelegramAudioAttachment,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<VoiceTranscription> {
  if (!attachment?.fileId) throw new Error("telegram_audio_missing");
  const token = env.TG_BOT_TOKEN?.trim();
  if (!token) throw new Error("telegram_bot_token_missing");
  if (!env.AGENT_SERVICE) throw new Error("agent_service_missing");
  const serviceBearer = env.AGENT_CONTEXT_SERVICE_BEARER?.trim();
  if (!serviceBearer) throw new Error("agent_voice_auth_missing");

  const fetcher = options.fetch ?? fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Math.floor(Number(options.timeoutMs))
    : TG_VOICE_TIMEOUT_MS;
  const declaredType = assertAllowedAudio(cleanMimeType(attachment.mimeType) ?? inferredMimeType(attachment.fileName));
  assertAllowedSize(attachment.fileSize);

  const { response: getFileResponse, payload: getFilePayload } = await runWithTimeout(async (signal) => {
    const response = await fetcher(`https://api.telegram.org/bot${token}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: attachment.fileId }),
      signal,
    });
    let payload: unknown = {};
    try { payload = await response.json(); } catch (error) { if (signal.aborted) throw error; }
    return { response, payload };
  }, timeoutMs) as { response: Response; payload: {
    ok?: boolean;
    description?: string;
    result?: { file_path?: string; file_size?: number };
  } };
  if (!getFileResponse.ok || getFilePayload.ok !== true) {
    throw new Error(`telegram_get_file_failed:${getFileResponse.status}:${String(getFilePayload.description ?? "unknown").slice(0, 160)}`);
  }
  const filePath = getFilePayload.result?.file_path?.trim();
  if (!filePath) throw new Error("telegram_file_path_missing");
  assertAllowedSize(finiteNonNegative(getFilePayload.result?.file_size));

  const { response: downloadResponse, bytes } = await runWithTimeout(async (signal) => {
    const response = await fetcher(`https://api.telegram.org/file/bot${token}/${encodeTelegramPath(filePath)}`, {
      method: "GET",
      signal,
    });
    if (!response.ok) return { response, bytes: null };
    return { response, bytes: await response.arrayBuffer() };
  }, timeoutMs);
  if (!downloadResponse.ok) throw new Error(`telegram_file_download_failed:${downloadResponse.status}`);
  const contentLength = Number(downloadResponse.headers.get("content-length"));
  assertAllowedSize(Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : undefined);
  const responseType = cleanMimeType(downloadResponse.headers.get("content-type"));
  const mediaType = assertAllowedAudio(responseType ?? declaredType);

  if (!bytes) throw new Error("telegram_file_download_empty");
  // Raw audio remains scoped to this call and is never returned or persisted.
  assertAllowedSize(bytes.byteLength);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mediaType }), safeFileName(attachment.fileName, `telegram-audio.${EXTENSIONS_BY_TYPE[mediaType] ?? "audio"}`));
  form.append("kind", attachment.kind);
  form.append("telegram_file_id", attachment.fileId);
  if (attachment.uniqueId) form.append("telegram_file_unique_id", attachment.uniqueId);
  if (attachment.durationSeconds != null) form.append("duration_seconds", String(attachment.durationSeconds));

  const { response: agentResponse, payload } = await runWithTimeout(async (signal) => {
    const response = await env.AGENT_SERVICE!.fetch("https://<AGENT_SERVICE>.internal/service/providers/voice/transcribe", {
      method: "POST",
      headers: { authorization: `Bearer ${serviceBearer}` },
      body: form,
      signal,
    });
    let body: unknown = {};
    try { body = await response.json(); } catch (error) { if (signal.aborted) throw error; }
    return { response, payload: body as Record<string, unknown> };
  }, timeoutMs);
  if (!agentResponse.ok) {
    throw new Error(`agent_voice_http_${agentResponse.status}:${String(payload.error ?? "unknown").slice(0, 160)}`);
  }
  const text = typeof payload.text === "string"
    ? payload.text.trim()
    : typeof payload.transcript === "string" ? payload.transcript.trim() : "";
  if (!text) throw new Error("agent_voice_transcript_missing");
  return {
    text,
    ...(typeof payload.language === "string" && payload.language ? { language: payload.language } : {}),
    ...(typeof payload.provider === "string" && payload.provider ? { provider: payload.provider } : {}),
  };
}
