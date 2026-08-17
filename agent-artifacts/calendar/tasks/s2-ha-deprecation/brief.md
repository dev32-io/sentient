# Task Brief: Deprecate and hide the four HA calendar tools

## Contribution Goal

Remove the four home_*_calendar_event tools from the model-facing surface entirely so they are absent from provider output, the MCP catalog, and role-default generation, while leaving adapter methods available for a future sync bridge and making orphaned profile permission entries harmless.

## Boundary — Included

- Remove the four calendar tool definitions from buildHomeTools in home-tools.ts
- Retain the home-adapter calendarEvents/mutateCalendar methods for a future sync bridge
- Update or retire the web-tools-migrator mappings for the removed tool names and add an optional migrator to drop orphaned profile.tools.permissions entries
- Update mcp-catalog projection and role-default generation consumers so the four tools do not appear
- Update affected home-tools/tool-tier/home-config-state-machine tests to assert absence instead of presence

## Required Work

- 1. Remove the four calendar tool builders from buildHomeTools in gateway/src/tools/home/home-tools.ts; keep adapter methods.
- 2. Update gateway/src/admin/web-tools-migrator.ts to retire the stale mappings and add an optional migrator that drops orphaned profile.tools.permissions entries for the removed names.
- 3. Verify gateway/src/api/handlers/mcp-catalog.ts and gateway/src/tools/role-defaults.ts no longer project the four tools; add/adjust tests asserting absence.
- 4. Update gateway/src/tools/home/home-tools.test.ts, tool-tier.test.ts, and home-config-state-machine.test.ts to assert the four tools are absent.
- 5. Run the affected tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s2-ha-deprecation.

## Context

- The four HA calendar tools are generated in gateway/src/tools/home/home-tools.ts and described by gateway/src/tools/home/home-adapter.ts (calendarEvents, mutateCalendar).
- gateway/src/admin/web-tools-migrator.ts maps retired HA/web tool names to these four home tools.
- gateway/src/api/handlers/mcp-catalog.ts projects native foundation tools; gateway/src/tools/role-defaults.ts generates role defaults from foundationProductToolMetadata().
- Existing tests in home-tools.test.ts, tool-tier.test.ts, and home-config-state-machine.test.ts assert the current home tool list.
- The adapter methods may be retained for a future sync bridge; only the tool surface is removed.

## Boundary — Excluded

- CalendarStore and calendar tool group (separate tasks)
- Future HA sync bridge implementation

## Interfaces and Dependencies

- Produces: home provider output and catalog/role-defaults with no home_*_calendar_event tools.
- Consumes: existing home provider, catalog, and role-defaults seams.
