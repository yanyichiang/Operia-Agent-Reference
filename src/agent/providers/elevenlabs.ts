import { fetchBytes, fetchJson, requireEnabled, type ProviderHttpConfig } from "./http";
import { ProviderError, type ElevenLabsSttRequest, type ElevenLabsTtsRequest, type ElevenLabsVoiceDesignRequest, type ElevenLabsVoiceSaveRequest, type ProviderFetch, type ProviderHealth, type ProviderRuntimeConfig, type SpeechResult, type TranscriptResult, type VoiceDesignResult, type VoiceSaveResult } from "./types";

const DEFAULT_BASE_URL = "https://api.elevenlabs.io/v1";
const MAX_INPUT_AUDIO_BYTES = 25 * 1024 * 1024;

export class ElevenLabsProvider {
  private readonly config: ProviderRuntimeConfig;
  private readonly fetchImpl: ProviderFetch;

  constructor(config: ProviderRuntimeConfig, fetchImpl: ProviderFetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  snapshot() {
    return {
      id: "elevenlabs" as const,
      enabled: this.config.enabled === true,
      configured: Boolean(this.config.apiKey?.trim()),
      capabilities: ["voice_design", "voice_save", "stt", "tts"] as const,
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

  async designVoice(input: ElevenLabsVoiceDesignRequest["input"] | (Omit<ElevenLabsVoiceDesignRequest["input"], "voiceDescription"> & { description: string })): Promise<VoiceDesignResult> {
    const description = "voiceDescription" in input ? input.voiceDescription : input.description;
    const body: Record<string, unknown> = {
      voice_description: text(description, "invalid_voice_description", 20, 1_000),
      model_id: input.modelId ?? "eleven_multilingual_ttv_v2",
      auto_generate_text: input.text === undefined,
    };
    if (input.text !== undefined) body.text = text(input.text, "invalid_preview_text", 100, 1_000);
    optionalRange(body, "loudness", input.loudness, -1, 1);
    optionalInteger(body, "seed", input.seed, 0, 2_147_483_647);
    optionalRange(body, "guidance_scale", input.guidanceScale, 0, 100);
    optionalRange(body, "quality", input.quality, -1, 1);
    const value = await fetchJson(this.http(this.responseLimit(12 * 1024 * 1024)), `${baseUrl(this.config.baseUrl)}/text-to-voice/design`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify(body),
    });
    return parseVoiceDesign(value);
  }

  async saveVoice(input: ElevenLabsVoiceSaveRequest["input"] | { name: string; description: string; generatedVoiceId: string; labels?: Record<string, string> }): Promise<VoiceSaveResult> {
    const voiceName = "voiceName" in input ? input.voiceName : input.name;
    const voiceDescription = "voiceDescription" in input ? input.voiceDescription : input.description;
    const labels = input.labels === undefined ? undefined : safeLabels(input.labels);
    const value = await fetchJson(this.http(), `${baseUrl(this.config.baseUrl)}/text-to-voice`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({
        voice_name: text(voiceName, "invalid_voice_name", 1, 100),
        voice_description: text(voiceDescription, "invalid_voice_description", 20, 1_000),
        generated_voice_id: identifier(input.generatedVoiceId, "invalid_generated_voice_id"),
        ...(labels ? { labels } : {}),
      }),
    });
    const root = record(value);
    if (typeof root.voice_id !== "string" || !root.voice_id) throw new ProviderError("elevenlabs", "invalid_response_shape");
    return { voiceId: root.voice_id.slice(0, 256) };
  }

  async transcribe(input: ElevenLabsSttRequest["input"] | { audio: Uint8Array; mediaType: string; fileName?: string; languageCode?: string }): Promise<TranscriptResult> {
    const apiKey = this.authorize();
    const contentType = "contentType" in input ? input.contentType : input.mediaType;
    if (input.audio.byteLength < 1 || input.audio.byteLength > MAX_INPUT_AUDIO_BYTES) throw new ProviderError("elevenlabs", "invalid_audio_size");
    if (!/^audio\/[a-z0-9.+-]+$/i.test(contentType)) throw new ProviderError("elevenlabs", "invalid_audio_content_type");
    const form = new FormData();
    const bytes = input.audio.slice().buffer as ArrayBuffer;
    form.set("file", new Blob([bytes], { type: contentType }), safeFileName(input.fileName));
    form.set("model_id", "scribe_v2");
    if (input.languageCode) form.set("language_code", text(input.languageCode, "invalid_language_code", 2, 16));
    const value = await fetchJson(this.http(), `${baseUrl(this.config.baseUrl)}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
    const root = record(value);
    if (typeof root.text !== "string") throw new ProviderError("elevenlabs", "invalid_response_shape");
    return {
      text: root.text.slice(0, 100_000),
      ...(typeof root.language_code === "string" ? { languageCode: root.language_code.slice(0, 16) } : {}),
      ...(typeof root.language_probability === "number" && Number.isFinite(root.language_probability) ? { languageProbability: root.language_probability } : {}),
    };
  }

  async synthesize(input: ElevenLabsTtsRequest["input"]): Promise<SpeechResult> {
    const voiceId = identifier(input.voiceId, "invalid_voice_id");
    const outputFormat = input.outputFormat ?? "mp3_44100_128";
    if (!/^[a-z0-9_]{1,64}$/i.test(outputFormat)) throw new ProviderError("elevenlabs", "invalid_output_format");
    const query = `output_format=${encodeURIComponent(outputFormat)}&enable_logging=false`;
    const voiceSettings = input.voiceSettings ? {
      stability: boundedSetting(input.voiceSettings.stability, 0, 1, "stability"),
      similarity_boost: boundedSetting(input.voiceSettings.similarityBoost, 0, 1, "similarity_boost"),
      style: boundedSetting(input.voiceSettings.style, 0, 1, "style"),
      speed: boundedSetting(input.voiceSettings.speed, 0.7, 1.2, "speed"),
    } : undefined;
    const result = await fetchBytes(this.http(this.responseLimit(12 * 1024 * 1024)), `${baseUrl(this.config.baseUrl)}/text-to-speech/${encodeURIComponent(voiceId)}?${query}`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ text: text(input.text, "invalid_speech_text", 1, 10_000), model_id: input.modelId ?? "eleven_multilingual_v2", ...(voiceSettings ? { voice_settings: voiceSettings } : {}) }),
    }, ["audio/"]);
    return { audio: result.bytes, contentType: result.contentType, mediaType: result.contentType };
  }

  private authorize(): string {
    return requireEnabled("elevenlabs", this.config.enabled === true, this.config.apiKey);
  }

  private jsonHeaders(): Record<string, string> {
    return { "xi-api-key": this.authorize(), "content-type": "application/json" };
  }

  private http(maxResponseBytes = this.config.maxResponseBytes): ProviderHttpConfig {
    return { provider: "elevenlabs", fetch: this.fetchImpl, timeoutMs: this.config.timeoutMs, maxResponseBytes, signal: this.config.signal };
  }

  private responseLimit(endpointLimit: number): number {
    return Math.min(this.config.maxResponseBytes ?? endpointLimit, endpointLimit);
  }
}

function boundedSetting(value: number | undefined, minimum: number, maximum: number, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new ProviderError("elevenlabs", `invalid_${name}`);
  return value;
}

function parseVoiceDesign(value: unknown): VoiceDesignResult {
  const root = record(value);
  if (!Array.isArray(root.previews) || typeof root.text !== "string") throw new ProviderError("elevenlabs", "invalid_response_shape");
  const previews = root.previews.slice(0, 3).map((raw) => {
    const item = record(raw);
    if (typeof item.generated_voice_id !== "string" || typeof item.audio_base_64 !== "string" || typeof item.media_type !== "string") {
      throw new ProviderError("elevenlabs", "invalid_response_shape");
    }
    validateBase64(item.audio_base_64);
    return {
      generatedVoiceId: item.generated_voice_id.slice(0, 256),
      audioBase64: item.audio_base_64,
      audio: decodeBase64(item.audio_base_64),
      mediaType: /^audio\/[a-z0-9.+-]+$/i.test(item.media_type) ? item.media_type : "audio/mpeg",
      ...(typeof item.duration_secs === "number" && Number.isFinite(item.duration_secs) ? { durationSeconds: item.duration_secs } : {}),
      ...(typeof item.language === "string" ? { language: item.language.slice(0, 32) } : {}),
    };
  });
  if (previews.length === 0) throw new ProviderError("elevenlabs", "invalid_response_shape");
  return { previews, text: root.text.slice(0, 1_000) };
}

function validateBase64(value: string): void {
  if (value.length > 16 * 1024 * 1024 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new ProviderError("elevenlabs", "invalid_preview_audio");
  }
}

function decodeBase64(value: string): Uint8Array {
  validateBase64(value);
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new ProviderError("elevenlabs", "invalid_preview_audio");
  }
}

function text(value: string, code: string, minimum: number, maximum: number): string {
  const clean = value.trim();
  if (clean.length < minimum || clean.length > maximum) throw new ProviderError("elevenlabs", code);
  return clean;
}

function identifier(value: string, code: string): string {
  const clean = value.trim();
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(clean)) throw new ProviderError("elevenlabs", code);
  return clean;
}

function optionalRange(target: Record<string, unknown>, key: string, value: number | undefined, minimum: number, maximum: number): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new ProviderError("elevenlabs", `invalid_${key}`);
  target[key] = value;
}

function optionalInteger(target: Record<string, unknown>, key: string, value: number | undefined, minimum: number, maximum: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new ProviderError("elevenlabs", `invalid_${key}`);
  target[key] = value;
}

function safeLabels(labels: Record<string, string>): Record<string, string> {
  const entries = Object.entries(labels);
  if (entries.length > 20) throw new ProviderError("elevenlabs", "invalid_labels");
  return Object.fromEntries(entries.map(([key, value]) => [text(key, "invalid_labels", 1, 64), text(value, "invalid_labels", 1, 128)]));
}

function safeFileName(value?: string): string {
  return (value ?? "audio.bin").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "audio.bin";
}

function baseUrl(value?: string): string {
  return (value?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
