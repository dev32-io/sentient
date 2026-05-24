# Roadmap

This is what's done, what's in progress, and what's coming.

## Done

- **Gateway** — Bun/TypeScript voice gateway, production-stable. Cognitive
  cycle, attention gate, salience accumulation, barge-in arbitration,
  interrupt controller, decorator-pattern TTS pipeline, MCP host, Hermes
  adapter client. PASETO browser auth + shared-token service auth.
- **STT Service** — local Python service (Silero VAD + Smart-Turn v3 +
  SenseVoice-Small) shipping over WebSocket.
- **Web client** — Preact toggle-to-talk UI with settings + admin panes,
  PIN login, WebRTC AEC loopback.
- **Hermes integration** — per-user worker pool managed by supervisord
  inside a single `sentient-hermes` container.
- **Local + Pi deployment** — docker compose for both targets, host-side
  `~/.sentient/` layout for persistent state.

## In progress

### ESP32-S3 cube (Phase 5.5)

A small hardware client with a touchscreen, mic, and speaker that talks to
the same gateway. Phase 1–5 done: foundation, display + touch, speaker,
sentient connect, opus end-to-end pivot. Phase 6 (cube SDK extraction)
underway. See `esp32/STATUS.md` and `esp32/cube/` for current state.

## Planned, not yet started

### Android client

A Kotlin/Compose native client that uses the same WebSocket protocol as
the browser. Will share configuration shape with the web client via the
existing protocol package. See `android/STATUS.md`.

### iOS client

Same idea, Swift/SwiftUI. See `ios/STATUS.md`.

### Latency measurement + tuning

Tabulate p50/p90/p99 at each pipeline stage (mic capture → VAD → STT
first-partial → STT final → LLM first-token → TTS first-byte → speaker
first PCM). Commit to `docs/latency.md`. Tune the slow legs.

### Demo capture

A 30–60 second screen capture of a conversation including a barge-in,
linked from the README.

## Won't do (in this repository)

- **Hosted demo** — the system runs on your own hardware. There's no
  managed instance.
- **Pre-built binary releases** — install is `docker compose build` from
  source. Pre-built images can come later if there's demand from
  contributors.
- **Translations / i18n** — out of scope for the v1 release.

## Contributing to the roadmap

Open an issue if there's a missing feature you'd want, or a "good first
issue" tag that interests you. See `CONTRIBUTING.md`.
