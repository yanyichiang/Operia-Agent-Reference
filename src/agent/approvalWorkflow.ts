import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { OperiaAgentRuntime } from "./runtime";

export type ApprovalWorkflowParams = { ticketId: string; runtimeName: string; nonce: string };
export type ApprovalWorkflowDecision = {
  action: "approve" | "reject";
  approvalScope: "once" | "task" | "reject";
  ownerId: string;
  chatId: string;
};
type ApprovalWorkflowEnv = {
  OPERIA_AGENT: DurableObjectNamespace<OperiaAgentRuntime>;
  AGENT_APPROVAL_SERVICE_BEARER?: string;
};

export class OperiaApprovalWorkflow extends WorkflowEntrypoint<ApprovalWorkflowEnv, ApprovalWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<ApprovalWorkflowParams>>, step: WorkflowStep): Promise<unknown> {
    let decision: ApprovalWorkflowDecision | null = null;
    try {
      const received = await step.waitForEvent<ApprovalWorkflowDecision>("wait-for-telegram-owner", {
        type: "telegram-decision",
        timeout: "15 minutes",
      });
      decision = received.payload;
    } catch {
      // Timeout is a terminal denial, never an implicit approval.
    }
    return step.do("apply-one-use-decision", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, async () => {
      const bearer = this.env.AGENT_APPROVAL_SERVICE_BEARER?.trim();
      if (!bearer) throw new Error("approval_service_auth_misconfigured");
      const stub = this.env.OPERIA_AGENT.getByName(event.payload.runtimeName);
      const response = await stub.fetch(`https://<AGENT_SERVICE>.internal/service/approvals/${event.payload.ticketId}/workflow`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ ...(decision ?? { action: "timeout" }), nonce: event.payload.nonce }),
      });
      if (!response.ok) throw new Error(`approval_commit_http_${response.status}`);
      const payload = await response.json<Record<string, unknown>>();
      return { ok: true, status: typeof payload.status === "string" ? payload.status : "applied" };
    });
  }
}
