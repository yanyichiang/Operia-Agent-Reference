# Operia Telegram Inbound Vision P0 Implementation Spec

Date: 2026-07-22
Status: approved for local implementation
Workstream: Message Reliability
Branch: `<BRANCH>`

## Outcome

When Telegram acknowledges an owner image, Operia durably records the turn, performs a bounded image
download, asks the configured low-cost vision model for OCR and scene understanding, and always sends the
bounded vision result through the ordinary Opus conversation path for the final answer. No inbound image
may be acknowledged and silently discarded.

P0 deliberately does **not** add Anthropic native image blocks. The configured Memory-owned
`VISION_MODEL` (`google-ai-studio/gemini-3-flash-preview` in the current production config) performs the
vision prepass. Grok remains a future provider substitution behind the same Memory-owned contract; it is
not an automatic fallback in P0.

## Ownership and cache boundaries

- Telegram owns webhook parsing, `file_id` metadata, batching, bounded download and transport telemetry.
- Memory remains the sole owner of model routing, prompt assembly, usage, persona, recall and inference
  idempotency.
- The vision provider receives only the current image turn and a fixed extraction instruction. It does
  not receive the stable persona/system prefix or historical Memory context.
- The vision output enters the existing `vision_context` turn block after every stable cache breakpoint.
  It never becomes pinned persona, stable prefix or automatic long-term memory.
- Opus remains the only model whose natural-language answer is delivered to Telegram.

## Telegram ingress contract

Accepted inputs:

1. Telegram `photo`; choose the largest valid size by declared bytes, then pixel area.
2. Telegram `document` only when its normalized MIME type is `image/jpeg`, `image/png`, `image/webp` or
   `image/gif`.
3. Preserve bounded `caption`, reply metadata and `media_group_id`.
4. Store only `file_id`, `file_unique_id`, MIME, declared bytes, dimensions, safe filename and bounded
   correlation metadata in `tg_inbox.payload_json`. Do not store image bytes or Telegram download URLs.

`tg_inbox.kind` gains the additive value `image`; the existing TEXT column needs no migration. Duplicate
Telegram updates remain suppressed by the current message/update unique indexes. Same-chat serialization,
the trailing quiet window and hard aggregation cap remain unchanged.

## Download contract

- Download only inside the durable inference resume path, after `tg_chat_inference_runs` exists.
- Use Telegram `getFile`, then stream-read the file with a hard aggregate limit taken from
  `TG_MEDIA_MAX_BYTES` and clamped to 20 MB.
- Maximum four images per inference. Extra images become an explicit bounded marker in the current turn;
  they are not silently omitted.
- Validate declared size, `getFile` size, `Content-Length`, streamed byte count and MIME allowlist.
- Never expose the token-bearing Telegram file URL to Memory logs, D1, a model, or a response.
- Convert accepted bytes to a data URL only in request-local memory. The persisted Telegram inference
  request remains text-only, allowing retries to re-download by durable `file_id` without storing binary
  data in D1.

## Memory two-stage inference contract

For a request with image content whose ordinary resolved model is Anthropic:

1. Resolve `VISION_MODEL` separately; do not replace the final target model.
2. Call the vision model with only the final user image turn and a fixed instruction requesting bounded
   OCR, objects, layout, relationships and uncertainty. Cap output tokens.
3. Require non-empty visible vision output. Record bounded usage and correlation as
   `request_kind=vision_prepass`; never log image data or extracted text.
4. Strip image parts before the Anthropic assembler. Preserve the user's caption/text and add a static
   placeholder when the turn was image-only.
5. Before the final Anthropic request is assembled, remove `tools` and `tool_choice` from this image turn.
   This is a Memory-side request gate, not a Telegram-side rejection after Opus has already emitted an
   empty tool-only first response.
6. Pass the bounded extraction through the existing non-cacheable `vision_context`, then call Opus using
   the ordinary persona, Memory recall, cache and durable idempotency path. Opus must finish the image turn
   directly in this first request. Text-only turns retain the ordinary OpenAI/Anthropic tool registration
   and durable continuation behavior.

OpenAI-compatible clients that already route an image request directly to `VISION_MODEL` retain their
existing behavior. The two-stage path is selected only when the ordinary final target is Anthropic.

## Failure and recovery semantics

- Unsupported type or declared oversize: terminalize before any model call and send one static image
  error through the reliable outbox.
- Telegram `getFile`/download timeout or bounded-read failure: terminalize the run; do not spend on a
  model and do not hold the chat lock.
- Vision fetch/status/parse/empty-output failure: classify as terminal `vision_failed`; do not repeat the
  vision call three times and do not call Opus.
- Vision success followed by unknown Opus outcome: retain the existing Memory idempotency unknown-outcome
  protection; do not blindly replay either paid stage.
- Every terminal transition kicks pending same-chat inbox work.

## Bounded telemetry

Use the existing correlation ID across:

- `image.accepted`
- `image.downloaded`
- `vision_prepass` usage/log event
- ordinary `inference.run`
- delivery/outbox events

Metadata may contain count, normalized MIME, declared/downloaded byte count, elapsed milliseconds and
bounded error code. It must not contain caption text, image bytes, base64, Telegram file path/URL, prompt,
token, secret or vision output.

## Offline acceptance matrix

- Pure photo reaches durable `image` inbox and schedules the existing Queue.
- Photo with caption preserves caption in the current user turn.
- Image document allowlist accepts JPEG/PNG/WebP/GIF and rejects other documents.
- Largest photo size is chosen deterministically.
- Reply metadata and `media_group_id` survive ingress.
- Duplicate update/message remains idempotent.
- Active run keeps a later image unclaimed and terminal wakeup processes it without same-chat concurrency.
- `getFile` failure, download timeout, absent body, mismatched MIME, per/aggregate oversize and more than
  four images have explicit bounded outcomes.
- No token-bearing URL, image data or caption appears in persisted request/telemetry.
- Vision request contains current-turn image data but no persona/history/tools.
- Image + `react_to_message` and image + `reply_to_message` expose no tools in the final Opus wire request;
  the gate runs before assembler/provider request construction, so no empty first tool-only turn exists.
- Text-only OpenAI/Anthropic requests retain canonical tool registration and tool continuation.
- Gemini output is bounded, image parts are stripped, and `vision_context` appears after cache anchors.
- Opus remains the final target; `client_system_hash` and cache breakpoints are unchanged by vision output.
- Vision failure terminalizes immediately with a static Telegram notice.
- Normal text, voice, sticker, reaction, continuation, multi-bubble delivery and unknown-outcome regressions
  remain green.

## Verification and release gate

Local implementation must pass targeted inbound-image/vision verification, TypeScript, the complete
`npm run verify`, and Memory plus Telegram Wrangler dry-runs. No real Telegram message, provider/model
call, remote D1 write, secret/route change, push or production deployment is part of this implementation
gate. The coordinator owns integration and any later paired Memory -> Telegram rollout.

## Explicit P0 limit

Interaction tools are intentionally unavailable for Telegram image turns. The direct Opus answer is
covered, while reaction/reply/browse/delegation and other tool actions are a temporary functional
degradation for those turns. Carrying an opaque, short-TTL, conversation-bound Memory-owned
`vision_context_ref` across a durable tool continuation is the restoration path. Until then, the P0 gate
keeps the safer boundary: no base64 image or OCR text is written into Telegram continuation rows, Gemini
is not repeated, and Opus cannot enter a continuation that has lost the visual facts.
