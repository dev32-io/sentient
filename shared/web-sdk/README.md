# @sentient/web-sdk

Voice client SDK for Sentient. Handles voice mode, VAD, transport, and state management.

## Dependencies

- `@ricky0123/vad-web` — Silero VAD (ML-based voice activity detection)
- `onnxruntime-web` — ONNX Runtime for Silero model inference (transitive via vad-web)

## Silero VAD Setup

Silero VAD requires ONNX Runtime WASM files served as static assets. The consuming application (e.g., `web/`) must:

1. Copy WASM + model files to a public directory (see `web/scripts/copy-vad-assets.sh`)
2. Serve with COOP/COEP headers for `SharedArrayBuffer` support:
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: credentialless
   ```
3. Optionally configure the asset path via `createSileroVadFilter({ assetPath: "/vad/" })`

If Silero fails to init (missing WASM, no SharedArrayBuffer), the SDK falls back to energy-only VAD with a console warning.

## VAD Chain

```
Microphone audio (PCM16 frames)
  → Energy VAD filter (RMS threshold, ~0ms)
  → Silero VAD filter (ML classifier, ~10ms)
  → Trailing VAD filter (sends 1500ms of silence after speech)
  → Transport → Gateway → Deepgram
```

Client-side VAD is a **cost optimization gate** — it reduces bandwidth to Deepgram. The gateway makes the authoritative turn boundary decision.

## Key Interfaces

- `VoiceClient` — main API surface (`connect`, `startVoiceMode`, `stopVoiceMode`)
- `AudioCaptureAdapter` — mic input abstraction
- `AudioPlaybackAdapter` — speaker output abstraction (WebRTC AEC loopback in `web/`)
- `VadFilter` — pluggable VAD filter interface
