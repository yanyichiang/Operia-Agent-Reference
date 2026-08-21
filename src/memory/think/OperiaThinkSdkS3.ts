import { Think, type TurnContext } from "@cloudflare/think";
import { createExecuteRuntime } from "@cloudflare/think/tools/execute";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createGateASyntheticModel } from "./syntheticModel";
import { validateSandboxCodeModePlan } from "../../agent/sandboxCodeMode";

type GateS3Env = Cloudflare.Env & { LOADER: WorkerLoader; THINK_SDK_S3_ENABLED?: string };
const EFFECT_COUNT = "s3:effect-count";

export class OperiaThinkSdkS3 extends Think<GateS3Env> {
  override includeMcpTools = false;
  override workspaceBash = false;
  override fetchTools: false = false;
  override sendReasoning = false;
  override maxSteps = 6;
  private modelCalls = 0;

  override getModel() { return createGateASyntheticModel({ onCall: () => { this.modelCalls += 1; } }); }
  override getSystemPrompt() { return "S3 official Code Mode approval fixture. No external systems."; }
  override getMessengers() { return {}; }
  override getSkills() { return []; }
  override getSkillScriptRunner() { return null; }
  override authorizeTurn() { return { allowed: true, grantedPermissions: ["operia:read-tools"] }; }
  override beforeTurn(_ctx: TurnContext) { return { activeTools: ["execute_codemode"], maxRetries: 0 }; }

  override getTools(): ToolSet {
    const sdk = createExecuteRuntime({
      ctx: this.ctx,
      loader: this.env.LOADER,
      globalOutbound: null,
      name: "operia-sdk-s3-fixture",
      tools: {
        tool_action: tool({
          description: "Synthetic metered read requiring approval.",
          inputSchema: z.object({ operationKey: z.string(), toolKey: z.string(), args: z.record(z.string(), z.unknown()) }),
          needsApproval: true,
          execute: async ({ operationKey, toolKey, args }) => {
            const count = Number(await this.ctx.storage.get<number>(EFFECT_COUNT) ?? 0) + 1;
            await this.ctx.storage.put(EFFECT_COUNT, count);
            return { approved: true, operationKey, toolKey, args, count, externalWrites: 0 };
          },
        }),
      },
    });
    this.codemode = sdk.runtime;
    const execute = sdk.tool.execute;
    if (!execute) throw new Error("s3_execute_missing");
    return {
      execute_codemode: {
        ...sdk.tool,
        execute: (input, options) => {
          const record = input && typeof input === "object" && !Array.isArray(input) ? input as { code?: unknown } : {};
          return execute({ code: validateSandboxCodeModePlan(record.code, ["tools"]) }, options);
        },
      },
    };
  }

  override describePausedExecution(pending: import("@cloudflare/codemode").PendingAction[]) {
    const first = pending[0];
    return first?.connector === "tools" && first.method === "tool_action" ? {
      action: "tools.tool_action",
      summary: "Approve the S3 metered read",
      risk: "medium" as const,
      permissions: ["operia:read-tools"],
    } : undefined;
  }

  async park() {
    await this.clearMessages();
    await this.ctx.storage.put(EFFECT_COUNT, 0);
    this.modelCalls = 0;
    const result = await this.runTurn({ input: "GATE_S3_CODEMODE" });
    return { status: result.status, pending: await this.pendingApprovals(), effectCount: 0, modelCalls: this.modelCalls };
  }

  async resolve(executionId: string, decision: "approve" | "reject") {
    const result = decision === "approve" ? await this.approveExecution(executionId) : await this.rejectExecution(executionId, "S3 rejection");
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      result,
      pending: await this.pendingApprovals(),
      effectCount: Number(await this.ctx.storage.get<number>(EFFECT_COUNT) ?? 0),
      modelCalls: this.modelCalls,
      messages: JSON.stringify(await this.getMessages()).replace(/cm_[a-zA-Z0-9-]+/g, "<execution>"),
    };
  }
}
