# Operia Conversation Import P0 Design

Date: 2026-07-19

Status: implementation-ready P0 specification; local design only; no production change

Owner: Memory

Coordinator thread: `<UUID>`

## 1. Decision

Operia Memory will import third-party JSON chat exports into a Memory-owned historical archive. The
archive is not a live channel, not a Telegram session, and not a second conversation source of truth.
An import produces three deliberately separate layers:

1. a private, traceable transcript for owner-only search and inspection;
2. one bounded historical summary per imported conversation;
3. reviewable long-term-memory candidates that enter the existing candidate queue and are not durable
   memories until the owner approves, edits, merges, or supersedes them.

Raw transcript messages are never placed in `persona_pinned`, `precious`, `digest`, `boot_stable`, the
pinned/stable system prefix, or the live `tg_chat_state` rolling summary. Imported material can enter a
live turn only through bounded recall after the stable cache breakpoint. Explicitly approved
`identity` or `persona` facts continue to use the existing owner-reviewed profile path.

P0 supports one production adapter only after a synthetic implementation passes all gates. The
adapter framework is multi-source, but adapters are enabled individually. Unknown exports fail closed;
there is no generic best-effort role or timestamp guessing.

## 2. Current implementation evidence

The implementation must extend, not bypass, these existing contracts:

- `migrations/0001_init.sql` owns live `conversations`, `messages`, `memories`, `summaries`,
  `memory_events`, and generic `idempotency_keys`.
- `migrations/0005_memory_candidates.sql` and `src/api/memories.ts` own the pending candidate queue and
  approve, discard, merge, and supersede actions.
- `src/memory/conversationState.ts` owns Telegram's idempotent 50-turn fold with the newest 10 turns
  retained. It is channel state and must not become the import archive or historical summarizer.
- `src/memory/v2/recall.ts` owns per-turn recall and its decay, core de-duplication, score floor, and
  bounded `k` behavior.
- `src/memory/embedding.ts` and the existing Vectorize binding own the current embedding path. The
  project contract remains `workers-ai/@cf/google/embeddinggemma-300m`, exactly 768 dimensions.
- `src/assembler/blocks.ts` already places `dynamic_memory_patch` in a `turn_context` user message
  immediately before the current user message and after all cache breakpoints. This is the only P0
  context-injection location for imported summaries or approved memories.
- `src/assembler/blocks.ts` limits `persona_pinned` to identity, persona, and existing precious input.
  Import code must not append raw or summarized archive material to that block.
- `src/index.ts` and the existing admin shell provide Memory-owned routing and authenticated owner UI.

The live `messages` table is intentionally not reused for imports. Reuse would mix historical archive
timestamps with live inference maintenance, nightly digest inputs, retention, message cursors, and
channel observability.

## 3. P0 scope and non-goals

### In scope

- versioned adapters for supported JSON exports;
- an offline fixture validator and a server-side preview/dry-run path;
- deterministic speaker, timestamp, timezone, content, and locator normalization;
- exact-export and per-conversation/per-message idempotency;
- a resumable import ledger and bounded derived jobs;
- private raw export retention and canonical transcript storage;
- per-conversation summary generation;
- candidate extraction with full provenance and explicit owner review;
- batch deletion and versioned recomputation;
- exactly 768-dimensional embeddings for accepted memories and eligible historical summaries;
- bounded historical-summary recall after the stable cache breakpoint;
- owner UI for preview, mapping, progress, review, recompute, and delete.

### Out of scope for P0

- importing arbitrary unknown JSON with heuristics;
- binary attachment upload, OCR, audio transcription, image understanding, or link fetching;
- embedding every raw message;
- automatically promoting any candidate, including identity/persona;
- using imported history as the live conversation tail or Telegram short-session summary;
- changing model providers, enabling a provider, paid smoke tests, Cloudflare routes, production
  deployment, or owner cutover;
- cross-user or public archive access;
- raw transcript access from Agent, Telegram, Operia, Xiaozhi, MCP clients, or URLs.

## 4. Invariants

