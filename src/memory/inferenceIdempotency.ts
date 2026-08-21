import { nowIso } from "../utils/time";

type InferenceReplayRow = {
  request_hash: string;
  source?: string;
  status: string;
  response_json: string | null;
  upstream_status: number | null;
  last_error: string | null;
};

type InferenceReplayIdentity = {
  requestHash: string;
  source: string;
};

export type InferencePresentationKind = "approval" | "sdk_action" | "codemode_parked" | "harness_held";

export type InferencePresentation = {
  idempotency_key: string;
  revision: number;
  request_hash: string;
  source: string;
  kind: InferencePresentationKind;
  response_json: string;
  status: "ready" | "consumed" | "superseded" | "attention_required";
};

export async function readCompletedInferenceReplay(
  db: D1Database,
  idempotencyKey: string,
  identity: InferenceReplayIdentity,
): Promise<string | null> {
  const row = await db.prepare(`SELECT request_hash,source,status,response_json
    FROM inference_idempotency WHERE idempotency_key=?`)
    .bind(idempotencyKey).first<{
      request_hash: string;
      source: string;
      status: string;
      response_json: string | null;
    }>();
  if (!row) return null;
  if (row.request_hash !== identity.requestHash || row.source !== identity.source) {
    throw new InferenceReplayTransitionError("inference_replay_identity_mismatch");
  }
  return row.status === "completed" && row.response_json ? row.response_json : null;
}

export class InferenceReplayTransitionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "InferenceReplayTransitionError";
  }
}

export type InferenceReplayClaim =
  | { kind: "owner" }
  | { kind: "replay"; response: Response }
  | { kind: "blocked"; status: string; error: string }
  | { kind: "conflict" };

export async function inferenceRequestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Acquire the Memory-owned provider call. Only the INSERT winner may contact
 * the provider. A completed response is replayed byte-for-byte; an ambiguous
 * in-flight outcome is surfaced without issuing another paid call.
 */
export async function beginInferenceReplay(
  db: D1Database,
  input: { idempotencyKey: string; requestHash: string; source: string; retentionSeconds?: number },
): Promise<InferenceReplayClaim> {
  const now = nowIso();
  await db.prepare("DELETE FROM inference_idempotency WHERE idempotency_key=? AND expires_at < ?")
    .bind(input.idempotencyKey, now).run();
  const retentionSeconds = Math.min(7 * 24 * 60 * 60, Math.max(60, input.retentionSeconds ?? 7 * 24 * 60 * 60));
  const expiresAt = new Date(Date.now() + retentionSeconds * 1000).toISOString();
  const inserted = await db.prepare(`INSERT INTO inference_idempotency
    (idempotency_key,request_hash,source,status,created_at,updated_at,expires_at)
    VALUES(?,?,?,'calling',?,?,?) ON CONFLICT(idempotency_key) DO NOTHING
    RETURNING idempotency_key`)
    .bind(input.idempotencyKey, input.requestHash, input.source, now, now, expiresAt)
    .first<{ idempotency_key: string }>();
  if (inserted) return { kind: "owner" };

  const row = await db.prepare(`SELECT request_hash,source,status,response_json,upstream_status,last_error
    FROM inference_idempotency WHERE idempotency_key=?`)
    .bind(input.idempotencyKey).first<InferenceReplayRow>();
  if (!row) return { kind: "blocked", status: "missing", error: "inference_replay_state_missing" };
  if (row.request_hash !== input.requestHash || row.source !== input.source) return { kind: "conflict" };
  if (row.status === "completed" && row.response_json) {
    return {
      kind: "replay",
      response: new Response(row.response_json, {
        status: row.upstream_status ?? 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-operia-idempotency-replay": "true",
        },
      }),
    };
  }
  if (row.status === "responded") {
    const presentation = await readReadyInferencePresentation(db,input.idempotencyKey);
    if (presentation && presentation.request_hash === input.requestHash && presentation.source === input.source) {
      return {
        kind: "replay",
        response: new Response(presentation.response_json, {
          status: row.upstream_status ?? 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-operia-idempotency-replay": "true",
            "x-operia-presentation-replay": presentation.kind,
          },
        }),
      };
    }
  }
  return {
    kind: "blocked",
    status: row.status,
    error: row.last_error || (row.status === "calling" || row.status === "responded"
      ? "inference_outcome_pending_or_unknown"
      : "inference_not_replayable"),
  };
}

