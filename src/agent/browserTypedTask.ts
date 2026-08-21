import { assertBrowserUrlAllowed } from "./browserQuickActions";
import {
  classifyBrowserCdpAction,
  normalizeBrowserInteractionMode,
  type BrowserActionDescriptor,
  type BrowserInteractionMode,
} from "./browserTaskLease";

export type BrowserTypedAction =
  | { kind: "navigate"; url: string }
  | { kind: "follow_link"; selector: string; url: string }
  | { kind: "next_page"; selector: string; url: string }
  | { kind: "inspect"; selector?: string }
  | { kind: "wait_for"; selector: string; timeoutMs: number }
  | { kind: "scroll"; direction: "up" | "down"; amount: number }
  | { kind: "click"; selector: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "select"; selector: string; value: string }
  | { kind: "submit"; selector: string }
  | { kind: "answer_radio_groups"; strategy: "first" | "middle" | "last" | "alternating"; maxGroups: number }
  | { kind: "screenshot"; label?: string }
  | { kind: "checkpoint"; label?: string };

export type BrowserTypedTaskInput = {
  domains: string[];
  interactionMode: BrowserInteractionMode;
  sessionKey: string;
  recording: boolean;
  maxLogicalSteps: number;
  deadlineMs: number;
  actions: BrowserTypedAction[];
};

export type CompiledBrowserAction = {
  action: BrowserTypedAction;
  descriptor: BrowserActionDescriptor;
  code: string | null;
  logicalStepCost: number;
};

const MAX_ACTIONS = 60;
const MAX_SELECTOR_CHARS = 500;
const MAX_VALUE_CHARS = 4_000;

export function validateBrowserTypedTaskInput(
  value: unknown,
  globalAllowlist: ReadonlyArray<string>,
): BrowserTypedTaskInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser_task_input_invalid");
  const record = value as Record<string, unknown>;
  const domains = normalizeDomains(record.domains, globalAllowlist);
  const interactionMode = normalizeBrowserInteractionMode(record.interaction_mode);
  const sessionKey = normalizeSessionKey(record.session_key);
  const recording = record.recording === true;
  const maxLogicalSteps = boundedInteger(record.max_steps, interactionMode === "read" ? 20 : interactionMode === "form" ? 40 : 60, 1, 60);
  const deadlineMs = boundedInteger(record.timeout_ms, interactionMode === "trusted" ? 10 * 60_000 : 5 * 60_000, 5_000, 10 * 60_000);
  if (!Array.isArray(record.actions) || record.actions.length < 1 || record.actions.length > MAX_ACTIONS) {
    throw new Error("browser_task_actions_invalid");
  }
  const actions = record.actions.map((action) => normalizeAction(action, domains));
  const declaredCost = actions.reduce((total, action) => total + actionStepCost(action), 0);
  if (declaredCost > maxLogicalSteps) throw new Error("browser_task_declared_step_limit");
  if (interactionMode === "read" && actions.some((action) => !["navigate", "follow_link", "next_page", "inspect", "wait_for", "scroll", "screenshot", "checkpoint"].includes(action.kind))) {
    throw new Error("browser_read_mode_action_forbidden");
  }
  if (interactionMode === "trusted") throw new Error("browser_trusted_mode_requires_manual_grant");
  if (actions[0]?.kind !== "navigate") throw new Error("browser_task_initial_navigation_required");
  return { domains, interactionMode, sessionKey, recording, maxLogicalSteps, deadlineMs, actions };
}

export function compileBrowserTypedAction(action: BrowserTypedAction): CompiledBrowserAction {
  if (action.kind === "checkpoint") {
    return { action, descriptor: { kind: "checkpoint", method: "checkpoint", mutating: false }, code: null, logicalStepCost: 1 };
  }
  if (action.kind === "navigate") {
    return {
      action,
      descriptor: { kind: "navigate", method: "Target.createTarget", mutating: false },
      code: `async () => {
  const created = await cdp.send({ method: "Target.createTarget", params: { url: ${JSON.stringify(action.url)} } });
  return { kind: "navigate", targetId: created.targetId, url: ${JSON.stringify(action.url)} };
}`,
      logicalStepCost: 1,
    };
  }
  if (action.kind === "follow_link" || action.kind === "next_page") {
    return verifiedLinkNavigationAction(action);
  }
  if (action.kind === "screenshot") {
    return pageAction(action, "Page.captureScreenshot", {}, { kind: "screenshot", method: "Page.captureScreenshot", mutating: false });
  }

  const expression = actionExpression(action);
  // The expression is generated from the typed action above. Classifying it as
  // arbitrary client JavaScript would reject bounded server-owned form loops.
  const descriptor = typedActionDescriptor(action);
  return pageAction(action, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, descriptor);
}

