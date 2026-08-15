# Result envelope details

This file expands `.claude/rules/mobile-shared.md` for data-surface results.

```kotlin
sealed class SentientResult<out T : Any> {
    data class Loading<out T : Any>(val partial: T? = null) : SentientResult<T>()
    data class Success<out T : Any>(val data: T) : SentientResult<T>()
    data class Failure(val error: SentientError) : SentientResult<Nothing>()
}
```

Consumers fold all three cases explicitly. `Loading.partial` preserves the last useful value during refresh or reconnect. `Failure` carries typed retry intent and a user-safe message; diagnostic causes remain for sanitized logging.

Repositories are stateless adapters and usecases own combination/mapping. One current exception to avoid inventing a mapping layer: the connection repository directly exposes `sdk.connection` as its `StateFlow<ConnectionState>`. Do not document it as a `SentientResult` conversion unless the implementation changes.
