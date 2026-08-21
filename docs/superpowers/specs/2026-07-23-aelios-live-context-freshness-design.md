# Operia Live Context Freshness and Explicit Historical Recall Design

Date: 2026-07-23

Status: owner-review draft; specification only; no implementation or production change

Owner: Memory

Coordinator thread: `<UUID>`

## 1. Decision

Operia will distinguish live conversational continuity from historical recall by source time, support
time, and owner intent. A message, rolling-summary item, or imported summary is not fresh merely
because it was rewritten, re-folded, migrated, or retrieved recently.

The owner decisions for this design are:

1. Ordinary material older than the live window must not be injected merely because it remains in a
   rolling summary.
2. Material outside the live window is eligible only when the current owner message explicitly
   reactivates the subject. “The system remembers it” is not sufficient.
3. Historical summaries with no trustworthy source time are down-ranked, not deleted or made
   permanently inaccessible.
4. Legacy rows created before per-turn timestamps existed remain `unknown`; migration must not invent
   an occurrence time from row update time, deployment time, import time, or fold time.
5. Rolling summaries and historical recall remain dynamic turn context after cache breakpoints. They
   never enter `persona_pinned`, `precious`, `digest`, `boot_stable`, or `client_system`.

The initial implementation target is the Memory-owned owner-private conversation path used by
Telegram. Operia, Telegram, Agent, and future clients remain consumers of the same Memory contracts;
no client becomes a second source of truth.

## 2. Confirmed structural cause

The current private Telegram rolling state has two structural freshness gaps:

- a recent turn stores only `role` and `content`, with no occurrence time;
- compaction is triggered and retained by message count, not event age;
- the existing summary is recursively merged into the next summary;
- the summary has no generation time, coverage range, last-supported time, expiry state, or policy
  version;
- a recently completed fold updates the row but does not prove that every carried item is recent;
- the rendered summary is injected as an ordinary historical `user` message before recent turns;
- the current 1,500-character target is a model instruction, not a server-enforced output bound.

This permits a synthetic sequence such as:

```text
T-48h EVENT_A
  -> folded into rolling summary
  -> inherited by a later fold
  -> row receives a new updated_at
  -> EVENT_A remains present during unrelated TOPIC_B turns
```

The cache is not the source of the stale information. Cache breakpoints reuse byte-identical prefixes;
they do not create context that the assembler did not supply. This design changes the dynamic
projection while preserving all stable hashes and breakpoint positions.

## 3. Scope and non-goals

### In scope

- trustworthy per-turn occurrence metadata for new owner-private turns;
- explicit summary revision, generation time, coverage, support time, and freshness state;
- a count-, age-, and byte-bounded recent-history projection;
- a structured rolling-summary envelope with per-item lifecycle;
- owner-query-gated recall for material outside the live window;
- recency and unknown-time down-ranking for imported historical summaries;
- a dedicated dynamic conversation-summary block after all stable cache breakpoints;
- content-free per-layer selection telemetry;
- a conservative legacy cutover with no invented timestamps;
- synthetic verification of T-24h, T-48h, unknown-time, cache, and cross-layer behavior.

### Out of scope

- reading or rewriting current private conversation, persona, precious, or imported-summary content
  while implementing the structural contract;
- changing the active persona or precious records;
- deleting the private LegacyChat archive or recomputing its summaries as part of this change;
- changing embedding dimensions, model providers, routes, Access, secrets, Workers, or namespaces;
- enabling a paid model, running a paid production smoke, or triggering a real owner message;
- changing Telegram room-summary behavior, which already has a separate two-hour contract;
- turning PWA-local history into another Memory owner;
- implementing router or home-network changes.

## 4. Canonical time vocabulary

Every time-bearing context object uses `<YOUR_TIMEZONE>` for owner-facing display and an exact UTC ISO
instant for comparison.

| Field | Meaning |
| --- | --- |
| `occurredAtUtc` | Source event instant for a turn. Never derived from a later database write. |
| `observedAtUtc` | Time Memory accepted the event. May differ from occurrence time. |
| `generatedAtUtc` | Time a summary revision was produced. Not evidence of source freshness. |
| `coversFromUtc` | Earliest known source occurrence included in a summary revision. |
| `coversThroughUtc` | Latest known source occurrence included in a summary revision. |
| `lastSupportedAtUtc` | Latest source occurrence that affirmatively supports one summary item. |
| `temporalConfidence` | `exact`, `bounded`, or `unknown`. |
| `freshness` | `live`, `aged`, `stale`, `unknown`, or `expired`. |

