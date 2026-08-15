---
paths:
  - "ios/**"
---
# iOS guardrails

- iOS is a thin SwiftUI UI over shared mobile layers. Do not reimplement transport, reconnect, session/audio state, repositories, or usecases in the app.
- Views read one route-scoped `@MainActor` ViewModel state and dispatch actions. Business combination belongs in usecases; route-argument changes create a fresh ViewModel.
- SwiftUI bodies are side-effect free; use lifecycle-scoped `.task` work. Leaf views receive values and closures, not ViewModels.
- Prefer Swift concurrency/`AsyncSequence`; use Combine only at an existing or framework-owned publisher boundary. Never retain subscriptions globally or create strong self-cycles.
- Keep Swift 6 strict concurrency. Avoid detached/unstructured tasks without an explicit lifecycle and cancellation owner.
- `ios/project.yml` is the XcodeGen source of truth. Never hand-edit or commit generated project/scheme state; rebuild the KMP XCFramework when shared code changes.
- Simulator E2E uses Maestro or XCUITest, not Playwright. Identify controls by accessibility identifier and inject clocks instead of sleeping.
