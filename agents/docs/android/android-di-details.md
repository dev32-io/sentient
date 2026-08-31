# Dependency Injection — Details

This file expands `.claude/rules/android.md`. Production DI is Koin; the shared KMP layer remains framework-free.

## The graph, top-to-bottom

```text
SentientApp.onCreate
  ├─ MobileSdk.initAndroid(applicationContext)
  ├─ startKoin { androidContext(...); modules(appModule) }
  └─ PresenceCoordinator.start()

appModule
  ├─ single PresenceCoordinator
  ├─ single UserSessionManager                 authenticated user/connection owner
  ├─ factory SettingsComponent                 re-resolves the current connection scope
  ├─ viewModel { (sessionId: String?) ->
  │     ChatViewModel(UserSessionManager.component(), sessionId)
  │   }
  └─ route ViewModels over ChatComponent/SettingsComponent usecases
```

`UserSessionManager` lazily builds one `SentientSdk`, `ChatComponent`, and `SettingsComponent` for the explicit authenticated user. It keeps that connection scope across navigation and destroys it on logout, terminal auth failure, account replacement, or backend replacement.

## Koin ownership

`appModule` is the production composition root:

```kotlin
val appModule = module {
    single { PresenceCoordinator() }
    single {
        UserSessionManager(
            appContext = androidContext(),
            presence = get(),
            authenticatedUserStore = AuthenticatedUserHolder.store,
        )
    }

    factory { get<UserSessionManager>().settingsComponent() }

    viewModel { (sessionId: String?) ->
        ChatViewModel(get<UserSessionManager>().component(), sessionId)
    }
    viewModel { HistoryViewModel(get()) }
}
```

`SettingsComponent` is a `factory`, not a Koin `single`: each resolution must ask `UserSessionManager` for the current connection-scoped instance after logout/login or backend replacement.

## UserSessionManager construction

On first `component()` access, `UserSessionManager`:

1. requires the server-authenticated user id and configured backend;
2. creates a serialized `SupervisorJob` session scope with a boundary exception handler;
3. builds `SentientSdk` and the hand-written shared `ChatComponent`;
4. builds `SettingsComponent` beside it on the same authenticated scope;
5. wires presence/network recovery and starts `component.connect()` in the session scope.

The SDK exists only inside this authenticated owner. `ChatViewModel` receives `ChatComponent`, never `SentientSdk` or a repository.

## Route scope is not connection scope

The chat route passes nullable `sessionId` to a Koin ViewModel. A route change creates fresh per-conversation UI state and a fresh VM-owned `OutboundCache`, while the same `UserSessionManager` and `ChatComponent` remain alive. `ChatViewModel.onCleared()` must not disconnect the socket.

Logout and other authenticated-boundary exits call the appropriate `UserSessionManager` teardown before routing to login. Do not use route disposal as connection teardown.

## Gotchas

- Do not add Hilt/Dagger, KSP DI, manual `viewModelFactory` wiring, or a second service locator.
- Do not put `SentientSdk` in `AppDependencies` or a process-global holder.
- Do not inject repositories into screen VMs. Resolve shared usecases and passthrough commands from `ChatComponent`/`SettingsComponent`.
- Do not cache `SettingsComponent` independently of `UserSessionManager`; it becomes stale across authenticated-scope replacement.
- A conversation switch recreates screen state, not the authenticated connection.
