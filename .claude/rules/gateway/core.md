---
paths:
  - "gateway/src/**/*.ts"
  - "shared/**/*.ts"
---
# Gateway and shared TypeScript guardrails

- Validate unknown external input at the boundary; do not cast network, tool, provider, or persisted data into trusted types.
- Streaming surfaces use `AsyncGenerator`/`for await`; thread `AbortSignal` through async work and close iterators, sockets, and buffers on cancellation.
- Provider and service adapters implement boundary interfaces. They do not own retry/supervisor lifecycle, and transient startup failure must not kill unrelated session channels.
- Preserve exact wire message types and fields across gateway, web SDK, and mobile SDK; do not invent convenience envelopes in code or tests.
- The append-only session store is authoritative. Do not add a second conversation/task mirror or ambient current-session state; live and replay client projections must remain equivalent.
- Turn cancellation stops the turn and TTS, not background work. Background completion returns later as a session stimulus rather than through polling.
- Identity becomes authority only through `AccessManager`; resource handles carry attenuated capabilities by value. Tool calls require role and per-tool mediation at the execution boundary.
- Prompt/tool/skill/background-completion content is untrusted. Route it through the established scanner/risk boundaries; never treat model intent as authorization.
- Large prompts and instruction templates live in Markdown resources rather than inline TypeScript strings.
- Shipped code uses the tagged structured logger. Never log prompts, message text, transcripts, raw frames, tokens, or audio; mobile logs are uploaded and must obey the same rule.

When a rule is unclear, read `agents/docs/gateway/architecture-details.md`, `agents/docs/gateway/config-details.md`, `agents/docs/error-handling-details.md`, or `agents/docs/logging-details.md`.
