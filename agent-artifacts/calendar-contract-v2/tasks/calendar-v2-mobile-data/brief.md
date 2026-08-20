# Task Brief: Expose calendar V2 paging and mutations through mobile-data

## Contribution Goal

Shared mobile repositories and use cases expose typed V2 reads and recurring mutations while remaining stateless at the repository layer and requiring no Android/iOS screen changes.

## Boundary — Included

- V2 repository and mutation use-case contracts
- Cursor-capable read state and whole-series convenience adapters
- SettingsComponent exports, result/error mapping, and focused mobile-data tests

## Required Work

- 1. Update CalendarRepository and SdkCalendarRepository to expose V2 list/query pages with raw temporal strings and optional cursor, plus create, get, and mutate(command) over CalendarHttpClient. Keep the repository a stateless SDK passthrough.
- 2. Add a typed MutateCalendarUseCase and expose it from CalendarUseCases and SettingsComponent alongside existing operations. Return SentientResult success/failure without embedding diagnostic causes in UI messages.
- 3. Preserve source-level update/delete convenience interfaces used by current VMs by translating them to entire_series commands through repository.mutate. Carry event revision when available and map mutation results back only as required by the current caller contract.
- 4. Replace listBoth's two independent timed/all-day HTTP calls with one V2 bounded query because the gateway now merges both kinds. Keep the existing method signature as a source adapter for untouched screens, selecting the approved raw range without using device-default timezone implicitly.
- 5. Make list/get StateFlow transitions remain exhaustive Loading/Success/Failure. Expose nextCursor in the V2 page for future screens without adding paging state to platform ViewModels now.
- 6. Map stable calendar HTTP/domain errors to SentientResult failures at the repository boundary. Preserve conflict/recurrence_conflict/forbidden/not-found distinctions where the existing result model permits, but keep raw server bodies and calendar content out of diagnostics and UI messages.
- 7. Update CalendarDataTest fakes and cases for one-call mixed-kind listing, cursor propagation, mutate success/failure, entire-series convenience mapping, stale conflict, SettingsComponent exports, and stateless repository behavior.
- 8. Compile shared mobile-data plus the current Android target to prove untouched calendar screens/ViewModels still bind. Do not edit platform UI source.
- 9. Add sanitized integration assertions for the mobile-data portion of E2E-015/E2E-016 using the real KMP client fake/handler seam; evidence contains operation/result types and revisions only.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-mobile-data.

## Context

- CalendarRepository and CalendarUseCases currently expose V1 get/list/create/update/delete and listBoth performs separate timed/all-day requests.
- V2 gateway queries merge timed and all-day events behind one bounded query and return nextCursor.
- Existing platform VMs consume SettingsComponent calendar interfaces; source-level convenience methods must keep them compiling until the later UI refresh.

## Boundary — Excluded

- Android/iOS screen, ViewModel, navigation, or visual changes
- Implementing client-side paged UI state
- Gateway and KMP HTTP implementation
- Legacy wire compatibility

## Interfaces and Dependencies

- Consumes KMP V2 CalendarHttpClient/models and existing SentientResult/SettingsComponent patterns.
- Produces stateless CalendarRepository, StateFlow-backed CalendarUseCases, typed mutation use case, cursor-aware page results, and source adapters for current platform callers.
