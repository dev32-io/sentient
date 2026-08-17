# Task Brief: Mobile-data calendar repository, use cases, and DI

## Contribution Goal

Deliver the KMP mobile-data calendar repository, SDK passthrough, use cases, and DI wiring exposing calendar access to platform screens.

## Boundary — Included

- CalendarRepository interface and SdkCalendarRepository passthrough over CalendarHttpClient
- Calendar use cases (get/list/create/update/delete) with state in use cases, not repositories
- SettingsComponent DI wiring for the calendar HTTP client, repository, and use cases
- Unit tests for repository mapping and use-case folding

## Required Work

- 1. Create CalendarRepository interface and SdkCalendarRepository passthrough over CalendarHttpClient in shared/mobile-data commonMain.
- 2. Add calendar use cases (get/list/create/update/delete) keeping state in use cases, not repositories.
- 3. Wire the calendar HTTP client, repository, and use cases into SettingsComponent.kt.
- 4. Add unit tests for repository mapping (SentientResult) and use-case folding.
- 5. Run mobile-data unit tests and Kotlin compile.

## Integration Expectation

Deliver this contribution for integration in stage s7-mobile-data.

## Context

- Mobile-data precedent is shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/data/settings/ProfileRepository.kt and SdkProfileRepository.kt (stateless SDK passthrough).
- DI is shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/di/SettingsComponent.kt constructing HTTP clients, repositories, and use cases.
- Repositories must remain stateless; state folding belongs in use cases/ViewModels.
- Calendar CRUD is not a profile/restart mutation; do not inherit long-timeout restart assumptions.

## Boundary — Excluded

- Android/iOS screens
- SDK HTTP client (s6-mobile-sdk)

## Interfaces and Dependencies

- Produces: CalendarRepository and use cases consumed by Android/iOS screens.
- Consumes: CalendarHttpClient from s6-mobile-sdk; existing SettingsComponent DI seam.
