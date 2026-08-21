import type { RiskLevel } from "../../agent/types";
import type { ProductionCatalog } from "./productionAgentGatewayClient";
import {
  runRecordedThinkShadow,
  type RecordedSanitizedThinkTrace,
  type ThinkShadowPlan,
  type ThinkShadowResult,
} from "./shadow";

export type ProductionSdkShadowObservation = {
  status: "disabled" | "shadowed" | "incompatible" | "error";
  result: ThinkShadowResult | null;
  errorCode: string | null;
};

type ShadowableThinkResult = {
  status: string;
  toolCalls: number;
  codeModeCalls: number;
  skillCalls: number;
  toolKeys: string[];
  toolErrors: string[];
  pendingApprovals: unknown[];
  pendingSdkApprovals: unknown[];
};

type SnapshotDescriptor = {
  toolKey: string;
  riskClass: RiskLevel;
  executable: boolean;
  requiresConfirmation: boolean;
  mayCost: boolean;
};

export type ProductionSdkShadowSnapshot =
  | { enabled: false }
  | {
      enabled: true;
      compatible: boolean;
      errorCode: string | null;
      requestId: string;
      contextProjectionHash: string;
      result: {
        status: string;
        toolCalls: number;
        codeModeCalls: number;
        skillCalls: number;
        toolKeys: string[];
        toolErrorCount: number;
        pendingApprovalCount: number;
      };
      catalog: null | {
        catalogRevision: string;
        snapshotHash: string;
        policyVersion: string;
        descriptorCount: number;
        descriptors: SnapshotDescriptor[];
      };
    };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/;
const MAX_TOOL_KEYS = 8;
const MAX_CATALOG_DESCRIPTORS = 256;

/**
 * Capture only bounded, metadata-only facts while still inside the Think DO.
 * The actual comparison runs later in Memory's best-effort telemetry path.
 */
export function captureProductionSdkShadowSnapshot(input: {
  enabled: boolean;
  requestId: string;
  contextProjectionHash: string;
  result: ShadowableThinkResult;
  catalog: ProductionCatalog | null;
}): ProductionSdkShadowSnapshot {
  if (!input.enabled) return { enabled: false };
  const rawKeys = [...new Set(input.result.toolKeys)];
  const toolKeys = rawKeys.filter((key) => TOOL_KEY.test(key)).slice(0, MAX_TOOL_KEYS);
  let compatible = rawKeys.length <= MAX_TOOL_KEYS && toolKeys.length === rawKeys.length
    && !(input.result.toolCalls > 0 && toolKeys.length === 0);
  let errorCode = compatible ? null : "sdk_shadow_trace_incompatible";
  let catalog: Extract<ProductionSdkShadowSnapshot, { enabled: true }>["catalog"] = null;
  if (input.catalog) {
    if (input.catalog.descriptors.length > MAX_CATALOG_DESCRIPTORS) {
      compatible = false;
      errorCode = "sdk_shadow_catalog_too_large";
    } else {
      const selectedKeys = new Set(toolKeys);
      const descriptors: SnapshotDescriptor[] = [];
      for (const descriptor of input.catalog.descriptors) {
        if (!selectedKeys.has(descriptor.toolKey)) continue;
        descriptors.push({
          toolKey: descriptor.toolKey,
          riskClass: descriptor.riskClass,
          executable: descriptor.executable,
          requiresConfirmation: descriptor.requiresConfirmation,
          mayCost: descriptor.mayCost,
        });
      }
      catalog = {
        catalogRevision: input.catalog.catalogRevision,
        snapshotHash: input.catalog.snapshotHash,
        policyVersion: input.catalog.policyVersion,
        descriptorCount: input.catalog.descriptors.length,
        descriptors,
      };
    }
  }
  return {
    enabled: true,
    compatible,
    errorCode,
    requestId: input.requestId,
    contextProjectionHash: input.contextProjectionHash,
    result: {
      status: input.result.status,
      toolCalls: input.result.toolCalls,
      codeModeCalls: input.result.codeModeCalls,
      skillCalls: input.result.skillCalls,
      toolKeys,
      toolErrorCount: input.result.toolErrors.length,
      pendingApprovalCount: input.result.pendingApprovals.length + input.result.pendingSdkApprovals.length,
    },
    catalog,
  };
}

export async function observeProductionSdkShadow(
  input: ProductionSdkShadowSnapshot,
): Promise<ProductionSdkShadowObservation> {
  if (!input.enabled) return { status: "disabled", result: null, errorCode: null };
  try {
    const trace = await productionTrace(input);
    const result = await runRecordedThinkShadow({ compatible: input.compatible, enabled: true, trace });
    return { status: result.status, result, errorCode: input.errorCode };
  } catch (error) {
    return {
      status: "error",
      result: null,
      errorCode: boundedError(error, "sdk_shadow_projection_failed"),
    };
  }
}

