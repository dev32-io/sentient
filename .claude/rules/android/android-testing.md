---
paths:
  - "android/**/*.kt"
---
# Android Testing Rules

- Tests live in `src/test/java/`.
- Name test files `{Class}Test.kt`.
- Use backtick-quoted test names: `` fun `returns zero for empty dates`() ``.
- Create `Fake{Interface}` implementations for dependencies — no mocking frameworks.
- Use `runTest { }` for coroutine tests.
- Test use cases and ViewModels, not Composables directly.
- Each use case must have a corresponding test file.

> When a rule is unclear, read `agents/docs/android-testing-details.md`.
