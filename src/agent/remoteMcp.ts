export const REMOTE_MCP_TIMEOUT_MS = 10_000;
export const REMOTE_MCP_MAX_RESPONSE_BYTES = 256 * 1024;

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const FORBIDDEN_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa"];
const FORBIDDEN_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.aws.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

export type RemoteMcpErrorCode =
  | "remote_mcp_invalid_endpoint"
  | "remote_mcp_host_not_allowed"
  | "remote_mcp_invalid_allowed_hostname"
  | "remote_mcp_invalid_bearer"
  | "remote_mcp_invalid_tool_name"
  | "remote_mcp_invalid_tool_arguments"
  | "remote_mcp_timeout"
  | "remote_mcp_network_error"
  | "remote_mcp_http_error"
  | "remote_mcp_invalid_content_type"
  | "remote_mcp_response_too_large"
  | "remote_mcp_invalid_json"
  | "remote_mcp_invalid_jsonrpc"
  | "remote_mcp_rpc_error"
  | "remote_mcp_invalid_tools_list"
  | "remote_mcp_invalid_tool_result";

export class RemoteMcpError extends Error {
  readonly code: RemoteMcpErrorCode;
  readonly status?: number;
  readonly rpcCode?: number;

  constructor(code: RemoteMcpErrorCode, options: { status?: number; rpcCode?: number; cause?: unknown } = {}) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RemoteMcpError";
    this.code = code;
    this.status = options.status;
    this.rpcCode = options.rpcCode;
  }
}

export type RemoteMcpClientOptions = {
  endpoint: string;
  bearerToken?: string;
  allowedHostnames?: ReadonlyArray<string>;
  fetcher?: typeof fetch;
};

export type RemoteMcpClient = {
  endpoint: string;
  listTools(): Promise<unknown>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
};

export function createRemoteMcpClient(options: RemoteMcpClientOptions): RemoteMcpClient {
  const allowedHostnames = normalizeAllowedHostnames(options.allowedHostnames ?? []);
  const endpoint = validateRemoteMcpEndpoint(options.endpoint, allowedHostnames);
  const bearerToken = validateBearer(options.bearerToken);
  const fetcher = options.fetcher ?? fetch;

  return {
    endpoint: endpoint.toString(),
    listTools: () => request(fetcher, endpoint, bearerToken, "tools/list", {}, validateToolsList),
    callTool: (name, args = {}) => {
      if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) throw new RemoteMcpError("remote_mcp_invalid_tool_name");
      if (!isPlainObject(args)) throw new RemoteMcpError("remote_mcp_invalid_tool_arguments");
      return request(fetcher, endpoint, bearerToken, "tools/call", { name, arguments: args }, validateToolResult);
    },
  };
}

export function validateRemoteMcpEndpoint(raw: string, explicitHostnames: ReadonlySet<string> = new Set()): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemoteMcpError("remote_mcp_invalid_endpoint");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    url.search || url.hash || url.origin === "null"
  ) {
    throw new RemoteMcpError("remote_mcp_invalid_endpoint");
  }

  const hostname = normalizeParsedHostname(url.hostname);
  if (isForbiddenHostname(hostname)) throw new RemoteMcpError("remote_mcp_host_not_allowed");
  if (!isOneLevelOperiaHost(hostname) && !explicitHostnames.has(hostname)) {
    throw new RemoteMcpError("remote_mcp_host_not_allowed");
  }
  url.hostname = hostname;
  return url;
}

function normalizeAllowedHostnames(values: ReadonlyArray<string>): Set<string> {
  const hostnames = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") throw new RemoteMcpError("remote_mcp_invalid_allowed_hostname");
    const candidate = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!candidate || candidate.includes("*") || candidate.includes(":") || candidate.includes("/") || candidate.includes("@")) {
      throw new RemoteMcpError("remote_mcp_invalid_allowed_hostname");
    }
    if (!HOSTNAME_PATTERN.test(candidate) || isForbiddenHostname(candidate)) {
      throw new RemoteMcpError("remote_mcp_invalid_allowed_hostname");
    }
    hostnames.add(candidate);
  }
  return hostnames;
}

function normalizeParsedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isOneLevelOperiaHost(hostname: string): boolean {
  const labels = hostname.split(".");
  return labels.length === 3 && labels[1] === "operia" && labels[2] === "com";
}

function isForbiddenHostname(hostname: string): boolean {
  if (!hostname || FORBIDDEN_HOSTNAMES.has(hostname) || FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  if (!hostname.includes(".") || hostname.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname === "0.0.0.0" || hostname.startsWith("127.") || hostname.startsWith("169.254.")) return true;
  return !HOSTNAME_PATTERN.test(hostname);
}

function validateBearer(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new RemoteMcpError("remote_mcp_invalid_bearer");
  }
  return value;
}

