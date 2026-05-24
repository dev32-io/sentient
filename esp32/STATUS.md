# ESP32 Cube — Status

## What this is

A small hardware client built around the ESP32-S3 with a touchscreen,
mic, and speaker, that talks to the Sentient gateway over the same
WebSocket protocol as the browser client.

## Current state

**In active development. Phase 5.5 (opus end-to-end pivot) complete.**

Working today:
- WiFi onboarding via the gateway's pairing flow
- USB-CDC + UDP log shipping to the gateway log sink
- LVGL UI on the touchscreen
- Mic capture + speaker playback
- Opus codec end-to-end with the gateway
- Daemon for persistent USB-CDC sessions during dev

In progress:
- Cube SDK extraction (Phase 6) — refactoring the cube as a downstream
  consumer of a reusable SDK, so future hardware variants don't fork the
  firmware tree.

See `esp32/cube/firmware/` for the firmware tree (vendored from
xiaozhi-esp32 at SHA `b72945a` — see
`esp32/cube/firmware/THIRD_PARTY_NOTICES.md`).

See `esp32/cube/scripts/` for the dev tooling (cube-daemon, flash
scripts, agent console).
