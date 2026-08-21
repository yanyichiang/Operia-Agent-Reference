import { sha256Hex } from "../toolCatalog";
import { assertJsonValue, canonicalJson } from "../../utils/json";
import { assertResultCapsuleV1, type NormalizedToolResultV1, type ResultCapsuleV1 } from "./types";
import { compileGenericReceipt } from "./recipes/genericReceipt";
import { compileGenericResult } from "./recipes/genericResult";
import { compileCalendarAgenda } from "./recipes/calendarAgenda";
import { compileGoogleMaps } from "./recipes/googleMaps";
import { compileNcm } from "./recipes/ncm";
import { compileHealthSummary } from "./recipes/healthSummary";

export async function compileResultCapsule(result: NormalizedToolResultV1): Promise<ResultCapsuleV1> {
  if (result.schema !== "operia.tool-result/v1") throw new Error("normalized_result_schema_invalid");
  const draft = isHealth(result)
    ? compileHealthSummary(result)
    : isCalendar(result)
    ? compileCalendarAgenda(result)
    : isGoogleMaps(result.toolKey)
    ? compileGoogleMaps(result)
    : isNcm(result.toolKey)
      ? compileNcm(result)
      : hasDisplayableResult(result)
        ? compileGenericResult(result)
        : compileGenericReceipt(result);
  const identity = {
    schema: draft.schema,
    taskId: draft.taskId,
    toolCallIds: draft.toolCallIds,
    normalizedResultHash: result.rawResultHash,
    recipe: draft.recipe,
    presentationRevision: draft.presentationRevision,
    content: draft,
  };
  const capsuleHash = await sha256Hex(canonicalJson(assertJsonValue(identity)));
  const capsule: ResultCapsuleV1 = {
    ...draft,
    capsuleId: `caps_${capsuleHash.slice(0, 32)}`,
    capsuleHash,
    createdAt: result.normalizedAt,
  };
  assertResultCapsuleV1(capsule);
  return capsule;
}

function isGoogleMaps(toolKey: string): boolean { return /google[_-]?maps|places|directions|distance[_-]?matrix/i.test(toolKey); }
function isNcm(toolKey: string): boolean { return /(^|[/_-])(ncm|netease|music)([/_-]|$)|playlist|lyric/i.test(toolKey); }
function isHealth(result: NormalizedToolResultV1): boolean {
  return result.sources.some((source) => source.id === "apple-health") || result.sensitivity.includes("health");
}
function isCalendar(result: NormalizedToolResultV1): boolean {
  return /calendar/i.test(`${result.toolKey} ${result.providerId}`)
    || result.sources.some((source) => source.id === "google-calendar");
}
function hasDisplayableResult(result: NormalizedToolResultV1): boolean {
  return Boolean(result.title || result.summary || result.items.length || result.assets.length || result.sources.length);
}
