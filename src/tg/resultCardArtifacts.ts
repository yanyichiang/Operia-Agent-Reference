import type { ResultCapsuleV1 } from "../agent/presentation/types";
import type { Env } from "../types";
import type { TelegramRenderOptions } from "./richResultRenderer";

export async function prepareResultCardOptions(env: Env,capsule: ResultCapsuleV1): Promise<TelegramRenderOptions> {
  const miniAppBaseUrl = env.TG_MINIAPP_ENABLED?.trim().toLowerCase() === "true" ? env.TG_MINIAPP_URL?.trim() : undefined;
  if (!capsule.recipe.startsWith("music.") || capsule.recipe === "music.lyric") return { ...(miniAppBaseUrl ? { miniAppBaseUrl } : {}) };
  const cover = capsule.assets.find((asset) => asset.kind === "image" && asset.source === "provider_url" && safeNcmCover(asset.url));
  if (!cover?.url || !env.AGENT_SERVICE || !env.AGENT_CONTEXT_SERVICE_BEARER?.trim()) return { ...(miniAppBaseUrl ? { miniAppBaseUrl } : {}) };
  const table = capsule.blocks.find((block) => block.type === "table");
  const variant = table?.type === "table" && table.rows.length === 1 && capsule.recipe === "music.search" ? "p1" : "p2";
  try {
    const response = await env.AGENT_SERVICE.fetch("https://<AGENT_SERVICE>.internal/service/presentation/music-poster",{
      method:"POST",headers:{ "content-type":"application/json",authorization:`Bearer ${env.AGENT_CONTEXT_SERVICE_BEARER.trim()}` },
      body:JSON.stringify({ coverUrl:cover.url,variant,capsuleHash:capsule.capsuleHash }),signal:AbortSignal.timeout(3_500),
    });
    if (!response.ok) return { ...(miniAppBaseUrl ? { miniAppBaseUrl } : {}) };
    const body = await response.json<{mediaRef?:unknown}>();
    if (typeof body.mediaRef !== "string" || !/^agent-media:[0-9a-f-]{36}$/i.test(body.mediaRef)) return { ...(miniAppBaseUrl ? { miniAppBaseUrl } : {}) };
    return { ...(miniAppBaseUrl ? { miniAppBaseUrl } : {}),musicPosterMediaRef:body.mediaRef };
  } catch { return { ...(miniAppBaseUrl ? { miniAppBaseUrl } : {}) }; }
}

function safeNcmCover(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && /^p[1-4]\.music\.126\.net$/i.test(url.hostname) && !url.username && !url.password && !url.port && !url.hash && [...url.searchParams.keys()].every((key) => key === "param");
  } catch { return false; }
}
