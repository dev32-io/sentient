# Task Acceptance: Mobile-data calendar repository, use cases, and DI

## Deliverables

- Deliver the KMP mobile-data calendar repository, SDK passthrough, use cases, and DI wiring exposing calendar access to platform screens.

## Acceptance

- CalendarRepository and SdkCalendarRepository expose stateless get/list/create/update/delete use cases
- Calendar use cases and DI wiring are exposed to platform screens via the SettingsComponent seam
- Repositories remain stateless; state folding stays in use cases/ViewModels

## Boundary Proof

- mobile-data unit tests cover repository mapping and use-case folding
