# Task Brief: Mint calendar capabilities, wire the tool group, and own calendar config

## Contribution Goal

Mint calendar-private and calendar-household capabilities and open their CalendarStores in phase-services, wire the calendar product tool group into the session, close stores on session disposal, and add the orchestratorCfg.calendar config (schema, defaults, and old-config compatibility), preserving prompt-cache stability.

## Boundary — Included

- grant calendar-private and calendar-household capabilities and open CalendarStores per session alongside memory, closing them on session disposal
- Wire the calendar product tool provider into the product-tool-provider composition feeding the broker
- Add orchestratorCfg.calendar (enabled, recurrence limits, nudge budget, serving timezone default America/Vancouver) to the config schema, gateway/config.yaml defaults, and an old-config compatibility test
- Preserve session system-prompt composition once-per-session and cache stability (calendar writes do not mutate the prompt within the session)

## Required Work

- 1. Add an orchestratorCfg.calendar config section (enabled, recurrence limits, nudge budget, serving timezone default America/Vancouver) to the config schema file and gateway/config.yaml defaults following the memory config pattern.
- 2. Add an old-config compatibility test proving a config with no calendar block still boots with sane defaults.
- 3. In phase-services.ts, grant calendar-private and calendar-household capabilities and open their CalendarStores alongside memory when enabled; close stores on session disposal.
- 4. Wire calendarProductToolProvider into the product-tool-provider composition feeding the broker.
- 5. Add tests for capability minting, store open, tool wiring, store close on disposal, the disabled graceful path, config schema/defaults, old-config compatibility, and that the session prompt is still composed once.
- 6. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s5-phase-bootstrap.

## Context

- Session memory is built in gateway/src/bootstrap/phase-services.ts buildSessionMemory: grant memory-private, open store, grant memory-household, open store, build tools, return augmentPrompt() and spark.
- Session system prompt is composed once via composeSessionSystemPrompt then sessionMemory.augmentPrompt; prompt-cache stability must be preserved.
- Calendar must mint calendar-private and calendar-household capabilities and open stores alongside memory, wire calendar tools, and close stores on session disposal.
- Operator-tunable behavior belongs in YAML/config (guardrails): own the config schema file (shared/config .../orchestrator-config.ts), gateway/config.yaml defaults, and old-config compatibility.
- The calendar config should be feature-flagged like memory (orchestratorCfg.calendar.enabled) with bounded defaults for recurrence and nudge.

## Boundary — Excluded

- Nudge composition (next task)
- REST, web, mobile

## Interfaces and Dependencies

- Produces: calendar capability minting, tool wiring, store lifecycle, and calendar config.
- Consumes: calendarProductToolProvider from s4-tool-provider; CalendarStore (with close()) from s1-store-schema-factory; AccessManager from s1-resource-classes.
