import { classifyTerminalCompleteness, type TerminalCompleteness } from "../../reliability/terminalCompleteness";

export type HostFinalStepInput = {
  finishReason: string;
  rawFinishReason?: string | null;
  toolCallCount: number;
  text: string;
};

export type HostFinalStepDecision =
  | {
      kind: "continue";
      finishReason: string;
      rawFinishReason: string | null;
    }
  | {
      kind: "final";
      finishReason: string;
      rawFinishReason: string | null;
      text: string;
      completeness: TerminalCompleteness;
    };

/**
 * AI SDK continues the agent loop only for a tool-calls step. Every other
 * finish reason is terminal for the current model step. The Harness therefore
 * owns final-answer recognition from provider metadata instead of requiring a
 * model-authored marker or tool call.
 */
export function decideHostFinalStep(input: HostFinalStepInput): HostFinalStepDecision {
  const finishReason = input.finishReason.trim().toLowerCase() || "unknown";
  const rawFinishReason = input.rawFinishReason?.trim().toLowerCase() || null;
  if (finishReason === "tool-calls" || input.toolCallCount > 0
    || rawFinishReason === "pause_turn" || rawFinishReason === "compaction") {
    return { kind: "continue", finishReason, rawFinishReason };
  }
  return { kind: "final", finishReason, rawFinishReason, text: input.text,
    completeness:classifyTerminalCompleteness(finishReason,rawFinishReason).completeness };
}
