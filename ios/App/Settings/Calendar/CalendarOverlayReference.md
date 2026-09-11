# Calendar overlay reference adaptation

The iOS overlays are compared against the consolidated `design/prototype/calendar/index.html` composition at 390×844 and 430×932, using `calendar.css` and `calendar.js` from the same directory. They retain the reference's Dusk paper sheet, Terra decisive action, 26pt top corners, 42×4 handle, 84% maximum height, internal scrolling, 48pt actions, tonal scrim, and token motion. Native SwiftUI date/time, picker, focus, keyboard, Dynamic Type, safe-area, and accessibility behavior replaces prototype HTML controls.

## Calendar V2 additions

The reference prototype shows title, calendar, date/time, and sample-only place/reminder values. Product overlays deliberately omit unsupported place, reminder, color, and member-owner fields. They add every supported V2 field from `CalendarMutationDraft`:

- description
- all-day or timed start and optional end, retaining the source time zone/offset
- private or household scope
- everyone or adults visibility
- normal, important, or pinned importance
- optional group and tags
- structured recurrence: frequency, interval, weekly days, count, and until date
- explicit occurrence, following, or entire-series mutation scope

Shared `CalendarExperience` state remains authoritative for availability, recurrence applicability, conflict reread/review, typed failure, submission, and outcomes. The SwiftUI views only render those values and forward controlled closures.
