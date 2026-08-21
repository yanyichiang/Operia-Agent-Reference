import { assertJsonValue, canonicalJson } from "../utils/json";
import type { RiskLevel, ToolCatalogEntry, ToolCatalogEntryInput, ToolSchema } from "./types";

const DEFAULT_OUTPUT_BYTE_LIMIT = 4096;
const MIN_OUTPUT_BYTE_LIMIT = 256;
export const ABSOLUTE_OUTPUT_BYTE_LIMIT = 64 * 1024;
const KNOWN_RISKS = new Set<RiskLevel>(["read", "write", "device", "message", "purchase", "delete"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ToolReversibilityV3 = "none" | "native_undo" | "compensating" | "soft_delete";
export type ToolBillingClassV3 = "none" | "metered" | "unknown";

export type ToolDescriptorV3 = {
  toolKey: string;
  ownerDomain: string;
  providerId: string;
  name: string;
  summary: string;
  tags: string[];
  riskClass: RiskLevel;
  consequences: string[];
  sensitivity: string[];
  reversibility: ToolReversibilityV3;
  schemaHash: string;
  catalogRevision: string;
  connectorVersion: string;
  enabled: boolean;
  executable: boolean;
  mayCost: boolean;
  billingClass: ToolBillingClassV3;
  requiresConfirmation: boolean;
};

export type ToolDescriptionV3 = {
  descriptor: ToolDescriptorV3;
  inputSchema: ToolSchema;
  outputSchema: ToolSchema | null;
  outputByteLimit: number;
  ownerRevision: string;
  policyHints: string[];
  requiresFreshAuth: boolean;
  mayCost: boolean;
  billingClass: ToolBillingClassV3;
  requiresConfirmation: boolean;
  mayWrite: boolean;
  unavailableReason: "disabled" | "schema_drift" | "connector_unversioned" | null;
};

export type ToolDescriptorMetadataV3 = {
  ownerDomain?: string;
  ownerRevision?: string;
  tags?: string[];
  consequences?: string[];
  sensitivity?: string[];
  reversibility?: ToolReversibilityV3;
  outputSchema?: ToolSchema | null;
  policyHints?: string[];
  requiresFreshAuth?: boolean;
  mayCost?: boolean;
  billingClass?: ToolBillingClassV3;
  requiresConfirmation?: boolean;
};

export type ToolCatalogSnapshotV3 = {
  catalogVersion: 3;
  catalogRevision: string;
  snapshotHash: string;
  policyVersion: string;
  connectorVersions: Record<string, string>;
  descriptors: ToolDescriptorV3[];
  descriptions: Record<string, ToolDescriptionV3>;
};

export type ToolCatalogSnapshotInputV3 = {
  catalog: ReadonlyArray<ToolCatalogEntry>;
  observedCatalog: ReadonlyArray<ToolCatalogEntry>;
  catalogRevision: string;
  policyVersion: string;
  connectorVersions: Readonly<Record<string, string>>;
  metadata?: Readonly<Record<string, ToolDescriptorMetadataV3>>;
};

export type ToolSearchInputV3 = {
  query?: string;
  tags?: string[];
  riskClasses?: RiskLevel[];
  ownerDomain?: string;
  includeUnavailable?: boolean;
  limit?: number;
  expectedCatalogRevision: string;
  expectedSnapshotHash: string;
};

/** @deprecated Identity code should call canonicalJson(assertJsonValue(value)) directly. */
export function stableJsonStringify(value: unknown): string {
  return canonicalJson(assertJsonValue(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function byteLengthOf(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function catalogToolKey(serverId: string, toolName: string): string {
  return `${serverId}/${toolName}`;
}

export function normalizeToolAllowlist(allowlist: ReadonlyArray<string> | null | undefined): string[] {
  return [...new Set((allowlist ?? []).filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

export async function hashToolSchema(schema: ToolSchema | null | undefined): Promise<string | null> {
  if (schema === null || schema === undefined) return null;
  // JSON-roundtrip sanitizes any non-JSON metadata (e.g. compiled validator state) that may have
  // been attached to the schema object after prior policy evaluation, ensuring stable hashes.
  const sanitized = typeof schema === "boolean" ? schema : JSON.parse(JSON.stringify(schema));
  return sha256Hex(canonicalJson(assertJsonValue(sanitized)));
}

export async function createToolCatalogEntry(input: ToolCatalogEntryInput): Promise<ToolCatalogEntry> {
  const serverId = input.serverId.trim();
  const toolName = input.toolName.trim();
  if (!serverId || !toolName) throw new Error("catalog_identity_required");
  if (!KNOWN_RISKS.has(input.riskLevel)) throw new Error("catalog_risk_required");
  if (typeof input.enabled !== "boolean") throw new Error("catalog_enabled_required");
  if (!isToolSchema(input.inputSchema)) throw new Error("catalog_schema_required");
  const schemaHash = await hashToolSchema(input.inputSchema);
  if (!schemaHash) throw new Error("catalog_schema_required");
  return {
    catalogVersion: 2,
    serverId,
    toolName,
    catalogKey: catalogToolKey(serverId, toolName),
    description: input.description?.trim() ?? "",
    riskLevel: input.riskLevel,
    inputSchema: input.inputSchema,
    schemaHash,
    outputByteLimit: clampByteLimit(input.outputByteLimit),
    enabled: input.enabled,
  };
}

export async function createToolCatalogSnapshotV3(input: ToolCatalogSnapshotInputV3): Promise<ToolCatalogSnapshotV3> {
  const catalogRevision = normalizeRevision(input.catalogRevision, "catalog_revision_required");
  const policyVersion = normalizeRevision(input.policyVersion, "policy_version_required");
  const connectorVersions = normalizeConnectorVersions(input.connectorVersions);
  const observedByKey = new Map<string, ToolCatalogEntry>();
  for (const observed of input.observedCatalog) {
    if (!isCompleteCatalogEntry(observed)) throw new Error("invalid_observed_catalog_entry");
    if (observedByKey.has(observed.catalogKey)) throw new Error("duplicate_observed_tool_key");
    observedByKey.set(observed.catalogKey, observed);
  }
  const descriptions: Record<string, ToolDescriptionV3> = {};
  const seenToolKeys = new Set<string>();

  for (const entry of [...input.catalog].sort((left, right) => left.catalogKey.localeCompare(right.catalogKey))) {
    if (!isCompleteCatalogEntry(entry)) throw new Error("invalid_v2_catalog_entry");
    if (seenToolKeys.has(entry.catalogKey)) throw new Error("duplicate_tool_key");
    seenToolKeys.add(entry.catalogKey);
    const metadata = input.metadata?.[entry.catalogKey] ?? {};
    const observed = observedByKey.get(entry.catalogKey);
    const connectorVersion = connectorVersions[entry.serverId] ?? "";
    const ownerRevision = normalizeRevision(metadata.ownerRevision ?? catalogRevision, "owner_revision_required");
    const [storedSchemaHash, observedSchemaHash] = await Promise.all([
      hashToolSchema(entry.inputSchema),
      hashToolSchema(observed?.inputSchema),
    ]);
    const unavailableReason = !entry.enabled
      ? "disabled"
      : !connectorVersion
        ? "connector_unversioned"
        : !observed
          || !observed.enabled
          || !storedSchemaHash
          || !observedSchemaHash
          || storedSchemaHash !== entry.schemaHash
          || observedSchemaHash !== observed.schemaHash
          || observedSchemaHash !== storedSchemaHash
          ? "schema_drift"
          : null;
    const billing = normalizeBilling(metadata, entry.riskLevel);
    const descriptor: ToolDescriptorV3 = {
      toolKey: entry.catalogKey,
      ownerDomain: normalizeMetadataText(metadata.ownerDomain, defaultOwnerDomain(entry.serverId), 64),
      providerId: entry.serverId,
      name: entry.toolName,
      summary: entry.description,
      tags: normalizeMetadataList(metadata.tags, defaultTags(entry), 12),
      riskClass: entry.riskLevel,
      consequences: normalizeMetadataList(metadata.consequences, defaultConsequences(entry.riskLevel), 8),
      sensitivity: normalizeMetadataList(metadata.sensitivity, [], 8),
      reversibility: normalizeReversibility(metadata.reversibility, entry.riskLevel),
      schemaHash: entry.schemaHash,
      catalogRevision,
      connectorVersion,
      enabled: entry.enabled,
      executable: unavailableReason === null,
      mayCost: billing.mayCost,
      billingClass: billing.billingClass,
      requiresConfirmation: billing.requiresConfirmation,
    };
    descriptions[entry.catalogKey] = {
      descriptor,
      inputSchema: entry.inputSchema,
      outputSchema: isToolSchema(metadata.outputSchema) ? metadata.outputSchema : null,
      outputByteLimit: entry.outputByteLimit,
      ownerRevision,
      policyHints: normalizeMetadataList(metadata.policyHints, defaultPolicyHints(entry.riskLevel), 8),
      requiresFreshAuth: metadata.requiresFreshAuth === true,
      mayCost: billing.mayCost,
      billingClass: billing.billingClass,
      requiresConfirmation: billing.requiresConfirmation,
      mayWrite: entry.riskLevel !== "read",
      unavailableReason,
    };
  }

  const descriptors = Object.values(descriptions).map((item) => item.descriptor);
  const snapshotHash = await sha256Hex(canonicalJson(assertJsonValue({
    catalogVersion: 3,
    catalogRevision,
    policyVersion,
    connectorVersions,
    descriptions,
  })));
  return {
    catalogVersion: 3,
    catalogRevision,
    snapshotHash,
    policyVersion,
    connectorVersions,
    descriptors,
    descriptions,
  };
}

function normalizeBilling(
  metadata: ToolDescriptorMetadataV3,
  riskLevel: RiskLevel,
): { mayCost: boolean; billingClass: ToolBillingClassV3; requiresConfirmation: boolean } {
  const explicitClass = metadata.billingClass;
  const billingClass: ToolBillingClassV3 = explicitClass
    ?? (metadata.mayCost === false ? "none" : metadata.mayCost === true || riskLevel === "purchase" ? "metered" : "unknown");
  const mayCost = billingClass !== "none";
  if (metadata.mayCost !== undefined && metadata.mayCost !== mayCost) throw new Error("tool_billing_metadata_inconsistent");
  return {
    mayCost,
    billingClass,
    // Paid and unknown-cost calls can never opt out of Owner confirmation.
    requiresConfirmation: mayCost || metadata.requiresConfirmation === true,
  };
}

export function searchToolCatalogV3(snapshot: ToolCatalogSnapshotV3, input: ToolSearchInputV3): ToolDescriptorV3[] {
  assertSnapshotPin(snapshot, input.expectedCatalogRevision, input.expectedSnapshotHash);
  const query = normalizeSearchQuery(input.query);
  const queryTokens = tokenize(query);
  const requestedTags = new Set(normalizeMetadataList(input.tags, [], 12).map((tag) => tag.toLowerCase()));
  if ((input.riskClasses ?? []).some((risk) => !KNOWN_RISKS.has(risk))) throw new Error("invalid_risk_filter");
  const requestedRisks = new Set(input.riskClasses ?? []);
  const ownerDomain = input.ownerDomain?.trim().toLowerCase() ?? "";
  const limit = clampSearchLimit(input.limit);

  return snapshot.descriptors
    .filter((descriptor) => input.includeUnavailable === true || (descriptor.enabled && descriptor.executable))
    .filter((descriptor) => requestedRisks.size === 0 || requestedRisks.has(descriptor.riskClass))
    .filter((descriptor) => !ownerDomain || descriptor.ownerDomain.toLowerCase() === ownerDomain)
    .filter((descriptor) => requestedTags.size === 0 || descriptor.tags.some((tag) => requestedTags.has(tag.toLowerCase())))
    .map((descriptor) => ({ descriptor, score: descriptorSearchScore(descriptor, query, queryTokens) }))
    .filter((item) => !query || item.score > 0)
    .sort((left, right) => right.score - left.score || left.descriptor.toolKey.localeCompare(right.descriptor.toolKey))
    .slice(0, limit)
    .map((item) => structuredClone(item.descriptor));
}

export function describeToolV3(
  snapshot: ToolCatalogSnapshotV3,
  input: { toolKey: string; expectedCatalogRevision: string; expectedSnapshotHash: string },
): ToolDescriptionV3 {
  assertSnapshotPin(snapshot, input.expectedCatalogRevision, input.expectedSnapshotHash);
  const description = snapshot.descriptions[input.toolKey];
  if (!description) throw new Error("tool_not_found");
  return structuredClone(description);
}

export function assertSnapshotPin(
  snapshot: ToolCatalogSnapshotV3,
  expectedCatalogRevision: string,
  expectedSnapshotHash: string,
): void {
  if (snapshot.catalogRevision !== expectedCatalogRevision) throw new Error("catalog_revision_drift");
  if (snapshot.snapshotHash !== expectedSnapshotHash) throw new Error("catalog_snapshot_drift");
}

export function parseToolCatalog(value: unknown): ToolCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isCompleteCatalogEntry);
}

export function toolCatalogNeedsRefresh(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  return value.some((item) => !isCompleteCatalogEntry(item));
}

export function matchesAllowlist(allowlist: ReadonlyArray<string>, entry: ToolCatalogEntry): boolean {
  return allowlist.includes(entry.catalogKey) || allowlist.includes(entry.toolName);
}

export function findCatalogEntry(catalog: ReadonlyArray<unknown>, serverId: string | undefined, toolName: string): ToolCatalogEntry | null {
  const validCatalog = parseToolCatalog(catalog);
  if (serverId) return validCatalog.find((entry) => entry.serverId === serverId && entry.toolName === toolName) ?? null;
  const byName = validCatalog.filter((entry) => entry.toolName === toolName);
  return byName.length === 1 ? byName[0] : null;
}

function clampByteLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_BYTE_LIMIT;
  return Math.max(MIN_OUTPUT_BYTE_LIMIT, Math.min(ABSOLUTE_OUTPUT_BYTE_LIMIT, Math.trunc(value as number)));
}

function clampSearchLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(20, Math.trunc(value as number)));
}

function normalizeRevision(value: string, errorCode: string): string {
  const normalized = value.trim();
  if (!REVISION_PATTERN.test(normalized)) throw new Error(errorCode);
  return normalized;
}

function normalizeConnectorVersions(value: Readonly<Record<string, string>>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [providerId, version] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    const key = providerId.trim();
    const normalized = version.trim();
    if (!key || !REVISION_PATTERN.test(normalized)) throw new Error("connector_version_invalid");
    output[key] = normalized;
  }
  return output;
}

function normalizeMetadataText(value: string | undefined, fallback: string, maxLength: number): string {
  const normalized = value?.trim() || fallback;
  return normalized.slice(0, maxLength);
}

function normalizeMetadataList(value: ReadonlyArray<string> | undefined, fallback: string[], limit: number): string[] {
  const source = value ?? fallback;
  return [...new Set(source
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 80))
    .filter(Boolean))]
    .slice(0, limit);
}

function normalizeReversibility(value: ToolReversibilityV3 | undefined, risk: RiskLevel): ToolReversibilityV3 {
  if (value === "none" || value === "native_undo" || value === "compensating" || value === "soft_delete") return value;
  return risk === "delete" ? "soft_delete" : "none";
}

function defaultOwnerDomain(serverId: string): string {
  return serverId.startsWith("custom:") ? "mcp-gateway" : "agent";
}

function defaultTags(entry: ToolCatalogEntry): string[] {
  return [...new Set([
    entry.serverId,
    entry.toolName,
    entry.riskLevel,
    ...tokenize(entry.description).slice(0, 6),
  ])];
}

function defaultConsequences(risk: RiskLevel): string[] {
  if (risk === "read") return ["returns_untrusted_external_data"];
  return [`may_${risk}_external_state`];
}

function defaultPolicyHints(risk: RiskLevel): string[] {
  return risk === "read"
    ? ["read_only", "result_is_untrusted", "bounded_output"]
    : ["preflight_required", "approval_may_be_required", "idempotency_required"];
}

function normalizeSearchQuery(value: string | undefined): string {
  return (value ?? "").trim().slice(0, 256).toLowerCase();
}

function tokenize(value: string): string[] {
  return [...new Set(value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 1))]
    .slice(0, 32);
}

