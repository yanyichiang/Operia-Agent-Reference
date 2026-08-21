/**
 * H-C1 — Shared credential primitives.
 *
 * This module provides the minimum reusable functions for credential class
 * isolation. It deliberately does **not** grant authority across classes:
 * an application API key cannot satisfy `authorizeInternalService`, and an
 * internal service bearer cannot satisfy browser Domain Session checks.
 */

import type { InternalServiceCaller, InternalServiceRoute } from "./internalServiceRegistry";

export type InternalServiceAuthSpec = {
  routeId: string;
  host: string;
  path: string;
  methods: string[];
  allowedCallers: Array<{ sourceDomain: string; serviceId: string }>;
};

export type InternalServiceIdentity = {
  sourceDomain: string;
  serviceId: string;
  routeId: string;
};

const BEARER_PREFIX = "bearer ";

/**
 * Parse a Bearer token from the `Authorization` header.
 *
 * Accepts only `Authorization: Bearer <non-empty-token>`.
 * Rejects empty, whitespace-only, `Basic`, `Token`, `Bearer` alone, duplicated
 * scheme, and malformed values. No fallback to `x-api-key`.
 */
export function parseBearer(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth) return null;

  const lower = auth.toLowerCase();
  if (!lower.startsWith(BEARER_PREFIX)) return null;

  // Reject duplicated scheme such as "Bearer Bearer token" or "Bearer Basic x".
  const remainder = auth.slice(BEARER_PREFIX.length);
  if (!remainder) return null;

  // Reject internal whitespace; valid bearer tokens are single non-empty
  // sequences without spaces, tabs, or newlines.
  if (/\s/.test(remainder)) return null;

  const token = remainder;
  if (!token) return null;

  return token;
}

/**
 * Compare two secrets in constant time when `crypto.subtle.timingSafeEqual` is
 * available. Fail closed on missing or empty inputs.
 */
export async function secretEqual(actual: string, expected: string): Promise<boolean> {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  if (actual.length === 0 || expected.length === 0) return false;

  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);

  if (actualBytes.length !== expectedBytes.length) return false;

  if (typeof crypto !== "undefined" && crypto.subtle && "timingSafeEqual" in crypto.subtle) {
    try {
      return crypto.subtle.timingSafeEqual(actualBytes, expectedBytes);
    } catch {
      // Fall through to direct comparison if timingSafeEqual throws.
    }
  }

  let equal = true;
  for (let i = 0; i < actualBytes.length; i += 1) {
    equal = equal && actualBytes[i] === expectedBytes[i];
  }
  return equal;
}

/**
 * Verify that the request carries the expected Bearer token.
 *
 * This is a class-neutral identity check: it confirms "who sent this request"
 * at the bearer level but does not judge caller class or route authority.
 */
export async function authorizeBearer(request: Request, expected?: string): Promise<boolean> {
  if (!expected || expected.length === 0) return false;
  const token = parseBearer(request);
  if (!token) return false;
  return secretEqual(token, expected);
}

function normalizePath(path: string): string {
  // Treat route parameter patterns such as `/service/control/overrides/:key`
  // as a prefix match for any segment after the prefix.
  return path.replace(/:\w+/g, "*");
}

export function matchInternalServicePath(specPath: string, requestPath: string): boolean {
  const normalized = normalizePath(specPath);
  if (normalized === specPath) {
    return specPath === requestPath;
  }
  // Parameterized route: convert to a prefix match up to the first wildcard,
  // but require that the request path has at least one more path segment.
  const wildcardIndex = normalized.indexOf("*");
  const prefix = normalized.slice(0, wildcardIndex);
  if (!requestPath.startsWith(prefix)) return false;
  const remainder = requestPath.slice(prefix.length);
  if (!remainder || remainder === "/") return false;
  return true;
}

/**
 * Authorize an internal service request.
 *
 * Verifies all of the following:
 * - exact host (`request.url` hostname === spec.host)
 * - allowed method/path
 * - dedicated bearer (`parseBearer` then `secretEqual` against expectedSecret)
 * - required `x-operia-source-domain` header
 * - required `x-operia-service-id` header
 * - caller allowlist (sourceDomain + serviceId exact match)
 *
 * Returns `InternalServiceIdentity` on success, `null` on any failure.
 */
export async function authorizeInternalService(
  request: Request,
  spec: InternalServiceAuthSpec,
  expectedSecret?: string,
): Promise<InternalServiceIdentity | null> {
  const url = new URL(request.url);
  if (url.hostname !== spec.host) return null;
  if (!spec.methods.includes(request.method)) return null;
  if (!matchInternalServicePath(spec.path, url.pathname)) return null;

  if (!expectedSecret || expectedSecret.length === 0) return null;
  const token = parseBearer(request);
  if (!token) return null;
  if (!await secretEqual(token, expectedSecret)) return null;

  const sourceDomain = request.headers.get("x-operia-source-domain")?.trim();
  const serviceId = request.headers.get("x-operia-service-id")?.trim();
  if (!sourceDomain || !serviceId) return null;

  const allowed = spec.allowedCallers.some(
    (caller) => caller.sourceDomain === sourceDomain && caller.serviceId === serviceId,
  );
  if (!allowed) return null;

  return { sourceDomain, serviceId, routeId: spec.routeId };
}

/**
 * Build an `InternalServiceAuthSpec` from a registered route, keeping only
 * callers whose evidence is `"confirmed"`.
 */
export function internalServiceAuthSpecForRoute(route: InternalServiceRoute): InternalServiceAuthSpec {
  return {
    routeId: route.id,
    host: route.host,
    path: route.path,
    methods: route.methods,
    allowedCallers: route.callers
      .filter((caller): caller is InternalServiceCaller & { evidence: "confirmed" } => caller.evidence === "confirmed")
      .map((caller) => ({ sourceDomain: caller.sourceDomain, serviceId: caller.serviceId })),
  };
}
