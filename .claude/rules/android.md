---
paths:
  - "android/**"
---
# Android guardrails

- Android is a thin Compose UI over shared mobile layers. Do not reimplement transport, reconnect, session/audio state, repositories, or usecases in the app.
- Data flows through usecases into one route-scoped ViewModel state holder. A route-argument change creates a fresh ViewModel; do not reset screen state in place or drop the connection during navigation.
- Composables do not perform I/O or mutate state. Leaf composables receive state and callbacks; collect flows lifecycle-aware.
- Do not use a lifecycle-paused `SharedFlow` for guaranteed UI events; represent them in acknowledged state or use a buffered channel.
- Use structured coroutine scopes; never `GlobalScope`, and never swallow `CancellationException`.
- Build configuration is Kotlin DSL and version-catalog sourced. Do not add annotation processors or split the single app module preemptively.
- Emulator E2E uses Maestro, not Playwright. Use fakes at app boundaries; do not sleep in tests.
