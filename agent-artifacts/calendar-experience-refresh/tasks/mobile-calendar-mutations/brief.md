# Task Brief: Implement shared online calendar mutation intents and recovery

## Contribution Goal

CalendarExperience owns complete online create, edit, and delete intent handling with exact V2 recurrence/revision semantics, offline write gates, typed conflicts, draft-preserving failures, and affected-window revalidation.

## Boundary — Included

- Shared draft and mutation intent/result state
- Create/update/delete command construction
- Recurring mutation-scope and successor identity handling
- Typed validation/conflict/permission/not-found recovery
- Offline save/delete gates and affected-window invalidation/revalidation
- Deterministic mutation tests

## Required Work

- 1. Add shared intents/state for opening preview/editor, creating a draft, editing an effective occurrence, choosing applicable mutation scope, confirming delete, submitting, cancelling, rereading a conflict, and acknowledging outcomes.
- 2. Build complete Calendar V2 create/update/delete commands with title, description, all-day/timed start/end, private/household scope, visibility, importance, group, tags, recurrence, eventId, raw offset-bearing originalStart, expectedRevision, and `this_occurrence`/`this_and_following`/`entire_series` applyTo. Do not synthesize an IANA timezone absent from the wire.
- 3. Preserve all-day date identity and raw timed recurrence wall-clock/offset anchor. Track successor event IDs returned by following mutations and refresh all affected windows/segments.
- 4. Consume the explicit cached-offline and unavailable-offline states produced by mobile-calendar-retention-offline. Reject save/delete while offline with connection-required state, no optimistic success, no database queue record, and no hidden retry. In-memory drafts live only for the current editor lifecycle.
- 5. Preserve drafts and visible cached data on typed validation, conflict, forbidden, not-found, connection, and server failures. Stale revisions never blind-retry; expose authoritative reread/review state and remain non-disclosing for forbidden targets.
- 6. Require explicit delete confirmation and an applicable recurrence scope before recurring writes; never infer entire-series mutation from an occurrence row.
- 7. After success, invalidate/revalidate affected complete windows through CalendarExperience without blanking current content; persist no content-bearing diagnostics.
- 8. Add tests for all field mappings, all-day/timed raw values, each recurrence scope, originalStart/revision, successor IDs, confirmation, offline gates/no queue, conflicts/reread, role failures, draft retention, and revalidation.

## Integration Expectation

Deliver this contribution for integration in stage mobile-calendar-mutations.

## Context

- Mutations remain online-only and run through the stateless CalendarRepository/CalendarHttpClient. No SQLDelight mutation queue may be introduced.
- The preceding retention/offline contribution defines cached-offline and unavailable-offline state; this task must consume that state rather than recreate connectivity policy.
- Exact mobile interaction references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Shared state must support their Add/Edit/preview sheets and confirmation flows while exposing Calendar V2 fields instead of prototype member/place/reminder semantics.
- Android and iOS send intents and render shared state; they do not reconstruct mutation payloads or conflict policy.

## Boundary — Excluded

- Native sheet visuals and focus handling
- Offline mutation synchronization or conflict replay
- Backend Calendar V2 changes
- Unsupported location/reminder/member/color fields
- Web mutation UI

## Interfaces and Dependencies

- Consumes CalendarRepository mutation methods, CalendarExperience read/revalidation path, and the freshness/offline state finalized by mobile-calendar-retention-offline.
- Produces shared preview/editor/draft/mutation state and intents for thin Android/iOS ViewModels.