1. **Memory is the sole owner.** Adapters, archive, ledger, derivation, review, deletion, and recall are
   implemented in the Memory Worker and Memory storage.
2. **Preview has zero durable writes.** Preview performs no D1, R2, Vectorize, Queue, model, cache, or
   memory write. The response is `Cache-Control: no-store` and logs contain counts and hashes only.
3. **Commit revalidates bytes.** The import request re-uploads the file and supplies the preview digest.
   The server reparses it and rejects a digest or options mismatch; it does not trust client preview
   output.
4. **No guessing.** Unknown speaker, missing naive-time timezone, invalid timestamps, hidden prompts,
   secrets, and unsupported payloads remain errors or quarantined items until the owner chooses a
   mapping or exclusion.
5. **No raw-vector path.** Raw messages are not embedded and do not enter ordinary memory recall.
6. **No automatic stable-prefix mutation.** Imported summaries and candidates never set `pinned=1` and
   never create `identity`, `persona`, `precious`, `digest`, or glossary records automatically.
7. **All derived records are reproducible.** A summary, candidate, or vector records an input-set hash,
   algorithm/model identifier, version, and source locators.
8. **Deletion is provenance-aware.** Removing one batch cannot delete a fact supported by another batch,
   a live message, or an owner edit.
9. **Logs are content-free.** Logs and events contain IDs, counts, durations, status codes, and truncated
   SHA-256 digests, never transcript text, titles, participant names, prompts, attachment names, or
   source IDs.
10. **Every bound is enforced server-side.** UI limits are advisory; server limits control bytes,
    conversations, messages, text length, jobs, retries, summaries, candidates, recall hits, and prompt
    characters.

## 5. Canonical adapter contract

### 5.1 Interface

Create `src/memory/import/adapters/types.ts` with this conceptual contract:

```ts
interface ConversationImportAdapter {
  id: string;                 // e.g. "chatgpt"
  version: string;            // immutable parser behavior, e.g. "1.0.0"
  detect(input: JsonValue): AdapterDetection;
  preview(input: JsonValue, options: PreviewOptions): ImportPreview;
  normalize(input: JsonValue, options: ConfirmedImportOptions): ConversationArchiveV1;
}
```

`detect` may identify a source only from structural markers. It must not examine hidden fields as
instructions. If zero or multiple adapters meet the confidence threshold, return
`unsupported_source` or `ambiguous_source`.

Each adapter has its own module and fixture directory. Adapters may map documented fields only. A new
source or export revision requires a new fixture and adapter version; it does not silently alter an old
version.

### 5.2 `ConversationArchiveV1`

```ts
interface ConversationArchiveV1 {
  schemaVersion: "conversation-archive/v1";
  sourceApp: string;
  adapter: { id: string; version: string };
  export: {
    blobSha256: string;
    canonicalSha256: string;
    byteCount: number;
  };
  mapping: {
    ownerParticipantKey: string;
    assistantParticipantKeys: string[];
    otherParticipantRoles: Record<string, "other" | "unknown">;
    defaultTimezone: string | null;
  };
  conversations: CanonicalImportedConversation[];
  quarantine: QuarantinedItem[];
  warnings: ValidationIssue[];
}
```

A canonical message contains:

- source conversation and message locator hashes, never public raw IDs;
- source parent locator hash when a branch structure exists;
- stable sequence index within the selected branch;
- participant key and canonical role: `owner | assistant | other | system | tool | unknown`;
- original timestamp string, source timezone, resolved IANA timezone, and UTC instant;
- content type: `text | markdown | code | attachment_reference | mixed | unsupported`;
- normalized UTF-8 text and content SHA-256;
- attachment metadata references only: media type, byte count if declared, and a source-local locator
  hash; never fetched content in P0;
- hidden/system flag and quarantine reason when applicable;
- deterministic message fingerprint.

The archive preserves branches instead of flattening them invisibly. P0 imports the adapter-declared
active branch and records excluded branch counts. A later branch selector can be additive.

### 5.3 Normalization rules

- Decode UTF-8 strictly; reject invalid encoding, top-level non-JSON, JSON Lines, ZIP, and compressed
  input in P0.
