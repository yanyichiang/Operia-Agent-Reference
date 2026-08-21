import { Think, action, type TurnContext } from "@cloudflare/think";
import { tool, type StopCondition, type ToolSet } from "ai";
import { z } from "zod";
import {
  normalizeThinkResolution,
  selectOperiaToolLoop,
  stableApprovalRef,
  THINK_GATE_A_VERSIONS,
  type ThinkApprovalProjection,
} from "./adapter";
import { createGateASyntheticModel } from "./syntheticModel";
import { runRecordedThinkShadow, thinkShadowEnabled } from "./shadow";

type GateAEnv = Cloudflare.Env & {
  MEMORY_THINK_SHADOW_ENABLED?: string;
};

type ApprovalDescriptor = {
  action?: string;
  summary?: string;
  risk?: "low" | "medium" | "high";
  permissions?: string[];
};

const ACTIVE_TOOLS = [
  "syntheticEcho",
  "syntheticWrite",
  "syntheticIdempotentEffect",
] as const;

const APPROVAL_MAP_PREFIX = "gate-a-approval-map:";
const WRITE_COUNT_KEY = "gate-a-write-count";
const IDEMPOTENT_COUNT_KEY = "gate-a-idempotent-count";

const stopOnDurablePause: StopCondition<ToolSet> = ({ steps }) =>
  steps.some((step) =>
    step.toolResults.some((result) => {
      const output = (result as { output?: unknown }).output;
      return Boolean(
        output &&
        typeof output === "object" &&
        (output as Record<string, unknown>).status === "paused"
      );
    })
  );

export class OperiaThinkGateA extends Think<GateAEnv> {
  // Think 0.15 keeps MCP connections available for discovery and Code Mode
  // while preventing their schemas from being auto-merged into the model.
  override includeMcpTools = false;
  override workspaceBash = false;
  override fetchTools: false = false;
  override sendReasoning = false;
  override maxSteps = 12;
  override messageConcurrency = "queue" as const;
  override chatRecovery = {
    maxAttempts: 3,
    noProgressTimeoutMs: 120_000,
    terminalMessage: "Operia 的工具任务中断且未能安全恢复。",
  };
  override actionLedgerPendingRetryLeaseMs: false = false;

  private syntheticModelCalls = 0;
  private lastAssembledToolNames: string[] = [];

  override getModel() {
    return createGateASyntheticModel({
      onCall: () => {
        this.syntheticModelCalls += 1;
      },
    });
  }

  override getSystemPrompt(): string {
    return "Gate A synthetic compatibility fixture. Never access external systems.";
  }

  override getMessengers() {
    return {};
  }

  override getSkills() {
    return [];
  }

  override getSkillScriptRunner() {
    return null;
  }

  override getTools(): ToolSet {
    return {
      syntheticEcho: tool({
        description: "Return a bounded synthetic value.",
        inputSchema: z.object({ value: z.string().max(64) }),
        execute: async ({ value }) => ({ echoed: value }),
      }),
    };
  }

  override getActions() {
    return {
      syntheticWrite: action({
        description: "Record a reversible synthetic approval fixture.",
        inputSchema: z.object({ target: z.string().max(64) }),
        kind: "durable-pause",
        approval: true,
        approvalSummary: "Approve the local synthetic write fixture",
        approvalRisk: "medium",
        permissions: ["gate-a:synthetic-write"],
        idempotencyKey: ({ input }) => `synthetic-write:${input.target}`,
        execute: async ({ target }) => {
          const count = Number(await this.ctx.storage.get<number>(WRITE_COUNT_KEY) ?? 0) + 1;
          await this.ctx.storage.put(WRITE_COUNT_KEY, count);
          return { approved: true, target, count };
        },
      }),
      syntheticIdempotentEffect: action({
        description: "Record one synthetic ledger effect.",
        inputSchema: z.object({ key: z.string().max(64) }),
        idempotencyKey: ({ input }) => `synthetic-idempotency:${input.key}`,
        execute: async ({ key }) => {
          const count = Number(await this.ctx.storage.get<number>(IDEMPOTENT_COUNT_KEY) ?? 0) + 1;
          await this.ctx.storage.put(IDEMPOTENT_COUNT_KEY, count);
          return { effect: "recorded", key, count };
        },
      }),
    };
  }

  override authorizeTurn() {
    return {
      allowed: true,
      grantedPermissions: ["gate-a:synthetic-write"],
    };
  }

  override beforeTurn(ctx: TurnContext) {
    this.lastAssembledToolNames = Object.keys(ctx.tools).sort();
    return {
      activeTools: [...ACTIVE_TOOLS],
      maxRetries: 0,
      stopWhen: stopOnDurablePause,
    };
  }

  private async resetFixture(): Promise<void> {
    await this.clearMessages();
    this.syntheticModelCalls = 0;
    this.lastAssembledToolNames = [];
  }

  private async messagesJson(): Promise<string> {
    return JSON.stringify(await this.getMessages())
      .replace(/actpause_[a-zA-Z0-9-]+/g, "<isolated-think-execution>");
  }

