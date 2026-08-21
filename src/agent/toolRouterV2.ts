import { canonicalArgsHash } from "./contextBroker";
import { evaluateToolPolicy, sanitizeToolResult } from "./policy";
import { assertSnapshotPin, describeToolV3, sha256Hex, type ToolCatalogSnapshotV3, type ToolDescriptionV3 } from "./toolCatalog";
import { assertJsonValue, canonicalJson } from "../utils/json";
import type { JsonValue, PlannedToolCall, SanitizedToolResult, ToolCatalogEntry } from "./types";

const canonicalJsonStringify = (value: unknown): string => canonicalJson(assertJsonValue(value));

const READ_ONLY_RISK = "read";

export type ToolTaskPinV3 = {
  catalogRevision: string;
  catalogSnapshotHash: string;
  policyVersion: string;
  connectorVersions: Record<string, string>;
  skillInstallationRevision: string;
  thinkHarnessVersion: string;
  memoryContextProjectionHash: string;
};

export type ToolExecutionPinV3 = {
  toolKey: string;
  schemaHash: string;
  ownerRevision: string;
  catalogRevision: string;
  catalogSnapshotHash: string;
  policyVersion: string;
  connectorVersion: string;
};

export type PreparedDirectReadV3 = {
  call: PlannedToolCall;
  description: ToolDescriptionV3;
  taskPin: ToolTaskPinV3;
  executionPin: ToolExecutionPinV3;
  argsHash: string;
};

export type ToolRouterAuditV3 = {
  route: "direct_read";
  toolKey: string;
  catalogRevision: string;
  catalogSnapshotHash: string;
  schemaHash: string;
  ownerRevision: string;
  policyVersion: string;
  connectorVersion: string;
  skillInstallationRevision: string;
  thinkHarnessVersion: string;
  memoryContextProjectionHash: string;
  argsHash: string;
  resultHash: string;
  sanitizedBytes: number;
  truncated: boolean;
};

export type ToolRouteShadowComparisonV3 = {
  legacyToolKeys: string[];
  progressiveToolKeys: string[];
  sameToolSequence: boolean;
  initialSurfaceContainsSchema: boolean;
  initialSurfaceBytes: number;
  legacyCatalogBytes: number;
};

export const PROGRESSIVE_TOOL_SURFACE_V3 = Object.freeze([
  {
    name: "tool_search",
    description: "Search bounded tool metadata by intent, tags, owner, and risk. Returns stable keys only.",
  },
  {
    name: "tool_describe",
    description: "Describe one exact tool key at a pinned catalog revision before execution.",
  },
  {
    name: "tool_execute",
    description: "Execute one previously described direct tool through Agent policy and audit.",
  },
]);

export function toolRouterV2Enabled(env: { AGENT_TOOL_ROUTER_V2_ENABLED?: string }): boolean {
  return env.AGENT_TOOL_ROUTER_V2_ENABLED?.trim().toLowerCase() === "true";
}

export function createToolTaskPinV3(input: {
  snapshot: ToolCatalogSnapshotV3;
  skillInstallationRevision: string;
  thinkHarnessVersion: string;
  memoryContextProjectionHash: string;
}): ToolTaskPinV3 {
  return {
    catalogRevision: input.snapshot.catalogRevision,
    catalogSnapshotHash: input.snapshot.snapshotHash,
    policyVersion: input.snapshot.policyVersion,
    connectorVersions: structuredClone(input.snapshot.connectorVersions),
    skillInstallationRevision: requirePin(input.skillInstallationRevision, "skill_installation_revision_required"),
    thinkHarnessVersion: requirePin(input.thinkHarnessVersion, "think_harness_version_required"),
    memoryContextProjectionHash: requireHash(input.memoryContextProjectionHash, "memory_context_projection_hash_required"),
  };
}

