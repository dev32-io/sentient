# Task Acceptance: Calendar product tool group provider and metadata

## Deliverables

- Deliver the calendar product tool group (calendar_list, calendar_get, calendar_search, calendar_create, calendar_update, calendar_delete) as NativeToolRunners backed by CalendarStore, registered as a FoundationProductGroup 'calendar' with metadata, tier defaults (read=allow, write=ask, delete=confirm), and broker role reachability.

## Acceptance

- calendar_list/calendar_get/calendar_search are read (allow), calendar_create/calendar_update are write (ask), calendar_delete is confirm (ask) via defaultPermissionForTier
- Role reachability via canExecute denies guests at the broker for calendar_create
- Calendar tools appear in product-tool-metadata and FoundationProductGroup with productGroup calendar and defaultExposure standard

## Boundary Proof

- Tool tests cover definitions/tiers, argument validation, abort propagation, broker role denial for guests, and ask/confirm fail-closed behavior