`updated_at` remains database mutation metadata. It must never be used as a substitute for
`occurredAtUtc`, `coversThroughUtc`, or `lastSupportedAtUtc`.

## 5. Freshness policy

P0 uses two owner-local horizons:

- `LIVE_CONTEXT_MAX_AGE = 24 hours`;
- `STALE_TOPIC_AGE = 48 hours`.

The server computes age from the request-start UTC instant supplied to the assembler. The current
exact-clock contract remains unchanged.

### 5.1 Selection policy

| Source state | Automatic injection | Owner explicitly reactivates subject |
| --- | --- | --- |
| exact/bounded, age `<=24h` | eligible within count/byte bounds | eligible |
| exact/bounded, age `>24h` and `<=48h` | no | eligible, marked `aged` |
| exact/bounded, age `>48h` | no | eligible once, marked `historical` |
| unknown source time | no | eligible once with unknown-time penalty |
| resolved/superseded/expired item | no | only through historical recall, never silent carry-forward |

“Owner explicitly reactivates” is request-local and deterministic. It requires the current owner
message to satisfy the historical-query relevance gate in section 10. It is not inferred from:

- the previous assistant reply;
- an old summary’s own wording;
- a generic greeting or pronoun;
- an imported summary being recently generated;
- an item being pinned by the system without owner action;
- a model deciding on its own that an old topic is important.

Reactivation permits a bounded projection for the current request. It does not rewrite the original
event time. A new owner statement that substantively supports the same item may create a new support
edge at the current time.

## 6. Recent-turn contract

### 6.1 Versioned turn shape

New turns use a versioned envelope:

```ts
type ConversationRecentTurnV2 = {
  version: 2;
  eventId: string;
  role: "user" | "assistant";
  content: string;
  occurredAtUtc: string | null;
  observedAtUtc: string;
  temporalConfidence: "exact" | "bounded" | "unknown";
};
```

Requirements:

- the owner message occurrence time comes from the authenticated Telegram event when available;
- the assistant occurrence time is the durable finalization instant;
- both values are validated UTC instants and are displayed in `<YOUR_TIMEZONE>` only at presentation;
- `eventId` retains the existing idempotent turn-event identity;
- legacy `{role, content}` entries parse as V1 and become
  `occurredAtUtc=null, temporalConfidence="unknown"`;
- no migration writes the enclosing `tg_chat_state.updated_at` into legacy turns;
- logs and events expose counts and timestamp bounds, never `content`.

### 6.2 Storage and injection are separate bounds

The existing fold trigger and keep behavior may remain storage policy during the first rollout:

- fold trigger: 50 message turns;
- post-fold retained tail: 10 message turns.

The live injection projection adds independent hard defaults:

- at most 24 message turns;
- at most 24,000 UTF-8 bytes;
- only turns with trusted age `<=24h`;
- deterministic chronological order;
- a complete owner/assistant pair is preferred, but a current unmatched owner turn is allowed;
- legacy unknown-time turns are not automatically injected.

The projection reports only:

- stored turn count;
- selected turn count;
- excluded-by-age count;
- excluded-unknown-time count;
- selected bytes;
- oldest and newest selected UTC instants;
- projection policy version and hash.

## 7. Rolling-summary envelope

The plain summary string becomes a compatibility projection of a structured Memory-owned envelope.
The physical representation may use additive columns plus a JSON manifest, but it has one canonical
schema:

```ts
type RollingSummaryEnvelopeV2 = {
  version: 2;
  revision: number;
  policyVersion: string;
  generatedAtUtc: string;
  coversFromUtc: string | null;
  coversThroughUtc: string | null;
  temporalConfidence: "exact" | "bounded" | "unknown";
  items: RollingSummaryItemV2[];
  renderedText: string;
  renderedSha256: string;
};

type RollingSummaryItemV2 = {
  itemId: string;
  text: string;
  status: "active" | "resolved" | "superseded" | "expired";
  firstSupportedAtUtc: string | null;
  lastSupportedAtUtc: string | null;
  temporalConfidence: "exact" | "bounded" | "unknown";
  supportCount: number;
  sourceEventHashes: string[];
};
```

### 7.1 Bounds

