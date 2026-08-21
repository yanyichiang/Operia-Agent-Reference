import { parseBrowserDomainAllowlist } from "./browserQuickActions";
import { decideRevisionCas } from "../control/revision";

export type BrowserAllowlistMutation =
  | { ok: true; domains: string[]; revision: number }
  | { ok: false; status: 409 | 422 | 428; error: string; currentRevision: number };

export function normalizeBrowserDomainInput(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("browser_domain_allowlist_invalid");
  if (!value.every((item) => typeof item === "string" && item.length <= 253 && !item.includes(","))) {
    throw new Error("browser_domain_allowlist_invalid");
  }
  const normalizedInputs = value.map((item) => item.trim().toLowerCase()).filter(Boolean);
  const domains = parseBrowserDomainAllowlist(value.join(","));
  if (domains.some((domain) => domain.startsWith("*."))) throw new Error("browser_domain_wildcard_forbidden");
  if (domains.length !== normalizedInputs.length) {
    throw new Error("browser_domain_allowlist_invalid");
  }
  return domains;
}

export function mergeBrowserDomainInputs(...values: ReadonlyArray<unknown>): string[] {
  const items = values.flatMap((value) => Array.isArray(value) ? value : []);
  if (!items.every((item) => typeof item === "string")) throw new Error("browser_domain_allowlist_invalid");
  return normalizeBrowserDomainInput(parseBrowserDomainAllowlist(items.join(",")));
}

export function applyBrowserAllowlistMutation(
  currentRevision: number,
  ifMatch: string | null,
  value: unknown,
): BrowserAllowlistMutation {
  const decision = decideRevisionCas(currentRevision, ifMatch);
  if ("code" in decision) {
    const status = decision.code === "missing_revision" ? 428 : decision.code === "revision_conflict" ? 409 : 422;
    return { ok: false, status, error: decision.code, currentRevision };
  }
  try {
    return { ok: true, domains: normalizeBrowserDomainInput(value), revision: decision.nextRevision };
  } catch {
    return { ok: false, status: 422, error: "browser_domain_allowlist_invalid", currentRevision };
  }
}
