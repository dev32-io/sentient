---
paths:
  - "android/**/*.kt"
---
# Android Compose Rules

- One Composable per source file. File name matches the Composable name.
- Every `@Composable` function must have a `@Preview` in the same file.
- Hoist state — Composables receive state and callbacks as parameters.
- Reusable components must not reference ViewModels directly.
- Screen-level Composables may take a ViewModel via `koinViewModel()`.
- Use `MaterialTheme.colorScheme` and `MaterialTheme.typography` for all styling.
- No hardcoded colors or font sizes. Use theme and string resources.

> When a rule is unclear, read `agents/docs/android-compose-details.md`.
