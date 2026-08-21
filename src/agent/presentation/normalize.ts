import { sha256Hex } from "../toolCatalog";
import { assertJsonValue, canonicalJson } from "../../utils/json";
import type {
  Attribution,
  CachePolicy,
  NormalizedItem,
  NormalizedLocation,
  NormalizedToolResultV1,
  PresentationAsset,
  PresentationSource,
  Sensitivity,
} from "./types";

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data?: string; mimeType?: string }
  | { type: "audio"; data?: string; mimeType?: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | Record<string, unknown>;

export type RecordedCallToolResult = {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export type NormalizeMcpToolResultInput = {
  toolKey: string;
  providerId: string;
  taskId: string;
  toolCallId: string;
  result: RecordedCallToolResult;
  normalizedAt: string;
  elapsedMs?: number;
  sensitivity?: Sensitivity[];
};

const MAX_ITEMS = 10;
const MAX_STRING = 1_000;
const SECRET_KEY = /(authorization|bearer|token|secret|password|cookie|api[_-]?key|authreference)/i;
const SECRET_QUERY = /(^|_)(token|secret|key|signature|credential|auth)($|_)/i;
const SECRET_VALUE = /(?:^|\s)Bearer\s+\S{12,}|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/;
const GOOGLE_TOOLS = /google[_-]?maps|places|directions|distance[_-]?matrix/i;
const NCM_TOOLS = /(^|[/_-])(ncm|netease|music)([/_-]|$)|playlist|lyric/i;
const GENERIC_HIDDEN_KEY = /(^|_)(id|key|hash|etag|cursor|revision|version|metadata|raw|debug)($|_)/i;
const GENERIC_RESERVED_KEYS = new Set([
  "id","key","uid","title","name","label","displayName","subtitle","description","summary","message","text",
  "url","href","link","uri","webUrl","web_url","location","coordinates","latitude","longitude","lat","lng",
  "items","results","records","entries","events","files","data","result","sourceUrl","source_url",
]);

export async function normalizeMcpToolResult(input: NormalizeMcpToolResultInput): Promise<NormalizedToolResultV1> {
  assertIdentity(input);
  const warnings: string[] = [];
  const payload = extractStructuredPayload(input.result, warnings);
  rejectSecretKeys(payload);
  const calendarProjection = findCalendarProjection(payload);
  const healthProjection = findHealthProjection(payload);
  const adapter = healthProjection
    ? normalizeHealth(healthProjection, warnings)
    : calendarProjection
    ? normalizeCalendar(calendarProjection, warnings)
    : GOOGLE_TOOLS.test(input.toolKey)
      ? normalizeGoogle(payload, input.toolKey, warnings)
      : NCM_TOOLS.test(input.toolKey)
        ? normalizeNcm(payload, input.toolKey, warnings)
        : normalizeGeneric(payload, input.toolKey, input.providerId, warnings);
  const assets = normalizeAssets(input.result.content, warnings);
  const status = input.result.isError === true
    ? "failed"
    : adapter.status ?? (adapter.items.length > 0 || adapter.summary
        ? warnings.length > 0 ? "partial" : "success"
        : "empty");
  const cachePolicy: CachePolicy = adapter.cachePolicy ?? { mode: "transient", maxAgeSeconds: 300, refreshRequired: true };
  const rawResultHash = await sha256Hex(canonicalJson(assertJsonValue(input.result)));
  return {
    schema: "operia.tool-result/v1",
    toolKey: input.toolKey,
    providerId: input.providerId,
    taskId: input.taskId,
    toolCallId: input.toolCallId,
    status,
    ...(adapter.title ? { title: adapter.title } : {}),
    ...(adapter.summary ? { summary: adapter.summary } : {}),
    items: adapter.items,
    assets,
    sources: adapter.sources,
    warnings: unique(warnings).slice(0, 12),
    sensitivity: unique(input.sensitivity ?? adapter.sensitivity),
    attribution: adapter.attribution,
    cachePolicy,
    rawResultHash,
    normalizedAt: new Date(input.normalizedAt).toISOString(),
    ...(input.elapsedMs === undefined ? {} : { elapsedMs: clampInteger(input.elapsedMs, 0, 600_000) }),
  };
}

function findHealthProjection(value: unknown, depth = 0, seen = new Set<object>()): Record<string,unknown> | null {
  if (depth > 5 || !value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value.slice(0,12)) {
      const found = findHealthProjection(entry,depth+1,seen);
      if (found) return found;
    }
    return null;
  }
  const root = value as Record<string,unknown>;
  if (root.ownerDomain === "health.example.com" && record(root.summary)) return root;
  for (const key of ["projection","health","healthProjection","result","data","value","output"]) {
    const found = findHealthProjection(root[key],depth+1,seen);
    if (found) return found;
  }
  return null;
}

const HEALTH_LABELS: Record<string,string> = {
  "sleep.total_minutes":"睡眠", "activity.steps":"步数", "activity.active_energy":"活动能量",
  "activity.exercise_minutes":"锻炼", "cardio.heart_rate":"心率", "cardio.resting_heart_rate":"静息心率",
  "cardio.hrv_sdnn":"心率变异性", "body.weight":"体重",
};

function normalizeHealth(root: Record<string,unknown>, warnings: string[]): AdapterResult {
  const providerStatus = cleanText(firstString(root.status),64) ?? "unavailable";
  const freshness = record(root.freshness);
  const freshnessState = cleanText(firstString(freshness?.state),32) ?? "missing";
  const summary = record(root.summary) ?? {};
  const preferred = Object.keys(HEALTH_LABELS).filter((key) => key in summary);
  const remaining = Object.keys(summary).filter((key) => !preferred.includes(key)).sort();
  const items = [...preferred,...remaining].slice(0,4).flatMap((key,index) => {
    const metric = record(summary[key]);
    const value = finiteNumber(metric?.value);
    if (!metric || value === undefined) return [];
    const unit = cleanText(firstString(metric.unit),32) ?? "";
    const date = cleanText(firstString(metric.date),32);
    const changePercent = finiteNumber(metric.changePercent);
    const facts: Record<string,string | number | boolean> = { value,unit };
    if (date) facts.date = date;
    if (changePercent !== undefined) facts.changePercent = changePercent;
    return [{ id:`health-${index+1}`,title:HEALTH_LABELS[key] ?? key,facts,links:[] } satisfies NormalizedItem];
  });
  if (Object.keys(summary).length > items.length) warnings.push("health_metrics_truncated");
  if (freshnessState !== "fresh") warnings.push(freshnessState === "stale" ? "health_data_stale" : "health_data_missing");
  const fullViewUrl = safeHttpsUrl(firstString(root.fullViewUrl),warnings);
  const source: PresentationSource = { id:"apple-health",label:"Apple Health",...(fullViewUrl ? { url:fullViewUrl } : {}) };
  const status: NormalizedToolResultV1["status"] = providerStatus === "available" && freshnessState === "fresh"
    ? items.length ? "success" : "empty"
    : providerStatus === "stale" || freshnessState === "stale" ? "partial" : "empty";
  return {
    status,
    title:`健康摘要 · ${Number(root.range) === 30 ? "30 天" : Number(root.range) === 90 ? "90 天" : "7 天"}`,
    summary: status === "success" ? `最近数据已同步 · ${items.length} 项摘要` : freshnessState === "stale" ? "健康数据已过期，请先同步" : "暂时没有可用的健康数据",
    items,
    sources:[source],
    attribution:[{ ...source,required:true,placement:"footer" }],
    sensitivity:["owner_private","health"],
    cachePolicy:{ mode:"no_store",refreshRequired:true },
  };
}

type AdapterResult = {
  status?: NormalizedToolResultV1["status"];
  title?: string;
  summary?: string;
  items: NormalizedItem[];
  sources: PresentationSource[];
  attribution: Attribution[];
  sensitivity: Sensitivity[];
  cachePolicy?: CachePolicy;
};

function findCalendarProjection(value: unknown, depth = 0, seen = new Set<object>()): Record<string,unknown> | null {
  if (depth > 5 || !value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value.slice(0,12)) {
      const found = findCalendarProjection(entry,depth+1,seen);
      if (found) return found;
    }
    return null;
  }
  const root = value as Record<string,unknown>;
  if (root.ownerDomain === "calendar.example.com" && Array.isArray(root.upcoming)) return root;
  for (const key of ["projection","calendar","calendarProjection","result","data","value","output"]) {
    const found = findCalendarProjection(root[key],depth+1,seen);
    if (found) return found;
  }
  for (const entry of Object.values(root).slice(0,12)) {
    const found = findCalendarProjection(entry,depth+1,seen);
    if (found) return found;
  }
  return null;
}

