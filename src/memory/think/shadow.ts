export type ThinkShadowRoute =
  | "answer_only"
  | "direct"
  | "codemode"
  | "sandbox"
  | "unavailable";

export type ThinkShadowRiskClass =
  | "read"
  | "write"
  | "message"
  | "device"
  | "purchase"
  | "delete";

export type ThinkShadowApproval = "none" | "once";

export type ThinkShadowCandidate = {
  toolKey: string;
  riskClass: ThinkShadowRiskClass;
  executable: boolean;
  argumentSchemaValid: boolean;
  requiresFreshAuth: boolean;
  mayCost: boolean;
};

export type ThinkShadowPlan = {
  route: ThinkShadowRoute;
  toolKeys: string[];
  argumentSchemaValid: boolean;
  requiresCodeMode: boolean;
  requiresSandbox: boolean;
  expectedApproval: ThinkShadowApproval;
  stepCount: number;
  catalogTokenEstimate: number;
};

export type RecordedSanitizedThinkTrace = {
  traceVersion: 1;
  source: "recorded_sanitized_trace";
  traceId: string;
  requestId: string;
  recordedAt: string;
  instructionClass:
    | "answer_only"
    | "single_tool"
    | "multi_tool"
    | "sandbox_compute"
    | "rendered_ui";
  requestedToolKeys: string[];
  dependencyCount: number;
  requiresShell: boolean;
  requiresRenderedUi: boolean;
  progressiveCatalogTokenEstimate: number;
  candidates: ThinkShadowCandidate[];
  legacy: ThinkShadowPlan;
  pins: {
    catalogRevision: string;
    catalogSnapshotHash: string;
    policyVersion: string;
    thinkHarnessVersion: string;
    memoryContextProjectionHash: string;
  };
};

export type ThinkShadowComparison = {
  routeMatch: boolean;
  toolKeysMatch: boolean;
  argumentSchemaValidityMatch: boolean;
  codeModeMatch: boolean;
  sandboxMatch: boolean;
  approvalMatch: boolean;
  stepCountMatch: boolean;
  catalogTokenDelta: number;
  allRoutingFieldsMatch: boolean;
};

export type ThinkShadowResult =
  | {
      status: "disabled" | "incompatible";
      traceId: string;
      requestId: string;
      modelCalls: 0;
      toolCalls: 0;
      externalWrites: 0;
    }
  | {
      status: "shadowed";
      shadowRunId: string;
      traceId: string;
      requestId: string;
      source: "recorded_sanitized_trace";
      plan: ThinkShadowPlan;
      comparison: ThinkShadowComparison;
      pins: RecordedSanitizedThinkTrace["pins"];
      modelCalls: 0;
      toolCalls: 0;
      externalWrites: 0;
    };

