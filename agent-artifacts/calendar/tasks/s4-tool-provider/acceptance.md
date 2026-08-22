# Task Acceptance: Calendar product tool group with pre-PDP household-write rejection

## Deliverables

- Deliver the calendar product tool group (calendar_list, calendar_get, calendar_search, calendar_create, calendar_update, calendar_delete) as NativeToolRunners backed by CalendarStore, with a pre-PDP validate() rejection for non-adult household writes, registered as a FoundationProductGroup 'calendar' with metadata, tier defaults (read=allow, write=ask, delete=confirm), broker role reachability, and tool descriptions that scope the calendar to durable dated/timed events and steer the model away from scheduler-owned reminders.

## Acceptance

- AC-004: a non-adult (child/guest) household create/update/delete returns a typed failure BEFORE the ask/confirm flow, with no permission.request emitted, zero confirmation calls, and zero store calls (broker-level regression)
- calendar_list/calendar_get/calendar_search are read (allow), calendar_create/calendar_update are write (ask), calendar_delete is confirm (ask) via defaultPermissionForTier
- Role reachability via canExecute denies guests at the broker for calendar_create
- admin is adult-equivalent (isAdult) for visibility and household writes, with no bypass
- Calendar tool descriptions scope the calendar to durable dated/timed events and explicitly steer the model away from filing relative reminders ('remind me tomorrow morning'), recurring briefings ('9am every Monday'), or interval reminders ('every 4h') as calendar events — those belong to a future scheduler
- Tools return tz-aware values (UTC instant + event tz id, or all-day date); they never need the user current tz

## Boundary Proof

- Tool tests cover definitions/tiers, argument validation, abort propagation, broker role denial for guests, pre-PDP no-confirm child rejection (zero confirm calls, zero store calls), admin/adult household writes allowed, ask/confirm fail-closed deny, and description text that fences out scheduler-owned reminders
