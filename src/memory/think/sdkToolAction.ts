import { action, type ActionContext } from "@cloudflare/think";
import { z } from "zod";
import type { JsonValue } from "../../agent/types";

export type OperiaSdkToolActionInput = {
  operationKey: string;
  toolKey: string;
  args: JsonValue;
};

export type OperiaSdkToolActionHost = {
  preflight(input: OperiaSdkToolActionInput, ctx: ActionContext): Promise<void>;
  execute(input: OperiaSdkToolActionInput, ctx: ActionContext): Promise<unknown>;
  idempotencyKey(input: OperiaSdkToolActionInput, ctx: ActionContext): Promise<string> | string;
};

const OPERIA_TOOL_ACTION_TIMEOUT_MS = 90_000;

/**
 * Thin bridge from Think's official durable Action ledger to the Agent-owned
 * policy/grant boundary. The host preflights before Think parks; after Owner
 * approval, execute consumes that exact grant. This module owns no approval
 * table, retry loop, or continuation state.
 */
export function createOperiaSdkToolAction(host: OperiaSdkToolActionHost) {
  return action({
    name: "tool_action",
    description: "Execute one read-only Operia tool that Agent classified as paid, unknown-cost, or confirmation-gated. Search and describe first. This action always pauses for exact Owner approval; it cannot call Browser, send messages, control devices, purchase, delete, or write data.",
    inputSchema: z.object({
      operationKey: z.string().min(8).max(180),
      toolKey: z.string().min(3).max(180),
      args: z.record(z.string(), z.unknown()).default({}),
    }),
    kind: "durable-pause",
    approval: async ({ input, ctx }) => {
      await host.preflight({
        ...input,
        args: JSON.parse(JSON.stringify(input.args)) as JsonValue,
      }, ctx);
      return true;
    },
    approvalSummary: "Operia 请求执行一项需要确认的只读工具",
    approvalRisk: "medium",
    permissions: ["operia:read-tools"],
    // Think Actions default to 30 seconds. The Agent's pinned catalog/policy
    // preflight and durable receipt projection can outlive that even when the
    // remote MCP call itself is sub-second, so use one explicit bounded window.
    timeoutMs: OPERIA_TOOL_ACTION_TIMEOUT_MS,
    idempotencyKey: ({ input, ctx }) => host.idempotencyKey({
      ...input,
      args: JSON.parse(JSON.stringify(input.args)) as JsonValue,
    }, ctx),
    execute: async (input, ctx) => host.execute({
      ...input,
      args: JSON.parse(JSON.stringify(input.args)) as JsonValue,
    }, ctx),
  });
}
