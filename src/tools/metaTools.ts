import { TELEGRAM_REACTION_EMOJI_VALUES } from "./telegramInteractionContract";

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    strict?: boolean;
    parameters: ToolParameters;
  };
}

export type CanonicalExecutionMode = "context" | "delegated" | "direct" | "hybrid";

export type ToolParameters = {
  type: "object";
  properties: Record<string,
    | { type: "string" | "integer"; description: string; enum?: string[]; minimum?: number; maximum?: number; pattern?: string }
    | { type: "array"; description: string; items: { type: "string"; pattern?: string }; minItems?: number; maxItems?: number }
  >;
  required?: string[];
  additionalProperties: false;
};

export type CanonicalToolDefinition = {
  execution: CanonicalExecutionMode;
  exposeToMainModel?: boolean;
  serverId?: "grok" | "voice" | "browser";
  risk: "read" | "message" | "purchase";
  channels?: readonly string[];
  tool: OpenAITool;
};

export const CANONICAL_TOOL_DEFINITIONS: readonly CanonicalToolDefinition[] = [
  {
    execution: "direct",
    risk: "message",
    channels: ["telegram"],
    tool: {
      type: "function",
      function: {
        name: "react_to_message",
        description: "Add one ordinary emoji reaction to one message ID listed in the current Telegram interaction context. In a private chat the targets are owner messages; in a registered Agent room they may be owner or registered-agent messages. You may call this multiple times in the same tool round for different message IDs, including alongside one reply_to_message call.",
        strict: true,
        parameters: {
          type: "object",
          properties: {
            message_id: { type: "integer", description: "Telegram message ID from the current interaction target list." },
            emoji: {
              type: "string",
              description: "One ordinary Telegram reaction emoji from this exact allowlist.",
              enum: [...TELEGRAM_REACTION_EMOJI_VALUES],
            },
          },
          required: ["message_id", "emoji"],
          additionalProperties: false,
        },
      },
    },
  },
  {
    execution: "direct",
    risk: "message",
    channels: ["telegram"],
    tool: {
      type: "function",
      function: {
        name: "reply_to_message",
        description: "Choose which message from the current Telegram interaction context the final text reply should quote. In a private chat the targets are owner messages; in a registered Agent room they may be owner or registered-agent messages. This may be called in the same tool round as one or more react_to_message calls.",
        strict: true,
        parameters: {
          type: "object",
          properties: {
            message_id: { type: "integer", description: "Telegram message ID from the current interaction target list." },
          },
          required: ["message_id"],
          additionalProperties: false,
        },
      },
    },
  },
  {
    execution: "context",
    risk: "read",
    tool: {
      type: "function",
      function: {
        name: "request_context",
        description: "Request a purpose-bound Operia context capsule for the current task.",
        parameters: {
          type: "object",
          properties: {
            purpose: { type: "string", description: "Why this context is needed right now." },
            scope: { type: "string", description: "Optional narrow scope for the requested context." },
          },
          required: ["purpose"],
          additionalProperties: false,
        },
      },
    },
  },
  {
    execution: "delegated",
    risk: "read",
    tool: {
      type: "function",
      function: {
        name: "delegate_action",
        description: "Submit a bounded complex tool task to the GLM planner and wait for a sanitized result.",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string", description: "The exact complex tool task to hand off." },
            context_ref: { type: "string", description: "Optional opaque context capsule reference returned by request_context." },
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
    },
  },
  {
    execution: "hybrid",
    risk: "read",
    tool: {
      type: "function",
      function: {
        name: "browse_web",
        description: "Use the web for a task. This is the only web tool you should choose: Operia routes exact-page public HTTPS reading through Sandbox and live search through the search provider. Rendered Browser UI, clicking, login, forms, pagination, uploads, and observation are currently unavailable.",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string", description: "The complete web goal in the user's language." },
            starting_url: { type: "string", description: "Optional exact HTTPS URL where the task should start." },
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
    },
  },
  {
    execution: "direct",
    exposeToMainModel: false,
    serverId: "browser",
    risk: "read",
    tool: {
      type: "function",
      function: {
        name: "browser_markdown",
        description: "Compatibility quick action: read one exact allowlisted HTTPS URL as bounded Markdown without following links or interacting.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Exact allowlisted HTTPS URL to read." },
          },
          required: ["url"],
          additionalProperties: false,
        },
      },
    },
  },
  {
    execution: "direct",
    exposeToMainModel: false,
    serverId: "grok",
    risk: "read",
    tool: {
      type: "function",
      function: {
        name: "search_web",
        description: "Compatibility quick action: search the live web with Grok and return a bounded evidence bundle with sources.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Specific search question or query." },
            max_sources: { type: "integer", description: "Maximum cited sources to return.", minimum: 1, maximum: 8 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
  },
  {
    execution: "direct",
    serverId: "grok",
    risk: "purchase",
    tool: {
      type: "function",
      function: {
        name: "generate_image",
        description: "Generate one image with Grok Imagine and return a durable media reference.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Complete image-generation prompt." },
            aspect_ratio: { type: "string", description: "Requested aspect ratio.", enum: ["1:1", "3:2", "2:3", "16:9", "9:16"] },
            quality: { type: "string", description: "Image quality tier.", enum: ["standard", "quality"] },
            reference_media_refs: { type: "array", description: "Up to three private agent-media image handles to edit or combine.", items: { type: "string", pattern: "^agent-media:[0-9a-f-]{36}$" }, maxItems: 3 },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    },
  },
  {
    execution: "direct",
    serverId: "voice",
    risk: "message",
    tool: {
      type: "function",
      function: {
        name: "speak",
        description: "Render a short reply with the configured default voice; text remains the canonical response.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to speak, without secrets or hidden reasoning." },
            mode: { type: "string", enum: ["realtime", "quality", "expressive"], description: "Optional voice latency/quality profile." },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
  },
] as const;

export const META_TOOLS: OpenAITool[] = CANONICAL_TOOL_DEFINITIONS
  .filter((definition) => definition.exposeToMainModel !== false && !definition.channels)
  .map((definition) => definition.tool);

export function metaToolsForChannel(channel?: string | null): OpenAITool[] {
  return CANONICAL_TOOL_DEFINITIONS
    .filter((definition) => definition.exposeToMainModel !== false && (!definition.channels || definition.channels.includes(channel || "")))
    .map((definition) => definition.tool);
}

export function findCanonicalTool(name: string): CanonicalToolDefinition | undefined {
  return CANONICAL_TOOL_DEFINITIONS.find((definition) => definition.tool.function.name === name);
}
