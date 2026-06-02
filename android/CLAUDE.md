# Android Client

Native Android client for Sentient. Thin Jetpack Compose UI consumer of the shared KMP SDK (`shared/mobile-sdk`).

## MANDATORY — Read Rules First

Rules live at the repo root. Load ALL of these before modifying Android source:

- Cross-cutting: `.claude/rules/*.md`
- Android UI app: `.claude/rules/android/*.md`
- Shared KMP SDK (consumed by this app): `.claude/rules/mobile-sdk/*.md`
- Mobile cross-platform: `.claude/rules/mobile/*.md`

Details: `agents/docs/android/*-details.md`, `agents/docs/mobile-sdk/*-details.md`, `agents/docs/mobile/*-details.md`.

## Stack

- Language: Kotlin
- UI: Jetpack Compose + Material3
- DI: Hilt (NOT Koin — compile-time graph validation)
- Transport + session/audio FSM: `shared/mobile-sdk` KMP module (Ktor OkHttp WS engine on Android). The Android app does NOT own WebSocket, reconnect, or session state — those live in the SDK.
- Build: Gradle (Kotlin DSL + version catalog `gradle/libs.versions.toml`)
- Push: UnifiedPush / ntfy (self-hosted on Pi; no Google / no Firebase) — Phase 4

STT and TTS are server-side (gateway). No on-device wake word in v1.

## Status

**Phase 0 (Foundation) complete.** App builds, launches on emulator, and renders the SDK greeting via the shared KMP module. Agent dev-loop validated (`android` CLI + `adb logcat`). Reaches local gateway at `10.0.2.2:8888`.

Later phases: P1 WS transport, P2 text chat UI, P3 voice, P4 push. See `STATUS.md` and `docs/superpowers/plans/`.

## Commands

    ./gradlew :android:assembleDebug   — Build debug APK
    ./gradlew :android:assembleRelease — Build release APK
    android run --apks=…               — Install + launch on emulator
    adb logcat                         — Stream logs
