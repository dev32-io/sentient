# MVI Architecture -- Details & Worked Example

This file expands `.claude/rules/android/android-architecture-mvi.md`.
The Login example below shows the full **form-screen MVI triple**
(`UiState` + `Intent` + `dispatch`) — the pattern `AuthViewModel`
and `BackendSetupViewModel` actually use. Simple command screens
(`ChatViewModel`, `HistoryViewModel`, `SettingsViewModel`) expose
plain methods instead; see "Shipped chat architecture" at the end.

All VMs are hand-wired (no Hilt) — see `android-di-details.md`.

## LoginUiState

The state holds everything the view needs to render. Note: the
form fields, the in-flight indicator, and the field-level error
are all here. The "go to home" navigation is NOT -- that's an
Effect.

```kotlin
data class LoginUiState(
    val email: String = "",
    val password: String = "",
    val isSubmitting: Boolean = false,
    val emailError: String? = null,
    val passwordError: String? = null,
) {
    val canSubmit: Boolean
        get() = email.isNotBlank() &&
                password.isNotBlank() &&
                !isSubmitting
}
```

`canSubmit` is a derived `val` -- the view reads it directly, no
extra plumbing. This is cheap; for expensive derivations, the
reducer should compute and cache.

## LoginIntent

Every user action and every external event is a variant. Adding
"forgot password tapped" = adding one variant + one reducer arm.

```kotlin
sealed interface LoginIntent {
    data class EmailChanged(val value: String) : LoginIntent
    data class PasswordChanged(val value: String) : LoginIntent
    data object SubmitTapped : LoginIntent
    data object ForgotPasswordTapped : LoginIntent
    sealed interface Consumed : LoginIntent {
        data object Navigation : Consumed
        data object Toast : Consumed
    }
}
```

## LoginEffect

One-shot side effects. The screen consumes these in a
`LaunchedEffect`; the screen's parent decides what to do.

```kotlin
sealed interface LoginEffect {
    data class NavigateToHome(val userId: UserId) : LoginEffect
    data object NavigateToForgotPassword : LoginEffect
    data class ShowError(val message: String) : LoginEffect
}
```

## LoginViewModel

The reducer is a `when` over the sealed Intent type. Side work
(the actual login call) is launched in `viewModelScope` from
inside the reducer arm.

```kotlin
class LoginViewModel(
    private val authRepository: AuthRepository,   // plain constructor; built via viewModelFactory
) : ViewModel() {

    private val _state = MutableStateFlow(LoginUiState())
    val state: StateFlow<LoginUiState> = _state.asStateFlow()

    // Pattern A (preferred): events live in UiState.
    // LoginUiState includes optional one-shot fields the view consumes + clears.
    //   data class LoginUiState(
    //     ...,
    //     val navigateTo: Destination? = null,
    //     val toast: String? = null,
    //   )
    // The composable reads navigateTo / toast; after acting, dispatches Consumed.
    // Adding a Consumed variant to Intent forces "I saw this event" semantics.

    // Pattern B (secondary): Channel for events that genuinely cannot live in state.
    private val _effects = Channel<LoginEffect>(Channel.BUFFERED)
    val effects: Flow<LoginEffect> = _effects.receiveAsFlow()

    fun dispatch(intent: LoginIntent) {
        when (intent) {
            is LoginIntent.EmailChanged -> _state.update {
                it.copy(email = intent.value, emailError = null)
            }
            is LoginIntent.PasswordChanged -> _state.update {
                it.copy(password = intent.value, passwordError = null)
            }
            LoginIntent.SubmitTapped -> submit()
            LoginIntent.ForgotPasswordTapped -> viewModelScope.launch {
                _effects.send(LoginEffect.NavigateToForgotPassword)
            }
            LoginIntent.Consumed.Navigation -> _state.update { it.copy(navigateTo = null) }
            LoginIntent.Consumed.Toast -> _state.update { it.copy(toast = null) }
        }
    }

    private fun submit() {
        val current = _state.value
        if (!current.canSubmit) return
        _state.update { it.copy(isSubmitting = true) }
        viewModelScope.launch {
            when (val outcome = authRepository.login(current.email, current.password)) {
                is LoginOutcome.Success -> {
                    _state.update { it.copy(isSubmitting = false) }
                    _effects.send(LoginEffect.NavigateToHome(outcome.userId))
                }
                is LoginOutcome.InvalidEmail -> _state.update {
                    it.copy(isSubmitting = false, emailError = outcome.reason)
                }
                is LoginOutcome.InvalidPassword -> _state.update {
                    it.copy(isSubmitting = false, passwordError = outcome.reason)
                }
                is LoginOutcome.NetworkFailure -> {
                    _state.update { it.copy(isSubmitting = false) }
                    _effects.send(LoginEffect.ShowError("Network unavailable"))
                }
            }
        }
    }
}
```

Key properties of this reducer:
- `dispatch` returns `Unit` -- no result, no exceptions.
- Field-level errors live in state; transport failures are
  effects (a snackbar).
- `_state.update { it.copy(...) }` is atomic; safe to call from
  multiple coroutines.

### Why not `SharedFlow(replay=0, extraBufferCapacity=1)`?

