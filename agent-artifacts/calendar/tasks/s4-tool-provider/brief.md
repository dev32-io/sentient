# Task Brief: Calendar product tool group with pre-PDP household-write rejection

## Contribution Goal

Deliver the calendar product tool group (calendar_list, calendar_get, calendar_search, calendar_create, calendar_update, calendar_delete) as NativeToolRunners backed by CalendarStore, with a pre-PDP validate() rejection for non-adult household writes, registered as a FoundationProductGroup 'calendar' with metadata, tier defaults (read=allow, write=ask, delete=confirm), broker role reachability, and tool descriptions that scope the calendar to durable dated/timed events and steer the model away from scheduler-owned reminders.

## Boundary — Included

- New gateway/src/bootstrap/product-tools/calendar-provider.ts building the six NativeToolRunners over CalendarStore
- Add 'calendar' to FoundationProductGroup and the provider registry (EMPTY_PRODUCT_TOOL_PROVIDERS)
- Metadata entries in product-tool-metadata.ts with productGroup calendar and defaultExposure standard
- Tool tiers: read for list/get/search, write for create/update, confirm for delete
- Pre-PDP validate() closing over cap.role + resource class rejecting non-adult household writes before the ask/confirm flow
- Tool descriptions that scope the calendar to durable dated/timed events and explicitly say relative reminders / recurring briefings / interval reminders belong to a future scheduler, not the calendar
- Argument validation, abort propagation, and typed tool failures (malformed RRULE, not-found, household write-gate) matching the golden wire fixtures
- Broker-level regression asserting typed failure, zero confirmation calls, and zero store calls for child household create/update
- Role reachability and tier-default contract tests for all four roles

## Required Work

- 1. Create gateway/src/bootstrap/product-tools/calendar-provider.ts building calendar_list, calendar_get, calendar_search (read), calendar_create, calendar_update (write), calendar_delete (confirm) as NativeToolRunners over a CalendarStore injected through config.
- 2. Add 'calendar' to FoundationProductGroup in product-tool-providers.ts and register calendarProductToolProvider in EMPTY_PRODUCT_TOOL_PROVIDERS.
- 3. Add calendar metadata to product-tool-metadata.ts with productGroup 'calendar' and defaultExposure 'standard'.
- 4. Author tool descriptions that scope the calendar to durable dated/timed events and explicitly steer the model away from filing relative reminders ('remind me tomorrow morning'), recurring briefings ('9am every Monday'), or interval reminders ('every 4h') as calendar events — those belong to a future scheduler. The calendar is literally a calendar.
- 5. Implement a provider validate() that closes over the capability (role + resource class) and rejects non-adult (child/guest) household writes with a typed failure BEFORE the broker ask/confirm flow; keep the store gate as defense-in-depth.
- 6. Implement argument validation, abort propagation, and typed tool failures matching the golden wire fixtures; return tz-aware values (UTC instant + event tz id, or all-day date).
- 7. Add tests for tool definitions/tiers, argument validation, abort propagation, broker role denial for guests, pre-PDP no-confirm child rejection (assert zero confirmation calls and zero store calls), admin/adult household writes allowed, ask/confirm fail-closed deny, and description text that fences out scheduler-owned reminders.
- 8. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s4-tool-provider.

## Context

- FoundationProductGroup is defined in gateway/src/bootstrap/product-tool-providers.ts (currently 'web'|'home'|'music'); calendar should be a first-class foundation group.
- ProductToolProvider<G> and the home provider (gateway/src/bootstrap/product-tools/home-provider.ts) are the provider template; NativeToolRunner has an optional validate() that runs in the broker path.
- Metadata lives in gateway/src/bootstrap/product-tool-metadata.ts (name, description, tier, productGroup, defaultExposure).
- Tier defaults: defaultPermissionForTier (read=allow, write=ask, confirm=ask); role reachability via canExecute; the broker (gateway/src/tools/tool-broker.ts) resolves ask/confirm BEFORE executing run, so a store-layer gate alone cannot prevent permission.request.
- The provider validate() closes over the capability (role + resource class) and must reject non-adult household writes BEFORE the ask/confirm flow; the store gate remains as defense-in-depth.
- isAdult(role)=adult|admin (no bypass); CalendarStore query methods take cap.role for visibility filtering.
- The calendar is durable dated/timed storage (a real calendar), NOT the home for relative reminders, recurring briefings, or interval reminders — those are a future scheduler-owned record type. The tool descriptions must say so to keep the model from misfiling scheduler items as calendar events.
- Timezone model: events carry an event tz id (default household tz) over UTC instants; all-day events are dates. Tools return tz-aware values and never need the user current tz. Rendering uses the existing household-tz explicit-offset seam; the future scheduler (not the calendar) owns user-current-tz.
- Tool activity surfaces as tasklist.state frames, not conversation pills [memory 5dce0274].

## Boundary — Excluded

- phase-services minting/wiring and nudge (separate task)
- REST API
- Web/mobile UI
- The future scheduler / user-current-tz / free-reminder record type

## Interfaces and Dependencies

- Produces: calendarProductToolProvider and metadata consumed by phase-services and the catalog.
- Consumes: CalendarStore from s3-store-reads; tool-broker, role-defaults, product-tool-providers seams; isAdult, event-tz model, and wire schema from s1-domain-contracts.
