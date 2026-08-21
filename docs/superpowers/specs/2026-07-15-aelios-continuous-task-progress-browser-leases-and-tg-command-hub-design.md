# Operia Continuous Task Progress, Browser Leases, and Telegram Command Hub

**Status:** accepted by owner, implementation in progress

**Date:** 2026-07-15

**Scope:** Agent Browser execution, cross-channel continuous-task progress, Telegram command surface
**Depends on:**

- `2026-07-14-operia-federated-control-plane-design.md`
- `2026-07-14-operia-p1-tool-loop-reasoning-owner-transfer-design.md`
- `2026-07-15-operia-browser-domain-policy-design.md`
- `2026-07-14-<AGENT_SERVICE>-mcp-skills-browser-run-design.md`

## 1. Decision Summary

This design makes three coordinated changes without changing the existing owner boundaries.

1. Browser automation moves from blanket single-step handoff to a scoped task lease. A lease combines a trusted site profile, an interaction mode, explicit action bounds, a step budget, and a deadline. Multi-step execution is allowed only while every action remains inside that lease.
2. Every user-initiated foreground task that continues beyond the first response publishes progress through one canonical Agent event stream. The main model turns safe milestone snapshots into short first-person updates; Telegram edits one persistent status message instead of sending a flood of messages.
3. Telegram exposes nine top-level commands: `/start`, `/new`, `/status`, `/browser`, `/voice`, `/think`, `/mcp`, `/skill`, and `/cancel`. Existing commands remain accepted as hidden compatibility aliases during migration.

The user-facing acceptance target is deliberately narrow: a smooth multi-step Browser task, visible and interruptible progress, and a compact Telegram menu.

## 2. First Principles

### 2.1 Safety is a capability boundary, not a confirmation after every click

The browser must not become unrestricted. It also must not ask for approval after each harmless action. Permission is granted to a bounded task capability, not to arbitrary browser code and not to page content.

### 2.2 Progress is part of the task contract

A task that runs silently for tens of seconds is operationally incomplete even if it eventually succeeds. The user must know what is happening, be able to pause or stop it, and receive the final result through the same conversation.

### 2.3 Main-model voice and execution truth are separate

The main model may narrate verified task facts in its normal voice. It must not invent progress, expose hidden chain-of-thought, or become the authoritative task state store. Agent remains the execution owner.

### 2.4 A channel menu is navigation, not an inventory dump

Telegram top-level commands represent stable product areas. Provider-specific switches and detailed parameters belong under those hubs and in the domain control panels.

### 2.5 One truth, multiple projections

- Memory owns the primary model, persona, reasoning execution, sampling, and prompt cache.
- MCP owns the authoritative MCP provider and tool catalog.
- Agent owns tasks, Browser, Skills, approvals, leases, hooks, heartbeat execution, and task audit.
- Telegram owns command parsing, message presentation, callback delivery, outbox state, and short channel session state.

Telegram and the domain panels may display inherited values, but they must edit the canonical owner through an explicit contract rather than copy state.

## 3. Browser Capability Model

### 3.1 Hard global gates

The following restrictions remain effective in every interaction mode and cannot be granted by a site profile, a task lease, a planner, or page content:

- HTTPS only, except explicitly isolated development fixtures.
- No localhost, private IP, link-local, metadata service, or internal-network targets.
- No reading or exporting cookies, browser storage, credentials, tokens, password fields, passkeys, OTPs, or MFA material.
- No arbitrary network fetches from generated browser code.
- No dynamic code generation or unbounded mutation loops.
- No page instruction may expand its own permissions.
- No payment completion, account-security change, authorization grant, destructive deletion, external publication, or external message send without a dedicated high-risk approval contract.

The last category is intentionally outside ordinary Browser `trusted` mode. Future dedicated tools may implement those operations with their own owner, idempotency, and approval rules.

### 3.2 Site profiles

Agent owns versioned `BrowserSiteProfile` records:

```ts
type BrowserInteractionMode = "read" | "form" | "trusted";

interface BrowserSiteProfile {
  id: string;
  label: string;
  primaryHosts: string[];
  redirectHosts: string[];
  maximumMode: BrowserInteractionMode;
  allowedPathPatterns: string[];
  deniedPathPatterns: string[];
  allowedActionKinds: BrowserActionKind[];
  deniedActionKinds: BrowserActionKind[];
  revision: number;
  enabled: boolean;
  createdBy: "owner" | "migration";
  updatedAt: string;
}
```

