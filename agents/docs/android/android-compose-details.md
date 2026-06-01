# Jetpack Compose -- Details & Examples

This file expands `platforms/android/rules/android-compose.md`.
The rule states the bar; this doc shows the patterns and the
recomposition gotchas that catch agents off-guard.

## State hoisting -- the canonical shape

The "hoisted" version separates the controller from the view.
The controller (screen) owns state; the view (component) is pure.

```kotlin
// Stateless component -- reusable, previewable, no VM.
@Composable
fun NameField(
    name: String,
    onNameChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedTextField(
        value = name,
        onValueChange = onNameChange,
        label = { Text("Name") },
        modifier = modifier,
    )
}

// Stateful screen -- owns state via VM, threads state down.
@Composable
fun NameScreen(viewModel: NameViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    NameField(
        name = state.name,
        onNameChange = { viewModel.dispatch(NameIntent.Edit(it)) },
    )
}

@Preview
@Composable
private fun NameFieldPreview() {
    AppTheme {
        NameField(name = "Ada Lovelace", onNameChange = {})
    }
}
```

`NameField` doesn't know `NameViewModel` exists. That's the
property that makes it reusable and previewable.

## `derivedStateOf` for expensive computed values

A naive computed value in the body recomputes on every
recomposition:

```kotlin
// BAD: filteredItems recomputes every recomposition, even when
// `items` and `query` haven't changed.
@Composable
fun ItemList(items: List<Item>, query: String) {
    val filteredItems = items.filter { it.matches(query) }
    LazyColumn { items(filteredItems) { ItemRow(it) } }
}
```

`derivedStateOf` memoizes against the State reads inside its
block. Recomputes only when those reads change:

```kotlin
// GOOD: filteredItems recomputes only when items OR query change.
@Composable
fun ItemList(items: List<Item>, query: String) {
    val filteredItems by remember(items, query) {
        derivedStateOf { items.filter { it.matches(query) } }
    }
    LazyColumn { items(filteredItems) { ItemRow(it) } }
}
```

`derivedStateOf` is for "many State reads → one computed value
that doesn't change as often." If the computation is cheap, skip
it -- the wrapper itself has overhead.

## `produceState` for one-shot async loads

When you need to start an async load when a composable enters
the composition and surface its result as state:

```kotlin
@Composable
fun UserAvatar(userId: UserId, repo: UserRepository) {
    val avatarState by produceState<AvatarState>(
        initialValue = AvatarState.Loading,
        userId,
    ) {
        value = try {
            AvatarState.Loaded(repo.loadAvatar(userId))
        } catch (e: IOException) {
            AvatarState.Error(e)
        }
    }

    when (val s = avatarState) {
        AvatarState.Loading -> Spinner()
        is AvatarState.Loaded -> Image(s.bitmap, null)
        is AvatarState.Error -> ErrorIcon()
    }
}
```

`produceState` is a `LaunchedEffect` + `remember { mutableStateOf }`
in one helper. Reach for it when the source is async and the sink
is a single State.

## Common recomposition gotchas

### Lambda capture without `remember`

```kotlin
// BAD: lambda is a new instance every recomposition, breaking
// MyButton's skippability.
@Composable
fun Screen(viewModel: VM) {
    MyButton(onClick = { viewModel.click() })
}

// GOOD: stable lambda reference across recomposition.
@Composable
fun Screen(viewModel: VM) {
    val onClick = remember(viewModel) { { viewModel.click() } }
    MyButton(onClick = onClick)
}
```

In practice, method-reference form (`viewModel::click`) is also
stable -- Compose treats it as referentially equal.

### Reading State outside its scope

```kotlin
// BAD: by-getter outside the composable function body. The
// State read isn't tracked; updates don't trigger recomposition.
class BadHelper(val state: State<Int>) {
    fun render() = Text("${state.value}")  // unreliable
}
```

Always read `State.value` (or use `by`) inside a `@Composable`
function, where the runtime can observe the read.

### Unstable list parameters

