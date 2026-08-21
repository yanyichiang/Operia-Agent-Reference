import type { CapsuleDraft, NormalizedToolResultV1, PresentationBlock } from "../types";

export const NCM_RECIPE_VERSION = "music.result@2";

export function compileNcm(result: NormalizedToolResultV1): CapsuleDraft {
  const isLyric = result.toolKey.toLowerCase().includes("lyric");
  const isPlaylist = result.toolKey.toLowerCase().includes("playlist");
  const recipe = isLyric ? "music.lyric" : isPlaylist ? "music.playlist" : "music.search";
  const blocks: PresentationBlock[] = [{ type: "heading", text: result.title ?? "网易云音乐", level: 1 }];
  if (result.summary) blocks.push({ type: "paragraph", text: result.summary });
  const hero = result.assets.find((asset) => asset.kind === "image");
  if (hero) blocks.push({ type: "media", assetId: hero.id, caption: result.title });
  if (isLyric && result.items[0]?.facts.excerpt) {
    const excerpt = String(result.items[0].facts.excerpt).slice(0, 160);
    blocks.push({ type: "paragraph", text: excerpt });
  } else if (result.items.length) {
    blocks.push({
      type: "table",
      columns: ["名称", "歌手", "专辑"],
      rows: result.items.slice(0, 10).map((item) => [item.title, String(item.facts.artist ?? item.subtitle ?? "—"), String(item.facts.album ?? "—")]),
    });
  }
  if (result.warnings.length) blocks.push({ type: "notice", text: result.warnings.join("；"), tone: "warning" });
  if (result.sources.length) blocks.push({ type: "sources", sourceIds: result.sources.map((source) => source.id) });
  return {
    schema: "operia.presentation/v1",
    taskId: result.taskId,
    toolCallIds: [result.toolCallId],
    recipe,
    status: result.status,
    title: result.title ?? "网易云音乐",
    ...(result.summary ? { summary: result.summary } : {}),
    blocks,
    actions: officialActions(result),
    assets: result.assets,
    sources: result.sources,
    attribution: result.attribution,
    sensitivity: result.sensitivity,
    cachePolicy: result.cachePolicy,
    fallbackText: ncmFallback(result),
    presentationRevision: `${recipe}@2`,
  };
}

function ncmFallback(result: NormalizedToolResultV1): string {
  const lines = [result.title ?? "网易云音乐", result.summary ?? (result.status === "empty" ? "没有找到结果" : "查询完成")];
  const lyric = result.toolKey.toLowerCase().includes("lyric") ? result.items[0]?.facts.excerpt : undefined;
  if (lyric) {
    lines.push(String(lyric).slice(0, 160));
  } else {
    for (const [index, item] of result.items.slice(0, 10).entries()) {
      const artist = item.facts.artist ?? item.subtitle;
      lines.push(`${index + 1}. ${item.title}${artist ? ` · ${artist}` : ""}`);
    }
  }
  if (result.attribution.length) lines.push(`来源：${result.attribution.map((item) => item.label).join("、")}`);
  return lines.join("\n").slice(0, 4_000);
}

function officialActions(result: NormalizedToolResultV1): CapsuleDraft["actions"] {
  const seen = new Set<string>();
  return result.items.slice(0,3).flatMap((item,index) => {
    const url = item.links.find((link) => link.rel === "canonical")?.url;
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ id:`ncm-open-${index+1}`,label:result.items.length === 1 ? "在网易云音乐打开" : `打开 ${item.title.slice(0,24)}`,kind:"open_url" as const,style:index === 0 ? "primary" as const : "secondary" as const,urlRef:url,requiresApproval:false as const }];
  });
}
