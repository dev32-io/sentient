# Task Brief: Mint calendar capabilities, wire the tool group, and own calendar config

## Contribution Goal

Mint calendar-private and calendar-household capabilities and open their CalendarStores in phase-services, wire the calendar product tool group into the session, close stores on session disposal, and add the orchestratorCfg.calendar config (schema, defaults, old-config compatibility; default event tz id resolves to the household tz via resolveTimeZone()), preserving prompt-cache stability.

## Boundary — Included

- grant calendar-private and calendar-household capabilities and open CalendarStores per session alongside memory, closing them on session disposal
- Wire the calendar product tool provider into the product-tool-provider composition feeding the broker
- Add orchestratorCfg.calendar (enabled, recurrence limits, nudge budget, default event tz id) to the config schema and gateway/config.yaml defaults; default event tz id resolves to the household tz via resolveTimeZone(); add an old-config compatibility test
- Preserve session system-prompt composition once-per-session and cache stability (calendar writes do not mutate the prompt within the session)

## Required Work

- 1. Add an orchestratorCfg.calendar config section (enabled, recurrence limits, nudge budget, default event tz id) to the config schema file and gateway/config.yaml defaults following the memory config pattern; the default event tz id resolves to the household tz via resolveTimeZone().
- 2. Add an old-config compatibility test proving a config with no calendar block still boots with sane defaults.
- 3. In phase-services.ts, grant calendar-private and calendar-household capabilities and open their CalendarStores alongside memory when enabled; close stores on session disposal.
- 4. Wire calendarProductToolProvider into the product-tool-provider composition feeding the broker.
- 5. Add tests for capability minting, store open, tool wiring, store close on disposal, the disabled graceful path, config schema/defaults, old-config compatibility, default event tz id resolving to household tz, and that the session prompt is still composed once.
- 6. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s5-phase-bootstrap.

## Context

- Session memory is built in gateway/src/bootstrap/phase-services.ts buildSessionMemory: grant memory-private, open store, grant memory-household, open store, build tools, return augmentPrompt() and spark.
- Session system prompt is composed once via composeSessionSystemPrompt then sessionMemory.augmentPrompt; prompt-cache stability must be preserved. resolveTimeZone() (gateway/src/bootstrap/phase-services.ts) already provides the household tz via TimeZoneProvider (host zone today).
- Calendar must mint calendar-private and calendar-household capabilities and open stores alongside memory, wire calendar tools, and close stores on session disposal.
- Operator-tunable behavior belongs in YAML/config (guardrails): own the config schema file (shared/config .../orchestrator-config.ts), gateway/config.yaml defaults, and old-config compatibility.
- Timezone model: there is no single 'serving tz' config. The household tz comes from the existing resolveTimeZone()/TimeZoneProvider. CalendarConfig carries a default event tz id (resolving to the household tz) and recurrence/nudge limits. Per-event tz override is allowed. The calendar never needs a user current tz (future scheduler).
- The calendar config should be feature-flagged like memory (orchestratorCfg.calendar.enabled) with bounded defaults.

## Boundary — Excluded

- Nudge composition (next task)
- REST, web, mobile
- User-current-tz / scheduler (future)

## Interfaces and Dependencies

- Produces: calendar capability minting, tool wiring, store lifecycle, and calendar config.
- Consumes: calendarProductToolProvider from s4-tool-provider; CalendarStore (with close()) from s1-store-schema-factory; AccessManager from s1-resource-classes; resolveTimeZone()/TimeZoneProvider from phase-services/message-time.
