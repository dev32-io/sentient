# Task Brief: Calendar product tool group provider and metadata

## Contribution Goal

Deliver the calendar product tool group (calendar_list, calendar_get, calendar_search, calendar_create, calendar_update, calendar_delete) as NativeToolRunners backed by CalendarStore, registered as a FoundationProductGroup 'calendar' with metadata, tier defaults (read=allow, write=ask, delete=confirm), and broker role reachability.

## Boundary — Included

- New gateway/src/bootstrap/product-tools/calendar-provider.ts building the six NativeToolRunners over CalendarStore
- Add 'calendar' to FoundationProductGroup and the provider registry (EMPTY_PRODUCT_TOOL_PROVIDERS)
- Metadata entries in product-tool-metadata.ts with productGroup calendar and defaultExposure standard
- Tool tiers: read for list/get/search, write for create/update, confirm for delete
- Argument validation, abort propagation, and typed tool failures (e.g. malformed RRULE)
- Role reachability and tier-default contract tests

## Required Work

- 1. Create gateway/src/bootstrap/product-tools/calendar-provider.ts building calendar_list, calendar_get, calendar_search (read), calendar_create, calendar_update (write), calendar_delete (confirm) as NativeToolRunners over a CalendarStore injected through config.
- 2. Add 'calendar' to FoundationProductGroup in product-tool-providers.ts and register calendarProductToolProvider in EMPTY_PRODUCT_TOOL_PROVIDERS.
- 3. Add calendar metadata to product-tool-metadata.ts with productGroup 'calendar' and defaultExposure 'standard'.
- 4. Implement argument validation, abort propagation, and typed tool failures (malformed RRULE, not-found, household write-gate surfacing).
- 5. Add tests for tool definitions/tiers, argument validation, abort propagation, broker role denial for guests, and ask/confirm fail-closed deny.
- 6. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s4-tool-provider.

## Context

- FoundationProductGroup is defined in gateway/src/bootstrap/product-tool-providers.ts (currently 'web'|'home'|'music'); memory is NOT a foundation group (special native path), but calendar should be a first-class foundation group.
- ProductToolProvider<G> and the home provider (gateway/src/bootstrap/product-tools/home-provider.ts) are the provider template.
- Metadata lives in gateway/src/bootstrap/product-tool-metadata.ts (name, description, tier, productGroup, defaultExposure).
- Tier defaults: defaultPermissionForTier (read=allow, write=ask, confirm=ask); role reachability via canExecute; the broker is the choke point (gateway/src/tools/tool-broker.ts).
- Ask triggers permission.request with fail-closed deny on timeout/cancel; tool activity surfaces as tasklist.state frames, not conversation pills.
- CalendarStore query methods take cap.role for visibility filtering.

## Boundary — Excluded

- phase-services minting/wiring and nudge (separate task)
- REST API
- Web/mobile UI

## Interfaces and Dependencies

- Produces: calendarProductToolProvider and metadata consumed by phase-services and the catalog.
- Consumes: CalendarStore from s3 tasks; tool-broker, role-defaults, product-tool-providers seams.
