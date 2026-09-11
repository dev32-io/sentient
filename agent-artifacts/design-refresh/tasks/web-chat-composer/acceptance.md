# Task Acceptance: Build the Web ChatComposer and internal capture-aware VoiceCaptureControl

## Deliverables

- Replace the legacy mic rail/composer visuals with the reviewed native product composite while preserving text, task, playback, interruption, and capture safety semantics.

## Acceptance

- Manual Send commits, Cancel discards, Hold-to-Auto commits then opens a new semantic capture, and active Auto finalizes/exits.
- No frame follows terminal and stale actions cannot affect newer captures.
- Text-only composer remains fully usable when microphone permission is denied.
- Task activity remains server-owned outside bubbles; Interrupt remains foreground-only.
- Keyboard, screen reader, 390px/200% zoom, 44px targets, and Reduced Motion are covered.

## Boundary Proof

- Fake-connector/component tests pin every capture transition and text/task/interrupt invariant.
- E2E-002 and E2E-005 use text only and never activate voice controls.