- at most 12 summary items;
- at most 300 Unicode characters per item;
- at most 4,000 Unicode characters and 16,000 UTF-8 bytes in the stored compatibility
  `renderedText`;
- at most 1,500 Unicode characters and 6,000 UTF-8 bytes in the request-local
  `conversation_summary_patch`;
- at most 64 source-event hashes per revision;
- no raw provider response, reasoning, tool arguments, or quarantined import data;
- server validation is authoritative.

An invalid, storage-over-budget, or schema-incompatible compactor result does not replace the previous
revision. It records a content-free failure and keeps the unfurled recent turns for a later bounded
retry. An empty delta is valid: it advances source coverage without inventing an active fact. The
server must not silently truncate a malformed item into apparent success. If more active items are
eligible than the injection carrier can hold, the deterministic projection emits a bounded subset and
an explicit `summary_budget_limited` status instead of dropping the whole patch.

### 7.2 Merge and lifecycle rules

The compactor receives:

- the prior structured items;
- at most eight newly evicted, timestamped turns per asynchronous call, preserving owner/assistant
  pair boundaries;
- request-start time;
- the immutable policy version.

It must:

1. retain an old item only when new source evidence supports it or it is still within the live window;
2. mark completed or contradicted items `resolved` or `superseded`;
3. mark unsupported items older than 48 hours `expired`;
4. keep unknown-time legacy items historical-only unless the current owner request reactivates them;
5. calculate coverage from source events, not summary generation time;
6. record an input-set hash and output hash;
7. never promote an item into persona, precious, digest, or a durable memory.

The model response is a change set, not a full rewritten envelope. Unreferenced prior items are
retained byte-for-byte by the server. A retained `prior_ref` does not need to echo its text. Explicitly
inactive items may be pruned when the 12-slot storage bound is full; a thirteenth active item fails the
fold losslessly instead of silently evicting an active fact. Coverage advances over every timestamped
event in a successful batch, including a batch that yields no durable fact changes.

The model may propose item matches and lifecycle changes, but the server validates timestamps, bounds,
allowed statuses, hashes, and monotonic revision. A model cannot assign a newer support time than the
newest source event supplied to it.

## 8. Legacy cutover

The production cutover is conservative and reversible:

1. capture a private, content-protected rollback snapshot of the existing `tg_chat_state` row;
2. add the new nullable metadata through an additive migration;
3. wrap the existing summary as a legacy revision with:
   - `temporalConfidence="unknown"`;
   - null coverage and support times;
   - a content hash;
   - no automatic live-injection eligibility;
4. parse existing recent entries as V1 unknown-time turns;
5. start V2 timestamps only for events accepted after the cutover;
6. do not call a model merely to rewrite the legacy summary;
7. preserve `/new` and rollback semantics.

The legacy material remains owner-retrievable through the explicit historical-query gate. It is not
deleted, relabeled with the deployment time, or silently presented as current.

## 9. Dynamic injection and cache boundary

Add `conversation_summary_patch` as a Memory-owned `turn_context` block adjacent to
`dynamic_memory_patch`.

Target order:

```text
stable system blocks
  -> client_system cache anchor
  -> boot_stable
  -> recent-history cache breakpoints
  -> client_volatile_context
  -> conversation_summary_patch
  -> dynamic_memory_patch
  -> vision_context
  -> current_user
```

The exact order among the three request-local patches must remain deterministic. No dynamic summary
text may appear in:

- `system_blocks`;
- `persona_pinned`;
- `client_system`;
- `boot_stable`;
- the one-hour cache prefix;
- the five-minute conversation cache prefix.

The patch contains bounded content plus a model-visible metadata header:

```text
source=live_conversation_summary
freshness=live|aged|historical|unknown
generated_at=<UTC>
covers=<UTC-or-unknown>..<UTC-or-unknown>
policy=<version>
```

It contains no raw message IDs, D1 IDs, R2 references, owner identifiers, tokens, or secrets.

With the patch on or off:

- `client_system_hash` is byte-identical;
- stable system blocks are byte-identical;
- cache breakpoint count and positions are unchanged;
- tool continuation and image-turn direct-answer behavior are unchanged.

### 9.1 Bounded cache epochs and no-gap degradation

