---
paths:
  - "ios/**/*.swift"
---
# iOS Testing Rules

- Name test files `{Class}Tests.swift` (plural).
- Use XCTest framework.
- Name methods `test{Behavior}` in camelCase.
- Create `Fake{Protocol}` implementations for dependencies — no mocking frameworks.
- Use `async` test methods for testing async code.
- Prefer `async` over `XCTestExpectation` when possible.
- Each use case must have a corresponding test file.

> When a rule is unclear, read `agents/docs/ios-testing-details.md`.
