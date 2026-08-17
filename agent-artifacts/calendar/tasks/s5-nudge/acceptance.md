# Task Acceptance: Calendar session-start nudge composer (household-tz today) with prompt-cache stability proof

## Deliverables

- Deliver the calendar nudge composer that appends a capped, deterministic session-start summary (today + this week important/pinned, 'today' = household-tz today via resolveTimeZone()) after the memory block in augmentPrompt, applying role-based visibility and omitting the block entirely for an empty calendar, with prompt-cache stability proven.

## Acceptance

- AC-007: the nudge never exceeds its cap; an empty calendar renders no nudge block
- The nudge composes today's events plus this week's important or pinned, hard-capped, ending with an '...and N more' overflow line; 'today' is household-tz today via the existing resolveTimeZone() seam
- The nudge applies role-based visibility (child/guest omit adults events via isAdult) and is appended after the memory block
- Nudge over-budget drops overflow summaries then non-important weekly items, keeping today plus important/pinned
- Prompt-cache stability: two turns around a calendar write produce a byte-identical system prompt (the nudge is composed once at session build)

## Boundary Proof

- Nudge tests cover cap enforcement, overflow line, empty-calendar omission (AC-007), child/guest adults-event omission (AC-003 at nudge), admin/adult visibility, household-tz 'today' rendering with explicit offsets, deterministic drop order, and prompt-cache stability across an in-session write
