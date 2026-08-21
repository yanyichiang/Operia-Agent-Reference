# Operia Telegram Agent QA Room P0/P1 Implementation Spec

Date: 2026-07-22
Status: implementation-ready, local-only; production rollout requires a separate approval gate

## 1. Outcome

The Telegram supergroup is an owner-controlled Agent QA room, not a household-life memory room and not a customer-support channel. The owner directs communication with explicit Telegram names:

- `@OperiaBot diagnose ...` wakes Operia only.
- `@CodexBot inspect ...` wakes Codex only.
- Mentioning both lets both runtimes independently answer the owner.
- Replying to an agent's message targets that agent without repeating its name.
- Unmentioned conversation, ordinary reactions, media and unknown senders are silent and produce no model call.

Bot user ID is the authorization and routing key. First name and username are display labels checked against Telegram at enrollment; they are never authorization credentials.

## 2. Current architecture and invariants

- Operia remains the existing `<TG_SERVICE>` Cloudflare Worker using the existing D1, Queue, Memory and Agent service bindings.
- Codex remains the local <LOCAL_CODEX_BRIDGE> runtime. No second Operia Agent, Memory owner, provider layer or Telegram Worker is introduced.
- The room panel is `https://tgbot.example.com/admin#rooms`; no new hostname is required for P0.
- Memory remains the sole source for stable persona, identity and long-term memory. The QA room does not create a Memory conversation or save message正文. Its only post-delivery conversational window is the Telegram-owned `tg_agent_room_turns` table: at most four completed turns, two-hour TTL, exact room/thread scope. Content-bearing reliability checkpoints may exist before confirmed delivery under the bounded rules in section 7; they are not conversation memory.
- Telegram administrator status is operational evidence only. It never grants Operia Owner authority.
- Private Telegram chat behavior remains unchanged.

## 3. Principal and state model

An inbound principal is:

`householdId + roomId + chatId + threadKey + actorUserId + actorKind + targetBotUserId + role + membershipRevision + correlationId`

P0 roles are `Owner`, `Agent`, `Unknown`, `Suspended`, and `Removed`. The future household roles `Adult`, `Member`, `Child`, and `Guest` remain reserved but are not enabled in this QA room.

Room states are `active`, `suspended`, and `removed`. Wake states are `mention_or_reply` and `off`. Agent states are `active`, `suspended`, and `removed`. Every mutation uses compare-and-swap against `revision`; membership changes also advance `membershipRevision`.

The P0 topic policy is one exact registered thread. Missing, `null`, numeric/string `0`, and Telegram's numeric/string General Topic ID `1` normalize to the built-in key `general`; only a safe integer `message_thread_id >= 2` normalizes to `topic:<id>`. The webhook compares only normalized keys. It never treats every non-null thread as “not General”, and it never enables all topics implicitly.

## 4. Enrollment and panel contract

### Bind room

Owner enters `chatId`, their Telegram `userId`, and optionally one `message_thread_id` (blank/0/1 means General; explicit topics start at 2). The server calls:

1. `getChat(chatId)` and requires `group` or `supergroup`.
2. `getChatMember(chatId, ownerUserId)` and requires creator or administrator.
3. `getMe()` and `getChatMember(chatId, localBotId)` and requires the local Operia bot to be an administrator.

The server creates one room and automatically registers the current Worker bot as the `operia_worker` transport. No bot token is stored in D1.

### Add future agent

Owner first adds the bot to Telegram, then enters Bot Name, numeric Bot ID and runtime kind. The server calls `getChatMember` and requires:

- the returned stable user ID exactly equals the submitted Bot ID;
- `is_bot=true`;
- current membership is active;
- submitted name exactly matches live `first_name`, `username`, or `@username`.

The registry stores both the stable ID and current display labels. Renaming a bot requires re-verification but does not change authorization identity. Adding a row never provisions Telegram membership and never accepts or stores a token.

## 5. Inbound routing

P0 accepts `message` updates only when all checks pass:

1. Webhook secret is valid.
2. `chat.type` is `group` or `supergroup` and `chat.id` maps to one active room.
3. Actor is the exact Operia Owner for owner-originated turns.
4. The normalized thread key exactly matches the room's registered `allowed_thread_key`.
5. The local runtime is targeted by either:
   - a `mention` entity whose username equals the registered username;
   - a `text_mention` entity whose user ID equals the registered Bot ID;
   - a `bot_command` entity suffixed with that username; or
   - `reply_to_message.from.id` equal to the registered Bot ID.
6. The target agent and its membership revision are active.

Entity offsets are interpreted as JavaScript UTF-16 offsets, matching Telegram. Substring search outside Telegram entities is not authoritative. In group scope only no-argument `/status@TargetBot` is exposed at P0. It returns a deterministic room-local projection of room/thread/wake/registered-agent/loop state. `progress`, `blocks`, `usage`, `tasks`, `health` and every other argument are rejected before any settings, audit, inbox or conversation mutation; the room path never enters the private `handleStatusHub` or calls Agent/Memory services.

