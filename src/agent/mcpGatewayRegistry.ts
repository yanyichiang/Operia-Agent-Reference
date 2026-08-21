import { sha256Hex } from "./toolCatalog";
import { assertJsonValue as assertCanonicalJsonValue, canonicalJson } from "../utils/json";

const PROVIDER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FORBIDDEN_KEYS = /(?:authorization|bearer|cookie|ciphertext|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password)/i;
const RISK_LEVELS = new Set(["low", "medium", "high"]);
const BILLING_CLASSES = new Set(["none", "metered", "unknown"]);

export type McpGatewayBillingClass = "none" | "metered" | "unknown";

export type McpGatewayOwnerTool = {
  name: string;
  description: string;
  enabled: boolean;
  defaultEnabled: boolean;
  ownerRevision: number;
  category?: string;
  risk?: string;
  mayCost: boolean;
  billingClass: McpGatewayBillingClass;
  requiresConfirmation: boolean;
  executable: false;
};

export type McpGatewayOwnerProvider = {
  id: string;
  label: string;
  status: "enabled" | "pending" | "disabled";
  route: string;
  kind: "built-in" | "custom";
  sourceType: "builtin" | "github" | "remote" | "cloudflare-worker" | "vps-runner";
  risk: string;
  ownerRevision: number;
  tools: McpGatewayOwnerTool[];
  readOnlyHealthProbe?: {
    toolName: string;
    args: Record<string, JsonValue>;
  };
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type McpGatewayOwnerSnapshot = {
  owner: "mcp.example.com";
  ownerVersion: string;
  revision: number;
  cutoverState: "registry_only" | "executor_ready";
  executionTransport?: {
    type: "service_binding";
    routeTemplate: "/service/executor/{providerId}/mcp";
    methods: ["tools/list", "tools/call"];
  };
  updatedAt: string;
  providers: McpGatewayOwnerProvider[];
};

export function parseMcpGatewayOwnerSnapshot(value: unknown): McpGatewayOwnerSnapshot {
  assertNoSecretBearingKeys(value);
  const root = record(value, "mcp_gateway_snapshot_invalid");
  if (root.owner !== "mcp.example.com" || (root.cutoverState !== "registry_only" && root.cutoverState !== "executor_ready")) {
    throw new Error("mcp_gateway_owner_contract_invalid");
  }
  let executionTransport: McpGatewayOwnerSnapshot["executionTransport"];
  if (root.cutoverState === "executor_ready") {
    const transport = record(root.executionTransport, "mcp_gateway_execution_transport_invalid");
    if (
      transport.type !== "service_binding"
      || transport.routeTemplate !== "/service/executor/{providerId}/mcp"
      || !Array.isArray(transport.methods)
      || transport.methods.length !== 2
      || transport.methods[0] !== "tools/list"
      || transport.methods[1] !== "tools/call"
    ) throw new Error("mcp_gateway_execution_transport_invalid");
    executionTransport = {
      type: "service_binding",
      routeTemplate: "/service/executor/{providerId}/mcp",
      methods: ["tools/list", "tools/call"],
    };
  }
  const ownerVersion = requiredString(root.ownerVersion, "mcp_gateway_owner_version_invalid", 128);
  const revision = Number(root.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("mcp_gateway_revision_invalid");
  const updatedAt = requiredIsoDate(root.updatedAt);
  if (!Array.isArray(root.providers)) throw new Error("mcp_gateway_providers_invalid");
  const seenProviders = new Set<string>();
  const providers = root.providers.map((entry) => parseProvider(entry, seenProviders));
  if (providers.some((provider) => provider.ownerRevision > revision || provider.tools.some((tool) => tool.ownerRevision > revision))) {
    throw new Error("mcp_gateway_revision_ahead_of_owner");
  }
  return {
    owner: "mcp.example.com", ownerVersion, revision,
    cutoverState: root.cutoverState,
    ...(executionTransport ? { executionTransport } : {}),
    updatedAt, providers,
  };
}

export async function hashMcpGatewayOwnerSnapshot(snapshot: McpGatewayOwnerSnapshot): Promise<string> {
  return await sha256Hex(canonicalJson(assertCanonicalJsonValue(snapshot)));
}

function parseProvider(value: unknown, seen: Set<string>): McpGatewayOwnerProvider {
  const input = record(value, "mcp_gateway_provider_invalid");
  const id = identifier(input.id, "mcp_gateway_provider_id_invalid", PROVIDER_IDENTIFIER);
  if (seen.has(id)) throw new Error("mcp_gateway_provider_duplicate");
  seen.add(id);
  const kind = input.kind === "built-in" || input.kind === "custom" ? input.kind : null;
  const status = input.status === "enabled" || input.status === "pending" || input.status === "disabled" ? input.status : null;
  const sourceType = ["builtin", "github", "remote", "cloudflare-worker", "vps-runner"].includes(String(input.sourceType))
    ? input.sourceType as McpGatewayOwnerProvider["sourceType"] : null;
  if (!kind || !status || !sourceType) throw new Error("mcp_gateway_provider_invalid");
  const ownerRevision = revision(input.ownerRevision, "mcp_gateway_provider_revision_invalid");
  const providerRisk = risk(input.risk);
  if (!Array.isArray(input.tools)) throw new Error("mcp_gateway_tools_invalid");
  const seenTools = new Set<string>();
  const tools = input.tools.map((entry) => parseTool(entry, seenTools));
  const readOnlyHealthProbe = input.readOnlyHealthProbe === undefined
    ? undefined
    : parseReadOnlyHealthProbe(input.readOnlyHealthProbe, tools, providerRisk);
  return {
    id,
    label: requiredString(input.label, "mcp_gateway_provider_name_invalid", 200),
    status,
    route: requiredString(input.route, "mcp_gateway_provider_route_invalid", 200),
    kind,
    sourceType,
    risk: providerRisk,
    ownerRevision,
    tools,
    ...(readOnlyHealthProbe ? { readOnlyHealthProbe } : {}),
  };
}

function parseReadOnlyHealthProbe(
  value: unknown,
  tools: McpGatewayOwnerTool[],
  providerRisk: string,
): NonNullable<McpGatewayOwnerProvider["readOnlyHealthProbe"]> {
  const input = record(value, "mcp_gateway_health_probe_invalid");
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "toolName" && key !== "args")) throw new Error("mcp_gateway_health_probe_invalid");
  const toolName = identifier(input.toolName, "mcp_gateway_health_probe_tool_invalid", TOOL_IDENTIFIER);
  const args = record(input.args, "mcp_gateway_health_probe_args_invalid");
  assertJsonValue(args, 0);
  if (JSON.stringify(args).length > 8_000) throw new Error("mcp_gateway_health_probe_args_invalid");
  const tool = tools.find((entry) => entry.name === toolName);
  const toolRisk = tool?.risk ?? providerRisk;
  if (!tool || !tool.enabled || providerRisk !== "low" || toolRisk !== "low"
    || tool.mayCost || tool.billingClass !== "none" || tool.requiresConfirmation) {
    throw new Error("mcp_gateway_health_probe_not_read_only");
  }
  return { toolName, args: args as Record<string, JsonValue> };
}

