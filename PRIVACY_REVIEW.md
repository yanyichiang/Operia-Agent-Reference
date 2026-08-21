# Privacy & Sensitivity Review — Operia Agent Reference

This repository is a **sanitized architecture reference** derived from the private `Operia-Agent` engineering origin. Before switching it from **private** to **public**, verify every item below.

## Status

| Date | Action |
|---|---|
| 2026-08-21 | Created clean export with no Git history from the private origin. |
| 2026-08-21 | Scanned against the GPT-produced denylist; replaced or redacted literal identifiers, infrastructure names, commit hashes, branch names, and third-party archive references. |

## ✅ Already scrubbed

| Category | Action |
|---|---|
| Git history | New repo created from a working-tree export; no private origin refs, branches, or commit metadata are carried over. |
| Direct identifiers | Hard-coded admin email in `src/auth/domainSession.ts` replaced with `admin@example.com`. |
| Real name / owner handle | Replaced with `Owner` in specs and source prompts. |
| Local usernames / home paths | Replaced with `<USER>` and `/home/<USER>`. |
| Real-time domain | Production domain replaced with `example.com`. |
| Session protocol | The three previous production session-protocol identifiers (secret name / cookie name / header name) replaced with `OPERIA_SESSION_SECRET` / `operia_session` / `x-operia-session`. |
| Cloudflare / Worker version UUIDs | All literal UUIDs replaced with `<UUID>`. |
| Infrastructure service names | `aelios-*` Worker/queue/bucket names replaced with placeholders such as `<MEMORY_SERVICE>`, `<TG_SERVICE>`, `<HEALTH_RAW_BUCKET>`, etc. |
| Internal protocol headers | `x-aelios-*` replaced with `x-operia-*`. |
| Project branding in prose | `Aelios` references in body text replaced with `Operia`. File names still contain the old prefix for link stability; see review list below. |
| Constants / signing contexts | `AELIOS_*` constants and `AELIOS-COMMUNITY-SKILL-MANIFEST-V1` replaced with `OPERIA_*` equivalents. |
| GitHub attachment links | Image attachment URLs redacted. |
| Branch names in docs | Internal `codex/*` branch references replaced with `<BRANCH>`. |
| Commit hashes | Internal 40-character and short commit hashes replaced with `<COMMIT>`. |
| Operational notes | References to private note-vault tools replaced with generic wording. |
| Archive wording | `private archive` changed to `owner archive`. |
| Third-party archive source | A third-party chat-archive adapter renamed to `LegacyChat`; upstream commit replaced with `<UPSTREAM_COMMIT>`. |
| Timezone literals | `Asia/Shanghai` / `Asia/Singapore` removed from source and example config; neutral placeholders used. |

## ⚠️ Review required before going public

### 1. File names still contain old prefix
Many `docs/superpowers/` files are named `2026-XX-XX-aelios-...md`. The body text has been sanitized, but the file names retain the old project codename. They do not expose real infrastructure, but you may want to rename them to `operia-` for consistency. Renaming will also require updating internal cross-references.

### 2. API key / token / bearer variable names
The source code and specs contain many environment variable names like `TG_BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `*_BEARER`, `*_SECRET`, `HOME_ASSISTANT_ACCESS_TOKEN`, etc. These are **configuration template names**, not secret values. They are intentionally kept so the architecture is understandable. Make sure no literal values accompany them.

### 3. Health / Calendar / Note source code
The following source domains are excluded entirely:
- `src/calendar`
- `src/health`
- `src/note`
- `src/tg/private`

Some included files still import types or reference these domains (e.g., `src/tg/calendarClient.ts`, `src/tg/healthClient.ts`, `src/tg/miniAppApi.ts`). These references are type-only and do not contain personal data, but they create broken imports if you try to compile the repo. This is acceptable for an architecture reference.

### 4. Implementation-detail specs
Resolved in the release-gate round: operational/production/QA/incident spec documents and the entire `plans/` directory were removed. The remaining specs are architecture and design documents.

### 5. Third-party vendored code
Verified on 2026-08-21: no Dwell-derived files or snippets remain (`dwell` / `polyform` scans over source return zero hits). The vendored directory was excluded at export time.

### 6. License scope
Satisfied by the root `NOTICE`: it separates the upstream foundation from Operia contributions and lists excluded components. The upstream foundation is GNU AGPL v3.0 (`LICENSE`, changed from MIT by the upstream author on 2026-08-21); the Operia contributions are PolyForm Noncommercial 1.0.0 (`LICENSE-OPERIA`). Where an Operia contribution derives from upstream AGPL code, the AGPL additionally governs that file.

## Recommended final checks

Status: executed on 2026-08-21 against the final tree and full history with zero unexpected findings. Re-run after any future sync from the private origin:

```bash
# Direct identifiers
grep -R -E -o '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' . | grep -v example.com

# UUIDs
grep -R -E -o '\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b' .

# Real Cloudflare account / API key / token patterns
grep -R -E -o '(sk|pk|ghp|gho|ghu|ghs|ghr|xai|hf|AKIA|SG)[-_][A-Za-z0-9]{16,}' .

# Domain that should no longer appear
grep -R -i '<REAL_DOMAIN>' .

# Private origin repo handle
grep -R -i '<OWNER>/Operia-Agent' .

# Private third-party component
grep -R -i 'dwell\|polyform' .
```

## Decision log

| Date | Decision | Owner |
|---|---|---|
| 2026-08-21 | Clean export created; literal identifiers and infrastructure names redacted | Kiri |
| 2026-08-21 | Ox review round: replaced hardcoded production Telegram bot usernames with `<OWNER_BOT_USERNAME>` / `<CODEX_BOT_USERNAME>` placeholders (5 sites); rewrote session-protocol and archive-source rows to remove real domain/vendor names from this file; renamed placeholder class `<AgentRuntime>` back to valid identifier `OperiaAgentRuntime` (6 sites); migrated sanitized `src/types.ts` and `src/controlRegistry.ts` (all `*.example.com` domains); added sanitized `wrangler.example.toml` with placeholder account/database IDs | Ox |
| 2026-08-21 | Ox release-gate round (per external review): removed 14 operational/production/QA/incident spec docs and the entire `plans/` directory; redacted home-infrastructure vocabulary (build-server hostname, household device names) from remaining design docs; generalized residual note-vault references; replaced local bridge tool name with `<LOCAL_CODEX_BRIDGE>`; rewrote bearer-key auth to constant-time table-driven comparison via `secretEqual`; added explicit not-a-starter-template contract to README | Ox |
| 2026-08-21 | Licensing change: Operia contributions layer relicensed from MIT to PolyForm Noncommercial 1.0.0 via new `LICENSE-OPERIA` (noncommercial use with attribution; commercial use requires separate license). Upstream Aelios foundation remains MIT, unchanged. NOTICE / README / this review updated accordingly | Ox |
| 2026-08-21 | Upstream relicensing: the Aelios foundation layer changed from MIT to GNU Affero General Public License v3.0 by the upstream author; root `LICENSE` replaced with the AGPL-3.0 text, NOTICE sections 1-2 and README updated to describe the two-layer structure (upstream AGPL + Operia PolyForm NC) and the derivative-work boundary | Ox |
| | | |
