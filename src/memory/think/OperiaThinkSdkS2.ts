import { Think, type Action, type ActionContext, type TurnContext } from "@cloudflare/think";
import type { ToolSet } from "ai";
import { createGateASyntheticModel } from "./syntheticModel";
import { createOperiaSdkToolAction, type OperiaSdkToolActionInput } from "./sdkToolAction";

type GateS2Env = Cloudflare.Env & { THINK_SDK_S2_ENABLED?: string };
type ApprovalDescriptor = { action?: string; summary?: string; risk?: "low" | "medium" | "high"; input?: unknown };
const PREFLIGHT_PREFIX = "s2:preflight:";
const EFFECT_COUNT = "s2:effect-count";
const FAILURE_COUNT = "s2:failure-count";

export class OperiaThinkSdkS2 extends Think<GateS2Env> {
  override includeMcpTools = false;
  override workspaceBash = false;
  override fetchTools: false = false;
  override sendReasoning = false;
  override maxSteps = 6;
  override actionLedgerPendingRetryLeaseMs: false = false;
  private modelCalls = 0;

  override getModel() {
    return createGateASyntheticModel({ onCall: () => { this.modelCalls += 1; } });
  }

  override getSystemPrompt() { return "S2 official Think Action fixture. No external systems."; }
  override getMessengers() { return {}; }
  override getSkills() { return []; }
  override getSkillScriptRunner() { return null; }
  override getTools(): ToolSet { return {}; }
  override authorizeTurn() { return { allowed: true, grantedPermissions: ["operia:read-tools"] }; }
  override beforeTurn(_ctx: TurnContext) { return { activeTools: ["tool_action"], maxRetries: 0 }; }

  override getActions(): Record<string, Action> {
    if (this.env.THINK_SDK_S2_ENABLED !== "true") return {};
    return {
      tool_action: createOperiaSdkToolAction({
        preflight: (input, ctx) => this.preflight(input, ctx),
        execute: (input, ctx) => this.executeGranted(input, ctx),
        idempotencyKey: (input) => `s2:${input.operationKey}`,
      }),
    };
  }

  private async preflight(input: OperiaSdkToolActionInput, ctx: ActionContext): Promise<void> {
    if (!input.toolKey.startsWith("fixture/")) throw new Error("s2_tool_policy_denied");
    await this.ctx.storage.put(`${PREFLIGHT_PREFIX}${ctx.toolCallId}`, {
      toolCallId: ctx.toolCallId,
      operationKey: input.operationKey,
      toolKey: input.toolKey,
      args: input.args,
      policyVersion: "s2-fixture-v1",
      status: "proposed",
    });
  }

  private async executeGranted(input: OperiaSdkToolActionInput, ctx: ActionContext): Promise<unknown> {
    const key = `${PREFLIGHT_PREFIX}${ctx.toolCallId}`;
    const plan = await this.ctx.storage.get<Record<string, unknown>>(key);
    if (!plan || plan.status !== "proposed" || plan.operationKey !== input.operationKey || plan.toolKey !== input.toolKey
      || JSON.stringify(plan.args) !== JSON.stringify(input.args)) throw new Error("s2_exact_grant_missing_or_drifted");
    await this.ctx.storage.put(key, { ...plan, status: "consuming" });
    if (input.toolKey === "fixture/failing_read") {
      const attempts = Number(await this.ctx.storage.get<number>(FAILURE_COUNT) ?? 0) + 1;
      await this.ctx.storage.put(FAILURE_COUNT, attempts);
      throw new Error("s2_known_provider_failure");
    }
    const count = Number(await this.ctx.storage.get<number>(EFFECT_COUNT) ?? 0) + 1;
    await this.ctx.storage.put(EFFECT_COUNT, count);
    await this.ctx.storage.put(key, { ...plan, status: "consumed" });
    return { approved: true, toolKey: input.toolKey, args: input.args, count, externalWrites: 0 };
  }

  private async reset(): Promise<void> {
    await this.clearMessages();
    this.modelCalls = 0;
  }

  private async pending() {
    return (await this.pendingApprovals()).map((item) => ({
      executionId: item.executionId,
      source: item.source,
      descriptor: item.descriptor as ApprovalDescriptor,
    }));
  }

  async park(marker: "GATE_S2_ACTION" | "GATE_S2_FAILURE") {
    await this.reset();
    if (marker === "GATE_S2_ACTION") await this.ctx.storage.put(EFFECT_COUNT, 0);
    else await this.ctx.storage.put(FAILURE_COUNT, 0);
    const result = await this.runTurn({ input: marker });
    return { status: result.status, pending: await this.pending(), modelCalls: this.modelCalls };
  }

  async resolve(executionId: string, decision: "approve" | "reject") {
    const result = decision === "approve"
      ? await this.approveExecution(executionId)
      : await this.rejectExecution(executionId, "S2 fixture rejection");
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      result,
      pending: await this.pending(),
      effectCount: Number(await this.ctx.storage.get<number>(EFFECT_COUNT) ?? 0),
      failureCount: Number(await this.ctx.storage.get<number>(FAILURE_COUNT) ?? 0),
      modelCalls: this.modelCalls,
      messages: JSON.stringify(await this.getMessages()).replace(/actpause_[a-zA-Z0-9-]+/g, "<execution>"),
    };
  }
}
