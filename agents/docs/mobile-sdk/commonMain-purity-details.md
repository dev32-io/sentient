# commonMain purity details

This file expands `.claude/rules/mobile-shared.md` for Kotlin Multiplatform boundaries.

`commonMain` must compile for Android/JVM and iOS/Native without platform imports or platform types in common signatures. Keep domain models, state machines, protocol serialization, and injected interfaces common.

Inject platform capabilities such as clocks, logging, storage, and WebSocket engines. Use `expect`/`actual` only for a minimal capability boundary; keep platform implementations in the relevant source set. `kotlin.time.Clock.System` and `kotlin.random.Random` are portable; JVM classes such as `System.currentTimeMillis()` and `java.util.Random` are not.

Common tests should exercise the pure state machine with fakes. Do not “fix” a platform issue by weakening this boundary or adding an Android/iOS import to `commonMain`.
