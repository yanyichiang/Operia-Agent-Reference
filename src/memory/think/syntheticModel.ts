import type { LanguageModel } from "ai";

type SyntheticCallOptions = {
  prompt: unknown;
  abortSignal?: AbortSignal;
};

type SyntheticScenario =
  | "tool-loop"
  | "approval"
  | "rejection"
  | "idempotency"
  | "s2-action"
  | "s2-failure"
  | "s3-codemode"
  | "abort"
  | "unknown";

type SyntheticModelHooks = {
  onCall(): void;
};

const EMPTY_USAGE = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: {
    total: 1,
    text: 1,
    reasoning: 0,
  },
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
      { type: "text-start", id: "gate-a-text" },
      { type: "text-delta", id: "gate-a-text", delta: text },
      { type: "text-end", id: "gate-a-text" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: EMPTY_USAGE,
      },
    ]),
  };
}

function toolResponse(toolName: string, input: Record<string, unknown>) {
  return {
    stream: stream([
      {
        type: "tool-call",
        toolCallId: `gate-a-${toolName}`,
        toolName,
        input: JSON.stringify(input),
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: EMPTY_USAGE,
      },
    ]),
  };
}

function scenarioFromPrompt(serializedPrompt: string): SyntheticScenario {
  if (serializedPrompt.includes("GATE_A_TOOL_LOOP")) return "tool-loop";
  if (serializedPrompt.includes("GATE_A_APPROVAL")) return "approval";
  if (serializedPrompt.includes("GATE_A_REJECTION")) return "rejection";
  if (serializedPrompt.includes("GATE_A_IDEMPOTENCY")) return "idempotency";
  if (serializedPrompt.includes("GATE_S2_ACTION")) return "s2-action";
  if (serializedPrompt.includes("GATE_S2_FAILURE")) return "s2-failure";
  if (serializedPrompt.includes("GATE_S3_CODEMODE")) return "s3-codemode";
  if (serializedPrompt.includes("GATE_A_ABORT")) return "abort";
  return "unknown";
}

function abortedResponse(options: SyntheticCallOptions) {
  return {
    stream: new ReadableStream({
      start(controller) {
        const abort = () => controller.error(new DOMException("Gate A turn cancelled", "AbortError"));
        if (options.abortSignal?.aborted) {
          abort();
          return;
        }
        options.abortSignal?.addEventListener("abort", abort, { once: true });
      },
    }),
  };
}

export function createGateASyntheticModel(hooks: SyntheticModelHooks): LanguageModel {
  const doStream = async (options: SyntheticCallOptions) => {
    hooks.onCall();
    const prompt = JSON.stringify(options.prompt);
    const scenario = scenarioFromPrompt(prompt);

    if (scenario === "abort") return abortedResponse(options);
    if (prompt.includes('"status":"paused"')) {
      return textResponse("GATE_A_APPROVAL_PARKED");
    }
    if (prompt.includes('"echoed":"gate-a"')) {
      return textResponse("GATE_A_TOOL_LOOP_COMPLETE");
    }
    if (prompt.includes('"approved":true')) {
      return textResponse("GATE_A_APPROVAL_COMPLETE");
    }
    if (prompt.includes('"status":"rejected"')) {
      return textResponse("GATE_A_REJECTION_COMPLETE");
    }
    if (prompt.includes('"effect":"recorded"')) {
      return textResponse("GATE_A_IDEMPOTENCY_COMPLETE");
    }

    switch (scenario) {
      case "tool-loop":
        return toolResponse("syntheticEcho", { value: "gate-a" });
      case "approval":
        return toolResponse("syntheticWrite", { target: "approval-fixture" });
      case "rejection":
        return toolResponse("syntheticWrite", { target: "rejection-fixture" });
      case "idempotency":
        return toolResponse("syntheticIdempotentEffect", { key: "stable-fixture-key" });
      case "s2-action":
        return toolResponse("tool_action", {
          operationKey: "calendar-read-2026-07-28",
          toolKey: "fixture/metered_read",
          args: { date: "2026-07-28" },
        });
      case "s2-failure":
        return toolResponse("tool_action", {
          operationKey: "known-failure-no-retry",
          toolKey: "fixture/failing_read",
          args: {},
        });
      case "s3-codemode":
        return toolResponse("execute_codemode", {
          code: "async () => tools.tool_action({ operationKey: 's3-metered-read', toolKey: 'fixture/metered_read', args: { date: '2026-07-28' } })",
        });
      default:
        return textResponse("GATE_A_UNKNOWN");
    }
  };

  const model = {
    specificationVersion: "v3" as const,
    provider: "operia-gate-a",
    modelId: "synthetic-no-network",
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
      return {
        content,
        finishReason,
        usage: EMPTY_USAGE,
        warnings: [],
      };
    },
  };

  // The fixture implements the AI SDK v3 provider contract without importing a
  // provider package or credential-bearing transport. Wrangler/typecheck is the
  // compatibility assertion for this isolated Gate A adapter.
  return model as unknown as LanguageModel;
}
