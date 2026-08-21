import { getDomain } from "tldts";

export type BrowserDomainPolicyStatus = "allowed" | "approval_required" | "denied";

export type BrowserDomainPolicyDenyCode =
  | "browser_invalid_url"
  | "browser_url_not_https"
  | "browser_host_blocked"
  | "browser_owner_denied";

export type BrowserDomainPolicyInput = {
  sourceUrl?: string | URL | null;
  targetUrls: ReadonlyArray<string | URL>;
  ownerDeniedHosts?: ReadonlyArray<string>;
  permanentAllowedHosts?: ReadonlyArray<string>;
  taskGrantedHosts?: ReadonlyArray<string>;
};

export type BrowserDomainPolicyDecision = {
  status: BrowserDomainPolicyStatus;
  unknownHosts: string[];
  deniedHosts: string[];
  denyCode?: BrowserDomainPolicyDenyCode;
};

type ParsedBrowserUrl = {
  url: URL;
  hostname: string;
};

type UrlParseResult =
  | { ok: true; value: ParsedBrowserUrl }
  | { ok: false; code: Exclude<BrowserDomainPolicyDenyCode, "browser_owner_denied"> };

export function evaluateBrowserDomainPolicy(input: BrowserDomainPolicyInput): BrowserDomainPolicyDecision {
  const ownerDeniedHosts = normalizeExactHostnameSet(input.ownerDeniedHosts);
  const permanentAllowedHosts = normalizeExactHostnameSet(input.permanentAllowedHosts);
  const taskGrantedHosts = normalizeExactHostnameSet(input.taskGrantedHosts);
  const source = input.sourceUrl == null ? null : parseBrowserPolicyUrl(input.sourceUrl);

  if (source && "code" in source) return deniedDecision(source.code);

  const targets: ParsedBrowserUrl[] = [];
  for (const rawUrl of input.targetUrls) {
    const parsed = parseBrowserPolicyUrl(rawUrl);
    if ("code" in parsed) return deniedDecision(parsed.code);
    targets.push(parsed.value);
  }

  const deniedHosts = uniqueHosts(targets
    .map((target) => target.hostname)
    .filter((hostname) => ownerDeniedHosts.has(hostname)));
  if (deniedHosts.length > 0) {
    return { status: "denied", unknownHosts: [], deniedHosts, denyCode: "browser_owner_denied" };
  }

  const unknownHosts = uniqueHosts(targets
    .map((target) => target.hostname)
    .filter((hostname) => !permanentAllowedHosts.has(hostname))
    .filter((hostname) => !isSameSite(source && "value" in source ? source.value.hostname : null, hostname))
    .filter((hostname) => !taskGrantedHosts.has(hostname)));

  return unknownHosts.length > 0
    ? { status: "approval_required", unknownHosts, deniedHosts: [] }
    : { status: "allowed", unknownHosts: [], deniedHosts: [] };
}

export function parseBrowserPolicyUrl(raw: string | URL): UrlParseResult {
  let url: URL;
  try {
    url = new URL(raw instanceof URL ? raw.toString() : raw);
  } catch {
    return { ok: false, code: "browser_invalid_url" };
  }

  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return { ok: false, code: "browser_url_not_https" };
  }

  const hostname = normalizeHostname(url.hostname);
  if (!isValidHostname(hostname) || isBlockedBrowserHostname(hostname)) {
    return { ok: false, code: "browser_host_blocked" };
  }

  url.hostname = hostname;
  url.hash = "";
  return { ok: true, value: { url, hostname } };
}

export function isBlockedBrowserHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized.endsWith(".internal")) {
    return true;
  }
  if (/^\d+(?:\.\d+){3}$/.test(normalized) || normalized.includes(":")) return true;
  return false;
}

export function isSameSite(sourceHostname: string | null | undefined, targetHostname: string): boolean {
  if (!sourceHostname) return false;
  const source = normalizeHostname(sourceHostname);
  const target = normalizeHostname(targetHostname);
  if (!source || !target) return false;
  if (source === target) return true;

  const sourceDomain = getDomain(source, { allowPrivateDomains: true });
  const targetDomain = getDomain(target, { allowPrivateDomains: true });
  return sourceDomain !== null && sourceDomain === targetDomain;
}

function normalizeExactHostnameSet(values: ReadonlyArray<string> | undefined): Set<string> {
  const hostnames = new Set<string>();
  for (const value of values ?? []) {
    const hostname = normalizeHostname(value);
    if (!isValidHostname(hostname) || isBlockedBrowserHostname(hostname) || hostname.includes("*")) {
      throw new Error("browser_domain_policy_invalid_hostname");
    }
    hostnames.add(hostname);
  }
  return hostnames;
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function isValidHostname(value: string): boolean {
  return value.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function deniedDecision(denyCode: Exclude<BrowserDomainPolicyDenyCode, "browser_owner_denied">): BrowserDomainPolicyDecision {
  return { status: "denied", unknownHosts: [], deniedHosts: [], denyCode };
}

function uniqueHosts(hostnames: string[]): string[] {
  return [...new Set(hostnames)];
}
