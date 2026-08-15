---
paths:
  - "android/**"
---
# Android guardrails

- Android is a thin Compose UI over shared mobile layers. Do not reimplement transport, reconnect, session/audio state, repositories, or usecases in the app.
- `UserSessionManager` owns the authenticated connection lifecycle and the shared `ChatComponent`. A chat route owns only conversation UI state.
- `ChatViewModel` takes `ChatComponent` and nullable `sessionId`; it switches conversation but does not close the connection. Navigation may recreate it without disconnecting the user session.
- Use the shipped Navigation Compose `NavHost` and route destinations. Do not replace it with a state gate or add a second navigation mechanism.
- Composables do not perform I/O or mutate state. Leaf composables receive state and callbacks; collect flows lifecycle-aware.
- Do not use a lifecycle-paused `SharedFlow` for guaranteed UI events; represent them in acknowledged state or use a buffered channel.
- Use structured coroutine scopes; never `GlobalScope`, and never swallow `CancellationException`.
- Production DI is Koin. Keep the shared KMP layer framework-free and do not add Hilt/KSP or annotation processors.
- Build configuration is Kotlin DSL and version-catalog sourced; keep the single `:android` app module.
- Emulator E2E uses Maestro, not Playwright. Use fakes at app boundaries; do not sleep in tests.

When a rule is unclear, read `agents/docs/android/android-architecture-mvi-details.md`.
When a rule is unclear, read `agents/docs/android/android-compose-details.md`.
When a rule is unclear, read `agents/docs/android/android-gradle-details.md`.
When a rule is unclear, read `agents/docs/android/android-testing-details.md`.
