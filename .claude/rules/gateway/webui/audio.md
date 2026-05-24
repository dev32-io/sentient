---
paths:
  - "gateway/webui/src/**/*.tsx"
  - "gateway/webui/src/**/*.ts"
---
# Audio Rules

- AudioWorklet for audio capture (PCM16 via Float32→Int16 conversion, no MediaRecorder).
- AudioWorklet for TTS playback (ring buffer, 96KB, drop-oldest overflow).
- COOP/COEP headers required for SharedArrayBuffer (AudioWorklet).
- Toggle-to-talk: click once to start recording, click again to stop.
- Barge-in: stop playback, clear ring buffer, send barge_in message.
- Handle mic permission denial gracefully (text-only fallback).

> When a rule is unclear, read `agents/docs/audio-details.md`.
