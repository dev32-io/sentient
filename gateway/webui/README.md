# Sentient Web Client

Preact web client for the Sentient voice assistant. Builds to a static
bundle under `dist/`; the gateway serves it directly. There is no
separate webui container.

## Setup

```bash
bun install           # install dependencies (from repo root)
bun run dev           # start Vite dev server
```

The Vite dev server runs on port 5173 and proxies WebSocket / API
traffic to the gateway running locally on port 8888.

## Audio

PCM16 capture and playback both run in `AudioWorklet` (Float32 → Int16
conversion in the worklet, no `MediaRecorder`). Toggle-to-talk: click
to start recording, click again to stop — there is no client-side VAD;
turn detection happens server-side via STTService.

TTS playback is routed through a local `RTCPeerConnection` loopback so
the browser's built-in echo cancellation treats the assistant's voice
as remote audio and subtracts it from the mic input.

`AudioWorklet` requires `SharedArrayBuffer`, which in turn requires
COOP/COEP headers. Configured in two places:

| Environment | Where |
|------------|-------|
| Vite dev server | `vite.config.ts` → `server.headers` |
| Gateway static serve | `gateway/src/api/handlers/webui.ts` → COOP/COEP headers |

Use `credentialless` (not `require-corp`) for COEP to avoid blocking
loads of cross-origin assets.

## Commands

```bash
bun run dev           # Vite dev server with HMR
bun run build         # Production build → dist/
bun run test          # Vitest
bun run typecheck     # TypeScript strict check
```

## Project structure

```
gateway/webui/
  src/
    adapters/         AudioWorklet capture, web-audio playback, WebRTC peer
    components/       Preact UI (chat, settings, dock)
    hooks/            Preact hooks (voice client, awaiting-tracker, …)
    services/         API clients (auth, profile, providers)
    styles/           CSS modules
    main.tsx          Entry point
  vite.config.ts      Vite + COOP/COEP headers
  package.json
```

## Build & deploy

The webui is built as part of the gateway's Docker image — see
`gateway/Dockerfile`. The build stage runs `bun run build` and copies
`dist/` into `/app/webui/dist/` in the runtime image; the gateway
process serves those files at `/` over the same HTTPS port that
hosts the WebSocket.

For local Docker:

```bash
docker compose -f deploy/docker/docker-compose.yml build gateway
docker compose -f deploy/docker/docker-compose.yml up -d gateway
# https://localhost:8888/
```
