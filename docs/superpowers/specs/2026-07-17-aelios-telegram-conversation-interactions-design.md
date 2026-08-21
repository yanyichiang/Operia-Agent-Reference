# Operia Telegram Conversation Interactions Design

Date: 2026-07-17
Status: implementation approved
Owner: private Operia Telegram owner

## 1. Goal

Upgrade the existing private Operia Telegram surface with four conversation
behaviours without changing its identity, memory, tool, approval, or network
ownership boundaries:

1. quote-reply to a known Telegram message;
2. add one ordinary emoji reaction to a known Telegram message;
3. wait until the owner has been silent for eight seconds, then process all
   buffered natural messages as one turn;
4. keep model replies as plain text bubbles split on blank lines, with an
   independent 4096-character hard guard and tool results separated from the
   natural-language conclusion;
5. expose the owner's incoming reply selection, sticker identity, and message
   reaction changes to Opus as bounded Telegram event context.

The future sticker/meme asset workbench is a separate follow-up. This change
may prepare extension points but must not add an upload surface, R2 binding, or
new public route.

## 2. Non-regression boundaries

- `tgbot.example.com` remains the only Telegram custom domain.
- The Telegram webhook secret and exact owner chat allowlist remain mandatory.
- Cloudflare Access continues to protect browser/admin routes. No new Bypass
  path is introduced.
- Operia Memory remains the identity, persona, conversation, and long-term
  memory owner.
- Agent task, approval, MCP/Skill, Browser, Elicitation, Fiber, media cleanup,
  heartbeat, and durable continuation semantics remain unchanged.
- Slash commands and callback queries remain immediate and do not enter the
  eight-second natural-message window.
- Telegram delivery remains idempotent through `tg_agent_outbox`.
- Message IDs are opaque owner-chat-scoped capabilities. The model may only
  target IDs supplied from the currently claimed input batch.
- Paid reactions and arbitrary custom emoji IDs are forbidden.

## 3. Input and debounce contract

### 3.1 True trailing-edge window

`TG_DEBOUNCE_SECONDS` becomes `8` in production. Every accepted natural text
or audio message is persisted before scheduling work.

The queue consumer must check the newest unprocessed inbox timestamp before it
claims a batch:

- if the newest row is younger than the configured quiet window, enqueue one
  replacement `tg_process` task for the remaining delay and return without
  claiming anything;
- otherwise atomically claim all current unprocessed rows and process them as
  one turn.

This check is required because merely delaying every queue message by eight
seconds would process at `first message + 8s`, not `last message + 8s`.

The current 250ms direct timer is raised to the same configured quiet window.
Queue and cron recovery remain available. Duplicate direct timers and queue
deliveries are harmless because every consumer re-checks the trailing edge
before claiming.

### 3.2 Batch identity

Claimed inbox rows must include their `message_id`, `update_id`, and
`created_at`. The ordered batch exposes a compact, deterministic list of
targets to the Telegram orchestration layer, but does not persist message IDs
into Operia long-term memory or the conversational prose transcript.

The default quote target for a normal response is the last message in the
claimed batch. An explicit interaction tool may select another message ID only
when that ID occurs in the same batch target list.

### 3.3 Incoming interaction visibility

- A text/audio message that replies to another Telegram message carries the
  replied message ID and a bounded visible text/caption excerpt into the same
  eight-second batch.
- A sticker message carries its stable `file_unique_id`, current bot-scoped
  `file_id`, set name, associated emoji, and any owner-authored catalog
  description. Binary sticker content is not injected into the prompt.
- A `message_reaction` update carries the target message ID plus bounded added
  and removed ordinary/custom reaction identifiers.
- Sticker and reaction events are normal short-term conversation events but do
  not count as Heartbeat natural-text or natural-voice activity.
- Unknown chats and bot-authored reaction updates remain silently dropped.

## 4. Reply-to contract

Outgoing text and supported media use Telegram `reply_parameters`:

```json
{
  "reply_parameters": {
    "message_id": 123,
    "allow_sending_without_reply": true
  }
}
```

Only the first natural-language bubble quotes the owner message; later bubbles
remain visually contiguous without repeating the quote. System commands,
status-card edits, and unrelated background notifications do not inherit a
stale reply target.

## 5. Reaction contract

The model receives a local Telegram interaction tool with a bounded schema:

```json
{
  "name": "react_to_message",
  "arguments": {
    "message_id": 123,
    "emoji": "❤️"
  }
}
```

Rules:

