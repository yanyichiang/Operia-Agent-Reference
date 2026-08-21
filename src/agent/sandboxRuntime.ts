import { ContainerProxy, Sandbox, getSandbox, type ExecutionSession } from "@cloudflare/sandbox";
import { getAgentByName } from "agents";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import type { AgentEnv } from "./types";
import { mintSandboxCapability, newSandboxCapabilityNonce, verifySandboxCapability, type SandboxCapabilityScope } from "./sandboxCapability";
import {
  SANDBOX_EXEC_CAPTURE_BYTES,
  SANDBOX_MAX_COMMAND_MS,
  SANDBOX_POLICY_VERSION,
  deriveSandboxIsolationId,
  evaluateSandboxPublicEgress,
  normalizeSandboxExecutionInput,
  readBoundedSandboxResponse,
  sanitizeSandboxOutboundHeaders,
  truncateSandboxExecutionOutput,
} from "./sandboxPolicy";

export { ContainerProxy };

const CONNECTOR_HOST = "connector.operia.test";
const DEFAULT_RUNTIME_NAME = "primary";

function withSandboxDeadline<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function sandboxRuntimeName(env: SandboxWorkerEnv): string {
  const configured = env.AGENT_SANDBOX_RUNTIME_NAME?.trim();
  return configured && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(configured) ? configured : DEFAULT_RUNTIME_NAME;
}

export type SandboxWorkerEnv = AgentEnv & {
  OPERIA_AGENT: DurableObjectNamespace;
  OPERIA_SANDBOX: DurableObjectNamespace<<Sandbox>>;
  SANDBOX_CAPABILITY_SIGNING_SECRET?: string;
};

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (!match) throw new Error("sandbox_capability_missing");
  return match[1];
}

async function connectorOutbound(request: Request, env: SandboxWorkerEnv, ctx: OutboundHandlerContext): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const secret = env.SANDBOX_CAPABILITY_SIGNING_SECRET?.trim();
  const serviceBearer = env.AGENT_CONTEXT_SERVICE_BEARER?.trim();
  if (!secret || !serviceBearer) return new Response("sandbox connector unavailable", { status: 503 });
  let claims;
  try { claims = await verifySandboxCapability(secret, bearerToken(request)); }
  catch (error) { return new Response(error instanceof Error ? error.message : "sandbox capability denied", { status: 403 }); }
  const payload = await request.arrayBuffer();
  if (payload.byteLength > 64 * 1024) return new Response("sandbox connector payload too large", { status: 413 });
  const runtime = await getAgentByName(env.OPERIA_AGENT as never, sandboxRuntimeName(env));
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${serviceBearer}`,
    "x-sandbox-capability": bearerToken(request),
    "x-sandbox-id": claims.sandboxId,
    "x-container-instance-id": ctx.containerId,
    "x-sandbox-policy": SANDBOX_POLICY_VERSION,
  });
  console.log("sandbox.egress", { decision: "connector", taskId: claims.taskId, method: request.method, host: CONNECTOR_HOST, bytes: payload.byteLength });
  return runtime.fetch(new Request("https://<AGENT_SERVICE>.internal/service/sandbox/connector", { method: "POST", headers, body: payload }));
}

async function publicOutbound(request: Request, env: SandboxWorkerEnv): Promise<Response> {
  if (env.AGENT_SANDBOX_P2_READ_ENABLED?.trim().toLowerCase() !== "true") {
    return new Response("sandbox_p2_read_disabled", { status: 403, headers: { "cache-control": "no-store" } });
  }
  const decision = evaluateSandboxPublicEgress(request);
  const url = (() => { try { return new URL(request.url); } catch { return null; } })();
  if (!decision.ok) {
    console.warn("sandbox.egress", { decision: "deny", code: decision.code, method: request.method, origin: url?.origin ?? "invalid" });
    return new Response(decision.code, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const upstream = await fetch(decision.url, { method: decision.method, headers: sanitizeSandboxOutboundHeaders(request.headers), redirect: "manual" });
  const bounded = await readBoundedSandboxResponse(upstream);
  console.log("sandbox.egress", { decision: "allow", method: decision.method, origin: decision.url.origin, status: bounded.status, bytes: bounded.headers.get("content-length") });
  return bounded;
}

// Staging canary entrypoints call the exact production handler without
// exposing a public route or bypassing its flag, SSRF, method, header, and
// response-size policy. Container-to-handler wiring is verified separately.
export async function runSandboxPublicOutboundCanary(request: Request, env: SandboxWorkerEnv): Promise<Response> {
  return publicOutbound(request, env);
}

export class <Sandbox> extends Sandbox<SandboxWorkerEnv> {
  sleepAfter = "10m";
  // Public web remains available by default at the application layer through
  // the handler below. Raw container internet is disabled so non-HTTP ports
  // cannot bypass method, SSRF, size, audit, and feature-flag checks.
  enableInternet = false;
  interceptHttps = true;
  deniedHosts = ["localhost", "*.localhost", "*.local", "*.internal", "127.*", "10.*", "169.254.*", "172.16.*", "172.17.*", "172.18.*", "172.19.*", "172.2?.*", "172.30.*", "172.31.*", "192.168.*"];
}

// These assignments must stay outside the class body. Container exposes
// inherited static setters that populate handler registries in every Worker
// execution context. Class static fields would instead define own data
// properties, bypass those setters, and make ContainerProxy default-deny 520.
<Sandbox>.outboundByHost = { [CONNECTOR_HOST]: connectorOutbound };
<Sandbox>.outbound = publicOutbound;

export type Open<Sandbox>TaskInput = {
  ownerId: string;
  taskId: string;
  environment: "candidate" | "qa" | "production";
  scopes: SandboxCapabilityScope[];
};

export async function open<Sandbox>Task(env: SandboxWorkerEnv, input: Open<Sandbox>TaskInput): Promise<{
  sandboxId: string;
  sessionId: string;
  session: ExecutionSession;
  expiresAt: number;
}> {
  const sandboxId = await deriveSandboxIsolationId(input.ownerId, input.taskId, input.environment);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 15 * 60_000;
  let token: string | null = null;
  if (input.scopes.length > 0) {
    const secret = env.SANDBOX_CAPABILITY_SIGNING_SECRET?.trim();
    if (!secret) throw new Error("sandbox_capability_secret_missing");
    token = await mintSandboxCapability(secret, {
      version: 1,
      ownerId: input.ownerId,
      taskId: input.taskId,
      environment: input.environment,
      sandboxId,
      policyVersion: SANDBOX_POLICY_VERSION,
      scopes: input.scopes,
      issuedAt,
      expiresAt,
      nonce: newSandboxCapabilityNonce(),
    });
  }
  const sandbox = getSandbox(env.OPERIA_SANDBOX, sandboxId, {
    sleepAfter: "10m",
    enableDefaultSession: false,
    normalizeId: true,
    transport: "rpc",
    labels: { workload: "operia-task", environment: input.environment },
  });
  const sessionId = `task-${input.taskId.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 64)}-${newSandboxCapabilityNonce().slice(0, 8)}`;
  const session = await sandbox.createSession({
    id: sessionId,
    name: `Operia ${input.environment} task`,
    cwd: "/workspace",
    isolation: true,
    commandTimeoutMs: SANDBOX_MAX_COMMAND_MS,
    env: {
      OPERIA_TASK_ID: input.taskId,
      OPERIA_SANDBOX_POLICY: SANDBOX_POLICY_VERSION,
      ...(token ? {
        OPERIA_CONNECTOR_URL: `https://${CONNECTOR_HOST}`,
        OPERIA_CAPABILITY_TOKEN: token,
      } : {}),
    },
  });
  return { sandboxId, sessionId, session, expiresAt };
}

