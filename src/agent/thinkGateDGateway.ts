import { bearerAuthorized, json, readJsonObject } from "./security";
import {
  createToolCatalogEntry,
  createToolCatalogSnapshotV3,
  describeToolV3,
  type ToolCatalogSnapshotV3,
} from "./toolCatalog";
import { assertJsonValue, canonicalJson } from "../utils/json";
import {
  createToolTaskPinV3,
  executeDirectReadV3,
  toolRouterV2Enabled,
  type ToolExecutionPinV3,
  type ToolTaskPinV3,
} from "./toolRouterV2";
import {
  evaluateSandboxPublicEgress,
  readBoundedSandboxResponse,
  sanitizeSandboxOutboundHeaders,
} from "./sandboxPolicy";
import type { JsonValue, ToolCatalogEntry, ToolCatalogEntryInput } from "./types";

export type ThinkGateDGatewayEnv = {
  AGENT_THINK_GATEWAY_ENABLED?: string;
  AGENT_TOOL_ROUTER_V2_ENABLED?: string;
  AGENT_THINK_SERVICE_BEARER?: string;
};

const CATALOG_REVISION = "think-gate-d-staging-v1";
const POLICY_VERSION = "static-v2";
const THINK_HARNESS_VERSION = "think-0.15.0";
const SKILL_INSTALLATION_REVISION = "skills-disabled-gate-d";
const PUBLIC_READ_MAX_BYTES = 16 * 1024;
const PUBLIC_READ_TIMEOUT_MS = 15_000;
const PUBLIC_READ_HOSTS = new Set(["developers.cloudflare.com"]);

const CONNECTOR_VERSIONS = Object.freeze({
  "operia-observer": "gate-d-staging-v1",
  "public-https": "gate-d-staging-v1",
  health: "gate-d-staging-v1",
  calendar: "gate-d-staging-v1",
});

const TOOL_INPUTS: ToolCatalogEntryInput[] = [
  {
    serverId: "operia-observer",
    toolName: "system_status",
    description: "Read a bounded staging runtime status fixture.",
    riskLevel: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputByteLimit: 4096,
    enabled: true,
  },
  {
    serverId: "public-https",
    toolName: "read_url",
    description: "Read one bounded public HTTPS document through the Agent egress policy.",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 12, maxLength: 2048, pattern: "^https://" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    outputByteLimit: PUBLIC_READ_MAX_BYTES,
    enabled: true,
  },
  {
    serverId: "health",
    toolName: "health_summary",
    description: "Read a bounded synthetic staging health summary.",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: { range: { type: "string", enum: ["today", "7d", "30d"] } },
      additionalProperties: false,
    },
    outputByteLimit: 4096,
    enabled: true,
  },
  {
    serverId: "calendar",
    toolName: "calendar_list",
    description: "Read a bounded synthetic staging calendar projection.",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 8 } },
      additionalProperties: false,
    },
    outputByteLimit: 4096,
    enabled: true,
  },
];

export function thinkGateDGatewayEnabled(env: ThinkGateDGatewayEnv): boolean {
  return env.AGENT_THINK_GATEWAY_ENABLED?.trim().toLowerCase() === "true"
    && toolRouterV2Enabled(env);
}

export async function handleThinkGateDGateway(
  request: Request,
  env: ThinkGateDGatewayEnv,
): Promise<Response> {
  if (!thinkGateDGatewayEnabled(env)) return json({ error: "not_found" }, { status: 404 });
  if (new URL(request.url).hostname !== "<AGENT_SERVICE>.internal") {
    return json({ error: "not_found" }, { status: 404 });
  }
  if (!(await bearerAuthorized(request, env.AGENT_THINK_SERVICE_BEARER))) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  try {
    const snapshot = await createGateDSnapshot();
    if (request.method === "GET" && url.pathname === "/service/think/catalog") {
      return json({
        catalogRevision: snapshot.catalogRevision,
        catalogSnapshotHash: snapshot.snapshotHash,
        policyVersion: snapshot.policyVersion,
        connectorVersions: snapshot.connectorVersions,
        tools: snapshot.descriptors,
      });
    }
    if (request.method === "POST" && url.pathname === "/service/think/describe") {
      const body = await readJsonObject(request);
      const toolKey = requiredString(body.toolKey, "tool_key_required");
      assertCatalogPins(snapshot, body);
      return json(describeToolV3(snapshot, {
        toolKey,
        expectedCatalogRevision: snapshot.catalogRevision,
        expectedSnapshotHash: snapshot.snapshotHash,
      }));
    }
    if (request.method === "POST" && url.pathname === "/service/think/execute") {
      return await executeGateDRead(request, snapshot);
    }
    return json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    const code = boundedCode(error, "think_gate_d_gateway_failed");
    const status = /drift|invalid|required|denied|not_found/.test(code) ? 400 : 502;
    return json({ error: code }, { status });
  }
}

