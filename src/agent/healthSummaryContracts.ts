export type AgentHealthSummaryEnv = {
  AGENT_HEALTH_SUMMARY_MODEL_ENABLED?: string;
  AGENT_HEALTH_SUMMARY_DAILY_CALL_LIMIT?: string;
};

export type AgentHealthSummaryWordingRequest = {
  requestId: string;
  ownerHash: string;
  projectionHash: string;
  factsSchema: "operia.health.summary_facts.v1";
  factsHash: string;
  factsBytes: number;
  purpose: "health_summary_wording";
};

export type AgentHealthSummaryUsageReceipt = {
  requestId: string;
  projectionHash: string;
  outcome: "validated" | "schema_rejected" | "fallback" | "outcome_unknown";
  metricKeyCount: number;
  inputBytes: number;
  outputBytes: number;
  modelCallCount: 0 | 1 | 2;
  usageReceiptHash?: string;
};