export type <Sandbox>ExecutionResult = {
  kind: "sandbox_execution";
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  durationMs: number;
  timeoutMs: number;
  policyVersion: typeof SANDBOX_POLICY_VERSION;
  isolation: "owner_task_environment";
  connectorCapabilityExposed: false;
  workspaceDiscarded: true;
  cleanup: { processesKilled: number; sessionDeleted: boolean; sandboxDestroyed: boolean };
};

export async function execute<Sandbox>Script(
  env: SandboxWorkerEnv,
  input: {
    ownerId: string;
    taskId: string;
    environment: "candidate" | "qa" | "production";
    args: Record<string, unknown>;
  },
  signal: AbortSignal,
): Promise<<Sandbox>ExecutionResult> {
  const normalized = normalizeSandboxExecutionInput(input.args);
  const sandboxId = await deriveSandboxIsolationId(input.ownerId, input.taskId, input.environment);
  const sandbox = getSandbox(env.OPERIA_SANDBOX, sandboxId, {
    sleepAfter: "10m",
    enableDefaultSession: false,
    normalizeId: true,
    transport: "rpc",
    labels: { workload: "operia-task", environment: input.environment },
  });
  const opened = await withSandboxDeadline(open<Sandbox>Task(env, {
    ownerId: input.ownerId,
    taskId: input.taskId,
    environment: input.environment,
    scopes: [],
  }), SANDBOX_MAX_COMMAND_MS, "sandbox_execution_session_open_timeout")
    .catch(async (error) => {
      // A timed-out createSession may still complete behind the RPC deadline.
      // Destroy the deterministic task sandbox so a failed open cannot retain
      // the account's limited Container capacity.
      await withSandboxDeadline(sandbox.destroy(), 10_000, "sandbox_execution_open_cleanup_timeout").catch(() => undefined);
      if (error instanceof Error && error.message.startsWith("sandbox_execution_")) throw error;
      throw new Error("sandbox_execution_session_open_failed");
    });
  const scriptPath = "/workspace/.operia-task.sh";
  const wrapperPath = "/workspace/.operia-wrapper.sh";
  const stdoutPath = "/workspace/.operia-stdout";
  const stderrPath = "/workspace/.operia-stderr";
  const exitPath = "/workspace/.operia-exit";
  let execution: Omit<<Sandbox>ExecutionResult, "workspaceDiscarded" | "cleanup"> | null = null;
  let processesKilled = 0;
  let sessionDeleted = false;
  let sandboxDestroyed = false;
  let stage = "script_write";
  try {
    const written = await withSandboxDeadline(
      opened.session.writeFile(scriptPath, normalized.script, { encoding: "utf8" }),
      10_000,
      "sandbox_execution_script_write_timeout",
    );
    if (!written.success) throw new Error("sandbox_execution_script_write_failed");
    stage = "wrapper_write";
    const wrapper = `#!/bin/sh
umask 077
ulimit -f 128
set +e
sh ${scriptPath} >${stdoutPath} 2>${stderrPath}
code=$?
printf "%s" "$code" >${exitPath}
exit 0
`;
    const wrapperWritten = await withSandboxDeadline(
      opened.session.writeFile(wrapperPath, wrapper, { encoding: "utf8" }),
      10_000,
      "sandbox_execution_wrapper_write_timeout",
    );
    if (!wrapperWritten.success) throw new Error("sandbox_execution_wrapper_write_failed");
    stage = "command";
    const started = Date.now();
    if (signal.aborted) throw new DOMException("Task cancelled", "AbortError");
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void opened.session.killAllProcesses().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let wrapperResult: Awaited<ReturnType<ExecutionSession["exec"]>>;
    try {
      wrapperResult = await withSandboxDeadline(
        opened.session.exec(`sh ${wrapperPath}`, { timeout: normalized.timeoutMs }),
        normalized.timeoutMs + 5_000,
        "sandbox_execution_command_timeout",
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (aborted) throw new DOMException("Task cancelled", "AbortError");
    if (!wrapperResult.success) {
      const detail = `${wrapperResult.stdout}\n${wrapperResult.stderr}`.toLowerCase();
      const reason = detail.includes("file size limit") || detail.includes("ulimit")
        ? "resource_limit"
        : detail.includes("syntax error") ? "syntax"
          : detail.includes("not found") ? "not_found"
            : `exit_${Math.max(0, Math.trunc(wrapperResult.exitCode))}`;
      throw new Error(`sandbox_execution_wrapper_${reason}_failed`);
    }
    stage = "output_read";
    const [exitResult, stdoutResult, stderrResult] = await withSandboxDeadline(Promise.all([
      opened.session.readFile(exitPath, { encoding: "utf8" }),
      opened.session.readFile(stdoutPath, { encoding: "utf8" }),
      opened.session.readFile(stderrPath, { encoding: "utf8" }),
    ]), 10_000, "sandbox_execution_output_read_timeout");
    if (!exitResult.success || !stdoutResult.success || !stderrResult.success) {
      throw new Error("sandbox_execution_output_read_failed");
    }
    const exitCode = Number(exitResult.content.trim());
    if (!Number.isSafeInteger(exitCode)) throw new Error("sandbox_execution_exit_code_invalid");
    const stdout = truncateSandboxExecutionOutput(stdoutResult.content, SANDBOX_EXEC_CAPTURE_BYTES);
    const stderr = truncateSandboxExecutionOutput(stderrResult.content, SANDBOX_EXEC_CAPTURE_BYTES);
    execution = {
      kind: "sandbox_execution",
      success: exitCode === 0,
      exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      stdoutBytes: stdout.sourceBytes,
      stderrBytes: stderr.sourceBytes,
      outputTruncated: stdout.truncated || stderr.truncated,
      durationMs: Math.max(1, Date.now() - started),
      timeoutMs: normalized.timeoutMs,
      policyVersion: SANDBOX_POLICY_VERSION,
      isolation: "owner_task_environment",
      connectorCapabilityExposed: false,
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code.startsWith("sandbox_execution_")) throw error;
    throw new Error(`sandbox_execution_${stage}_failed`);
  } finally {
    processesKilled = await withSandboxDeadline(opened.session.killAllProcesses(), 5_000, "sandbox_execution_process_cleanup_timeout").catch(() => 0);
    await withSandboxDeadline(sandbox.deleteSession(opened.sessionId), 5_000, "sandbox_execution_session_delete_timeout")
      .then(() => { sessionDeleted = true; }).catch(() => undefined);
    await withSandboxDeadline(sandbox.destroy(), 10_000, "sandbox_execution_destroy_timeout")
      .then(() => { sandboxDestroyed = true; }).catch(() => undefined);
  }
  if (!execution) throw new Error("sandbox_execution_failed");
  if (!sessionDeleted || !sandboxDestroyed) throw new Error("sandbox_execution_cleanup_incomplete");
  return {
    ...execution,
    workspaceDiscarded: sandboxDestroyed,
    cleanup: { processesKilled, sessionDeleted, sandboxDestroyed },
  };
}