async function executeGateDRead(request: Request, snapshot: ToolCatalogSnapshotV3): Promise<Response> {
  const body = await readJsonObject(request);
  const requestId = requiredIdentifier(body.requestId, "request_id_required");
  const memoryContextProjectionHash = requiredHash(
    body.memoryContextProjectionHash,
    "memory_context_projection_hash_required",
  );
  const taskPin = parseTaskPin(body.taskPin);
  const executionPin = parseExecutionPin(body.executionPin);
  const args = asJsonValue(body.args);
  assertCatalogPins(snapshot, taskPin);

  const expectedTaskPin = createToolTaskPinV3({
    snapshot,
    skillInstallationRevision: SKILL_INSTALLATION_REVISION,
    thinkHarnessVersion: THINK_HARNESS_VERSION,
    memoryContextProjectionHash,
  });
  if (canonicalJson(assertJsonValue(taskPin)) !== canonicalJson(assertJsonValue(expectedTaskPin))) {
    throw new Error("think_gate_d_task_pin_drift");
  }

  let externalReads = 0;
  const startedAt = Date.now();
  const result = await executeDirectReadV3({
    snapshot,
    observedCatalog: await gateDCatalog(),
    allowlist: snapshot.descriptors.map((item) => item.toolKey),
    taskPin,
    executionPin,
    args,
    invoke: async (call) => {
      if (call.serverId === "public-https") externalReads += 1;
      return invokeGateDRead(call.serverId, call.toolName, call.args);
    },
  });
  const elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    event: "think.gate_d.direct.completed",
    requestId,
    route: result.audit.route,
    toolKey: result.audit.toolKey,
    argsHash: result.audit.argsHash,
    resultHash: result.audit.resultHash,
    elapsedMs,
    externalReads,
    externalWrites: 0,
  }));
  return json({
    requestId,
    result: result.result,
    audit: result.audit,
    elapsedMs,
    externalReads,
    externalWrites: 0,
    approvalRequired: false,
  });
}

async function invokeGateDRead(serverId: string, toolName: string, args: JsonValue): Promise<unknown> {
  const input = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, JsonValue>
    : {};
  if (serverId === "operia-observer" && toolName === "system_status") {
    return {
      environment: "staging",
      service: "<AGENT_SERVICE>-think-gateway",
      status: "healthy",
      syntheticFixture: true,
      externalWrites: 0,
    };
  }
  if (serverId === "public-https" && toolName === "read_url") {
    return readPublicHttps(String(input.url ?? ""));
  }
  if (serverId === "health" && toolName === "health_summary") {
    return {
      ownerDomain: "health.example.com",
      environment: "staging",
      syntheticFixture: true,
      range: String(input.range ?? "7d"),
      status: "available",
      summary: { activityMinutes: 42, sleepMinutes: 438 },
      disclaimer: "informational_not_medical_diagnosis",
      externalWrites: 0,
    };
  }
  if (serverId === "calendar" && toolName === "calendar_list") {
    const limit = Math.max(1, Math.min(8, Number(input.limit) || 3));
    return {
      ownerDomain: "calendar.example.com",
      environment: "staging",
      syntheticFixture: true,
      timezone: "<YOUR_TIMEZONE>",
      upcoming: [
        { eventRef: "fixture-1", startsAt: "2030-01-01T09:00:00Z", label: "Synthetic read fixture" },
      ].slice(0, limit),
      externalWrites: 0,
    };
  }
  throw new Error("think_gate_d_tool_not_found");
}

