# Compose details

This expands `.claude/rules/android.md`. Keep composables render-only and hoist state to the route/ViewModel boundary.

## Hoisting and collection

```kotlin
@Composable
fun NameField(name: String, onNameChange: (String) -> Unit, modifier: Modifier = Modifier) {
    OutlinedTextField(value = name, onValueChange = onNameChange,
        label = { Text("Name") }, modifier = modifier)
}

@Composable
fun NameScreen(viewModel: NameViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    NameField(state.name) { viewModel.dispatch(NameIntent.Edit(it)) }
}
```

Stateless leaves should be previewable with fake state. Use `LaunchedEffect(key)` for work tied to composition, `DisposableEffect` for setup/cleanup, and `SideEffect` only for post-composition publication. Do not perform I/O directly in a composable.

Use `remember` for expensive or identity-sensitive derived values only when useful. A cheap calculation does not need `derivedStateOf`; when filtering large state, key the remembered derivation by its inputs. Read `State.value` inside the composable scope so Compose tracks it. Prefer stable immutable UI models and lazy-list keys.

## Repository-specific composer gesture rule

`Composer.kt` puts swipe-to-dismiss beside the task strip's `horizontalScroll` in `ComposerTaskStrip.kt`. Built-in `detectVerticalDragGestures` can win on raw vertical touch slop before the horizontal child, even for a mostly horizontal diagonal gesture.

For an ancestor gesture that must coexist with that child, use an `awaitEachGesture` loop, stop when `change.isConsumed`, and defer all consumption until the app action's threshold. Keep sub-threshold events unconsumed so the child can claim the drag. The extracted, unit-tested accumulator is `android/src/main/kotlin/io/sentient/android/chat/composer/ComposerSwipeGesture.kt` (`accumulateSwipeDown`).

## Composer layout sizing

`ComposerTaskStrip.kt` derives pill sizing from the strip's actual constraints, not screen width. Use `BoxWithConstraints`, pass `maxWidth` through a pure helper such as `ComposerTaskStripLayout.kt`'s `taskPillMinWidth`, and apply the resulting `widthIn` as the outermost modifier so padding is included in the bound. Keep the formula unit-testable.

## Insets and adaptive UI

`MainActivity` uses `enableEdgeToEdge()`. Prefer Scaffold-provided insets or `WindowInsets.safeDrawing` rather than fixed status/navigation offsets. Add adaptive layouts only where the current screen needs them; do not introduce a second navigation system—the shipped `NavHost` owns destinations.