The canonical history remains append-only in durable storage, but the provider working set is
bounded. Eligible recent turns are deterministically partitioned into append-only epochs of at most
24 turns or 24,000 UTF-8 bytes while preserving owner/assistant pairs. Projection retains the newest
two complete epochs under an 80,000-byte hard ceiling. Appending within the active epoch preserves the
exact prior provider prefix. Epoch membership is persisted in canonical recent state so removing an
older prefix cannot repartition the surviving turns from a new array index. A durable fold may consume
only the contiguous prefix outside the newest two provider-visible epochs, in batches of at most eight
turns. Therefore partial and completed folds of a retired epoch leave both active epochs byte-order
stable; rotation happens only when a new bounded epoch begins. This is policy
`live-context-freshness-v2.5`.

Turns outside the selected epochs are not silently treated as absent. Memory compares them with the
summary coverage range. If an omitted turn is not covered, the dynamic post-breakpoint carrier emits
`coverage_degraded` using counts only and may include at most four whole, query-relevant historical
turns as escaped read-only evidence. Unknown or oversized content never bypasses the hard ceiling.
Unrelated omitted text is not sprayed into the prompt. The context-degraded carrier instructs the
model to request clarification naturally rather than fabricate continuity.

## 10. Owner-query relevance gate

Historical material older than 24 hours or with unknown source time is eligible only when the current
owner message independently matches it.

P0 uses deterministic local relevance:

1. normalize the current owner text with NFKC and lowercase;
2. extract at most eight bounded terms using the existing imported-summary tokenizer;
3. discard configured stop terms and one-character generic tokens;
4. require at least one high-specificity exact term or two distinct bounded CJK bigram matches;
5. require a raw lexical relevance score of at least `0.60`;
6. do not use prior assistant text, prior summary text as the query, or an extra model call;
7. do not expose matched terms in telemetry.

The gate is intentionally conservative. False negatives leave information available for a more
explicit owner query; false positives would reintroduce stale-topic drift.

If the owner explicitly invokes a future “search history” action, that action may use a separate,
clearly labeled historical-search contract. It does not loosen ordinary-chat recall.

## 11. Imported historical-summary recall

The existing hard bounds remain:

- default `topK=2`;
- hard `topK<=3`;
- at most 1,800 bytes per hit;
- at most 3,600 bytes total;
- one hit per canonical conversation;
- no raw-message fallback.

Ranking becomes:

```text
finalScore =
  lexicalScore
  * sourceTimeFactor
  * eventAgeFactor
  * repeatInjectionFactor
```

P0 factors:

| Condition | Factor |
| --- | --- |
| trusted source range ending within 24h | `1.00` |
| trusted range older than 24h and at most 7d | `0.70` |
| trusted range older than 7d and at most 30d | `0.45` |
| trusted range older than 30d | `0.25` |
| missing source range | `0.50` |
| same summary injected within 30 minutes | additional `0.15` |

For every source range older than 24 hours or missing its source range:

- section 10’s owner-query relevance gate must pass before ranking;
- the source-time factor down-ranks the result but does not permanently exclude it;
- the citation reports `timeRange=null` and `freshness=unknown` when appropriate;
- summary `updated_at` is only a deterministic tie-breaker, never the event-age input.

The implementation records a bounded, content-free injection receipt so repeat suppression can be
reconciled without logging the summary:

```ts
type ContextInjectionReceipt = {
  requestId: string;
  namespaceHash: string;
  layer: "live_summary" | "ordinary_memory" | "imported_summary";
  recordHash: string;
  selectedAtUtc: string;
  freshness: string;
  scoreBucket: string;
  byteCount: number;
};
```

## 12. Persona, precious, digest, and daily log

This fix does not inspect or rewrite current owner content in these layers.

Their structural rules are:

- `persona_pinned`: durable identity, relationship style, and assistant behavior only; no dated
  transient topic or short-lived task;
- `precious`: explicit owner-kept material only; no automatic promotion from rolling summary;
- `digest`: compatibility storage and explicit access only; not automatically injected by v3;
- `daily_log`: yesterday boot context remains separate and visibly dated;
- imported summaries: dynamic and cited only;
- rolling summary: dynamic and freshness-bounded only.

A later owner-data review may flag a stable record for manual inspection using only record ID, type,
timestamps, and hashes. This implementation must not read or alter its content automatically.

## 13. Channel boundaries

### Owner-private Telegram

- Memory owns state, fold, projection, summary, and freshness policy.
- Telegram supplies authenticated event time and submits idempotent turn events.
- Telegram does not store a writable copy of the summary envelope.

