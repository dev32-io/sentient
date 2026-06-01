# Kotlin -- Details & Examples

This file expands `platforms/android/rules/kotlin.md`. The rule
states the bar; this doc shows the patterns and the anti-patterns
the agent reaches for when uncertain.

## Null-safety patterns

The hierarchy of preference, strongest to weakest:

```kotlin
// 1. Smart-cast: best -- compile-time narrowing.
fun render(user: User?) {
    if (user != null) {
        // `user` is now `User` (non-null) inside this block.
        println(user.name)
    }
}

// 2. Safe call + Elvis: pure-expression form.
val display = user?.name ?: "Anonymous"

// 3. requireNotNull: precondition with message.
fun process(input: Input) {
    val token = requireNotNull(input.token) {
        "process() requires a token; got input=$input"
    }
    // `token` is non-null below.
}

// 4. let for transform-if-present.
user?.let { sendWelcome(it) }
```

The forbidden form:

```kotlin
// NEVER. `!!` says "I promise this is non-null." If the promise
// breaks, the stack trace points at the !! site, not the bug.
val name = user!!.name
```

If you find yourself writing `!!`, the right answer is one of:
1. Change the type to non-null upstream.
2. Use `requireNotNull(x) { "..." }` with a real message.
3. Handle the null case explicitly.

## Sealed class as state enum

`sealed class` with `data class` variants is the canonical shape
for UI state. The compiler enforces exhaustive `when`.

```kotlin
sealed interface LoadState<out T> {
    data object Idle : LoadState<Nothing>
    data object Loading : LoadState<Nothing>
    data class Success<T>(val value: T) : LoadState<T>
    data class Failure(val cause: Throwable) : LoadState<Nothing>
}

@Composable
fun renderState(state: LoadState<User>) = when (state) {
    LoadState.Idle -> EmptyState()
    LoadState.Loading -> Spinner()
    is LoadState.Success -> UserCard(state.value)
    is LoadState.Failure -> ErrorView(state.cause)
} // exhaustive -- adding a variant forces this when to update.
```

Compare against `enum class`, which can't carry per-variant data:

```kotlin
// Use enum for plain tags only.
enum class SortOrder { Ascending, Descending }
```

## Unstructured-launch anti-pattern

`GlobalScope` is a global, never-cancelled scope. Work launched
there outlives its caller:

```kotlin
// BAD: leaks the job past the calling lifecycle. Result never
// reaches a UI that may already be gone, and the network call
// keeps going on rotation/back-press/process death races.
class BadViewModel : ViewModel() {
    fun load() {
        GlobalScope.launch {
            val users = api.fetchUsers()
            _state.value = State.Loaded(users)
        }
    }
}
```

The structured form:

```kotlin
// GOOD: tied to viewModelScope. Cancelled when the ViewModel
// is cleared. The collector never sees state from a dead VM.
class GoodViewModel(private val api: Api) : ViewModel() {
    fun load() {
        viewModelScope.launch {
            val users = withContext(Dispatchers.IO) { api.fetchUsers() }
            _state.value = State.Loaded(users)
        }
    }
}
```

The same applies to coroutines started from a Composable -- use
`LaunchedEffect(key)` so the coroutine respects composition
lifecycle.

## Result vs throw -- the decision

Use throw for invariant violations (bugs):

```kotlin
fun divide(a: Int, b: Int): Int {
    require(b != 0) { "divide() called with b=0" }  // programmer bug.
    return a / b
}
```

Use `Result` (or domain sealed class) for expected failures:

```kotlin
// kotlin.Result form -- terse, fine for internal boundaries.
suspend fun loadUser(id: UserId): Result<User> = runCatching {
    api.getUser(id)
}

// Domain sealed-class form -- preferred at module boundaries.
sealed interface LoadUserOutcome {
    data class Found(val user: User) : LoadUserOutcome
    data object NotFound : LoadUserOutcome
    data class TransportFailure(val cause: IOException) : LoadUserOutcome
}

suspend fun loadUser(id: UserId): LoadUserOutcome = try {
    when (val response = api.getUser(id)) {
        is ApiResponse.Ok -> LoadUserOutcome.Found(response.body)
        is ApiResponse.NotFound -> LoadUserOutcome.NotFound
    }
} catch (e: IOException) {
    LoadUserOutcome.TransportFailure(e)
}
```

The domain sealed-class form is preferred when:
- Callers must discriminate the failure (NotFound vs transport).
- The failure carries useful data (validation errors, retry hint).
- The surface is a public module/feature boundary.

`kotlin.Result` is fine for internal helpers where the caller
only needs "ok / failed with throwable."

## Extension functions -- additive, not stateful

```kotlin
// GOOD: pure transform, no hidden state.
fun String.toUserId(): UserId? =
    if (matches(USER_ID_REGEX)) UserId(this) else null

// BAD: extension pretending to be a class. Use a class.
private var counter = 0  // top-level mutable state
fun String.next(): String {
    counter++           // hidden mutation -- breaks reasoning.
    return "$this-$counter"
}
```

If an extension needs state, you've outgrown the pattern -- model
it as a class with a method.