function normalizeCalendar(root: Record<string,unknown>, warnings: string[]): AdapterResult {
  const providerStatus = cleanText(firstString(root.status),64) ?? "connected";
  const syncStatus = cleanText(firstString(root.lastSyncStatus,root.last_sync_status),64);
  const syncUnavailable = syncStatus === "error";
  const candidates = syncUnavailable ? [] : firstArray(root.upcoming);
  const items = candidates.slice(0,MAX_ITEMS).map((value,index) => calendarItem(value,index,warnings)).filter(nonNull);
  if (candidates.length > MAX_ITEMS) warnings.push("result_items_truncated");
  const remainingToday = finiteNumber(root.remainingToday);
  const summary = syncUnavailable
    ? "Calendar 同步授权已失效，需要重新连接"
    : providerStatus === "connected"
    ? items.length > 0
      ? `${remainingToday === undefined ? "接下来" : `今天还剩 ${Math.max(0,Math.trunc(remainingToday))} 项`} · 显示 ${items.length} 项日程`
      : "近期没有日程"
    : providerStatus === "not_configured" ? "Google Calendar 尚未连接"
      : providerStatus === "revoked" ? "Google Calendar 授权已失效"
        : providerStatus === "disabled" ? "Calendar 读取当前未启用" : "Calendar 暂时不可用";
  const status: NormalizedToolResultV1["status"] = syncUnavailable
    ? "partial"
    : providerStatus === "connected"
    ? items.length > 0 ? "success" : "empty"
    : providerStatus === "unavailable" ? "partial" : "empty";
  const source: PresentationSource = { id:"google-calendar",label:"Google Calendar" };
  return {
    status,
    title:"日程",
    summary,
    items,
    sources:[source],
    attribution:[{ ...source,required:true,placement:"footer" }],
    sensitivity:["owner_private","account"],
    cachePolicy:{ mode:"no_store",refreshRequired:true },
  };
}

