# Operia Memory V3 Compatibility Upgrade and Private TG Bot Design

Date: 2026-07-12
Status: Approved design, pending implementation plan

## 1. Objective

Upgrade the current private Operia deployment with the useful changes from
upstream `memory-v2` and add a private Telegram entry point without breaking the
existing deployment contracts.

The result must preserve:

- `memory.example.com` as the primary Operia Worker entry point;
- `mcp.example.com` as the allowlist-controlled MCP gateway;
- the existing D1 database, `default` namespace, and 768-dimensional Vectorize
  index;
- the domain-wide `operia_session` browser login;
- the explicit identity and assistant-persona memory tools;
- Operia and Riddle API profiles, model aliases, and vision routing;
- expressive punctuation, including em dashes and full-width punctuation.

The upgrade also adds:

- a private Telegram bot that shares the same Operia identity, persona, and
  long-term memory;
- deterministic slash commands and Telegram inline menus;
- a separate Command Ledger dashboard at `tgbot.example.com`;
- a persistent right rail linking to existing private control pages.

## 2. Current and Upstream Baselines

The private branch and upstream are sibling continuations of the same v2 base,
not a v1-to-v2 migration.

- Private branch: 11 commits after common commit <COMMIT>.
- Upstream `memory-v2`: 30 commits after the same common commit.
- A merge-tree rehearsal reports six actual conflicts:
  - `README.md`
  - `scripts/verify-assembler.mjs`
  - `src/api/chatCompletions.ts`
  - `src/assembler/blocks.ts`
  - `src/memory/extractPipeline.ts` (modify/delete)
  - `wrangler.toml`

The Telegram implementation is not merged wholesale from upstream `tg-bot`.
That branch lags the latest `memory-v2` line. Its Telegram-specific modules,
migration, tests, and queue behavior are ported onto the reconciled private
branch instead.

## 3. Target Architecture

### 3.1 Primary Worker

`memory.example.com` remains the primary Worker. It owns:

- the OpenAI-compatible chat pipeline;
- memory recall and message ingest;
- nightly dream processing and retention;
- memory REST and MCP endpoints;
- the Operia Admin UI;
- the only scheduled cron triggers.

It absorbs upstream v3-slim behavior while preserving private authentication,
profile, model-routing, vision, and style behavior.

### 3.2 Telegram Twin Worker

`tgbot.example.com` is a separate Worker built from the reconciled codebase.
It owns:

- `POST /tg/webhook`;
- Telegram inbox debounce and queue processing;
- Telegram rolling chat state 的只读投影与 Memory Service Binding 客户端；
- deterministic slash commands and callback handling;
- the Command Ledger HTML and dashboard APIs.

It has no cron triggers. It uses a dedicated Queue because a Cloudflare Queue
has one consumer Worker. It shares the production D1 database and 768-dimensional
Vectorize index with the primary Worker.

### 3.3 Shared State

Both Workers use:

- the same D1 memory records;
- the same `default` namespace;
- the same stable user identity and assistant persona;
- the same long-term Vectorize memory mirror.

Telegram-specific inbox, settings, and event metadata live in separate D1
tables. Rolling state 的物理表继续沿用兼容名称，但读写、折叠、备份、退避和
telemetry 由 Memory Worker 唯一拥有；TG 只能通过私有 Service Binding 获取
投影或提交幂等 turn event。它们不创建第二个对话或长期记忆真源。

### 3.4 Existing Consumers

Operia, Riddle, and the MCP gateway keep their existing URLs, authentication
contracts, model aliases, and namespaces. No consumer migration is required for
the initial release.

## 4. Upstream Merge Policy

### 4.1 Absorb Directly

- v3-slim nightly dream-to-candidate processing;
- dream run observability, manual trigger, retry, and backfill;
- candidate idempotency and proposal-type badges;
- HTTP recall and three-gate recall behavior;
- removal of per-turn LLM memory compression;
- dynamic context movement out of the cached prompt prefix;
- prompt-cache breakpoint and message-mapping fixes;
- vector doctor full-index and D1-backing fixes;
- diary endpoints;
- GitHub daily archive code, left disabled unless explicitly configured.

### 4.2 Preserve Through Compatibility Adapters

- `digest_get` and `digest_set` remain available to current consumers. The
  digest is not automatically injected by v3-slim, but its storage and explicit
  API/MCP access remain supported.
- `memory_extract_dryrun` keeps its public tool name but is adapted to the new
  dream dry-run implementation. The obsolete four-hour extraction pipeline is
  not retained.
- New upstream MCP tools remain hidden at `mcp.example.com` until each is
  explicitly added to the private gateway allowlist after verification.
- The upstream Admin review UI is merged with domain-session login and private
  identity/persona types.

### 4.3 Explicit Exclusions

