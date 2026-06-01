# Coroutines and Flow -- Details & Examples

This file expands `platforms/android/rules/android-coroutines-flow.md`.
Worked examples for the patterns the rule names.

## StateFlow vs SharedFlow -- the comparison

`StateFlow` is for state. A new collector immediately sees the
current value. Equality is checked -- emitting the same value
twice is a no-op.

```kotlin
class CounterViewModel : ViewModel() {
    private val _count = MutableStateFlow(0)
    val count: StateFlow<Int> = _count.asStateFlow()

    fun increment() {
        _count.value = _count.value + 1
    }
}

// Collector: always sees a value. Late subscribers get the
// current value immediately.
viewModel.count.collect { println(it) }
```

`SharedFlow` is for events. There's no "current value." New
collectors only see future emissions (unless `replay > 0`).
Equality is NOT checked -- repeated emissions all fire.

```kotlin
class NavViewModel : ViewModel() {
    private val _events = MutableSharedFlow<NavEvent>(
        replay = 0,
        extraBufferCapacity = 1,
    )
    val events: SharedFlow<NavEvent> = _events.asSharedFlow()

    fun goHome() {
        viewModelScope.launch {
            _events.emit(NavEvent.Home)
        }
    }
}
```

The decision:
- "What's the current X?" -- StateFlow.
- "What just happened?" -- SharedFlow.

A common mistake is modeling a one-shot event (like "show
snackbar with message X") as state. On rotation, the collector
re-reads the same state and re-fires the snackbar. SharedFlow
is right: the event fires once.

## Lifecycle-scoped collection -- Compose

`collectAsStateWithLifecycle` is the right collector in Compose.
It pauses when the screen is below STARTED.

```kotlin
@Composable
fun ScreenA(vm: AViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    // `state` is the latest UiState; collection pauses on background.
    Body(state)
}
```

For one-shot events, collect inside a `LaunchedEffect`:

```kotlin
@Composable
fun ScreenA(vm: AViewModel = hiltViewModel()) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(Unit) {
        vm.events.collect { event ->
            when (event) {
                is Event.ShowSnackbar -> snackbar.showSnackbar(event.msg)
            }
        }
    }
    // ...
}
```

## Lifecycle-scoped collection -- Fragment / Activity

When not in Compose, use `repeatOnLifecycle`:

```kotlin
override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
    viewLifecycleOwner.lifecycleScope.launch {
        viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            viewModel.state.collect { state ->
                renderState(state)
            }
        }
    }
}
```

`repeatOnLifecycle` cancels the inner collector when the
lifecycle drops below STARTED and re-launches when it rises
again. Don't try to write this loop by hand -- the helper handles
the edge cases (initial run, cancellation, re-launch) correctly.

## `flatMapLatest` -- search-as-you-type

The use case: user types in a search box, each keystroke kicks
off a network query, and the user's latest input is the one
whose results we want. Older in-flight queries are wasted work
-- they should be cancelled.

```kotlin
class SearchViewModel @Inject constructor(
    private val repo: SearchRepository,
) : ViewModel() {

    private val query = MutableStateFlow("")

    val results: StateFlow<List<Result>> = query
        .debounce(300)             // wait 300ms after typing stops
        .filter { it.length >= 2 } // ignore one-char queries
        .distinctUntilChanged()    // ignore re-emission of same query
        .flatMapLatest { q ->
            // When a new q arrives, the previous repo.search()
            // is cancelled mid-flight.
            repo.search(q)
        }
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5_000),
            initialValue = emptyList(),
        )

    fun onQueryChange(q: String) { query.value = q }
}
```

The chain reads top-to-bottom: keystroke → debounce → filter →
dedupe → cancel-previous + new query → stateIn for the UI.

`SharingStarted.WhileSubscribed(5_000)` is the right policy for
screen-scoped state: collect while there's at least one
subscriber; keep producing for 5s after the last leaves
(survives rotation without re-fetching).

## Producer/consumer with backpressure

A naive producer overwhelming a slow consumer:

```kotlin
// BAD: producer blocks on each emit, slowing it down to consumer speed.
flow {
    for (frame in cameraFrames) emit(frame)
}.collect { frame ->
    processSlowly(frame)
}
```

With `conflate`, intermediate frames drop -- the consumer always
gets the latest:

```kotlin
flow {
    for (frame in cameraFrames) emit(frame)
}.conflate()
 .collect { frame ->
    processSlowly(frame)
 }
```

With `buffer(N)`, producer can race ahead by N items:

```kotlin
flow { ... }
    .buffer(capacity = 16)
    .collect { ... }
```

Pick `conflate` when intermediate values are disposable;
`buffer` when none can be dropped but the producer can run
ahead.

## Dispatcher placement

Wrong: ViewModel knows about IO.

```kotlin
class Bad : ViewModel() {
    fun load() = viewModelScope.launch(Dispatchers.IO) {
        val users = api.fetchUsers()  // blocking
        _state.update { it.copy(users = users) }  // wrong thread!
    }
}
```

Right: dispatcher pushed down into the repository; ViewModel
runs on Main.

```kotlin
class UserRepository @Inject constructor(private val api: Api) {
    suspend fun fetch(): List<User> = withContext(Dispatchers.IO) {
        api.fetchUsers()
    }
}

class Good : ViewModel() {
    fun load() = viewModelScope.launch {
        val users = repo.fetch()
        _state.update { it.copy(users = users) }  // Main -- safe.
    }
}
```

The boundary owns the dispatcher choice. Callers don't repeat
themselves; collectors are always on Main.

## Data sources as Flow (audit G5)

### Room

```kotlin
@Dao
interface CounterDao {
    @Query("SELECT * FROM counter LIMIT 1")
    fun observe(): Flow<CounterRow?>

    @Upsert
    suspend fun upsert(row: CounterRow)
}
```

Repository wraps and maps. ViewModel collects via `stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), initial)`.

### DataStore Preferences

```kotlin
val Context.dataStore by preferencesDataStore("settings")

class SettingsRepository(private val ds: DataStore<Preferences>) {
    val dark: Flow<Boolean> = ds.data.map { it[booleanPreferencesKey("dark")] ?: false }
    suspend fun setDark(v: Boolean) { ds.edit { it[booleanPreferencesKey("dark")] = v } }
}
```

### DataStore Proto

For typed payloads, prefer Proto DataStore over key-value Preferences. Serializer implements `Serializer<T>`; reads/writes are typed `Flow<T>`.
