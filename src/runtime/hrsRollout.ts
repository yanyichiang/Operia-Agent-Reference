import type { TurnPlan } from "./turnPlan";

export type HrsRolloutMode = "shadow" | "enforced";

export type HrsRollout = {
  turn: HrsRolloutMode;
};

type HrsRolloutEnv = {
  HRS_TURN_PLAN_ENFORCED?: string;
};

function enforced(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

/**
 * The only HRS rollout decision point. The Turn planner always runs, but callers use
 * this immutable adapter to select either the accepted 9875d34 behavior or the
 * new latency path. Recall and Publication authority are intentionally absent.
 */
export function resolveHrsRollout(env: HrsRolloutEnv): HrsRollout {
  return {
    turn: enforced(env.HRS_TURN_PLAN_ENFORCED) ? "enforced" : "shadow",
  };
}

export function hrsThinkSelected(input: {
  rollout: HrsRollout;
  plan: TurnPlan;
  acceptedThinkEligible: boolean;
}): boolean {
  if (!input.acceptedThinkEligible) return false;
  return input.rollout.turn === "shadow" || input.plan.executor === "think";
}
