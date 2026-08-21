import type { CapsuleDraft, NormalizedToolResultV1, PresentationBlock } from "../types";

export const HEALTH_SUMMARY_RECIPE_VERSION = "health.summary@1";

export function compileHealthSummary(result: NormalizedToolResultV1): CapsuleDraft {
  const blocks: PresentationBlock[] = [{ type:"heading",text:`♥ ${result.title ?? "健康摘要"}`,level:1 }];
  if (result.summary) blocks.push(result.status === "success"
    ? { type:"paragraph",text:result.summary }
    : { type:"notice",text:result.summary,tone:"warning" });
  for (const item of result.items.slice(0,4)) {
    const value = formatHealthValue(Number(item.facts.value),String(item.facts.unit ?? ""));
    const change = typeof item.facts.changePercent === "number" ? `${item.facts.changePercent > 0 ? "+" : ""}${item.facts.changePercent.toFixed(1)}%` : undefined;
    blocks.push({ type:"metric",label:item.title,value,...(change ? { note:`较前期 ${change}` } : {}) });
  }
  blocks.push({ type:"notice",text:"健康数据仅供个人信息参考，不构成医疗诊断或治疗建议。",tone:"info" });
  if (result.warnings.length) blocks.push({ type:"notice",text:result.warnings.join("；"),tone:"warning" });
  if (result.sources.length) blocks.push({ type:"sources",sourceIds:result.sources.map((source) => source.id) });
  return {
    schema:"operia.presentation/v1",taskId:result.taskId,toolCallIds:[result.toolCallId],recipe:"health.summary",
    status:result.status,title:result.title ?? "健康摘要",...(result.summary ? { summary:result.summary } : {}),blocks,
    actions:[
      { id:"health-7d",label:"查看 7 天",kind:"open_mini_app",style:"primary",miniAppTarget:"health_7d",requiresApproval:false },
      { id:"health-30d",label:"查看 30 天",kind:"open_mini_app",style:"secondary",miniAppTarget:"health_30d",requiresApproval:false },
    ],
    assets:result.assets,sources:result.sources,attribution:result.attribution,sensitivity:result.sensitivity,
    cachePolicy:result.cachePolicy,fallbackText:healthFallback(result),presentationRevision:HEALTH_SUMMARY_RECIPE_VERSION,
  };
}

function formatHealthValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "—";
  if (unit === "min" && value >= 60) return `${Math.floor(value/60)} 小时 ${Math.round(value%60)} 分`;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}${unit ? ` ${unit}` : ""}`;
}

function healthFallback(result: NormalizedToolResultV1): string {
  const lines = [`♥ ${result.title ?? "健康摘要"}`];
  if (result.summary) lines.push(result.summary);
  for (const item of result.items.slice(0,4)) lines.push(`${item.title}：${formatHealthValue(Number(item.facts.value),String(item.facts.unit ?? ""))}`);
  lines.push("健康数据仅供个人信息参考，不构成医疗诊断或治疗建议。");
  return lines.join("\n").slice(0,4_000);
}