Host matching is exact by default. Same-site redirects may be allowed only through registrable-domain comparison using the existing PSL-aware policy. Cross-site redirects require the destination in `redirectHosts` or a task-scoped grant. The global denylist always wins.

### 3.3 Interaction modes

#### Read

Default mode. Allows navigation, DOM inspection, accessibility-tree inspection, screenshots, scrolling, and non-mutating page-state reads. It cannot focus or edit form controls, click a control with a side effect, submit a form, upload a file, or invoke account state.

#### Form

Allows bounded ordinary interaction on a trusted site profile: click, select, fill non-sensitive fields, answer questionnaires, and submit ordinary forms. It still rejects login, password, passkey, OTP, payment, OAuth, account settings, file upload, publication, external communication, and destructive operations.

#### Trusted

Allows broader manually enumerated interactions for a site profile that the owner explicitly marks trusted. It is never selected automatically. It still cannot override the hard global gates.

The name `trusted` is used instead of `full` because the mode is broad but not unrestricted.

### 3.4 Task capability leases

Every interactive Browser task receives an immutable input declaration and a revocable lease:

```ts
interface BrowserTaskLease {
  id: string;
  taskId: string;
  ownerSubject: string;
  channelRef: string;
  siteProfileId: string;
  siteProfileRevision: number;
  mode: BrowserInteractionMode;
  allowedHosts: string[];
  allowedPathPatterns: string[];
  allowedActionKinds: BrowserActionKind[];
  maxLogicalSteps: number;
  maxNavigations: number;
  maxRetriesPerStep: number;
  deadlineAt: string;
  instructionHash: string;
  state: "active" | "paused" | "revoked" | "expired" | "completed";
  revision: number;
}
```

Effective permission is the intersection of:

```text
global policy
AND site profile maximum
AND user/task grant
AND declared task actions
AND current lease bounds
```

No component can widen another component.

### 3.5 Automatic mode selection

- Unknown site: `read` only, with a domain challenge before leaving the current allowed site set.
- Known profile with `maximumMode=read`: `read` only.
- Known profile with `maximumMode=form`: Agent may select `form` when the typed plan contains only ordinary form actions.
- `trusted`: owner must select it for that task or explicitly approve an escalation. The system never infers it from natural language alone.

### 3.6 Typed logical actions

Continuous execution operates on typed actions rather than arbitrary generated CDP programs:

```ts
type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "inspect"; selector?: string }
  | { kind: "scroll"; direction: "up" | "down"; amount: number }
  | { kind: "click"; target: StableTarget }
  | { kind: "fill"; target: StableTarget; valueRef: string; fieldClass: "ordinary" }
  | { kind: "select"; target: StableTarget; option: string }
  | { kind: "submit"; target: StableTarget; submissionClass: "ordinary" }
  | { kind: "screenshot"; label?: string }
  | { kind: "checkpoint"; reason: string };
```

Sensitive values are referenced through sealed task input, not copied into events or model narration. One logical action is the maximum uninterruptible unit. Mutation loops inside `Runtime.evaluate` are rejected.

### 3.7 Multi-step execution and handoff

While a lease is active, Browser Run may continue across logical actions and preserve the session. It pauses only when a boundary is reached:

- unknown or denied host/path;
- cross-site redirect outside the lease;
- interaction-mode escalation;
- sensitive field or hard-gate action;
- action not declared by the typed plan;
- material page drift that invalidates the target or instruction hash;
- step, navigation, retry, or time budget exhausted;
- user pause/stop;
- executor uncertainty about side effects.

A pause creates a resumable challenge containing the requested delta, not a request to reapprove the whole task. Approval issues a new lease revision and resumes the same task and Browser session when still alive.

### 3.8 Runtime bounds

Initial defaults:

- 30 seconds maximum per execution phase.
- 90 seconds paused-session keepalive.
- 5 minutes for a user-opened Live View handoff.
- 10 minutes absolute Browser session keepalive ceiling.
- 40 logical steps for `form`, 20 for `read`, and an explicit owner-selected value for `trusted` capped at 60.
- 3 retries per logical step.
- stop after 3 no-progress checkpoints with the same normalized page fingerprint.

Terminal states explicitly close the Browser target and release billing resources.

## 4. Continuous Task Progress Protocol

### 4.1 Scope

The protocol applies to every user-initiated foreground task that:

- is expected to take more than three seconds;
- becomes deferred or queued;
- performs multiple tool steps;
- waits for approval or user attention; or
- remains active after the first channel response.

