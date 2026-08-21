import type { CapsuleDraft, NormalizedItem, NormalizedToolResultV1, PresentationBlock } from "../types";

export const CALENDAR_AGENDA_RECIPE_VERSION = "calendar.agenda@2";

export function compileCalendarAgenda(result: NormalizedToolResultV1): CapsuleDraft {
  const blocks: PresentationBlock[] = [
    { type:"heading",text:`📅 ${result.title ?? "日程"}`,level:1 },
  ];
  if (result.summary) blocks.push(result.status === "success" || result.status === "empty"
    ? { type:"paragraph",text:result.summary }
    : { type:"notice",text:result.summary,tone:"warning" });
  if (result.items.length) blocks.push({
    type:"table",
    columns:["时间","日程","状态"],
    rows:result.items.slice(0,5).map((item) => [calendarTime(item),item.title.slice(0,120),calendarStatus(item)]),
    caption:`接下来 ${Math.min(result.items.length,5)} 项`,
  });
  const calendars = [...new Set(result.items.map((item) => item.facts.calendar).filter((value): value is string => typeof value === "string"))];
  if (calendars.length) blocks.push({ type:"paragraph",text:`日历：${calendars.join("、")}` });
  if (result.warnings.length) blocks.push({ type:"notice",text:result.warnings.join("；"),tone:"warning" });
  if (result.sources.length) blocks.push({ type:"sources",sourceIds:result.sources.map((source) => source.id) });
  return {
    schema:"operia.presentation/v1",
    taskId:result.taskId,
    toolCallIds:[result.toolCallId],
    recipe:"calendar.agenda",
    status:result.status,
    title:result.title ?? "日程",
    ...(result.summary ? { summary:result.summary } : {}),
    blocks,
    actions:[{ id:"calendar-open",label:"打开完整日历",kind:"open_mini_app",style:"primary",miniAppTarget:"calendar",requiresApproval:false }],
    assets:result.assets,
    sources:result.sources,
    attribution:result.attribution,
    sensitivity:result.sensitivity,
    cachePolicy:result.cachePolicy,
    fallbackText:calendarFallback(result),
    presentationRevision:CALENDAR_AGENDA_RECIPE_VERSION,
  };
}

function calendarTime(item: NormalizedItem): string {
  if (item.facts.allDay === true) return dayLabel(item.facts.start) || "全天";
  const start = zonedLabel(item.facts.start,item.facts.timezone);
  const end = zonedLabel(item.facts.end,item.facts.timezone,true);
  return start && end ? `${start}–${end}` : start || end || "时间待定";
}

function zonedLabel(value: unknown,timezone: unknown,timeOnly=false): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN",{
      ...(timeOnly ? {} : { month:"numeric",day:"numeric" }),
      hour:"2-digit",minute:"2-digit",hour12:false,
      ...(typeof timezone === "string" && timezone ? { timeZone:timezone } : {}),
    }).format(new Date(value)).replace(/\s+/g," ");
  } catch { return value.slice(0,16).replace("T"," "); }
}

function dayLabel(value: unknown): string {
  return typeof value === "string" && value.length >= 10 ? `${value.slice(5,10).replace("-","/")} 全天` : "";
}

function calendarStatus(item: NormalizedItem): string {
  const status = String(item.facts.status ?? "confirmed");
  const response = String(item.facts.responseStatus ?? "");
  const labels: Record<string,string> = { confirmed:"已确认",tentative:"待定",cancelled:"已取消",accepted:"已接受",declined:"已拒绝",needsAction:"待回复" };
  return [labels[status] ?? status, response ? labels[response] ?? response : ""].filter(Boolean).join(" · ").slice(0,80);
}

function calendarFallback(result: NormalizedToolResultV1): string {
  const lines = [`📅 ${result.title ?? "日程"}`];
  if (result.summary) lines.push(result.summary);
  result.items.slice(0,10).forEach((item,index) => lines.push(`${index+1}. ${calendarTime(item)}　${item.title}　${calendarStatus(item)}`));
  if (result.attribution.length) lines.push(`来源：${result.attribution.map((item) => item.label).join("、")}`);
  return lines.join("\n").slice(0,4_000);
}
