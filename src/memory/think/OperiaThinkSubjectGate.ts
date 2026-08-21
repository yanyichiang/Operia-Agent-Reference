import type { LanguageModel } from "ai";
import { OperiaThinkHarness } from "./OperiaThinkHarness";

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

function subjectProposalFixtureModel(): LanguageModel {
  const doStream = async (options: { prompt: unknown }) => {
    const prompt = JSON.stringify(options.prompt);
    if (prompt.includes("pending_owner_review")) {
      return {
        stream: stream([
          { type: "text-start", id: "subject-gate-final" },
          { type: "text-delta", id: "subject-gate-final", delta: "SUBJECT_PROPOSAL_PENDING_OWNER_REVIEW" },
          { type: "text-end", id: "subject-gate-final" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: EMPTY_USAGE },
        ]),
      };
    }
    return {
      stream: stream([
        {
          type: "tool-call",
          toolCallId: "subject-gate-proposal",
          toolName: "subject_self_core_propose",
          input: JSON.stringify({
            operation: "add",
            claim_key: "self.commitment.subject_gate_fixture",
            value: "我会把稳定的主体变化写成可审阅的原子提案。",
            assertion_mode: "explicit",
            rationale: "Synthetic wire regression fixture",
          }),
        },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: EMPTY_USAGE },
      ]),
    };
  };
  return {
    specificationVersion: "v3",
    provider: "operia-subject-gate",
    modelId: "synthetic-no-network",
    supportedUrls: {},
    doStream,
    async doGenerate(options: { prompt: unknown }) {
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
  } as unknown as LanguageModel;
}

export class OperiaThinkSubjectGate extends OperiaThinkHarness {
  protected override subjectProposalSurfaceSelected(): boolean {
    return true;
  }

  override getModel(): LanguageModel {
    return subjectProposalFixtureModel();
  }
}
