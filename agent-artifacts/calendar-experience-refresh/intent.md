# Intent: Cross-platform family calendar experience

## Problem

The existing web, Android, and iOS calendar screens expose only rough CRUD lists despite a capable calendar domain and REST V2 contract.

## Desired Outcome

Deliver a polished, functional family calendar across all three clients by adapting the committed Sentient web and mobile calendar handoffs exactly for supported product behavior, following industrial responsive-calendar practice, preserving existing platform design systems, and providing cache-first mobile browsing with automatic background revalidation.

## Scope — Included

- Web, Android, and iOS calendar redesign
- Day, Week, Month, and Year views with Today, interval navigation, date selection, event preview, and overflow
- Desktop web filter sidebar and calendar canvas with Google-style sidebar collapse and shrink-to-fit narrow-web calendar views
- Native mobile horizontal filters, compact calendar summaries, agenda-first rows, floating view bar, and preview/editor bottom sheets
- Combined authorized private and household calendar with scope, group, tag, importance, and text filters
- Locally persisted, account-scoped view and filter preferences
- Complete online create, inspect, edit, and delete UX including recurrence mutation scope
- Loading, empty, error, stale-revision, permission, confirmation, and recovery states
- Mobile SQLDelight persistent cache with automatic adjacent-month prefetch and shared observable KMP data flow
- Reusable components and existing shared design tokens rather than feature-local constants or a broad design-system rewrite

## Success Signals

- All three clients deliver the approved Day, Week, Month, Year, filtering, preview, editing, recurrence, conflict, permission, accessibility, motion, responsive, and reduced-motion behaviors
- Web desktop and narrow viewport screenshots match the authoritative web handoff after the reviewed Google-style responsive correction; Android and iOS match the authoritative mobile handoff
- Narrow web preserves a usable seven-column Month and Week calendar without horizontal page overflow while keeping Add Event and filters reachable after sidebar collapse
- Combined calendar reads explicitly request all authorized scopes and consume bounded continuation pages
- Filter and view preferences survive revisits without crossing account or backend boundaries
- Mobile emits SQLDelight-cached calendar data immediately, automatically revalidates, prefetches adjacent months, and retains usable cached data through network failure
- Android and iOS do not duplicate cache, remote-call, filtering, or prefetch business logic
- Offline mobile browsing never implies or queues a successful mutation
- The approved touched-area E2E matrix is satisfied using synthetic local data and visual evidence against the committed design references

## Scope — Excluded

- Offline event creation, editing, deletion, and mutation synchronization
- Web offline event caching
- Household-member ownership or attendees
- User-defined event colors
- Reminder delivery, scheduler behavior, and notification implementation
- Group or tag catalog management beyond metadata attached to events
- Google Calendar synchronization
- Application-level SQLCipher encryption and cross-platform database-key management
- Wholesale adoption or rebuilding of the WIP sentient-design token and component runtimes

## Constraints

- The authoritative adaptation references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html with sentient-design/components/web/sentient-web.js, and sentient-design/design/mobile/calendar.html with sentient-design/components/mobile/sentient-mobile.js
- The committed sentient-design folder is WIP adaptation guidance: calendar hierarchy, geometry, controls, motion, transitions, effects, and interaction flows are authoritative where supported, but prototype data and unrelated component-system implementation are not production requirements
- When the WIP runtime conflicts with explicit reviewed direction, the reviewed direction wins: narrow web uses Google-style sidebar collapse and keeps Day/Week/Month/Year calendar views shrinking/reflowing to fit without generic mobile drawer/agenda substitution or page-level horizontal overflow
- Existing repository Dusk tokens, typography, icons, reusable controls, and native design projections remain implementation authority; new visual constants belong in shared platform token surfaces
- Current calendar V2 identity, recurrence, scope, revision, authorization, and privacy contracts remain data and mutation authority
- Mobile calendar cache and preference persistence use a SQLDelight-backed KMP SQLite database owned by shared/mobile-data and exported through the shared KMP surface
- Shared KMP owns cache schema, migrations, observable queries, stale-while-revalidate policy, filtering, pagination, prefetch, freshness, LRU retention, and account/backend isolation
- Android and iOS remain thin consumers; platform responsibilities are limited to SQLDelight driver and protected app-private path creation, authenticated-session lifecycle wiring, native UI, and platform date/time controls
- mobile-sdk remains the REST and wire boundary while shared/mobile-data remains the reusable business/data layer
- Mobile SQLite relies on OS-protected app-private storage; application-level SQLCipher is not required
- Calendar content, filter values, descriptions, and mutation payloads must not enter diagnostics
- Production remains observational-only; calendar mutation and smoke evidence use the real local stack with disposable data