async function readPublicHttps(rawUrl: string): Promise<unknown> {
  const request = new Request(rawUrl, {
    method: "GET",
    headers: { accept: "text/plain,text/html;q=0.8" },
  });
  const decision = evaluateSandboxPublicEgress(request);
  if (!decision.ok) throw new Error(decision.code);
  if (!PUBLIC_READ_HOSTS.has(decision.url.hostname.toLowerCase())) {
    throw new Error("think_gate_d_public_host_denied");
  }
  const response = await fetch(decision.url, {
    method: decision.method,
    headers: sanitizeSandboxOutboundHeaders(request.headers),
    redirect: "manual",
    signal: AbortSignal.timeout(PUBLIC_READ_TIMEOUT_MS),
  });
  const bounded = await readBoundedSandboxResponse(response, PUBLIC_READ_MAX_BYTES);
  const contentType = (bounded.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
  if (!contentType.startsWith("text/") && contentType !== "application/json") {
    throw new Error("think_gate_d_public_content_type_denied");
  }
  return {
    url: decision.url.toString(),
    status: bounded.status,
    contentType,
    body: await bounded.text(),
    policyVersion: bounded.headers.get("x-operia-egress-policy"),
    externalWrites: 0,
  };
}

async function createGateDSnapshot(): Promise<ToolCatalogSnapshotV3> {
  const catalog = await gateDCatalog();
  return createToolCatalogSnapshotV3({
    catalog,
    observedCatalog: catalog,
    catalogRevision: CATALOG_REVISION,
    policyVersion: POLICY_VERSION,
    connectorVersions: CONNECTOR_VERSIONS,
    metadata: Object.fromEntries(catalog.map((entry) => [entry.catalogKey, {
      ownerRevision: `${entry.serverId}-staging-v1`,
      tags: ["read", "gate-d", "staging"],
      consequences: ["none"],
      sensitivity: entry.serverId === "health" || entry.serverId === "calendar"
        ? ["synthetic-sensitive-fixture"]
        : [],
      reversibility: "none" as const,
      requiresFreshAuth: false,
      mayCost: false,
      billingClass: "none" as const,
      requiresConfirmation: false,
    }])),
  });
}

async function gateDCatalog(): Promise<ToolCatalogEntry[]> {
  return Promise.all(TOOL_INPUTS.map((input) => createToolCatalogEntry(input)));
}

function assertCatalogPins(snapshot: ToolCatalogSnapshotV3, input: Record<string, unknown>): void {
  if (
    input.catalogRevision !== snapshot.catalogRevision
    || input.catalogSnapshotHash !== snapshot.snapshotHash
    || input.policyVersion !== snapshot.policyVersion
  ) {
    throw new Error("think_gate_d_catalog_pin_drift");
  }
}

function parseTaskPin(value: unknown): ToolTaskPinV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("think_gate_d_task_pin_invalid");
  const input = value as Record<string, unknown>;
  return {
    catalogRevision: requiredIdentifier(input.catalogRevision, "think_gate_d_task_pin_invalid"),
    catalogSnapshotHash: requiredHash(input.catalogSnapshotHash, "think_gate_d_task_pin_invalid"),
    policyVersion: requiredIdentifier(input.policyVersion, "think_gate_d_task_pin_invalid"),
    connectorVersions: parseStringMap(input.connectorVersions),
    skillInstallationRevision: requiredIdentifier(input.skillInstallationRevision, "think_gate_d_task_pin_invalid"),
    thinkHarnessVersion: requiredIdentifier(input.thinkHarnessVersion, "think_gate_d_task_pin_invalid"),
    memoryContextProjectionHash: requiredHash(input.memoryContextProjectionHash, "think_gate_d_task_pin_invalid"),
  };
}

function parseExecutionPin(value: unknown): ToolExecutionPinV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("think_gate_d_execution_pin_invalid");
  const input = value as Record<string, unknown>;
  return {
    toolKey: requiredString(input.toolKey, "think_gate_d_execution_pin_invalid"),
    schemaHash: requiredHash(input.schemaHash, "think_gate_d_execution_pin_invalid"),
    ownerRevision: requiredIdentifier(input.ownerRevision, "think_gate_d_execution_pin_invalid"),
    catalogRevision: requiredIdentifier(input.catalogRevision, "think_gate_d_execution_pin_invalid"),
    catalogSnapshotHash: requiredHash(input.catalogSnapshotHash, "think_gate_d_execution_pin_invalid"),
    policyVersion: requiredIdentifier(input.policyVersion, "think_gate_d_execution_pin_invalid"),
    connectorVersion: requiredIdentifier(input.connectorVersion, "think_gate_d_execution_pin_invalid"),
  };
}

function parseStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("think_gate_d_task_pin_invalid");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) throw new Error("think_gate_d_task_pin_invalid");
  return Object.fromEntries(entries.map(([key, item]) => [
    requiredIdentifier(key, "think_gate_d_task_pin_invalid"),
    requiredIdentifier(item, "think_gate_d_task_pin_invalid"),
  ]));
}

function asJsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || new TextEncoder().encode(encoded).byteLength > 8192) {
    throw new Error("think_gate_d_args_invalid");
  }
  return JSON.parse(encoded) as JsonValue;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error(code);
  return value.trim();
}

function requiredIdentifier(value: unknown, code: string): string {
  const normalized = requiredString(value, code);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(normalized)) throw new Error(code);
  return normalized;
}

function requiredHash(value: unknown, code: string): string {
  const normalized = requiredString(value, code);
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
}

function boundedCode(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : fallback;
  return /^[a-z0-9_:.-]{1,160}$/i.test(value) ? value : fallback;
}
