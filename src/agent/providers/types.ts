export type ProviderId = "xai" | "elevenlabs" | "minimax" | "home_assistant";

export type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ProviderRuntimeConfig = {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
};

export type HomeAssistantRuntimeConfig = Omit<ProviderRuntimeConfig, "apiKey"> & {
  accessToken?: string;
  entityAllowlist?: readonly string[];
  serviceAllowlist?: readonly string[];
};

export type ProviderRegistryConfig = {
  xai?: ProviderRuntimeConfig;
  elevenlabs?: ProviderRuntimeConfig;
  minimax?: ProviderRuntimeConfig;
  homeAssistant?: HomeAssistantRuntimeConfig;
};

export type ProviderDependencies = { fetch: ProviderFetch };

export type ProviderSnapshot =
  | { id: "xai"; enabled: boolean; configured: boolean; capabilities: readonly ["search_web", "generate_image"] }
  | { id: "elevenlabs"; enabled: boolean; configured: boolean; capabilities: readonly ["voice_design", "voice_save", "stt", "tts"] }
  | { id: "minimax"; enabled: boolean; configured: boolean; capabilities: readonly ["tts", "voice_design", "voice_clone", "voice_list", "voice_delete"] }
  | { id: "home_assistant"; enabled: boolean; configured: boolean; capabilities: readonly ["call_service"]; entityCount: number; serviceCount: number };

export type ProviderHealth = {
  id: ProviderId;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  capabilities: readonly string[];
  reason?: "disabled" | "missing_credentials" | "empty_entity_allowlist" | "empty_service_allowlist";
};

export type XaiSearchRequest = {
  provider: "xai";
  operation: "search_web";
  input: { query: string; model?: string; allowedDomains?: string[]; excludedDomains?: string[] };
};

export type XaiImageRequest = {
  provider: "xai";
  operation: "generate_image";
  input: { prompt: string; model?: string; aspectRatio?: string; resolution?: string; referenceImages?: string[] };
};

export type ElevenLabsVoiceDesignRequest = {
  provider: "elevenlabs";
  operation: "voice_design";
  input: {
    voiceDescription: string;
    text?: string;
    modelId?: "eleven_multilingual_ttv_v2" | "eleven_ttv_v3";
    loudness?: number;
    seed?: number;
    guidanceScale?: number;
    quality?: number;
  };
};

export type ElevenLabsVoiceSaveRequest = {
  provider: "elevenlabs";
  operation: "voice_save";
  input: { voiceName: string; voiceDescription: string; generatedVoiceId: string; labels?: Record<string, string> };
};

export type ElevenLabsSttRequest = {
  provider: "elevenlabs";
  operation: "stt";
  input: { audio: Uint8Array; contentType: string; fileName?: string; languageCode?: string };
};

export type ElevenLabsTtsRequest = {
  provider: "elevenlabs";
  operation: "tts";
  input: { voiceId: string; text: string; modelId?: string; outputFormat?: string; voiceSettings?: { stability?: number; similarityBoost?: number; style?: number; speed?: number } };
};

export type MiniMaxSpeechModel =
  | "speech-2.8-hd"
  | "speech-2.8-turbo"
  | "speech-2.6-hd"
  | "speech-2.6-turbo"
  | "speech-02-hd"
  | "speech-02-turbo"
  | "speech-01-hd"
  | "speech-01-turbo";

export type MiniMaxTtsRequest = {
  provider: "minimax";
  operation: "tts";
  input: {
    voiceId: string;
    text: string;
    model?: MiniMaxSpeechModel;
    languageBoost?: string;
    voiceSettings?: { speed?: number; volume?: number; pitch?: number; emotion?: string };
    audioSettings?: { format?: "opus" | "mp3"; sampleRate?: 32000 | 44100; channel?: 1 | 2; bitrate?: 32000 | 64000 | 128000 | 256000 };
  };
};

export type MiniMaxCloneUploadRequest = {
  provider: "minimax";
  operation: "clone_audio_upload" | "prompt_audio_upload";
  input: { audio: Uint8Array; contentType: "audio/mpeg" | "audio/mp4" | "audio/wav"; fileName?: string };
};

export type MiniMaxVoiceCloneRequest = {
  provider: "minimax";
  operation: "voice_clone";
  input: {
    fileId: string;
    voiceId: string;
    textValidation: string;
    accuracy?: number;
    prompt?: { fileId: string; text: string };
    previewText?: string;
    model?: MiniMaxSpeechModel;
    languageBoost?: string;
    noiseReduction?: boolean;
    volumeNormalization?: boolean;
    aigcWatermark?: boolean;
  };
};

export type MiniMaxVoiceDesignRequest = {
  provider: "minimax";
  operation: "voice_design";
  input: { prompt: string; previewText: string; voiceId?: string };
};

export type MiniMaxVoiceListRequest = {
  provider: "minimax";
  operation: "voice_list";
  input: { type: "system" | "voice_cloning" | "voice_generation" | "all" };
};

