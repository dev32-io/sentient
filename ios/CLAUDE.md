# iOS Client

Native iOS client for Sentient — a thin SwiftUI UI over the shared KMP SDK (`shared/mobile-sdk`), linked as a SKIE-processed XCFramework. Transport, session/audio state, reconnect, and logging live in the SDK, not here. STT/TTS are server-side; no on-device wake word in v1.

## Build

Local dev: `./scripts/ios-setup.sh` (builds the debug KMP XCFramework to the stable path +
generates the project), then open `ios/SentientApp.xcodeproj`. Release ipa: `./scripts/build-ios.sh`.
See `docs/mobile-release.md`.
