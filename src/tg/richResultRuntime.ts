import { renderResultCapsule } from "./richResultRenderer";
import { attemptRichResultPrimary, decideRichResultDelivery } from "./richResults";
import type { Env } from "../types";
import type { ResultCapsuleV1 } from "../agent/presentation/types";
import type { TelegramIntent } from "./richResultRenderer";

export const TG_RICH_RESULT_REGISTRY = Object.freeze({
  schema: "operia.presentation/v1",
  mode: "native_with_fallback",
  maxMedia: 10,
  implementation: Object.freeze({
    renderFinal: renderResultCapsule,
    attemptPrimary: attemptRichResultPrimary,
    decideDelivery: decideRichResultDelivery,
  }),
});

export function tgRichResultsEnabled(env: Pick<Env, "TG_RICH_RESULTS_ENABLED">): boolean {
  return env.TG_RICH_RESULTS_ENABLED?.trim().toLowerCase() === "true";
}

/** Public Bot API projection; every returned intent becomes an ordinary
 * durable outbox row and inherits the existing delivery/idempotency contract. */
export function renderTelegramCompatibleResultCapsule(capsule: ResultCapsuleV1, options: Parameters<typeof renderResultCapsule>[1] = {}): TelegramIntent[] {
  const plan = renderResultCapsule(capsule,options);
  const map = capsule.blocks.find((block) => block.type === "map");
  return [
    ...(map?.type === "map" ? [{
      method: "sendLocation",
      latitude: map.latitude,
      longitude: map.longitude,
    }] : []),
    plan.primary,
  ];
}

export function handleTgRichResultCapabilities(request: Request, env: Env): Response {
  if (request.method !== "GET" || !tgRichResultsEnabled(env)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json({
    schema: TG_RICH_RESULT_REGISTRY.schema,
    mode: TG_RICH_RESULT_REGISTRY.mode,
    maxMedia: TG_RICH_RESULT_REGISTRY.maxMedia,
    implementation: {
      renderFinal: TG_RICH_RESULT_REGISTRY.implementation.renderFinal.name,
      attemptPrimary: TG_RICH_RESULT_REGISTRY.implementation.attemptPrimary.name,
      decideDelivery: TG_RICH_RESULT_REGISTRY.implementation.decideDelivery.name,
    },
  }, { headers: { "cache-control": "no-store" } });
}
