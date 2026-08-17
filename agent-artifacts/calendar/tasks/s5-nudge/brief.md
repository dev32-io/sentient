# Task Brief: Calendar session-start nudge composer

## Contribution Goal

Deliver the calendar nudge composer that appends a capped, deterministic session-start summary (today + this week important/pinned) after the memory block in augmentPrompt, applying role-based visibility and omitting the block entirely for an empty calendar.

## Boundary — Included

- composeCalendarNudge(store, role, tz, now, budget) producing a capped summary or null for an empty calendar
- Deterministic drop order: overflow summaries first, then non-important weekly items, keeping today plus important/pinned
- Role-based visibility via the store query layer
- Integration into augmentPrompt after the memory block with its own char/line budget
- '...and N more' overflow line when capped

## Required Work

- 1. Create gateway/src/calendar/nudge.ts with composeCalendarNudge(store, role, tz, now, budget) returning a string or null for an empty calendar.
- 2. Select today's events plus this week's important/pinned events, hard-cap by char/line budget, and append an '...and N more' overflow line.
- 3. Apply role-based visibility by querying through the store's visibility-filtered list.
- 4. Implement the deterministic drop order: drop overflow summaries first, then non-important weekly items, keeping today plus important/pinned.
- 5. Integrate the nudge into augmentPrompt in phase-services after the memory block, composed once at session build.
- 6. Add tests for cap enforcement, overflow line, empty-calendar omission (AC-007), child adults-event omission (AC-003 at nudge), and drop order; assert no content is logged.
- 7. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s5-nudge.

## Context

- Memory augmentation appends a block to the session system prompt in phase-services (SessionMemory.augmentPrompt); composeMemoryBlock enforces cfg.prompt_budget_chars with a deterministic drop order and logs counts not content.
- The nudge composes once per session on the augmentPrompt seam, after the memory block, with its own char/line budget and deterministic drop order.
- Prompt-cache stability requires the nudge be composed once at session build, not mutated after calendar writes.
- CalendarStore.list with visibility filtering and expandRecurrence provide the nudge input.

## Boundary — Excluded

- Dynamic per-turn stimuli (out of scope: long-session staleness handled by agent calling calendar_list)
- REST, web, mobile

## Interfaces and Dependencies

- Produces: calendar nudge block appended in augmentPrompt; composeCalendarNudge module.
- Consumes: CalendarStore.list with visibility from s3-store-list-filter; augmentPrompt seam from s5-phase-bootstrap; TimeZoneProvider from message-time.