```kotlin
// PROBABLY UNSTABLE: List<T> is an interface; the compiler
// can't prove the implementation is immutable.
@Composable
fun Items(items: List<Item>) { ... }

// STABLE: ImmutableList from kotlinx.collections.immutable, or
// wrap in @Immutable class.
@Immutable
data class ItemList(val items: List<Item>)

@Composable
fun Items(list: ItemList) { ... }
```

If profiling shows a list-taking composable recomposes too
often, this is the usual cause.

## Effect lifecycle quick reference

```kotlin
// LaunchedEffect: keyed coroutine.
LaunchedEffect(userId) {
    // Re-runs when userId changes; cancels on leaving composition.
    val user = repo.load(userId)
    snackbarHost.showSnackbar("Loaded ${user.name}")
}

// DisposableEffect: setup + teardown.
DisposableEffect(lifecycleOwner) {
    val observer = LifecycleEventObserver { _, event -> ... }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
}

// SideEffect: runs after every successful composition.
SideEffect {
    analytics.screenView(screenName)
}
```

Pick by lifetime requirement: coroutine that should cancel
(`LaunchedEffect`), resource that needs cleanup (`DisposableEffect`),
fire-and-forget every frame (`SideEffect`).

## Strong-skipping mode (audit A10)

On Compose Compiler 2.0+ (default since 1.5.4 + on by default at 2.0.20), every restartable composable is skippable: at recomposition, params are compared by `equals()`, and on referential equality with the previous frame the body is skipped. Unstable params (e.g. `List<T>`, lambdas with captured state) are still tested; the framework compares by `===` (reference) and re-runs the body if changed.

What this means in practice:

- Annotating a `data class` of primitives with `@Immutable` no longer changes skippability — the compiler already infers it as stable.
- Annotating `@Stable` on a class with expensive `equals()` still pays off — it tells the runtime to skip the comparison entirely when the reference is unchanged.
- Lambdas: if the lambda doesn't capture mutable state, the compiler hoists it to a singleton — referentially stable. If it captures changing state, the lambda *is* unstable and the strong-skipping fallback runs.

Measurement: enable Compose Compiler metrics:

```kotlin
composeCompiler {
    metricsDestination = layout.buildDirectory.dir("compose_metrics")
    reportsDestination = layout.buildDirectory.dir("compose_reports")
}
```

Generates `module-metrics.json` and `composables.txt` showing skippable / restartable / inline counts per composable.

## Adaptive layouts (audit G3)

```kotlin
val windowSizeClass = calculateWindowSizeClass(activity)
when (windowSizeClass.widthSizeClass) {
    WindowWidthSizeClass.Compact -> CompactLayout()
    WindowWidthSizeClass.Medium  -> MediumLayout()
    WindowWidthSizeClass.Expanded -> ExpandedLayout()
}
```

Dependency: `androidx.compose.material3.adaptive:adaptive` + `androidx.compose.material3.adaptive:adaptive-layout`.

For top-level adaptive navigation:

```kotlin
NavigationSuiteScaffold(navigationSuiteItems = { ... }) { content() }
```

Auto-switches between bottom nav / nav rail / nav drawer based on window size.

## Edge-to-edge (audit A5)

```kotlin
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { AppTheme { Surface { App() } } }
    }
}
```

Requires `androidx.activity:activity-compose:1.8.0+`. With targetSdk 35+ it is the **enforced default**; on Android 16 the opt-out flag is removed. Insets via `WindowInsets.safeDrawing`, `Modifier.safeDrawingPadding()`, or Material3 `Scaffold` which propagates insets to its content lambda.

Theme: define `res/values/themes.xml`:

```xml
<resources>
    <style name="Theme.AppName" parent="Theme.Material3.DayNight.NoActionBar">
        <item name="android:statusBarColor">@android:color/transparent</item>
        <item name="android:navigationBarColor">@android:color/transparent</item>
        <item name="android:windowLightStatusBar">true</item>
        <item name="android:enforceNavigationBarContrast">false</item>
    </style>
</resources>
```

Add dep `com.google.android.material:material` for the parent theme to resolve.
