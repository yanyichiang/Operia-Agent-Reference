import type {
  CapsuleDraft,
  NormalizedItem,
  NormalizedToolResultV1,
  PresentationAction,
  PresentationBlock,
} from "../types";

export const GENERIC_RESULT_RECIPE_VERSION = "generic.result@1";

export function compileGenericResult(result: NormalizedToolResultV1): CapsuleDraft {
  const providerLabel = humanLabel(result.providerId);
  const toolLabel = humanLabel(result.toolKey.split("/").at(-1) ?? result.toolKey);
  const title = result.title ?? `${providerLabel} · ${toolLabel}`;
  const blocks: PresentationBlock[] = [
    { type: "heading", text: `${statusIcon(result.status)} ${title}`, level: 2 },
  ];
  if (result.summary) blocks.push({
    type: result.status === "success" ? "paragraph" : "notice",
    text: result.summary,
    ...(result.status === "success" ? {} : { tone: tone(result.status) }),
  } as PresentationBlock);

  appendItems(blocks,result.items);
  appendImages(blocks,result);
  if (result.warnings.length) blocks.push({ type:"notice",text:result.warnings.join("；"),tone:"warning" });
  if (result.sources.length) blocks.push({ type:"sources",sourceIds:result.sources.map((source) => source.id) });
  if (blocks.length === 1) blocks.push({ type:"notice",text:statusText(result.status),tone:tone(result.status) });

  return {
    schema: "operia.presentation/v1",
    taskId: result.taskId,
    toolCallIds: [result.toolCallId],
    recipe: "generic.result",
    status: result.status,
    title,
    ...(result.summary ? { summary: result.summary } : {}),
    blocks,
    actions: genericActions(result),
    assets: result.assets,
    sources: result.sources,
    attribution: result.attribution,
    sensitivity: result.sensitivity,
    cachePolicy: result.cachePolicy,
    fallbackText: genericFallback(result,title),
    presentationRevision: GENERIC_RESULT_RECIPE_VERSION,
  };
}

function appendItems(blocks: PresentationBlock[],items: NormalizedItem[]): void {
  if (!items.length) return;
  const commonFactKeys = commonFacts(items).slice(0,3);
  if (items.length > 1) {
    const columns = ["项目",...commonFactKeys.map(humanLabel)];
    const rows = items.slice(0,10).map((item) => [
      item.title.slice(0,120),
      ...commonFactKeys.map((key) => displayValue(item.facts[key],80)),
    ]);
    blocks.push({ type:"table",columns,rows,caption:`${Math.min(items.length,10)} 项结果` });
    const described = items.filter((item) => item.subtitle).slice(0,5);
    if (described.length) blocks.push({
      type:"details",summary:"查看说明",blocks:described.map((item) => ({
        type:"paragraph" as const,text:`${item.title}：${item.subtitle}`.slice(0,240),
      })),
    });
  } else {
    const item = items[0];
    if (item.title) blocks.push({ type:"heading",text:item.title,level:3 });
    if (item.subtitle) blocks.push({ type:"paragraph",text:item.subtitle });
    const facts = Object.entries(item.facts).slice(0,16).map(([label,value]) => ({
      label:humanLabel(label),value:displayValue(value),
    }));
    if (facts.length) blocks.push({ type:"fact_list",facts });
  }
  const located = items.find((item) => item.location);
  if (located?.location) blocks.push({
    type:"map",latitude:located.location.latitude,longitude:located.location.longitude,
    zoom:items.filter((item) => item.location).length > 1 ? 14 : 16,label:located.title,
  });
}

function appendImages(blocks: PresentationBlock[],result: NormalizedToolResultV1): void {
  const images = result.assets.filter((asset) => asset.kind === "image").slice(0,4);
  if (images.length === 1) blocks.push({ type:"media",assetId:images[0].id,caption:result.title });
  if (images.length > 1) blocks.push({ type:"gallery",assetIds:images.map((asset) => asset.id),caption:result.title });
}

function genericActions(result: NormalizedToolResultV1): PresentationAction[] {
  const url = result.items.flatMap((item) => item.links).find((link) => link.rel === "canonical")?.url
    ?? result.sources.find((source) => source.url)?.url;
  return url ? [{
    id:"open-result",label:"打开结果",kind:"open_url",style:"primary",urlRef:url,requiresApproval:false,
  }] : [];
}

function commonFacts(items: NormalizedItem[]): string[] {
  const counts = new Map<string,number>();
  for (const item of items) for (const key of Object.keys(item.facts)) counts.set(key,(counts.get(key) ?? 0)+1);
  return [...counts.entries()]
    .filter(([,count]) => count >= Math.ceil(items.length/2))
    .sort((left,right) => right[1]-left[1] || left[0].localeCompare(right[0]))
    .map(([key]) => key);
}

function genericFallback(result: NormalizedToolResultV1,title: string): string {
  const lines = [`${statusIcon(result.status)} ${title}`];
  if (result.summary) lines.push(result.summary);
  for (const [index,item] of result.items.slice(0,10).entries()) {
    const facts = Object.entries(item.facts).slice(0,2)
      .map(([key,value]) => `${humanLabel(key)} ${displayValue(value)}`).join(" · ");
    lines.push(`${index+1}. ${item.title}${item.subtitle ? ` · ${item.subtitle}` : ""}${facts ? ` · ${facts}` : ""}`);
  }
  if (!result.summary && !result.items.length) lines.push(statusText(result.status));
  if (result.elapsedMs !== undefined) lines.push(`耗时：${result.elapsedMs} ms`);
  if (result.attribution.length) lines.push(`来源：${result.attribution.map((item) => item.label).join("、")}`);
  return lines.join("\n").slice(0,4_000);
}

function humanLabel(value: string): string {
  const aliases: Record<string,string> = {
    status:"状态",count:"数量",total:"总数",type:"类型",name:"名称",title:"标题",date:"日期",
    createdAt:"创建时间",updatedAt:"更新时间",start:"开始",end:"结束",duration:"时长",size:"大小",
    rating:"评分",url:"链接",description:"说明",
  };
  if (aliases[value]) return aliases[value];
  return value.replace(/[_-]+/g," ").replace(/([a-z0-9])([A-Z])/g,"$1 $2").trim() || "结果";
}

function displayValue(value: string | number | boolean | undefined,max=256): string {
  if (value === undefined) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value).slice(0,max);
}

function statusIcon(status: NormalizedToolResultV1["status"]): string { return status === "success" ? "✓" : status === "partial" ? "△" : status === "empty" ? "○" : "✕"; }
function statusText(status: NormalizedToolResultV1["status"]): string { return status === "success" ? "已完成" : status === "partial" ? "部分完成" : status === "empty" ? "没有结果" : "执行失败"; }
function tone(status: NormalizedToolResultV1["status"]): "success" | "warning" | "error" | "info" { return status === "success" ? "success" : status === "partial" ? "warning" : status === "failed" ? "error" : "info"; }
