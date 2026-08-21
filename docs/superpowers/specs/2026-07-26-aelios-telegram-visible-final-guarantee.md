# Operia Telegram interaction visible-final guarantee

Date: 2026-07-26 (<YOUR_TIMEZONE>)
Status: local implementation candidate; production unchanged

## Problem

Private Telegram turns can finish with an interaction tool and no visible text. The current trusted final-only prompt covers the normal interaction continuation, but an invalid interaction enters a separate `:repair` call without that contract. The provider can then return HTTP 200, `stop`, and empty content. The reaction tool schema also describes an allowed emoji without exposing the runtime allowlist, so schema-valid model output can still fail runtime validation.

## Contract

1. One shared immutable reaction emoji list owns both the model JSON schema and Telegram runtime validation.
2. Every private terminal reaction/reply round uses one trusted Memory finalization lane. Agent Rooms keep their existing separate contract.
3. The trusted lane is accepted only over the internal Memory Service Binding with the Telegram key/profile/channel/recipient envelope, a private recipient, continuation mode, and a terminal interaction-only tool suffix.
4. Memory replaces ordinary tools with one internal output carrier, forces that carrier, and unwraps it before the response leaves Memory. The carrier is never executable by Telegram.
5. A valid non-empty carrier payload becomes the visible final. Direct visible provider text remains compatible. Empty, malformed, filtered-empty, or otherwise invalid final output becomes one static visible fallback with bounded disposition metadata. There is no additional model call or retry.
6. Existing inference idempotency owns the transformed request and finalized response. Unknown provider or Telegram side effects remain terminal and are never blindly replayed.
7. Static fallback is a Telegram presentation outcome, not an Opus assistant message. Memory records its usage/disposition but does not archive it as assistant text or enqueue long-term maintenance.
8. A mixed invalid interaction/tool round fails closed to one local visible status without a repair inference or any tool side effect.

## Non-goals

- No new Worker, Queue, schema, migration, Provider, route, secret, or production action.
- No change to Agent Room tool policy, ordinary text tool continuation, image policy, debounce, delivery ordering, or Telegram unknown-delivery behavior.
- No model-generated repair call after an invalid interaction.

## Acceptance

- Normal private reaction/reply, invalid reaction repair, and post-tool terminal interaction all enter the trusted final lane.
- The reaction schema enum and runtime set come from the same module.
- Structured final, direct visible final, null, whitespace, malformed carrier, filtered-empty, and length-shaped responses finalize deterministically.
- Internal carrier tool calls cannot reach TG continuation or outbox.
- Exactly one final inference is allowed after a tool-only interaction; fallback uses zero additional inference.
- Request hashing, replay, correlation, cache anchors, ordinary tools, rooms, multi-bubble delivery, and unknown-outcome semantics do not regress.

## Rollback

Revert the candidate commit before integration. If later deployed, roll back TG first and Memory second to their paired pre-rollout versions; never roll back only Memory while a TG build that emits the trusted header remains active.