const ROOT_KEYS = new Set([
  "traceVersion",
  "source",
  "traceId",
  "requestId",
  "recordedAt",
  "instructionClass",
  "requestedToolKeys",
  "dependencyCount",
  "requiresShell",
  "requiresRenderedUi",
  "progressiveCatalogTokenEstimate",
  "candidates",
  "legacy",
  "pins",
]);
const CANDIDATE_KEYS = new Set([
  "toolKey",
  "riskClass",
  "executable",
  "argumentSchemaValid",
  "requiresFreshAuth",
  "mayCost",
]);
const PLAN_KEYS = new Set([
  "route",
  "toolKeys",
  "argumentSchemaValid",
  "requiresCodeMode",
  "requiresSandbox",
  "expectedApproval",
  "stepCount",
  "catalogTokenEstimate",
]);
const PIN_KEYS = new Set([
  "catalogRevision",
  "catalogSnapshotHash",
  "policyVersion",
  "thinkHarnessVersion",
  "memoryContextProjectionHash",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/;
const RISKS = new Set<ThinkShadowRiskClass>(["read", "write", "message", "device", "purchase", "delete"]);
const ROUTES = new Set<ThinkShadowRoute>(["answer_only", "direct", "codemode", "sandbox", "unavailable"]);
const INSTRUCTION_CLASSES = new Set<RecordedSanitizedThinkTrace["instructionClass"]>([
  "answer_only",
  "single_tool",
  "multi_tool",
  "sandbox_compute",
  "rendered_ui",
]);
const FORBIDDEN_TRACE_KEYS = /^(?:prompt|messages?|content|text|instruction|args?|arguments?|results?|secret|credentials?|authorization|cookies?|accessToken|refreshToken|apiKey)$/i;

export function thinkShadowEnabled(env: { MEMORY_THINK_SHADOW_ENABLED?: string }): boolean {
  return env.MEMORY_THINK_SHADOW_ENABLED?.trim().toLowerCase() === "true";
}

export async function runRecordedThinkShadow(input: {
  enabled: boolean;
  compatible: boolean;
  trace: unknown;
}): Promise<ThinkShadowResult> {
  const trace = parseRecordedSanitizedThinkTrace(input.trace);
  if (!input.enabled) return terminal("disabled", trace);
  if (!input.compatible) return terminal("incompatible", trace);

  const plan = deriveThinkShadowPlan(trace);
  const comparison = compareThinkShadowPlan(trace.legacy, plan);
  const shadowRunId = `think_shadow_${(await sha256Hex(stableJson({
    trace,
    plan,
  }))).slice(0, 24)}`;
  return {
    status: "shadowed",
    shadowRunId,
    traceId: trace.traceId,
    requestId: trace.requestId,
    source: trace.source,
    plan,
    comparison,
    pins: structuredClone(trace.pins),
    modelCalls: 0,
    toolCalls: 0,
    externalWrites: 0,
  };
}

export function parseRecordedSanitizedThinkTrace(value: unknown): RecordedSanitizedThinkTrace {
  assertNoForbiddenTraceKeys(value);
  const root = exactRecord(value, ROOT_KEYS, "think_shadow_trace_invalid");
  if (
    root.traceVersion !== 1 ||
    root.source !== "recorded_sanitized_trace" ||
    !identifier(root.traceId) ||
    !identifier(root.requestId) ||
    !validIsoDate(root.recordedAt) ||
    typeof root.instructionClass !== "string" ||
    !INSTRUCTION_CLASSES.has(root.instructionClass as RecordedSanitizedThinkTrace["instructionClass"]) ||
    !boundedInteger(root.dependencyCount, 0, 8) ||
    typeof root.requiresShell !== "boolean" ||
    typeof root.requiresRenderedUi !== "boolean" ||
    !boundedInteger(root.progressiveCatalogTokenEstimate, 0, 8_000)
  ) {
    throw new Error("think_shadow_trace_invalid");
  }

  const requestedToolKeys = toolKeys(root.requestedToolKeys, 8, "think_shadow_requested_tools_invalid");
  if (!Array.isArray(root.candidates) || root.candidates.length > 32) {
    throw new Error("think_shadow_candidates_invalid");
  }
  const seenCandidates = new Set<string>();
  const candidates = root.candidates.map((value) => {
    const candidate = exactRecord(value, CANDIDATE_KEYS, "think_shadow_candidate_invalid");
    if (
      typeof candidate.toolKey !== "string" ||
      !TOOL_KEY.test(candidate.toolKey) ||
      seenCandidates.has(candidate.toolKey) ||
      typeof candidate.riskClass !== "string" ||
      !RISKS.has(candidate.riskClass as ThinkShadowRiskClass) ||
      typeof candidate.executable !== "boolean" ||
      typeof candidate.argumentSchemaValid !== "boolean" ||
      typeof candidate.requiresFreshAuth !== "boolean" ||
      typeof candidate.mayCost !== "boolean"
    ) {
      throw new Error("think_shadow_candidate_invalid");
    }
    seenCandidates.add(candidate.toolKey);
    return {
      toolKey: candidate.toolKey,
      riskClass: candidate.riskClass as ThinkShadowRiskClass,
      executable: candidate.executable,
      argumentSchemaValid: candidate.argumentSchemaValid,
      requiresFreshAuth: candidate.requiresFreshAuth,
      mayCost: candidate.mayCost,
    };
  });
  if (requestedToolKeys.some((toolKey) => !seenCandidates.has(toolKey))) {
    throw new Error("think_shadow_requested_tool_missing");
  }

  const legacy = parsePlan(root.legacy);
  const pins = exactRecord(root.pins, PIN_KEYS, "think_shadow_pins_invalid");
  if (
    !revision(pins.catalogRevision) ||
    !hash(pins.catalogSnapshotHash) ||
    !revision(pins.policyVersion) ||
    !revision(pins.thinkHarnessVersion) ||
    !hash(pins.memoryContextProjectionHash)
  ) {
    throw new Error("think_shadow_pins_invalid");
  }

  const instructionClass = root.instructionClass as RecordedSanitizedThinkTrace["instructionClass"];
  assertInstructionProjection({
    instructionClass,
    requestedToolKeys,
    dependencyCount: root.dependencyCount as number,
    requiresShell: root.requiresShell,
    requiresRenderedUi: root.requiresRenderedUi,
  });

  return {
    traceVersion: 1,
    source: "recorded_sanitized_trace",
    traceId: root.traceId as string,
    requestId: root.requestId as string,
    recordedAt: root.recordedAt as string,
    instructionClass,
    requestedToolKeys,
    dependencyCount: root.dependencyCount as number,
    requiresShell: root.requiresShell,
    requiresRenderedUi: root.requiresRenderedUi,
    progressiveCatalogTokenEstimate: root.progressiveCatalogTokenEstimate as number,
    candidates,
    legacy,
    pins: {
      catalogRevision: pins.catalogRevision as string,
      catalogSnapshotHash: pins.catalogSnapshotHash as string,
      policyVersion: pins.policyVersion as string,
      thinkHarnessVersion: pins.thinkHarnessVersion as string,
      memoryContextProjectionHash: pins.memoryContextProjectionHash as string,
    },
  };
}

export function deriveThinkShadowPlan(trace: RecordedSanitizedThinkTrace): ThinkShadowPlan {
  if (trace.instructionClass === "answer_only") {
    return plan("answer_only", [], true, "none", 0, trace.progressiveCatalogTokenEstimate);
  }
  const candidatesByKey = new Map(trace.candidates.map((candidate) => [candidate.toolKey, candidate]));
  const selected = trace.requestedToolKeys.map((toolKey) => candidatesByKey.get(toolKey)!);
  const argumentSchemaValid = selected.every((candidate) => candidate.argumentSchemaValid);
  const unavailable = selected.some((candidate) => !candidate.executable) || !argumentSchemaValid;
  const expectedApproval = selected.some((candidate) =>
    candidate.riskClass !== "read" || candidate.requiresFreshAuth || candidate.mayCost
  ) ? "once" : "none";

  if (trace.requiresRenderedUi || trace.instructionClass === "rendered_ui" || unavailable) {
    return plan("unavailable", trace.requestedToolKeys, argumentSchemaValid, expectedApproval, 0, trace.progressiveCatalogTokenEstimate);
  }
  if (trace.requiresShell || trace.instructionClass === "sandbox_compute") {
    return plan("sandbox", trace.requestedToolKeys, argumentSchemaValid, expectedApproval, 1, trace.progressiveCatalogTokenEstimate);
  }
  if (
    trace.instructionClass === "multi_tool" ||
    trace.dependencyCount > 1 ||
    trace.requestedToolKeys.length > 1
  ) {
    return plan(
      "codemode",
      trace.requestedToolKeys,
      argumentSchemaValid,
      expectedApproval,
      trace.requestedToolKeys.length + 1,
      trace.progressiveCatalogTokenEstimate,
    );
  }
  return plan("direct", trace.requestedToolKeys, argumentSchemaValid, expectedApproval, 1, trace.progressiveCatalogTokenEstimate);
}

export function compareThinkShadowPlan(legacy: ThinkShadowPlan, shadow: ThinkShadowPlan): ThinkShadowComparison {
  const routeMatch = legacy.route === shadow.route;
  const toolKeysMatch = stableJson(legacy.toolKeys) === stableJson(shadow.toolKeys);
  const argumentSchemaValidityMatch = legacy.argumentSchemaValid === shadow.argumentSchemaValid;
  const codeModeMatch = legacy.requiresCodeMode === shadow.requiresCodeMode;
  const sandboxMatch = legacy.requiresSandbox === shadow.requiresSandbox;
  const approvalMatch = legacy.expectedApproval === shadow.expectedApproval;
  const stepCountMatch = legacy.stepCount === shadow.stepCount;
  return {
    routeMatch,
    toolKeysMatch,
    argumentSchemaValidityMatch,
    codeModeMatch,
    sandboxMatch,
    approvalMatch,
    stepCountMatch,
    catalogTokenDelta: shadow.catalogTokenEstimate - legacy.catalogTokenEstimate,
    allRoutingFieldsMatch: routeMatch &&
      toolKeysMatch &&
      argumentSchemaValidityMatch &&
      codeModeMatch &&
      sandboxMatch &&
      approvalMatch &&
      stepCountMatch,
  };
}

function plan(
  route: ThinkShadowRoute,
  toolKeysValue: string[],
  argumentSchemaValid: boolean,
  expectedApproval: ThinkShadowApproval,
  stepCount: number,
  catalogTokenEstimate: number,
): ThinkShadowPlan {
  return {
    route,
    toolKeys: [...toolKeysValue],
    argumentSchemaValid,
    requiresCodeMode: route === "codemode",
    requiresSandbox: route === "sandbox",
    expectedApproval,
    stepCount,
    catalogTokenEstimate,
  };
}

function parsePlan(value: unknown): ThinkShadowPlan {
  const input = exactRecord(value, PLAN_KEYS, "think_shadow_plan_invalid");
  if (
    typeof input.route !== "string" ||
    !ROUTES.has(input.route as ThinkShadowRoute) ||
    typeof input.argumentSchemaValid !== "boolean" ||
    typeof input.requiresCodeMode !== "boolean" ||
    typeof input.requiresSandbox !== "boolean" ||
    (input.expectedApproval !== "none" && input.expectedApproval !== "once") ||
    !boundedInteger(input.stepCount, 0, 16) ||
    !boundedInteger(input.catalogTokenEstimate, 0, 32_000)
  ) {
    throw new Error("think_shadow_plan_invalid");
  }
  const route = input.route as ThinkShadowRoute;
  if (input.requiresCodeMode !== (route === "codemode") || input.requiresSandbox !== (route === "sandbox")) {
    throw new Error("think_shadow_plan_invalid");
  }
  return {
    route,
    toolKeys: toolKeys(input.toolKeys, 8, "think_shadow_plan_tools_invalid"),
    argumentSchemaValid: input.argumentSchemaValid,
    requiresCodeMode: input.requiresCodeMode,
    requiresSandbox: input.requiresSandbox,
    expectedApproval: input.expectedApproval,
    stepCount: input.stepCount,
    catalogTokenEstimate: input.catalogTokenEstimate,
  };
}

function terminal(
  status: "disabled" | "incompatible",
  trace: RecordedSanitizedThinkTrace,
): ThinkShadowResult {
  return {
    status,
    traceId: trace.traceId,
    requestId: trace.requestId,
    modelCalls: 0,
    toolCalls: 0,
    externalWrites: 0,
  };
}

function assertInstructionProjection(input: {
  instructionClass: RecordedSanitizedThinkTrace["instructionClass"];
  requestedToolKeys: string[];
  dependencyCount: number;
  requiresShell: boolean;
  requiresRenderedUi: boolean;
}): void {
  const count = input.requestedToolKeys.length;
  if (input.instructionClass === "answer_only") {
    if (count !== 0 || input.dependencyCount !== 0 || input.requiresShell || input.requiresRenderedUi) {
      throw new Error("think_shadow_instruction_projection_invalid");
    }
    return;
  }
  if (input.instructionClass === "single_tool") {
    if (count !== 1 || input.dependencyCount !== 1 || input.requiresShell || input.requiresRenderedUi) {
      throw new Error("think_shadow_instruction_projection_invalid");
    }
    return;
  }
  if (input.instructionClass === "multi_tool") {
    if (
      count < 2 ||
      input.dependencyCount < 2 ||
      input.dependencyCount > count ||
      input.requiresShell ||
      input.requiresRenderedUi
    ) {
      throw new Error("think_shadow_instruction_projection_invalid");
    }
    return;
  }
  if (input.instructionClass === "sandbox_compute") {
    if (count < 1 || input.dependencyCount < 1 || input.dependencyCount > count || !input.requiresShell || input.requiresRenderedUi) {
      throw new Error("think_shadow_instruction_projection_invalid");
    }
    return;
  }
  if (count < 1 || input.dependencyCount < 1 || input.dependencyCount > count || input.requiresShell || !input.requiresRenderedUi) {
    throw new Error("think_shadow_instruction_projection_invalid");
  }
}

function exactRecord(value: unknown, allowed: ReadonlySet<string>, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error(code);
  return record;
}

function toolKeys(value: unknown, limit: number, code: string): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(code);
  const output = value.map((item) => {
    if (typeof item !== "string" || !TOOL_KEY.test(item)) throw new Error(code);
    return item;
  });
  if (new Set(output).size !== output.length) throw new Error(code);
  return output;
}

function assertNoForbiddenTraceKeys(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error("think_shadow_trace_too_deep");
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenTraceKeys(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_TRACE_KEYS.test(key)) throw new Error("think_shadow_sensitive_field_forbidden");
    assertNoForbiddenTraceKeys(item, depth + 1);
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function revision(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function hash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return typeof serialized === "string" ? serialized : "null";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
