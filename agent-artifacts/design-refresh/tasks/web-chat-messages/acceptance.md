# Task Acceptance: Refresh Web chat message chronology, bubbles, and assistant identity states

## Deliverables

- Implement the reviewed message-bubble product composite for committed and streaming text while preserving session projection, Markdown, interruption, and task separation.

## Acceptance

- One durable/streaming projection is visible per message with no duplicate assistant reply.
- Thinking/responding/idle map according to product state; listening is impossible.
- Task activity remains outside message bubbles.
- Content remains readable and unclipped at narrow width and 200% zoom.
- Markdown, interruption, grouping, and accessibility chronology remain correct.

## Boundary Proof

- Focused component/helper tests cover projection, state mapping, grouping, Markdown, overflow, and task exclusion.
- Text-only E2E-002 selectors expose thinking/responding/completed/interrupted states without using TTS.
