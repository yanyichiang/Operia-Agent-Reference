export type TerminalCompleteness = "complete" | "partial" | "failed" | "attention";

export type TerminalCompletenessDecision = {
  completeness: TerminalCompleteness;
  finishReason: string;
  rawFinishReason: string | null;
};

export function classifyTerminalCompleteness(
  finishReasonValue: string | null | undefined,
  rawFinishReasonValue?: string | null,
): TerminalCompletenessDecision {
  const finishReason = finishReasonValue?.trim().toLowerCase() || "unknown";
  const rawFinishReason = rawFinishReasonValue?.trim().toLowerCase() || null;
  const effective = rawFinishReason || finishReason;
  if (["stop","end_turn","stop_sequence"].includes(effective)
    || (effective === finishReason && finishReason === "stop")) {
    return { completeness:"complete",finishReason,rawFinishReason };
  }
  if (["length","max_tokens"].includes(effective)) {
    return { completeness:"partial",finishReason,rawFinishReason };
  }
  if (effective === "error") return { completeness:"failed",finishReason,rawFinishReason };
  return { completeness:"attention",finishReason,rawFinishReason };
}
