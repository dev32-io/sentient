# Sentient Web Client

Preact client for the Sentient voice gateway. Vite builds a static bundle under
`dist/`; the native gateway serves it directly in production. There is no
webui or gateway application container.

## Development

From the repository root:

```bash
bun install
bun run dev            # complete local stack: gateway, Vite, and managed addons
```

For UI-only iteration, run `bun run dev` in `gateway/webui/`. Vite listens
strictly on port 5173 and proxies `/api/v1/ws` plus `/api/v1/*` to the local
gateway at `https://localhost:8888`.

## Audio path

Capture and playback use AudioWorklets rather than `MediaRecorder`.

```text
mic PCM (48 kHz)
  -> RNNoise denoise + speech probability
  -> speech latch with pre-roll
  -> Opus encoder
  -> /api/v1/ws
  -> gateway -> whisper-stt

turn audio from gateway
  -> Opus decoder
  -> turn-keyed FIFO
  -> AudioWorklet playback
```

The gateway/STT service owns the final utterance boundary. The browser speech
latch opens only after sustained speech and closes when the gateway emits a
user-triggered `turn.started`. Echo handling combines playback-state gating,
RNNoise thresholds, a gateway cooldown, and optional browser WebRTC AEC.
Failure to establish the AEC loopback must not disable voice capture.

A new `turn.audio.start` queues behind existing audio. Only `playback.stop`
from barge-in or interrupt flushes the queue.

AudioWorklets and WASM workers require cross-origin isolation. Keep these
headers aligned in both locations:

| Environment | Configuration |
|---|---|
| Vite | `vite.config.ts` → `server.headers` |
| Native gateway static serving | `../src/api/handlers/webui.ts` |

Use `Cross-Origin-Embedder-Policy: credentialless` with
`Cross-Origin-Opener-Policy: same-origin`.

## Commands

```bash
bun run dev       # Vite development server with HMR
bun run build     # production bundle -> dist/
bun run test      # Vitest
bun run typecheck # TypeScript strict check
```

## Project structure

```text
gateway/webui/
  src/
    adapters/       capture, playback, and WebRTC AEC integration
    audio/          worklets, Opus codecs, RNNoise, and buffers
    components/     Preact UI
    hooks/          gateway/voice state composition
    services/       REST clients
    styles/         application styles
    main.tsx        entry point
  vite.config.ts
  package.json
```

## Build and production serving

Build with `bun run build` in this package. The resulting `dist/` is packaged
with the native gateway release and served by the gateway on the same HTTPS
origin as `/api/v1/ws`. Production gateway lifecycle is owned by `launchd` and
the health-gated installer under `deploy/mac-prod/`; do not use Docker Compose
to build or start the gateway.