Group reactions, photos, documents, voice, stickers, edits, joins, channel posts, unknown users and unregistered bots return HTTP 200 before inbox insertion. They create no Queue job, Memory request, provider call or content-bearing telemetry.

## 6. Bot-to-bot communication

Telegram's current Bot-to-Bot Communication Mode permits bots in the same group to receive bot-authored messages through the normal update flow. A command mention such as `/qa@TargetBot` or a direct reply is the guaranteed targeting form when at least one side has the mode enabled. A receiving bot with the mode enabled and sufficient group visibility can also receive ordinary bot messages, after which this application still requires an explicit mention/reply target before calling a model.

P0 therefore uses Telegram as both visible transcript and primary transport:

- Every participating bot must be registered by stable Bot ID in the room.
- Bot-to-Bot Communication Mode is a separate BotFather approval gate; the application never toggles it automatically.
- A bot actor must be an active agent in the same room and must explicitly target the receiving Bot ID by command mention, mention entity, text mention or direct reply.
- Agent input is speaker-labelled after the stable cache breakpoint and never gains Owner authority.
- Operia replies directly to the triggering agent message. A further handoff requires an explicit target again.
- The Worker accepts at most five agent-origin turns per room in two minutes. Duplicate updates remain idempotent. The <LOCAL_CODEX_BRIDGE> adapter must enforce the same bound before production enablement.

P0 does not create a second handoff transport or persist a plaintext handoff copy. Native Telegram B2B is the only visible transport. If a future degraded-delivery fallback is ever approved, it requires a new threat review and may persist only content-free locator/hash/correlation metadata by default.

## 7. Session, queue and delivery

Owner turns retain existing D1 inbox uniqueness, debounce, FIFO, inference idempotency and outbox semantics. The room key is `chatId + normalized threadKey`; a mismatched topic is dropped before insertion. Correlation is derived from the stable batch key. Unknown provider or Telegram delivery outcomes remain terminal/attention states and are not automatically replayed. Room requests may create only bounded Telegram-presentation continuations for `react_to_message` and `reply_to_message`; Memory overwrites the tool surface to exactly those two schemas and rejects every other tool or continuation.

The following content-bearing rows are reliability checkpoints, not transcript owners:

- TG `tg_inbox`, `tg_chat_inference_runs` (`request_json`, `user_text`, `prior_state_json`, first/final response), and pending outbox payloads are retained until Telegram delivery has a known successful outcome.
- Memory `inference_idempotency.response_json` is required to recover an already-paid provider response without issuing a second call. QA-room claims receive a two-hour expiry instead of the normal seven-day window and are removed by the existing retention pass.
- Only after the TG run is `completed` does the archive job append one bounded room turn, redact the processed inbox payload, clear the run's content fields, and redact `sent` outbox payloads. IDs, hashes, state, timing, attempt counts, Telegram message IDs and content-free correlations remain for audit.
- `calling`, `responded`, retry, `attention_required`, pending and unknown-delivery states are never redacted merely because time passed in the TG pipeline. Their recovery evidence remains intact and they are never blindly replayed.

## 8. Memory and cache boundary

The TG Worker adds room headers only after D1 room resolution. Memory accepts them only on the internal service-binding hostname, authenticated by the TG service key, with `x-operia-channel=telegram`, and after confirming that both `x-operia-room-id` and `x-operia-recipient-id` exactly match the active D1 room row's `id` and `chat_id`. A forged room ID, missing room, wrong recipient or wrong/missing channel fails closed before provider selection.

The effective room profile is fixed server-side:

- source `telegram-room`;
- request-only namespace `tg-room:<opaque-room-id>` for idempotency/usage labels, never a durable Memory conversation;
- scope `chat:proxy` only;
- injection `none`;
- memory mode `none`, plus explicit no-create/no-save enforcement for user and assistant messages;
- no model passthrough override.

Before the final provider request Memory overwrites the tool surface to the exact Telegram presentation allowlist (`react_to_message`, `reply_to_message`) with `tool_choice=auto`; it rejects stream, image and every non-presentation tool continuation. Both tools can target only current-batch message IDs validated by the TG delivery layer. Room turns never call `getOrCreateConversation`, `saveUserMessages` or `saveAssistantMessage`, and never enqueue extraction, maintenance or retention. Dynamic speaker-labelled context comes only from the TG-owned four-turn/two-hour window and belongs after the stable cache breakpoint.

Expiration or room deletion clears the TG short window while retaining content-free audit facts. No private content is copied into room pins, Memory rows or a fallback handoff table.

## 9. Capability matrix

| Capability | Owner private | QA room P0 | QA room P1 |
|---|---:|---:|---:|
| Conversation / debug QA | yes | explicit target | explicit target |
| Deterministic status | yes | no-argument `/status@Target`; room/thread/wake/agent/loop only | same |
| Agent-to-agent handoff | n/a | native targeted B2B, max 5 turns/2 min | same plus reviewed controls |
| Shared timeline read | n/a | content-free run state | bounded QA transcript |
| Private Memory recall/write | yes | no | no |
| Calendar / Health / HA | policy controlled | no | separate approval only |
| MCP / Skill / tool mutation | policy controlled | no | separate approval only |
| Paid image / voice | policy controlled | no | separate approval only |
| Heartbeat / finance actions | policy controlled | no | no by default |

