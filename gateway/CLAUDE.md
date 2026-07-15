# Gateway

Bun/TypeScript voice gateway. Orchestrates STT→LLM→TTS streaming pipeline on Raspberry Pi 5.

## MANDATORY — Read Rules First

Rules live at the repo root: cross-cutting at `.claude/rules/*.md`, gateway-specific at `.claude/rules/gateway/*.md`. Auto-loaded by Claude Code via `paths:` frontmatter when you read matching source. Subproject details are at `agents/docs/gateway/*-details.md`; cross-cutting details at `agents/docs/*-details.md`.

## Stack

- Runtime: Bun
- Language: TypeScript (strict mode)
- Test runner: Vitest
- WebSocket: Bun built-in
- LLM: Hermes (per user, supervised by `sentient-hermes`); gateway dials it via ACP JSON-RPC over WebSocket (`hermes-adapter-client/`). The `sentient-plugin` dashboard sidecar covers the search / get / getMessages / delete surfaces ACP doesn't expose.
- STT: local STTService (gateway dials over WS)
- TTS: local-tts / LocalTTSService (gateway dials over WS)
- Validation: zod

## Commands

    bun run dev       — Start gateway with hot reload
    bun run test      — Run all gateway tests
    bun run build     — Production build
    bun run typecheck — TypeScript strict check
