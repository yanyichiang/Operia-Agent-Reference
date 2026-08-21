import { hashToolSchema, sha256Hex } from "./toolCatalog";
import { assertJsonValue, canonicalJson } from "../utils/json";
import type { RiskLevel, ToolSchema } from "./types";

export const SITE_ADAPTER_REGISTRY_VERSION = 1 as const;
export const SITE_ADAPTER_MAX_PAGES = 20;
export const SITE_ADAPTER_MAX_STEPS = 30;
export const SITE_ADAPTER_MAX_RESULT_BYTES = 24 * 1024;
export const SITE_ADAPTER_MAX_MEDIA_BYTES = 10 * 1024 * 1024;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const KNOWN_RISKS = new Set<RiskLevel>(["read", "write", "device", "message", "purchase", "delete"]);
const SMOKE_STATUSES = new Set<SiteAdapterSmokeStatus>(["unknown", "passing", "failing", "drifted"]);
const ENTRY_KEYS = [
  "registryVersion", "key", "version", "description", "domains", "riskLevel", "inputSchema", "outputSchema",
  "schemaHash", "source", "sourceHash", "requiresLogin", "budgets", "smoke", "enabled",
];
const SOURCE_KEYS = ["mode", "contractVersion", "selectors", "endpointPaths", "responseSchema"];

export type SiteAdapterSmokeStatus = "unknown" | "passing" | "failing" | "drifted";

export type SiteAdapterBudgets = {
  maxPages: number;
  maxSteps: number;
  maxResultBytes: number;
  maxMediaBytes: number;
};

export type SiteAdapterSourceContract = {
  mode: "browser" | "api";
  contractVersion: string;
  selectors?: Record<string, string>;
  endpointPaths?: string[];
  responseSchema?: ToolSchema;
};

export type SiteAdapterSmoke = {
  fixtureId: string;
  status: SiteAdapterSmokeStatus;
  checkedAt: string;
};

export type SiteAdapterEntryInput = {
  key: string;
  version: string;
  description: string;
  domains: ReadonlyArray<string>;
  riskLevel: RiskLevel;
  inputSchema: ToolSchema;
  outputSchema: ToolSchema;
  source: SiteAdapterSourceContract;
  requiresLogin: boolean;
  budgets: SiteAdapterBudgets;
  smoke: SiteAdapterSmoke;
  enabled: boolean;
};

export type SiteAdapterEntry = SiteAdapterEntryInput & {
  registryVersion: typeof SITE_ADAPTER_REGISTRY_VERSION;
  domains: string[];
  schemaHash: string;
  sourceHash: string;
  source: SiteAdapterSourceContract;
  budgets: SiteAdapterBudgets;
  smoke: SiteAdapterSmoke;
};

export type SiteAdapterObservation = {
  version: string;
  schemaHash: string;
  sourceHash: string;
  smokeStatus: SiteAdapterSmokeStatus;
};

export type SiteAdapterExecutionDecision =
  | { ok: true; code: "allowed"; adapter: SiteAdapterEntry; url: URL }
  | {
      ok: false;
      code:
        | "unknown_adapter"
        | "domain_not_allowed"
        | "version_drift"
        | "schema_drift"
        | "source_drift"
        | "smoke_failed";
      fallback: "read_only_exploration" | "none";
    };

export async function createSiteAdapterEntry(input: SiteAdapterEntryInput): Promise<SiteAdapterEntry> {
  const key = normalizeRequiredString(input.key, "adapter_key_invalid");
  if (!KEY_PATTERN.test(key)) throw new Error("adapter_key_invalid");
  const version = normalizeRequiredString(input.version, "adapter_version_invalid");
  if (!VERSION_PATTERN.test(version)) throw new Error("adapter_version_invalid");
  const description = normalizeRequiredString(input.description, "adapter_description_invalid");
  if (!KNOWN_RISKS.has(input.riskLevel)) throw new Error("adapter_risk_invalid");
  if (!isToolSchema(input.inputSchema) || !isToolSchema(input.outputSchema)) throw new Error("adapter_schema_invalid");
  if (typeof input.requiresLogin !== "boolean" || typeof input.enabled !== "boolean") throw new Error("adapter_shape_invalid");

  const domains = normalizeDomains(input.domains);
  const source = normalizeSourceContract(input.source);
  const budgets = normalizeBudgets(input.budgets);
  const smoke = normalizeSmoke(input.smoke);
  const schemaHash = await hashAdapterSchemas(input.inputSchema, input.outputSchema);
  const sourceHash = await hashSiteAdapterSource(source);

  return {
    registryVersion: SITE_ADAPTER_REGISTRY_VERSION,
    key,
    version,
    description,
    domains,
    riskLevel: input.riskLevel,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    schemaHash,
    source,
    sourceHash,
    requiresLogin: input.requiresLogin,
    budgets,
    smoke,
    enabled: input.enabled,
  };
}

export function parseSiteAdapterRegistry(value: unknown): SiteAdapterEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isCompleteSiteAdapterEntry);
}

