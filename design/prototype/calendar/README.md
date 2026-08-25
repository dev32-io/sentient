# Calendar prototype

ID: `calendar`

Open `index.html` through the Visual Companion or a local static server.

Implementation handoff: [`handoff.md`](./handoff.md).

## Boundary

- Covers the source-supported day, week, month, and year views; previous/next/Today navigation; local search; scope, group, tag, and importance filters; dense-cell overflow; event preview; add/edit; recurrence indication; recurring mutation scope; delete confirmation; and responsive desktop/mobile composition.
- Draws spatial inspiration from `sentient-design/sentient-responsive-prototype.html` and `sentient-design/sentient-responsive-mobile- prototype.html`, while `DESIGN.md` and current production calendar code remain authoritative.
- Uses only supported V2 event fields: scope, title, description, start/end, recurrence, visibility, importance, group, and tags. Prototype-only category, conflict-check, reminder, place, and assistant-action fields are deliberately excluded.
- Search matches title and description only, mirroring `gateway/webui/src/components/calendar/calendar-filters.ts`.
- Month density adapts the number of directly visible events to the available cell height and keeps the remainder reachable through `+N more`; the complete six-row month remains visible without an internal vertical drag. Compact phone month cells retain accessible event buttons while displaying importance dots.
- Calendar scope is a direct Private/Household checkbox list; selecting both includes all events without introducing a separate “All” option. Importance, Group, and Tag filters use the shared fixed-width-state label chip primitive; Groups and Tags use the reviewed common-composites disclosure shell so the filter panel stays compact. Active state remains with the filter controls instead of creating a separate strip beneath the date.
- The view switcher shrink-wraps its labels instead of reserving a broad fixed width.
- Selecting a month date opens Day; selecting a Year month opens Month. Preview exposes only production-supported details and capability actions.
- The event editor keeps its header and actions stable while the form body scrolls. The All day option is grouped with Start and End under Date and time, and the dialog title is the sole primary heading.
- The local fixture date is for visual review only. Production date identity, time-zone projection, pagination, authorization, optimistic conflict handling, and persistence remain owned by the existing controller and API contracts.
- `vendor/` is a self-contained snapshot of the reviewed foundation component styles.

This is a responsive visual review artifact, not production code. Production implementations remain native to Preact, SwiftUI, and Compose and follow `DESIGN.md`.
