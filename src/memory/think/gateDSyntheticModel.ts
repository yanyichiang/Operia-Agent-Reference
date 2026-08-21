import type { LanguageModel } from "ai";

type SyntheticCallOptions = {
  prompt: unknown;
  abortSignal?: AbortSignal;
};

type GateDScenario = "system" | "public" | "health" | "calendar" | "unknown";

type GateDModelHooks = {
  onCall(): void;
};

const EMPTY_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function stream(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function textResponse(text: string) {
  return {
    stream: stream([
      { type: "text-start", id: "gate-d-text" },
      { type: "text-delta", id: "gate-d-text", delta: text },
      { type: "text-end", id: "gate-d-text" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: EMPTY_USAGE,
      },
    ]),
  };
}

function toolResponse(toolKey: string, args: Record<string, unknown>) {
  return {
    stream: stream([
      {
        type: "tool-call",
        toolCallId: `gate-d-${toolKey.replace(/[^a-z0-9]/gi, "-")}`,
        toolName: "tool_execute",
        input: JSON.stringify({ toolKey, args }),
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: EMPTY_USAGE,
      },
    ]),
  };
}

function scenario(prompt: string): GateDScenario {
  if (prompt.includes("GATE_D_SYSTEM_STATUS")) return "system";
  if (prompt.includes("GATE_D_PUBLIC_HTTPS")) return "public";
  if (prompt.includes("GATE_D_HEALTH")) return "health";
  if (prompt.includes("GATE_D_CALENDAR")) return "calendar";
  return "unknown";
}

export function createGateDSyntheticModel(hooks: GateDModelHooks): LanguageModel {
  const doStream = async (options: SyntheticCallOptions) => {
    hooks.onCall();
    const prompt = JSON.stringify(options.prompt);
    if (options.abortSignal?.aborted) throw new DOMException("Gate D turn cancelled", "AbortError");
    if (prompt.includes('"route":"direct_read"')) return textResponse("GATE_D_DIRECT_COMPLETE");
    switch (scenario(prompt)) {
      case "system":
        return toolResponse("operia-observer/system_status", {});
      case "public":
        return toolResponse("public-https/read_url", {
          url: "https://developers.cloudflare.com/robots.txt",
        });
      case "health":
        return toolResponse("health/health_summary", { range: "7d" });
      case "calendar":
        return toolResponse("calendar/calendar_list", { limit: 3 });
      default:
        return textResponse("GATE_D_UNKNOWN");
    }
  };

  const model = {
    specificationVersion: "v3" as const,
    provider: "operia-gate-d",
    modelId: "synthetic-no-provider",
    supportedUrls: {},
    doStream,
    async doGenerate(options: SyntheticCallOptions) {
      const result = await doStream(options);
      const reader = result.stream.getReader();
      const content: unknown[] = [];
      let finishReason = { unified: "stop", raw: "stop" };
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const part = next.value as { type?: string; finishReason?: typeof finishReason };
        if (part.type === "finish" && part.finishReason) finishReason = part.finishReason;
        else if (part.type !== "stream-start") content.push(part);
      }
      return { content, finishReason, usage: EMPTY_USAGE, warnings: [] };
    },
  };
  return model as unknown as LanguageModel;
}
