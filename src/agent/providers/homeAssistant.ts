import { fetchJson } from "./http";
import { ProviderError, type HomeAssistantRequest, type HomeAssistantResult, type HomeAssistantRuntimeConfig, type ProviderFetch, type ProviderHealth } from "./types";

export class HomeAssistantProvider {
  private readonly config: HomeAssistantRuntimeConfig;
  private readonly fetchImpl: ProviderFetch;
  private readonly entities: ReadonlySet<string>;
  private readonly services: ReadonlySet<string>;

  constructor(config: HomeAssistantRuntimeConfig = {}, fetchImpl: ProviderFetch = async () => { throw new ProviderError("home_assistant", "disabled"); }) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.entities = new Set((config.entityAllowlist ?? []).map((value) => value.trim()).filter(Boolean));
    this.services = new Set((config.serviceAllowlist ?? []).map((value) => value.trim()).filter(Boolean));
  }

  health(): ProviderHealth {
    const snapshot = this.snapshot();
    const available = snapshot.enabled && snapshot.configured && snapshot.entityCount > 0 && snapshot.serviceCount > 0;
    return { ...snapshot, available, ...(!snapshot.enabled ? { reason: "disabled" as const } : !snapshot.configured ? { reason: "missing_credentials" as const } : snapshot.entityCount === 0 ? { reason: "empty_entity_allowlist" as const } : snapshot.serviceCount === 0 ? { reason: "empty_service_allowlist" as const } : {}) };
  }

  snapshot() {
    return {
      id: "home_assistant" as const,
      enabled: this.config.enabled === true,
      configured: Boolean(this.config.baseUrl?.trim() && this.config.accessToken?.trim()),
      capabilities: ["call_service"] as const,
      entityCount: this.entities.size,
      serviceCount: this.services.size,
    };
  }

  async callService(input: HomeAssistantRequest["input"]): Promise<HomeAssistantResult> {
    if (this.config.enabled !== true) throw new ProviderError("home_assistant", "disabled");
    if (!this.config.baseUrl?.trim() || !this.config.accessToken?.trim()) throw new ProviderError("home_assistant", "not_configured");
    if (!this.entities.has(input.entityId)) throw new ProviderError("home_assistant", "entity_not_allowlisted");
    if (!/^[a-z0-9_]+$/.test(input.domain) || !/^[a-z0-9_]+$/.test(input.service)) throw new ProviderError("home_assistant", "invalid_service");
    if (!input.entityId.startsWith(`${input.domain}.`)) throw new ProviderError("home_assistant", "domain_entity_mismatch");
    if (!this.services.has(`${input.domain}.${input.service}`)) throw new ProviderError("home_assistant", "service_not_allowlisted");
    const data = safeData(input.data);
    const value = await fetchJson({ provider: "home_assistant", fetch: this.fetchImpl, timeoutMs: this.config.timeoutMs, maxResponseBytes: 256 * 1024, signal: this.config.signal }, `${baseUrl(this.config.baseUrl)}/api/services/${input.domain}/${input.service}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...data, entity_id: input.entityId }),
    });
    return { accepted: true, entityId: input.entityId, domain: input.domain, service: input.service, stateCount: Array.isArray(value) ? value.length : 0 };
  }


  async execute(_entityId: string, _action: string): Promise<never> {
    throw new ProviderError("home_assistant", "disabled");
  }
}

function safeData(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new ProviderError("home_assistant", "invalid_data");
  const serialized = JSON.stringify(value);
  if (serialized.length > 8_000 || Object.keys(value).length > 32) throw new ProviderError("home_assistant", "invalid_data");
  if (["entity_id", "device_id", "area_id", "target"].some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new ProviderError("home_assistant", "target_override_forbidden");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function baseUrl(value?: string): string {
  const clean = value?.trim().replace(/\/+$/, "") ?? "";
  try {
    const url = new URL(clean);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new ProviderError("home_assistant", "invalid_base_url");
  }
}