async function productionTrace(
  input: Extract<ProductionSdkShadowSnapshot, { enabled: true }>,
): Promise<RecordedSanitizedThinkTrace> {
  if (!input.contextProjectionHash || input.contextProjectionHash.length > 256) {
    throw new Error("sdk_shadow_context_hash_invalid");
  }
  const contextProjectionHash = HASH.test(input.contextProjectionHash)
    ? input.contextProjectionHash.replace(/^sha256:/, "")
    : await sha256Hex(input.contextProjectionHash);
  const requestId = IDENTIFIER.test(input.requestId)
    ? input.requestId
    : `request-${(await sha256Hex(input.requestId)).slice(0, 24)}`;
  const descriptors = new Map((input.catalog?.descriptors ?? []).map((item) => [item.toolKey, item]));
  const candidates = input.result.toolKeys.map((toolKey) => {
    const descriptor = descriptors.get(toolKey);
    return {
      toolKey,
      riskClass: normalizeRisk(descriptor?.riskClass),
      executable: descriptor?.executable ?? builtInExecutable(toolKey),
      argumentSchemaValid: input.result.toolErrorCount === 0,
      requiresFreshAuth: descriptor?.requiresConfirmation ?? false,
      mayCost: descriptor?.mayCost ?? false,
    };
  });
  const legacyRoute = legacyRouteFor(input.result);
  const expectedApproval = input.result.pendingApprovalCount > 0 ? "once" as const : "none" as const;
  const catalogTokenEstimate = Math.min(8_000, (input.catalog?.descriptorCount ?? 0) * 48);
  const legacy = plan({
    route: legacyRoute,
    toolKeys: input.result.toolKeys,
    argumentSchemaValid: input.result.toolErrorCount === 0,
    expectedApproval,
    stepCount: Math.min(16, Math.max(legacyRoute === "answer_only" ? 0 : 1, input.result.toolCalls)),
    catalogTokenEstimate,
  });
  const instructionClass = legacyRoute === "answer_only" || input.result.toolKeys.length === 0
    ? "answer_only" as const
    : legacyRoute === "sandbox"
      ? "sandbox_compute" as const
      : input.result.toolKeys.length > 1
        ? "multi_tool" as const
        : "single_tool" as const;
  return {
    traceVersion: 1,
    source: "recorded_sanitized_trace",
    traceId: `sdk-shadow-${(await sha256Hex(`${requestId}:${contextProjectionHash}`)).slice(0, 24)}`,
    requestId,
    recordedAt: new Date().toISOString(),
    instructionClass,
    requestedToolKeys: instructionClass === "answer_only" ? [] : input.result.toolKeys,
    dependencyCount: instructionClass === "answer_only" ? 0 : input.result.toolKeys.length,
    requiresShell: instructionClass === "sandbox_compute",
    requiresRenderedUi: false,
    progressiveCatalogTokenEstimate: catalogTokenEstimate,
    candidates: instructionClass === "answer_only" ? [] : candidates,
    legacy: instructionClass === "answer_only" && legacy.route !== "answer_only"
      ? plan({ route: "answer_only", catalogTokenEstimate })
      : legacy,
    pins: {
      catalogRevision: input.catalog?.catalogRevision ?? "catalog-not-loaded",
      catalogSnapshotHash: input.catalog?.snapshotHash ?? await sha256Hex("catalog-not-loaded"),
      policyVersion: input.catalog?.policyVersion ?? "policy-not-loaded",
      thinkHarnessVersion: "sdk-first-shadow-v1",
      memoryContextProjectionHash: contextProjectionHash,
    },
  };
}

function legacyRouteFor(result: Extract<ProductionSdkShadowSnapshot, { enabled: true }>["result"]): ThinkShadowPlan["route"] {
  if (result.toolCalls === 0) return "answer_only";
  if (result.codeModeCalls > 0) return "codemode";
  if (result.toolKeys.some((key) => key.startsWith("sandbox/") || key.startsWith("sandbox-codemode/"))) return "sandbox";
  return "direct";
}

function plan(input: {
  route: ThinkShadowPlan["route"];
  toolKeys?: string[];
  argumentSchemaValid?: boolean;
  expectedApproval?: ThinkShadowPlan["expectedApproval"];
  stepCount?: number;
  catalogTokenEstimate: number;
}): ThinkShadowPlan {
  return {
    route: input.route,
    toolKeys: input.toolKeys ?? [],
    argumentSchemaValid: input.argumentSchemaValid ?? true,
    requiresCodeMode: input.route === "codemode",
    requiresSandbox: input.route === "sandbox",
    expectedApproval: input.expectedApproval ?? "none",
    stepCount: input.stepCount ?? 0,
    catalogTokenEstimate: input.catalogTokenEstimate,
  };
}

function builtInExecutable(toolKey: string): boolean {
  return toolKey === "router/search" || toolKey === "router/describe"
    || toolKey === "skills/search" || toolKey.startsWith("skills/activate:")
    || toolKey === "operia-observer/system_status";
}

function normalizeRisk(value: RiskLevel | undefined): RecordedSanitizedThinkTrace["candidates"][number]["riskClass"] {
  return value === "write" || value === "message" || value === "device" || value === "purchase" || value === "delete"
    ? value : "read";
}

function boundedError(error: unknown, fallback: string): string {
  return String(error instanceof Error ? error.message : error || fallback)
    .replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 160) || fallback;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
