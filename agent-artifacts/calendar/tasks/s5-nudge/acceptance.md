# Task Acceptance: Calendar session-start nudge composer

## Deliverables

- Deliver the calendar nudge composer that appends a capped, deterministic session-start summary (today + this week important/pinned) after the memory block in augmentPrompt, applying role-based visibility and omitting the block entirely for an empty calendar.

## Acceptance

- AC-007: the nudge never exceeds its cap; an empty calendar renders no nudge block
- The nudge composes today's events plus this week's important or pinned, hard-capped, ending with an '...and N more' overflow line
- The nudge applies role-based visibility (children omit adults events) and is appended after the memory block
- Nudge over-budget drops overflow summaries then non-important weekly items, keeping today plus important/pinned

## Boundary Proof

- Nudge tests cover cap enforcement, overflow line, empty-calendar omission, child adults-event omission, and deterministic drop order
