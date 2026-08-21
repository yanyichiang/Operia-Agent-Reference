---
title: Operia Telegram Tool Envelope Failure P0
date: 2026-07-26
status: deployed-observing
owner: Message Reliability / Memory and Telegram
scope: ordinary non-streaming Telegram tool-envelope validation and terminal recovery
---

# Operia Telegram Tool Envelope Failure P0

## Symptom and evidence

Two natural private turns reached Memory and received HTTP 200 from the primary Provider, but the
ordinary first response failed canonical tool-envelope validation. Memory marked the inference replay
`attention_required` and returned 502. Telegram then retried the same idempotency key twice, received
authoritative 409 responses, and still waited until attempt three. Neither turn produced a business
outbox. Provider usage existed but was not written because tool parsing preceded every usage branch.

The bounded production shape proves Provider availability and excludes webhook, Queue, final-only
carrier, continuation, outbox and delivery failures. The two rejected envelopes were interaction-only
reactions whose emoji value was outside the runtime allowlist.

## Contract

1. Canonical tool parsing emits a closed parser code. Error text, tool name, arguments, response body
   and owner content never cross the boundary.
2. Every non-streaming Provider 200 that reaches tool parsing writes usage synchronously before Memory
   recovers or terminalizes the result. If usage persistence fails, the inference freezes and is not
   called again.
3. Ordinary Telegram reaction/reply schemas are Provider-strict and derive reaction values from the
   same immutable list as runtime validation.
4. Only an authenticated internal, non-room Telegram request whose entire rejected envelope contains
   reaction/reply calls may recover locally. Memory removes all invalid calls and returns either the
   already-visible sanitized text or one deterministic visible fallback. No interaction side effect
   or second inference occurs, and the fallback is not archived as model-authored Memory.
5. Unknown, malformed or mixed tool envelopes remain `attention_required`; they are never guessed,
   executed or converted into an ordinary answer.
6. Memory returns a typed bounded error for an unrecoverable tool parse. Telegram preserves only the
   allowlisted type/detail and terminalizes it on the first failure. An exact Memory replay 409 with
   `attention_required` also terminalizes immediately. `calling` and `responded` remain unknown and
   are never replayed; ordinary 409 validation/conflict errors are not reclassified.
7. Terminal handling releases the chat and wakes pending input. Its static notice describes an invalid
   result, not a false network or Provider outage.

## Acceptance

- invalid reaction emoji: one Provider call, usage recorded once, zero reaction send, one visible
  local response, zero continuation or retry;
- valid reaction/reply: existing interaction and visible-final behavior unchanged;
- malformed or mixed tool: one Provider call, usage recorded once, typed attention, zero second call;
- Memory 409 attention: no second/third wait; calling/responded: unknown fail-closed;
- parser code and telemetry contain no tool name, arguments, response text or secrets;
- ordinary text, room, image, tool continuation, cache wire, delivery and outbox regressions pass.

## Rollout and rollback

The source contract spans Memory and Telegram. Deploy Memory first and Telegram second only after the
full repository verification and both Worker dry-runs pass. Roll back Telegram first, then Memory.
No migration, route, Access, secret, Queue or Provider configuration change is required.

Production rollout completed under Owner authorization. Canonical commit <COMMIT> deployed Memory
`<UUID>` first and Telegram
`<UUID>` second, each at 100%. Immediate rollback restores Telegram
`<UUID>` first, then Memory
`<UUID>`.
