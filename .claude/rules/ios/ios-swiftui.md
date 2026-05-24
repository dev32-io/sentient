---
paths:
  - "ios/**/*.swift"
---
# iOS SwiftUI Rules

- One View per source file. File name matches the struct name.
- Every View must have a `#Preview` macro in the same file.
- Screen-level Views receive dependencies via init parameters.
- Reusable components take only data and callbacks — no ViewModel references.
- Use `@Observable` macro on ViewModels. Never use `ObservableObject`/`@Published`.
- Use `@State` for local view state only.
- No hardcoded colors or font sizes. Use design tokens.

> When a rule is unclear, read `agents/docs/ios-swiftui-details.md`.
