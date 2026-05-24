---
paths:
  - "ios/**/*.swift"
---
# iOS Architecture Rules

- Follow layered architecture: Views → ViewModel → UseCase → Repository → DataSource.
- Dependencies flow inward only — outer layers depend on inner, never reverse.
- `Domain/` has zero imports from `Data/` or `Views/`.
- Use constructor injection with protocol types.
- Use `any` keyword for existential protocol types in parameters.
- ViewModels are passed to Views via init parameters.

> When a rule is unclear, read `agents/docs/ios-architecture-details.md`.
