# Android testing details

This expands `.claude/rules/android.md`. Prefer deterministic behavior tests and fakes at app boundaries.

## JVM tests

The Android module's configured unit-test dependencies are `kotlin-test` and `kotlinx-coroutines-test`. Existing tests live under `android/src/test/kotlin/io/sentient/android/`, including `ChatViewModelTest`, permission/reconnect tests, state and mapper tests, and the composer gesture/layout tests.

For coroutine-driven ViewModels, use `runTest`, a test dispatcher where needed, `advanceUntilIdle()`, and assert public state/behavior. Do not test implementation call counts when an observable outcome is sufficient. Fake shared components or repositories you own; use a real boundary only when the behavior under test requires it.

```kotlin
@Test
fun `failure keeps the last model and shows a retryable banner`() {
    val prior = ChatUiState(model = ChatModel(committed = listOf(message)))
    val next = reduceChatUi(prior, SentientResult.Failure(SentientError.Connection("lost")))

    assertEquals(prior.model, next.model)
    assertTrue(next.banner?.canRetry == true)
}
```

Use the existing `reduceChatUi` seam for reducer behavior. Current Android tests do not provide a general `ChatComponent` test double; do not claim one exists. If a ViewModel change truly requires construction, introduce the smallest boundary fake in the same change and preserve the invariant that teardown does not close the `UserSessionManager` connection.

## Compose-facing behavior

The module does not currently configure an `androidTest`/AndroidX Compose UI-test stack. Prefer pure reducers and extracted helpers for deterministic behavior; add device/Compose infrastructure only for a failure that cannot be pinned at a cheaper stable boundary.

The repository's pure composer tests cover the tricky gesture/layout contracts: `ComposerSwipeGestureTest.kt`, `ComposerTaskStripLayoutTest.kt`, and `MicCornerGestureTest.kt`. Preserve those tests when changing `Composer.kt`, `ComposerTaskStrip.kt`, or their helpers. Avoid sleeps—advance test schedulers or wait on an explicit condition.

## Maestro E2E

Maestro is the configured emulator E2E driver. Reusable charters are in `qa/android/charters/`; numbered Android flows are in `qa/mobile/flows/android/`, driven by `qa/mobile/run-e2e.sh`.

```yaml
# qa/mobile/flows/android/01-send-stream.yaml
appId: io.dev32.sentient.debug
---
- launchApp
- runFlow:
    when: { visible: { id: "login-backend-setup" } }
    file: "_helpers/login.yaml"
- assertVisible:
    id: "composer-input"
- tapOn:
    id: "composer-input"
- inputText: "what is 2 plus 2"
- tapOn:
    id: "chat-send"
- assertVisible:
    id: "assistant-bubble"
```

Compose tags are surfaced as resource IDs through `testTagsAsResourceId`. Debug fault scenarios use `adb shell am broadcast -a io.sentient.debug.FAULT --es kind <fault>`.

MockK, Robolectric, Roborazzi, Macrobenchmark, and JankStats are not configured. Do not add examples, commands, or claims that depend on them.