### Telegram Agent room

- remains isolated from private state;
- retains its two-hour transcript and summary expiry contract;
- does not receive private persona, imported summary, or private rolling summary;
- is covered by regression tests only, not changed by this implementation.

### Operia PWA

- remains a client of the Memory chat pipeline;
- its local last-N relay history is client-supplied recent history, not Memory rolling state;
- when this contract is later adopted by Operia, its rows must retain their source timestamps and
  apply the same age/byte projection before sending;
- the current P0 does not copy the Telegram state into Operia or vice versa.

## 14. Data and migration plan

Implementation must ask the coordinator for the next free additive migration number. This draft does
not reserve one.

The migration may extend the current state with:

- summary revision;
- summary policy version;
- summary generated time;
- coverage start/end;
- summary temporal confidence;
- structured manifest JSON;
- rendered summary hash;
- projection revision/CAS fields;
- content-free injection receipts, if no existing event table can enforce the required unique key.

Requirements:

- additive and repeat-readable under repository migration practice;
- no table drop, rename, destructive rewrite, or content backfill;
- legacy summary and recent content remain private;
- no trigger copies text into events or logs;
- state updates use revision/CAS and preserve the current one-generation fold backup;
- rollback can disable V2 reads without deleting V2 metadata.

## 15. Feature flags and rollback

Use independent default-false gates:

- `CONVERSATION_FRESHNESS_V2_ENABLED=false`;
- `IMPORTED_SUMMARY_RECENCY_ENABLED=false`.

Rollout order:

1. deploy schema-compatible code with both flags false;
2. verify legacy reads and all cache contracts;
3. enable V2 timestamp writes only for a synthetic/local namespace;
4. verify unknown-time cutover and rollback;
5. enable live recent/summary projection for the owner-private canary;
6. enable imported-summary recency ranking last;
7. keep an immediate flag rollback to legacy reads.

Rollback:

- disables V2 selection and ranking;
- does not delete timestamps, manifests, receipts, summaries, imports, or memories;
- restores the captured pre-cutover rolling-state snapshot only if the owner explicitly authorizes a
  data rollback;
- never changes persona or precious data as a side effect.

No step above authorizes deployment or production writes in the current spec task.

## 16. Content-free observability

Per request, emit bounded structured metadata only:

- request/trace ID;
- context policy version;
- stable `client_system_hash`;
- per-layer available/selected/excluded counts;
- per-layer bytes and score buckets;
- oldest/newest selected timestamps;
- unknown-time count;
- excluded-by-age count;
- excluded-by-owner-query-gate count;
- normalized record hashes for cross-layer deduplication;
- cache breakpoint count;
- summary revision and freshness state;
- model/provider call count by purpose.
- recent projection mode, epoch counts, omitted/uncovered turn and byte counts;
- summary items available/projected/dropped-by-budget and relevant evidence count/bytes.

Never emit:

- message, summary, persona, precious, or imported-summary text;
- extracted match terms;
- titles, participant names, source locators, raw IDs, or owner identifiers;
- prompts, model responses, tool arguments, secrets, tokens, headers, or R2 references.

## 17. Synthetic verification matrix

All fixtures use only placeholders such as `EVENT_A`, `TOPIC_B`, and `T-48h`.

### Timestamp and recent projection

1. V2 exact timestamps preserve UTC and display in `<YOUR_TIMEZONE>`.
2. Legacy V1 turns become `unknown`; no timestamp is synthesized.
3. At T+23h, `EVENT_A` may remain within live count/byte bounds.
4. At T+25h, unrelated `TOPIC_B` excludes `EVENT_A`.
5. At T+25h, an explicit owner query for `EVENT_A` permits one aged projection.
6. At T+49h, unrelated `TOPIC_B` excludes `EVENT_A`.
7. At T+49h, an explicit owner query permits one historical projection.
8. Count, age, and byte limits each fail closed independently.

### Summary lifecycle

1. A fold produces valid coverage and monotonic revision.
2. Re-folding without new support does not refresh `lastSupportedAtUtc`.
3. Generation time cannot become source occurrence time.
4. A resolved item does not silently return.
5. A superseded item does not outrank its replacement.
6. An unsupported item crosses 48 hours and becomes expired.
7. Unknown-time legacy items are absent from ordinary live injection.
8. Empty, malformed, over-item, over-character, and over-byte outputs preserve the prior state.
9. `renderedText` is hard-bounded by the server.

