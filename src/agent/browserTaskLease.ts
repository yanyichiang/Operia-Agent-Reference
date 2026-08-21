import { parse } from "acorn";

export type BrowserInteractionMode = "read" | "form" | "trusted";

export type BrowserActionKind =
  | "navigate"
  | "inspect"
  | "wait_for"
  | "scroll"
  | "click"
  | "fill"
  | "select"
  | "submit"
  | "screenshot"
  | "checkpoint"
  | "trusted_mutation";

export type BrowserSiteProfile = {
  id: string;
  label: string;
  primaryHosts: string[];
  redirectHosts: string[];
  maximumMode: BrowserInteractionMode;
  allowedActions: BrowserActionKind[];
  revision: number;
  enabled: boolean;
};

export type BrowserTaskLease = {
  id: string;
  taskId: string;
  siteProfileId: string;
  siteProfileRevision: number;
  mode: BrowserInteractionMode;
  allowedHosts: string[];
  allowedActions: BrowserActionKind[];
  maxLogicalSteps: number;
  usedLogicalSteps: number;
  deadlineAt: string;
  instructionHash: string;
  state: "active" | "paused" | "revoked" | "expired" | "completed";
  revision: number;
  stepOnce?: boolean;
};

export type BrowserActionDescriptor = {
  kind: BrowserActionKind;
  method: string;
  mutating: boolean;
};

export function browserActionRecoveryDecision(
  state: "started" | "completed" | "attention_required" | null,
  mutating: boolean,
): "execute" | "reuse" | "attention_required" {
  if (state === "completed") return "reuse";
  if (state === null || (state === "started" && !mutating)) return "execute";
  return "attention_required";
}

const MODE_RANK: Record<BrowserInteractionMode, number> = { read: 0, form: 1, trusted: 2 };
const READ_ACTIONS = new Set<BrowserActionKind>(["navigate", "inspect", "wait_for", "scroll", "screenshot", "checkpoint"]);
const FORM_ACTIONS = new Set<BrowserActionKind>([
  ...READ_ACTIONS,
  "click",
  "fill",
  "select",
  "submit",
]);
const HARD_SENSITIVE_TERMS = new Set([
  "password", "passwd", "passkey", "credential", "cookie", "localstorage", "sessionstorage",
  "otp", "totp", "mfa", "2fa", "cvv", "cvc", "creditcard", "credit-card", "payment",
  "oauth", "authorize", "authorization", "delete-account", "close-account", "wire-transfer",
]);

type AstNode = { type: string; [key: string]: unknown };

export function normalizeBrowserInteractionMode(value: unknown): BrowserInteractionMode {
  return value === "form" || value === "trusted" ? value : "read";
}

export function defaultBrowserStepBudget(mode: BrowserInteractionMode): number {
  return mode === "read" ? 20 : mode === "form" ? 40 : 60;
}

export function browserModeAllows(maximum: BrowserInteractionMode, requested: BrowserInteractionMode): boolean {
  return MODE_RANK[maximum] >= MODE_RANK[requested];
}

export function siteProfileCoversDomains(profile: BrowserSiteProfile, domains: ReadonlyArray<string>): boolean {
  if (!profile.enabled || domains.length === 0) return false;
  const covered = new Set([...profile.primaryHosts, ...profile.redirectHosts].map(normalizeHost));
  return domains.every((domain) => covered.has(normalizeHost(domain)));
}

export function selectBrowserSiteProfile(
  profiles: ReadonlyArray<BrowserSiteProfile>,
  domains: ReadonlyArray<string>,
  requestedMode: BrowserInteractionMode,
): BrowserSiteProfile | null {
  const candidates = profiles.filter((profile) => (
    siteProfileCoversDomains(profile, domains) && browserModeAllows(profile.maximumMode, requestedMode)
  ));
  candidates.sort((left, right) => {
    const leftHosts = left.primaryHosts.length + left.redirectHosts.length;
    const rightHosts = right.primaryHosts.length + right.redirectHosts.length;
    return leftHosts - rightHosts || right.revision - left.revision || left.id.localeCompare(right.id);
  });
  return candidates[0] ?? null;
}

export function validateBrowserLeaseAction(lease: BrowserTaskLease, action: BrowserActionDescriptor, now = new Date()): void {
  if (lease.state === "paused") throw new Error("browser_task_lease_paused");
  if (lease.state !== "active") throw new Error(`browser_task_lease_${lease.state}`);
  if (Date.parse(lease.deadlineAt) <= now.getTime()) throw new Error("browser_task_lease_expired");
  if (lease.usedLogicalSteps >= lease.maxLogicalSteps) throw new Error("browser_task_lease_step_limit");
  if (!lease.allowedActions.includes(action.kind)) throw new Error(`browser_task_action_not_leased:${action.kind}`);
  if (lease.mode === "read" && !READ_ACTIONS.has(action.kind)) throw new Error(`browser_read_mode_action_forbidden:${action.kind}`);
  if (lease.mode === "form" && !FORM_ACTIONS.has(action.kind)) throw new Error(`browser_form_mode_action_forbidden:${action.kind}`);
}

