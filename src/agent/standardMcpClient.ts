import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type ElicitRequestParams, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

const OPERIA_CALL_KEY_META = "io.operia/call-key";

function assertSafeCallKey(callKey: string, executorBearer: string): void {
  if (callKey.length < 1 || callKey.length > 1_024 || /[\u0000-\u001f\u007f]/.test(callKey)) {
    throw new Error("mcp_call_key_invalid");
  }
  if (callKey === executorBearer) throw new Error("mcp_call_key_secret_collision");
}

type StandardMcpConnectionInput = {
  gateway: Fetcher;
  executorBearer: string;
  providerId: string;
  signal: AbortSignal;
  onElicitation?: (params: ElicitRequestParams) => Promise<ElicitResult>;
};

type StandardMcpSession = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

export type StandardMcpProbe = {
  toolName: string;
  args: Record<string, unknown>;
};

async function withStandardMcpSession<T>(
  input: StandardMcpConnectionInput,
  operation: (session: StandardMcpSession) => Promise<T>,
): Promise<T> {
  const endpoint = new URL(`https://mcp-gateway.internal/service/executor/${encodeURIComponent(input.providerId)}/mcp`);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: async (_resource, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${input.executorBearer}`);
      return input.gateway.fetch(endpoint.toString(), { ...init, headers });
    },
    reconnectionOptions: {
      initialReconnectionDelay: 200,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 1,
    },
  });
  const capabilities = input.onElicitation ? { elicitation: { form: {}, url: {} } } : {};
  const client = new Client(
    { name: "<AGENT_SERVICE>", version: "1.0.0" },
    { capabilities, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  if (input.onElicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => input.onElicitation!(request.params));
  }
  try {
    await client.connect(transport, { signal: input.signal, timeout: 15_000 });
    return await operation({ client, transport });
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

export async function listStandardMcpTools(input: StandardMcpConnectionInput): Promise<{
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
  protocolVersion: string | null;
  serverVersion: ReturnType<Client["getServerVersion"]> | null;
}> {
  return await withStandardMcpSession(input, async ({ client, transport }) => ({
    tools: (await client.listTools({}, { signal: input.signal, timeout: 15_000 })).tools,
    protocolVersion: transport.protocolVersion ?? null,
    serverVersion: client.getServerVersion() ?? null,
  }));
}

export async function probeStandardMcpProvider(input: StandardMcpConnectionInput & { probe: StandardMcpProbe }): Promise<{
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
  probeResult: unknown;
  protocolVersion: string | null;
  serverVersion: ReturnType<Client["getServerVersion"]> | null;
}> {
  const callKey = `health-probe:${input.providerId}:${input.probe.toolName}`;
  assertSafeCallKey(callKey, input.executorBearer);
  return await withStandardMcpSession(input, async ({ client, transport }) => {
    const tools = (await client.listTools({}, { signal: input.signal, timeout: 15_000 })).tools;
    const probeResult = await client.callTool(
      {
        name: input.probe.toolName,
        arguments: input.probe.args,
        _meta: { [OPERIA_CALL_KEY_META]: callKey },
      },
      undefined,
      { signal: input.signal, timeout: 30_000, maxTotalTimeout: 30_000 },
    );
    if (probeResult.isError === true) throw new Error("mcp_read_only_health_probe_failed");
    return {
      tools,
      probeResult,
      protocolVersion: transport.protocolVersion ?? null,
      serverVersion: client.getServerVersion() ?? null,
    };
  });
}

export async function callStandardMcpTool(input: {
  gateway: Fetcher;
  executorBearer: string;
  providerId: string;
  toolName: string;
  args: Record<string, unknown>;
  callKey: string;
  signal: AbortSignal;
  onElicitation: (params: ElicitRequestParams) => Promise<ElicitResult>;
}): Promise<unknown> {
  assertSafeCallKey(input.callKey, input.executorBearer);
  return await withStandardMcpSession(input, async ({ client }) => {
    return await client.callTool(
      {
        name: input.toolName,
        arguments: input.args,
        _meta: { [OPERIA_CALL_KEY_META]: input.callKey },
      },
      undefined,
      { signal: input.signal, timeout: 30_000, maxTotalTimeout: 30_000 },
    );
  });
}
