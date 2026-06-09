# SentientResult Envelope — Details

The envelope decouples the UI from SDK transport reality: a ViewModel only ever sees `Loading`, `Success`, or `Failure`, and renders accordingly.

## The type

```kotlin
// shared/mobile-data/.../result/SentientResult.kt
sealed class SentientResult<out T : Any> {
    data class Loading<out T : Any>(val partial: T? = null) : SentientResult<T>()
    data class Success<out T : Any>(val data: T) : SentientResult<T>()
    data class Failure(val error: SentientError) : SentientResult<Nothing>()
}
```

`Failure` is `SentientResult<Nothing>`, so it slots into any `SentientResult<T>` without a type argument.

## The error taxonomy

```kotlin
// shared/mobile-sdk/.../result/SentientError.kt
enum class ErrorKind { CONNECTION, AUTH, PROTOCOL, TIMEOUT, CYCLE, OUTBOX, UNKNOWN }
sealed class RetryPolicy { None; Internal; UserPrompt }   // (data objects)
```

| Subtype | kind | recoverable | retry | When |
|---------|------|-------------|-------|------|
| `Connection` | CONNECTION | true | Internal | WS drop; the SDK reconnect loop handles it |
| `Auth(terminal)` | AUTH | `!terminal` | terminal→None / else→UserPrompt | token expired |
| `Protocol` | PROTOCOL | true | Internal | malformed/unknown frame |
| `Timeout` | TIMEOUT | true | UserPrompt | request deadline (e.g. session list) |
| `Cycle` | CYCLE | true | UserPrompt | cognitive cycle aborted/errored |
| `Outbox` | OUTBOX | true | UserPrompt | queued send failed |
| `Unknown` | UNKNOWN | false | None | unclassified |

The UI maps `retry` → affordance: `Internal` = show a transient banner, the SDK self-heals; `UserPrompt` = show a Retry button; `None` = terminal, route to login or an error state.

## Boundary mapping (errors as values, not throws)

```kotlin
// ConnectionRepository — map ConnectionState → SentientResult, never throw
val status: Flow<SentientResult<ConnectionState>> = connection.map { c ->
    when {
        c.authExpired     -> SentientResult.Failure(SentientError.Auth("Session expired", terminal = true))
        c.connectionLost  -> SentientResult.Failure(SentientError.Connection("Connection lost"))
        c.status == READY -> SentientResult.Success(c)
        c.status == ERROR -> SentientResult.Failure(SentientError.Unknown("Connection error"))
        else              -> SentientResult.Loading(partial = c)
    }
}
```

## Exhaustive folding in the ViewModel

```kotlin
// Android
when (result) {
    is SentientResult.Loading -> ui = ui.copy(isLoading = true, last = result.partial ?: ui.last)
    is SentientResult.Success -> ui = ui.copy(isLoading = false, data = result.data, error = null)
    is SentientResult.Failure -> ui = ui.copy(isLoading = false, error = result.error)  // never else-swallow
}
```

```swift
// iOS — SKIE bridges the sealed class to a Swift enum
onEnum(of: result) { r in
    switch r {
    case .loading(let l): state.isLoading = true; state.last = l.partial ?? state.last
    case .success(let s): state.data = s.data; state.isLoading = false
    case .failure(let f): state.error = f.error; state.isLoading = false
    }
}
```

## Gotchas

- `Loading.partial` is what keeps screens from blank-flashing on reconnect — always thread the last-known value into it (cache, previous `ConnectionState`), don't emit a bare `Loading()`.
- Never `catch` in a ViewModel — the repository already converted the throw into a `Failure`. A ViewModel `try/catch` means a repository is leaking exceptions; fix the repository.
- `userMessage` is display copy; `cause` is for the log sanitizer only. Putting `cause.message` on screen leaks internals.
- Adding a new failure mode = add an `ErrorKind` + a `SentientError` subtype. Do NOT overload `Unknown` as a catch-all for known-but-unhandled cases.
