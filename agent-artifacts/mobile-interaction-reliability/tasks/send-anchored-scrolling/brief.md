# Task Brief: Anchor mobile chat on the newly sent user message

## Contribution Goal

A newly sent user row moves to the top of the viewport once, while assistant creation, streaming, tools, and later row growth never move the viewport programmatically.

## Boundary — Included

- Android and iOS MessageList send-top anchoring
- Stable optimistic/committed user-row identity for scrolling
- Initial history positioning retained separately from live send behavior
- Focused state/layout tests and accessibility evidence for agentic viewport verification

## Required Work

- 1. Replace follow-latest/bottom-follow triggers in Android MessageList and iOS MessageList with a one-shot send-anchor transition driven only by a newly observed outbound pending/user-send identity.
- 2. Give the optimistic user row and its committed echo a stable scroll identity using the existing pendingId/message metadata; reconciliation must not remount or scroll the row again.
- 3. Scroll the beginning of the newly sent row to the viewport top even when the user was previously elsewhere. For content taller than the viewport, anchor its beginning rather than its end.
- 4. Remove programmatic scrolling caused by assistant row creation, token/content growth, TTS state, tool/task updates, pending-to-committed reconciliation, or the user being at the bottom.
- 5. Preserve a separate non-animated initial/session-history positioning path that may land at the latest message, including existing snapshot-loading behavior.
- 6. Replace obsolete FollowLatest tests with pure/testable send-anchor reducer or identity tests on iOS and add equivalent Android tests. Cover short sends, long sends, reconciliation, assistant streaming, prior user scroll, and initial history load.
- 7. Add or preserve stable accessibility identifiers needed for an unattended E2E agent to compare the anchored user row and viewport before/after assistant streaming.
- 8. Run focused native tests and git diff --check.

## Integration Expectation

Deliver this contribution for integration in stage foundation.

## Context

- Android MessageList currently animates to the last rendered row whenever row count or the last message content changes.
- iOS MessageList follows messages.count, last content, and pending count; iOS 17 follows unconditionally and iOS 18 follows while pinned.
- Outbound pending rows provide the user-send edge. The optimistic row and committed echo need one stable anchor identity so reconciliation does not trigger another movement.
- This task is deliberately list/row scoped so it can proceed independently from fresh-chat session wiring.

## Boundary — Excluded

- Changing web chat scrolling
- Changing message bubble appearance or spacing
- Changing outbound delivery/session behavior
- Adding manual visual verification steps

## Interfaces and Dependencies

- Consumes ChatMessage/PendingMessage identity and existing MessageList rows; produces one top-anchor command per newly sent user identity.
- Proof seam: pure anchor-decision tests plus native list behavior and accessibility-visible row identity.
- Supports the agent-driven send/stream journeys E2E-004, E2E-005, E2E-006, and existing-session E2E-010.