function parseTool(value: unknown, seen: Set<string>): McpGatewayOwnerTool {
  const input = record(value, "mcp_gateway_tool_invalid");
  const name = identifier(input.name, "mcp_gateway_tool_name_invalid", TOOL_IDENTIFIER);
  if (seen.has(name)) throw new Error("mcp_gateway_tool_duplicate");
  seen.add(name);
  if (typeof input.enabled !== "boolean" || typeof input.defaultEnabled !== "boolean") throw new Error("mcp_gateway_tool_invalid");
  const ownerRevision = revision(input.ownerRevision, "mcp_gateway_tool_revision_invalid");
  if (input.risk !== undefined) risk(input.risk);
  if (input.requiresConfirmation !== undefined && typeof input.requiresConfirmation !== "boolean") throw new Error("mcp_gateway_tool_invalid");
  if (input.mayCost !== undefined && typeof input.mayCost !== "boolean") throw new Error("mcp_gateway_tool_billing_invalid");
  if (input.billingClass !== undefined && (typeof input.billingClass !== "string" || !BILLING_CLASSES.has(input.billingClass))) {
    throw new Error("mcp_gateway_tool_billing_invalid");
  }
  const billingClass: McpGatewayBillingClass = typeof input.billingClass === "string"
    ? input.billingClass as McpGatewayBillingClass
    : input.mayCost === false ? "none" : input.mayCost === true ? "metered" : "unknown";
  const mayCost = billingClass !== "none";
  if (input.mayCost !== undefined && input.mayCost !== mayCost) throw new Error("mcp_gateway_tool_billing_invalid");
  return {
    name,
    description: typeof input.description === "string" ? input.description.slice(0, 2_000) : "",
    enabled: input.enabled,
    defaultEnabled: input.defaultEnabled,
    ownerRevision,
    ...(typeof input.category === "string" ? { category: input.category.slice(0, 120) } : {}),
    ...(typeof input.risk === "string" ? { risk: input.risk } : {}),
    mayCost,
    billingClass,
    // Missing legacy billing fields are unknown/paid and therefore fail closed.
    requiresConfirmation: mayCost || input.requiresConfirmation === true,
    executable: false,
  };
}

function assertNoSecretBearingKeys(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error("mcp_gateway_snapshot_too_deep");
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretBearingKeys(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error("mcp_gateway_snapshot_secret_forbidden");
    assertNoSecretBearingKeys(nested, depth + 1);
  }
}

function assertJsonValue(value: unknown, depth: number): asserts value is JsonValue {
  if (depth > 8) throw new Error("mcp_gateway_health_probe_args_invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("mcp_gateway_health_probe_args_invalid");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") throw new Error("mcp_gateway_health_probe_args_invalid");
  for (const nested of Object.values(value as Record<string, unknown>)) assertJsonValue(nested, depth + 1);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, code: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(code);
  return value.trim();
}

function identifier(value: unknown, code: string, pattern: RegExp): string {
  const normalized = requiredString(value, code, 128);
  if (!pattern.test(normalized)) throw new Error(code);
  return normalized;
}

function risk(value: unknown): string {
  if (typeof value !== "string" || !RISK_LEVELS.has(value)) throw new Error("mcp_gateway_risk_invalid");
  return value;
}

function revision(value: unknown, code: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new Error(code);
  return normalized;
}

function requiredIsoDate(value: unknown): string {
  const normalized = requiredString(value, "mcp_gateway_updated_at_invalid", 64);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error("mcp_gateway_updated_at_invalid");
  return normalized;
}