Because lifecycle-aware collection pauses the collector when the screen drops below STARTED. A `SharedFlow.emit` issued while the collector is paused will be dropped if the buffer is already drained. The exact bug the rule is supposed to prevent. Channel guarantees delivery via suspend-on-full; events-in-state guarantee delivery via state durability.

## The composable

The screen is mostly view code. It collects state, collects
effects, threads state down, sends Intents up.

```kotlin
@Composable
fun LoginScreen(
    onLoggedIn: (UserId) -> Unit,
    onForgotPassword: () -> Unit,
    viewModel: LoginViewModel,   // passed in from the host; built via viewModelFactory, not hiltViewModel()
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(state.navigateTo) {
        state.navigateTo?.let { dest ->
            when (dest) {
                is Destination.Home -> onLoggedIn(dest.userId)
                Destination.ForgotPassword -> onForgotPassword()
            }
            viewModel.dispatch(LoginIntent.Consumed.Navigation)
        }
    }

    LaunchedEffect(state.toast) {
        state.toast?.let { msg ->
            snackbarHostState.showSnackbar(msg)
            viewModel.dispatch(LoginIntent.Consumed.Toast)
        }
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
        LoginForm(
            modifier = Modifier.padding(padding),
            state = state,
            onEmailChange = { viewModel.dispatch(LoginIntent.EmailChanged(it)) },
            onPasswordChange = { viewModel.dispatch(LoginIntent.PasswordChanged(it)) },
            onSubmit = { viewModel.dispatch(LoginIntent.SubmitTapped) },
            onForgotPassword = { viewModel.dispatch(LoginIntent.ForgotPasswordTapped) },
        )
    }
}
```

`LoginForm` is the stateless leaf -- it takes `state` and
callbacks. It can be `@Preview`'d with fake state without any
ViewModel involved.

## Testing the reducer

Because the reducer is "state in, state out, no I/O directly,"
unit testing is mechanical: construct a VM with a fake
repository, dispatch intents, assert state.

```kotlin
@Test
fun `submit with valid form navigates to home`() = runTest {
    val fakeAuth = FakeAuthRepository().apply {
        nextOutcome = LoginOutcome.Success(UserId("u-1"))
    }
    val vm = LoginViewModel(fakeAuth)

    vm.dispatch(LoginIntent.EmailChanged("a@b.c"))
    vm.dispatch(LoginIntent.PasswordChanged("hunter2"))

    val effects = mutableListOf<LoginEffect>()
    val job = launch { vm.effects.toList(effects) }

    vm.dispatch(LoginIntent.SubmitTapped)
    advanceUntilIdle()

    assertEquals(false, vm.state.value.isSubmitting)
    assertEquals(LoginEffect.NavigateToHome(UserId("u-1")), effects.single())
    job.cancel()
}
```

This is why we keep state in state and effects in effects: the
test asserts on both shapes independently.

## Navigation — state-gate (shipped), NOT NavHost

Top-level navigation is a state-based composable swap in `MainActivity`, gated on booleans. There is no `NavHost`, no route graph, no `navigation-compose` dependency.

```kotlin
// AppRoot → AppConfiguredRoot → ChatRoot (state gate, not a router)
if (!configured || showSetupOverride) BackendSetupScreen(...)
else if (hasToken)                     ChatRoot(...)      // token present (displayName != null)
else                                   LoginScreen(...)
```

Why gate on `hasToken`, not `status == READY`: a WS drop must NOT unmount chat. Token presence is set at login, cleared at logout, and survives a drop — so a dropped connection keeps the user on chat with the connection-lost banner. Settings + the history drawer are overlays inside the in-session state (`rememberSaveable { showSettings }`, `DrawerState`), not stack destinations.

### Future — typed NavHost (NOT adopted)

If a real multi-destination back stack ever appears, the target is Navigation-Compose 2.8+ with `@Serializable` routes (`NavHost(startDestination = …) { composable<Route> { entry.toRoute<Route>() } }`, deep links via `navDeepLink<Route>(…)`, artifacts `navigation-compose` + `kotlinx-serialization-json`, plugin `org.jetbrains.kotlin.plugin.serialization`). Do not add it preemptively — the current screen set does not need a stack.

## Shipped chat architecture (command-method VMs)

`ChatViewModel` is NOT a `dispatch(Intent)` reducer — it collects `chatStream` from the repo and exposes plain command methods:

```kotlin
class ChatViewModel(
    private val repo: ChatRepository,
    private val onOpen: suspend () -> Unit, private val onClose: () -> Unit,
    private val onForeground: () -> Unit, private val onBackground: () -> Unit,
    private val presence: PresenceCoordinator,
) : ViewModel() {
    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    init {
        presence.bind(onForeground = onForeground, onBackground = onBackground)
        viewModelScope.launch { onOpen() }                       // connect in the background
        viewModelScope.launch {                                   // fold the repo's SentientResult
            repo.chatStream.collect { result -> _state.update { it.foldChat(result) } }
        }
    }

    fun send(text: String) { repo.send(text) }                   // optimistic; returns immediately
    fun retry(pendingId: String) { repo.retry(pendingId) }

    override fun onCleared() { presence.unbind(); onClose() }     // single teardown path
}
```

The SDK is reached only through `repo` (a `MobileSession` repository). Commands that are one-shot SDK calls (`newChat`, `interrupt`, mic toggle) are invoked on `session.sdk` from the composition scope in `ChatRoot` — see `MainActivity.kt`.
