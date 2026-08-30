# Gateway

Bun/TypeScript native voice gateway. It owns client WebSockets, durable
sessions, the append-only store, the native ReAct loop, tool mediation, and
STT/TTS streaming. Production is a compiled host binary supervised by
`launchd`; the gateway is not a Docker container.

## Architecture

- `src/runtime/session-runtime.ts` — one runtime per server-minted durable
  `sessionId`, with multiple attached connection windows; serializes turns,
  owns cancellation, publishes committed projections, and manages retention.
- `src/runtime/react-loop.ts` — calls the OpenAI-compatible provider directly,
  re-reads the store each iteration, dispatches tools through `ToolBroker`, and
  forces a content-only final iteration at the configured bound.
- `src/store/` — append-only source of truth for model and client projections.
- `src/session-handlers/` — authentication, attachment binding, session-scoped
  replay journals, command mediation, STT input, and `turn.*` wire emission.
- `src/system-orchestrator/` — supervises native addons and Docker-backed
  infrastructure/MCP services through one dependency graph and health model.

Hermes is only a bounded one-shot implementation behind `delegateTask`; it is
not a session runtime, provider connection, or managed service. Its background
completion returns as a stimulus to the owning `SessionRuntime`.

## Local capabilities

- STT: whisper-stt WebSocket at `ws://127.0.0.1:8768`
- TTS: LocalTTSService WebSocket at `ws://127.0.0.1:8770`
- LLM: configured OpenAI-compatible provider, called by the native gateway

## Commands

```bash
bun run dev       # gateway only: bun --watch src/main.ts
bun run test      # gateway tests
bun run build     # production build
bun run typecheck # TypeScript strict check
```

The repository-root `bun run dev` launches the complete local stack. Gateway
development must use `bun --watch`, which restarts the process on change.
Never use `bun --hot`: preserving the process can duplicate in-process
supervisors and managed addons.

Production lifecycle is owned by `launchd` and `deploy/mac-prod/setup-prod.py`;
do not hand-start a second gateway process.
