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

## Login and navigation

Coming Home uses the shared avatar and PIN controls, including desktop keyboard
input. Verification retains at least 700 ms of checking and 250 ms of accepted
feedback, then fades directly into chat over 250 ms without a welcome page.
Back cancels the login attempt; late responses cannot persist authentication.
Fresh login opens chat; an existing authenticated session restores its route.

The brand returns to chat without creating a conversation. History selection and
New chat change route only after a successful session operation. Leaving dirty
settings offers **Stay / Discard changes** before navigation or session effects;
a pending save must settle first. Discard does not undo completed immediate saves.
Clean settings can be left, including Sign out, without a confirmation.

Calendar refresh keeps useful content in place rather than inserting a flashing
loading bar. Initial loading, errors and retry remain explicit. Editors preserve
drafts across incidental refreshes and retain the original revision for conflict
checks; changing the target or closing/reopening starts a fresh editor.

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

## Isolated product review

With Vite running, these DEV-only pages render actual production components using
fictional fixtures:

- `/product-review.html?page=login&state=populated`
- `/product-review.html?page=history&state=populated`
- `/product-review.html?page=settings&pane=memory` (navigate to the other panes)
- `/calendar-evidence.html?view=month&shell=app` (also `day`, `week`, `year`)

Product review uses isolated in-memory storage, default-deny fixture fetches and
transport-blocking CSP. It does not authenticate against the gateway, play audio,
or prove real API/Rive behavior. Test real flows separately against a disposable
local fixture, never production. See [`qa/design-refresh`](../../qa/design-refresh/).

Use native browser zoom for 200% checks; resizing the viewport is not equivalent
zoom evidence. Native Chrome zoom can crop Playwright's default screenshot clip:
verify raster dimensions against viewport/DPR, or capture the full visible surface
with CDP `Page.captureScreenshot` without a clip and with
`captureBeyondViewport: false`.

## Build and production serving

Build with `bun run build` in this package. The resulting `dist/` is packaged
with the native gateway release and served by the gateway on the same HTTPS
origin as `/api/v1/ws`. Production gateway lifecycle is owned by `launchd` and
the health-gated installer under `deploy/mac-prod/`; do not use Docker Compose
to build or start the gateway.
