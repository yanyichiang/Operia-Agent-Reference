import { ElevenLabsProvider } from "./elevenlabs";
import { HomeAssistantProvider } from "./homeAssistant";
import { MiniMaxVoiceProvider } from "./minimax";
import { ProviderError, type ProviderDependencies, type ProviderFetch, type ProviderHealth, type ProviderId, type ProviderRegistryConfig, type ProviderRequest, type ProviderResult, type ProviderSnapshot } from "./types";
import { XaiProvider } from "./xai";

export class ProviderRegistry {
  constructor(
    private readonly xai: XaiProvider,
    private readonly elevenlabs: ElevenLabsProvider,
    private readonly minimax: MiniMaxVoiceProvider,
    private readonly homeAssistant: HomeAssistantProvider,
  ) {}

  snapshot(): ProviderSnapshot[] {
    return [this.xai.snapshot(), this.elevenlabs.snapshot(), this.minimax.snapshot(), this.homeAssistant.snapshot()];
  }

  health(): ProviderHealth[] {
    return [this.xai.health(), this.elevenlabs.health(), this.minimax.health(), this.homeAssistant.health()];
  }

  get(id: "xai"): XaiProvider;
  get(id: "elevenlabs"): ElevenLabsProvider;
  get(id: "minimax"): MiniMaxVoiceProvider;
  get(id: "home_assistant"): HomeAssistantProvider;
  get(id: ProviderId): XaiProvider | ElevenLabsProvider | MiniMaxVoiceProvider | HomeAssistantProvider {
    const provider = id === "xai" ? this.xai : id === "elevenlabs" ? this.elevenlabs : id === "minimax" ? this.minimax : this.homeAssistant;
    const health = provider.health();
    if (!health.available) throw new ProviderError(id, health.reason ?? "unavailable");
    return provider;
  }

  async invoke<R extends ProviderRequest>(request: R): Promise<ProviderResult<R>> {
    if (!request || typeof request !== "object") throw new ProviderError("registry", "invalid_provider_request");
    switch (request.provider) {
      case "xai":
        if (request.operation === "search_web") return await this.xai.searchWeb(request.input) as ProviderResult<R>;
        if (request.operation === "generate_image") return await this.xai.generateImage(request.input) as ProviderResult<R>;
        break;
      case "elevenlabs":
        if (request.operation === "voice_design") return await this.elevenlabs.designVoice(request.input) as ProviderResult<R>;
        if (request.operation === "voice_save") return await this.elevenlabs.saveVoice(request.input) as ProviderResult<R>;
        if (request.operation === "stt") return await this.elevenlabs.transcribe(request.input) as ProviderResult<R>;
        if (request.operation === "tts") return await this.elevenlabs.synthesize(request.input) as ProviderResult<R>;
        break;
      case "minimax":
        if (request.operation === "tts") return await this.minimax.synthesize(request.input) as ProviderResult<R>;
        if (request.operation === "clone_audio_upload") return await this.minimax.uploadCloneAudio(request.input) as ProviderResult<R>;
        if (request.operation === "prompt_audio_upload") return await this.minimax.uploadPromptAudio(request.input) as ProviderResult<R>;
        if (request.operation === "voice_clone") return await this.minimax.cloneVoice(request.input) as ProviderResult<R>;
        if (request.operation === "voice_design") return await this.minimax.designVoice(request.input) as ProviderResult<R>;
        if (request.operation === "voice_list") return await this.minimax.listVoices(request.input) as ProviderResult<R>;
        if (request.operation === "voice_delete") return await this.minimax.deleteVoice(request.input) as ProviderResult<R>;
        break;
      case "home_assistant":
        if (request.operation === "call_service") return await this.homeAssistant.callService(request.input) as ProviderResult<R>;
        break;
      default:
        throw new ProviderError("registry", "unknown_provider");
    }
    throw new ProviderError("registry", "unknown_provider_operation");
  }
}

export function createProviderRegistry(config: ProviderRegistryConfig = {}, dependencies: ProviderDependencies | ProviderFetch): ProviderRegistry {
  const fetchImpl = typeof dependencies === "function" ? dependencies : dependencies?.fetch;
  if (typeof fetchImpl !== "function") throw new ProviderError("registry", "fetch_required");
  return new ProviderRegistry(
    new XaiProvider(config.xai ?? {}, fetchImpl),
    new ElevenLabsProvider(config.elevenlabs ?? {}, fetchImpl),
    new MiniMaxVoiceProvider(config.minimax ?? {}, fetchImpl),
    new HomeAssistantProvider(config.homeAssistant ?? {}, fetchImpl),
  );
}
