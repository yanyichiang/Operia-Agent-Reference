# Operia Agent Reference

A sanitized, stable-architecture snapshot of the private **Operia Agent** project.

> **Status:** Private preview. We will switch this repository to public only after the privacy review in [`PRIVACY_REVIEW.md`](./PRIVACY_REVIEW.md) is complete.

## What this is

Operia Agent is a personal, persistent agent runtime built on Cloudflare Workers. This reference repository contains the stable architectural layers and design specs that are safe to share with collaborators, without any production credentials, personal data, or experimental features that have not yet been validated.

Experimental work stays in the private upstream repository and is merged here via pull requests once it has passed review.

## What is included

- **Architecture specs** — `docs/superpowers/specs/`: control-plane, memory, Telegram, tool-loop, browser, voice, and observability designs.
- **Core source modules** — `src/`:
  - `agent/` — Agent core, approval workflows, browser tools, sandbox runtime, skills, tool planning, and side-effect repository.
  - `api/` — Chat completions, gateway broker, control pages, conversation imports, and Think wake endpoints.
  - `assembler/` — Context assembly and prompt blocks.
  - `auth/` — Domain session verification and API-key authentication.
  - `config/` — Key profiles and public model catalog.
  - `control/` — Control-plane registry and owner store.
  - `db/` — Shared database schemas and access patterns.
  - `memory/` — Legacy, v2, and vNext memory systems, recall, episodic extraction, Think harness, and import adapters.
  - `preset/` — History preprocessing and regex/stream filters.
  - `proxy/` — OpenAI/Anthropic-compatible model adapters and streaming.
  - `publication/` — Publication lifecycle, delivery authority, and shadow comparisons.
  - `queue/` — Queue consumers and reliability primitives.
  - `reliability/` — Idempotency, retry, and durability helpers.
  - `runtime/` — Runtime orchestration and HRS Think responses.
  - `security/` — Internal service registry and authority checks.
  - `tg/` — Telegram webhook, outbox, mini-app API, room state, and commands (excluding private owner-binding code).
  - `tools/` — Tool catalog, side-effect state, and result rendering.
  - `utils/` — Shared utilities.
- **Contracts** — `contracts/operia/`: action, note, and projection-envelope schemas.
- **Deployment surface** — `wrangler.example.toml`: a fully sanitized example of the production binding topology (D1, R2, Queues, Vectorize, Service Bindings, Durable Objects, AI Gateway, Workers AI), plus `src/types.ts` with the typed `Env` binding surface and `src/controlRegistry.ts` with the multi-worker control-plane registry.

## What is excluded

The following are intentionally left in the private upstream repository:

- Personal data modules: Apple Health, Google Calendar, and Note service source code and migrations.
- Private Telegram owner/chat bindings.
- Real `wrangler*.toml` deployment configs, secrets, and environment templates (a fully sanitized `wrangler.example.toml` is included instead).
- Operational runbooks, incident write-ups, archived docs, and product planning docs that may contain personal or infrastructure-sensitive details.
- Experimental feature branches and unmerged work.

See [`PRIVACY_REVIEW.md`](./PRIVACY_REVIEW.md) for the exact checklist and remaining review items before this repo can be made public.

## License

This repository is a mixed-origin reference snapshot. The upstream foundation is
MIT-licensed (see [`LICENSE`](./LICENSE)); the Operia contributions are described
in [`NOTICE`](./NOTICE). Read both files before redistributing or reusing any
part of this code.

## Contributing

This is a reference mirror. New experimental features are first developed and tested in the private upstream repository, then proposed here as pull requests once they are stable and privacy-safe.

> **Not a starter template.** This snapshot is intentionally *not buildable or runnable as-is*: package manifests, lockfiles, tests, deployment entrypoints, and real credentials are omitted. Treat it as an architecture and design reference — read the specs, contracts, and module boundaries; do not expect `npm install` to work.
