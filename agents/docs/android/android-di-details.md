# Dependency Injection — Details

This file expands `.claude/rules/android/android-di.md`. The app uses manual constructor wiring + Compose `viewModelFactory` — no Hilt/Dagger.

## The graph, top-to-bottom

```
SentientApp.onCreate
  ├─ MobileSdk.initAndroid(applicationContext)     // one-time platform init
  └─ PresenceCoordinator().start()                 // app-scoped fg/bg relay

MainActivity → AppRoot → AppConfiguredRoot → ChatRoot
  └─ val chatSession = remember { SdkSessionFactory.create() }   // chat-scoped MobileSession
       ├─ chatVm = viewModel(key = "chat-${identityHashCode(chatSession)}") {
       │      ChatViewModel(repo = chatSession.chatRepo,
       │                    onOpen = { chatSession.open() }, onClose = { chatSession.close() },
       │                    onForeground = { chatSession.resume() }, onBackground = { chatSession.pause() },
       │                    presence = appPresence)
       │   }
       └─ historyVm = viewModel(key = "history-…") { HistoryViewModel(chatSession.historyRepo, …) }
```

Activity-scoped VMs with no collaborators use the `by viewModels { … }` form:

```kotlin
private val authViewModel: AuthViewModel by viewModels {
    viewModelFactory { initializer { AuthViewModel() } }
}
```

## Session-scoped construction (SdkSessionFactory)

```kotlin
object SdkSessionFactory {
    fun create(): MobileSession {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
        val r = resolveBackend(/* override, build-time default */)
        require(r is ResolvedBackend.Configured)
        val config = SdkConfig(gatewayWsUrl = r.gatewayWsUrl, capabilities = AppDependencies.capabilities, …)
        val sdk = SentientSdk(config = config, bundle = createPlatformBundle(), scope = scope)
        return MobileSession(sdk = sdk, scope = scope)   // repos + lifecycle wired inside MobileSession
    }
}
```

The SDK instance exists ONLY here. There is no process-wide SDK singleton.

## App-scoped, non-SDK deps (AppDependencies)

```kotlin
object AppDependencies {
    val capabilities: List<String> = listOf(/* connector CAPABILITY consts */)
    val tokenStore: SecureTokenStore by lazy { createPlatformBundle().tokenStore }
    val authClient: AuthClient get() = /* lazily built from resolved backend; invalidate on config change */
}
```

These outlive a chat screen (token survives logout→login). The SDK does not.

## Keying = teardown

Keying the VM by `MobileSession` identity means a logout→login (which exits + re-enters `ChatRoot`, producing a fresh session) clears the old VM. `ChatViewModel.onCleared()` → `onClose` → `session.close()` is the SINGLE teardown path — no `DisposableEffect` needed.

## Gotchas

- Do NOT introduce a global `SdkHolder`/`object Sdk`. The whole point of the refactor was to bind the SDK to the chat scope; a singleton resurrects the lifecycle/leak bugs.
- `viewModel(key = …)` without a stable key reuses the VM across sessions — the stale repo/scope then leaks. Always key by session identity.
- `AppDependencies` is for app-lived NON-SDK state only. If you find yourself putting a `SentientSdk` there, it belongs in `MobileSession`.

## Future — Hilt (NOT adopted)

Hilt/Dagger is intentionally NOT used today; the graph is small enough that hand-wiring is clearer and avoids an annotation processor. If the app grows enough modules to justify it, the migration target would be: `@HiltAndroidApp` Application, `@HiltViewModel @Inject constructor` VMs, `hiltViewModel()` in Compose, `@Module @InstallIn` bindings, KSP (`ksp(libs.hilt.compiler)`, not KAPT), and `@TestInstallIn` for test doubles. Until that decision is made, do not add Hilt annotations — they will not compile (no Hilt plugin/deps on the classpath).