- Do not adopt `workers-ai/@cf/baai/bge-m3` as the default embedding model.
- Do not change the Vectorize index to 1024 dimensions.
- Do not duplicate the stable persona in `TG_SYSTEM_PROMPT`.
- Do not merge the complete `tg-bot` branch over the reconciled branch.
- Do not expose new MCP tools merely because the upstream Worker advertises
  them.

### 4.4 Private Behavior That Must Survive

- Google Access and domain-session cookie authentication;
- root redirect and stale service-worker cleanup;
- protected health/admin behavior;
- `identity_profile_set` and `assistant_persona_set`;
- Operia and Riddle key profiles and model restrictions;
- public vision aliases required by Riddle;
- no dash-to-comma or stream dash collapsing.

## 5. Embedding Contract

The production embedding contract is fixed for this project:

- model: `workers-ai/@cf/google/embeddinggemma-300m`;
- dimensions: `768`;
- metric: cosine;
- index: the current production Operia Vectorize index.

The override must be consistent in `wrangler.toml`, environment defaults,
setup scripts, runtime fallback values, tests, and README documentation. A
future embedding migration is out of scope.

## 6. Telegram Behavior

### 6.1 Privacy and Identity

- The bot is private and accepts exactly one allowlisted Telegram chat ID.
- Unknown chat IDs receive no response.
- The webhook requires Telegram's secret header.
- The bot shares Operia identity, persona, and long-term memory.
- The previously disclosed Bot token must be revoked and replaced before any
  webhook is registered. It must never enter source, documentation, logs, or
  dashboard output.

### 6.2 Message Flow

1. Telegram sends a text update to `/tg/webhook`.
2. The Worker verifies the webhook secret and chat allowlist.
3. Text messages are inserted into the TG inbox.
4. A dedicated Queue schedules processing after the debounce interval.
5. Pending messages for the chat are atomically claimed and merged.
6. The Twin Worker invokes the complete Operia chat pipeline internally with a
   dedicated API profile.
7. The response is split on blank lines into Telegram bubbles, with safe hard
   splitting above Telegram's message limit.
8. TG 把本轮 user/assistant turn 以稳定 event id 提交给 Memory 私有服务；
   Memory 原子更新 rolling state。达到 50 turns 时由 Memory 的 Workers AI
   compactor 折叠较旧 turns，最近 10 turns 保持 verbatim。

### 6.3 Persona Prompt

Telegram does not keep a second persona secret. The chat pipeline uses the
stable Operia assistant persona and user identity. Telegram adds only stable
format rules for blank-line bubble splitting and safe maximum message length.

## 7. Slash Commands and Inline Menus

Commands are parsed before ordinary message ingest. Command input and callback
payloads do not enter the model, raw chat archive, or long-term memory unless a
specific command intentionally writes memory after confirmation.

Initial BotFather command menu:

- `/start`: welcome, current status, and common inline buttons;
- `/new`: confirm, then clear Telegram rolling state only;
- `/status`: bot, queue, model, and Operia health;
- `/model`: choose from the allowed Telegram model profile;
- `/memory`: show memory status and an Operia Admin link;
- `/remember`: collect text, preview it, and explicitly confirm a long-term
  memory write;
- `/persona`: show a stable-persona summary and Admin edit link;
- `/cancel`: cancel the current pending command or confirmation;
- `/help`: show commands and inline actions.

Destructive long-term memory review, deletion, and bulk editing remain in
Operia Admin. Telegram does not become a second full memory administration UI.

## 8. Command Ledger Dashboard

### 8.1 Visual System

- warm white or white background;
- black body text and gray dividers;
- `#CC7D5E` as the primary accent;
- Noto Serif SC / Source Han Serif SC for Chinese;
- Anthropic Serif Web (the same family used in a private note-vault setup) for
  English, with a serif fallback;
- editorial, paper-like density rather than a conventional blue/black SaaS
  dashboard.

### 8.2 Three-Column Layout

- Left rail: dashboard navigation.
- Center: the active dashboard section.
- Right rail: persistent links to existing control pages and quick health.

On mobile, the left rail becomes horizontal tabs and the right rail moves below
the active content.

### 8.3 Dashboard Sections

The left rail contains:

- Overview
- Commands
- Models and Persona
- Short-term Session
- Runtime Logs
- Security

Overview uses four vertical lanes whose cards stack downward:

- Incoming
- Processing
- Needs Attention
- Completed

The right rail remains visible in all sections and initially links to:

- Operia Admin
- MCP Dashboard
- Operia
- <HOME_DEVICE_A>
- VPS Ops

The link registry supports future entries with title, description, URL, and an
optional health check. It is a navigation layer, not a duplicate of the target
system's administration features.

### 8.4 Dashboard Data and Actions

- Default logs store event type, status, duration, counts, and model metadata,
  not duplicate message bodies.
- Secrets are never displayed by the dashboard.
- Mutating dashboard APIs require a valid Access session, strict Origin checks,
  and CSRF protection.