export function siteAdapterRegistryNeedsRefresh(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  return value.some((entry) => !isCompleteSiteAdapterEntry(entry));
}

export async function evaluateSiteAdapterExecution(input: {
  registry: ReadonlyArray<unknown>;
  key: string;
  url: string;
  observed: SiteAdapterObservation;
}): Promise<SiteAdapterExecutionDecision> {
  const adapter = parseSiteAdapterRegistry(input.registry).find((entry) => entry.key === input.key && entry.enabled);
  if (!adapter) return deny("unknown_adapter", "none");

  const url = parseAllowedAdapterUrl(input.url, adapter.domains);
  if (!url) return deny("domain_not_allowed", "none");

  const storedSchemaHash = await hashAdapterSchemas(adapter.inputSchema, adapter.outputSchema);
  if (adapter.schemaHash !== storedSchemaHash) return deny("schema_drift");
  const storedSourceHash = await hashSiteAdapterSource(adapter.source);
  if (adapter.sourceHash !== storedSourceHash) return deny("source_drift");

  if (input.observed.version !== adapter.version) return deny("version_drift");
  if (input.observed.schemaHash !== adapter.schemaHash) return deny("schema_drift");
  if (input.observed.sourceHash !== adapter.sourceHash) return deny("source_drift");
  if (adapter.smoke.status !== "passing" || input.observed.smokeStatus !== "passing") return deny("smoke_failed");

  return { ok: true, code: "allowed", adapter, url };
}

export async function hashSiteAdapterSource(source: SiteAdapterSourceContract): Promise<string> {
  return sha256Hex(canonicalJson(assertJsonValue(source)));
}

function deny(
  code: Exclude<SiteAdapterExecutionDecision, { ok: true }>["code"],
  fallback: "read_only_exploration" | "none" = "read_only_exploration",
): SiteAdapterExecutionDecision {
  return { ok: false, code, fallback };
}

async function hashAdapterSchemas(inputSchema: ToolSchema, outputSchema: ToolSchema): Promise<string> {
  const inputHash = await hashToolSchema(inputSchema);
  const outputHash = await hashToolSchema(outputSchema);
  if (!inputHash || !outputHash) throw new Error("adapter_schema_invalid");
  return sha256Hex(canonicalJson(assertJsonValue({ inputHash, outputHash })));
}

function normalizeDomains(value: ReadonlyArray<string>): string[] {
  if (!Array.isArray(value)) throw new Error("adapter_domain_invalid");
  const domains = [...new Set(value.map(normalizeDomain))];
  if (domains.length === 0) throw new Error("adapter_domain_invalid");
  return domains;
}

function normalizeDomain(value: string): string {
  if (typeof value !== "string") throw new Error("adapter_domain_invalid");
  const candidate = value.trim().toLowerCase();
  if (!candidate || candidate.includes("*") || candidate.includes(":") || candidate.includes("/") || candidate.endsWith(".")) {
    throw new Error("adapter_domain_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${candidate}`);
  } catch {
    throw new Error("adapter_domain_invalid");
  }
  if (parsed.hostname !== candidate || isForbiddenHostname(parsed.hostname)) throw new Error("adapter_domain_invalid");
  return parsed.hostname;
}

function parseAllowedAdapterUrl(value: string, domains: ReadonlyArray<string>): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || isForbiddenHostname(url.hostname)) return null;
  if (!domains.includes(url.hostname.toLowerCase())) return null;
  url.hash = "";
  return url;
}

function isForbiddenHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (
    value === "localhost" || value === "metadata.google.internal" || value.endsWith(".localhost") ||
    value.endsWith(".local") || value.endsWith(".internal") || value.endsWith(".lan") || !value.includes(".")
  ) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return true;
  if (value.includes(":")) return true;
  return false;
}

function normalizeSourceContract(value: SiteAdapterSourceContract): SiteAdapterSourceContract {
  if (!isRecord(value) || (value.mode !== "browser" && value.mode !== "api")) throw new Error("adapter_source_invalid");
  if (!hasOnlyKeys(value, SOURCE_KEYS)) throw new Error("adapter_source_invalid");
  const contractVersion = normalizeRequiredString(value.contractVersion, "adapter_source_invalid");
  const source: SiteAdapterSourceContract = { mode: value.mode, contractVersion };

  if (value.selectors !== undefined) {
    if (!isRecord(value.selectors)) throw new Error("adapter_source_invalid");
    const selectors = Object.fromEntries(Object.entries(value.selectors).map(([name, selector]) => {
      if (!name.trim() || typeof selector !== "string" || !selector.trim()) throw new Error("adapter_source_invalid");
      return [name.trim(), selector.trim()];
    }));
    if (Object.keys(selectors).length === 0) throw new Error("adapter_source_invalid");
    source.selectors = selectors;
  }

  if (value.endpointPaths !== undefined) {
    if (!Array.isArray(value.endpointPaths) || value.endpointPaths.length === 0) throw new Error("adapter_source_invalid");
    source.endpointPaths = [...new Set(value.endpointPaths.map((path) => {
      if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
        throw new Error("adapter_source_invalid");
      }
      return path;
    }))];
  }

  if (value.responseSchema !== undefined) {
    if (!isToolSchema(value.responseSchema)) throw new Error("adapter_source_invalid");
    source.responseSchema = value.responseSchema;
  }
  if (source.mode === "browser" && !source.selectors) throw new Error("adapter_source_invalid");
  if (source.mode === "api" && !source.endpointPaths) throw new Error("adapter_source_invalid");
  return source;
}