function calendarItem(value: unknown,index: number,warnings: string[]): NormalizedItem | null {
  const item = record(value);
  if (!item) { warnings.push("invalid_calendar_item_dropped"); return null; }
  const title = cleanText(firstString(item.title,item.label,item.summary),256);
  if (!title) { warnings.push("calendar_item_without_title_dropped"); return null; }
  const start = cleanText(firstString(item.start,item.startsAt,item.starts_at),80);
  const end = cleanText(firstString(item.end,item.endsAt,item.ends_at),80);
  const timezone = cleanText(firstString(item.timezone),80);
  const calendarLabel = cleanText(firstString(item.calendarLabel,item.calendar_label),128);
  const eventStatus = cleanText(firstString(item.status),64);
  const responseStatus = cleanText(firstString(item.responseStatus,item.response_status),64);
  const allDay = item.allDay === true || item.all_day === true || item.all_day === 1;
  const facts: Record<string,string | number | boolean> = { allDay };
  if (start) facts.start = start;
  if (end) facts.end = end;
  if (timezone) facts.timezone = timezone;
  if (calendarLabel) facts.calendar = calendarLabel;
  if (eventStatus) facts.status = eventStatus;
  if (responseStatus) facts.responseStatus = responseStatus;
  return {
    id:`calendar-${index+1}`,
    title,
    ...(calendarLabel ? { subtitle:calendarLabel } : {}),
    facts,
    links:[],
  };
}

