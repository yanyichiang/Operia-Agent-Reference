import type { ToolCatalogEntry, ToolPolicyDecision } from "./types";

export const POLICY_V3_SHADOW_VERSION = "operia-sandbox-allowlist-v1-shadow";

export type PolicyV3ShadowDecision = "auto" | "approval" | "deny";

export type PolicyV3ShadowResult = {
  policyVersion: typeof POLICY_V3_SHADOW_VERSION;
  decision: PolicyV3ShadowDecision;
  ruleId: string;
  capability: string;
  targetClass: string;
  consequence: "read" | "draft_mutation" | "external_effect" | "device_effect" | "paid_effect" | "delete_effect" | "unknown";
  sensitivity: "bounded_private" | "none" | "unknown";
  staticDecision: "auto" | "approval" | "deny";
  differsFromStatic: boolean;
};

export function evaluatePolicyV3Shadow(input: {
  serverId: string;
  toolName: string;
  args: unknown;
  staticDecision: ToolPolicyDecision;
  tool?: ToolCatalogEntry;
}): PolicyV3ShadowResult {
  const staticDecision = input.staticDecision.ok
    ? input.staticDecision.requiresApproval ? "approval" : "auto"
    : "deny";
  const capability = `${input.serverId}/${input.toolName}`;
  const base = {
    policyVersion: POLICY_V3_SHADOW_VERSION,
    capability,
    staticDecision,
  } as const;
  const result = classify(input, base);
  return { ...result, differsFromStatic: result.decision !== staticDecision };
}

function classify(
  input: { serverId: string; toolName: string; args: unknown; staticDecision: ToolPolicyDecision; tool?: ToolCatalogEntry },
  base: Pick<PolicyV3ShadowResult, "policyVersion" | "capability" | "staticDecision">,
): Omit<PolicyV3ShadowResult, "differsFromStatic"> {
  if (!input.staticDecision.ok) {
    return { ...base, decision: "deny", ruleId: `preserve-${input.staticDecision.code}`, targetClass: "policy_denied",
      consequence: "unknown", sensitivity: "unknown" };
  }

  if (input.serverId === "browser") return browserDecision(input, base);
  if (input.serverId === "health" && ["health_summary", "health_trends"].includes(input.toolName)) {
    return { ...base, decision: "auto", ruleId: "allow-bounded-health-read", targetClass: "owner_health_projection",
      consequence: "read", sensitivity: "bounded_private" };
  }
  if (input.serverId === "grok" && input.toolName === "generate_image") {
    return { ...base, decision: "approval", ruleId: "paid-intent-and-budget-unattested", targetClass: "paid_image_provider",
      consequence: "paid_effect", sensitivity: "none" };
  }
  if (input.serverId === "voice" && input.toolName === "speak") {
    return { ...base, decision: "approval", ruleId: "outbound-message-requires-context", targetClass: "telegram_voice_output",
      consequence: "external_effect", sensitivity: "unknown" };
  }
  if (input.serverId === "home-assistant" || input.serverId === "home_assistant") {
    return { ...base, decision: "approval", ruleId: "device-facade-not-attested", targetClass: "home_assistant_entity",
      consequence: "device_effect", sensitivity: "unknown" };
  }

  const risk = input.tool?.riskLevel ?? input.staticDecision.riskLevel;
  if (risk === "read") {
    return { ...base, decision: "auto", ruleId: "allow-attested-read", targetClass: "attested_provider",
      consequence: "read", sensitivity: "none" };
  }
  if (risk === "delete") {
    return { ...base, decision: "approval", ruleId: "delete-reversibility-unattested", targetClass: "external_persistent_target",
      consequence: "delete_effect", sensitivity: "unknown" };
  }
  const consequence = risk === "device" ? "device_effect" : risk === "purchase" ? "paid_effect" : "external_effect";
  return { ...base, decision: "approval", ruleId: "external-effect-requires-context", targetClass: "external_target",
    consequence, sensitivity: "unknown" };
}

function browserDecision(
  input: { toolName: string; args: unknown },
  base: Pick<PolicyV3ShadowResult, "policyVersion" | "capability" | "staticDecision">,
): Omit<PolicyV3ShadowResult, "differsFromStatic"> {
  if (["browser_markdown", "browser_links", "browser_scrape", "browser_extract", "site_adapter_read"].includes(input.toolName)) {
    return { ...base, decision: "auto", ruleId: "allow-public-browser-read", targetClass: "browser_host_set",
      consequence: "read", sensitivity: "none" };
  }
  if (input.toolName !== "browser_task") {
    return { ...base, decision: "approval", ruleId: "browser-effect-not-typed", targetClass: "browser_session",
      consequence: "external_effect", sensitivity: "unknown" };
  }
  const args = record(input.args);
  const actions = Array.isArray(args?.actions) ? args.actions.map(record).filter(Boolean) as Array<Record<string, unknown>> : [];
  const kinds = actions.map((action) => String(action.kind ?? ""));
  if (kinds.some((kind) => kind === "submit")) {
    return { ...base, decision: "approval", ruleId: "browser-final-effect", targetClass: "browser_form_target",
      consequence: "external_effect", sensitivity: "unknown" };
  }
  if (kinds.some((kind) => ["fill", "select", "click", "answer_radio_groups"].includes(kind))) {
    return { ...base, decision: "approval", ruleId: "browser-draft-sensitivity-unattested", targetClass: "browser_form_target",
      consequence: "draft_mutation", sensitivity: "unknown" };
  }
  return { ...base, decision: "auto", ruleId: "allow-typed-browser-read", targetClass: "browser_host_set",
    consequence: "read", sensitivity: "none" };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
