# iOS Client

Native iOS client for Sentient — a thin SwiftUI UI over the shared KMP SDK (`shared/mobile-sdk`), linked as a SKIE-processed XCFramework. Transport, session/audio state, reconnect, and logging live in the SDK, not here. STT/TTS are server-side; no on-device wake word in v1.

## MANDATORY — Read Rules First

Before modifying iOS source, load: cross-cutting `.claude/rules/*.md`, iOS UI `.claude/rules/ios/*.md`, shared-SDK `.claude/rules/mobile-sdk/*.md` (this app consumes it), and mobile-cross `.claude/rules/mobile/*.md`. Claude Code auto-loads them via `paths:` frontmatter. Details on demand: `agents/docs/{ios,mobile-sdk,mobile}/*-details.md`.

The rules own the stack and conventions (Swift/SwiftUI, SKIE bridging, xcodegen+xcodebuild, Maestro) — don't restate them here. 