- Reject prototype keys (`__proto__`, `constructor`, `prototype`) during structured traversal.
- Normalize line endings to LF and Unicode to NFC. Preserve meaningful whitespace inside code blocks;
  trim only adapter-defined presentation padding.
- Preserve the original text only in owner archive storage. Hashing uses the normalized canonical
  representation, not model-cleaned or summarized text.
- A source message ID is a locator, not authority. Duplicate source IDs with different content are a
  hard validation error.
- Unsupported binary/base64 bodies, credential-shaped fields, hidden prompts, internal tool state, and
  opaque metadata are quarantined. They are not copied into transcript text or passed to a model.
- P0 hard defaults: 25 MiB file, 1,000 conversations, 100,000 messages, 200,000 characters per message,
  and 2,000 quarantined items. All limits are configurable downward and fail with a typed error rather
  than truncating silently.

## 6. Speaker and timezone mapping

### Speaker mapping

Preview lists participant keys, source labels, source-declared roles, and message counts. Labels are
owner-visible private data and are not logged. Import cannot proceed until exactly one participant key
maps to `owner`; zero or multiple owner mappings are rejected.

Source-declared assistant participants may be preselected, but the owner confirms them. `system`,
`tool`, `other`, and `unknown` content is archived but excluded from candidate extraction by default.
Hidden system/developer prompts are quarantined and never summarized or embedded.

Role mapping is stored as a frozen batch snapshot. Changing it creates a recomputation revision; it
does not mutate previous derivation provenance in place.

### Timezone mapping

Every message retains `original_timestamp`. Offset-aware timestamps convert directly to UTC and retain
their original offset. Naive timestamps require a valid IANA timezone selected in preview. A source
timezone can be accepted as the default, overridden by the owner, or mapped per conversation.

Invalid and nonexistent DST local times are hard errors. Ambiguous DST folds require an explicit
`earlier | later` choice and generate a warning recorded in the batch. Date-only values remain
`precision=date`; they are not invented as midnight facts for candidate extraction. Messages with no
usable time remain ordered by source sequence and have `occurred_at_utc=null`; summaries must state
that time precision is unavailable when relevant.

## 7. Deterministic hashes and idempotency

Use SHA-256 with domain-separated, length-prefixed canonical fields. Never use JSON object insertion
order or a non-cryptographic hash.

- `blob_sha256 = SHA256(raw bytes)` detects an exact replay.
- `preview_digest = SHA256("operia-import-preview-v1", blob_sha256, adapter id/version,
  canonical options JSON, preview counts and validation result)` binds confirmation to preview.
- `conversation_fingerprint = SHA256("operia-import-conversation-v1", namespace, source app,
  source conversation locator hash or canonical conversation content hash)`.
- `message_fingerprint = SHA256("operia-import-message-v1", namespace, source app,
  conversation fingerprint, source message locator hash or source sequence, canonical role,
  original timestamp, resolved UTC instant, content type, content SHA-256)`.
- `summary_input_hash` hashes the ordered active message fingerprints plus speaker/time mapping
  revision and summarizer version.
- `candidate_input_hash` hashes the summary input hash, extractor version, extraction policy version,
  and source-message fingerprint set.

Exact replay returns the existing batch. A different export with overlapping messages creates a new
batch only for new raw provenance while canonical message rows are reused through batch-message link
rows. An idempotency key is mandatory for every mutation, but semantic fingerprints remain the final
deduplication authority.

## 8. Storage and migration

Implementation should claim the next free migration number at implementation time. At the current
head this would be `migrations/0025_conversation_import.sql`, but the coordinator may reserve a newer
number if another workstream lands first.

### 8.1 Private raw objects

Add a private R2 binding such as `MEMORY_ARCHIVE`; the bucket has no public route. Object keys use an
opaque batch UUID and random suffix, not titles, participant names, source app IDs, timestamps, or
conversation IDs. Store original bytes once, plus a small content-free manifest containing hash,
bytes, adapter, and encryption/storage version. APIs never return the raw object key to clients.

