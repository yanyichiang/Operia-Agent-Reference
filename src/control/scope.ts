import { ControlPlaneCoreError } from "./errors";
import type { ControlScopeRef, ControlScopeType, NextTurnScopeRef } from "./types";

const SCOPE_FIELDS = {
  channel: ["type", "channel"],
  chat: ["type", "channel", "chatId"],
  device: ["type", "channel", "deviceId"],
  next_turn: ["type", "channel", "recipientType", "recipientId"],
} as const;

export function parseControlScopeRef(value: unknown): ControlScopeRef {
  if (!isRecord(value) || typeof value.type !== "string" || !Object.prototype.hasOwnProperty.call(SCOPE_FIELDS, value.type)) {
    throw new ControlPlaneCoreError("invalid_scope", "unknown_type");
  }

  const type = value.type as keyof typeof SCOPE_FIELDS;
  const expectedFields = SCOPE_FIELDS[type];
  const actualFields = Object.keys(value).sort();
  if (!sameStrings(actualFields, [...expectedFields].sort())) {
    throw new ControlPlaneCoreError("invalid_scope", "unexpected_or_missing_fields");
  }
  if (!nonEmpty(value.channel)) throw new ControlPlaneCoreError("invalid_scope", "channel_required");

  if (type === "channel") return { type, channel: value.channel as string };
  if (type === "chat") {
    if (!nonEmpty(value.chatId)) throw new ControlPlaneCoreError("invalid_scope", "chat_id_required");
    return { type, channel: value.channel as string, chatId: value.chatId as string };
  }
  if (type === "device") {
    if (!nonEmpty(value.deviceId)) throw new ControlPlaneCoreError("invalid_scope", "device_id_required");
    return { type, channel: value.channel as string, deviceId: value.deviceId as string };
  }
  if ((value.recipientType !== "chat" && value.recipientType !== "device") || !nonEmpty(value.recipientId)) {
    throw new ControlPlaneCoreError("invalid_scope", "recipient_required");
  }
  return {
    type,
    channel: value.channel as string,
    recipientType: value.recipientType,
    recipientId: value.recipientId as string,
  };
}

export function assertAllowedScope(scope: ControlScopeRef, allowedScopes: readonly ControlScopeType[]): void {
  if (!allowedScopes.includes(scope.type)) throw new ControlPlaneCoreError("scope_not_allowed", scope.type);
}

export function controlScopeKey(scope: ControlScopeRef): string {
  const parsed = parseControlScopeRef(scope);
  switch (parsed.type) {
    case "channel": return `channel:${encode(parsed.channel)}`;
    case "chat": return `chat:${encode(parsed.channel)}:${encode(parsed.chatId)}`;
    case "device": return `device:${encode(parsed.channel)}:${encode(parsed.deviceId)}`;
    case "next_turn": return `next_turn:${encode(parsed.channel)}:${parsed.recipientType}:${encode(parsed.recipientId)}`;
  }
}

export function scopeAppliesTo(scope: ControlScopeRef, target: ControlScopeRef): boolean {
  const candidate = parseControlScopeRef(scope);
  const requested = parseControlScopeRef(target);
  if (candidate.channel !== requested.channel) return false;
  if (candidate.type === "channel") return true;
  if (requested.type === "next_turn" && candidate.type === requested.recipientType) {
    return candidate.type === "chat"
      ? candidate.chatId === requested.recipientId
      : candidate.deviceId === requested.recipientId;
  }
  if (candidate.type !== requested.type) return false;
  if (candidate.type === "chat" && requested.type === "chat") return candidate.chatId === requested.chatId;
  if (candidate.type === "device" && requested.type === "device") return candidate.deviceId === requested.deviceId;
  return candidate.type === "next_turn" && requested.type === "next_turn"
    && candidate.recipientType === requested.recipientType
    && candidate.recipientId === requested.recipientId;
}

export function sameNextTurnRecipient(left: NextTurnScopeRef, right: NextTurnScopeRef): boolean {
  return controlScopeKey(left) === controlScopeKey(right);
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