Examples include Browser sessions, MCP workflows, Skills, voice generation, search/image workflows, and future HA operations.

Scheduled heartbeat, hook maintenance, cache sweeps, and other background housekeeping do not send routine chat updates. They appear in `/status health` and only notify the user on an anomaly, requested report, or required intervention.

### 4.2 Canonical event stream

Agent owns append-only task events. Minimum event vocabulary:

```text
task.accepted
task.plan_ready
task.started
task.progress
task.checkpoint_saved
task.waiting_for_approval
task.paused
task.resumed
task.cancel_requested
task.cancelled
task.completed
task.failed
browser.lease_created
browser.navigation_started
browser.navigation_completed
browser.action_started
browser.action_completed
browser.policy_escalation
```

Events contain structured facts, safe summaries, timestamps, revisions, and redacted references. They never contain cookies, storage values, credentials, form contents, hidden reasoning, or raw private page dumps.

### 4.3 Progress snapshots

High-frequency events are folded into a revisioned `TaskProgressSnapshot`:

```ts
interface TaskProgressSnapshot {
  taskId: string;
  revision: number;
  state: "queued" | "running" | "waiting" | "paused" | "completed" | "failed" | "cancelled";
  phase: string;
  safeActivity: string;
  completedSteps: number;
  totalSteps?: number;
  elapsedMs: number;
  attention?: { kind: string; challengeId: string };
  availableControls: Array<"pause" | "resume" | "step" | "stop" | "live_view" | "read_only">;
  finalResultRef?: string;
}
```

All channel projections consume the same snapshot. Telegram must not reconstruct task truth from its own message history.

### 4.4 Main-model progress narrator

Progress updates should sound like the same assistant who answers the user. Therefore Memory/Opus receives a small read-only `progress_context` capsule at semantic milestones:

- a safe summary of the user request;
- the current canonical snapshot;
- the previous public update;
- stable persona and style instructions;
- a strict instruction to write one short first-person progress update and not a final answer.

The narrator has no tools and cannot mutate the task. It must not expose or simulate chain-of-thought. It may only verbalize supplied facts.

Narration is generated at:

- task start;
- first meaningful progress;
- a changed milestone after at least 20 seconds;
- approval, pause, or intervention;
- completion or failure.

Default budget is no more than six narrator calls per task. Snapshot hash deduplication prevents repeated updates. Narrator requests use a stable prompt prefix, small output limit, deterministic idempotency key, and the existing primary-model cache contract.

If the narrator times out or fails, a deterministic safe template updates the same status message. Narration failure never blocks task execution.

### 4.5 Telegram presentation

Telegram owns one persistent presentation record per foreground task:

```ts
interface TelegramTaskPresentation {
  taskId: string;
  chatId: string;
  messageId?: number;
  presentationRevision: number;
  lastSnapshotRevision: number;
  lastRenderHash: string;
  lastEditedAt: string;
  lastNarratedAt?: string;
  state: "draft" | "active" | "terminal";
}
```

Presentation rules:

- Create the status message immediately after task acceptance.
- Prefer Telegram rich-message draft streaming when available; fall back to `editMessageText`.
- Coalesce updates and never edit faster than once per second in one chat.
- Main text is the main-model progress update.
- A compact technical footer may show task state, phase, elapsed time, step count, active Browser mode/site, and task ID.
- Inline controls appear only when valid: `Pause`, `Resume`, `Stop`, `Live View`, `Read only`, and `Trace`.
- Callback queries are acknowledged immediately, then routed to Agent.
- Final answer replaces or conclusively updates the same status message; a separate result message is permitted only when Telegram size/media constraints require it.

### 4.6 Reply-level expandable status block

The live task message and the expandable block solve different problems and therefore have independent controls.

- Live task progress answers: "What is it doing right now, and how do I interrupt it?"
- The reply-level block answers: "What produced this model reply, how long did it take, and what tools or cache were involved?"

Every logical main-model reply appends one collapsed status block to its final Telegram bubble. A long reply split into several Telegram bubbles still receives only one block, attached to the last bubble.

The block may contain:

```text
Response: completed | partial | attention required | failed
Model: concrete model and service tier
Timing: TTFT and total elapsed time
Tokens: input and output tokens
Cache: read and create tokens
Tools: no tool, or sanitized tool name/status/elapsed time by round
Task: task ID when the reply belongs to a durable task
```