function normalizeGoogle(payload: unknown, toolKey: string, warnings: string[]): AdapterResult {
  const root = record(payload) ?? {};
  const lowerToolKey = toolKey.toLowerCase();
  if (lowerToolKey.includes("distance_matrix")) return normalizeGoogleDistanceMatrix(root, warnings);
  if (lowerToolKey.includes("directions")) return normalizeGoogleDirections(root, warnings);

  const listed = firstArray(root.places, root.results, record(root.data)?.places, record(root.data)?.results);
  const candidates = listed.length > 0
    ? listed
    : lowerToolKey.includes("place_details") && (root.name || root.title || root.id || root.location)
      ? [root]
      : [];
  const items = candidates.slice(0, MAX_ITEMS).map((value, index) => googleItem(value, index, warnings)).filter(nonNull);
  if (candidates.length > MAX_ITEMS) warnings.push("result_items_truncated");
  const sourceUrl = safeHttpsUrl(firstString(root.googleMapsUri, root.mapsUri, root.url, items[0]?.links.find((link) => link.rel === "canonical")?.url), warnings);
  const source = googleSource(sourceUrl);
  const isDetails = lowerToolKey.includes("place_details");
  return {
    title: isDetails ? items[0]?.title ?? "地点详情" : cleanText(firstString(root.query, root.title)) ?? "周边地点",
    summary: isDetails && items[0]?.subtitle
      ? items[0].subtitle
      : items.length > 0
        ? `找到 ${items.length} 个地点`
        : cleanText(firstString(root.message, root.statusText)),
    items,
    ...googleProvenance(source),
    sensitivity: ["owner_private", "location"],
    cachePolicy: { mode: "no_store", refreshRequired: true },
  };
}

function normalizeGoogleDirections(root: Record<string, unknown>, warnings: string[]): AdapterResult {
  const routes = firstArray(root.routes);
  const totalLegs = routes.map((value) => firstArray(record(value)?.legs).length).reduce<number>((count, length) => count + length, 0);
  const items: NormalizedItem[] = [];
  routes.slice(0, MAX_ITEMS).forEach((value, routeIndex) => {
    const route = record(value);
    if (!route) { warnings.push("invalid_route_dropped"); return; }
    const legs = firstArray(route.legs);
    legs.slice(0, MAX_ITEMS - items.length).forEach((legValue, legIndex) => {
      const leg = record(legValue);
      if (!leg) { warnings.push("invalid_route_leg_dropped"); return; }
      const start = cleanText(firstString(leg.startAddress, leg.start_address));
      const end = cleanText(firstString(leg.endAddress, leg.end_address));
      const distance = cleanText(firstString(record(leg.distance)?.text, leg.distance));
      const duration = cleanText(firstString(record(leg.duration)?.text, leg.duration));
      const facts: Record<string, string | number | boolean> = {};
      if (distance) facts.distance = distance;
      if (duration) facts.duration = duration;
      const routeSummary = cleanText(firstString(route.summary));
      items.push({
        id: `route-${routeIndex + 1}-leg-${legIndex + 1}`,
        title: routeSummary ?? `路线 ${routeIndex + 1}`,
        ...(start || end ? { subtitle: `${start ?? "起点"} → ${end ?? "终点"}` } : {}),
        facts,
        links: [],
      });
    });
    const routeWarnings = firstArray(route.warnings).map((warning) => cleanText(firstString(warning))).filter(nonNull);
    if (routeWarnings.length) warnings.push(...routeWarnings.map((warning) => `provider_warning:${warning}`));
  });
  if (totalLegs > MAX_ITEMS) warnings.push("result_items_truncated");
  const source = googleSource();
  return {
    title: "路线概览",
    summary: items.length > 0 ? `${items.length} 段路线` : cleanText(firstString(root.status, root.message)),
    items: items.slice(0, MAX_ITEMS),
    ...googleProvenance(source),
    sensitivity: ["owner_private", "location"],
    cachePolicy: { mode: "no_store", refreshRequired: true },
  };
}

