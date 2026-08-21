import { ControlPlaneCoreError } from "./errors";
import { CONTROL_ROUTE_LOCATORS, type ControlRouteLocator, type ControlRouteTemplate } from "./types";

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const SENSITIVE_LOCATOR = /(?:secret|token|cookie|prompt|memory|result|text|body|key_value|credential|live_view)/i;

export function validateRouteTemplate(template: ControlRouteTemplate, allowedDomains: readonly string[]): void {
  if (!template.id || !isDomain(template.ownerDomain) || !allowedDomains.includes(template.ownerDomain)) {
    throw new ControlPlaneCoreError("invalid_route_template", "unknown_owner_domain");
  }
  if (new Set(template.allowedLocators).size !== template.allowedLocators.length) {
    throw new ControlPlaneCoreError("invalid_route_template", "duplicate_locator");
  }
  for (const locator of template.allowedLocators) {
    if (!CONTROL_ROUTE_LOCATORS.includes(locator) || SENSITIVE_LOCATOR.test(locator)) {
      throw new ControlPlaneCoreError("invalid_route_template", "unsafe_locator");
    }
  }

  let url: URL;
  try {
    url = new URL(template.template.replace(PLACEHOLDER, "safe-locator"));
  } catch {
    throw new ControlPlaneCoreError("invalid_route_template", "invalid_url");
  }
  if (url.protocol !== "https:" || url.hostname !== template.ownerDomain || url.username || url.password || url.port) {
    throw new ControlPlaneCoreError("invalid_route_template", "unsafe_origin");
  }

  const placeholders = [...template.template.matchAll(PLACEHOLDER)].map((match) => match[1]);
  if (placeholders.some((value) => !template.allowedLocators.includes(value as ControlRouteLocator))) {
    throw new ControlPlaneCoreError("invalid_route_template", "undeclared_placeholder");
  }
  if (template.allowedLocators.some((locator) => !placeholders.includes(locator))) {
    throw new ControlPlaneCoreError("invalid_route_template", "unused_locator");
  }
  for (const queryKey of url.searchParams.keys()) {
    if (!template.allowedLocators.includes(queryKey as ControlRouteLocator)) {
      throw new ControlPlaneCoreError("invalid_route_template", "unknown_query");
    }
  }
  if (decodeURIComponent(url.pathname).includes("..") || url.pathname.startsWith("//")) {
    throw new ControlPlaneCoreError("invalid_route_template", "unsafe_path");
  }
}

export function buildControlRoute(
  template: ControlRouteTemplate,
  locators: Partial<Record<ControlRouteLocator, string>>,
  allowedDomains: readonly string[],
): string {
  validateRouteTemplate(template, allowedDomains);
  const supplied = Object.keys(locators) as ControlRouteLocator[];
  if (supplied.some((key) => !template.allowedLocators.includes(key))) {
    throw new ControlPlaneCoreError("invalid_route_locator", "unknown_locator");
  }
  let rendered = template.template.replace(PLACEHOLDER, (_, name: ControlRouteLocator) => {
    const value = locators[name];
    if (!safeLocatorValue(value)) throw new ControlPlaneCoreError("invalid_route_locator", name);
    return encodeURIComponent(value);
  });
  const url = new URL(rendered);
  for (const [key, value] of url.searchParams) {
    if (template.allowedLocators.includes(key as ControlRouteLocator)) {
      const raw = locators[key as ControlRouteLocator];
      if (!safeLocatorValue(raw)) throw new ControlPlaneCoreError("invalid_route_locator", key);
      url.searchParams.set(key, raw);
    } else if (value.includes("safe-locator")) {
      throw new ControlPlaneCoreError("invalid_route_locator", key);
    }
  }
  rendered = url.toString();
  const finalUrl = new URL(rendered);
  if (finalUrl.hostname !== template.ownerDomain || finalUrl.protocol !== "https:" || finalUrl.port || finalUrl.username || finalUrl.password) {
    throw new ControlPlaneCoreError("invalid_route_locator", "origin_changed");
  }
  return rendered;
}

function safeLocatorValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) && value.includes(".");
}
