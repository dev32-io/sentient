# Android Client

Kotlin/Compose mobile client for Sentient voice assistant. Deferred to Phase 6.

## MANDATORY — Read Rules First

Rules live at the repo root: cross-cutting at `.claude/rules/*.md`, android-specific at `.claude/rules/android/*.md`. Auto-loaded by Claude Code via `paths:` frontmatter when you read matching source. Android details: `agents/docs/android/*-details.md`.

## Stack

- Language: Kotlin
- UI: Jetpack Compose
- DI: Koin
- Networking: OkHttp WebSocket
- Wake word: Porcupine (Picovoice)
- Audio: AudioRecord + ring buffer
- Build: Gradle

## Status

Not yet implemented. Rules and architecture documented for when Phase 6 begins.