async function readInferenceReplayRow(db: D1Database, idempotencyKey: string): Promise<InferenceReplayRow | null> {
  return db.prepare(`SELECT request_hash,source,status,response_json,upstream_status,last_error
    FROM inference_idempotency WHERE idempotency_key=?`)
    .bind(idempotencyKey).first<InferenceReplayRow>();
}

async function preserveMissingInferenceAttention(
  db: D1Database,
  idempotencyKey: string,
  identity: InferenceReplayIdentity,
  code: string,
): Promise<void> {
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await db.prepare(`INSERT INTO inference_idempotency
      (idempotency_key,request_hash,source,status,last_error,created_at,updated_at,expires_at)
      VALUES(?,?,?,'attention_required',?,?,?,?)
      ON CONFLICT(idempotency_key) DO NOTHING`)
      .bind(idempotencyKey, identity.requestHash, identity.source, code, now, now, expiresAt).run();
  } catch {
    throw new InferenceReplayTransitionError("inference_terminal_attention_unknown");
  }
}

async function resolveZeroRowTransition(
  db: D1Database,
  idempotencyKey: string,
  identity: InferenceReplayIdentity,
  matches: (row: InferenceReplayRow) => boolean,
  code: string,
): Promise<void> {
  let row: InferenceReplayRow | null;
  try {
    row = await readInferenceReplayRow(db, idempotencyKey);
  } catch {
    throw new InferenceReplayTransitionError("inference_terminal_read_unknown");
  }
  if (row?.request_hash === identity.requestHash && row.source === identity.source && matches(row)) return;
  if (!row) await preserveMissingInferenceAttention(db, idempotencyKey, identity, code);
  throw new InferenceReplayTransitionError(code);
}

export async function markInferenceResponded(
  db: D1Database,
  idempotencyKey: string,
  upstreamStatus: number,
  identity: InferenceReplayIdentity,
): Promise<void> {
  let updated: { idempotency_key: string } | null;
  try {
    updated = await db.prepare(`UPDATE inference_idempotency SET status='responded',upstream_status=?,updated_at=?
      WHERE idempotency_key=? AND request_hash=? AND source=? AND status='calling' RETURNING idempotency_key`)
      .bind(upstreamStatus, nowIso(), idempotencyKey, identity.requestHash,identity.source).first<{ idempotency_key: string }>();
  } catch {
    throw new InferenceReplayTransitionError("inference_responded_update_unknown");
  }
  if (updated) return;
  await resolveZeroRowTransition(
    db,
    idempotencyKey,
    identity,
    (row) => (row.status === "responded" || row.status === "completed") && row.upstream_status === upstreamStatus,
    "inference_responded_transition_rejected",
  );
}

/**
 * A pending approval/SDK/Code Mode envelope is a durable, replayable
 * presentation checkpoint. It is not a completed provider response, so the
 * paid-call ledger remains `responded` while Telegram may recover the exact
 * same JSON without asking the model or Action runtime to run again.
 */
export async function storeInferencePresentation(
  db: D1Database,
  input: {
    idempotencyKey: string;
    upstreamStatus: number;
    identity: InferenceReplayIdentity;
    kind: InferencePresentationKind;
    responseJson: string;
  },
): Promise<void> {
  JSON.parse(input.responseJson) as unknown;
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
  await db.batch([
    db.prepare(`UPDATE inference_idempotency SET status='responded',upstream_status=?,updated_at=?
      WHERE idempotency_key=? AND request_hash=? AND source=? AND status IN ('calling','responded')`)
      .bind(input.upstreamStatus,now,input.idempotencyKey,input.identity.requestHash,input.identity.source),
    db.prepare(`INSERT INTO inference_presentations
      (idempotency_key,revision,request_hash,source,kind,response_json,status,created_at,updated_at,expires_at)
      SELECT ?,1,?,?,?,?, 'ready',?,?,?
      WHERE EXISTS (SELECT 1 FROM inference_idempotency
        WHERE idempotency_key=? AND request_hash=? AND source=? AND status='responded')
      ON CONFLICT(idempotency_key,revision) DO UPDATE SET
        response_json=excluded.response_json,kind=excluded.kind,status='ready',updated_at=excluded.updated_at,
        expires_at=excluded.expires_at
      WHERE inference_presentations.request_hash=excluded.request_hash
        AND inference_presentations.source=excluded.source`)
      .bind(input.idempotencyKey,input.identity.requestHash,input.identity.source,input.kind,input.responseJson,
        now,now,expiresAt,input.idempotencyKey,input.identity.requestHash,input.identity.source),
  ]);
  const stored = await db.prepare(`SELECT idempotency_key,revision,request_hash,source,kind,response_json,status
    FROM inference_presentations WHERE idempotency_key=? AND revision=1`)
    .bind(input.idempotencyKey).first<InferencePresentation>();
  if (!stored || stored.request_hash !== input.identity.requestHash || stored.source !== input.identity.source
    || stored.kind !== input.kind || stored.response_json !== input.responseJson || stored.status !== "ready") {
    throw new InferenceReplayTransitionError("inference_presentation_transition_rejected");
  }
}