Preview does not write R2. Confirmed import writes R2 before setting a batch to `archived`. If D1
commit fails, delete the just-created object as compensation. If compensation fails, emit a
content-free orphan cleanup event.

### 8.2 D1 tables

Use dedicated import tables, not live `messages` or `summaries`:

#### `conversation_import_batches`

- `id` primary key; `namespace`; `source_app`; `adapter_id`; `adapter_version`;
- `blob_sha256`; `canonical_sha256`; `preview_digest`; `raw_object_ref` (server-only);
- frozen `speaker_map_json`, `timezone_map_json`, `mapping_revision`;
- `status`: `creating | archived | deriving | ready | partial | failed | deleting | deleted`;
- bounded counts, warning/quarantine counts, current cursor, typed `error_code` only;
- derivation policy/model/version fields; created, updated, completed, deleted timestamps;
- unique `(namespace, blob_sha256, adapter_id, adapter_version)`.

#### `conversation_import_conversations`

- canonical conversation ID and namespace;
- `conversation_fingerprint`, private source locator hash, private title, selected branch hash;
- start/end UTC, original time precision, message count, status;
- unique `(namespace, conversation_fingerprint)`.

#### `conversation_import_batch_conversations`

- batch/conversation link with source order and inclusion status;
- primary key `(batch_id, conversation_id)`.

#### `conversation_import_messages`

- canonical message ID and namespace;
- conversation ID, `message_fingerprint`, private source locator hash, parent locator hash, sequence;
- participant key, canonical role, original timestamp, source/resolved timezone, UTC instant, precision;
- content type, private normalized text, content hash, attachment-reference JSON, quarantine status;
- unique `(namespace, message_fingerprint)` and index `(conversation_id, sequence)`.

#### `conversation_import_batch_messages`

- batch/message link with source order and active flag;
- primary key `(batch_id, message_id)`.

#### `conversation_import_summaries`

- ID, namespace, conversation ID, status and bounded summary text;
- `summary_input_hash`, summarizer model/provider reference, prompt policy version, summarizer version;
- source first/last UTC, source message count, vector ID, vector status, created/updated timestamps;
- unique `(conversation_id, summary_input_hash, summarizer_version)`.

#### `conversation_import_jobs`

- ID, namespace, batch ID, kind: `normalize | summarize | extract | vectorize | recompute | delete`;
- deterministic `job_key`, status, cursor, attempt, lease, input hash, version, counts, typed error;
- unique `(namespace, job_key)`.

#### `memory_candidate_provenance`

- candidate ID, import batch/conversation/message IDs, extractor version, candidate input hash;
- source timestamps, conflict class, sensitivity class, created timestamp;
- primary key across candidate and source message.

#### `memory_provenance`

- memory ID, provenance kind, import batch/conversation/message IDs or other supported source locator;
- candidate ID, content hash at promotion, extractor/reviewer version, created timestamp;
- supports multiple independent sources for one memory.

#### `conversation_import_events`

- append-only, content-free audit: actor kind/hash, action, batch/job IDs, status, count metadata JSON,
  request/trace/idempotency IDs, created timestamp.

Do not add raw text to `memory_events`, `conversation_events`, generic logs, or error columns.

### 8.3 Transaction boundaries

Normalize an import into bounded chunks. Each D1 batch transaction inserts canonical rows, links them
to the import batch, advances a cursor, and writes an audit event. Replays use `INSERT OR IGNORE` plus
post-read hash comparison; an existing fingerprint with different canonical fields is a corruption
error, not a last-write-wins update.

## 9. Import and derivation state machine

```text
local file
  -> preview (memory only, no writes, no model)
  -> confirm + re-upload
  -> R2 owner archive + D1 batch creating
  -> bounded normalize/link chunks
  -> archived
  -> summarize jobs
  -> extract candidates
  -> vectorize eligible summaries
  -> ready | partial | failed
```

