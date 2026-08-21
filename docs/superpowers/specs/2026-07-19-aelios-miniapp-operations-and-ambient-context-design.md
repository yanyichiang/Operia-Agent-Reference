# Operia Mini App Operations Cockpit and Ambient Context

Date: 2026-07-19  
Status: implementation contract  
Canonical branch: `<BRANCH>`

## Goal

Turn the owner-only Telegram Mini App into a bounded operations cockpit while making Opus naturally aware of current time and connected owner projections without damaging prompt-cache reuse.

This change must reuse the existing `<TG_SERVICE>`, `<AGENT_SERVICE>`, `<MEMORY_SERVICE>`, Calendar, Health, and MCP Gateway ownership boundaries. It must not create another Worker, another credential owner, or another writable source of truth.

## Decision: ambient summary plus tools

Neither full per-turn injection nor tool-only access is sufficient:

- Tool-only access preserves the cache, but Opus cannot naturally notice a nearby appointment or understand the current temporal setting unless it first decides to call a tool.
- Injecting full Calendar, weather, task, or Home Assistant payloads on every turn is noisy, expensive, stale-prone, and risks turning a projection into a second source of truth.
- Therefore Operia uses a small ambient snapshot for ordinary awareness and owner tools for exact reads, refreshes, wider windows, and every mutation.

The ambient snapshot is a separate system message beginning with `[动态上下文]`. The Prompt Assembler already routes this section into `client_volatile_context`, immediately before the current user message and after every Anthropic cache breakpoint. It never changes the stable persona, tools, client system hash, or rolling-history breakpoint.

## Ambient snapshot contract

The snapshot is deterministic in field order and bounded to 2 KiB. It may contain only:

1. Local date, time, and timezone.
2. Calendar owner status, observation/freshness timestamps, current event, next event, and remaining events today.
3. Future task, weather, and Home Assistant summaries only after their authoritative read-only projections exist.
4. Source owner and freshness metadata for every included fact.

It must not contain:

- full calendars or event bodies;
- raw health samples or unsolicited health measurements;
- Home Assistant entity dumps, service data, or controls;
- task bodies, secrets, provider tokens, URLs containing credentials, or raw tool results;
- model-generated summaries that would add another paid inference before each turn.

Missing or stale sources are identified as unavailable and must never be represented as current facts or numeric zeroes. Opus may use the snapshot naturally when relevant, but should not recite it by default. Exact questions and every action continue through the appropriate owner tool.

## Operations cockpit ownership

The Mini App is a protected presentation and request surface, not an owner:

| Surface | Canonical owner | Mini App behavior |
| --- | --- | --- |
| Tasks | Agent DO | Read bounded progress; request pause, resume, or stop |
| Approval tickets | Agent approval workflow | Approve or reject one exact ticket |
| MCP Elicitation | Agent DO / MCP session | Accept, decline, cancel, or open the canonical form |
| MCP registry | MCP Gateway | Display owner projection; request one tool toggle using owner ETag/CAS |
| Skills | Agent | Display installed status and revision; no duplicate TG toggle owner |
| Heartbeat | Agent | Read owner projection only |
| TG outbox/continuations | TG durable ledgers | Display bounded state; unknown delivery is never blindly retried |
| Usage/cache | Memory/TG usage ledger | Display bounded telemetry without prompts or provider credentials |

## Mutation security contract

Every Mini App mutation requires all of the following:

1. Telegram `initData` verified against the configured owner ID.
2. A short-lived HttpOnly, Secure, SameSite=Strict session.
3. Same-origin validation and the session-bound Mini App CSRF token.
4. An explicit, bounded action body. There is no `Approve All` or generic arbitrary owner request.
5. Agent approval bearer only on the TG server side; the WebView never receives it.
6. Existing Agent scope checks binding `ownerId`, `chatId`, `taskId`, `serviceId`, ticket expiry, and ticket state.
7. MCP tool changes include the Gateway owner ETag in `If-Match`; stale revisions fail closed.
8. Audit and replay behavior stays in the canonical owner. TG does not synthesize a successful result.

Approval rows expose `taskId`, provider/tool, risk, expiry, policy version, and `argsHash`, but not raw arguments. Elicitation forms remain on the existing Agent workbench. Unknown Telegram delivery remains `attention_required` and is not automatically resent from the Mini App.

## Phase 1

- Add an Agent service operations projection for the configured Telegram owner.
- Add owner-only Mini App actions for task pause/resume/stop, exact approval approve/reject, exact MCP Elicitation decisions, and MCP tool CAS toggles.
- Add bounded TG usage/cache, outbox, continuation, and attention projections.
- Keep Skill status read-only until an Agent-owned revision/CAS mutation contract is explicitly exposed.
- Add cache-safe Calendar ambient context behind a rollout flag. Weather, task, and HA slots remain unavailable until their real read-only owners exist.

## Rollout

Code lands with `TG_MINIAPP_OPERATIONS_ENABLED=false` and `TG_AMBIENT_CONTEXT_ENABLED=false` in the canonical production config. Local preview and verification may exercise the complete surface without production writes or inference. Enabling either flag and deploying requires a separate owner-confirmed canary.

## Acceptance

- Changing ambient time or Calendar data does not change `client_system_hash` or any cache breakpoint position.
- Opening or refreshing Mini App does not call a model or trigger Heartbeat.
- Mini App cannot mutate without valid owner session, same origin, CSRF, and enabled rollout flag.
- Approval and Elicitation decisions remain one-ticket operations and preserve expiry/replay behavior.
- MCP toggles reject missing or stale ETags.
- No Provider token or raw prompt/health/tool payload appears in Mini App JSON.
- Unknown delivery is shown as attention and never represented as exactly-once success.
- Agent and TG dry-runs, typecheck, assembler verification, and Mini App verification pass.
