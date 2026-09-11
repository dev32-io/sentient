# Task Acceptance: Refresh the native iOS chat, messages, task shelf, and capture-aware composer

## Deliverables

- Implement the complete native chat product composition—including reviewed messages and encapsulated composer—while preserving session projection, optimistic outbox, permissions, tasks, playback, and capture semantics.

## Acceptance

- Optimistic text reconciles without duplicate messages and streaming/Markdown/interruption remain durable.
- Thinking/responding/idle map correctly; capture never drives identity.
- Manual Send/Cancel/Hold-to-Auto/Auto exit call KMP semantic intents correctly with stale isolation.
- Task shelf stays outside bubbles; Interrupt remains foreground-only.
- Text-only chat is usable with mic denied; native Dynamic Type, safe area, focus, 44pt targets, and Reduced Motion remain correct.

## Boundary Proof

- iOS unit/view tests use fake KMP/audio state to pin all behavior without capture/playback.
- E2E-007 exercises only text send/stream/interrupt and sanitized state selectors.