export async function readReadyInferencePresentation(
  db: D1Database,
  idempotencyKey: string,
): Promise<InferencePresentation | null> {
  return db.prepare(`SELECT idempotency_key,revision,request_hash,source,kind,response_json,status
    FROM inference_presentations WHERE idempotency_key=? AND status='ready'
    ORDER BY revision DESC LIMIT 1`).bind(idempotencyKey).first<InferencePresentation>();
}

export async function completeInferenceReplay(
  db: D1Database,
  idempotencyKey: string,
  responseJson: string,
  upstreamStatus = 200,
  identity: InferenceReplayIdentity,
): Promise<void> {
  const now = nowIso();
  let updated: { idempotency_key: string } | null;
  try {
    updated = await db.prepare(`UPDATE inference_idempotency SET status='completed',response_json=?,upstream_status=?,
      last_error=NULL,updated_at=?,completed_at=? WHERE idempotency_key=? AND request_hash=? AND source=?
      AND status IN ('calling','responded') RETURNING idempotency_key`)
      .bind(responseJson, upstreamStatus, now, now, idempotencyKey, identity.requestHash,identity.source)
      .first<{ idempotency_key: string }>();
  } catch {
    throw new InferenceReplayTransitionError("inference_complete_update_unknown");
  }
  if (!updated) {
    await resolveZeroRowTransition(
      db,
      idempotencyKey,
      identity,
      (row) => row.status === "completed" && row.response_json === responseJson && row.upstream_status === upstreamStatus,
      "inference_complete_transition_rejected",
    );
  }
  await db.prepare(`UPDATE inference_presentations SET status='consumed',updated_at=?
    WHERE idempotency_key=? AND request_hash=? AND source=? AND status='ready'`)
    .bind(nowIso(),idempotencyKey,identity.requestHash,identity.source).run();
}

export async function failInferenceReplay(
  db: D1Database,
  idempotencyKey: string,
  error: string,
  upstreamStatus: number | undefined,
  identity: InferenceReplayIdentity,
): Promise<void> {
  const boundedError = error.slice(0, 300);
  let updated: { idempotency_key: string } | null;
  try {
    updated = await db.prepare(`UPDATE inference_idempotency SET status='attention_required',
      upstream_status=COALESCE(?,upstream_status),last_error=?,updated_at=?
      WHERE idempotency_key=? AND request_hash=? AND source=? AND status IN ('calling','responded')
      RETURNING idempotency_key`)
      .bind(upstreamStatus ?? null, boundedError, nowIso(), idempotencyKey, identity.requestHash,identity.source)
      .first<{ idempotency_key: string }>();
  } catch {
    throw new InferenceReplayTransitionError("inference_fail_update_unknown");
  }
  if (!updated) {
    await resolveZeroRowTransition(
      db,
      idempotencyKey,
      identity,
      (row) => row.status === "attention_required"
        && row.last_error === boundedError
        && (upstreamStatus === undefined || row.upstream_status === upstreamStatus),
      "inference_fail_transition_rejected",
    );
  }
  await db.prepare(`UPDATE inference_presentations SET status='attention_required',updated_at=?
    WHERE idempotency_key=? AND request_hash=? AND source=? AND status='ready'`)
    .bind(nowIso(),idempotencyKey,identity.requestHash,identity.source).run();
}