Jobs are at-least-once and idempotent. A lease expiry permits resume from the last committed cursor.
The normalize job may parse the confirmed raw JSON as one file only within the 25 MiB P0 hard limit;
it then commits canonical conversations/messages in bounded D1 chunks. All later derivation jobs read
one bounded canonical conversation or message window from D1 and never reload the full export. A
single bad conversation marks that conversation failed and the batch `partial`; it does not silently
skip it or roll back already verified conversations.

P0 default concurrency is one batch per namespace, one conversation derivation at a time, and bounded
message chunks. Retry only transient errors. Parser validation, mapping ambiguity, dimension mismatch,
and hash collision are terminal until owner action.

## 10. API contract

All endpoints are Memory-owned, return `Cache-Control: no-store`, require an authorized domain session
or a dedicated Memory API profile, enforce namespace scope, validate `Origin`, and require CSRF for
cookie-authenticated mutations. Write actions require `memory:write` plus `Idempotency-Key`; raw
transcript read/download requires a new narrower `conversation_import:raw_read` authority and must not
be granted to ordinary Agent or channel profiles.

### Preview and create

- `POST /v1/conversation-imports/preview`
  - multipart JSON file plus optional adapter, speaker map, timezone map, and branch selection;
  - no durable write and no model call;
  - returns adapter/version, counts, participants, time range/precision, unsupported/quarantined field
    summaries, mapping requirements, validation errors, `blob_sha256`, and `preview_digest`;
  - never echoes full transcript or hidden fields; sample rows are opt-in, owner-only, and tightly
    bounded.
- `POST /v1/conversation-imports`
  - re-uploads the same file with confirmed mappings, branch selection, `preview_digest`, and
    `Idempotency-Key`;
  - returns `202` with batch status, counts, duplicate/reused flags, and next action;
  - no model call in the request path.

### Inspect and search

- `GET /v1/conversation-imports?status=&cursor=&limit=` lists content-free batch summaries.
- `GET /v1/conversation-imports/:batchId` returns status, counts, warnings, versions, jobs, and
  derivation state.
- `GET /v1/conversation-imports/:batchId/conversations?cursor=&limit=` lists private titles and time
  ranges for the owner.
- `GET /v1/conversation-imports/:batchId/conversations/:conversationId/messages?cursor=&limit=` returns
  owner-only transcript pages. Default page size 50, maximum 200.
- `POST /v1/conversation-imports/search` performs owner-only bounded text search over canonical
  transcript rows and returns cited message locators. It is not exposed through MCP in P0.
- `GET /v1/conversation-imports/:batchId/candidates` filters the existing candidate queue by provenance.

### Derive, recompute, and delete

- `POST /v1/conversation-imports/:batchId/derive` queues summaries/candidates/vectors with explicit
  versions and a dry-run option. `dry_run=true` reports the plan and makes no write or model call.
- `POST /v1/conversation-imports/:batchId/recompute` accepts
  `scope=summaries|candidates|embeddings|all`, expected source/version hashes, and an idempotency key.
- `DELETE /v1/conversation-imports/:batchId` requires typed owner confirmation in UI, current revision
  via `If-Match`, and idempotency key. It returns an asynchronous deletion plan and job ID.

Mutation responses include batch revision. Stale revisions return `409`, never overwrite concurrent
mapping, review, recompute, or deletion work.

## 11. Summary and candidate derivation

### Historical summaries

Summaries are per canonical conversation, not per export file. The summarizer input contains only the
owner-visible normalized text of selected roles, bounded message windows, UTC/time-precision metadata,
and prior partial summary when chunking is required. Hidden/system/tool/quarantined content is absent.

The prompt requires a neutral historical summary, explicit uncertainty, preserved commitments and
unresolved topics, no new facts, no diagnosis, no persona mutation, and a hard output limit. P0 target
is at most 1,500 Chinese characters or 4,000 UTF-8 characters, configurable downward. Long
conversations use deterministic chronological chunks and a final bounded fold; every stage records its
input hash.

### Candidate extraction

The extractor receives the bounded summary plus cited canonical messages, never the complete export.
Allowed candidate categories are existing canonical memory types such as `fact`, `preference`,
`relationship`, `boundary`, `habit`, `decision`, `event`, and `note`. Identity and persona suggestions
may be shown as a special conflict/sensitivity class but remain pending and cannot be auto-approved.