It must not contain hidden reasoning, raw prompts, private page content, form values, credentials, cookies, or unredacted tool payloads.

Canonical Telegram-owned controls:

```text
telegram.presentation.expandable_response_status   boolean, default true
telegram.presentation.expandable_usage             boolean, default true
telegram.presentation.expandable_tool_trace        boolean, default true
telegram.presentation.task_progress_mode           live | compact | off, default live
```

`expandable_response_status` is the master reply-level block switch. The existing usage and tool-trace booleans control sections inside that block. During migration, their existing stored values are retained.

`task_progress_mode` behaves as follows:

- `live`: main-model-voice milestone updates, compact technical footer, and direct controls. This is the default.
- `compact`: one deterministic task message with state and controls, updated only at major transitions; no progress-narrator calls.
- `off`: no routine progress message. Canonical events continue, `/status tasks` remains available, and the final reply still receives its expandable block when enabled.

Approval requests, safety boundary pauses, failures, and final results cannot be silenced by `task_progress_mode=off`. Turning presentation off never turns execution audit off.

The current pre-migration behavior is explicitly transitional: `expandable_tool_trace` creates separate collapsed messages, while `expandable_usage` is declared in the control registry but is not yet attached to response delivery. Hub V2 consolidates them into the final model reply rather than preserving the extra-message behavior.

### 4.7 Interruption guarantees

`pause`, `resume`, `step`, `stop`, and `read_only` are deterministic control-plane operations. They do not call the main model or planner.

- Agent verifies owner subject and channel binding.
- Lease mutation uses compare-and-swap revision semantics.
- Executor checks cancellation before and after every logical action.
- `stop` revokes the lease, closes the Browser session, and marks the task cancelled.
- `pause` finishes at most the current logical action and then checkpoints.
- `step` executes one logical action and returns to paused state.
- `read_only` can only reduce permissions and therefore applies immediately.

## 5. Telegram Command Hub V2

### 5.1 Visible top-level commands

The visible Bot command menu contains exactly nine commands:

| Command | Purpose |
| --- | --- |
| `/start` | Open the private assistant home and navigation menu |
| `/new` | Start a new short Telegram conversation |
| `/status` | Show runtime, active tasks, usage, cache, and heartbeat health |
| `/browser` | Browser tasks, security mode, site profiles, Live View, and controls |
| `/voice` | One-shot and automatic voice behavior, provider mode, and Voice Studio link |
| `/think` | Reasoning execution, Telegram reasoning display, budget, and temperature |
| `/mcp` | MCP catalog, status, and tool invocation hub |
| `/skill` | Skills catalog, status, and invocation hub |
| `/cancel` | Immediately cancel the pending command or active foreground task |

`/cancel` remains visible because it is the channel's deterministic emergency stop. `/help` is folded into `/start` and remains accepted as a hidden alias.

### 5.2 Hub subcommands

#### Browser

```text
/browser
/browser status
/browser pause
/browser resume
/browser step
/browser stop
/browser live
/browser mode read|form|trusted
/browser sites
```

Mode changes must satisfy the canonical Agent site profile and lease policy. Telegram cannot bypass it.

#### Voice

```text
/voice
/voice once
/voice auto
/voice off
/voice model realtime|quality|expressive
/voice status
```

#### Think

```text
/think
/think show off|summary|debug
/think reasoning off|low|medium|high|max|reset
/think temperature <0..1>|reset
/think status
```

`show` controls Telegram presentation. `reasoning` and `temperature` edit the Memory-owned primary-model runtime contract through Service Binding.

#### MCP

```text
/mcp
/mcp list
/mcp status
/mcp run <tool-alias> [key=value ...]
```

MCP catalog data is fetched from the MCP owner. Agent remains responsible for execution policy, approvals, and audit.

#### Skill

```text
/skill
/skill list
/skill status
/skill run <skill-name> [arguments]
```

#### Status

```text
/status
/status tasks
/status usage
/status health
/status progress live|compact|off
/status blocks on|off
/status blocks usage on|off
/status blocks tools on|off
```

Heartbeat and hooks are shown under health. They are not separate top-level menu entries.

### 5.3 Hidden compatibility aliases

The following existing commands remain parseable but disappear from the visible menu:

```text
/model
/memory
/remember
/persona
/voice_auto
/voice_realtime
/voice_quality
/voice_expressive
/voice_off
/think_on
/think_off
/think_debug
/reasoning
/temperature
/usage
/tool
/help
```

Mappings:

