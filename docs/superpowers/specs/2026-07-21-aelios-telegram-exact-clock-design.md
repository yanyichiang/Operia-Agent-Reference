# Operia Prompt vNext and Telegram Exact Clock Design

## Goal

Give every Telegram-originated model request the exact owner-local current time without enabling the
larger ambient-context feature or invalidating either prompt-cache tier.

Apply the owner-returned Prompt draft by mapping stable behavior contracts back to deterministic code
blocks. Owner persona and precious-history edits remain Memory-owned data changes and are staged as a
separate rollout input; they must not be duplicated in source code or written to production as a side
effect of a Worker deploy.

## Confirmed cause

Telegram does not supply a model-visible wall clock. The only existing clock was produced by
`buildTelegramAmbientContext`, and production keeps `TG_AMBIENT_CONTEXT_ENABLED=false`. Therefore an
ordinary Telegram request contains no authoritative current time unless a client happens to write one
into its own prompt.

## Contract

- Memory computes a clock anchor only when the authenticated request source is `telegram`.
- The clock uses `<YOUR_TIMEZONE>`, preserves the request-start instant, and displays local time to the
  second plus the exact UTC ISO instant. It performs no rounding or bucketing.
- The assembler receives the computed value as explicit input; it never reads the wall clock itself.
- The clock is part of `client_volatile_context`, immediately before the current user message and after
  every one-hour and five-minute cache breakpoint.
- The one-hour `client_system_hash`, persona prefix, tool prefix, five-minute conversation prefix and
  cache-breakpoint count remain unchanged when the clock advances.
- Calendar, weather, tasks and other ambient sources stay disabled. No model call, Telegram delivery,
  production write or provider change is part of this implementation.

## Prompt mapping

- `<STATIC_RULES>` remains the existing Operia proxy-static block.
- `assistant_persona` remains the single active Memory persona record. The returned draft changes this
  record, but applying it requires an explicit owner data write and independent rollback snapshot.
- `shared_precious_history` remains the Memory precious layer. Two wording corrections are staged for
  the same controlled data rollout; source code does not duplicate them.
- `output_style` replaces the smaller `preset_lite` text.
- Relationship, Memory, tool/action, complete-reply and safety/truthfulness sections become the
  versioned `<BEHAVIOR_CONTRACTS>` stable system block.
- `telegram_channel` extends the existing Telegram client system prompt, preserving its stable hash
  semantics and keeping interaction message IDs outside the stable prefix.

## Acceptance

1. Two request times inside one five-minute window produce different exact clock values.
2. The local value includes seconds and the UTC value preserves the original instant without rounding.
3. Telegram assembly includes the exact clock inside `client_volatile_context`; non-Telegram assembly
   can omit it.
4. Changing the clock does not change `client_system_hash`, system blocks or any cache breakpoint.
5. The Anthropic tail breakpoint remains five minutes and the total explicit breakpoint budget stays
   within the existing four-marker limit.
6. Existing volatile time extraction, prompt assembly, Telegram window/recovery and repository verify
   suites remain green.
7. Stable code contracts from the owner draft are present exactly once; persona and precious content
   continue to come only from Memory data.

## Rollback

Revert the versioned behavior-contract, Telegram-channel and exact-clock changes. If the later owner data
rollout has occurred, restore the captured persona/precious snapshot separately. The existing disabled
ambient-context behavior remains otherwise untouched.

## Production rollout

The owner authorized a direct paired rollout on 2026-07-21 after correcting the original five-minute
bucket proposal to exact per-turn time.

- Canonical integrated the reviewed branch as <COMMIT>, <COMMIT> and <COMMIT> on top of <COMMIT>.
- `npm run verify`, the 191-case assembler suite, Telegram window/recovery/latency checks, and both
  Worker Wrangler dry-runs passed on canonical.
- Remote D1 had no pending migrations. Before and after rollout, unprocessed inbox, active inference,
  live delivery batches, nonterminal continuations and live outbox were all zero.
- Memory deployed first as `<UUID>`, then Telegram as
  `<UUID>`; both received 100% traffic.
- Entry checks returned `/app=200`, anonymous Mini App bootstrap `401`, protected TG admin and Memory
  health `302`, and unsigned webhook `401`.
- Rollback points are Memory `<UUID>` and Telegram
  `<UUID>`. A paired rollback restores Telegram before Memory.
- No owner message, Telegram delivery, model/Provider call, paid smoke, secret, Access policy, route or
  remote D1 data was changed by acceptance. Persona/precious owner-data edits remain separate and
  unapplied.

## Owner-data rollout

The owner subsequently authorized writing the edited private prompt data. A gitignored rollback
snapshot captured the single active persona and the two target precious rows before mutation. The
write was bound to the exact row IDs and old-state markers. Cloudflare returned a D1 storage timeout,
so the operation was treated as outcome-unknown and was not replayed. Immediate readback proved that
all three updates had committed exactly: the persona and both precious contents byte-match the owner
draft, and active persona cardinality remains one. No other Memory row was changed. No Worker deploy,
Telegram delivery, model/Provider call, embedding call, secret, Access policy or route change was part
of the data rollout.
