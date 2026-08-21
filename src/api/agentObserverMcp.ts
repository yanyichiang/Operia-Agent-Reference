import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import type { Env } from "../types";

const SYSTEM_STATUS_TOOL = {
  name: "system_status",
  description: "Return a sanitized read-only snapshot of the Operia memory runtime.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

function rpc(id: unknown, result: unknown, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result }, { status });
}

function rpcError(id: unknown, code: number, message: string, status = 400): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

export async function handleAgentObserverMcp(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return rpcError(null, -32001, "Unauthorized", 401);
  const scopeError = requireScope(auth.profile, "memory:read");
  if (scopeError) return scopeError;

  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  if (body.method === "tools/list") return rpc(body.id, { tools: [SYSTEM_STATUS_TOOL] });
  if (body.method !== "tools/call") return rpcError(body.id, -32601, "Method not found", 404);
  if (body.params?.name !== SYSTEM_STATUS_TOOL.name) return rpcError(body.id, -32602, "Unknown tool");
  if (body.params.arguments && Object.keys(body.params.arguments as Record<string, unknown>).length > 0) {
    return rpcError(body.id, -32602, "system_status accepts no arguments");
  }

  const runtimeModel = env.CHAT_MODEL || env.DEFAULT_UPSTREAM_MODEL || null;
  const snapshot = {
    ok: true,
    memory_lifecycle: env.MEMORY_LIFECYCLE_ENABLED !== "false",
    model: runtimeModel,
    runtime_model: runtimeModel,
    public_alias: env.PUBLIC_MODEL_NAME || "companion",
    embedding_dimensions: Number(env.EMBEDDING_DIMENSIONS || 768),
    vectorize_bound: Boolean(env.VECTORIZE),
    queue_bound: Boolean(env.MEMORY_QUEUE),
  };
  return rpc(body.id, { content: [{ type: "text", text: JSON.stringify(snapshot) }], structuredContent: snapshot });
}