function normalizeGoogleDistanceMatrix(root: Record<string, unknown>, warnings: string[]): AdapterResult {
  const origins = firstArray(root.originAddresses, root.origin_addresses).map((value) => cleanText(firstString(value)));
  const destinations = firstArray(root.destinationAddresses, root.destination_addresses).map((value) => cleanText(firstString(value)));
  const rows = firstArray(root.rows);
  const items: NormalizedItem[] = [];
  rows.forEach((rowValue, originIndex) => {
    const row = record(rowValue);
    if (!row) { warnings.push("invalid_distance_row_dropped"); return; }
    firstArray(row.elements).forEach((elementValue, destinationIndex) => {
      if (items.length >= MAX_ITEMS) return;
      const element = record(elementValue);
      if (!element) { warnings.push("invalid_distance_element_dropped"); return; }
      const origin = origins[originIndex] ?? `起点 ${originIndex + 1}`;
      const destination = destinations[destinationIndex] ?? `终点 ${destinationIndex + 1}`;
      const distance = cleanText(firstString(record(element.distance)?.text, element.distance));
      const duration = cleanText(firstString(record(element.duration)?.text, element.duration));
      const elementStatus = cleanText(firstString(element.status));
      const facts: Record<string, string | number | boolean> = {};
      if (distance) facts.distance = distance;
      if (duration) facts.duration = duration;
      if (elementStatus) facts.status = elementStatus;
      items.push({ id: `distance-${originIndex + 1}-${destinationIndex + 1}`, title: `${origin} → ${destination}`, facts, links: [] });
    });
  });
  const totalElements = rows.map((value) => firstArray(record(value)?.elements).length).reduce<number>((count, length) => count + length, 0);
  if (totalElements > MAX_ITEMS) warnings.push("result_items_truncated");
  const source = googleSource();
  return {
    title: "距离与时间",
    summary: items.length > 0 ? `${items.length} 组距离` : cleanText(firstString(root.status, root.message)),
    items,
    ...googleProvenance(source),
    sensitivity: ["owner_private", "location"],
    cachePolicy: { mode: "no_store", refreshRequired: true },
  };
}

function googleSource(url?: string): PresentationSource {
  return { id: "google-maps", label: "Google Maps", ...(url ? { url } : {}) };
}

function googleProvenance(source: PresentationSource): Pick<AdapterResult, "sources" | "attribution"> {
  return {
    sources: [source],
    attribution: [{ id: source.id, label: source.label, ...(source.url ? { url: source.url } : {}), required: true, placement: "footer" }],
  };
}

function googleItem(value: unknown, index: number, warnings: string[]): NormalizedItem | null {
  const item = record(value);
  if (!item) { warnings.push("invalid_place_item_dropped"); return null; }
  const displayName = record(item.displayName);
  const title = cleanText(firstString(displayName?.text, item.name, item.title));
  if (!title) { warnings.push("place_without_title_dropped"); return null; }
  const geometry = record(item.geometry);
  const location = normalizeLocation(item.location) ?? normalizeLocation(geometry?.location);
  const rating = finiteNumber(item.rating);
  const count = finiteNumber(item.userRatingCount) ?? finiteNumber(item.user_ratings_total);
  const status = cleanText(firstString(item.businessStatus, item.business_status));
  const facts: Record<string, string | number | boolean> = {};
  if (rating !== undefined) facts.rating = rating;
  if (count !== undefined) facts.userRatingCount = Math.max(0, Math.trunc(count));
  if (status) facts.businessStatus = status;
  const phone = cleanText(firstString(item.phone, item.nationalPhoneNumber, item.formatted_phone_number), 80);
  if (phone) facts.phone = phone;
  const hours = record(item.regularOpeningHours) ?? record(item.opening_hours);
  const weekdayDescriptions = firstArray(hours?.weekdayDescriptions, hours?.weekday_text).map((entry) => cleanText(firstString(entry))).filter(nonNull);
  if (weekdayDescriptions.length) facts.openingHours = cleanText(weekdayDescriptions.join("；"), 256) ?? "";
  const url = safeHttpsUrl(firstString(item.googleMapsUri, item.mapsUri, item.url), warnings);
  const website = safeHttpsUrl(firstString(item.websiteUri, item.website), warnings);
  return {
    id: cleanIdentifier(firstString(item.id, item.placeId, item.place_id)) ?? `place-${index + 1}`,
    title,
    ...(cleanText(firstString(item.formattedAddress, item.formatted_address, item.address, item.vicinity)) ? { subtitle: cleanText(firstString(item.formattedAddress, item.formatted_address, item.address, item.vicinity)) } : {}),
    ...(location ? { location } : {}),
    facts,
    links: [
      ...(url ? [{ rel: "canonical" as const, url }] : []),
      ...(website ? [{ rel: "source" as const, url: website }] : []),
    ],
  };
}

