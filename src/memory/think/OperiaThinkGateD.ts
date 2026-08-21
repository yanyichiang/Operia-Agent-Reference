import { Think, type TurnContext } from "@cloudflare/think";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { JsonValue } from "../../agent/types";
import { selectOperiaToolLoop, THINK_GATE_A_VERSIONS } from "./adapter";
import {
  executeThinkGateDDirectRead,
  type ThinkGateDAgentGatewayEnv,
  type ThinkGateDDirectResult,
} from "./agentGatewayClient";
import { createGateDSyntheticModel } from "./gateDSyntheticModel";

export type ThinkGateDEnv = Cloudflare.Env & ThinkGateDAgentGatewayEnv & {
  MEMORY_THINK_EXECUTION_ENABLED?: string;
  MEMORY_THINK_TOOL_LOOP_ENABLED?: string;
  THINK_GATE_D_CANARY_BEARER?: string;
};

type GateDScenario = "system" | "public" | "health" | "calendar";

const SCENARIO_MARKERS: Record<GateDScenario, string> = {
  system: "GATE_D_SYSTEM_STATUS",
  public: "GATE_D_PUBLIC_HTTPS",
  health: "GATE_D_HEALTH",
  calendar: "GATE_D_CALENDAR",
};

export function thinkGateDExecutionEnabled(env: ThinkGateDEnv): boolean {
  return env.MEMORY_THINK_EXECUTION_ENABLED?.trim().toLowerCase() === "true";
}

export function thinkGateDToolLoopEnabled(env: ThinkGateDEnv): boolean {
  return thinkGateDExecutionEnabled(env)
    && env.MEMORY_THINK_TOOL_LOOP_ENABLED?.trim().toLowerCase() === "true";
}

export class OperiaThinkGateD extends Think<ThinkGateDEnv> {
  override includeMcpTools = false;
  override workspaceBash = false;
  override fetchTools: false = false;
  override sendReasoning = false;
  override maxSteps = 4;
  override messageConcurrency = "queue" as const;
  override chatRecovery = {
    maxAttempts: 2,
    noProgressTimeoutMs: 60_000,
    terminalMessage: "Gate D staging read could not recover safely.",
  };

  private modelCalls = 0;
  private directCalls = 0;
  private lastAssembledToolNames: string[] = [];
  private lastDirectResult: ThinkGateDDirectResult | null = null;

  override getModel() {
    return createGateDSyntheticModel({
      onCall: () => {
        this.modelCalls += 1;
      },
    });
  }

