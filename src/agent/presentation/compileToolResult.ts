import { sha256Hex } from "../toolCatalog";
import { compileResultCapsule } from "./compile";
import { normalizeMcpToolResult, type RecordedCallToolResult } from "./normalize";
import type { ResultCapsuleV1 } from "./types";

export type CapturedMcpToolResult = {
  toolKey: string;
  taskId: string;
  toolCallId: string;
  capturedAt: string;
  result: unknown;
};

export async function compileCapturedMcpToolResult(input: CapturedMcpToolResult): Promise<ResultCapsuleV1> {
  try {
    const decoded = decodeToolResult(input.result);
    const normalized = await normalizeMcpToolResult({
      toolKey:input.toolKey,
      providerId:input.toolKey.split("/",1)[0] || "unknown",
      taskId:input.taskId,
      toolCallId:input.toolCallId,
      result:decoded,
      normalizedAt:input.capturedAt,
    });
    return compileResultCapsule(normalized);
  } catch (error) {
    console.warn("operia_result_capsule_safe_receipt", { code:boundedError(error),toolKey:input.toolKey.slice(0,180) });
    return compileSafeReceipt(input);
  }
}

function decodeToolResult(value: unknown): RecordedCallToolResult {
  let decoded = unwrapResult(value);
  if (typeof decoded === "string") {
    try { decoded = JSON.parse(decoded); } catch { /* Plain text remains text. */ }
  }
  const record = asRecord(decoded);
  if (record && Array.isArray(record.content)) return record as RecordedCallToolResult;
  return {
    content:[{ type:"text",text:typeof decoded === "string" ? decoded : JSON.stringify(decoded ?? {}) }],
    ...(record ? { structuredContent:record } : {}),
  };
}

function unwrapResult(value: unknown): unknown {
  let current = value;
  for (let depth=0; depth<3; depth+=1) {
    const record = asRecord(current);
    if (!record) break;
    if (typeof record.payload === "string") { current = record.payload; continue; }
    if (record.result !== undefined) { current = record.result; continue; }
    break;
  }
  return current;
}

async function compileSafeReceipt(input: CapturedMcpToolResult): Promise<ResultCapsuleV1> {
  const normalized = await normalizeMcpToolResult({
    toolKey:input.toolKey,
    providerId:input.toolKey.split("/",1)[0] || "unknown",
    taskId:input.taskId,
    toolCallId:input.toolCallId,
    result:{ content:[{ type:"text",text:JSON.stringify({
      title:"工具结果",
      summary:"工具调用已完成，但返回内容没有通过安全展示检查。",
    }) }] },
    normalizedAt:input.capturedAt,
  });
  normalized.status = "partial";
  normalized.warnings.push("unsafe_result_hidden");
  // Make the safe receipt identity independent of rejected raw content while
  // remaining stable for the exact tool call.
  normalized.rawResultHash = await sha256Hex(`safe-receipt\0${input.taskId}\0${input.toolCallId}\0${input.toolKey}`);
  return compileResultCapsule(normalized);
}

function asRecord(value: unknown): Record<string,unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : null;
}
function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g," ").slice(0,160);
}