function normalizeNcm(payload: unknown, toolKey: string, warnings: string[]): AdapterResult {
  const root = record(payload) ?? {};
  const result = record(root.result) ?? root;
  const operationData = record(root.data);
  const playlist = record(root.playlist) ?? record(result.playlist);
  const lyric = cleanText(firstString(operationData?.lyric, record(root.lrc)?.lyric, root.lyric, result.lyric), 2_000);
  const candidates = firstArray(root.data, result.songs, result.artists, result.playlists, root.songs, root.artists, root.playlists, playlist?.tracks);
  const items = candidates.slice(0, MAX_ITEMS).map((value, index) => ncmItem(value, index, warnings)).filter(nonNull);
  if (candidates.length > MAX_ITEMS) warnings.push("result_items_truncated");
  if (lyric && items.length === 0) {
    items.push({ id: "lyric-1", title: cleanText(firstString(root.name, result.name)) ?? "歌词", facts: { excerpt: lyric }, links: [] });
  }
  const sourceUrl = safeHttpsUrl(firstString(root.canonicalUrl,root.url,result.canonicalUrl,result.url), warnings);
  const operation = cleanText(firstString(root.operation))?.toLowerCase() ?? "";
  const mode = `${toolKey.toLowerCase()} ${operation}`;
  const title = cleanText(firstString(playlist?.name, result.name, root.name))
    ?? (mode.includes("lyric") ? "歌词" : mode.includes("playlist") ? "歌单" : mode.includes("artist") ? "歌手作品" : "网易云搜索结果");
  return {
    title,
    summary: items.length > 0 ? `找到 ${items.length} 项结果` : cleanText(firstString(root.message, result.message)),
    items,
    sources: [{ id: "ncm", label: "网易云音乐", ...(sourceUrl ? { url: sourceUrl } : {}) }],
    attribution: [{ id: "ncm", label: "网易云音乐", ...(sourceUrl ? { url: sourceUrl } : {}), required: true, placement: "footer" }],
    sensitivity: ["owner_private"],
    cachePolicy: { mode: "transient", maxAgeSeconds: 300, refreshRequired: true },
  };
}

function ncmItem(value: unknown, index: number, warnings: string[]): NormalizedItem | null {
  const item = record(value);
  if (!item) { warnings.push("invalid_music_item_dropped"); return null; }
  const title = cleanText(firstString(item.name, item.title));
  if (!title) { warnings.push("music_item_without_title_dropped"); return null; }
  const artists = firstArray(item.artist, item.artists, item.ar).map((entry) => cleanText(firstString(record(entry)?.name, entry))).filter(nonNull).slice(0, 5);
  const album = record(item.album) ?? record(item.al);
  const facts: Record<string, string | number | boolean> = {};
  if (artists.length) facts.artist = artists.join(" / ");
  const albumName = cleanText(firstString(album?.name, item.album));
  if (albumName) facts.album = albumName;
  const duration = finiteNumber(item.duration) ?? finiteNumber(item.dt);
  if (duration !== undefined) facts.durationMs = Math.max(0, Math.trunc(duration));
  const url = safeHttpsUrl(firstString(item.canonicalUrl,item.url, item.shareUrl), warnings);
  return {
    id: cleanIdentifier(firstString(item.id)) ?? `music-${index + 1}`,
    title,
    ...(artists.length ? { subtitle: artists.join(" / ") } : {}),
    facts,
    links: url ? [{ rel: "canonical", url }] : [],
  };
}

