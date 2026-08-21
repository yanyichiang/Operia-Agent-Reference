export type TurnExecutionProfile = "answer_only" | "read_tools" | "action" | "code";

export type TrustedTurnProfileSource =
  | "owner_control"
  | "trusted_continuation"
  | "qa_canary";

export type TurnPlan = {
  profile: TurnExecutionProfile;
  executor: "direct" | "think";
  reasonCodes: string[];
  maxModelSteps: number;
  toolSurface: string[];
  latencyBudgetMs: number;
};

export type TurnPlanInput = {
  requestedProfile?: string | null;
  trustedProfileSource?: TrustedTurnProfileSource | null;
};

const PROFILE_BUDGETS: Record<TurnExecutionProfile, Omit<TurnPlan, "profile" | "reasonCodes">> = {
  answer_only: {
    executor: "direct",
    maxModelSteps: 1,
    toolSurface: [],
    latencyBudgetMs: 35_000,
  },
  read_tools: {
    executor: "think",
    maxModelSteps: 4,
    toolSurface: ["begin_final_response", "system_status", "tool_search", "tool_describe", "tool_execute"],
    latencyBudgetMs: 75_000,
  },
  action: {
    executor: "think",
    maxModelSteps: 4,
    toolSurface: ["begin_final_response", "tool_action"],
    latencyBudgetMs: 75_000,
  },
  code: {
    executor: "think",
    maxModelSteps: 4,
    toolSurface: ["begin_final_response", "code_inspect", "code_list", "code_search", "code_read"],
    latencyBudgetMs: 75_000,
  },
};

export function isTurnExecutionProfile(value: unknown): value is TurnExecutionProfile {
  return value === "answer_only" || value === "read_tools" || value === "action" || value === "code";
}

/**
 * Pure HRS-1 execution planner. Text content is intentionally not an input:
 * a turn can enter Think only through an explicit profile carried by an
 * already trusted control/continuation/canary identity.
 */
export function planTurnExecution(input: TurnPlanInput = {}): TurnPlan {
  const requested = input.requestedProfile?.trim().toLowerCase() ?? "";
  const trusted = input.trustedProfileSource ?? null;
  const profile = trusted && isTurnExecutionProfile(requested) ? requested : "answer_only";
  const budget = PROFILE_BUDGETS[profile];
  const reasonCodes = profile === "answer_only"
    ? requested && !trusted
      ? ["UNTRUSTED_PROFILE_IGNORED", "ORDINARY_DIRECT_DEFAULT"]
      : requested && !isTurnExecutionProfile(requested)
        ? ["INVALID_PROFILE_IGNORED", "ORDINARY_DIRECT_DEFAULT"]
        : ["ORDINARY_DIRECT_DEFAULT"]
    : ["EXPLICIT_TRUSTED_PROFILE", `PROFILE_SOURCE_${trusted!.toUpperCase()}`];

  return {
    profile,
    executor: budget.executor,
    reasonCodes,
    maxModelSteps: budget.maxModelSteps,
    toolSurface: [...budget.toolSurface],
    latencyBudgetMs: budget.latencyBudgetMs,
  };
}
