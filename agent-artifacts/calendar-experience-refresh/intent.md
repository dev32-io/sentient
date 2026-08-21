# Intent: Cross-platform family calendar experience

## Problem

The existing web, Android, and iOS calendar screens expose only rough CRUD lists despite a capable calendar domain and REST V2 contract.

## Desired Outcome

Deliver a polished, functional family calendar across all three clients, closely following design-ref/calendar.png, existing platform design systems, Google Calendar-style navigation and filtering, complete online event management, and cache-first mobile browsing with automatic background revalidation.

## Scope — Included

- Web, Android, and iOS calendar redesign
- Month and agenda views with Today, previous/next navigation, mini-calendar, day selection, and overflow
- Combined authorized private and household calendar with scope, group, tag, importance, and text filters
- Locally persisted, account-scoped view and filter preferences
- Complete online create, inspect, edit, and delete UX including recurrence mutation scope
- Loading, empty, error, stale-revision, permission, confirmation, and recovery states
- Mobile persistent cache with automatic adjacent-month prefetch and shared observable KMP data flow
- Reusable components and shared design tokens rather than feature-local constants

## Success Signals

- All three clients deliver the approved month, agenda, filtering, editing, recurrence, conflict, permission, accessibility, and responsive behaviors
- Combined calendar reads explicitly request all authorized scopes and consume bounded continuation pages
- Filter and view preferences survive revisits without crossing account or backend boundaries
- Mobile emits cached calendar data immediately, automatically revalidates, prefetches adjacent months, and retains usable cached data through network failure
- Offline mobile browsing never implies or queues a successful mutation
- The approved touched-area E2E matrix is satisfied using synthetic local data

## Scope — Excluded

- Offline event creation, editing, deletion, and mutation synchronization
- Web offline event caching
- Household-member ownership or attendees
- User-defined event colors
- Reminder delivery, scheduler behavior, and notification implementation
- Group or tag catalog management beyond metadata attached to events
- Google Calendar synchronization

## Constraints

- design-ref/calendar.png is the canonical visual reference
- Existing design tokens, typography, icons, and reusable controls must be preferred; new visual constants belong in shared platform token surfaces
- Current calendar V2 identity, recurrence, scope, revision, authorization, and privacy contracts remain authoritative
- The native Android and iOS layers remain thin; reusable mobile business logic belongs in shared KMP mobile-data while mobile-sdk remains the REST and wire boundary
- Calendar content, filter values, descriptions, and mutation payloads must not enter diagnostics
- Production remains observational-only; calendar mutation and smoke evidence use the real local stack with disposable data
