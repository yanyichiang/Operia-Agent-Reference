# Operia Telegram Experience-First Return — Implementation Spec

Date: 2026-07-21  
Status: approved for local implementation; production rollout requires a separate gate  
Branch: `<BRANCH>`  
Scope owner: Telegram ingress, scheduling, durable inference orchestration and delivery  

## Problem

The current Telegram webhook acknowledges the update and then runs the eight-second quiet window, the complete Opus request, interaction continuation and delivery persistence inside HTTP `ctx.waitUntil()`.

Cloudflare permits HTTP `waitUntil()` work to continue for only 30 seconds after the response finishes. Production canaries on the current paired release all crossed that boundary. The original invocation was cancelled while the durable run still held a 120-second lease, so the Queue fallback and five-second active-chat rechecks could not recover it until the lease expired.

Four bounded production samples on the current release required a second inference attempt. Last-ingress to first Telegram accepted was 166.352, 166.894, 212.047 and 193.979 seconds even though ordinary Opus calls completed in 15.787–18.622 seconds. A cache-hit sample still took 166.894 seconds. The reaction/tool sample showed the same cancellation between its first model round and interaction recovery.

There are two additional experience costs after final content exists:

- sequential outbox persistence performs multiple D1 round trips per bubble;
- normal first-bubble delivery waits for a new Queue invocation, adding 5.241–8.515 seconds before the first visible reply. Six to eleven bubbles then take 22.878–36.412 seconds to finish.

## Goals

1. Every accepted Telegram update is durably represented by exactly one inbox row and is eventually covered by exactly one inference batch or an explicit terminal outcome.
2. Full inference and interaction continuation run only in a Queue consumer or another execution context whose lifetime is suitable for the work. HTTP `waitUntil()` must not own correctness-critical inference or delivery.
3. A single message starts quickly while a burst of consecutive messages can still be grouped naturally.
4. Once final visible content is durable, the first Telegram bubble is attempted in the same Queue invocation rather than waiting for another normal Queue wakeup.
5. Existing paid-call idempotency, same-chat inference serialization, blank-line bubble formatting, response-batch FIFO and unknown-side-effect safety remain intact.

## Non-goals

- No new Worker, Queue, Durable Object, Workflow or Provider.
- No streaming draft messages and no repeated edit-in-place response UI.
- No concurrent Opus calls for the same chat.
- No blind replay of Memory `calling/responded` or Telegram `sending` outcomes.
- No prompt, cache-anchor, model-routing, secret, Access or route change in this workstream.

## Contract A — Webhook is receipt and handoff only

For natural text, voice, sticker and inbound reaction updates, the webhook must:

1. validate the owner/chat boundary;
2. durably insert the inbox row using the existing Telegram update/message idempotency keys;
3. enqueue `tg_process` and await the enqueue result before returning `200`;
4. optionally schedule a best-effort Telegram `typing` action because it is non-critical and safely repeatable;
5. never call `processTgChat()`, Opus, Agent continuation or final delivery from HTTP `ctx.waitUntil()`.

Commands and callbacks keep their existing immediate semantics.

## Contract B — Adaptive trailing aggregation

Telegram Bot API does not expose the owner's native typing state. The safe approximation is a received-message trailing window.

Configuration:

- quiet gap: `TG_DEBOUNCE_SECONDS=1.5`;
- hard burst cap: `TG_DEBOUNCE_MAX_SECONDS=5`;
- invalid values fall back to those defaults;
- quiet gap is bounded to 10 seconds and hard cap to 30 seconds, with hard cap never below quiet gap.

For the oldest and newest unprocessed inbox timestamps in one chat:

```text
quiet_deadline = newest_message_at + quiet_gap
hard_deadline  = oldest_message_at + hard_cap
start_at       = min(quiet_deadline, hard_deadline)
```

