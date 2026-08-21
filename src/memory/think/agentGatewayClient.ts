import type { ToolDescriptionV3, ToolDescriptorV3 } from "../../agent/toolCatalog";
import type { ToolExecutionPinV3, ToolTaskPinV3 } from "../../agent/toolRouterV2";
import type { JsonValue } from "../../agent/types";

export type ThinkGateDAgentGatewayEnv = {
  AGENT_SERVICE?: Fetcher;
  AGENT_THINK_SERVICE_BEARER?: string;
};

export type ThinkGateDDirectResult = {
  requestId: string;
  result: {
    ok: boolean;
    serverId: string;
    toolName: string;
    payload: JsonValue;
    payloadBytes: number;
    truncated: boolean;
    classification: string;
  };
  audit: {
    route: "direct_read";
    toolKey: string;
    argsHash: string;
    resultHash: string;
    sanitizedBytes: number;
    truncated: boolean;
  };
  elapsedMs: number;
  externalReads: number;
  externalWrites: 0;
  approvalRequired: false;
};

type CatalogResponse = {
  catalogRevision: string;
  catalogSnapshotHash: string;
  policyVersion: string;
  connectorVersions: Record<string, string>;
  tools: ToolDescriptorV3[];
};

const SKILL_INSTALLATION_REVISION = "skills-disabled-gate-d";
const THINK_HARNESS_VERSION = "think-0.15.0";

export async function executeThinkGateDDirectRead(input: {
  env: ThinkGateDAgentGatewayEnv;
  requestId: string;
  toolKey: string;
  args: JsonValue;
  memoryContextProjectionHash: string;
}): Promise<ThinkGateDDirectResult> {
  const service = input.env.AGENT_SERVICE;
  const bearer = input.env.AGENT_THINK_SERVICE_BEARER?.trim();
  if (!service || !bearer) throw new Error("think_gate_d_agent_binding_misconfigured");

  const catalog = await gatewayJson<CatalogResponse>(service, bearer, new Request(
    "https://<AGENT_SERVICE>.internal/service/think/catalog",
    { method: "GET" },
  ));
  const descriptor = catalog.tools.find((item) => item.toolKey === input.toolKey);
  if (!descriptor || !descriptor.enabled || !descriptor.executable || descriptor.riskClass !== "read") {
    throw new Error("think_gate_d_tool_unavailable");
  }
  const pinEnvelope = {
    catalogRevision: catalog.catalogRevision,
    catalogSnapshotHash: catalog.catalogSnapshotHash,
    policyVersion: catalog.policyVersion,
  };
  const description = await gatewayJson<ToolDescriptionV3>(service, bearer, new Request(
    "https://<AGENT_SERVICE>.internal/service/think/describe",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolKey: input.toolKey, ...pinEnvelope }),
    },
  ));
  if (
    description.descriptor.toolKey !== input.toolKey
    || description.descriptor.riskClass !== "read"
    || description.requiresFreshAuth
    || description.mayCost
    || description.mayWrite
  ) {
    throw new Error("think_gate_d_description_not_read_only");
  }

  const taskPin: ToolTaskPinV3 = {
    catalogRevision: catalog.catalogRevision,
    catalogSnapshotHash: catalog.catalogSnapshotHash,
    policyVersion: catalog.policyVersion,
    connectorVersions: catalog.connectorVersions,
    skillInstallationRevision: SKILL_INSTALLATION_REVISION,
    thinkHarnessVersion: THINK_HARNESS_VERSION,
    memoryContextProjectionHash: input.memoryContextProjectionHash,
  };
  const executionPin: ToolExecutionPinV3 = {
    toolKey: description.descriptor.toolKey,
    schemaHash: description.descriptor.schemaHash,
    ownerRevision: description.ownerRevision,
    catalogRevision: catalog.catalogRevision,
    catalogSnapshotHash: catalog.catalogSnapshotHash,
    policyVersion: catalog.policyVersion,
    connectorVersion: description.descriptor.connectorVersion,
  };
  return gatewayJson<ThinkGateDDirectResult>(service, bearer, new Request(
    "https://<AGENT_SERVICE>.internal/service/think/execute",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: input.requestId,
        memoryContextProjectionHash: input.memoryContextProjectionHash,
        taskPin,
        executionPin,
        args: input.args,
      }),
    },
  ));
}

async function gatewayJson<T>(service: Fetcher, bearer: string, request: Request): Promise<T> {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  const response = await service.fetch(new Request(request, { headers }));
  const value = await response.json<unknown>();
  if (!response.ok) {
    const code = value && typeof value === "object" && "error" in value
      ? String((value as Record<string, unknown>).error)
      : `think_gate_d_agent_http_${response.status}`;
    throw new Error(code.slice(0, 160));
  }
  return value as T;
}