### Historical recall

1. Missing source range receives factor `0.50`, not exclusion.
2. A stale or unknown-time hit cannot enter without the current owner query gate.
3. A relevant owner query can retrieve the hit within top-k and byte bounds.
4. Repeating the same query within 30 minutes applies factor `0.15`.
5. Same-conversation and cross-layer normalized duplicates appear once.
6. Citation freshness and time range agree with stored metadata.
7. Summary `updated_at` does not affect event-age classification.

### Cache and isolation

1. `client_system_hash` is identical with freshness V2 on and off.
2. Dynamic summary and imported recall occur after the last cache breakpoint.
3. No dynamic text enters persona, boot, digest, precious, or system blocks.
4. Tool continuation behavior remains unchanged.
5. Image-turn direct-answer behavior remains unchanged.
6. Agent-room summary, pin, transcript, and room isolation tests remain unchanged.
7. No raw content appears in telemetry snapshots or test failure output.
8. Appends inside an epoch preserve the exact prior history prefix; rotation occurs only at the
   deterministic epoch boundary.
9. Omitted query-relevant history appears only in the bounded post-breakpoint carrier; unrelated and
   oversized text does not.

### Resource behavior

1. Flag-off and no-hit paths make zero extra model, AI, Vectorize, Queue, or network calls.
2. Selection, ranking, and injection receipts are deterministic on replay.
3. Compaction uses the existing bounded summary call only when the existing fold trigger fires.
4. A failed structured fold does not drop recent turns or advance summary revision.
5. Each fold call contains at most eight events; successful partial folds advance by CAS and enqueue
   at most one successor revision while still due.
6. Empty change sets advance coverage without creating summary text, while a thirteenth active item
   fails losslessly.

## 18. Implementation file plan

Expected implementation touch points after owner and coordinator approval:

- `src/memory/conversationState.ts`
  - V1/V2 turn parsing, timestamp validation, summary envelope, fold validation, revision/CAS;
- `src/tg/conversationClient.ts`
  - authenticated occurrence metadata in the turn-event contract;
- `src/tg/process.ts`
  - bounded recent projection and removal of the generic summary-as-user wrapper;
- `src/assembler/types.ts` and `src/assembler/blocks.ts`
  - `conversation_summary_patch` after cache breakpoints;
- `src/api/chatCompletions.ts`
  - request-start clock, dynamic projection, imported ranking wiring;
- `src/memory/import/recall.ts`
  - source-time factor, event-age factor, owner-query gate, repeat factor;
- one additive migration after coordinator reservation;
- `src/types.ts` and `wrangler.toml`
  - default-false flags and bounded defaults;
- synthetic fixtures and verifiers for conversation state, assembler, wire cache, tool continuation,
  imported recall, Agent room, and local D1 CAS.

Shared files require coordinator sequencing. The implementation must use an isolated worktree and
ordinary commits; no amend, force-push, deploy, remote migration, or owner-data mutation.

## 19. Acceptance gates

### Gate A: local data contract

- migration replays safely;
- V1 rows parse as unknown without backfill;
- V2 timestamps, envelope hashes, revisions, and bounds are deterministic;
- local D1 quick/FK checks pass.

### Gate B: summary and projection

- T-24h/T-48h synthetic cases pass;
- malformed compactor outputs fail closed without losing state;
- recent and summary projections satisfy count, age, and byte bounds;
- no extra model call occurs outside the existing fold.

### Gate C: historical recall

- missing-time summaries are down-ranked, not deleted;
- stale/unknown material requires a current owner query;
- repeat suppression, top-k, total bytes, citations, and deduplication pass.

### Gate D: cache and channel regression

- assembler, Anthropic wire-cache, tool-continuation, image-turn, Telegram recovery, and Agent-room
  verifiers pass;
- stable hashes and breakpoints are byte-identical;
- full repository verification and both relevant Worker dry-runs pass.

### Gate E: controlled rollout, separately authorized

- record rollback versions and private state snapshot;
- apply only the additive migration;
- deploy flags false;
- run a fully synthetic, zero-content canary;
- enable the owner-private freshness gate for one bounded canary;
- inspect content-free metrics only;
- enable imported-summary recency ranking last;
- obtain separate authorization before any model-paid or owner-data-changing action.

The current task stops after this specification is reviewed. It does not authorize Gate A-E
implementation or production rollout.