- `/tool ...` -> `/mcp run ...`
- `/usage` -> `/status usage`
- voice variants -> `/voice ...`
- reasoning/display/temperature variants -> `/think ...`
- `/help` -> `/start`
- memory/persona commands return the existing action and point to Memory Admin; they are not removed until telemetry shows no external dependency.

No legacy handler is deleted in this phase.

Implementation must split the current single `BOT_COMMANDS` concept into two explicit registries:

- `MENU_COMMANDS`: the nine discoverable BotFather entries.
- `ACCEPTED_COMMANDS`: canonical handlers plus hidden aliases and their canonical mappings.

The admin API exposes both lists so the Command Ledger can audit the hidden compatibility surface without republishing it to Telegram.

### 5.4 Command synchronization

The nine-command menu is synchronized and verified across the existing projections:

- default scope;
- all private chats;
- owner chat;
- each with default, Chinese, and English language projections.

Acceptance requires `getMyCommands` to return exactly the expected nine commands for all nine projections and the owner chat menu button to use the command menu.

## 6. Data and Service Contracts

Additive schema changes only:

- Agent: `browser_site_profiles`, `browser_task_leases`, `task_progress_events`, and task snapshot fields.
- Telegram: `tg_task_presentations` only; no task execution truth is copied.

Required Service Binding methods:

```ts
agent.startTask(input)
agent.getTaskSnapshot(taskId)
agent.listTaskEvents(taskId, afterRevision)
agent.controlTask(taskId, control, expectedRevision)
agent.listBrowserSiteProfiles()
agent.previewBrowserLease(input)
agent.issueBrowserLease(input)

memory.narrateTaskProgress(progressContext)
memory.getPrimaryModelRuntime()
memory.patchPrimaryModelRuntime(patch)

mcp.listCatalog()
mcp.getProviderHealth()
```

All mutating calls require owner identity, channel reference, idempotency key, and audit metadata.

## 7. Security and Privacy Review

- Browser page content is untrusted data and cannot define site policy, actions, or narration instructions.
- Only safe structured milestones reach the progress narrator.
- Hidden model reasoning is never displayed. `debug` shows the approved reasoning summary and execution trace only.
- Form values are sealed and excluded from event payloads, logs, and status messages.
- A Telegram callback cannot control a task from another chat or user.
- Lease revisions prevent stale approval replay.
- Site profile revisions are pinned into each lease; profile edits do not silently widen a running task.
- Form/trusted task execution is not response-cached or blindly replayed. Read-only page analysis may use existing safe cache rules.
- Completion, cancellation, expiry, and failure explicitly close Browser resources.

## 8. Failure Behavior

- Planner output invalid: repair once against the typed schema; otherwise pause with a concise diagnostic and retain the Browser session when safe.
- Browser session expired: create a new session only after revalidating the current lease and restoring from a safe checkpoint.
- Main-model narrator unavailable: deterministic fallback update, task continues.
- Telegram edit fails: retry through outbox with idempotency; do not duplicate the task.
- Reply metadata unavailable: omit only the unavailable row and preserve the main answer.
- Unknown redirect: pause with exact source/destination host and requested profile delta.
- Repeated no progress: pause after three matching fingerprints and ask for intervention.
- Agent/TG disconnected: Agent continues only if the active lease permits unattended execution; Telegram catches up from the canonical snapshot on reconnect.

## 9. Feature Flags and Rollback

```text
BROWSER_TASK_LEASES_ENABLED
TASK_PROGRESS_ENABLED
TG_COMMAND_HUB_V2_ENABLED
```

Flags are independent. Rollback order:

1. Disable command Hub V2 to restore the current visible menu.
2. Disable progress presentation while preserving canonical task execution.
3. Disable Browser leases to restore the existing single-step handoff behavior.

Schema changes remain additive and dormant. Existing command handlers remain available throughout rollback.

## 10. Implementation Sequence After Approval

### P0: Contracts and tests

- Add schemas, event types, lease intersection logic, and owner checks.
- Add parser compatibility for `/mcp` and hub subcommands.
- Add feature flags and migration tests.

### P1: Browser lease executor

- Replace blanket interaction handoff with typed action checks.
- Implement site profiles, lease issuance, boundary pause, checkpoints, and direct controls.
- Add loop, timeout, redirect, and resource-close tests.

### P2: Continuous progress

- Publish canonical task snapshots.
- Add read-only main-model narrator with deterministic fallback.
- Add Telegram persistent presentation, throttled edits/drafts, callbacks, and reconnect catch-up.

