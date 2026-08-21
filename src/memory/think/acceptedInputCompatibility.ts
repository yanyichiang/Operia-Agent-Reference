import type { OperiaThinkRunInput } from "./OperiaThinkHarness";

type StoredAcceptedRunInput = OperiaThinkRunInput & {
  authorityMode?: OperiaThinkRunInput["authorityMode"];
  executionProfile?: OperiaThinkRunInput["executionProfile"];
  maxModelSteps?: number;
  latencyBudgetMs?: number;
};

/**
 * Upgrade only pre-HRS continuation records. Fresh inputs, and every HRS
 * production reservation, remain subject to the strict run-input contract.
 */
export function restoreAcceptedRunInput(input: OperiaThinkRunInput): OperiaThinkRunInput {
  const stored = input as StoredAcceptedRunInput;
  const missingHrsFields = stored.authorityMode === undefined
    || stored.executionProfile === undefined
    || stored.maxModelSteps === undefined
    || stored.latencyBudgetMs === undefined;
  if (!missingHrsFields) return input;
  if (stored.authorityMode !== undefined && stored.authorityMode !== "accepted") {
    throw new Error("operia_think_hrs_restore_input_incomplete");
  }
  return {
    ...stored,
    authorityMode: "accepted",
    executionProfile: stored.executionProfile ?? "read_tools",
    maxModelSteps: stored.maxModelSteps ?? 9,
    latencyBudgetMs: stored.latencyBudgetMs ?? 90_000,
  };
}