function normalizeBudgets(value: SiteAdapterBudgets): SiteAdapterBudgets {
  if (!isRecord(value)) throw new Error("adapter_budget_invalid");
  const budgets = {
    maxPages: value.maxPages,
    maxSteps: value.maxSteps,
    maxResultBytes: value.maxResultBytes,
    maxMediaBytes: value.maxMediaBytes,
  };
  if (
    !isBoundedInteger(budgets.maxPages, 1, SITE_ADAPTER_MAX_PAGES) ||
    !isBoundedInteger(budgets.maxSteps, 1, SITE_ADAPTER_MAX_STEPS) ||
    !isBoundedInteger(budgets.maxResultBytes, 256, SITE_ADAPTER_MAX_RESULT_BYTES) ||
    !isBoundedInteger(budgets.maxMediaBytes, 0, SITE_ADAPTER_MAX_MEDIA_BYTES)
  ) {
    throw new Error("adapter_budget_invalid");
  }
  return budgets;
}

function normalizeSmoke(value: SiteAdapterSmoke): SiteAdapterSmoke {
  if (!isRecord(value)) throw new Error("adapter_smoke_invalid");
  const fixtureId = normalizeRequiredString(value.fixtureId, "adapter_smoke_invalid");
  if (!SMOKE_STATUSES.has(value.status)) throw new Error("adapter_smoke_invalid");
  const checkedAt = normalizeRequiredString(value.checkedAt, "adapter_smoke_invalid");
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error("adapter_smoke_invalid");
  return { fixtureId, status: value.status, checkedAt };
}

function isCompleteSiteAdapterEntry(value: unknown): value is SiteAdapterEntry {
  if (!isRecord(value) || !hasOnlyKeys(value, ENTRY_KEYS)) return false;
  return (
    value.registryVersion === SITE_ADAPTER_REGISTRY_VERSION &&
    typeof value.key === "string" && KEY_PATTERN.test(value.key) &&
    typeof value.version === "string" && VERSION_PATTERN.test(value.version) &&
    typeof value.description === "string" && value.description.length > 0 &&
    Array.isArray(value.domains) && value.domains.length > 0 && new Set(value.domains).size === value.domains.length &&
    value.domains.every(isNormalizedDomain) &&
    typeof value.riskLevel === "string" && KNOWN_RISKS.has(value.riskLevel as RiskLevel) &&
    isToolSchema(value.inputSchema) && isToolSchema(value.outputSchema) &&
    typeof value.schemaHash === "string" && HASH_PATTERN.test(value.schemaHash) &&
    isCompleteSourceContract(value.source) && typeof value.sourceHash === "string" && HASH_PATTERN.test(value.sourceHash) &&
    typeof value.requiresLogin === "boolean" && isCompleteBudgets(value.budgets) && isCompleteSmoke(value.smoke) &&
    typeof value.enabled === "boolean"
  );
}

function isNormalizedDomain(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeDomain(value) === value;
  } catch {
    return false;
  }
}

function isCompleteSourceContract(value: unknown): value is SiteAdapterSourceContract {
  if (!isRecord(value) || !hasOnlyKeys(value, SOURCE_KEYS)) return false;
  try {
    normalizeSourceContract(value as SiteAdapterSourceContract);
    return true;
  } catch {
    return false;
  }
}

function isCompleteBudgets(value: unknown): value is SiteAdapterBudgets {
  return isRecord(value) && hasOnlyKeys(value, ["maxPages", "maxSteps", "maxResultBytes", "maxMediaBytes"]) &&
    isBoundedInteger(value.maxPages, 1, SITE_ADAPTER_MAX_PAGES) &&
    isBoundedInteger(value.maxSteps, 1, SITE_ADAPTER_MAX_STEPS) &&
    isBoundedInteger(value.maxResultBytes, 256, SITE_ADAPTER_MAX_RESULT_BYTES) &&
    isBoundedInteger(value.maxMediaBytes, 0, SITE_ADAPTER_MAX_MEDIA_BYTES);
}

function isCompleteSmoke(value: unknown): value is SiteAdapterSmoke {
  return isRecord(value) && hasOnlyKeys(value, ["fixtureId", "status", "checkedAt"]) &&
    typeof value.fixtureId === "string" && Boolean(value.fixtureId) && SMOKE_STATUSES.has(value.status) &&
    typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function normalizeRequiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isToolSchema(value: unknown): value is ToolSchema {
  return typeof value === "boolean" || isRecord(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
