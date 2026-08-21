import { runQuickAction, type QuickAction, type QuickActionBinding } from "agents/browser";

export const BROWSER_QUICK_ACTIONS = ["browser_markdown", "browser_links", "browser_scrape", "browser_extract"] as const;
export type BrowserQuickActionName = (typeof BROWSER_QUICK_ACTIONS)[number];

export const BROWSER_FREE_DAILY_BUDGET_MS = 9 * 60_000;
export const BROWSER_FREE_MIN_INTERVAL_MS = 10_000;
export const BROWSER_ACTION_TIMEOUT_MS = 30_000;
export const BROWSER_RESULT_MAX_BYTES = 64 * 1024;

export type BrowserQuickActionInput = {
  action: BrowserQuickActionName;
  url: string;
  selectors?: string[];
  prompt?: string;
  responseSchema?: unknown;
};

export type BrowserQuickActionResult = {
  action: BrowserQuickActionName;
  url: string;
  value: unknown;
  browserMsUsed: number;
};

export function parseBrowserDomainAllowlist(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).map(normalizeAllowlistEntry))];
}

export function assertBrowserUrlAllowed(raw: string, allowlist: ReadonlyArray<string>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("browser_invalid_url");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("browser_url_not_https");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || isBlockedHostname(hostname)) throw new Error("browser_host_blocked");
  if (!allowlist.some((entry) => hostMatches(hostname, entry))) throw new Error("browser_host_not_allowlisted");
  url.hash = "";
  return url;
}

export function validateBrowserQuickActionInput(input: BrowserQuickActionInput): BrowserQuickActionInput {
  if (!BROWSER_QUICK_ACTIONS.includes(input.action)) throw new Error("browser_action_not_allowed");
  if (input.action === "browser_scrape") {
    if (!Array.isArray(input.selectors) || input.selectors.length < 1 || input.selectors.length > 8) throw new Error("browser_selectors_required");
    for (const selector of input.selectors) {
      if (typeof selector !== "string" || selector.length < 1 || selector.length > 240) throw new Error("browser_invalid_selector");
    }
  }
  if (input.action === "browser_extract") {
    if (typeof input.prompt !== "string" || input.prompt.trim().length < 1 || input.prompt.length > 1_000) throw new Error("browser_extract_prompt_required");
    if (!input.responseSchema || typeof input.responseSchema !== "object" || Array.isArray(input.responseSchema)) throw new Error("browser_extract_schema_required");
  }
  return input;
}

export async function executeBrowserQuickAction(
  browser: QuickActionBinding,
  input: BrowserQuickActionInput,
  allowlist: ReadonlyArray<string>,
): Promise<BrowserQuickActionResult> {
  validateBrowserQuickActionInput(input);
  const url = assertBrowserUrlAllowed(input.url, allowlist).toString();
  const common = { url, gotoOptions: { waitUntil: "domcontentloaded" as const, timeout: BROWSER_ACTION_TIMEOUT_MS } };
  const action = browserAction(input.action);
  const params = input.action === "browser_scrape"
    ? { ...common, elements: input.selectors!.map((selector) => ({ selector })) }
    : input.action === "browser_extract"
      ? { ...common, prompt: input.prompt!.trim(), response_format: { type: "json_schema" as const, schema: input.responseSchema } }
      : common;
  const response = await runQuickAction(browser, action, params);
  const browserMsUsed = boundedBrowserMs(response.headers.get("x-browser-ms-used"));
  const text = await readBoundedResponse(response, BROWSER_RESULT_MAX_BYTES);
  if (!response.ok) throw new Error(`browser_run_http_${response.status}`);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("browser_run_invalid_json");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("browser_run_invalid_response");
  const record = payload as Record<string, unknown>;
  if (record.success === false || !("result" in record)) throw new Error("browser_run_no_result");
  return { action: input.action, url, value: record.result, browserMsUsed };
}

function browserAction(action: BrowserQuickActionName): QuickAction {
  if (action === "browser_markdown") return "markdown";
  if (action === "browser_links") return "links";
  if (action === "browser_scrape") return "scrape";
  return "json";
}

function normalizeAllowlistEntry(value: string): string {
  const entry = value.replace(/\.$/, "");
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(2);
    if (!validHostname(suffix) || isBlockedHostname(suffix)) throw new Error("browser_invalid_allowlist_entry");
    return `*.${suffix}`;
  }
  if (!validHostname(entry) || isBlockedHostname(entry)) throw new Error("browser_invalid_allowlist_entry");
  return entry;
}

function hostMatches(hostname: string, entry: string): boolean {
  return entry.startsWith("*.")
    ? hostname.endsWith(`.${entry.slice(2)}`) && hostname !== entry.slice(2)
    : hostname === entry;
}

function validHostname(value: string): boolean {
  return value.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function isBlockedHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (/^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(":")) return true;
  return false;
}

function boundedBrowserMs(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 60_000 ? Math.trunc(parsed) : 0;
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("browser_result_too_large");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > limit) throw new Error("browser_result_too_large");
  return text;
}
