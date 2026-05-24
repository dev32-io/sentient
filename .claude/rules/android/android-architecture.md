---
paths:
  - "android/**/*.kt"
---
# Android Architecture Rules

- Follow layered architecture: UI → ViewModel → UseCase → Repository → DataSource.
- Dependencies flow inward only — outer layers depend on inner, never reverse.
- Domain layer (`domain/`) has zero dependencies on `data/` or `ui/`.
- Use Koin for all dependency injection.
- Never manually instantiate ViewModels or Repositories in UI code.
- ViewModels are obtained via `koinViewModel()` in Composables.

> When a rule is unclear, read `agents/docs/android-architecture-details.md`.
