# Operia Message Latency Lock Split — Implementation Spec

Date: 2026-07-20  
Owner domains: Memory inference transport; Telegram channel orchestration and delivery  
Implementation lead: Message Reliability workstream

## Problem

Production evidence shows two remaining latency paths after the reliability P0 rollout:

1. Memory can durably complete an idempotent Opus response while the TG Worker loses the Service Binding return. The paid response is already safe in `inference_idempotency`, but the Telegram run waits for the 120-second inference lease before it can reclaim the run.
2. A final response can be fully durable while its blank-line bubbles are still being sent. The run remains `delivering`, so the same-chat inference lock blocks later inbox rows until the final bubble finishes.

The fix must reduce those waits without issuing a second paid call, allowing same-chat concurrent Opus calls, replaying an unknown Telegram side effect, reordering response batches, or moving inference ownership out of Memory.

## Invariants

- Memory remains the owner of provider calls and `inference_idempotency`.
- Telegram remains the owner of inbox, run, continuation, outbox and delivery state.
- The same chat has at most one active inference or continuation.
- An idempotency row in `calling` or `responded` is observed, never blindly replayed.
- A completed Memory response may be copied into the TG checkpoint exactly once through a D1 compare-and-set transition.
- Every final Telegram payload is durable before the inference lock is released.
- Delivery batches for one chat are FIFO. A later response batch cannot overtake an earlier batch.
- An outbox row in an unknown delivery state is never resent. Later durable tail items may continue.
- Telemetry contains bounded keys, states and durations only; no message body, prompt, provider token or secret.

## Contract A — Memory completion recovery

### Queue event

After `completeInferenceReplay` commits a non-streaming idempotent response, Memory best-effort enqueues:

```ts
{ type: "tg_inference_ready", idempotencyKey: string }
```

The event does not carry response content. The TG consumer accepts only the exact root Telegram key shape and reads the response from the canonical D1 row.

### Watchdog

Before TG awaits the Memory Service Binding, it schedules a bounded watchdog for the durable run. The watchdog reads, but never invokes, the Memory inference ledger.

- `completed` with a valid response: compare-and-set the empty TG checkpoint from `calling` to recoverable `ready`, clear its lease, and enqueue the existing inference resume path.
- `calling`, `responded` or missing: reschedule bounded probes. The target schedule is approximately 20, 35, 55 and 90 seconds from call start.
- terminal Memory state or a still-ambiguous state at the final bound: mark the TG run `attention_required`, send the existing static non-model notice once, and release/kick the chat.
- an original Service Binding return that loses the compare-and-set race stops. It cannot run continuation or delivery a second time.

The 120-second inference lease remains a last-resort crash sweeper, not the normal completed-response recovery mechanism.

## Contract B — inference and delivery separation

### Durable delivery batch

Add `tg_chat_delivery_batches` with one row per final inference package:

- `batch_key`, `chat_id`, `outbox_ids_json`, optional voice-once outbox ID;
- `pending | active | completed | attention_required`;
- `next_index`, `had_attention`, lease and timestamps.

Add nullable `delivery_batch_key` to `tg_agent_outbox`. Scheduled generic outbox recovery excludes lane-owned rows so it cannot bypass FIFO delivery.

### State transition

After final validation:

1. persist every text/media outbox row;
2. persist the delivery-batch row;
3. transition the inference run to `delivery_pending`, which is terminal for same-chat inference serialization;
4. enqueue conversation archive, delivery resume and an immediate pending-chat kick.

The next Telegram inference includes the prior `final_package_json` while archive is pending, so releasing the inference lock does not lose conversational context.

### FIFO delivery lane

A delivery consumer can claim a batch only when no older `pending` or `active` batch exists for the chat. It advances the D1 `next_index` after each terminal outbox result and schedules a watchdog before every Telegram side effect. Completion changes the run from `delivery_pending` to `completed`; an unknown outbox result yields `attention_required` only after the durable tail has been processed.

The minute recovery sweep re-enqueues due delivery batches. Duplicate queue messages are harmless because both the batch cursor and each outbox intent are idempotent.

## Offline acceptance

- Memory completes, TG caller disappears before receiving it: ready event or first watchdog restores the paid response; provider-call/usage count stays one.
- Original return and ready event race: only one path acquires the TG response checkpoint and only one final delivery batch is created.
- Memory remains `calling`: bounded probes do not call the provider; final attention releases the chat.
- A 14-bubble reply has all rows durable before its first send.
- A new inbox row after bubble 1 reaches the next Opus inference before bubble 14 completes.
- The second response batch cannot send until the first batch reaches a terminal delivery state.
- A partial unknown bubble is not replayed; the durable tail still advances and the next batch remains ordered.
- Pending conversation archive does not remove the previous final answer from the next inference context.
- Reaction/reply continuation and empty-final terminal paths still kick pending inbox.
- Full typecheck, Message Reliability verifier, repository verify and Memory/TG Wrangler dry-runs pass without a Provider call.

## Rollout and rollback

This implementation is local-only until a separate production gate. Rollout requires an additive D1 migration, then Memory before TG because Memory produces the ready event and TG consumes it. Rollback may return TG to the prior version while leaving the additive table/column in place; Memory event messages become harmless unknown/no-op only after the queue is drained or the paired rollback order is observed.
