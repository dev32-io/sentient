# Task Brief: Calendar session-start nudge composer (household-tz today) with prompt-cache stability proof

## Contribution Goal

Deliver the calendar nudge composer that appends a capped, deterministic session-start summary (today + this week important/pinned, 'today' = household-tz today via resolveTimeZone()) after the memory block in augmentPrompt, applying role-based visibility and omitting the block entirely for an empty calendar, with prompt-cache stability proven.

## Boundary — Included

- composeCalendarNudge(store, role, householdTz, now, budget) producing a capped summary or null for an empty calendar
- Deterministic drop order: overflow summaries first, then non-important weekly items, keeping today plus important/pinned
- Role-based visibility via the store query layer (isAdult)
- Integration into augmentPrompt after the memory block with its own char/line budget
- '...and N more' overflow line when capped
- 'today' via the existing resolveTimeZone() household tz, stamps with explicit offsets
- Prompt-cache stability test: two turns around a calendar write produce a byte-identical system prompt

## Required Work

- 1. Create gateway/src/calendar/nudge.ts with composeCalendarNudge(store, role, householdTz, now, budget) returning a string or null for an empty calendar; use the existing resolveTimeZone() household tz for 'today'.
- 2. Select today's events plus this week's important/pinned events, hard-cap by char/line budget, and append an '...and N more' overflow line; render stamps with explicit offsets via the existing message-time helpers.
- 3. Apply role-based visibility by querying through the store's visibility-filtered list (isAdult).
- 4. Implement the deterministic drop order: drop overflow summaries first, then non-important weekly items, keeping today plus important/pinned.
- 5. Integrate the nudge into augmentPrompt in phase-services after the memory block, composed once at session build.
- 6. Add tests for cap enforcement, overflow line, empty-calendar omission (AC-007), child/guest adults-event omission (AC-003 at nudge), admin/adult visibility, household-tz 'today' rendering with explicit offsets, drop order, and prompt-cache stability (two turns around a calendar write produce a byte-identical system prompt); assert no content is logged.
- 7. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s5-nudge.

## Context

- Memory augmentation appends a block to the session system prompt in phase-services (SessionMemory.augmentPrompt); composeMemoryBlock enforces cfg.prompt_budget_chars with a deterministic drop order and logs counts not content.
- The nudge composes once per session on the augmentPrompt seam, after the memory block, with its own char/line budget and deterministic drop order.
- Prompt-cache stability requires the nudge be composed once at session build and NOT mutated after calendar writes within the session.
- Timezone model: 'today' and 'this week' are household-tz today via the existing resolveTimeZone() / TimeZoneProvider (host zone today). Stamps carry explicit offsets (gateway/src/context/message-time.ts). The nudge never needs a user current tz — that belongs to the future scheduler.
- CalendarStore.list with visibility filtering (isAdult) and expandRecurrence (event tz) provide the nudge input.

## Boundary — Excluded

- Dynamic per-turn stimuli (out of scope: long-session staleness handled by the agent calling calendar_list)
- REST, web, mobile
- User-current-tz / scheduler (future)

## Interfaces and Dependencies

- Produces: calendar nudge block appended in augmentPrompt; composeCalendarNudge module.
- Consumes: CalendarStore.list with visibility from s3-store-reads; augmentPrompt seam from s5-phase-bootstrap; resolveTimeZone() / TimeZoneProvider from message-time; event-tz model from s1-domain-contracts.
