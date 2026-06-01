---
paths: ["shared/mobile-sdk/src/commonMain/**"]
---
# commonMain Purity

- commonMain MUST NOT import platform APIs (no `android.*`, no `platform.*`/Foundation, no JVM-only `java.*`).
- All platform capability (mic, playback, push token, secure storage, WS engine, log sink, clock) enters via an `expect` declaration or an injected interface defined in commonMain.
- No `System.currentTimeMillis()` / `Date()` directly — inject a `Clock` so logic is testable and deterministic.
- Pure logic (codec, gates, FSMs, connectors, reconnect) lives here and is unit-tested in commonTest with NO platform.
- If a type needs a platform import, it belongs in androidMain/iosMain behind an `expect`/`actual` or interface — never leak it into commonMain.

> Details: agents/docs/mobile-sdk/commonMain-purity-details.md
