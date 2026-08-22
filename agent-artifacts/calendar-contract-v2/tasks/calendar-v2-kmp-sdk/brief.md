# Task Brief: Cut the KMP calendar SDK over to REST V2

## Contribution Goal

Android and iOS shared SDK consumers can page calendar reads and issue typed recurring mutation commands with exact gateway wire parity and no content-bearing diagnostics.

## Boundary — Included

- Serializable V2 models and error/result mapping
- CalendarHttpClient V2 paging, create/get/mutate, and convenience adapters
- Golden-wire, timeout, privacy, and client contract tests

## Required Work

- 1. Replace V1 calendar wire models in shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/calendar/CalendarModels.kt with serializable V2 event, effective occurrence, page/nextCursor, structured recurrence, scope, mutation scope, changes, command, result, revision, and error models matching the generated fixture exactly.
- 2. Keep CalendarTime only as a source-level convenience for existing mobile callers if needed; external list/query serialization must emit raw V2 temporal strings. Provide explicit conversion that never uses the device default timezone implicitly.
- 3. Update CalendarHttpClient list/get/create to version-2 envelopes, raw temporal query values, all scope, filters, and cursor. Preserve bearer-token refresh and 15-second bounded timeout behavior.
- 4. Add mutate(eventId,command) posting only to /calendar/events/{eventId}/mutations and returning the typed mutation result or existing AuthResult failure envelope with stable calendar error detail available to repository mapping.
- 5. Preserve source-level update/delete methods used by current mobile-data/platform code by mapping them to entire_series mutation commands, carrying revision when available. Remove PATCH/DELETE calls and base-event ID normalization hacks.
- 6. Strip server-owned ids, occurrence metadata, revision, and timestamps from create input. Do not accept or generate legacy V1 envelope fields.
- 7. Update CalendarHttpClientTest to assert exact generated-fixture decoding, raw query parameters, cursor continuation, every mutation scope, entire-series convenience mapping, stale revision/domain errors, timeout, cancellation, and zero PATCH/DELETE requests.
- 8. Extend the mobile diagnostic privacy guard with canary calendar title, description, query, date, and mutation values. Drive the real CalendarHttpClient paths and assert none appear in captured diagnostics; only method/type/status/count/length/revision metadata may be logged.
- 9. Add a MockEngine/handler-backed integration seam proving the KMP request shape matches the gateway V2 handler for E2E-014 through E2E-016 without storing tokens or response payloads in evidence.
- 10. Compile common/Android targets and run only calendar/privacy-focused tests; do not edit Android/iOS screen or ViewModel source.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-kmp-sdk.

## Context

- CalendarModels.kt and CalendarHttpClient.kt currently model V1 baseEventId/occurrence normalization, more counters, JSON CalendarTime queries, and PATCH/DELETE.
- The mobile-sdk Gradle build generates CalendarGoldenFixture from gateway/src/calendar/fixtures/calendar-wire.json; use it as the cross-client source of truth.
- Platform UI files remain untouched. Source-level convenience methods may map current whole-series behavior to V2 entire_series commands.

## Boundary — Excluded

- Mobile-data repository/use-case changes
- Android/iOS UI or navigation changes
- Legacy REST or database compatibility

## Interfaces and Dependencies

- Consumes V2 JSON fixture/envelopes and the existing injected Ktor HttpClient, gateway URL, token supplier, safeSettingsCall, and AuthResult.
- Produces CalendarHttpClient list/get/create/mutate plus source-level whole-series update/delete convenience methods and serializable V2 models exported to mobile-data.