  override getSystemPrompt(): string {
    return "Gate D staging fixture. Use only tool_execute and never request a write.";
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
      tool_execute: tool({
        description: "Execute one pinned read-only tool through the Agent gateway.",
        inputSchema: z.object({
          toolKey: z.enum([
            "operia-observer/system_status",
            "public-https/read_url",
            "health/health_summary",
            "calendar/calendar_list",
          ]),
          args: z.record(z.string(), z.unknown()),
        }),
        execute: async ({ toolKey, args }) => {
          if (!thinkGateDToolLoopEnabled(this.env)) throw new Error("think_gate_d_tool_loop_disabled");
          this.directCalls += 1;
          const result = await executeThinkGateDDirectRead({
            env: this.env,
            requestId: `gate-d-${toolKey.replace(/[^a-z0-9]/gi, "-").slice(0, 80)}`,
            toolKey,
            args: JSON.parse(JSON.stringify(args)) as JsonValue,
            memoryContextProjectionHash: await projectionHash(toolKey),
          });
          if (
            result.audit.route !== "direct_read"
            || result.externalWrites !== 0
            || result.approvalRequired
          ) {
            throw new Error("think_gate_d_read_contract_violated");
          }
          this.lastDirectResult = result;
          return result;
        },
      }),
    };
  }

  override authorizeTurn() {
    return {
      allowed: thinkGateDExecutionEnabled(this.env),
      grantedPermissions: thinkGateDToolLoopEnabled(this.env) ? ["gate-d:direct-read"] : [],
    };
  }

  override beforeTurn(ctx: TurnContext) {
    const available = new Set(Object.keys(ctx.tools));
    this.lastAssembledToolNames = thinkGateDToolLoopEnabled(this.env) && available.has("tool_execute")
      ? ["tool_execute"]
      : [];
    return {
      activeTools: thinkGateDToolLoopEnabled(this.env) ? ["tool_execute"] : [],
      maxRetries: 0,
    };
  }

  async gateDContract(): Promise<Record<string, unknown>> {
    return {
      versions: THINK_GATE_A_VERSIONS,
      executionEnabled: thinkGateDExecutionEnabled(this.env),
      toolLoopEnabled: thinkGateDToolLoopEnabled(this.env),
      executionDefaultEnabled: thinkGateDExecutionEnabled({} as ThinkGateDEnv),
      toolLoopDefaultEnabled: thinkGateDToolLoopEnabled({} as ThinkGateDEnv),
      routeWhenDisabled: selectOperiaToolLoop({ thinkEnabled: false, thinkCompatible: true }),
      includeMcpTools: this.includeMcpTools,
      workspaceBash: this.workspaceBash,
      fetchTools: this.fetchTools,
      messengerCount: Object.keys(this.getMessengers()).length,
      skillCount: (await this.getSkills()).length,
      skillScriptRunner: this.getSkillScriptRunner(),
      modelMode: "synthetic-no-provider",
    };
  }

  async runCanaryMatrix(): Promise<Record<string, unknown>> {
    if (!thinkGateDToolLoopEnabled(this.env)) {
      return {
        status: "legacy",
        route: selectOperiaToolLoop({ thinkEnabled: false, thinkCompatible: true }),
        modelCalls: 0,
        directCalls: 0,
        externalReads: 0,
        externalWrites: 0,
      };
    }
    const results = [];
    let totalExternalReads = 0;
    let totalExternalWrites = 0;
    try {
      for (const scenario of ["system", "public", "health", "calendar"] as const) {
        const result = await this.runScenario(scenario);
        results.push(result);
        totalExternalReads += result.externalReads;
        totalExternalWrites += result.externalWrites;
      }
    } finally {
      await this.clearMessages();
    }
    return {
      status: "completed",
      environment: "staging",
      results,
      modelCalls: results.reduce((sum, item) => sum + item.modelCalls, 0),
      directCalls: results.reduce((sum, item) => sum + item.directCalls, 0),
      externalReads: totalExternalReads,
      externalWrites: totalExternalWrites,
      messengerCount: 0,
      providerModelCalls: 0,
      approvalCount: 0,
      retainedMessageCount: (await this.getMessages()).length,
    };
  }

  private async runScenario(scenario: GateDScenario): Promise<{
    scenario: GateDScenario;
    status: string;
    continuation: boolean;
    modelCalls: number;
    directCalls: number;
    externalReads: number;
    externalWrites: number;
    route: string;
    toolKey: string;
    finalObserved: boolean;
    assembledToolNames: string[];
    transcriptMessageCount: number;
  }> {
    await this.clearMessages();
    const modelCallsBefore = this.modelCalls;
    const directCallsBefore = this.directCalls;
    this.lastAssembledToolNames = [];
    this.lastDirectResult = null;
    const turn = await this.runTurn({ input: SCENARIO_MARKERS[scenario] });
    const messages = await this.getMessages();
    const serialized = JSON.stringify(messages);
    const direct = this.lastDirectResult as ThinkGateDDirectResult | null;
    if (!direct) throw new Error("think_gate_d_direct_result_missing");
    return {
      scenario,
      status: turn.status,
      continuation: turn.continuation,
      modelCalls: this.modelCalls - modelCallsBefore,
      directCalls: this.directCalls - directCallsBefore,
      externalReads: direct.externalReads,
      externalWrites: direct.externalWrites,
      route: direct.audit.route,
      toolKey: direct.audit.toolKey,
      finalObserved: serialized.includes("GATE_D_DIRECT_COMPLETE"),
      assembledToolNames: [...this.lastAssembledToolNames],
      transcriptMessageCount: messages.length,
    };
  }
}

async function projectionHash(toolKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(`gate-d-staging\u0000${toolKey}\u0000bounded-projection-v1`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