function normalizeGeneric(payload: unknown, toolKey: string, providerId: string, warnings: string[]): AdapterResult {
  const root = record(payload);
  const nested = record(root?.result) ?? record(root?.data);
  const summary = root
    ? cleanText(firstString(root.summary,root.message,root.text,root.description,nested?.summary,nested?.message,nested?.text))
    : Array.isArray(payload) ? undefined : cleanText(String(payload ?? ""));
  const candidates = Array.isArray(payload) ? payload : root ? firstArray(
    root.items,root.results,root.records,root.entries,root.events,root.files,
    Array.isArray(root.data) ? root.data : undefined,
    nested?.items,nested?.results,nested?.records,nested?.entries,
  ) : [];
  const items = candidates.slice(0,MAX_ITEMS).map((value,index) => genericItem(value,index,warnings)).filter(nonNull);
  if (candidates.length > MAX_ITEMS) warnings.push("result_items_truncated");
  const scalarRoot = nested ?? root;
  if (!items.length && scalarRoot) {
    const item = genericItem(scalarRoot,0,warnings,displayToolName(toolKey));
    if (item && (Object.keys(item.facts).length > 0 || item.location || item.links.length > 0)) items.push(item);
  }
  const sourceUrl = safeHttpsUrl(firstString(root?.sourceUrl,root?.source_url,nested?.sourceUrl,nested?.source_url),warnings);
  const sourceId = cleanIdentifier(providerId) ?? "mcp-provider";
  const source = { id:sourceId,label:displayToolName(providerId),...(sourceUrl ? { url:sourceUrl } : {}) };
  return {
    title: cleanText(firstString(root?.title,root?.name,root?.label,nested?.title,nested?.name,nested?.label))
      ?? displayToolName(toolKey),
    summary,
    items,
    sources:[source],
    attribution:[{ ...source,required:true,placement:"footer" }],
    sensitivity:["owner_private"],
    cachePolicy:{ mode:"transient",maxAgeSeconds:300,refreshRequired:true },
  };
}

function genericItem(value: unknown, index: number, warnings: string[], fallbackTitle?: string): NormalizedItem | null {
  const item = record(value);
  if (!item) {
    const title = cleanText(String(value ?? ""));
    return title ? { id: `item-${index + 1}`, title, facts: {}, links: [] } : null;
  }
  const title = cleanText(firstString(item.title,item.name,item.label,item.displayName)) ?? fallbackTitle ?? `结果 ${index+1}`;
  const subtitle = cleanText(firstString(item.subtitle,item.description,item.summary,item.message),256);
  const facts: Record<string,string | number | boolean> = {};
  for (const [key,entry] of Object.entries(item)) {
    if (Object.keys(facts).length >= 12 || GENERIC_RESERVED_KEYS.has(key) || GENERIC_HIDDEN_KEY.test(key)) continue;
    if (typeof entry === "boolean" || typeof entry === "number" && Number.isFinite(entry)) facts[key] = entry;
    else if (typeof entry === "string") {
      const text = cleanText(entry,256);
      if (text && !looksLikeUrl(text)) facts[key] = text;
    }
  }
  const location = normalizeLocation(item.location) ?? normalizeLocation(item.coordinates) ?? normalizeLocation(item);
  const canonical = safeHttpsUrl(firstString(item.url,item.href,item.link,item.uri,item.webUrl,item.web_url),warnings);
  return {
    id:cleanIdentifier(firstString(item.id,item.key,item.uid)) ?? `item-${index+1}`,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(location ? { location } : {}),
    facts,
    links:canonical ? [{ rel:"canonical",url:canonical }] : [],
  };
}

function extractStructuredPayload(result: RecordedCallToolResult, warnings: string[]): unknown {
  if (record(result.structuredContent)) return result.structuredContent;
  for (const block of result.content) {
    const value = record(block);
    if (value?.type !== "text" || typeof value.text !== "string") continue;
    try { return JSON.parse(value.text); } catch { /* Legacy text is handled below. */ }
  }
  const text = result.content.map((block) => record(block)).filter(nonNull).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("\n");
  if (text) { warnings.push("legacy_text_result"); return { summary: text }; }
  return {};
}