Each newly received message therefore extends the batch by 1.5 seconds, but the first message can never wait more than five seconds. Queue delays use whole seconds; when the remaining quiet period is below one second, the Queue consumer may perform one bounded sub-second wait and then re-read D1 before claiming. It must not busy-loop.

If a later message arrives after an inference run has already been claimed, it remains unprocessed in the inbox. The terminal transition of the active run immediately kicks the next batch. It is never silently appended to an already-paid request and never lost behind response delivery.

## Contract C — Queue-owned inference

`tg_process`, `tg_inference_resume`, interaction continuation and recovery remain on the existing `<TG_QUEUE>` Queue. The TG Queue consumer has a 15-minute wall-clock limit and may call Memory through the existing Service Binding.

The current D1 run CAS, Memory idempotency key and same-chat active-run guard remain the concurrency authority. Duplicate Queue messages are expected and must remain harmless.

The 120-second inference lease remains only a last-resort sweeper. A run with a durable final package may be resumed through an idempotent delivery-staging checkpoint without waiting for the generic lease. A bounded recovery message must be scheduled before delivery staging so a crash between final durability and delivery-batch durability cannot become a user-visible two-minute pause.

## Contract D — Batched durable outbox and first-bubble fast delivery

For one final response package:

1. validate that the final has visible content and split it with the existing blank-line/4096-unit rules;
2. precompute stable intent keys and candidate outbox IDs;
3. upsert all text/media outbox rows in one D1 `batch()` call, returning the canonical IDs for both first execution and partial-recovery execution;
4. persist one `tg_chat_delivery_batches` row containing the canonical ordered IDs;
5. transition inference to `delivery_pending`, enqueue archive and kick pending inbox;
6. synchronously invoke the existing delivery-lane claimant in the same Queue invocation so the first eligible bubble is attempted immediately;
7. pre-enqueue a delayed recovery message before the Telegram side effect; enqueue the remaining tail after the cursor advances.

The delivery batch and each outbox intent remain independently idempotent. A concurrent recovery may duplicate staging and Queue messages, but the delivery-batch lease, cursor and outbox state must prevent duplicate Telegram side effects.

An older nonterminal batch retains FIFO priority. An unknown send outcome becomes `attention_required` and is never resent; the durable tail may continue under the existing contract.

## Contract E — Experience telemetry

Bounded telemetry must expose timestamps or durations for:

- last ingress to inference start;
- Memory request start to durable response;
- final package durable to delivery batch durable;
- delivery batch durable to first send attempt and first accepted result;
- first accepted to last terminal bubble;
- invocation trigger (`queue`, `recovery`, never correctness-critical `http_wait_until`);
- run attempt and recovery reason.

Telemetry must not contain message text, model output, prompts, provider tokens, Telegram token, secrets or raw request/response bodies.

## Experience SLOs

- Single-message last ingress to inference start: p95 ≤ 3 seconds.
- Burst first ingress to inference start: no later than the five-second hard cap plus Queue dispatch tolerance.
- Final package durable to first Telegram accepted: p95 ≤ 2 seconds in an unblocked lane.
- Normal message: one inference attempt.
- Crash after final durability: recovery begins within five seconds without another paid call.
- Every accepted inbox ID is attributable to a batch or explicit terminal state.

## Offline regression matrix

The implementation is not complete until local tests cover:

1. HTTP response completes immediately and a simulated cancellation of all HTTP `waitUntil()` tasks cannot cancel inference because inference was never placed there.
2. One message starts after the 1.5-second quiet target; invalid configuration uses safe defaults.
3. Two or more messages reset the trailing window; continuous messages stop extending at the five-second hard cap.
4. A message received after active-run claim remains pending and is kicked immediately after inference releases, without same-chat concurrent Opus.
5. A normal, cache-hit-shaped response completes in one attempt.
6. Six to fourteen bubbles are durably staged in bounded D1 calls before the first Telegram side effect.
7. The first eligible bubble is delivered by the same Queue invocation; Queue remains the recovery/tail path.
8. Crash after partial outbox staging resumes within five seconds and does not duplicate a sent or unknown bubble.
9. Reaction plus natural-language continuation completes without an HTTP lifetime dependency and does not repeat the reaction.
10. Older delivery batch FIFO, partial unknown, empty final, reply target, voice/media intent and pending conversation archive contracts remain green.
11. Correlation telemetry contains bounded identifiers and durations only.

