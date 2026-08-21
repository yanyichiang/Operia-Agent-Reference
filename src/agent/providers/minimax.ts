import { fetchText, requireEnabled, type ProviderHttpConfig } from "./http";
import {
  ProviderError,
  type MiniMaxClonedVoiceResult,
  type MiniMaxCloneUploadRequest,
  type MiniMaxDesignedVoiceResult,
  type MiniMaxSpeechModel,
  type MiniMaxSpeechResult,
  type MiniMaxTtsRequest,
  type MiniMaxUploadResult,
  type MiniMaxVoiceCloneRequest,
  type MiniMaxVoiceDeleteRequest,
  type MiniMaxVoiceDeleteResult,
  type MiniMaxVoiceDesignRequest,
  type MiniMaxVoiceListRequest,
  type MiniMaxVoiceListResult,
  type MiniMaxVoiceProjection,
  type ProviderFetch,
  type ProviderHealth,
  type ProviderRuntimeConfig,
} from "./types";

const DEFAULT_BASE_URL = "https://api.minimax.io";
const UW_BASE_URL = "https://api-uw.minimax.io";
const ALLOWED_BASE_URLS = new Set([DEFAULT_BASE_URL, UW_BASE_URL]);
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_RESPONSE_BYTES = 16 * 1024 * 1024;
const MODELS = new Set<MiniMaxSpeechModel>([
  "speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo",
  "speech-02-hd", "speech-02-turbo", "speech-01-hd", "speech-01-turbo",
]);
const CURRENT_MODELS = new Set<MiniMaxSpeechModel>(["speech-2.8-hd", "speech-2.8-turbo"]);
const LANGUAGES = new Set([
  "Chinese", "Chinese,Yue", "English", "Arabic", "Russian", "Spanish", "French", "Portuguese",
  "German", "Turkish", "Dutch", "Ukrainian", "Vietnamese", "Indonesian", "Japanese", "Italian",
  "Korean", "Thai", "Polish", "Romanian", "Greek", "Czech", "Finnish", "Hindi", "Bulgarian",
  "Danish", "Hebrew", "Malay", "Persian", "Slovak", "Swedish", "Croatian", "Filipino",
  "Hungarian", "Norwegian", "Slovenian", "Catalan", "Nynorsk", "Tamil", "Afrikaans", "auto",
]);
const EMOTIONS = new Set(["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent", "whisper"]);
const RETRYABLE_CODES = new Set([1001, 1002, 1013, 1039]);
const UNKNOWN_MUTATION_CODES = new Set([1001, 1013]);

type JsonRecord = Record<string, unknown>;

export class MiniMaxVoiceProvider {
  private readonly config: ProviderRuntimeConfig;
  private readonly fetchImpl: ProviderFetch;

  constructor(config: ProviderRuntimeConfig, fetchImpl: ProviderFetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    validatedBaseUrl(config.baseUrl);
  }

  snapshot() {
    return {
      id: "minimax" as const,
      enabled: this.config.enabled === true,
      configured: Boolean(this.config.apiKey?.trim()),
      capabilities: ["tts", "voice_design", "voice_clone", "voice_list", "voice_delete"] as const,
    };
  }

  health(): ProviderHealth {
    const snapshot = this.snapshot();
    return {
      ...snapshot,
      available: snapshot.enabled && snapshot.configured,
      ...(!snapshot.enabled ? { reason: "disabled" as const } : !snapshot.configured ? { reason: "missing_credentials" as const } : {}),
    };
  }

