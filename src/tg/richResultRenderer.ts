import { assertResultCapsuleV1, type MiniAppTarget, type PresentationBlock, type ResultCapsuleV1 } from "../agent/presentation/types";

export type TelegramIntent = Record<string, unknown> & { method: string };
export type TelegramRenderOptions = { miniAppBaseUrl?: string; musicPosterMediaRef?: string };
export type TelegramRenderPlan = {
  primary: TelegramIntent;
  deterministicFallbacks: TelegramIntent[];
  reason: string;
  capsuleHash: string;
};

const MINI_APP_TARGETS: Record<MiniAppTarget,string> = {
  calendar:"calendar",health_7d:"health_7d",health_30d:"health_30d",
};

export function renderResultCapsule(capsule: ResultCapsuleV1, options: TelegramRenderOptions = {}): TelegramRenderPlan {
  assertResultCapsuleV1(capsule);
  const keyboard = renderActions(capsule,options.miniAppBaseUrl);
  const text = renderHtml(capsule).slice(0,3_800);
  const media = options.musicPosterMediaRef ?? firstImageReference(capsule);
  const primary: TelegramIntent = media ? {
    method:"sendPhoto",...(media.startsWith("agent-media:") ? { media_ref:media } : { photo:media }),
    caption:text.slice(0,900),parse_mode:"HTML",show_caption_above_media:false,
    ...(keyboard ? { reply_markup:{ inline_keyboard:keyboard } } : {}),
  } : {
    method:"sendMessage",text,parse_mode:"HTML",link_preview_options:{ is_disabled:true },
    ...(keyboard ? { reply_markup:{ inline_keyboard:keyboard } } : {}),
  };
  return {
    primary,
    deterministicFallbacks:[{ method:"sendMessage",text:capsule.fallbackText,link_preview_options:{ is_disabled:true },...(keyboard ? { reply_markup:{ inline_keyboard:keyboard } } : {}) }],
    reason:"telegram_public_bot_api_native_intent",
    capsuleHash:capsule.capsuleHash,
  };
}

function renderHtml(capsule: ResultCapsuleV1): string {
  const chunks: string[] = [];
  for (const block of capsule.blocks) chunks.push(...blockHtml(block,capsule));
  return chunks.filter(Boolean).join("\n").replace(/\n{3,}/g,"\n\n") || escapeHtml(capsule.fallbackText);
}

function blockHtml(block: PresentationBlock,capsule: ResultCapsuleV1): string[] {
  switch (block.type) {
    case "heading": return [`<b>${escapeHtml(block.text)}</b>`];
    case "paragraph": return [escapeHtml(block.text)];
    case "fact_list": return block.facts.map((fact) => `<b>${escapeHtml(fact.label)}</b>　${escapeHtml(fact.value)}`);
    case "metric": return [`<b>${escapeHtml(block.label)}</b>　${escapeHtml(block.value)}${block.note ? `\n<i>${escapeHtml(block.note)}</i>` : ""}`];
    case "table": return [block.caption ? `<i>${escapeHtml(block.caption)}</i>` : "",...block.rows.slice(0,6).map((row) => `• ${row.map(escapeHtml).join("　")}`)];
    case "map": return [block.label ? `📍 ${escapeHtml(block.label)}` : ""];
    case "media": case "gallery": case "divider": return [];
    case "details": return [`<b>${escapeHtml(block.summary)}</b>`,...block.blocks.flatMap((child) => blockHtml(child,capsule))];
    case "sources": {
      const labels = block.sourceIds.map((id) => capsule.sources.find((source) => source.id === id)?.label).filter((value): value is string => Boolean(value));
      return labels.length ? [`<i>来源：${labels.map(escapeHtml).join("、")}</i>`] : [];
    }
    case "notice": return [`<blockquote>${escapeHtml(block.text)}</blockquote>`];
  }
}

function firstImageReference(capsule: ResultCapsuleV1): string | undefined {
  const asset = capsule.assets.find((item) => item.kind === "image" && (item.mediaRef || item.url));
  return asset?.mediaRef ?? asset?.url;
}

function renderActions(capsule: ResultCapsuleV1,miniAppBaseUrl?: string): Array<Array<Record<string,unknown>>> | null {
  const buttons: Array<Record<string,unknown>> = [];
  for (const action of capsule.actions) {
    if (action.kind === "open_url" && isSafeActionUrl(action.urlRef)) buttons.push({ text:action.label,url:action.urlRef });
    if (action.kind === "callback" && /^[A-Za-z0-9._:-]{1,64}$/.test(action.callbackRef)) buttons.push({ text:action.label,callback_data:action.callbackRef });
    if (action.kind === "open_mini_app") {
      const url = miniAppUrl(miniAppBaseUrl,action.miniAppTarget);
      if (url) buttons.push({ text:action.label,web_app:{ url } });
    }
  }
  return buttons.length ? buttons.slice(0,8).map((button) => [button]) : null;
}

function miniAppUrl(base: string | undefined,target: MiniAppTarget): string | undefined {
  if (!base) return undefined;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.hostname !== "tgbot.example.com" || url.pathname !== "/app" || url.username || url.password || url.hash || url.port) return undefined;
    url.searchParams.set("tgWebAppStartParam",MINI_APP_TARGETS[target]);
    return url.toString();
  } catch { return undefined; }
}

function isSafeActionUrl(raw: string): boolean {
  try { const url = new URL(raw); return url.protocol === "https:" && !url.username && !url.password && !url.hash && url.toString().length <= 2_048; } catch { return false; }
}

function escapeHtml(value: string): string { return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