- `message_id` must be present in the current claimed batch;
- `emoji` must be one ordinary emoji from the local allowlist;
- up to eight reactions may be requested in one turn, but at most one per
  owner message ID;
- one or more reactions to distinct current-batch messages may share a tool
  round with one `reply_to_message` selection; this interaction-only batch is
  validated completely before the first Telegram side effect;
- interaction calls cannot share a round with context acquisition, Browser,
  MCP/Skill delegation, voice, image, search, or another expensive action;
- the resulting `setMessageReaction` intent is stored and delivered through
  the durable outbox with a stable idempotency key;
- reaction failure is recorded but cannot suppress the text reply;
- empty reaction arrays, paid reactions, and arbitrary custom emoji IDs are
  rejected.

## 6. Bubble and formatting contract

- Natural assistant text is sent without `parse_mode` and must not contain
  Markdown control syntax.
- Two or more newlines are the explicit bubble boundary.
- A single oversized bubble is split safely before Telegram's 4096 UTF-16-code
  unit limit, preferring a newline or space.
- There is no 150-character soft limit.
- Program-generated status cards may continue using escaped Telegram HTML;
  this is presentation code, not model-authored Markdown.
- Tool result material is emitted as one or more dedicated plain-text bubbles
  before the natural-language conclusion. It is bounded and never mixed into
  the conclusion bubble.
- Tool traces and hidden reasoning are not exposed as tool results.

## 7. Data changes

Existing `tg_inbox` columns already contain the needed Telegram IDs and
timestamps; the claim projection is expanded. Existing
`tg_agent_outbox.payload_json` stores reply and reaction intents.

`tg_agent_continuations` receives two additive nullable columns:

- `reply_to_message_id` keeps the quote anchor across a durable Agent pause;
- `interaction_targets_json` keeps the exact current-batch target allowlist
  across that pause.

Neither column contains message text, identity data, or a cross-chat target.

`tg_sticker_catalog` stores the bot-scoped send handle and stable unique ID for
stickers observed from the owner. Its optional description is the join point
for the later Access-protected sticker workbench. The table does not expose a
public file URL.

If a future implementation needs cross-turn targeting, it requires a separate
owner-scoped expiring message-reference table and a new review. Phase one must
not silently broaden the target window.

## 8. Acceptance criteria

1. Three owner messages at `t=0s`, `t=6s`, and `t=12s` produce no model call
   before `t=20s` and are processed once, in order, as one turn.
2. A slash command during a quiet window executes immediately and does not
   consume or prematurely flush the natural-message batch.
3. The first reply bubble quotes the latest owner message; subsequent bubbles
   do not repeat the quote.
4. An allowed reaction becomes one `setMessageReaction` outbox intent. An
   unknown message ID, disallowed emoji, paid reaction, or custom emoji is
   rejected locally.
   Multiple distinct message reactions plus one reply selection execute in one
   tool round and require only the normal post-tool model continuation.
5. Blank-line output becomes sequential bubbles. A bubble longer than the
   Telegram limit is hard-split, and no payload exceeds the limit.
6. Tool results and the assistant conclusion are distinct payloads.
7. Existing voice, media, task presentation, continuation, approval, Browser,
   MCP/Skill, Elicitation, Fiber, heartbeat, and command verification remains
   green.
8. Dry-run output contains no new public route, secret, token, or Access
   relaxation.
9. An incoming reply, sticker, and ordinary reaction update each produce a
   bounded event visible to Opus; Telegram's webhook subscription explicitly
   includes `message`, `callback_query`, and `message_reaction`.
10. The production Memory Worker exposes `react_to_message` and
    `reply_to_message` in the Anthropic tool list for requests carrying
    `x-operia-channel: telegram`; seeing only the interaction-context prose is
    a failed rollout, not a usable tool surface.

## 9. Rollout and rollback

Rollout order:

1. land deterministic tests and implementation;
2. run typecheck, full verify, TG dry-run, and secret-surface scan;
3. apply the additive D1 migrations required by the implementation;
4. deploy `<MEMORY_SERVICE>` first because canonical model-tool registration and
   Anthropic wire conversion live there, then deploy `<TG_SERVICE>` because
   target scoping, execution, delivery, and inbound event handling live there;
5. verify both Workers are on the same source revision, then verify active
   deployments, webhook/owner gates, queue health, the Memory tool surface,
   and a synthetic interaction smoke;
6. ask the owner to perform one natural three-message Telegram acceptance.

Rollback is a normal revert commit plus Memory and TG Worker redeploy. Because
no schema destruction or credential rotation is planned, rollback does not
require data restoration.