function descriptorSearchScore(descriptor: ToolDescriptorV3, query: string, queryTokens: string[]): number {
  if (!query) return 1;
  const key = descriptor.toolKey.toLowerCase();
  const name = descriptor.name.toLowerCase();
  const owner = descriptor.ownerDomain.toLowerCase();
  const summary = descriptor.summary.toLowerCase();
  const tags = descriptor.tags.map((tag) => tag.toLowerCase());
  let score = key === query || name === query ? 100 : 0;
  if (key.includes(query)) score += 50;
  if (name.includes(query)) score += 40;
  if (summary.includes(query)) score += 20;
  for (const token of queryTokens) {
    if (name.includes(token)) score += 12;
    if (key.includes(token)) score += 10;
    if (tags.some((tag) => tag.includes(token))) score += 8;
    if (summary.includes(token)) score += 4;
    if (owner.includes(token)) score += 2;
  }
  return score;
}

function isToolSchema(value: unknown): value is ToolSchema {
  return typeof value === "boolean" || (Boolean(value) && typeof value === "object" && !Array.isArray(value));
}

function isCompleteCatalogEntry(value: unknown): value is ToolCatalogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.catalogVersion === 2 &&
    typeof item.serverId === "string" &&
    item.serverId.length > 0 &&
    typeof item.toolName === "string" &&
    item.toolName.length > 0 &&
    item.catalogKey === catalogToolKey(item.serverId, item.toolName) &&
    typeof item.description === "string" &&
    typeof item.riskLevel === "string" &&
    KNOWN_RISKS.has(item.riskLevel as RiskLevel) &&
    isToolSchema(item.inputSchema) &&
    typeof item.schemaHash === "string" &&
    SHA256_PATTERN.test(item.schemaHash) &&
    typeof item.outputByteLimit === "number" &&
    Number.isInteger(item.outputByteLimit) &&
    item.outputByteLimit >= MIN_OUTPUT_BYTE_LIMIT &&
    item.outputByteLimit <= ABSOLUTE_OUTPUT_BYTE_LIMIT &&
    typeof item.enabled === "boolean"
  );
}
