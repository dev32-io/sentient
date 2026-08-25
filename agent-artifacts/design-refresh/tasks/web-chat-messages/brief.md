# Task Brief: Refresh Web chat message chronology, bubbles, and assistant identity states

## Contribution Goal

Implement the reviewed message-bubble product composite for committed and streaming text while preserving session projection, Markdown, interruption, and task separation.

## Boundary — Included

- Committed user/assistant messages, streaming assistant growth, Markdown, chronology/grouping, day dividers, interruption marker, empty/loading/error presentation within chat content, Rive placement/state mapping, responsive/accessibility behavior.

## Required Work

- 1. Migrate included chat content to Web shared primitives and the Sentient identity adapter. Create task-owned CSS and replicate the reviewed composition in design/prototype/chat-message-bubbles/; never import prototype runtime files.
- 2. Preserve current server/session message projection and exactly-one-visible-message behavior. Do not create a conversation mirror or duplicate server state. A streaming assistant bubble grows vertically and reconciles to the durable response without duplication.
- 3. Implement role rhythm and same-speaker grouping with repeated-avatar suppression where the reviewed handoff requires it, while retaining clear screen-reader role/author/chronology labels. Preserve day-divider semantics and interruption/cutoff presentation.
- 4. Constrain readable content to the reviewed responsive measure (up to 62ch) without clipping long tokens, code blocks, Markdown, or streaming text at desktop, 390px width, and 200% zoom.
- 5. Map assistant state through exactly idle/thinking/responding. Awaiting cognition/action uses thinking; first streaming text and active assistant playback use responding; completion/interruption returns idle when no newer active turn exists. Rapid updates must converge through the Rive wrapper; do not add CSS choreography.
- 6. Preserve Markdown sanitization/link behavior and existing bubble text/speaking-wave semantics where still applicable. Reduced Motion removes nonessential native wave motion while the Rive asset receives reducedMotion.
- 7. Keep task activity exclusively outside messages in the server-owned full-state composer shelf. No tool names, arguments, results, or progress pills appear in bubbles.
- 8. Add focused tests for chronology/grouping, Markdown, long tokens/code, streaming reconciliation, one bubble per reply, interrupted response, state mapping/latest turn, no task pills, reduced motion, and accessible labels.

## Integration Expectation

Deliver this contribution for integration in stage product-surfaces.

## Context

- Owned paths are gateway/webui/src/components/chat/{chat-view,message-list,message-bubble,bubble-text,bubble-speaking-wave,interrupt-chip,day-divider}.tsx and chat-specific styles/tests.
- Current full-state task activity is passed separately to ComposerTaskStrip; tool/task pills must never be added to bubbles.
- Assistant state contract is exactly idle/thinking/responding. Cognition/acting/processing map to thinking; streaming assistant text and assistant speech/playback map to responding; voice capture never drives identity.

## Boundary — Excluded

- Composer, microphone, task shelf, text-send controls
- Session/API/store redesign
- Audio playback implementation
- iOS/Android work
- Prototype runtime imports

## Interfaces and Dependencies

- Consumes current message/cycle projections and the three-state Web Sentient identity.
- Produces the refreshed ChatView/message list/bubble content while leaving composer/task props unchanged.
