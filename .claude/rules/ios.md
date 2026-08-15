---
paths:
  - "ios/**"
---
# iOS guardrails

- iOS is a thin SwiftUI UI over the shared mobile layers. Do not reimplement transport, reconnect, session/audio state, repositories, or usecases in the app.
- `UserSession` owns one KMP `IosUserSession` and its `ChatComponent` for the authenticated lifetime. `UserSessionHost` keeps that connection scope above the authenticated `NavigationStack`.
- Authenticated navigation is `Route` + `NavigationStack`. Route identity changes create the appropriate fresh screen ViewModel; leaf views receive values and closures, not ViewModels.
- SwiftUI bodies are side-effect free. Use lifecycle-scoped `.task` or explicitly owned, cancellable work. Mixed `ObservableObject`/`@Published` and `@Observable` usage is intentional; follow the surrounding feature.
- Prefer Swift concurrency and `AsyncSequence`; use SKIE's `for await` path for shared Kotlin streams. Combine is allowed at an existing or framework-owned publisher boundary, not as a new shared-stream bridge.
- `ios/project.yml` and XcodeGen are authoritative. Do not hand-edit or commit generated project/scheme state. The variant-neutral `../shared/mobile-data/build/XCFrameworks/MobileData.xcframework` path is the checked configuration.
- Simulator E2E uses Maestro or XCUITest with accessibility identifiers. Avoid arbitrary sleeps; use observable completion or controllable async seams. Gateway-stop E2E is supported; broadcasts used by some fault flows remain Android-only.

When a rule is unclear, read `agents/docs/ios/ios-architecture-mvvm-details.md`.
When testing guidance is unclear, read `agents/docs/ios/ios-testing-details.md`.
When build guidance is unclear, read `agents/docs/ios/ios-xcodebuild-details.md`.
When concurrency guidance is unclear, read `agents/docs/ios/swift-concurrency-details.md`.
