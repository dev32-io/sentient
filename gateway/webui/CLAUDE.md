# Web Client

Preact web client for Sentient voice assistant. Served as static files from the gateway.

## MANDATORY — Read Rules First

Rules live at the repo root: cross-cutting at `.claude/rules/*.md`, gateway-cross-cutting at `.claude/rules/gateway/*.md`, webui-specific at `.claude/rules/gateway/webui/*.md`. Auto-loaded by Claude Code via `paths:` frontmatter when you read matching source. Webui details: `agents/docs/gateway/webui/*-details.md`.

## Stack

- Framework: Preact + Vite
- Language: TypeScript (strict mode)
- Test runner: Vitest + Testing Library
- Audio: AudioWorklet (PCM16 capture + playback)

## Commands

    bun run dev       — Vite dev server with HMR
    bun run build     — Production build
    bun run test      — Run all web tests
    bun run typecheck — TypeScript strict check