### P3: Command Hub V2

- Deploy hub handlers and hidden legacy aliases before changing the public menu.
- Publish and verify the nine-command menu across all nine projections only after handler deployment succeeds.
- Update domain control pages to link Agent-global and Telegram-specific controls without duplicating owner state.

### P4: Production acceptance

- Run the three owner-visible acceptance scenarios below.
- Record exact task IDs, command projections, screenshots, timings, and rollback flags.
- Deploy only after automated checks pass.

## 11. Acceptance Criteria

### A. Smooth Browser security policy

Use a public interactive questionnaire with a profile that explicitly contains its primary and redirect hosts, initially `openpsychometrics.org` and `ojts.com`, with maximum mode `form`.

Pass conditions:

- One foreground task receives one bounded `form` lease.
- It navigates, answers multiple ordinary questions, and advances through multiple pages without routine per-click approval.
- Allowed same-site and declared cross-site redirects continue within the lease.
- An undeclared host pauses with a precise domain challenge.
- A simulated sensitive/login/payment action pauses at the hard gate.
- Step and time limits prevent loops.
- Terminal completion or stop closes the Browser session.

### B. Real-time task status

Pass conditions:

- Telegram creates the task status message within three seconds of task acceptance.
- The main model writes the initial update and at least one factual progress update before the final answer for a multi-step task.
- Updates edit one persistent message and do not flood the chat.
- The technical footer reflects canonical state and never exposes private form values or hidden reasoning.
- Switching to `compact` stops narrator calls while preserving deterministic state and controls.
- Switching to `off` suppresses routine progress but not approvals, safety pauses, failures, final results, or canonical audit.
- `Pause` takes effect after at most one logical action; `Resume` continues the same task and live session when available.
- `Step` performs exactly one logical action.
- `Stop` revokes the lease, closes the session, and produces a terminal update.
- Narrator failure is visibly and safely handled by the deterministic fallback without stalling the task.

### C. New Telegram slash-command panel

Pass conditions:

- All nine command projections return exactly the nine visible commands in section 5.1.
- Telegram shows `/browser`, `/voice`, `/think`, `/mcp`, `/skill`, and `/cancel` after server synchronization.
- `/mcp` invokes the canonical MCP path; `/tool` still works as a hidden alias.
- Voice and think legacy commands still work but are absent from the menu.
- `/status usage` and `/status health` expose usage/cache and heartbeat/hook health.
- `/status progress` controls live progress independently from reply-level expandable blocks.
- Every logical model reply has at most one expandable status block on its final Telegram bubble; its master, usage, and tool sections can be independently disabled.
- `/cancel` stops the active foreground task without a model call.

## 12. Non-Goals

- An unrestricted general-purpose browser.
- Automatic login, payment, OAuth consent, account-security changes, publishing, or destructive operations.
- Displaying hidden chain-of-thought.
- Calling the main model for every low-level event.
- Sending routine heartbeat messages into the conversation.
- Making Telegram a second task, Browser, MCP, or model-settings truth store.
- Removing legacy commands before migration telemetry and owner approval.

## 13. Owner Confirmation Requested

Approval of this spec confirms these product decisions:

1. The visible Telegram menu contains exactly nine top-level commands.
2. `/cancel` stays visible; `/help`, heartbeat, usage, memory/persona, and detailed voice/think commands are folded into hubs or hidden aliases.
3. Every user-initiated foreground continuous task receives main-model-voice progress updates; background maintenance remains silent unless attention is needed.
4. Browser multi-step autonomy is granted through bounded task leases and typed actions, while hard global gates remain non-bypassable.
5. Live progress defaults to `live` but may be changed to `compact` or `off`; reply-level expandable status remains an independent presentation setting.

No production implementation or deployment is authorized by this proposed document alone.

## 14. References

- Cloudflare Agents Browser: <https://developers.cloudflare.com/agents/tools/browser/>
- Cloudflare Agents human-in-the-loop: <https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/>
- Cloudflare Browser Run human-in-the-loop: <https://developers.cloudflare.com/browser-run/features/human-in-the-loop/>
- Cloudflare Browser Run limits: <https://developers.cloudflare.com/browser-run/limits/>
- Telegram Bot API: <https://core.telegram.org/bots/api>
- Telegram Bot API changelog: <https://core.telegram.org/bots/api-changelog>
- Telegram bot FAQ and rate limits: <https://core.telegram.org/bots/faq>
