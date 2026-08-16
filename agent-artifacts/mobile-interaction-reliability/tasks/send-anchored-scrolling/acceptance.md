# Task Acceptance: Anchor mobile chat on the newly sent user message

## Deliverables

- A newly sent user row moves to the top of the viewport once, while assistant creation, streaming, tools, and later row growth never move the viewport programmatically.

## Acceptance

- Every newly sent user row is positioned with its beginning at the viewport top exactly once
- A viewport-taller user message anchors at its beginning
- Assistant output and all subsequent row/content growth produce no programmatic scroll
- Pending-to-committed reconciliation retains the anchor without a second movement
- Initial existing-session load may still position at the latest message
- Behavior is equivalent on supported iOS versions and Android

## Boundary Proof

- Android unit tests pin send-only anchor decisions and stable row identity
- iOS tests replace FollowLatest expectations with send-anchor, no-assistant-scroll, long-message, and initial-load behavior
- Accessibility seams let the unattended E2E runner observe the relevant row anchors
