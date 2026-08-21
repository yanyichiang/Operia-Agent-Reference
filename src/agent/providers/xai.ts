import { fetchJson, requireEnabled, type ProviderHttpConfig } from "./http";
import { ProviderError, type ProviderFetch, type ProviderHealth, type ProviderRuntimeConfig, type XaiImageRequest, type XaiImageResult, type XaiSearchRequest, type XaiSearchResult } from "./types";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_SEARCH_MODEL = "grok-4.5";
const DEFAULT_IMAGE_MODEL = "grok-imagine-image-quality";

export class XaiProvider {
  private readonly config: ProviderRuntimeConfig;
  private readonly fetchImpl: ProviderFetch;

  constructor(config: ProviderRuntimeConfig, fetchImpl: ProviderFetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  snapshot() {
    return {
      id: "xai" as const,
      enabled: this.config.enabled === true,
      configured: Boolean(this.config.apiKey?.trim()),
      capabilities: ["search_web", "generate_image"] as const,
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

  async searchWeb(input: XaiSearchRequest["input"] | string, legacyModel?: string): Promise<XaiSearchResult> {
    const options = typeof input === "string" ? { query: input, model: legacyModel } : input;
    const apiKey = this.authorize();
    const model = boundedText(options.model ?? DEFAULT_SEARCH_MODEL, "invalid_model", 1, 128);
    const tool: Record<string, unknown> = { type: "web_search" };
    const allowed = domains(options.allowedDomains, "invalid_allowed_domains");
    const excluded = domains(options.excludedDomains, "invalid_excluded_domains");
    if (allowed && excluded) throw new ProviderError("xai", "conflicting_domain_filters");
    if (allowed) tool.filters = { allowed_domains: allowed };
    if (excluded) tool.filters = { excluded_domains: excluded };
    const value = await fetchJson(this.http(), `${baseUrl(this.config.baseUrl)}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: boundedText(options.query, "invalid_query", 1, 8_000), tools: [tool], store: false }),
    });
    return parseSearchResponse(value, model);
  }

  async generateImage(input: XaiImageRequest["input"] | string, legacyModel?: string): Promise<XaiImageResult> {
    const options = typeof input === "string" ? { prompt: input, model: legacyModel } : input;
    const apiKey = this.authorize();
    const model = boundedText(options.model ?? DEFAULT_IMAGE_MODEL, "invalid_model", 1, 128);
    const body: Record<string, unknown> = {
      model,
      prompt: boundedText(options.prompt, "invalid_prompt", 1, 8_000),
      response_format: "url",
    };
    if (options.aspectRatio !== undefined) body.aspect_ratio = boundedText(options.aspectRatio, "invalid_aspect_ratio", 1, 32);
    if (options.resolution !== undefined) body.resolution = boundedText(options.resolution, "invalid_resolution", 1, 32);
    body.n = 1;
    const references = referenceImages(options.referenceImages);
    if (references?.length === 1) body.image = { type: "image_url", url: references[0] };
    if (references && references.length > 1) body.images = references.map((url) => ({ type: "image_url", url }));
    const endpoint = references ? "edits" : "generations";
    const value = await fetchJson(this.http(), `${baseUrl(this.config.baseUrl)}/images/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const root = record(value);
    const images = (Array.isArray(root.data) ? root.data : []).slice(0, 4).map((raw) => {
      const item = record(raw);
      const url = safeHttpUrl(item.url);
      if (!url) throw new ProviderError("xai", "invalid_response_shape");
      return { url, ...(typeof item.revised_prompt === "string" ? { revisedPrompt: item.revised_prompt.slice(0, 4_000) } : {}) };
    });
    if (images.length === 0) throw new ProviderError("xai", "invalid_response_shape");
    return { images, url: images[0].url, ...(images[0].revisedPrompt ? { revisedPrompt: images[0].revisedPrompt } : {}), provider: { id: "xai", model } };
  }

  private authorize(): string {
    return requireEnabled("xai", this.config.enabled === true, this.config.apiKey);
  }

  private http(): ProviderHttpConfig {
    return { provider: "xai", fetch: this.fetchImpl, timeoutMs: this.config.timeoutMs, maxResponseBytes: this.config.maxResponseBytes, signal: this.config.signal };
  }
}

function referenceImages(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 3) throw new ProviderError("xai", "invalid_reference_images");
  const images = value.map((item) => item.trim());
  if (images.some((item) => item.length > 8 * 1024 * 1024 || !/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(item))) {
    throw new ProviderError("xai", "invalid_reference_images");
  }
  return images;
}

function parseSearchResponse(value: unknown, fallbackModel: string): XaiSearchResult {
  const root = record(value);
  const answerParts: string[] = typeof root.output_text === "string" ? [root.output_text] : [];
  const sources = new Map<string, { title: string; url: string; publishedAt?: string }>();
  for (const outputValue of Array.isArray(root.output) ? root.output : []) {
    const output = record(outputValue);
    if (!Array.isArray(output.content)) continue;
    for (const contentValue of output.content) {
      const content = record(contentValue);
      if (content.type === "output_text" && typeof content.text === "string") answerParts.push(content.text);
      for (const annotation of Array.isArray(content.annotations) ? content.annotations : []) addCitation(sources, annotation);
    }
  }
  for (const citation of Array.isArray(root.citations) ? root.citations : []) addCitation(sources, citation);
  const answer = answerParts.join("\n").trim().slice(0, 32_000);
  if (!answer) throw new ProviderError("xai", "invalid_response_shape");
  return {
    answer,
    sources: [...sources.values()].slice(0, 20),
    provider: {
      id: "xai",
      ...(typeof root.id === "string" ? { responseId: root.id.slice(0, 256) } : {}),
      model: typeof root.model === "string" ? root.model.slice(0, 128) : fallbackModel,
    },
  };
}

function addCitation(target: Map<string, { title: string; url: string; publishedAt?: string }>, raw: unknown): void {
  if (typeof raw === "string") {
    const url = safeHttpUrl(raw);
    if (url) target.set(url, { title: url, url });
    return;
  }
  const outer = record(raw);
  const item = outer.type === "url_citation" ? record(outer.url_citation ?? outer) : outer;
  const url = safeHttpUrl(item.url);
  if (!url) return;
  const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 500) : url;
  const date = typeof item.published_at === "string" ? item.published_at : typeof item.date === "string" ? item.date : undefined;
  target.set(url, { title, url, ...(date ? { publishedAt: date.slice(0, 64) } : {}) });
}

function domains(value: string[] | undefined, code: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 5) throw new ProviderError("xai", code);
  const result = value.map((domain) => domain.trim().toLowerCase());
  if (result.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain))) {
    throw new ProviderError("xai", code);
  }
  return [...new Set(result)];
}

function boundedText(value: string, code: string, minimum: number, maximum: number): string {
  const clean = value.trim();
  if (clean.length < minimum || clean.length > maximum) throw new ProviderError("xai", code);
  return clean;
}

function baseUrl(value?: string): string {
  return (value?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
