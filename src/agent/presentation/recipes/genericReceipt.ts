import type { CapsuleDraft, NormalizedToolResultV1, PresentationBlock } from "../types";

export const GENERIC_RECEIPT_RECIPE_VERSION = "execution.receipt@1";

export function compileGenericReceipt(result: NormalizedToolResultV1): CapsuleDraft {
  const providerLabel = providerName(result.providerId);
  const toolName = result.toolKey.split("/").at(-1) ?? result.toolKey;
  const blocks: PresentationBlock[] = [
    { type: "heading", text: `${statusIcon(result.status)} ${providerLabel} · ${toolName}`, level: 2 },
    { type: "notice", text: result.summary ?? statusText(result.status), tone: tone(result.status) },
  ];
  const facts = [
    { label: "状态", value: statusText(result.status) },
    { label: "结果数", value: String(result.items.length) },
    ...(result.elapsedMs === undefined ? [] : [{ label: "耗时", value: `${result.elapsedMs} ms` }]),
  ];
  blocks.push({ type: "fact_list", facts });
  if (result.items.length) blocks.push({ type: "details", summary: "查看执行详情", blocks: [{ type: "paragraph", text: result.items.slice(0, 5).map((item) => item.title).join("；") }] });
  if (result.warnings.length) blocks.push({ type: "notice", text: result.warnings.join("；"), tone: "warning" });
  if (result.sources.length) blocks.push({ type: "sources", sourceIds: result.sources.map((source) => source.id) });
  const fallbackText = `${statusIcon(result.status)} ${providerLabel} · ${toolName}\n${result.summary ?? statusText(result.status)}${result.elapsedMs === undefined ? "" : ` · ${result.elapsedMs} ms`}${result.attribution.length ? `\n来源：${result.attribution.map((item) => item.label).join("、")}` : ""}`;
  return {
    schema: "operia.presentation/v1",
    taskId: result.taskId,
    toolCallIds: [result.toolCallId],
    recipe: "execution.receipt",
    status: result.status,
    title: `${providerLabel} · ${toolName}`,
    ...(result.summary ? { summary: result.summary } : {}),
    blocks,
    actions: [],
    assets: result.assets,
    sources: result.sources,
    attribution: result.attribution,
    sensitivity: result.sensitivity,
    cachePolicy: result.cachePolicy,
    fallbackText: fallbackText.slice(0, 4_000),
    presentationRevision: GENERIC_RECEIPT_RECIPE_VERSION,
  };
}

function providerName(value: string): string { return value === "google-maps" ? "Google Maps" : /ncm|netease/i.test(value) ? "网易云音乐" : value; }
function statusIcon(status: NormalizedToolResultV1["status"]): string { return status === "success" ? "✓" : status === "partial" ? "△" : status === "empty" ? "○" : "✕"; }
function statusText(status: NormalizedToolResultV1["status"]): string { return status === "success" ? "已完成" : status === "partial" ? "部分完成" : status === "empty" ? "没有结果" : "执行失败"; }
function tone(status: NormalizedToolResultV1["status"]): "success" | "warning" | "error" | "info" { return status === "success" ? "success" : status === "partial" ? "warning" : status === "failed" ? "error" : "info"; }
