import { findCanonicalTool, META_TOOLS, metaToolsForChannel } from "./metaTools";
import type { OpenAIChatMessage, OpenAIChatRequest, OpenAIChatResponse } from "../types";

export interface CanonicalToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ParsedToolRound {
  assistant: OpenAIChatMessage & { role: "assistant"; tool_calls: CanonicalToolCall[] };
  toolCalls: CanonicalToolCall[];
}

export interface ContinuationMode {
  hasToolMessages: boolean;
  isContinuation: boolean;
  idempotencyKey: string | null;
  lastConversationMessage: OpenAIChatMessage | null;
  lastUserMessage: OpenAIChatMessage | null;
  shouldSaveUserMessage: boolean;
  shouldRunRecall: boolean;
}

export type ContinuationValidationCode =
  | "continuation_validation_failed"
  | "tool_calls_missing"
  | "tool_call_shape_invalid"
  | "tool_call_id_invalid"
  | "tool_name_unknown"
  | "tool_arguments_not_string"
  | "tool_arguments_invalid_json"
  | "tool_arguments_not_object"
  | "tool_argument_required_invalid"
  | "tool_argument_unsupported"
  | "tool_argument_type_invalid"
  | "tool_argument_enum_invalid"
  | "tool_argument_range_invalid"
  | "tool_call_content_invalid";

export class ContinuationValidationError extends Error {
  constructor(message: string, public readonly code: ContinuationValidationCode = "continuation_validation_failed") {
    super(message);
    this.name = "ContinuationValidationError";
  }
}

const META_TOOL_NAMES = new Set(
  META_TOOLS.map((tool) => tool.function.name)
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseArguments(name: string, value: unknown): void {
  if (typeof value !== "string") {
    throw new ContinuationValidationError(`Tool ${name} arguments must be a JSON string`, "tool_arguments_not_string");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ContinuationValidationError(`Tool ${name} arguments must be valid JSON`, "tool_arguments_invalid_json");
  }
  if (!isRecord(parsed)) {
    throw new ContinuationValidationError(`Tool ${name} arguments must be an object`, "tool_arguments_not_object");
  }

  const definition = findCanonicalTool(name);
  if (!definition) throw new ContinuationValidationError(`Unknown canonical tool ${name}`, "tool_name_unknown");
  const schema = definition.tool.function.parameters;
  const allowed = new Set(Object.keys(schema.properties));
  for (const required of schema.required ?? []) {
    const property = schema.properties[required];
    const candidate = parsed[required];
    if (property.type === "string" && (typeof candidate !== "string" || candidate.trim() === "")) {
      throw new ContinuationValidationError(`Tool ${name} requires a non-empty ${required}`, "tool_argument_required_invalid");
    }
    if (property.type === "integer" && !Number.isInteger(candidate)) {
      throw new ContinuationValidationError(`Tool ${name} requires integer ${required}`, "tool_argument_required_invalid");
    }
    if (property.type === "array" && !Array.isArray(candidate)) {
      throw new ContinuationValidationError(`Tool ${name} requires array ${required}`, "tool_argument_required_invalid");
    }
  }
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) {
      throw new ContinuationValidationError(`Tool ${name} has unsupported argument ${key}`, "tool_argument_unsupported");
    }
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    const candidate = parsed[key];
    if (candidate === undefined) continue;
    if (property.type === "string" && typeof candidate !== "string") throw new ContinuationValidationError(`Tool ${name} argument ${key} must be a string`, "tool_argument_type_invalid");
    if (property.type === "integer" && !Number.isInteger(candidate)) throw new ContinuationValidationError(`Tool ${name} argument ${key} must be an integer`, "tool_argument_type_invalid");
    if (property.type === "array") {
      if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string")) throw new ContinuationValidationError(`Tool ${name} argument ${key} must be a string array`, "tool_argument_type_invalid");
      if (property.minItems !== undefined && candidate.length < property.minItems) throw new ContinuationValidationError(`Tool ${name} argument ${key} has too few items`, "tool_argument_range_invalid");
      if (property.maxItems !== undefined && candidate.length > property.maxItems) throw new ContinuationValidationError(`Tool ${name} argument ${key} has too many items`, "tool_argument_range_invalid");
      if (property.items.pattern) {
        const pattern = new RegExp(property.items.pattern);
        if (candidate.some((item) => !pattern.test(item))) throw new ContinuationValidationError(`Tool ${name} argument ${key} contains an invalid item`, "tool_argument_type_invalid");
      }
      continue;
    }
    if (property.enum && !property.enum.includes(candidate as string)) throw new ContinuationValidationError(`Tool ${name} argument ${key} is not allowed`, "tool_argument_enum_invalid");
    if (typeof candidate === "number" && property.minimum !== undefined && candidate < property.minimum) throw new ContinuationValidationError(`Tool ${name} argument ${key} is too small`, "tool_argument_range_invalid");
    if (typeof candidate === "number" && property.maximum !== undefined && candidate > property.maximum) throw new ContinuationValidationError(`Tool ${name} argument ${key} is too large`, "tool_argument_range_invalid");
  }
}

