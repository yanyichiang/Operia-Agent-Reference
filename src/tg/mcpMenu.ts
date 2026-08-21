import type { AgentTelegramCommandItem } from "./agentClient";

const REF_HEX_LENGTH = 24;
const CALLBACK_MAX_BYTES = 64;

export type McpMenuCallback =
  | { action: "home" }
  | { action: "root"; section: "internal" | "external" }
  | { action: "internal"; tool: "browser" | "voice" | "memory" }
  | { action: "provider"; providerRef: string }
  | { action: "tool"; providerRef: string; toolRef: string }
  | { action: "opus"; providerRef: string; toolRef: string }
  | { action: "wizard"; choice: number; actionId: string; nonce: string; revision: number }
  | { action: "wizard_skip"; actionId: string; nonce: string; revision: number };

export type McpSimpleField = {
  name: string;
  required: boolean;
  values: unknown[];
};

async function digestRef(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest.slice(0, REF_HEX_LENGTH / 2)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function providerRef(providerId: string): Promise<string> {
  return digestRef(`provider\0${providerId}`);
}

export async function toolRef(providerId: string, toolName: string): Promise<string> {
  return digestRef(`tool\0${providerId}\0${toolName}`);
}

export function encodeMcpMenuCallback(callback: McpMenuCallback): string {
  const data = callback.action === "home"
    ? "m1:h"
    : callback.action === "root"
    ? `m1:r:${callback.section === "internal" ? "i" : "e"}`
    : callback.action === "internal"
      ? `m1:i:${callback.tool === "browser" ? "b" : callback.tool === "voice" ? "v" : "m"}`
      : callback.action === "provider"
        ? `m1:p:${callback.providerRef}`
        : callback.action === "tool"
          ? `m1:t:${callback.providerRef}:${callback.toolRef}`
          : callback.action === "opus"
            ? `m1:o:${callback.providerRef}:${callback.toolRef}`
            : callback.action === "wizard_skip"
              ? `m1:w:s:${callback.actionId}:${callback.nonce}:${callback.revision}`
              : `m1:w:${callback.choice}:${callback.actionId}:${callback.nonce}:${callback.revision}`;
  if (new TextEncoder().encode(data).byteLength > CALLBACK_MAX_BYTES) throw new Error("mcp_callback_too_long");
  return data;
}

export function parseMcpMenuCallback(data: string): McpMenuCallback | null {
  if (new TextEncoder().encode(data).byteLength > CALLBACK_MAX_BYTES) return null;
  if (data === "m1:h") return { action: "home" };
  if (data === "m1:r:i") return { action: "root", section: "internal" };
  if (data === "m1:r:e") return { action: "root", section: "external" };
  if (data === "m1:i:b") return { action: "internal", tool: "browser" };
  if (data === "m1:i:v") return { action: "internal", tool: "voice" };
  if (data === "m1:i:m") return { action: "internal", tool: "memory" };
  const wizard = /^m1:w:(s|\d{1,3}):(pa_[a-f0-9]{16}):([a-f0-9]{16}):(\d{1,9})$/.exec(data);
  if (wizard) return wizard[1] === "s"
    ? { action:"wizard_skip",actionId:wizard[2],nonce:wizard[3],revision:Number(wizard[4]) }
    : { action:"wizard",choice:Number(wizard[1]),actionId:wizard[2],nonce:wizard[3],revision:Number(wizard[4]) };
  const provider = new RegExp(`^m1:p:([a-f0-9]{${REF_HEX_LENGTH}})$`).exec(data);
  if (provider) return { action: "provider", providerRef: provider[1] };
  const tool = new RegExp(`^m1:([to]):([a-f0-9]{${REF_HEX_LENGTH}}):([a-f0-9]{${REF_HEX_LENGTH}})$`).exec(data);
  if (tool) return { action: tool[1] === "t" ? "tool" : "opus", providerRef: tool[2], toolRef: tool[3] };
  return null;
}

export async function findProviderByRef(items: AgentTelegramCommandItem[], ref: string): Promise<AgentTelegramCommandItem | null> {
  const matches = (await Promise.all(items.filter((item) => item.id).map(async (item) => ({ item, ref: await providerRef(item.id!) }))))
    .filter((candidate) => candidate.ref === ref);
  return matches.length === 1 ? matches[0].item : null;
}

export async function findToolByRef(providerId: string, items: AgentTelegramCommandItem[], ref: string): Promise<AgentTelegramCommandItem | null> {
  const matches = (await Promise.all(items.filter((item) => item.id).map(async (item) => ({ item, ref: await toolRef(providerId, item.id!) }))))
    .filter((candidate) => candidate.ref === ref);
  return matches.length === 1 ? matches[0].item : null;
}

export function simpleSchemaFields(schema: Record<string, unknown>): { fields: McpSimpleField[]; hasRequiredComplexField: boolean } {
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  const fields: McpSimpleField[] = [];
  let hasRequiredComplexField = false;
  for (const [name, raw] of Object.entries(properties)) {
    const field = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const values = Array.isArray(field.enum) && field.enum.length > 0 && field.enum.length <= 12
      ? field.enum.filter((value) => ["string", "number", "boolean"].includes(typeof value))
      : field.type === "boolean" ? [true, false] : [];
    if (values.length > 0) fields.push({ name, required: required.has(name), values });
    else if (required.has(name)) hasRequiredComplexField = true;
  }
  return { fields, hasRequiredComplexField };
}
