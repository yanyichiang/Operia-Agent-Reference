import type { CapsuleDraft, NormalizedItem, NormalizedToolResultV1, PresentationAction, PresentationBlock } from "../types";

export const GOOGLE_MAPS_RECIPE_VERSION = "google.result@2";

export function compileGoogleMaps(result: NormalizedToolResultV1): CapsuleDraft {
  const toolKey = result.toolKey.toLowerCase();
  if (toolKey.includes("place_details")) return compilePlaceDetails(result);
  if (toolKey.includes("directions") || toolKey.includes("distance_matrix")) return compileRouteSummary(result);
  return compilePlaceSearch(result);
}

function compilePlaceSearch(result: NormalizedToolResultV1): CapsuleDraft {
  const blocks = baseBlocks(result, "周边地点");
  appendMap(blocks, result);
  if (result.items.length) blocks.push(placeTable(result.items.slice(0, 5), "周边结果"));
  const remaining = result.items.slice(5);
  if (remaining.length) blocks.push({ type: "details", summary: `其余 ${remaining.length} 个地点`, blocks: [placeTable(remaining)] });
  appendTail(blocks, result);
  return capsuleDraft(result, {
    recipe: "place.search",
    title: result.title ?? "周边地点",
    blocks,
    actions: mapActions(result),
    fallbackText: placeFallback(result),
    presentationRevision: "place.search@2",
  });
}

function compilePlaceDetails(result: NormalizedToolResultV1): CapsuleDraft {
  const blocks = baseBlocks(result, "地点详情");
  appendMap(blocks, result);
  const item = result.items[0];
  if (item) {
    const labels: Record<string, string> = {
      rating: "评分",
      userRatingCount: "评价数",
      businessStatus: "营业状态",
      phone: "电话",
      openingHours: "营业时间",
    };
    const facts = [
      ...(item.subtitle ? [{ label: "地址", value: item.subtitle }] : []),
      ...Object.entries(item.facts).map(([key, value]) => ({ label: labels[key] ?? key, value: String(value) })),
    ];
    if (facts.length) blocks.push({ type: "fact_list", facts: facts.slice(0, 16) });
  }
  appendTail(blocks, result);
  return capsuleDraft(result, {
    recipe: "place.details",
    title: result.title ?? "地点详情",
    blocks,
    actions: mapActions(result),
    fallbackText: placeFallback(result),
    presentationRevision: "place.details@1",
  });
}

function compileRouteSummary(result: NormalizedToolResultV1): CapsuleDraft {
  const blocks = baseBlocks(result, "路线概览");
  if (result.items.length) {
    blocks.push({
      type: "table",
      columns: ["路线", "距离", "时间", "状态"],
      rows: result.items.slice(0, 10).map((item) => [
        item.subtitle ?? item.title,
        String(item.facts.distance ?? "—"),
        String(item.facts.duration ?? "—"),
        String(item.facts.status ?? "—"),
      ]),
      caption: result.toolKey.toLowerCase().includes("distance_matrix") ? "距离矩阵" : "路线分段",
    });
  }
  appendTail(blocks, result);
  return capsuleDraft(result, {
    recipe: "route.summary",
    title: result.title ?? "路线概览",
    blocks,
    actions: [],
    fallbackText: routeFallback(result),
    presentationRevision: "route.summary@1",
  });
}

function baseBlocks(result: NormalizedToolResultV1, fallbackTitle: string): PresentationBlock[] {
  const blocks: PresentationBlock[] = [{ type: "heading", text: result.title ?? fallbackTitle, level: 1 }];
  if (result.summary) blocks.push({ type: "paragraph", text: result.summary });
  return blocks;
}

function appendMap(blocks: PresentationBlock[], result: NormalizedToolResultV1): void {
  const located = result.items.find((item) => item.location);
  if (!located?.location) return;
  blocks.push({
    type: "map",
    latitude: located.location.latitude,
    longitude: located.location.longitude,
    zoom: result.items.filter((item) => item.location).length > 1 ? 14 : 16,
    label: located.title,
  });
}

function appendTail(blocks: PresentationBlock[], result: NormalizedToolResultV1): void {
  if (result.warnings.length) blocks.push({ type: "notice", text: result.warnings.join("；"), tone: "warning" });
  if (result.sources.length) blocks.push({ type: "sources", sourceIds: result.sources.map((source) => source.id) });
}

function mapActions(result: NormalizedToolResultV1): PresentationAction[] {
  const canonical = result.items.flatMap((item) => item.links).find((link) => link.rel === "canonical")?.url;
  return canonical
    ? [{ id: "open-map", label: "在 Google Maps 打开", kind: "open_url", style: "primary", urlRef: canonical, requiresApproval: false }]
    : [];
}

function capsuleDraft(
  result: NormalizedToolResultV1,
  view: Pick<CapsuleDraft, "recipe" | "title" | "blocks" | "actions" | "fallbackText" | "presentationRevision">,
): CapsuleDraft {
  return {
    schema: "operia.presentation/v1",
    taskId: result.taskId,
    toolCallIds: [result.toolCallId],
    status: result.status,
    ...(result.summary ? { summary: result.summary } : {}),
    assets: result.assets,
    sources: result.sources,
    attribution: result.attribution,
    sensitivity: result.sensitivity,
    cachePolicy: result.cachePolicy,
    ...view,
  };
}

function placeTable(items: NormalizedItem[], caption?: string) {
  return {
    type: "table" as const,
    columns: ["地点", "评分", "地址"],
    rows: items.slice(0, 5).map((item) => [item.title, item.facts.rating === undefined ? "—" : String(item.facts.rating), item.subtitle ?? "—"]),
    ...(caption ? { caption } : {}),
  };
}

function placeFallback(result: NormalizedToolResultV1): string {
  const lines = [result.title ?? "地点", result.summary ?? statusText(result.status)];
  for (const [index, item] of result.items.slice(0, 10).entries()) {
    const rating = item.facts.rating === undefined ? "" : ` · 评分 ${item.facts.rating}`;
    lines.push(`${index + 1}. ${item.title}${rating}${item.subtitle ? ` · ${item.subtitle}` : ""}`);
  }
  return withAttribution(lines, result);
}

function routeFallback(result: NormalizedToolResultV1): string {
  const lines = [result.title ?? "路线概览", result.summary ?? statusText(result.status)];
  for (const [index, item] of result.items.slice(0, 10).entries()) {
    const facts = [item.facts.distance, item.facts.duration, item.facts.status].filter((value) => value !== undefined).join(" · ");
    lines.push(`${index + 1}. ${item.subtitle ?? item.title}${facts ? ` · ${facts}` : ""}`);
  }
  return withAttribution(lines, result);
}

function withAttribution(lines: string[], result: NormalizedToolResultV1): string {
  if (result.attribution.length) lines.push(`来源：${result.attribution.map((item) => item.label).join("、")}`);
  return lines.join("\n").slice(0, 4_000);
}

function statusText(status: NormalizedToolResultV1["status"]): string {
  return status === "empty" ? "没有找到结果" : status === "failed" ? "查询失败" : status === "partial" ? "结果不完整" : "查询完成";
}
