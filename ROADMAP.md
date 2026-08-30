# Roadmap

Sentient serves one household from an Apple-silicon Mac. This file describes
current product direction, not the dated implementation history under
`docs/superpowers/`.

## Current foundation

- Native Bun gateway with provider calls, streamed ReAct, tool mediation,
  compaction, and gateway-owned durable sessions.
- Multi-window session attachment, reconnect replay, past-session history, and
  streamed tool and permission state.
- Local Whisper STT, Qwen3 TTS, Markdown memory, optional Deep Memory recall,
  and nightly consolidation.
- Web research, calendar, Home Assistant, Music Assistant, reusable skills, and
  optional one-shot Hermes delegation.
- Native macOS production install under `launchd`, with gateway-supervised
  native services and Docker addons.
- Production Preact web client plus active Android, iOS, ESP32 cube, and devtool
  clients.

## Active priorities

### Mobile clients

Keep the Android and iOS apps aligned with the shared session and wire
contracts. The native apps already implement text chat, history, settings,
voice controls, permissions, and task state. Remaining validation is focused on
the complete physical acoustic voice loop and release quality rather than a
future mobile-client launch claim.

### ESP32 cube

Bring the cube onto the complete current session protocol while continuing the
reusable firmware SDK extraction. The hardware, Opus audio path, pairing,
display, touch, microphone, speaker, logging, and companion diagnostics are
already development surfaces. See [`esp32/STATUS.md`](esp32/STATUS.md).

### Reliability and safety

Continue hardening durable task execution, reconnect and multi-window behavior,
content trust boundaries, capability path handling, and addon recovery. Stable
wire, state-machine, and authorization boundaries should gain regression tests
when a concrete gap is found.

### Operations

Keep the Apple-silicon installer, health-gated rollback, local model packaging,
and loopback/container network boundaries reproducible. Production remains
observational-only outside an explicitly authorized deployment action.

## Product boundaries

- Self-hosted household assistant; no hosted Sentient service is planned here.
- Apple-silicon macOS is the supported full-stack host. Raspberry Pi deployment
  is retired.
- The gateway remains the agent runtime. Hermes remains optional one-shot
  delegation, not a standing worker fleet.
- Mobile apps remain thin native clients over shared KMP state and transport.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the current system and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for development commands.
