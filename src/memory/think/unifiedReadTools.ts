import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { JsonValue } from "../../agent/types";

export type OperiaUnifiedReadToolHost = {
  systemStatus(): Promise<unknown>;
  search(input: { query: string; limit: number }): Promise<unknown>;
  describe(input: { toolKey: string }): Promise<unknown>;
  execute(input: { toolKey: string; args: JsonValue }): Promise<unknown>;
  inspect?(input: { query: string; prefix: string; maxFiles: number; maxLines: number }): Promise<unknown>;
};

/**
 * The one read ToolSet shared by direct Think calls and the official
 * createExecuteRuntime() ToolSetConnector. Policy and execution remain owned
 * by Agent; this module owns only stable model-facing schemas and descriptions.
 */
export function createOperiaUnifiedReadTools(
  host: OperiaUnifiedReadToolHost,
  options: { includeCoreRead?: boolean; includeCodeWorkspace?: boolean } = {},
): ToolSet {
  const tools: ToolSet = options.includeCoreRead === false ? {} : {
    system_status: tool({
      description: "Read Operia's current Agent runtime/system status now. This is the pinned core tool for questions about current status, health of the tool runtime, active capabilities, or whether the system is working; call it directly without tool_search or tool_describe.",
      inputSchema: z.object({}),
      execute: async () => host.systemStatus(),
    }),
    tool_search: tool({
      description: "Search the real Agent read-only MCP/tool catalog. Use this before describing or executing a tool.",
      inputSchema: z.object({
        query: z.string().max(500).default(""),
        limit: z.number().int().min(1).max(8).default(5),
      }),
      execute: async ({ query, limit }) => host.search({ query, limit }),
    }),
    tool_describe: tool({
      description: "Load one tool's exact input schema, billing classification, confirmation requirement, and read-only policy after tool_search.",
      inputSchema: z.object({ toolKey: z.string().min(3).max(180) }),
      execute: async ({ toolKey }) => host.describe({ toolKey }),
    }),
    tool_execute: tool({
      description: "Execute one previously described read-only tool through Agent preflight and execution. Code Mode exposes only free reads; paid, unknown-cost, confirmation-gated, write, Browser, message, device, purchase, and delete calls fail closed.",
      inputSchema: z.object({
        toolKey: z.string().min(3).max(180),
        args: z.record(z.string(), z.unknown()).default({}),
      }),
      execute: async ({ toolKey, args }) => host.execute({
        toolKey,
        args: JSON.parse(JSON.stringify(args)) as JsonValue,
      }),
    }),
  };
  if (!options.includeCodeWorkspace) return tools;
  const codeWorkspace: ToolSet = {
    code_list: tool({
      description: "List files in the exact pinned Operia source snapshot. The result always includes commit SHA and tree hash. Read-only; no dirty workspace, secrets, arbitrary filesystem, or source mutation.",
      inputSchema: z.object({
        prefix: z.string().max(500).default(""),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      execute: async ({ prefix, limit }) => host.execute({ toolKey: "source-code/list", args: { prefix, limit } }),
    }),
    code_search: tool({
      description: "Search exact source lines in the pinned Operia code snapshot. Use this before code_read when locating a module, function, flag, tool, or call site.",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        prefix: z.string().max(500).default(""),
        limit: z.number().int().min(1).max(40).default(20),
      }),
      execute: async ({ query, prefix, limit }) => host.execute({ toolKey: "source-code/search", args: { query, prefix, limit } }),
    }),
    code_read: tool({
      description: "Read a bounded line range from one tracked file in the pinned Operia source snapshot. Returns exact line numbers, file hash, commit SHA, and tree hash.",
      inputSchema: z.object({
        path: z.string().min(1).max(500),
        start_line: z.number().int().min(1).default(1),
        end_line: z.number().int().min(1).optional(),
      }),
      execute: async ({ path, start_line, end_line }) => host.execute({
        toolKey: "source-code/read",
        args: { path, start_line, ...(end_line == null ? {} : { end_line }) },
      }),
    }),
    code_inspect: tool({
      description: "Preferred source tool: search and read the exact pinned Operia snapshot in one bounded trusted operation. If terminalPlan is true, the next model step must answer directly without another tool call.",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        prefix: z.string().max(500).default(""),
        max_files: z.number().int().min(1).max(8).default(4),
        max_lines: z.number().int().min(20).max(400).default(160),
      }),
      execute: async ({ query, prefix, max_files, max_lines }) => {
        if (!host.inspect) throw new Error("operia_code_inspect_unavailable");
        return host.inspect({ query, prefix, maxFiles: max_files, maxLines: max_lines });
      },
    }),
  };
  return { ...tools, ...codeWorkspace };
}