  async synthesize(input: MiniMaxTtsRequest["input"]): Promise<MiniMaxSpeechResult> {
    const model = modelId(input.model, true);
    const format = input.audioSettings?.format ?? "opus";
    const sampleRate = input.audioSettings?.sampleRate ?? 32000;
    const channel = input.audioSettings?.channel ?? 1;
    if (![32000, 44100].includes(sampleRate)) throw new ProviderError("minimax", "invalid_sample_rate");
    if (![1, 2].includes(channel)) throw new ProviderError("minimax", "invalid_channel");
    const bitrate = input.audioSettings?.bitrate;
    if (bitrate !== undefined && ![32000, 64000, 128000, 256000].includes(bitrate)) throw new ProviderError("minimax", "invalid_bitrate");
    if (format !== "mp3" && bitrate !== undefined) throw new ProviderError("minimax", "bitrate_requires_mp3");
    const settings = input.voiceSettings;
    const voiceSetting: JsonRecord = { voice_id: voiceId(input.voiceId) };
    optionalRange(voiceSetting, "speed", settings?.speed, 0.5, 2);
    optionalRange(voiceSetting, "vol", settings?.volume, Number.MIN_VALUE, 10, true);
    optionalInteger(voiceSetting, "pitch", settings?.pitch, -12, 12);
    if (settings?.emotion !== undefined) {
      if (!EMOTIONS.has(settings.emotion)) throw new ProviderError("minimax", "invalid_emotion");
      if (settings.emotion === "whisper" && CURRENT_MODELS.has(model)) throw new ProviderError("minimax", "emotion_not_supported_by_model");
      voiceSetting.emotion = settings.emotion;
    }
    const languageBoost = optionalLanguage(input.languageBoost);
    const body = {
      model,
      text: boundedText(input.text, "invalid_speech_text", 1, 4_000),
      stream: false,
      output_format: "hex",
      voice_setting: voiceSetting,
      audio_setting: { sample_rate: sampleRate, format, channel, ...(bitrate === undefined ? {} : { bitrate }) },
      ...(languageBoost ? { language_boost: languageBoost } : {}),
    };
    const value = await this.json("/v1/t2a_v2", { method: "POST", headers: this.jsonHeaders(), body: JSON.stringify(body), redirect: "error" }, false, true);
    const root = record(value);
    const data = record(root.data);
    if (typeof data.audio !== "string") throw new ProviderError("minimax", "invalid_response_shape");
    const audio = decodeHex(data.audio, 7 * 1024 * 1024, "invalid_audio_hex");
    const extra = record(root.extra_info);
    const usageCharacters = safeUsageCharacters(extra.usage_characters);
    const traceId = safeTraceId(root.trace_id);
    return {
      audio,
      contentType: format === "opus" ? "audio/ogg" : "audio/mpeg",
      mediaType: format === "opus" ? "audio/ogg" : "audio/mpeg",
      usageCharacters,
      ...(traceId ? { traceId } : {}),
      provider: { id: "minimax", model },
    };
  }

  async uploadCloneAudio(input: MiniMaxCloneUploadRequest["input"]): Promise<MiniMaxUploadResult> {
    return this.upload(input, "voice_clone");
  }

  async uploadPromptAudio(input: MiniMaxCloneUploadRequest["input"]): Promise<MiniMaxUploadResult> {
    return this.upload(input, "prompt_audio");
  }

