# Web Client

Preact web client for Sentient voice assistant. Served as static files from the gateway.

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
