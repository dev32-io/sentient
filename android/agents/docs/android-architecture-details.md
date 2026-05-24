# Android Architecture — Details & Examples

Ported from dotJournal. Full examples will be expanded when Phase 6 begins.

## Layered Architecture

```
UI (Compose Screens, ViewModels)
  ↓ depends on
Domain (UseCases, Repository interfaces, models)
  ↓ depends on (nothing — this is the inner layer)

Data (Repository implementations, API clients, DAOs, Entities)
  ↓ depends on
Domain
```

Domain layer has ZERO imports from `data/` or `ui/`. All dependencies flow inward.
