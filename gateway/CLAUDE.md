# Gateway

Bun/TypeScript voice gateway. Orchestrates STT→LLM→TTS streaming pipeline. Ships as a compiled native binary supervised by `launchd` on the production Mac mini (the Pi 5 deploy is retired) — not a Docker container. See `deploy/README.md`.

## MANDATORY — Read Rules First

Rules live at the repo root: cross-cutting at `.claude/rules/*.md`, gateway-specific at `.claude/rules/gateway/*.md`. Auto-loaded by Claude Code via `paths:` frontmatter when you read matching source. Subproject details are at `agents/docs/gateway/*-details.md`; cross-cutting details at `agents/docs/*-details.md`.

## Stack

- Runtime: Bun
- Language: TypeScript (strict mode)
- Test runner: Vitest
- WebSocket: Bun built-in
- LLM: native orchestrator being built per the Sentient 2.0 spec (`docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md`) — the gateway runs its own ReAct loop directly against an OpenAI-compatible provider. Hermes is a delegated background tool (`delegateTask`), invoked as a native local process, not the agent runtime.
- STT: local STTService (gateway dials over WS)
- TTS: local-tts / LocalTTSService (gateway dials over WS)
- Validation: zod
- Deploy: `gateway/src/system-orchestrator/` is the host orchestrator — it supervises docker addons (MCP tool servers, searxng, egress-proxy/ingress-proxy) and native addons (whisper-stt, local-tts) through one registry, one dependency graph, one health model. Dev: `bun --watch src/main.ts` — a real process restart per change, **never `--hot`**. Prod: compiled binary under `launchd` — see `deploy/README.md`.

## Commands

    bun run dev       — Start gateway (`bun --watch`: full restart on save)
    bun run test      — Run all gateway tests
    bun run build     — Production build
    bun run typecheck — TypeScript strict check