  private async projectPending(): Promise<ThinkApprovalProjection[]> {
    const pending = await this.pendingApprovals();
    const projections: ThinkApprovalProjection[] = [];
    for (const item of pending) {
      const executionId = item.executionId;
      const approvalRef = await stableApprovalRef(executionId);
      await this.ctx.storage.put(`${APPROVAL_MAP_PREFIX}${approvalRef}`, executionId);
      const descriptor = item.descriptor as ApprovalDescriptor;
      projections.push({
        approvalRef,
        action: descriptor.action ?? "unknown",
        summary: descriptor.summary ?? "Approval required",
        risk: descriptor.risk ?? "medium",
        permissions: descriptor.permissions ?? [],
      });
    }
    return projections;
  }

  async gateAContract(): Promise<Record<string, unknown>> {
    return {
      versions: THINK_GATE_A_VERSIONS,
      includeMcpTools: this.includeMcpTools,
      modelMode: "injected-language-model",
      workspaceBash: this.workspaceBash,
      fetchTools: this.fetchTools,
      messengerCount: Object.keys(this.getMessengers()).length,
      skillCount: (await this.getSkills()).length,
      skillScriptRunner: this.getSkillScriptRunner(),
      activeTools: [...ACTIVE_TOOLS],
      fallbackDisabled: selectOperiaToolLoop({
        thinkEnabled: false,
        thinkCompatible: true,
      }),
      fallbackIncompatible: selectOperiaToolLoop({
        thinkEnabled: true,
        thinkCompatible: false,
      }),
      shadowEnabled: thinkShadowEnabled(this.env),
      shadowDefaultEnabled: thinkShadowEnabled({}),
    };
  }

  async runRecordedShadow(trace: unknown): Promise<Record<string, unknown>> {
    const modelCallsBefore = this.syntheticModelCalls;
    const messagesBefore = (await this.getMessages()).length;
    const result = await runRecordedThinkShadow({
      enabled: thinkShadowEnabled(this.env),
      compatible: true,
      trace,
    });
    const messagesAfter = (await this.getMessages()).length;
    return {
      ...result,
      modelCalls: this.syntheticModelCalls - modelCallsBefore,
      assembledToolNames: [],
      sessionMessagesWritten: messagesAfter - messagesBefore,
    };
  }

  async runToolLoop(): Promise<Record<string, unknown>> {
    await this.resetFixture();
    const result = await this.runTurn({ input: "GATE_A_TOOL_LOOP" });
    return {
      status: result.status,
      continuation: result.continuation,
      messages: await this.messagesJson(),
      modelCalls: this.syntheticModelCalls,
      assembledToolNames: this.lastAssembledToolNames,
    };
  }

  async parkApproval(kind: "approve" | "reject"): Promise<Record<string, unknown>> {
    await this.resetFixture();
    await this.ctx.storage.put(WRITE_COUNT_KEY, 0);
    const marker = kind === "approve" ? "GATE_A_APPROVAL" : "GATE_A_REJECTION";
    const result = await this.runTurn({ input: marker });
    return {
      status: result.status,
      continuation: result.continuation,
      pending: await this.projectPending(),
      writeCount: await this.ctx.storage.get<number>(WRITE_COUNT_KEY) ?? 0,
      messages: await this.messagesJson(),
      modelCalls: this.syntheticModelCalls,
    };
  }

  async resolveApproval(
    approvalRef: string,
    decision: "approve" | "reject",
  ): Promise<Record<string, unknown>> {
    const executionId = await this.ctx.storage.get<string>(`${APPROVAL_MAP_PREFIX}${approvalRef}`);
    if (!executionId) {
      return { resolution: { status: "already_resolved" }, pending: [] };
    }
    await this.ctx.storage.delete(`${APPROVAL_MAP_PREFIX}${approvalRef}`);
    const raw = decision === "approve"
      ? await this.approveExecution(executionId)
      : await this.rejectExecution(executionId, "Gate A synthetic rejection");
    // Think schedules the model continuation after the durable resolution.
    // Give the local runtime a bounded turn of the event loop before observing
    // the transcript; production code will reconcile from durable events.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      resolution: normalizeThinkResolution(raw),
      pending: await this.projectPending(),
      writeCount: await this.ctx.storage.get<number>(WRITE_COUNT_KEY) ?? 0,
      messages: await this.messagesJson(),
      modelCalls: this.syntheticModelCalls,
    };
  }

  async runIdempotency(): Promise<Record<string, unknown>> {
    await this.ctx.storage.put(IDEMPOTENT_COUNT_KEY, 0);
    await this.resetFixture();
    const first = await this.runTurn({ input: "GATE_A_IDEMPOTENCY" });
    const firstMessages = await this.messagesJson();
    await this.clearMessages();
    const second = await this.runTurn({ input: "GATE_A_IDEMPOTENCY" });
    return {
      firstStatus: first.status,
      secondStatus: second.status,
      firstMessages,
      secondMessages: await this.messagesJson(),
      effectCount: await this.ctx.storage.get<number>(IDEMPOTENT_COUNT_KEY) ?? 0,
      modelCalls: this.syntheticModelCalls,
    };
  }

  async runAbort(): Promise<Record<string, unknown>> {
    await this.resetFixture();
    const controller = new AbortController();
    const turn = this.runTurn({ input: "GATE_A_ABORT", signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    let error = "";
    let status = "threw";
    let continuation = false;
    try {
      const result = await turn;
      status = result.status;
      continuation = result.continuation;
    } catch (caught) {
      error = caught instanceof Error ? `${caught.name}:${caught.message}` : String(caught);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      error,
      status,
      continuation,
      modelCalls: this.syntheticModelCalls,
      messages: await this.messagesJson(),
      pending: await this.projectPending(),
    };
  }
}