Every candidate uses `source="conversation_import"`, remains `pending`, and records:

- batch, conversation, and cited message IDs;
- source app and time range;
- extractor model/provider reference and immutable version;
- candidate input/content hash;
- confidence, sensitivity class, conflict class, and a proposed stable `fact_key` when safe.

Before insertion, compare against pending candidates and active memories by fact key and normalized
content. A match adds provenance rather than another candidate. A contradiction creates a conflict
candidate and never supersedes automatically.

Existing approve, merge, and supersede actions must be extended to copy candidate provenance into
`memory_provenance` atomically with the memory mutation. Approved ordinary memories use the existing
retention and recall rules. Owner-selected identity/persona follows the existing profile tool/API path
and is the only route by which an imported fact can eventually affect `persona_pinned`.

## 12. Embedding and recall contract

### Embeddings

- Raw messages and raw exports are never embedded.
- Pending candidates are not embedded.
- Approved memories continue through the existing memory vector path.
- Ready historical summaries may be embedded with Vectorize metadata
  `kind="conversation_import_summary"`, namespace, summary ID, conversation fingerprint, status,
  input hash, source app, time range, and version. Metadata contains no summary text, title,
  participant name, or raw source locator.
- Before every upsert, assert `vector.length === 768` and every value is finite. A mismatch fails the
  vector job with `embedding_dimension_mismatch`; it does not truncate, pad, or write.
- Vector IDs are deterministic from summary ID plus summary input hash. Recompute writes the new vector
  first, updates D1 by revision, then deletes the obsolete vector best-effort; vector doctor cleans any
  orphan.

### Historical recall

Add a separate `searchImportedSummaries` path. Do not make ordinary memory search interpret summary
vectors as `memories` rows. `runRecall` may call both paths but returns distinct provenance:

```ts
type HistoricalSummaryHit = {
  id: string;
  content: string;
  score: number;
  source_layer: "conversation_import_summary";
  citation: { sourceApp: string; conversationId: string; timeRange: string | null };
};
```

Default bounds are at most two historical summaries, 1,200 total injected characters, a separate
minimum score, and no raw-message fallback. De-duplicate against approved memory hits and the current
live conversation. Mark the source as historical and include a stable citation label in the injected
text so the model can qualify old or conflicting information.

In `src/assembler/blocks.ts`, imported summary hits join `dynamic_memory_patch` or a new adjacent
`historical_summary_patch`, both with `kind="turn_context"`. They must appear after system and message
cache breakpoints and immediately before `current_user`. Add an assertion and verifier fixture proving:

- no import text appears in `system_blocks`, `persona_pinned`, or `boot_stable`;
- all historical hits appear after the last cache breakpoint;
- identical stable inputs retain the same `client_system_hash` with or without historical recall;
- recall is bounded and includes citation/provenance.

## 13. Delete and recompute semantics

Deletion runs from links and provenance, not string matching:

1. mark the batch `deleting` and prevent new derive jobs;
2. cancel or fence active jobs by batch revision;
3. remove the private R2 raw object and record its verified absence;
4. deactivate batch-message and batch-conversation links;
5. delete canonical messages/conversations only when no active batch link remains;
6. invalidate summaries whose input set changed; delete their vectors and either recompute from
   remaining sources or mark withdrawn;
7. withdraw pending candidates supported only by the deleted batch;
8. remove this batch's candidate and memory provenance links;
9. for an accepted memory, preserve it if any other provenance remains;
10. if the deleted batch was the sole provenance and the memory still equals the promoted content
    hash, soft-delete/archive it and delete its vector;
11. if the memory was owner-edited or merged after promotion, preserve it, mark
    `review_reason="source_deleted_after_owner_edit"`, and surface it for owner review;
12. mark the batch `deleted` with content-free counts. Keep the tombstone ledger and hashes for replay
    protection, but no transcript, title, participant, or raw object reference.