  async cloneVoice(input: MiniMaxVoiceCloneRequest["input"]): Promise<MiniMaxClonedVoiceResult> {
    const fileId = decimalInt64(input.fileId, "invalid_file_id");
    const providerVoiceId = customVoiceId(input.voiceId);
    const textValidation = boundedText(input.textValidation, "invalid_text_validation", 1, 200);
    const accuracy = input.accuracy ?? 0.7;
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1) throw new ProviderError("minimax", "invalid_accuracy");
    if (input.previewText !== undefined && input.model === undefined) throw new ProviderError("minimax", "preview_model_required");
    if (input.model !== undefined && input.previewText === undefined) throw new ProviderError("minimax", "preview_text_required");
    const model = input.model === undefined ? undefined : modelId(input.model, false);
    const prompt = input.prompt ? {
      prompt_audio: rawDecimal(decimalInt64(input.prompt.fileId, "invalid_prompt_file_id")),
      prompt_text: boundedText(input.prompt.text, "invalid_prompt_text", 1, 200),
    } : undefined;
    const body = serializeRawDecimals({
      file_id: rawDecimal(fileId),
      voice_id: providerVoiceId,
      text_validation: textValidation,
      accuracy,
      need_noise_reduction: input.noiseReduction === true,
      need_volume_normalization: input.volumeNormalization === true,
      aigc_watermark: input.aigcWatermark !== false,
      ...(prompt ? { clone_prompt: prompt } : {}),
      ...(input.previewText === undefined ? {} : { text: boundedText(input.previewText, "invalid_preview_text", 1, 1_000), model }),
      ...(input.languageBoost ? { language_boost: optionalLanguage(input.languageBoost) } : {}),
    });
    const value = await this.remoteMutation(() => this.json("/v1/voice_clone", {
      method: "POST", headers: this.jsonHeaders(), body, redirect: "error",
    }, true));
    const root = record(value);
    const demoAudioUrl = optionalPrivateHttpsUrl(root.demo_audio);
    const extra = record(root.extra_info);
    const usage = extra.usage_characters === undefined ? undefined : safeUsageCharacters(extra.usage_characters);
    const traceId = safeTraceId(root.trace_id);
    return { voiceId: providerVoiceId, ...(demoAudioUrl ? { demoAudioUrl } : {}), ...(usage === undefined ? {} : { usageCharacters: usage }), ...(traceId ? { traceId } : {}) };
  }

  async designVoice(input: MiniMaxVoiceDesignRequest["input"]): Promise<MiniMaxDesignedVoiceResult> {
    const body = {
      prompt: boundedText(input.prompt, "invalid_voice_prompt", 1, 1_000),
      preview_text: boundedText(input.previewText, "invalid_preview_text", 1, 500),
      ...(input.voiceId ? { voice_id: customVoiceId(input.voiceId) } : {}),
    };
    const value = await this.remoteMutation(() => this.json("/v1/voice_design", {
      method: "POST", headers: this.jsonHeaders(), body: JSON.stringify(body), redirect: "error",
    }, true));
    const root = record(value);
    if (typeof root.voice_id !== "string" || typeof root.trial_audio !== "string") throw new ProviderError("minimax", "invalid_response_shape");
    return { voiceId: customVoiceId(root.voice_id), trialAudio: decodeHex(root.trial_audio, 7 * 1024 * 1024, "invalid_trial_audio"), contentType: "audio/mpeg" };
  }

  async listVoices(input: MiniMaxVoiceListRequest["input"]): Promise<MiniMaxVoiceListResult> {
    if (!new Set(["system", "voice_cloning", "voice_generation", "all"]).has(input.type)) throw new ProviderError("minimax", "invalid_voice_type");
    const value = await this.json("/v1/get_voice", {
      method: "POST", headers: this.jsonHeaders(), body: JSON.stringify({ voice_type: input.type }), redirect: "error",
    });
    const root = record(value);
    const voices: MiniMaxVoiceProjection[] = [];
    for (const [field, kind] of [["system_voice", "system"], ["voice_cloning", "voice_cloning"], ["voice_generation", "voice_generation"]] as const) {
      const rows = root[field];
      if (rows === undefined) continue;
      if (!Array.isArray(rows)) throw new ProviderError("minimax", "invalid_response_shape");
      for (const raw of rows.slice(0, 1_000)) {
        const row = record(raw);
        if (typeof row.voice_id !== "string") throw new ProviderError("minimax", "invalid_response_shape");
        voices.push({
          voiceId: voiceId(row.voice_id), kind,
          ...(typeof row.voice_name === "string" ? { name: row.voice_name.slice(0, 200) } : {}),
          description: Array.isArray(row.description) ? row.description.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 500)) : [],
          ...(typeof row.created_time === "string" ? { createdAt: row.created_time.slice(0, 32) } : {}),
        });
      }
    }
    return { voices };
  }

  async deleteVoice(input: MiniMaxVoiceDeleteRequest["input"]): Promise<MiniMaxVoiceDeleteResult> {
    if (input.type !== "voice_cloning" && input.type !== "voice_generation") throw new ProviderError("minimax", "invalid_voice_type");
    const providerVoiceId = customVoiceId(input.voiceId);
    const value = await this.remoteMutation(() => this.json("/v1/delete_voice", {
      method: "POST", headers: this.jsonHeaders(), body: JSON.stringify({ voice_type: input.type, voice_id: providerVoiceId }), redirect: "error",
    }, true));
    const root = record(value);
    if (root.voice_id !== providerVoiceId) throw new ProviderError("minimax", "invalid_response_shape");
    return { deleted: true, voiceId: providerVoiceId };
  }

  private async upload(input: MiniMaxCloneUploadRequest["input"], purpose: "voice_clone" | "prompt_audio"): Promise<MiniMaxUploadResult> {
    const extension = input.contentType === "audio/mpeg" ? "mp3" : input.contentType === "audio/mp4" ? "m4a" : input.contentType === "audio/wav" ? "wav" : null;
    if (!extension) throw new ProviderError("minimax", "invalid_audio_content_type");
    if (input.audio.byteLength < 1 || input.audio.byteLength > MAX_AUDIO_BYTES) throw new ProviderError("minimax", "invalid_audio_size");
    const form = new FormData();
    form.set("purpose", purpose);
    form.set("file", new Blob([input.audio.slice().buffer as ArrayBuffer], { type: input.contentType }), safeFileName(input.fileName, extension));
    const value = await this.remoteMutation(() => this.json("/v1/files/upload", {
      method: "POST", headers: { authorization: `Bearer ${this.authorize()}` }, body: form, redirect: "error",
    }, true, false, true));
    const root = record(value);
    const file = record(root.file);
    if (typeof file.file_id !== "string") throw new ProviderError("minimax", "invalid_response_shape");
    return { fileId: decimalInt64(file.file_id, "invalid_file_id") };
  }

  private authorize(): string {
    return requireEnabled("minimax", this.config.enabled === true, this.config.apiKey);
  }

  private jsonHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.authorize()}`, "content-type": "application/json" };
  }

  private http(maxResponseBytes = this.config.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES): ProviderHttpConfig {
    return { provider: "minimax", fetch: this.fetchImpl, timeoutMs: this.config.timeoutMs, maxResponseBytes, signal: this.config.signal };
  }

  private async json(path: string, init: RequestInit, mutation = false, allowUw = false, preserveFileId = false): Promise<unknown> {
    let text: string;
    let status: number;
    try {
      ({ text, status } = await fetchText(this.http(), this.url(path, allowUw), init, ["application/json"]));
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const retryable = error.code === "timeout" || error.code === "network_error" || error.status === 408 || error.status === 425 || error.status === 429 || (error.status !== undefined && error.status >= 500);
      const remoteOutcome = mutation && (error.code === "timeout" || error.code === "network_error" || (error.status !== undefined && error.status >= 500)) ? "unknown" : "definitive";
      throw new ProviderError("minimax", error.code, error.status, {
        upstreamCode: error.upstreamCode, requestId: error.requestId, retryable, remoteOutcome,
      });
    }
    let value: unknown;
    try {
      value = preserveFileId ? parseJsonPreservingDecimalFields(text, new Set(["file_id"])) : JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("minimax", "invalid_response_json", status, { remoteOutcome: mutation ? "unknown" : "definitive" });
    }
    requireMiniMaxSuccess(value, mutation);
    return value;
  }

  private url(path: string, allowUw = false): string {
    const base = validatedBaseUrl(this.config.baseUrl);
    if (base === UW_BASE_URL && !allowUw) throw new ProviderError("minimax", "unsupported_endpoint_host");
    if (!/^\/v1\/[a-z0-9_/-]+$/.test(path)) throw new ProviderError("minimax", "invalid_endpoint_path");
    return `${base}${path}`;
  }

  private async remoteMutation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.remoteOutcome === "unknown") throw error;
      const unknown = error.code === "timeout" || error.code === "network_error" || (error.status !== undefined && error.status >= 500);
      if (!unknown) throw error;
      throw new ProviderError("minimax", error.code, error.status, {
        upstreamCode: error.upstreamCode, requestId: error.requestId, retryable: true, remoteOutcome: "unknown",
      });
    }
  }
}

function validatedBaseUrl(value?: string): string {
  const raw = value?.trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new ProviderError("minimax", "invalid_base_url"); }
  if (!ALLOWED_BASE_URLS.has(parsed.origin) || raw !== parsed.origin || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    throw new ProviderError("minimax", "invalid_base_url");
  }
  return parsed.origin;
}

function requireMiniMaxSuccess(value: unknown, mutation: boolean): void {
  const root = record(value);
  const base = record(root.base_resp);
  if (!Number.isSafeInteger(base.status_code)) throw new ProviderError("minimax", "invalid_response_shape", 200, { remoteOutcome: mutation ? "unknown" : "definitive" });
  const code = Number(base.status_code);
  if (code === 0) return;
  throw new ProviderError("minimax", "upstream_error", 200, {
    upstreamCode: `minimax_${code}`,
    requestId: safeTraceId(root.trace_id),
    retryable: RETRYABLE_CODES.has(code),
    remoteOutcome: mutation && UNKNOWN_MUTATION_CODES.has(code) ? "unknown" : "definitive",
  });
}

export function parseJsonPreservingDecimalFields(text: string, fields: ReadonlySet<string>): unknown {
  let output = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') { output += text[index++]; continue; }
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const char = text[index++];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') break;
    }
    if (text[index - 1] !== '"') throw new ProviderError("minimax", "invalid_response_json");
    const token = text.slice(start, index);
    output += token;
    let key: unknown;
    try { key = JSON.parse(token); } catch { throw new ProviderError("minimax", "invalid_response_json"); }
    if (typeof key !== "string" || !fields.has(key)) continue;
    let cursor = index;
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] !== ":") continue;
    cursor += 1;
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    const numberStart = cursor;
    while (/[0-9]/.test(text[cursor] ?? "")) cursor += 1;
    if (cursor === numberStart) continue;
    const boundary = text[cursor];
    if (boundary !== undefined && !/[\s,}\]]/.test(boundary)) throw new ProviderError("minimax", "invalid_response_json");
    output += text.slice(index, numberStart) + `"${text.slice(numberStart, cursor)}"`;
    index = cursor;
  }
  return JSON.parse(output) as unknown;
}

type RawDecimal = { readonly __minimaxRawDecimal: string };
function rawDecimal(value: string): RawDecimal { return { __minimaxRawDecimal: value }; }

export function serializeRawDecimals(value: unknown): string {
  const sentinels: string[] = [];
  const json = JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 1 && typeof (item as JsonRecord).__minimaxRawDecimal === "string") {
      const decimal = decimalInt64((item as JsonRecord).__minimaxRawDecimal as string, "invalid_file_id");
      const sentinel = `__MINIMAX_RAW_DECIMAL_${sentinels.length}__`;
      sentinels.push(decimal);
      return sentinel;
    }
    return item;
  });
  return sentinels.reduce((result, decimal, index) => result.replace(`"__MINIMAX_RAW_DECIMAL_${index}__"`, decimal), json);
}

function decimalInt64(value: unknown, code: string): string {
  if (typeof value !== "string") throw new ProviderError("minimax", code);
  const clean = value.trim();
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(clean)) throw new ProviderError("minimax", code);
  const parsed = BigInt(clean);
  if (parsed < 0n || parsed > 9_223_372_036_854_775_807n) throw new ProviderError("minimax", code);
  return clean;
}

function modelId(value: MiniMaxSpeechModel | undefined, currentDefault: boolean): MiniMaxSpeechModel {
  const result = value ?? (currentDefault ? "speech-2.8-turbo" : "speech-2.8-hd");
  if (!MODELS.has(result)) throw new ProviderError("minimax", "invalid_model");
  return result;
}

function voiceId(value: unknown): string {
  if (typeof value !== "string") throw new ProviderError("minimax", "invalid_voice_id");
  const clean = value.trim();
  if (clean.length < 1 || clean.length > 256 || /[\u0000-\u001f\u007f]/.test(clean)) throw new ProviderError("minimax", "invalid_voice_id");
  return clean;
}

function customVoiceId(value: unknown): string {
  if (typeof value !== "string") throw new ProviderError("minimax", "invalid_voice_id");
  const clean = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/.test(clean)) throw new ProviderError("minimax", "invalid_voice_id");
  return clean;
}

function boundedText(value: unknown, code: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw new ProviderError("minimax", code);
  const clean = value.trim();
  if (clean.length < minimum || clean.length > maximum) throw new ProviderError("minimax", code);
  return clean;
}

function optionalRange(target: JsonRecord, key: string, value: number | undefined, minimum: number, maximum: number, exclusiveMinimum = false): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || (exclusiveMinimum ? value <= minimum : value < minimum) || value > maximum) throw new ProviderError("minimax", `invalid_${key}`);
  target[key] = value;
}

function optionalInteger(target: JsonRecord, key: string, value: number | undefined, minimum: number, maximum: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new ProviderError("minimax", `invalid_${key}`);
  target[key] = value;
}

function optionalLanguage(value?: string): string | undefined {
  if (value === undefined) return undefined;
  if (!LANGUAGES.has(value)) throw new ProviderError("minimax", "invalid_language_boost");
  return value;
}

function decodeHex(value: string, maxBytes: number, code: string): Uint8Array {
  if (value.length === 0 || value.length % 2 !== 0 || value.length > maxBytes * 2 || !/^[0-9a-f]+$/i.test(value)) throw new ProviderError("minimax", code);
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function safeUsageCharacters(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 10_000) throw new ProviderError("minimax", "invalid_usage_characters");
  return Number(value);
}

function safeTraceId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

function optionalPrivateHttpsUrl(value: unknown): string | undefined {
  if (value === "" || value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 2_048) throw new ProviderError("minimax", "invalid_demo_audio_url");
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError("minimax", "invalid_demo_audio_url"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new ProviderError("minimax", "invalid_demo_audio_url");
  return url.toString();
}

function safeFileName(value: string | undefined, extension: string): string {
  const stem = (value ?? `voice-sample.${extension}`).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "voice-sample";
  return stem.toLowerCase().endsWith(`.${extension}`) ? stem : `${stem}.${extension}`;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