Inbound image handling implemented for private messaging is deliberately out of this room's P0/P1 scope. Group media is acknowledged and dropped before persistence.

## 10. Threat model

- `chatId = actor`: prevented by binding actor user ID independently.
- Display spoofing: names are display-only; Bot ID is authoritative.
- Prompt injection: unknown/member/bot content is not ingested; tool scopes are absent.
- Cross-household flash: room ID is validated server-side and maps to a fixed isolated namespace.
- Private Memory leak: no persona, recall, imported summary, ambient context or extraction in room profile.
- Bot loop: registered source, explicit target, update idempotency and five-agent-turn/two-minute ingress bound; ordinary bot chatter and self echoes are ignored.
- Group migration: a future `migrate_to_chat_id` transition must CAS-update the room chat ID and invalidate membership revision before accepting the new ID.
- Stale membership: enrollment is live-verified; P1 periodically refreshes `getChatMember` and suspends on mismatch.
- Guest/unknown sender: HTTP 200, zero durable content and zero model call.

## 11. Rollout and rollback

### P0

- additive D1 schema and owner panel;
- one active private supergroup;
- Owner → Operia mention/reply and targeted `/status`;
- request-only no-memory room profile and TG-owned short transcript;
- Codex registry row and Bot-to-Bot mode readiness projection; mode remains off until the BotFather approval gate.

### P1

- native bot-to-bot enablement after controlled canary and the <LOCAL_CODEX_BRIDGE> peer adapter;
- richer per-chain bot turn attribution while preserving the five-agent-turn/two-minute ceiling;
- topic-specific rooms after an explicit gate;
- periodic membership refresh and migration handling;
- transcript deletion and preview-as-agent panel.

### P2

- household member roles and reviewed shared memory candidates, only under a new product approval. They are not implied by the QA-room launch.

Feature flags default off. Rollback disables room wake first, leaving private chat untouched. Schema is additive and retained for audit; no destructive rollback is required.

## 12. Acceptance matrix

Local and synthetic tests must prove:

- owner mention, text mention, targeted command and reply each select exactly one agent;
- dual owner mentions independently select both adapters;
- unmentioned text, ordinary reaction, media, unknown member, unregistered bot and wrong topic create zero inbox rows;
- duplicate update produces one inference/result;
- stale revision returns conflict;
- bot name mismatch, missing membership and wrong Bot ID fail enrollment;
- room requests contain no private boot/persona/recall/imported-summary/ambient context;
- no room inference creates/saves a Memory conversation message or schedules extraction/retention;
- final provider request has no tools, and any returned tool call is rejected;
- null/0/1 General Topic, topic 2 and another explicit topic, wrong topic and topic-disabled fixtures all route deterministically;
- a fifth bot-origin turn inside two minutes is ignored;
- provider/outbox unknown outcomes are not blindly replayed.

Production canary is a separate approval gate: apply migration, bind the one intended room/thread, enroll the two known agents, verify zero-call negative cases, run one owner→Operia mention, run one owner→Codex mention, then one native Codex→Operia→Codex chain capped at two turns. Return room wake to off on any attribution, isolation or delivery mismatch.

## 13. Explicit non-adoptions

No external framework becomes a second Agent, Memory or provider layer. grammY can inform entity types and tests; Hermes Agent, AstrBot, LangBot and chatgpt-telegram-bot may inform group UX but are not embedded. Their runtime abstractions would duplicate Operia ownership boundaries, and license compatibility alone does not justify importing a second orchestration stack.

## 14. Open items and defaults

- <LOCAL_CODEX_BRIDGE> uses its own Telegram transport with the same stable Bot ID registry, exact-target and loop rules; it does not receive an Operia private Memory copy.
- runtime enrollment credential: recommend a one-time, hashed adapter credential only if a future panel-to-runtime control channel is approved; Bot ID alone must never authenticate a runtime.
- bot-turn limit: 5 per two minutes; production canary remains owner-directed and bounded.
- topic policy: one exact normalized thread, General by default.
- transcript retention: four completed turns and two hours in TG D1; post-completion reliability copies are redacted, while pre-completion unknown-outcome checkpoints remain recoverable; durable audit is content-free.
- images and other media: off for the QA room.

## 15. Primary references

- Telegram Bot API and Bot Features, including Bot-to-Bot Communication, message entities, topics, membership updates, ephemeral messages and loop-prevention requirements: <https://core.telegram.org/bots/api> and <https://core.telegram.org/bots/features#bot-to-bot-communication>.
- grammY is a useful MIT-licensed source for Telegram update types and test shapes; it is not adopted as a second runtime.
- Hermes Agent and grammY are MIT-licensed references; LangBot is Apache-2.0. AstrBot is AGPL-3.0 and `chatgpt-telegram-bot` is GPL-2.0, so both are research-only for this proprietary deployment. No external implementation is copied.