export async function prepareDirectReadV3(input: {
  snapshot: ToolCatalogSnapshotV3;
  observedCatalog: ReadonlyArray<ToolCatalogEntry>;
  allowlist: ReadonlyArray<string>;
  taskPin: ToolTaskPinV3;
  executionPin: ToolExecutionPinV3;
  args: JsonValue;
}): Promise<PreparedDirectReadV3> {
  assertTaskPin(input.snapshot, input.taskPin);
  const description = describeToolV3(input.snapshot, {
    toolKey: input.executionPin.toolKey,
    expectedCatalogRevision: input.executionPin.catalogRevision,
    expectedSnapshotHash: input.executionPin.catalogSnapshotHash,
  });
  assertExecutionPin(description, input.taskPin, input.executionPin);
  if (!description.descriptor.enabled || !description.descriptor.executable || description.unavailableReason) {
    throw new Error(description.unavailableReason ?? "tool_unavailable");
  }
  if (description.requiresFreshAuth) throw new Error("tool_fresh_auth_required");
  if (description.descriptor.riskClass !== READ_ONLY_RISK || description.mayWrite || description.mayCost) {
    throw new Error("tool_execute_gate_b_read_only");
  }

  const intendedCatalog = snapshotLegacyCatalog(input.snapshot);
  const decision = await evaluateToolPolicy({
    catalog: intendedCatalog,
    observedCatalog: input.observedCatalog,
    allowlist: input.allowlist,
    serverId: description.descriptor.providerId,
    toolName: description.descriptor.name,
    args: input.args,
    policyVersion: input.taskPin.policyVersion,
  });
  if (!decision.ok) throw new Error(`tool_policy_${decision.code}`);
  if (decision.requiresApproval || decision.riskLevel !== READ_ONLY_RISK) throw new Error("tool_execute_gate_b_read_only");
  if (decision.tool.schemaHash !== input.executionPin.schemaHash) throw new Error("tool_schema_drift");

  return {
    call: {
      serverId: description.descriptor.providerId,
      toolName: description.descriptor.name,
      args: input.args,
    },
    description,
    taskPin: structuredClone(input.taskPin),
    executionPin: structuredClone(input.executionPin),
    argsHash: decision.argsHash,
  };
}

export async function executeDirectReadV3(input: {
  snapshot: ToolCatalogSnapshotV3;
  observedCatalog: ReadonlyArray<ToolCatalogEntry>;
  allowlist: ReadonlyArray<string>;
  taskPin: ToolTaskPinV3;
  executionPin: ToolExecutionPinV3;
  args: JsonValue;
  invoke: (call: PlannedToolCall) => Promise<unknown>;
}): Promise<{ result: SanitizedToolResult; audit: ToolRouterAuditV3 }> {
  const prepared = await prepareDirectReadV3(input);
  const raw = await input.invoke(prepared.call);
  const result = sanitizeToolResult({
    catalog: snapshotLegacyCatalog(input.snapshot),
    serverId: prepared.call.serverId,
    toolName: prepared.call.toolName,
    result: raw,
  });
  const resultHash = await sha256Hex(canonicalJsonStringify(result));
  return {
    result,
    audit: {
      route: "direct_read",
      toolKey: prepared.executionPin.toolKey,
      catalogRevision: prepared.taskPin.catalogRevision,
      catalogSnapshotHash: prepared.taskPin.catalogSnapshotHash,
      schemaHash: prepared.executionPin.schemaHash,
      ownerRevision: prepared.executionPin.ownerRevision,
      policyVersion: prepared.taskPin.policyVersion,
      connectorVersion: prepared.executionPin.connectorVersion,
      skillInstallationRevision: prepared.taskPin.skillInstallationRevision,
      thinkHarnessVersion: prepared.taskPin.thinkHarnessVersion,
      memoryContextProjectionHash: prepared.taskPin.memoryContextProjectionHash,
      argsHash: prepared.argsHash,
      resultHash,
      sanitizedBytes: result.payloadBytes,
      truncated: result.truncated,
    },
  };
}

export function createExecutionPinV3(description: ToolDescriptionV3, taskPin: ToolTaskPinV3): ToolExecutionPinV3 {
  return {
    toolKey: description.descriptor.toolKey,
    schemaHash: description.descriptor.schemaHash,
    ownerRevision: description.ownerRevision,
    catalogRevision: taskPin.catalogRevision,
    catalogSnapshotHash: taskPin.catalogSnapshotHash,
    policyVersion: taskPin.policyVersion,
    connectorVersion: description.descriptor.connectorVersion,
  };
}