export function classifyBrowserCdpAction(args: unknown): BrowserActionDescriptor {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("browser_cdp_args_invalid");
  const record = args as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : "";
  if (!method) throw new Error("browser_cdp_method_required");
  const params = record.params && typeof record.params === "object" && !Array.isArray(record.params)
    ? record.params as Record<string, unknown>
    : {};

  if (method === "Page.navigate" || method === "Target.createTarget") return { kind: "navigate", method, mutating: false };
  if (method === "Page.captureScreenshot") return { kind: "screenshot", method, mutating: false };
  if (method === "Runtime.evaluate") return classifyRuntimeExpression(String(params.expression ?? ""), method);
  if (method === "Input.insertText" || method === "Input.dispatchKeyEvent") return { kind: "fill", method, mutating: true };
  if (method === "Input.dispatchMouseEvent" || method === "Input.dispatchTouchEvent") return { kind: "click", method, mutating: true };
  if (/^(?:DOM\.set|DOM\.remove|Page\.handleJavaScriptDialog|Page\.setDocumentContent)/.test(method)) {
    return { kind: "trusted_mutation", method, mutating: true };
  }
  if (/^(?:DOM\.|Accessibility\.|Network\.|Page\.|Performance\.|Runtime\.|Target\.|Console\.|Log\.|Emulation\.)/.test(method)) {
    return { kind: "inspect", method, mutating: false };
  }
  return { kind: "trusted_mutation", method, mutating: true };
}

export function allowedActionsForMode(mode: BrowserInteractionMode): BrowserActionKind[] {
  return [...(mode === "read" ? READ_ACTIONS : mode === "form" ? FORM_ACTIONS : new Set<BrowserActionKind>([...FORM_ACTIONS, "trusted_mutation"]))];
}

function classifyRuntimeExpression(expression: string, method: string): BrowserActionDescriptor {
  if (!expression || expression.length > 8_000) throw new Error("browser_runtime_expression_invalid");
  const ast = parseExpression(expression);
  let mutation: BrowserActionKind | null = null;
  let loopDepth = 0;
  walkAst(ast, (node) => {
    if (["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"].includes(node.type)) {
      loopDepth += 1;
    }
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") mutation = mutation ?? "fill";
    if (node.type !== "CallExpression") return;
    const callee = asNode(node.callee);
    const member = callee?.type === "MemberExpression" ? memberName(callee) : null;
    if (member === "click") mutation = mutation ?? "click";
    if (member === "submit" || member === "requestSubmit") mutation = "submit";
    if (member === "dispatchEvent") mutation = mutation ?? "select";
    if (member === "setRangeText" || member === "setSelectionRange") mutation = mutation ?? "fill";
  });
  assertNoSensitiveBrowserExpression(ast);
  if (mutation && loopDepth > 0) throw new Error("browser_runtime_mutation_loop_forbidden");
  return { kind: mutation ?? "inspect", method, mutating: mutation !== null };
}

function assertNoSensitiveBrowserExpression(ast: AstNode): void {
  walkAst(ast, (node) => {
    if (node.type === "Literal" && typeof node.value === "string" && containsSensitiveTerm(node.value)) {
      throw new Error("browser_sensitive_action_forbidden");
    }
    if (node.type === "Identifier" && typeof node.name === "string" && containsSensitiveTerm(node.name)) {
      throw new Error("browser_sensitive_action_forbidden");
    }
  });
}

function containsSensitiveTerm(value: string): boolean {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return [...HARD_SENSITIVE_TERMS].some((term) => normalized.includes(term));
}

function parseExpression(expression: string): AstNode {
  try { return parse(expression, { ecmaVersion: "latest", sourceType: "script" }) as unknown as AstNode; }
  catch { throw new Error("browser_runtime_expression_invalid"); }
}

function memberName(node: AstNode): string | null {
  const property = asNode(node.property);
  if (!property) return null;
  if (node.computed === true && property.type === "Literal" && typeof property.value === "string") return property.value;
  return node.computed !== true && property.type === "Identifier" && typeof property.name === "string" ? property.name : null;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function asNode(value: unknown): AstNode | null {
  return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
    ? value as AstNode
    : null;
}

function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc", "range"].includes(key)) continue;
    const child = asNode(value);
    if (child) {
      walkAst(child, visit);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const arrayChild = asNode(item);
      if (arrayChild) walkAst(arrayChild, visit);
    }
  }
}
