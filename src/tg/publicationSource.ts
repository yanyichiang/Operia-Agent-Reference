import type { Env } from "../types";
import { nativeInferencePublicationId } from "./publicationDeliveryAuthority";

export type TgPublicationSourceAuthorityMode = "native" | "legacy";

export type TgPublicationSourceRoute = {
  sourceKind:"inference";
  sourceRef:string;
  publicationId:string;
  conversationEventId:string;
  authorityMode:TgPublicationSourceAuthorityMode;
  createdAt:string;
};

export type TgPublicationDeliveryRoute = {
  authorityMode:TgPublicationSourceAuthorityMode;
  provenance:"recorded"|"pre_route_native"|"legacy_provenance_missing";
};

type SourceRouteRow = {
  source_kind:"inference";
  source_ref:string;
  publication_id:string;
  conversation_event_id:string;
  authority_mode:TgPublicationSourceAuthorityMode;
  created_at:string;
};

export function selectedTgPublicationSourceAuthority(
  env:Pick<Env,"PUBLICATION_DELIVERY_AUTHORITY_ENABLED">,
):TgPublicationSourceAuthorityMode {
  return env.PUBLICATION_DELIVERY_AUTHORITY_ENABLED?.trim().toLowerCase() === "true"
    ? "native" : "legacy";
}

export function inferencePublicationSourceRoute(
  batchKey:string,
  authorityMode:TgPublicationSourceAuthorityMode,
  createdAt:string,
):TgPublicationSourceRoute {
  return {
    sourceKind:"inference",
    sourceRef:batchKey,
    publicationId:nativeInferencePublicationId(batchKey),
    conversationEventId:`batch:${batchKey}`,
    authorityMode,
    createdAt,
  };
}

export function prepareTgPublicationSourceRouteInsert(
  db:D1Database,
  route:TgPublicationSourceRoute,
  sourceCreatedAt:string,
):D1PreparedStatement {
  // The SELECT binds provenance only to the source row created by the same
  // durable command. Replaying an older pre-Gate-E source cannot backfill it
  // using today's rollout mode.
  return db.prepare(`INSERT INTO tg_publication_source_routes(
      source_kind,source_ref,publication_id,conversation_event_id,authority_mode,created_at)
    SELECT ?,?,?,?,?,? FROM tg_chat_inference_runs source
    WHERE source.batch_key=? AND source.created_at=?
    ON CONFLICT(source_kind,source_ref) DO NOTHING`)
    .bind(route.sourceKind,route.sourceRef,route.publicationId,route.conversationEventId,
      route.authorityMode,route.createdAt,route.sourceRef,sourceCreatedAt);
}

export async function readTgPublicationSourceRoute(
  db:D1Database,
  batchKey:string,
):Promise<TgPublicationSourceRoute|null> {
  const row = await db.prepare(`SELECT source_kind,source_ref,publication_id,
      conversation_event_id,authority_mode,created_at
    FROM tg_publication_source_routes WHERE source_kind='inference' AND source_ref=?`)
    .bind(batchKey).first<SourceRouteRow>();
  return row ? {
    sourceKind:row.source_kind,
    sourceRef:row.source_ref,
    publicationId:row.publication_id,
    conversationEventId:row.conversation_event_id,
    authorityMode:row.authority_mode,
    createdAt:row.created_at,
  } : null;
}

export async function verifyTgPublicationSourceRoute(
  db:D1Database,
  expected:TgPublicationSourceRoute,
):Promise<void> {
  const stored = await readTgPublicationSourceRoute(db,expected.sourceRef);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(expected)) {
    throw new Error("tg_publication_source_route_identity_conflict");
  }
}

export async function resolveTgPublicationDeliveryRoute(
  db:D1Database,
  batchKey:string,
):Promise<TgPublicationDeliveryRoute> {
  const route = await readTgPublicationSourceRoute(db,batchKey);
  if (route) {
    const expected = inferencePublicationSourceRoute(batchKey,route.authorityMode,route.createdAt);
    if (JSON.stringify(route) !== JSON.stringify(expected)) {
      throw new Error("tg_publication_source_route_identity_conflict");
    }
    return {authorityMode:route.authorityMode,provenance:"recorded"};
  }
  const native = await db.prepare(`SELECT 1 AS present FROM publication_aggregates aggregate
    WHERE aggregate.publication_id=? AND aggregate.channel='telegram'
      AND aggregate.inference_run_id=?
      AND EXISTS(SELECT 1 FROM publication_transport_bindings binding
        WHERE binding.publication_id=aggregate.publication_id)
    LIMIT 1`).bind(nativeInferencePublicationId(batchKey),`tg-inference:${batchKey}`)
    .first<{present:number}>();
  return native
    ? {authorityMode:"native",provenance:"pre_route_native"}
    : {authorityMode:"legacy",provenance:"legacy_provenance_missing"};
}