export function compareLegacyAndProgressiveRoutesV3(input: {
  legacyCalls: ReadonlyArray<Pick<PlannedToolCall, "serverId" | "toolName">>;
  progressiveToolKeys: ReadonlyArray<string>;
  legacyCatalog: ReadonlyArray<ToolCatalogEntry>;
}): ToolRouteShadowComparisonV3 {
  const legacyToolKeys = input.legacyCalls.map((call) => `${call.serverId}/${call.toolName}`);
  const progressiveToolKeys = [...input.progressiveToolKeys];
  const initialSurface = canonicalJsonStringify(PROGRESSIVE_TOOL_SURFACE_V3);
  return {
    legacyToolKeys,
    progressiveToolKeys,
    sameToolSequence: canonicalJsonStringify(legacyToolKeys) === canonicalJsonStringify(progressiveToolKeys),
    initialSurfaceContainsSchema: /inputSchema|outputSchema|schemaHash/.test(initialSurface),
    initialSurfaceBytes: new TextEncoder().encode(initialSurface).byteLength,
    legacyCatalogBytes: new TextEncoder().encode(canonicalJsonStringify(input.legacyCatalog)).byteLength,
  };
}

function assertTaskPin(snapshot: ToolCatalogSnapshotV3, pin: ToolTaskPinV3): void {
  assertSnapshotPin(snapshot, pin.catalogRevision, pin.catalogSnapshotHash);
  if (snapshot.policyVersion !== pin.policyVersion) throw new Error("policy_version_drift");
  if (canonicalJsonStringify(snapshot.connectorVersions) !== canonicalJsonStringify(pin.connectorVersions)) {
    throw new Error("connector_versions_drift");
  }
  requirePin(pin.skillInstallationRevision, "skill_installation_revision_required");
  requirePin(pin.thinkHarnessVersion, "think_harness_version_required");
  requireHash(pin.memoryContextProjectionHash, "memory_context_projection_hash_required");
}

function assertExecutionPin(description: ToolDescriptionV3, taskPin: ToolTaskPinV3, pin: ToolExecutionPinV3): void {
  const descriptor = description.descriptor;
  if (pin.catalogRevision !== taskPin.catalogRevision || pin.catalogSnapshotHash !== taskPin.catalogSnapshotHash) {
    throw new Error("execution_catalog_pin_drift");
  }
  if (pin.policyVersion !== taskPin.policyVersion) throw new Error("execution_policy_pin_drift");
  if (descriptor.schemaHash !== pin.schemaHash) throw new Error("tool_schema_drift");
  if (description.ownerRevision !== pin.ownerRevision) throw new Error("owner_revision_drift");
  if (descriptor.connectorVersion !== pin.connectorVersion) throw new Error("connector_version_drift");
  if (taskPin.connectorVersions[descriptor.providerId] !== pin.connectorVersion) throw new Error("connector_version_drift");
}

function snapshotLegacyCatalog(snapshot: ToolCatalogSnapshotV3): ToolCatalogEntry[] {
  return Object.values(snapshot.descriptions).map((description) => ({
    catalogVersion: 2,
    serverId: description.descriptor.providerId,
    toolName: description.descriptor.name,
    catalogKey: description.descriptor.toolKey,
    description: description.descriptor.summary,
    riskLevel: description.descriptor.riskClass,
    inputSchema: structuredClone(description.inputSchema),
    schemaHash: description.descriptor.schemaHash,
    outputByteLimit: description.outputByteLimit,
    enabled: description.descriptor.enabled,
  }));
}

function requirePin(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) throw new Error(code);
  return normalized;
}

function requireHash(value: string, code: string): string {
  const normalized = value.trim();
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
}

export async function hashProgressiveRouteInputV3(value: unknown): Promise<string> {
  return canonicalArgsHash(value);
}
