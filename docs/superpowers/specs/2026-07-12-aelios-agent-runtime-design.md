# Operia Agent Runtime Design

## Decision

Deploy an independent Cloudflare Agents SDK Worker at `agent.example.com`.
It is an orchestration runtime, not a second memory system.

## Ownership Boundaries

- Operia remains the only owner of assistant persona, user identity, conversation
  context, and long-term memory.
- The Agent Durable Object stores runtime-only data: MCP connections, capability
  configuration, approvals, jobs, channel cursors, health observations, and
  audit metadata.
- Telegram remains the first channel client. Home Assistant, Operia Web, WeChat,
  email, Slack, and voice stay visible in the registry but disabled until their
  integrations are designed.
- The MCP gateway remains the controlled tool source. Advertising a tool does
  not automatically authorize it.

## Initial Runtime Surface

Enable Durable Agent identity, SQLite-backed runtime state, HTTP/RPC routing,
MCP registry, tool policy, approval records, cancellation, idempotency, and
audit/health reporting.

Expose every reviewed Cloudflare Agents capability in a Capability Registry.
Disabled capabilities remain inert: they receive no binding, credential,
prompt exposure, or model-call path.

Code Mode, Project Think, Browser, Sandbox, AI Search, Payments, multi-agent
handoffs, durable fibers, schedules, email, Slack, voice, WeChat, and Home
Assistant start disabled.

## Security

- Cloudflare Access protects the browser-facing control surface.
- Agent management writes require an exact allowed Origin and CSRF token.
- Machine calls require a dedicated application bearer or service token.
- MCP servers and tools are deny-by-default allowlists with risk levels.
- Read-only tools may be automatic. Writes, device control, outbound messages,
  purchases, and deletion require explicit approval.
- Secrets and sensitive tool arguments are never returned in runtime snapshots
  or audit responses.

## Compatibility

The primary Operia Worker, its D1/Vectorize storage, Telegram Queue, Telegram
rolling state, model profiles, and MCP gateway contracts remain unchanged.
The new Worker can be disabled or removed without migrating Operia data.

## Telegram Tool Architecture

There is no separate GLM routing call before the main model. The Operia main
model remains the semantic owner and always sees exactly two stable meta-tools:

- `request_context`: request a purpose-bound Operia context capsule;
- `delegate_action`: submit a tool task to the Agent runtime.

Ordinary chat finishes in one main-model call. GLM-5.2 starts only after the
main model calls `delegate_action`. It receives a narrow tool set and a bounded,
redacted context capsule, chooses tools and arguments, and never owns persona,
identity, long-term memory, or final response style. Deterministic Telegram
commands, callbacks, state transitions, policy checks, approvals, and delivery
never invoke a model.

## Tool Continuation Contract

Tool turns use an explicit continuation protocol:

1. Persist the user message exactly once and run normal Operia recall once.
2. Preserve the complete assistant `tool_calls` value without sending a chat
   bubble or writing an empty assistant message.
3. Resolve `request_context` locally or submit `delegate_action` to the Agent.
4. Append the matching `tool` result and continue the same model turn without
   a second recall or a second user-message/archive write.
5. Persist, extract memory from, and deliver only the final assistant response.

The loop has a fixed maximum of four tool calls and two continuation rounds.
Intermediate tool requests and untrusted tool results never enter automatic
memory extraction.

## Context Broker

The main model passes opaque context references, never copied memory text.
Every capsule is bound to namespace, Telegram owner/chat, task, recipient,
purpose, request hash, expiry, and byte limit. GLM cannot broaden its scope or
resolve a reference directly. Persona and identity are never available through
the generic context interface. Memory update/delete remains an Operia-owned,
previewed, separately approved operation.

## Execution And Approval

All tool calls pass through one fail-closed execution gateway:

`catalog -> allowlist -> static risk policy -> argument validation -> approval
ticket -> execution -> result sanitization -> audit`.

Unknown tools, unknown risks, empty allowlists, policy drift, and changed tool
schemas are denied. External MCP descriptions and results are untrusted data.
Destructive operations use `prepare -> preview -> approve -> commit`; the
single-use ticket binds owner, chat, task, tool, canonical argument hash,
policy version, expiry, and nonce. GLM review is advisory and cannot override
code policy or human approval.

## Cloudflare Runtime

- Telegram calls Agent through a Service Binding, not a public bearer.
- The existing private MCP Gateway remains the provider/tool policy authority
  and is called through a Service Binding. The Agent does not create a second
  provider registry for these tools.
- External independent OAuth MCP servers may later use Agents SDK
  `addMcpServer()` with stable IDs.
- GLM uses the Workers AI binding with model `@cf/zai-org/glm-5.2`.
- Short model/tool work uses durable fibers. Work waiting for human approval
  uses a Workflow approval gate.
- Telegram delivery uses an outbox. Uncertain external side effects are never
  automatically replayed.
- WebSockets are rejected until an authenticated readonly design is deployed.
- `workers.dev` is disabled after Service Bindings are active.
- `agents` is pinned exactly to `0.17.4` and `@cloudflare/codemode` to `0.4.3`; SDK upgrades require focused recovery,
  MCP, state, and authorization regression tests.

## Acceptance Criteria

- Anonymous and unauthenticated WebSocket attempts cannot reach Agent state.
- A normal Telegram chat performs no GLM or MCP call.
- A delegated read task completes GLM planning, policy validation, tool call,
  sanitized continuation, final Operia reply, and one Telegram delivery.
- Tool intermediates are absent from long-term memory extraction and visible
  Telegram history.
- Approval replay, expired tickets, changed arguments, wrong owner/chat, schema
  drift, and duplicate queue delivery are rejected.
- Agent eviction/restart resumes from a checkpoint without repeating a
  completed side effect.
- The original direct TG-to-Operia path remains a feature-flag rollback.
