# Android Client

Native Android client for Sentient — a thin Jetpack Compose UI over the shared KMP SDK (`shared/mobile-sdk`). Transport, session/audio state, reconnect, and logging live in the SDK, not here. STT/TTS are server-side; no on-device wake word in v1.

## Build

Signed apk: `./scripts/build-android.sh`. Release signing reads the gitignored
`android/keystore.properties` (generate via `scripts/android-make-keystore.sh`); absent →
release is unsigned so contributors can still build. See `docs/mobile-release.md`.