function parseCanonicalToolCalls(value: unknown): CanonicalToolCall[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ContinuationValidationError("assistant.tool_calls must be a non-empty array", "tool_calls_missing");
  }

  const ids = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry) || entry.type !== "function" || !isRecord(entry.function)) {
      throw new ContinuationValidationError("assistant.tool_calls must use function calls", "tool_call_shape_invalid");
    }
    const id = entry.id;
    const name = entry.function.name;
    const argumentsText = entry.function.arguments;
    if (typeof id !== "string" || id.trim() === "" || ids.has(id)) {
      throw new ContinuationValidationError("Tool call ids must be non-empty and unique per round", "tool_call_id_invalid");
    }
    if (typeof name !== "string" || !findCanonicalTool(name)) {
      throw new ContinuationValidationError("Only canonical Operia tool calls are allowed", "tool_name_unknown");
    }
    parseArguments(name, argumentsText);
    ids.add(id);
    return {
      id,
      type: "function" as const,
      function: { name, arguments: argumentsText as string },
    };
  });
}

function findLastConversationMessage(messages: OpenAIChatMessage[]): OpenAIChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== "system") return messages[i];
  }
  return null;
}

function findLastUserIndex(messages: OpenAIChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function consumeCanonicalToolResult(
  message: OpenAIChatMessage,
  pendingCalls: Map<string, string>
): void {
  const toolCallId = message.tool_call_id;
  if (typeof toolCallId !== "string") {
    throw new ContinuationValidationError("Tool result id does not match a pending tool call");
  }
  const expectedName = pendingCalls.get(toolCallId);
  if (!expectedName) {
    throw new ContinuationValidationError("Tool result id does not match a pending tool call");
  }
  if (message.name !== undefined && message.name !== expectedName) {
    throw new ContinuationValidationError("Tool result name does not match its canonical tool call");
  }
  if (typeof message.content !== "string") {
    throw new ContinuationValidationError("Tool result content must be a string");
  }
  if (message.tool_calls != null) {
    throw new ContinuationValidationError("Tool results cannot contain nested tool calls");
  }
  pendingCalls.delete(toolCallId);
}

function validateAllToolRounds(messages: OpenAIChatMessage[]): boolean {
  let pendingCalls: Map<string, string> | null = null;
  let sawTools = false;
  const seenCallIds = new Set<string>();

  for (const message of messages) {
    const hasToolCalls = message.tool_calls !== undefined && message.tool_calls !== null;
    if (message.role === "assistant" && hasToolCalls) {
      if (pendingCalls) {
        throw new ContinuationValidationError("A tool round is missing results");
      }
      if (message.content !== null && typeof message.content !== "string") {
        throw new ContinuationValidationError("Canonical tool-call assistant content must be text or null");
      }
      const calls = parseCanonicalToolCalls(message.tool_calls);
      for (const toolCall of calls) {
        if (seenCallIds.has(toolCall.id)) {
          throw new ContinuationValidationError("Tool call ids must be unique across the history");
        }
        seenCallIds.add(toolCall.id);
      }
      pendingCalls = new Map(
        calls.map((toolCall) => [toolCall.id, toolCall.function.name] as const)
      );
      sawTools = true;
      continue;
    }

    if (message.role === "tool") {
      if (!pendingCalls) {
        throw new ContinuationValidationError("Tool results must follow a canonical assistant tool call");
      }
      consumeCanonicalToolResult(message, pendingCalls);
      if (pendingCalls.size === 0) pendingCalls = null;
      sawTools = true;
      continue;
    }

    if (pendingCalls) {
      throw new ContinuationValidationError("Tool results must be a contiguous complete suffix");
    }
  }

  if (pendingCalls) {
    throw new ContinuationValidationError("Tool call history is incomplete");
  }
  return sawTools;
}

function validateTerminalSuffix(messages: OpenAIChatMessage[], lastUserIndex: number): string {
  if (lastUserIndex < 0) {
    throw new ContinuationValidationError("A continuation requires an earlier user message");
  }
  const suffix = messages.slice(lastUserIndex + 1);
  if (suffix.length < 2 || suffix[0].role !== "assistant" || suffix.at(-1)?.role !== "tool") {
    throw new ContinuationValidationError("Continuation must be a terminal tool-call/result suffix");
  }

  let index = 0;
  while (index < suffix.length) {
    const assistant = suffix[index];
    if (assistant.role !== "assistant" || assistant.tool_calls == null) {
      throw new ContinuationValidationError("Continuation rounds must start with assistant.tool_calls");
    }
    const calls = parseCanonicalToolCalls(assistant.tool_calls);
    const expected = new Map(
      calls.map((toolCall) => [toolCall.id, toolCall.function.name] as const)
    );
    index += 1;
    while (index < suffix.length && suffix[index].role === "tool") {
      consumeCanonicalToolResult(suffix[index], expected);
      index += 1;
    }
    if (expected.size > 0) {
      throw new ContinuationValidationError("Continuation is missing tool results");
    }
  }

  return `continuation:${JSON.stringify(suffix)}`;
}

function normalizeToolChoice(toolChoice: unknown): unknown {
  if (toolChoice == null) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return toolChoice;
  if (!isRecord(toolChoice)) return "auto";
  if (toolChoice.type !== "function") return "auto";
  const name = isRecord(toolChoice.function) && typeof toolChoice.function.name === "string"
    ? toolChoice.function.name
    : "";
  if (!META_TOOL_NAMES.has(name)) return "auto";
  return { type: "function", function: { name } };
}

export function getContinuationMode(messages: OpenAIChatMessage[]): ContinuationMode {
  const lastConversationMessage = findLastConversationMessage(messages);
  const lastUserIndex = findLastUserIndex(messages);
  const lastUserMessage = lastUserIndex >= 0 ? messages[lastUserIndex] : null;
  const toolMessages = validateAllToolRounds(messages);
  const isContinuation = lastConversationMessage?.role === "tool";

  if (lastConversationMessage?.role !== "user" && !isContinuation) {
    throw new ContinuationValidationError("Request must end with a user message or complete tool results");
  }
  const idempotencyKey = isContinuation
    ? validateTerminalSuffix(messages, lastUserIndex)
    : null;

  return {
    hasToolMessages: toolMessages,
    isContinuation,
    idempotencyKey,
    lastConversationMessage,
    lastUserMessage,
    shouldSaveUserMessage: !isContinuation,
    shouldRunRecall: !isContinuation,
  };
}

export function canonicalizeMainModelRequest(body: OpenAIChatRequest, channel?: string | null): OpenAIChatRequest {
  getContinuationMode(body.messages);
  const toolChoice = normalizeToolChoice(body.tool_choice);
  return {
    ...body,
    tools: metaToolsForChannel(channel),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };
}

export function parseToolRound(response: OpenAIChatResponse): ParsedToolRound | null {
  const message = response.choices?.[0]?.message;
  if (!message || message.role !== "assistant" || message.tool_calls == null) return null;
  const toolCalls = parseCanonicalToolCalls(message.tool_calls);
  if (message.content !== null && typeof message.content !== "string") {
    throw new ContinuationValidationError("Canonical tool-call assistant content must be text or null", "tool_call_content_invalid");
  }

  return {
    assistant: {
      ...message,
      role: "assistant",
      content: message.content ?? null,
      tool_calls: toolCalls,
    },
    toolCalls,
  };
}

export function shouldArchiveAssistantResponse(response: OpenAIChatResponse): boolean {
  return parseToolRound(response) == null;
}
