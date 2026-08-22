# Task Acceptance: Mobile-data calendar repository, use cases, and DI

## Deliverables

- Deliver the KMP mobile-data calendar repository, SDK passthrough, explicit use-case interfaces for platform ViewModels, and DI wiring exposing calendar access to platform screens.

## Acceptance

- CalendarRepository and SdkCalendarRepository expose stateless get/list/create/update/delete passthrough
- Explicit calendar use-case interfaces are exported for platform ViewModels (which must consume use cases, not raw repositories)
- Calendar DI wiring is exposed to platform screens via the SettingsComponent seam
- Repositories remain stateless; state folding stays in use cases/ViewModels

## Boundary Proof

- mobile-data unit tests cover repository mapping (SentientResult) and use-case folding