async function request(
  fetcher: typeof fetch,
  endpoint: URL,
  bearerToken: string | undefined,
  method: "tools/list" | "tools/call",
  params: Record<string, unknown>,
  validateResult: (value: unknown) => void,
): Promise<unknown> {
  const id = `mcp_${crypto.randomUUID()}`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort("remote_mcp_timeout");
  }, REMOTE_MCP_TIMEOUT_MS);

  try {
    const headers = new Headers({ accept: "application/json", "cache-control": "no-store", "content-type": "application/json" });
    if (bearerToken !== undefined) headers.set("authorization", `Bearer ${bearerToken}`);
    const response = await fetcher(endpoint.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
      redirect: "error",
    });

    if (!response.ok) throw new RemoteMcpError("remote_mcp_http_error", { status: response.status });
    if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
      throw new RemoteMcpError("remote_mcp_invalid_content_type", { status: response.status });
    }

    const text = await readBoundedBody(response);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new RemoteMcpError("remote_mcp_invalid_json", { cause: error });
    }
    validateJsonRpcResponse(payload, id, validateResult);
    return payload;
  } catch (error) {
    if (timedOut || controller.signal.aborted) throw new RemoteMcpError("remote_mcp_timeout", { cause: error });
    if (error instanceof RemoteMcpError) throw error;
    throw new RemoteMcpError("remote_mcp_network_error", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > REMOTE_MCP_MAX_RESPONSE_BYTES) {
    throw new RemoteMcpError("remote_mcp_response_too_large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > REMOTE_MCP_MAX_RESPONSE_BYTES) {
        await reader.cancel("remote_mcp_response_too_large");
        throw new RemoteMcpError("remote_mcp_response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof RemoteMcpError) throw error;
    throw new RemoteMcpError("remote_mcp_invalid_json", { cause: error });
  } finally {
    reader.releaseLock();
  }
}

function validateJsonRpcResponse(payload: unknown, id: string, validateResult: (value: unknown) => void): void {
  if (!isPlainObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== id) {
    throw new RemoteMcpError("remote_mcp_invalid_jsonrpc");
  }
  const hasResult = Object.prototype.hasOwnProperty.call(payload, "result");
  const hasError = Object.prototype.hasOwnProperty.call(payload, "error");
  if (hasResult === hasError) throw new RemoteMcpError("remote_mcp_invalid_jsonrpc");
  if (hasError) {
    if (!isPlainObject(payload.error) || !Number.isInteger(payload.error.code) || typeof payload.error.message !== "string") {
      throw new RemoteMcpError("remote_mcp_invalid_jsonrpc");
    }
    throw new RemoteMcpError("remote_mcp_rpc_error", { rpcCode: payload.error.code as number });
  }
  validateResult(payload.result);
}

function validateToolsList(value: unknown): void {
  if (!isPlainObject(value) || !Array.isArray(value.tools)) throw new RemoteMcpError("remote_mcp_invalid_tools_list");
  for (const tool of value.tools) {
    if (!isPlainObject(tool) || typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name)) {
      throw new RemoteMcpError("remote_mcp_invalid_tools_list");
    }
    if (tool.description !== undefined && typeof tool.description !== "string") throw new RemoteMcpError("remote_mcp_invalid_tools_list");
    if (!isPlainObject(tool.inputSchema)) throw new RemoteMcpError("remote_mcp_invalid_tools_list");
    if (tool.outputSchema !== undefined && !isPlainObject(tool.outputSchema)) throw new RemoteMcpError("remote_mcp_invalid_tools_list");
  }
  if (value.nextCursor !== undefined && typeof value.nextCursor !== "string") throw new RemoteMcpError("remote_mcp_invalid_tools_list");
}

function validateToolResult(value: unknown): void {
  if (!isPlainObject(value) || !Array.isArray(value.content)) throw new RemoteMcpError("remote_mcp_invalid_tool_result");
  if (value.isError !== undefined && typeof value.isError !== "boolean") throw new RemoteMcpError("remote_mcp_invalid_tool_result");
  if (value.structuredContent !== undefined && !isPlainObject(value.structuredContent)) {
    throw new RemoteMcpError("remote_mcp_invalid_tool_result");
  }
  for (const item of value.content) {
    if (!isPlainObject(item) || typeof item.type !== "string" || item.type.length < 1) {
      throw new RemoteMcpError("remote_mcp_invalid_tool_result");
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
