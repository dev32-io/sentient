# Task Brief: Mobile SDK CalendarHttpClient and models

## Contribution Goal

Deliver the KMP mobile SDK calendar REST client (CalendarHttpClient) and models mirroring the gateway domain and golden wire fixtures, deriving REST base and token per request like the profile client, receiving tz-aware values for device-tz rendering.

## Boundary — Included

- shared/mobile-sdk CalendarHttpClient (get/list/create/update/delete) deriving base URL and token per request
- Calendar models (CalendarEvent, Occurrence, RRULE subset, Visibility, Importance, Group, Tags, exceptions) mirroring the gateway domain and tz-aware value (UTC instant + event tz id, or all-day date)
- Unit tests for the client golden-fixture wire shape and model mapping

## Required Work

- 1. Create shared/mobile-sdk calendar models mirroring the gateway domain (event, occurrence, rrule subset, visibility, importance, group, tags, exceptions) and the tz-aware value (UTC instant + event tz id, or all-day date).
- 2. Create CalendarHttpClient in commonMain with get/list/create/update/delete deriving REST base and token per request like ProfileEditHttpClient; match the golden fixtures.
- 3. Add unit tests for the client golden-fixture wire shape and model (de)serialization.
- 4. Run the SDK unit tests and Kotlin compile from the repo root.

## Integration Expectation

Deliver this contribution for integration in stage s6-mobile-sdk.

## Context

- Mobile SDK REST precedent is shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/settings/ProfileEditHttpClient.kt and ProfileDocs.kt (derives REST base from gateway WS URL, reads token per request).
- Calendar should be a dedicated CalendarHttpClient (not added to ProfileEditHttpClient) because calendar CRUD is not a profile/restart mutation.
- Models live under mobile-sdk commonMain; repositories live in shared/mobile-data.
- Gradle is invoked from the repository root (no gradlew under shared/mobile-sdk).
- Timezone model: the SDK receives tz-aware values (UTC instant + event tz id, or all-day date) and renders in the device tz; it never needs a user current tz (future scheduler).
- The SDK must consume the shared golden fixtures from s1-domain-contracts to stay wire-compatible with REST, tools, and web.

## Boundary — Excluded

- Mobile-data repository (next task)
- Android/iOS screens
- User-current-tz / scheduler (future)

## Interfaces and Dependencies

- Produces: CalendarHttpClient and calendar models consumed by mobile-data repositories.
- Consumes: /api/v1/calendar REST surface from s4-rest-api; existing mobile-sdk auth/base-URL helpers; golden fixtures from s1-domain-contracts.