Required verification:

- TypeScript typecheck;
- TG command/webhook contract;
- TG window/cache contract;
- TG interactions;
- Message Reliability inference/delivery recovery verifier;
- Agent/outbox verifier;
- full `npm run verify`;
- TG Wrangler dry-run.

No local test may contact Telegram, Memory production, a model Provider or paid API.

## Rollout and rollback

This design is expected to be TG-only and schema-neutral. Production remains unchanged until a separate approval after local review.

Before rollout:

- rebase/cherry-pick onto the current canonical release without taking prompt edits from another workstream;
- confirm no active inference, continuation, delivery batch or outbox;
- record the current TG version and verify Queue binding/consumer configuration;
- run full verification and Wrangler dry-run.

Canary uses owner-authored natural messages only: one short message, a three-message burst, a reaction requiring a natural-language continuation and a multi-bubble response. Acceptance is based on the experience SLO timestamps, not merely terminal database status.

Rollback restores only the prior TG Worker version. Existing additive delivery-lane schema remains in place. Memory, secrets, Access, routes and Providers are unchanged.

## Local implementation evidence

Implemented on `<BRANCH>` without schema, prompt, Provider or production changes.

- Webhook handoff fails closed if the existing Queue binding is unavailable; HTTP `waitUntil()` contains only best-effort `typing`.
- `src/tg/scheduling.ts` is the single implementation of the 1.5-second quiet target and five-second hard cap.
- Final text and media intents use one D1 batch before the ordered delivery batch is published.
- A five-second delivery-staging recovery is recorded before staging starts, and becomes claimable independently of the 120-second generic lease.
- The originating Queue invocation calls the existing delivery claimant directly for the first eligible bubble.
- Bounded `inference.batch`, `delivery.staging` and `outbox.delivery` events expose the experience segments without message or prompt content.

Local gates completed on 2026-07-21:

- `npm run typecheck`
- `node scripts/verify-tg-commands.mjs`
- `node scripts/verify-tg-interactions.mjs`
- `node scripts/verify-tg-inference-recovery.mjs`
- `node scripts/verify-tg-experience-latency.mjs`
- `npm run verify`
- `npx wrangler deploy --config wrangler.tgbot.toml --dry-run --outdir <temporary-directory>`

All passed. No Telegram message, model/Provider call, remote D1 write or deployment was performed.

## Production rollout

The owner authorized deployment after a fresh full verification pass on 2026-07-21.

- Canonical `<BRANCH>` fast-forwarded from <COMMIT> to the verified code commit <COMMIT> and was pushed to the private remote with divergence `0/0`.
- Pre-deploy `npm run verify` and Telegram Wrangler dry-run passed. Remote D1 had no pending migration. Unprocessed inbox, active inference, live delivery batch, nonterminal continuation and live outbox were all zero.
- Only `<TG_SERVICE>` was deployed. The previous rollback version is `<UUID>`; the new version is `<UUID>` at 100% traffic.
- The existing `<TG_QUEUE>` producer/consumer, D1, Memory/Agent/Calendar/Health Service Bindings, Vectorize and AI bindings remained present.
- Post-deploy checks returned `/app=200`, anonymous Mini App bootstrap `401`, protected admin/health `302` and unsigned webhook `401`. Remote migrations remained empty and all five live Telegram state counts remained zero.
- Memory was not deployed. No remote D1 data was mutated, no Telegram message or model/Provider call was generated, and no secret, Access policy, route or other Worker changed.

The remaining production acceptance is an owner-authored natural-message canary. It must be evaluated with the new bounded timing events and may not be replaced by an automated paid smoke test.
