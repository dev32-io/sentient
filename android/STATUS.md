# Android Client — Status

## What this is

A native Android client that speaks the same WebSocket protocol as the web
client, built as a thin Jetpack Compose consumer of the shared KMP SDK
(`shared/mobile-sdk`). Targets Kotlin + Compose.

## Current state

**Phase 0 (Foundation) complete.** The app builds against the
`:shared:mobile-sdk` KMP module, launches on the `Pixel_3a_API_34` emulator,
and renders the SDK greeting (Compose `testTag` = `foundation-greeting`).
Debug builds trust the self-signed local-stack cert via a dev-host-scoped
`network_security_config` (10.0.2.2 / localhost); release builds use system
trust only.

Working:
- Compose app consuming `MobileSdk.greeting()` from the shared SDK.
- Agent dev-loop validated: `android` CLI (build / install / screen / layout) + `adb logcat`.
- Reaches the local gateway at `10.0.2.2:8888`.

Not yet built (later phases): real SDK wiring — WS transport (P1), chat UI (P2),
voice (P3), push (P4). See `docs/superpowers/plans/` and `qa/mobile/README.md`
(incl. P2 carry-forwards: Material3 theme, R8 release config). E2E contract:
`qa/mobile/foundation-matrix.md`.