function normalizeAssets(content: McpContentBlock[], warnings: string[]): PresentationAsset[] {
  const assets: PresentationAsset[] = [];
  for (const block of content) {
    const value = record(block);
    if (!value || assets.length >= 10) break;
    if (value.type === "resource_link" && typeof value.uri === "string") {
      const url = safeHttpsUrl(value.uri, warnings);
      if (!url) continue;
      const mimeType = cleanText(firstString(value.mimeType), 128) ?? "application/octet-stream";
      const kind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "document";
      assets.push({ id: `asset-${assets.length + 1}`, kind, source: "provider_url", url, mimeType, attributionIds: [], cachePolicy: { mode: "no_store", refreshRequired: true } });
    } else if ((value.type === "image" || value.type === "audio") && typeof value.data === "string") {
      warnings.push("inline_binary_omitted_from_capsule");
    }
  }
  return assets;
}

function safeHttpsUrl(raw: string | undefined, warnings: string[]): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || isPrivateHostname(url.hostname)) throw new Error();
    let secretQuery = false;
    url.searchParams.forEach((_value, key) => { if (SECRET_QUERY.test(key)) secretQuery = true; });
    if (secretQuery) throw new Error();
    if (url.toString().length > 2_048) throw new Error();
    return url.toString();
  } catch { warnings.push("unsafe_url_dropped"); return undefined; }
}

function rejectSecretKeys(value: unknown, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string" && SECRET_VALUE.test(value)) throw new Error("presentation_secret_value_rejected");
  if (Array.isArray(value)) { value.forEach((item) => rejectSecretKeys(item, depth + 1)); return; }
  const object = record(value);
  if (!object) return;
  for (const [key, item] of Object.entries(object)) {
    if (SECRET_KEY.test(key)) throw new Error("presentation_secret_field_rejected");
    rejectSecretKeys(item, depth + 1);
  }
}

function assertIdentity(input: NormalizeMcpToolResultInput): void {
  for (const value of [input.toolKey, input.providerId, input.taskId, input.toolCallId]) if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("presentation_identity_invalid");
  if (Number.isNaN(Date.parse(input.normalizedAt))) throw new Error("presentation_time_invalid");
  if (!Array.isArray(input.result.content)) throw new Error("mcp_call_tool_result_invalid");
}

function normalizeLocation(value: unknown): NormalizedLocation | undefined {
  const location = record(value);
  if (!location) return undefined;
  const latitude = finiteNumber(location.latitude) ?? finiteNumber(location.lat);
  const longitude = finiteNumber(location.longitude) ?? finiteNumber(location.lng);
  return latitude !== undefined && longitude !== undefined && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 ? { latitude, longitude } : undefined;
}

function isPrivateHostname(hostname: string): boolean { const host = hostname.toLowerCase().replace(/\.$/, ""); return host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "metadata.google.internal"; }
function cleanText(value: string | undefined, max = MAX_STRING): string | undefined { if (!value) return undefined; const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim(); return text ? text.slice(0, max) : undefined; }
function cleanIdentifier(value: string | undefined): string | undefined { const text = cleanText(value, 128); return text?.replace(/[^A-Za-z0-9._:-]/g, "-"); }
function displayToolName(value: string): string {
  const leaf = value.split("/").at(-1) ?? value;
  return cleanText(leaf.replace(/[_-]+/g," ").replace(/([a-z0-9])([A-Z])/g,"$1 $2"),128) ?? "MCP 结果";
}
function looksLikeUrl(value: string): boolean { try { new URL(value); return true; } catch { return false; } }
function firstString(...values: unknown[]): string | undefined { for (const value of values) if (typeof value === "string" || typeof value === "number") return String(value); return undefined; }
function firstArray(...values: unknown[]): unknown[] { for (const value of values) if (Array.isArray(value)) return value; return []; }
function finiteNumber(value: unknown): number | undefined { const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN; return Number.isFinite(number) ? number : undefined; }
function clampInteger(value: number, min: number, max: number): number { if (!Number.isFinite(value)) throw new Error("presentation_elapsed_invalid"); return Math.max(min, Math.min(max, Math.trunc(value))); }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
