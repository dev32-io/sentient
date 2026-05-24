# iOS Client

Swift/SwiftUI mobile client for Sentient voice assistant. Deferred to Phase 6.

## MANDATORY — Read Rules First

Rules live at the repo root: cross-cutting at `.claude/rules/*.md`, iOS-specific at `.claude/rules/ios/*.md`. Auto-loaded by Claude Code via `paths:` frontmatter when you read matching source. iOS details: `agents/docs/ios/*-details.md`.

## Stack

- Language: Swift
- UI: SwiftUI
- Networking: URLSessionWebSocketTask
- Wake word: Porcupine (Picovoice)
- Audio: AVAudioEngine + TPCircularBuffer
- Build: Xcode + xcodegen

## Status

Not yet implemented. Rules and architecture documented for when Phase 6 begins.