Recompute never updates an old derived row in place. It writes a new version keyed by input hash,
atomically activates it, retires the old version, and records an audit event. Owner decisions on old
candidates are retained for audit; equivalent new candidates may reuse the prior decision only after
an explicit owner option, never by default.

## 14. Owner UI

Add a Memory Console section, not a Telegram or Agent panel:

1. **Select JSON:** local file name/size, detected source, privacy notice, and explicit statement that
   preview performs no upload retention or model call.
2. **Preview:** conversations, messages, participants, time range/precision, unsupported/quarantine
   counts, validation errors, branch selection, speaker mapping, and IANA timezone mapping.
3. **Confirm import:** summary of durable writes, raw-retention policy, derivation disabled/enabled
   choice, and exact preview digest. Confirmation re-uploads the file.
4. **Progress:** batch state, chunk counts, per-conversation failures, job versions, retry/recompute.
5. **Archive browser:** owner-only paginated transcript and search with source/time citations.
6. **Summary review:** per-conversation summary, provenance, regenerate action, and vector state.
7. **Candidate review:** reuse the existing approve/edit/discard/merge/supersede controls with import
   provenance, conflict, and sensitivity badges.
8. **Delete:** impact preview showing raw object, canonical rows, summaries, candidates, accepted
   memories to archive, and owner-edited memories to preserve/review. Require typed batch label and
   current revision.

Never persist the selected raw JSON, preview transcript, or participant labels in browser localStorage.
Do not put file names, titles, locators, hashes representing transcript content, or batch options in
query strings. Clear file inputs and preview state after import, navigation, timeout, or failure.

## 15. Implementation file plan

The implementation worktree should be isolated before edits. Expected files:

- migration: next free `migrations/00xx_conversation_import.sql`;
- `src/memory/import/types.ts` and `canonicalize.ts`;
- `src/memory/import/adapters/types.ts`, registry, and one adapter module;
- `src/memory/import/hashes.ts`, `limits.ts`, `ledger.ts`, `archiveStore.ts`, `jobs.ts`;
- `src/memory/import/summarize.ts`, `extractCandidates.ts`, `provenance.ts`, `delete.ts`;
- `src/memory/import/searchSummaries.ts` and vector helpers;
- `src/api/conversationImports.ts` and Memory-owned routes in `src/index.ts`;
- an import section/component in `src/api/admin.ts` or a dedicated Memory admin page module;
- additive types/bindings in `src/types.ts` and local/dry-run Wrangler config only after coordinator
  review;
- `fixtures/conversation-import/<adapter>/` containing synthetic accepted and rejected exports;
- `scripts/verify-conversation-import.mjs` plus updates to assembler and wire-cache verifiers.

Shared files (`src/index.ts`, `src/types.ts`, `src/api/admin.ts`, assembler, Wrangler files, package
scripts) require coordinator sequencing before implementation.

## 16. Fixtures and offline validator

All repository fixtures are synthetic and contain no real names, handles, domains, tokens, private
prompts, or copied chat text.

Required fixtures:

- minimal valid export with owner and assistant;
- multiple conversations and deterministic ordering;
- exact replay and reordered JSON keys;
- partial overlap across two exports;
- branch structure with active and excluded branches;
- naive timestamps with valid timezone;
- offset-aware timestamps;
- ambiguous and nonexistent DST times;
- missing timestamps and date-only precision;
- duplicate source ID with identical content and with conflicting content;
- unknown participants and multiple possible owners;
- system/tool/hidden prompt quarantine;
- base64/binary and attachment-reference quarantine;
- invalid JSON, oversized file/message, excessive nesting, and prototype keys;
- secrets-shaped unsupported fields proving content does not reach logs/model inputs;
- long conversation summary chunking;
- conflicting candidate and sensitive identity/persona candidate;
- batch deletion with shared and sole provenance;
- recompute with changed adapter/summarizer/extractor versions;
- embedding vector length 767, 768, and 769;
- historical recall below/above score floor and over character budget.