- Resetting a short-term Telegram session requires confirmation and never
  deletes long-term Operia memory.
- BotFather command synchronization is an explicit authenticated action.

## 9. Cloudflare Access and Application Security

### 9.1 Browser Surface

The dashboard root, admin pages, and dashboard APIs are protected by Cloudflare
Access using the existing Google single-email policy and domain session flow.

### 9.2 Webhook Surface

`POST /tg/webhook` is not browser-authenticated. It is intentionally reachable
by Telegram but protected by:

- the Telegram webhook secret header;
- the single-chat allowlist;
- accepted update and content-type validation;
- fast acknowledgement and idempotent inbox processing.

This public application endpoint does not expose an interactive UI or generic
API capability.

### 9.3 Internal Chat Profile

The Twin Worker calls the Operia chat pipeline through a dedicated application
profile. It does not reuse a browser session or expose the internal credential
to Telegram or the dashboard.

## 10. Data Model

Port upstream migration `0007_tg_bot.sql` for:

- TG inbox rows;
- TG rolling chat state 的兼容物理表（语义 owner 为 Memory Worker）。

Add a new additive migration for:

- global Telegram settings and command enablement;
- per-chat model selection and pending command state;
- dashboard control-link registry;
- bounded runtime event metadata.

Do not alter or duplicate the primary `memories` table for Telegram.

## 11. Release Sequence

1. Record the current Worker version, bindings, routes, secrets names, and MCP
   allowlist. Export production D1 and memory records.
2. Revoke and replace the disclosed Telegram Bot token without storing it in
   project files.
3. Merge upstream `memory-v2` locally and resolve the six conflicts according
   to this specification.
4. Port Telegram-specific code and migrations onto the reconciled branch.
5. Run type checking and the complete verification suite.
6. Deploy a shadow Worker using a D1 copy, a separate 768-dimensional test
   Vectorize index, and test queues.
7. Verify migrations, memory APIs, MCP, Admin, chat, Operia, Riddle, and TG
   behavior against shadow resources.
8. Deploy the primary Worker and verify all existing consumers without config
   changes.
9. Update the private MCP gateway allowlist only for explicitly accepted tools.
10. Apply additive TG migrations, create the dedicated TG Queue, and deploy the
    Twin Worker and Command Ledger.
11. Configure Access for dashboard paths and verify anonymous redirects,
    authenticated domain-cookie access, Origin enforcement, and CSRF handling.
12. Register BotFather commands and the Telegram webhook last.
13. Run private-chat smoke tests for all commands, ordinary chat, memory recall,
    debounce, rolling summary, and rejection of untrusted requests.

## 12. Rollback

### 12.1 Primary Worker

Roll back to the recorded pre-release Worker version. New migrations are
additive and must not remove old tables or columns. The pre-release D1 and
memory exports are the data recovery boundary if new processing has mutated
production records.

### 12.2 Telegram Worker

Delete or disable the Telegram webhook first, then disable the TG Queue
consumer or roll back the Twin Worker. This does not affect the primary memory
service.

### 12.3 Dashboard

The dashboard and its APIs can be rolled back independently of the webhook
message path.

## 13. Acceptance Criteria

### 13.1 Core Memory

- D1 memory counts and namespaces remain consistent.
- Vector records remain 768-dimensional and D1-backed.
- identity and persona records remain readable and writable.
- digest compatibility tools continue to work.
- dream candidates, diary, recall, and vector doctor behave as designed.

### 13.2 Existing Consumers

- Operia chat works without a client configuration change.
- Riddle image requests follow the allowed vision path.
- MCP `tools/list` exposes only the private gateway allowlist.
- Existing allowed MCP tools complete a real smoke call.

### 13.3 Telegram

- untrusted webhook requests are rejected;
- unknown chat IDs receive no reply;
- slash commands do not enter model or memory ingest;
- ordinary messages use the shared Operia persona and memory;
- debounce 与 bubble splitting 正常；50-to-summary-to-10 由 Memory owner 执行，TG 不持有摘要模型或 state 写权限；
- `/new` clears only Telegram short-term state;
- `/remember` requires confirmation before writing memory.

### 13.4 Dashboard and Security

- anonymous dashboard and API requests are intercepted or rejected;
- the existing Google Access login and domain cookie work;
- mutations require valid Origin and CSRF proof;
- secrets never appear in HTML, API output, logs, or documentation;
- the persistent right rail opens the configured private control pages;
- desktop and mobile layouts do not overlap or lose navigation.

## 14. Out of Scope

- a 1024-dimensional Vectorize migration;
- a public or multi-user Telegram bot;
- per-user memory namespaces;
- full long-term memory administration inside Telegram;
- duplication of existing control pages inside Command Ledger;
- enabling GitHub daily archive ingestion without a separate user decision.