function typedActionDescriptor(
  action: Exclude<BrowserTypedAction, { kind: "navigate" | "follow_link" | "next_page" | "screenshot" | "checkpoint" }>,
): BrowserActionDescriptor {
  if (action.kind === "answer_radio_groups") return { kind: "click", method: "Runtime.evaluate", mutating: true };
  return { kind: action.kind, method: "Runtime.evaluate", mutating: !["inspect", "wait_for", "scroll"].includes(action.kind) };
}

function verifiedLinkNavigationAction(
  action: Extract<BrowserTypedAction, { kind: "follow_link" | "next_page" }>,
): CompiledBrowserAction {
  const selector = JSON.stringify(action.selector);
  const expected = JSON.stringify(action.url);
  return {
    action,
    descriptor: { kind: "navigate", method: "Target.createTarget", mutating: false },
    logicalStepCost: 1,
    code: `async () => {
  const targets = await cdp.send({ method: "Target.getTargets", params: {} });
  const page = (targets.targetInfos || []).filter((item) => item.type === "page" && item.url && item.url !== "about:blank").at(-1);
  if (!page) throw new Error("browser_task_page_missing");
  const attached = await cdp.attachToTarget({ targetId: page.targetId });
  const verified = await cdp.send({ method: "Runtime.evaluate", params: { expression: ${JSON.stringify(`(() => { const node = document.querySelector(${selector}); const anchor = node && (node.matches('a[href]') ? node : node.closest('a[href]')); if (!anchor) return false; try { return new URL(anchor.href, document.baseURI).href === ${expected}; } catch { return false; } })()`)}, returnByValue: true }, sessionId: attached.sessionId });
  const linkMatches = verified?.result?.value ?? verified?.result?.result?.value;
  if (linkMatches !== true) throw new Error("browser_task_link_mismatch");
  const created = await cdp.send({ method: "Target.createTarget", params: { url: ${expected} } });
  return { kind: ${JSON.stringify(action.kind)}, targetId: created.targetId, url: ${expected} };
}`,
  };
}

function pageAction(
  action: BrowserTypedAction,
  method: string,
  params: Record<string, unknown>,
  descriptor: BrowserActionDescriptor,
): CompiledBrowserAction {
  return {
    action,
    descriptor,
    logicalStepCost: actionStepCost(action),
    code: `async () => {
  const targets = await cdp.send({ method: "Target.getTargets", params: {} });
  const page = (targets.targetInfos || []).filter((item) => item.type === "page" && item.url && item.url !== "about:blank").at(-1);
  if (!page) throw new Error("browser_task_page_missing");
  const attached = await cdp.attachToTarget({ targetId: page.targetId });
  return cdp.send({ method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)}, sessionId: attached.sessionId });
}`,
  };
}

function actionExpression(action: Exclude<BrowserTypedAction, { kind: "navigate" | "follow_link" | "next_page" | "screenshot" | "checkpoint" }>): string {
  if (action.kind === "inspect") {
    const selector = JSON.stringify(action.selector ?? "body");
    return `(() => { const node = document.querySelector(${selector}); if (!node) return { found: false }; return { found: true, tag: node.tagName, text: String(node.innerText || node.textContent || "").slice(0, 4000) }; })()`;
  }
  if (action.kind === "wait_for") {
    const selector = JSON.stringify(action.selector);
    return `(async () => { const deadline = Date.now() + ${action.timeoutMs}; while (Date.now() < deadline) { const node = document.querySelector(${selector}); if (node) return { found: true, tag: node.tagName }; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("browser_task_wait_timeout"); })()`;
  }
  if (action.kind === "scroll") {
    const amount = action.direction === "up" ? -action.amount : action.amount;
    return `(() => { window.scrollBy({ top: ${amount}, behavior: "instant" }); return { scrollY: window.scrollY }; })()`;
  }
  if (action.kind === "click") {
    return `(() => { const node = document.querySelector(${JSON.stringify(action.selector)}); if (!node) throw new Error("browser_task_target_missing"); node.click(); return { clicked: true, tag: node.tagName }; })()`;
  }
  if (action.kind === "fill") {
    return `(() => { const node = document.querySelector(${JSON.stringify(action.selector)}); if (!node || !("value" in node)) throw new Error("browser_task_field_missing"); node.value = ${JSON.stringify(action.value)}; node.dispatchEvent(new Event("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true })); return { filled: true, tag: node.tagName }; })()`;
  }
  if (action.kind === "select") {
    return `(() => { const node = document.querySelector(${JSON.stringify(action.selector)}); if (!node || !("value" in node)) throw new Error("browser_task_select_missing"); node.value = ${JSON.stringify(action.value)}; node.dispatchEvent(new Event("change", { bubbles: true })); return { selected: true, tag: node.tagName }; })()`;
  }
  if (action.kind === "submit") {
    return `(() => { const node = document.querySelector(${JSON.stringify(action.selector)}); if (!node) throw new Error("browser_task_submit_missing"); if (node.tagName === "FORM" && typeof node.requestSubmit === "function") node.requestSubmit(); else node.click(); return { submitted: true, tag: node.tagName }; })()`;
  }
  const strategy = JSON.stringify(action.strategy);
  return `(() => { const groups = new Map(); for (const input of document.querySelectorAll('input[type="radio"]')) { const key = input.name || input.closest('fieldset,li,div')?.textContent?.slice(0,80) || String(groups.size); const list = groups.get(key) || []; list.push(input); groups.set(key, list); } const chosen = []; let index = 0; for (const list of groups.values()) { if (chosen.length >= ${action.maxGroups}) break; const strategy = ${strategy}; const at = strategy === "first" ? 0 : strategy === "last" ? list.length - 1 : strategy === "alternating" ? index % list.length : Math.floor((list.length - 1) / 2); const input = list[Math.max(0, Math.min(list.length - 1, at))]; if (input) { input.click(); chosen.push({ name: input.name || null, value: input.value || null }); } index += 1; } return { answered: chosen.length, groups: groups.size }; })()`;
}

