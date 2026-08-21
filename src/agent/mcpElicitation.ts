import { canonicalArgsHash } from "./contextBroker";
import { parse as parseDomain } from "tldts";

export type McpElicitationAction = "accept" | "decline" | "cancel";
export type McpElicitationRequest = {
  mode: "form" | "url";
  message: string;
  elicitationId?: string;
  url?: string;
  requestedSchema?: Record<string, unknown>;
};

const SECRET_HINT = /\b(?:password|passwd|passcode|secret|token|api\s*key|private\s*key|authorization|bearer|cookie|credential|otp|pin)\b/i;
const TICKET_ID = /^elc_[a-f0-9]{24}$/;
const STRING_FORMATS = new Set(["date", "date-time", "email", "uri"]);
const INTERNAL_HOST_SUFFIXES = ["localhost", "local", "internal", "home.arpa", "test", "example", "invalid", "onion"];
const MAX_STRING_LENGTH = 4_096;
const MAX_ARRAY_ITEMS = 50;

export const MCP_ELICITATION_TTL_MS = 2 * 60 * 60_000;
export const MCP_ELICITATION_HISTORY_MS = 24 * 60 * 60_000;

export function newMcpElicitationTicketId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `elc_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function encodeMcpElicitationCallback(action: McpElicitationAction, ticketId: string): string {
  if (!TICKET_ID.test(ticketId)) throw new Error("invalid_mcp_elicitation_ticket_id");
  const code = action === "accept" ? "a" : action === "decline" ? "d" : "c";
  return `me:${code}:${ticketId}`;
}

export function parseMcpElicitationCallback(data: string): { action: McpElicitationAction; ticketId: string } | null {
  const match = /^me:([adc]):(elc_[a-f0-9]{24})$/.exec(data);
  if (!match || new TextEncoder().encode(data).byteLength > 64) return null;
  return { action: match[1] === "a" ? "accept" : match[1] === "d" ? "decline" : "cancel", ticketId: match[2] };
}

export function mcpElicitationExpired(expiresAt: string, now = Date.now()): boolean {
  const expires = Date.parse(expiresAt);
  return !Number.isFinite(expires) || expires <= now;
}

export async function normalizeMcpElicitation(value: unknown): Promise<{ request: McpElicitationRequest; requestHash: string }> {
  const input = record(value, "mcp_elicitation_invalid");
  const message = boundedString(input.message, "mcp_elicitation_message_invalid", 1_000);
  if (hasSecretHint(message)) throw new Error("mcp_elicitation_message_forbidden");
  if (input.mode === "url") {
    const elicitationId = boundedString(input.elicitationId, "mcp_elicitation_id_invalid", 200);
    let url: URL;
    try {
      url = new URL(boundedString(input.url, "mcp_elicitation_url_invalid", 2_048));
    } catch {
      throw new Error("mcp_elicitation_url_invalid");
    }
    if (!isPublicHttpsUrl(url)) throw new Error("mcp_elicitation_url_forbidden");
    const request = { mode: "url" as const, message, elicitationId, url: url.toString() };
    return { request, requestHash: await canonicalArgsHash(request) };
  }

  const schema = record(input.requestedSchema, "mcp_elicitation_schema_invalid");
  if (schema.type !== "object") throw new Error("mcp_elicitation_schema_invalid");
  assertOnlyKeys(schema, ["type", "title", "description", "properties", "required", "additionalProperties"]);
  assertSafeSchemaHints(schema);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error("mcp_elicitation_schema_invalid");
  }
  const properties = record(schema.properties, "mcp_elicitation_schema_invalid");
  const names = Object.keys(properties);
  if (names.length < 1 || names.length > 20 || names.some((name) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) || hasSecretHint(name))) {
    throw new Error("mcp_elicitation_schema_forbidden");
  }
  for (const definition of Object.values(properties)) validatePrimitiveDefinition(definition);
  const required = schema.required === undefined ? [] : schema.required;
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !names.includes(name))) {
    throw new Error("mcp_elicitation_schema_invalid");
  }
  const requestedSchema = {
    type: "object",
    ...(typeof schema.title === "string" ? { title: schema.title } : {}),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    properties,
    ...(required.length ? { required: [...new Set(required)] } : {}),
    additionalProperties: false,
  };
  if (new TextEncoder().encode(JSON.stringify(requestedSchema)).byteLength > 16 * 1024) throw new Error("mcp_elicitation_schema_too_large");
  const request = { mode: "form" as const, message, requestedSchema };
  return { request, requestHash: await canonicalArgsHash(request) };
}

export function validateMcpElicitationDecision(
  request: McpElicitationRequest,
  action: McpElicitationAction,
  rawContent: unknown,
): { action: McpElicitationAction; content?: Record<string, string | number | boolean | string[]> } {
  if (action !== "accept") return { action };
  if (request.mode === "url") return { action };
  const content = record(rawContent, "mcp_elicitation_content_required");
  const schema = record(request.requestedSchema, "mcp_elicitation_schema_invalid");
  const properties = record(schema.properties, "mcp_elicitation_schema_invalid");
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  if (Object.keys(content).some((key) => !Object.hasOwn(properties, key))) throw new Error("mcp_elicitation_content_invalid");
  for (const key of required) if (!Object.hasOwn(content, key)) throw new Error("mcp_elicitation_content_required");
  const result: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(content)) {
    const definition = record(properties[key], "mcp_elicitation_schema_invalid");
    if (!primitiveMatches(definition, value)) throw new Error("mcp_elicitation_content_invalid");
    result[key] = value as string | number | boolean | string[];
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 8 * 1024) throw new Error("mcp_elicitation_content_too_large");
  return { action, content: result };
}

function validatePrimitiveDefinition(value: unknown): void {
  const definition = record(value, "mcp_elicitation_schema_invalid");
  assertSafeSchemaHints(definition);
  const type = definition.type;
  if (!["string", "number", "integer", "boolean", "array"].includes(String(type))) {
    throw new Error("mcp_elicitation_schema_invalid");
  }
  if (type === "string") {
    assertOnlyKeys(definition, ["type", "title", "description", "format", "minLength", "maxLength", "enum"]);
    validateStringDefinition(definition);
    return;
  }
  if (type === "number" || type === "integer") {
    assertOnlyKeys(definition, ["type", "title", "description", "minimum", "maximum"]);
    validateNumberDefinition(definition);
    return;
  }
  if (type === "boolean") {
    assertOnlyKeys(definition, ["type", "title", "description"]);
    return;
  }
  if (type === "array") {
    assertOnlyKeys(definition, ["type", "title", "description", "items", "minItems", "maxItems"]);
    const minItems = optionalBoundedInteger(definition.minItems, 0, MAX_ARRAY_ITEMS);
    const maxItems = optionalBoundedInteger(definition.maxItems, 0, MAX_ARRAY_ITEMS);
    if ((minItems ?? 0) > (maxItems ?? MAX_ARRAY_ITEMS)) throw new Error("mcp_elicitation_schema_invalid");
    const items = record(definition.items, "mcp_elicitation_schema_invalid");
    assertOnlyKeys(items, ["type", "title", "description", "enum"]);
    assertSafeSchemaHints(items);
    if (items.type !== "string" || !Array.isArray(items.enum) || items.enum.some((entry) => typeof entry !== "string")) {
      throw new Error("mcp_elicitation_schema_invalid");
    }
  }
}

function primitiveMatches(definition: Record<string, unknown>, value: unknown): boolean {
  if (Array.isArray(definition.enum)) return typeof value === "string" && definition.enum.includes(value);
  if (definition.type === "string") return typeof value === "string"
    && value.length >= Number(definition.minLength ?? 0)
    && value.length <= Number(definition.maxLength ?? MAX_STRING_LENGTH)
    && matchesStringFormat(String(definition.format ?? ""), value);
  if (definition.type === "number") return typeof value === "number" && Number.isFinite(value)
    && value >= Number(definition.minimum ?? -Infinity)
    && value <= Number(definition.maximum ?? Infinity);
  if (definition.type === "integer") return typeof value === "number" && Number.isSafeInteger(value)
    && value >= Number(definition.minimum ?? -Infinity)
    && value <= Number(definition.maximum ?? Infinity);
  if (definition.type === "boolean") return typeof value === "boolean";
  if (definition.type === "array") {
    const items = record(definition.items, "mcp_elicitation_schema_invalid");
    return Array.isArray(value)
      && value.length >= Number(definition.minItems ?? 0)
      && value.length <= Number(definition.maxItems ?? MAX_ARRAY_ITEMS)
      && value.every((entry) => typeof entry === "string" && (items.enum as unknown[]).includes(entry));
  }
  return false;
}

function validateStringDefinition(definition: Record<string, unknown>): void {
  const minLength = optionalBoundedInteger(definition.minLength, 0, MAX_STRING_LENGTH);
  const maxLength = optionalBoundedInteger(definition.maxLength, 0, MAX_STRING_LENGTH);
  if ((minLength ?? 0) > (maxLength ?? MAX_STRING_LENGTH)) throw new Error("mcp_elicitation_schema_invalid");
  if (definition.format !== undefined && (typeof definition.format !== "string" || !STRING_FORMATS.has(definition.format))) {
    throw new Error("mcp_elicitation_schema_invalid");
  }
  if (definition.enum !== undefined && (!Array.isArray(definition.enum)
    || definition.enum.length < 1
    || definition.enum.some((entry) => typeof entry !== "string" || !primitiveMatches({ ...definition, enum: undefined }, entry)))) {
    throw new Error("mcp_elicitation_schema_invalid");
  }
}

function validateNumberDefinition(definition: Record<string, unknown>): void {
  const minimum = optionalFiniteNumber(definition.minimum);
  const maximum = optionalFiniteNumber(definition.maximum);
  if ((minimum ?? -Infinity) > (maximum ?? Infinity)) throw new Error("mcp_elicitation_schema_invalid");
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("mcp_elicitation_schema_invalid");
}

function assertSafeSchemaHints(value: Record<string, unknown>): void {
  for (const key of ["title", "description", "format"] as const) {
    const hint = value[key];
    if (hint !== undefined && typeof hint !== "string") throw new Error("mcp_elicitation_schema_invalid");
    if (typeof hint === "string" && hasSecretHint(hint)) throw new Error("mcp_elicitation_schema_forbidden");
  }
}

function optionalBoundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error("mcp_elicitation_schema_invalid");
  }
  return Number(value);
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("mcp_elicitation_schema_invalid");
  return value;
}

function matchesStringFormat(format: string, value: string): boolean {
  if (!format) return true;
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri") {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  if (format === "date") return isValidDate(value);
  if (format === "date-time") return isValidDateTime(value);
  return false;
}

function hasSecretHint(value: string): boolean {
  const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ");
  return SECRET_HINT.test(words);
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function isValidDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || !isValidDate(match[1])) return false;
  const [, , hours, minutes, seconds, , offsetHours = "00", offsetMinutes = "00"] = match;
  return Number(hours) <= 23
    && Number(minutes) <= 59
    && Number(seconds) <= 59
    && Number(offsetHours) <= 23
    && Number(offsetMinutes) <= 59
    && Number.isFinite(Date.parse(value));
}

function isPublicHttpsUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || INTERNAL_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) return false;
  const ipv4 = parseIpv4(hostname);
  if (ipv4) return isPublicIpv4(ipv4);
  if (/^[0-9.]+$/.test(hostname)) return false;
  if (hostname.includes(":")) return isPublicIpv6(hostname);
  if (!hostname.includes(".")
    || hostname.length > 253
    || hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  const parsed = parseDomain(hostname);
  return Boolean(parsed.isIcann === true && parsed.domain);
}

function parseIpv4(hostname: string): number[] | null {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
  const octets = hostname.split(".").map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  return !(a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224);
}

function isPublicIpv6(hostname: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(hostname)) return false;
  const first = Number.parseInt(hostname.split(":", 1)[0] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff && !/^2001:db8(?::|$)/i.test(hostname);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, code: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(code);
  return value.trim();
}
