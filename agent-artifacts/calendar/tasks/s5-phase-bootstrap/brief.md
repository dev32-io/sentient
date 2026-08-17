# Task Brief: Mint calendar capabilities and wire the tool group in phase-services

## Contribution Goal

Mint calendar-private and calendar-household capabilities and open their CalendarStores in phase-services, wire the calendar product tool group into the session, and add a calendar config flag, preserving prompt-cache stability.

## Boundary — Included

- grant calendar-private and calendar-household capabilities and open CalendarStores per session alongside memory
- Wire the calendar product tool provider into the product-tool-provider composition feeding the broker
- Add an orchestratorCfg.calendar config flag (enabled, recurrence limits, nudge budget) and disable gracefully when off
- Preserve session system-prompt composition once-per-session and cache stability

## Required Work

- 1. Add an orchestratorCfg.calendar config section (enabled, recurrence limits, nudge budget) following the memory config pattern.
- 2. In phase-services.ts, grant calendar-private and calendar-household capabilities and open their CalendarStores alongside memory when enabled.
- 3. Wire calendarProductToolProvider into the product-tool-provider composition feeding the broker.
- 4. Add tests for capability minting, store open, tool wiring, and the disabled graceful path; assert session prompt is still composed once.
- 5. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s5-phase-bootstrap.

## Context

- Session memory is built in gateway/src/bootstrap/phase-services.ts buildSessionMemory: grant memory-private, open store, grant memory-household, open store, build tools, return augmentPrompt() and spark.
- Session system prompt is composed once via composeSessionSystemPrompt then sessionMemory.augmentPrompt; prompt-cache stability must be preserved.
- Calendar must mint calendar-private and calendar-household capabilities and open stores alongside memory, and wire calendar tools into the product-tool-provider composition.
- The calendar config should be feature-flagged like memory (orchestratorCfg.calendar.enabled).

## Boundary — Excluded

- Nudge composition (next task)
- REST, web, mobile

## Interfaces and Dependencies

- Produces: calendar capability minting and tool wiring in phase-services; calendar config.
- Consumes: calendarProductToolProvider from s4-tool-provider; CalendarStore from s3; AccessManager from s1.