function normalizeAction(value: unknown, domains: ReadonlyArray<string>): BrowserTypedAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser_task_action_invalid");
  const action = value as Record<string, unknown>;
  const kind = String(action.kind ?? "");
  if (kind === "navigate") {
    const url = String(action.url ?? "");
    assertBrowserUrlAllowed(url, domains);
    return { kind, url };
  }
  if (kind === "follow_link" || kind === "next_page") {
    const url = String(action.url ?? "");
    assertBrowserUrlAllowed(url, domains);
    const defaultSelector = kind === "next_page" ? 'a[rel="next"]' : "";
    return { kind, selector: selector(action.selector ?? defaultSelector), url };
  }
  if (kind === "inspect") return { kind, ...(action.selector === undefined ? {} : { selector: selector(action.selector) }) };
  if (kind === "wait_for") {
    return { kind, selector: selector(action.selector), timeoutMs: boundedInteger(action.timeout_ms, 3_000, 100, 10_000) };
  }
  if (kind === "scroll") {
    const direction = action.direction === "up" ? "up" : "down";
    return { kind, direction, amount: boundedInteger(action.amount, 700, 1, 5_000) };
  }
  if (kind === "click" || kind === "submit") return { kind, selector: selector(action.selector) };
  if (kind === "fill" || kind === "select") return { kind, selector: selector(action.selector), value: boundedString(action.value, MAX_VALUE_CHARS, "browser_task_value_invalid") };
  if (kind === "answer_radio_groups") {
    const strategy = ["first", "middle", "last", "alternating"].includes(String(action.strategy))
      ? action.strategy as "first" | "middle" | "last" | "alternating"
      : "middle";
    return { kind, strategy, maxGroups: boundedInteger(action.max_groups, 40, 1, 60) };
  }
  if (kind === "screenshot" || kind === "checkpoint") {
    return { kind, ...(action.label === undefined ? {} : { label: boundedString(action.label, 120, "browser_task_label_invalid") }) };
  }
  throw new Error("browser_task_action_kind_invalid");
}

function actionStepCost(action: BrowserTypedAction): number {
  return action.kind === "answer_radio_groups" ? action.maxGroups : 1;
}

function normalizeDomains(value: unknown, globalAllowlist: ReadonlyArray<string>): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("browser_task_domains_required");
  const domains = [...new Set(value.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  for (const domain of domains) {
    if (domain.startsWith("*.")) throw new Error("browser_task_wildcard_forbidden");
    assertBrowserUrlAllowed(`https://${domain}/`, globalAllowlist);
  }
  return domains;
}

function normalizeSessionKey(value: unknown): string {
  const key = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : `task-${crypto.randomUUID()}`;
  if (!/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(key)) throw new Error("browser_task_session_key_invalid");
  return key;
}

function selector(value: unknown): string {
  const result = boundedString(value, MAX_SELECTOR_CHARS, "browser_task_selector_invalid");
  classifyBrowserCdpAction({ method: "Runtime.evaluate", params: { expression: `document.querySelector(${JSON.stringify(result)})` } });
  return result;
}

function boundedString(value: unknown, max: number, code: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max) throw new Error(code);
  return result;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= minimum && numeric <= maximum ? numeric : fallback;
}
