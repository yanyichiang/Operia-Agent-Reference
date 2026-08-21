export const THINK_GATE_A_VERSIONS = Object.freeze({
  harness: "0.15.0",
  agents: "0.19.0",
  codemode: "0.5.1",
  aiSdkMajor: 7,
});

export type OperiaToolLoopRoute = "legacy" | "think";

export type ThinkApprovalProjection = {
  approvalRef: string;
  action: string;
  summary: string;
  risk: "low" | "medium" | "high";
  permissions: string[];
};

export function selectOperiaToolLoop(input: {
  thinkEnabled: boolean;
  thinkCompatible: boolean;
}): OperiaToolLoopRoute {
  return input.thinkEnabled && input.thinkCompatible ? "think" : "legacy";
}

export function normalizeThinkResolution(value: unknown): {
  status: "resolved" | "already_resolved" | "error";
  detail?: string;
} {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.status === "error") {
      const detail = String(record.error ?? record.message ?? "already resolved");
      if (/already|no longer pending|unknown|resolved/i.test(detail)) {
        return { status: "already_resolved", detail };
      }
      return { status: "error", detail };
    }
  }
  return { status: "resolved" };
}

export async function stableApprovalRef(executionId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`operia-think-gate-a:${executionId}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `think_gate_a_${hex.slice(0, 24)}`;
}