The offline validator accepts a fixture path and options, prints only content-free counts/hashes by
default, and supports `--show-synthetic-preview` only for repository synthetic fixtures. Exit codes are
stable: valid, mapping-required, unsupported-source, invalid-export, limit-exceeded, and internal error.

## 17. Verification and acceptance gates

### Gate A: contract and parser

- `npm run typecheck` passes.
- `node scripts/verify-conversation-import.mjs` passes all synthetic fixtures.
- Preview twice produces byte-identical normalized metadata and digests.
- Preview leaves D1, R2, Vectorize, Queue, logs, and model stubs unchanged.
- Unsupported/ambiguous exports and mappings fail closed with typed errors.

### Gate B: synthetic idempotent archive

- Local D1 migration applies twice safely in fresh databases/worktrees according to the repository's
  migration practice.
- Exact replay returns the same batch and creates zero new canonical/link rows.
- Overlapping exports reuse message rows and add only provenance links/new messages.
- Interrupted normalization resumes from the committed cursor without duplicates.
- Raw object is private and no API/log exposes its key or content.

### Gate C: synthetic derivation and review

- Summary input excludes quarantined/system/tool content and respects hard input/output bounds.
- Re-running identical versions produces no duplicate summary or candidate.
- Every candidate is pending and has complete provenance.
- Identity/persona/conflict/sensitive candidates require owner review.
- Approve/merge/supersede copies provenance atomically and creates exactly one 768-dimensional vector
  for the resulting active memory.

### Gate D: delete and recompute

- Deleting one overlapping batch preserves shared transcript rows and multi-source memories.
- Sole-source untouched memories are soft-deleted and their vectors removed.
- Owner-edited memories are preserved and flagged for review.
- Recompute activates only the new input/version hash, removes or retires stale vectors, and remains
  replay-safe after interruption.

### Gate E: cache-safe context integration

- `node scripts/verify-assembler.mjs` and `node scripts/verify-anthropic-wire-cache.mjs` pass after their
  contract mirrors are updated.
- Imported raw text never appears in the stable system prefix.
- At most two cited summaries and the configured character budget appear in turn context.
- Stable prefix hash and cache breakpoints are identical with recall on and off.
- Agent and Telegram receive only the bounded turn-context projection, never transcript APIs or raw
  object references.

### Gate F: rollout, outside this workstream's current authorization

Only after A-E:

1. coordinator reviews schema/API/shared-file changes and security posture;
2. deploy disabled with `CONVERSATION_IMPORT_ENABLED=false` and no adapter enabled;
3. run a synthetic production-path import with no model/provider call;
4. enable one adapter for the owner only;
5. import one separately prepared redacted real-export canary after explicit owner approval;
6. review summaries/candidates/deletion plan manually;
7. enable bounded historical recall last;
8. preserve rollback flags for ingest, derivation, and recall independently.

No current step authorizes Gate F.

## 18. Rollback

Use three independent flags:

- `CONVERSATION_IMPORT_ENABLED=false` blocks preview/commit UI and API;
- `CONVERSATION_IMPORT_DERIVATION_ENABLED=false` stops new summary/extractor/vector jobs but preserves
  owner archives and owner access;
- `CONVERSATION_IMPORT_RECALL_ENABLED=false` excludes imported summaries from live recall without
  deleting archives, summaries, approved memories, or provenance.

Rollback never drops migration tables. It fences jobs, disables read projections, and leaves the
ledger available for audit and later recovery. Batch deletion remains available to the owner even when
new imports are disabled.

## 19. Strict P0 completion definition

P0 is complete only when all of the following are true:

- one named adapter and its versioned synthetic fixtures pass offline and local Worker validation;
- preview is proven zero-write and zero-model;
- archive/import replay and overlap are idempotent;
- private transcript, historical summary, and candidate layers are visibly separate;
- every candidate and accepted memory has queryable provenance;
- deletion and recompute pass shared/sole/owner-edited provenance cases;
- embeddings are exactly 768 dimensions and dimension errors fail closed;
- imported recall is cited, bounded, after the cache breakpoint, and absent from pinned/stable prefix;
- no production change occurred until the coordinator and owner authorize the corresponding rollout
  gate.