export type MiniMaxVoiceDeleteRequest = {
  provider: "minimax";
  operation: "voice_delete";
  input: { type: "voice_cloning" | "voice_generation"; voiceId: string };
};

export type HomeAssistantRequest = {
  provider: "home_assistant";
  operation: "call_service";
  input: { entityId: string; domain: string; service: string; data?: Record<string, unknown> };
};

export type HomeAssistantResult = { accepted: true; entityId: string; domain: string; service: string; stateCount: number };

export type ProviderRequest =
  | XaiSearchRequest
  | XaiImageRequest
  | ElevenLabsVoiceDesignRequest
  | ElevenLabsVoiceSaveRequest
  | ElevenLabsSttRequest
  | ElevenLabsTtsRequest
  | MiniMaxTtsRequest
  | MiniMaxCloneUploadRequest
  | MiniMaxVoiceCloneRequest
  | MiniMaxVoiceDesignRequest
  | MiniMaxVoiceListRequest
  | MiniMaxVoiceDeleteRequest
  | HomeAssistantRequest;

export type XaiSearchResult = {
  answer: string;
  sources: Array<{ title: string; url: string; publishedAt?: string }>;
  provider: { id: "xai"; responseId?: string; model: string };
};

export type XaiImageResult = {
  images: Array<{ url: string; revisedPrompt?: string }>;
  url: string;
  revisedPrompt?: string;
  provider: { id: "xai"; model: string };
};

export type VoiceDesignResult = {
  previews: Array<{ generatedVoiceId: string; audioBase64: string; audio: Uint8Array; mediaType: string; durationSeconds?: number; language?: string }>;
  text: string;
};

export type VoiceSaveResult = { voiceId: string };
export type TranscriptResult = { text: string; languageCode?: string; languageProbability?: number };
export type SpeechResult = { audio: Uint8Array; contentType: string; mediaType: string };
export type MiniMaxUsage = { usageCharacters: number; traceId?: string };
export type MiniMaxSpeechResult = SpeechResult & MiniMaxUsage & { provider: { id: "minimax"; model: MiniMaxSpeechModel } };
export type MiniMaxUploadResult = { fileId: string };
export type MiniMaxClonedVoiceResult = { voiceId: string; demoAudioUrl?: string; usageCharacters?: number; traceId?: string };
export type MiniMaxDesignedVoiceResult = { voiceId: string; trialAudio: Uint8Array; contentType: "audio/mpeg" };
export type MiniMaxVoiceProjection = { voiceId: string; kind: "system" | "voice_cloning" | "voice_generation"; name?: string; description: string[]; createdAt?: string };
export type MiniMaxVoiceListResult = { voices: MiniMaxVoiceProjection[] };
export type MiniMaxVoiceDeleteResult = { deleted: true; voiceId: string };

export type ProviderResult<R extends ProviderRequest> =
  R extends XaiSearchRequest ? XaiSearchResult :
  R extends XaiImageRequest ? XaiImageResult :
  R extends ElevenLabsVoiceDesignRequest ? VoiceDesignResult :
  R extends ElevenLabsVoiceSaveRequest ? VoiceSaveResult :
  R extends ElevenLabsSttRequest ? TranscriptResult :
  R extends ElevenLabsTtsRequest ? SpeechResult :
  R extends MiniMaxTtsRequest ? MiniMaxSpeechResult :
  R extends MiniMaxCloneUploadRequest ? MiniMaxUploadResult :
  R extends MiniMaxVoiceCloneRequest ? MiniMaxClonedVoiceResult :
  R extends MiniMaxVoiceDesignRequest ? MiniMaxDesignedVoiceResult :
  R extends MiniMaxVoiceListRequest ? MiniMaxVoiceListResult :
  R extends MiniMaxVoiceDeleteRequest ? MiniMaxVoiceDeleteResult :
  R extends HomeAssistantRequest ? HomeAssistantResult : never;

export class ProviderError extends Error {
  readonly provider: ProviderId | "registry";
  readonly code: string;
  readonly status?: number;
  readonly upstreamCode?: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly remoteOutcome: "definitive" | "unknown";

  constructor(
    provider: ProviderId | "registry",
    code: string,
    status?: number,
    diagnostics: { upstreamCode?: string; requestId?: string; retryable?: boolean; remoteOutcome?: "definitive" | "unknown" } = {},
  ) {
    const upstreamCode = safeDiagnosticToken(diagnostics.upstreamCode);
    const requestId = safeRequestId(diagnostics.requestId);
    super([provider, code, upstreamCode ?? (status ? `http_${status}` : null), requestId ? `request_${requestId}` : null].filter(Boolean).join(":"));
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.status = status;
    this.upstreamCode = upstreamCode;
    this.requestId = requestId;
    this.retryable = diagnostics.retryable === true;
    this.remoteOutcome = diagnostics.remoteOutcome ?? "definitive";
  }
}

function safeDiagnosticToken(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized && normalized.length <= 80 ? normalized : undefined;
}

function safeRequestId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9._-]{1,128}$/.test(normalized) ? normalized : undefined;
}
