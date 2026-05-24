# iOS Architecture — Details & Examples

Ported from dotJournal. Full examples will be expanded when Phase 6 begins.

## Layered Architecture

```
Views (SwiftUI Screens, ViewModels)
  ↓ depends on
Domain (UseCases, Repository protocols, models)
  ↓ depends on (nothing — this is the inner layer)

Data (Repository implementations, API clients, SwiftData models)
  ↓ depends on
Domain
```

Domain layer has ZERO imports from `Data/` or `Views/`. All dependencies flow inward.
