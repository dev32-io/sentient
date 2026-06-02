# Android Client

Native Android client for Sentient — a thin Jetpack Compose UI over the shared KMP SDK (`shared/mobile-sdk`). Transport, session/audio state, reconnect, and logging live in the SDK, not here. STT/TTS are server-side; no on-device wake word in v1.

## MANDATORY — Read Rules First

Before modifying Android source, load: cross-cutting `.claude/rules/*.md`, Android UI `.claude/rules/android/*.md`, shared-SDK `.claude/rules/mobile-sdk/*.md` (this app consumes it), and mobile-cross `.claude/rules/mobile/*.md`. Claude Code auto-loads them via `paths:` frontmatter. Details on demand: `agents/docs/{android,mobile-sdk,mobile}/*-details.md`.

The rules own the stack and conventions (Kotlin/Compose, Hilt, Gradle catalog) — don't restate them here. 
