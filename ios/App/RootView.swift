// ---------------------------------------------------------------------------
// RootView — 3-way gate: unconfigured → setup, configured+no-token → login,
//             configured+token-present → chat.
//
// Config is checked FIRST so auth state is never evaluated while unconfigured.
// showSetupOverride lets the gear button on LoginView re-open setup at any time
// (without clearing the persisted config); after save, the override is cleared
// and the auth gate resumes normal routing.
//
// The auth gate keys on appConfig.hasToken (a reactive proxy for token presence:
// set when login saves a display name, cleared on logout). Gating on transport
// status would unmount ChatView on every WS drop and fall back to login, hiding
// the in-chat connection-lost banner. hasToken is set on first login and
// PRESERVED across drops / idle-disconnect / reconnect, cleared only on logout
// or authExpired — so a drop keeps the user on chat WITH the banner.
// Mirrors web-sdk: AUTH gates the screen, status drives the banner.
//
// ChatRoot builds a chat-scoped MobileSession + ChatViewModel once per entry.
// ChatViewModel.deinit is the single session-close path — do NOT add a second
// .onDisappear close path. The session is torn down when ChatView disappears
// (logout → hasToken=false → ChatRoot exits → StateObject deinit fires).
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct RootView: View {
    @EnvironmentObject private var appConfig: AppConfig
    @State private var showSetupOverride = false
    @State private var showSplash = true
    private let log = AppLog("root")

    var body: some View {
        Group {
            if !appConfig.isConfigured || showSetupOverride {
                BackendSetupView(
                    model: BackendSetupModel(
                        existing: BackendConfigStore().load(),
                        reconfigure: { appConfig.reconfigure($0) }
                    ),
                    onSaved: { showSetupOverride = false }
                )
            } else if appConfig.hasToken {
                ChatRoot(appConfig: appConfig)
            } else {
                LoginView(
                    onConnect: { appConfig.didLogin() },
                    onOpenBackendSetup: { showSetupOverride = true }
                )
            }
        }
        .overlay {
            if showSplash {
                SplashOverlay()
                    .transition(.opacity)
            }
        }
        .task(id: appConfig.configGeneration) {
            showSplash = true
            log.info("splash.show generation=\(appConfig.configGeneration)")
            try? await Task.sleep(for: .seconds(SplashLayout.minDisplay))
            withAnimation(.easeOut(duration: SplashLayout.fadeOut)) { showSplash = false }
            log.info("splash.hide")
        }
    }
}

// ---------------------------------------------------------------------------
// ChatRoot — builds a chat-scoped MobileSession + ChatViewModel, renders
// ChatView. Extracted to keep RootView under the 40-line function limit.
//
// The @StateObject ChatViewModel is created ONCE per composition entry into
// this branch. Exiting the branch (hasToken=false on logout) deinits the
// StateObject → ChatViewModel.deinit fires → session.close(). That is the
// SINGLE teardown path. No DisposableEffect / onDisappear close needed.
// ---------------------------------------------------------------------------

// ChatSessionConfig bundles the immutable backend params so ChatRoot doesn't
// re-create sessions on recomposition (the @StateObject autoclosure is still
// called on every ChatRoot.init, but the VM/session is the first one only).
private struct ChatSessionConfig {
    let gatewayWsUrl: String
    let allowSelfSignedDevHost: Bool
}

private struct ChatRoot: View {
    let config: ChatSessionConfig
    let userName: String
    let onLogout: () -> Void

    // @StateObject ensures ChatViewModel (and the MobileSession inside it) is
    // created exactly ONCE per composition lifetime of this view branch.
    // The wrappedValue autoclosure is only kept on the first init; subsequent
    // ChatRoot struct inits (parent recompose) are ignored by SwiftUI.
    @StateObject private var vm: ChatViewModel

    init(appConfig: AppConfig) {
        config = ChatSessionConfig(
            gatewayWsUrl: appConfig.gatewayWsUrl,
            allowSelfSignedDevHost: appConfig.allowSelfSignedDevHost
        )
        userName = appConfig.displayName
        onLogout = { appConfig.logout() }
        _vm = StateObject(wrappedValue: ChatViewModel(
            session: createMobileSession(
                gatewayWsUrl: appConfig.gatewayWsUrl,
                allowSelfSignedDevHost: appConfig.allowSelfSignedDevHost,
                capabilities: [],
                // Enable FaultHooks in debug builds for E2E fault-injection flows.
                // NOTE: iOS has no broadcast-receiver arming channel; arm faults
                // from the app code or via a future debug UI. FLAG: iOS fault
                // injection is a follow-up (no adb-equivalent simple arming channel).
                devFaultsEnabled: { () -> Bool in
                    #if DEBUG
                    return true
                    #else
                    return false
                    #endif
                }()
            )
        ))
    }

    var body: some View {
        ChatView(vm: vm, userName: userName, onLogout: onLogout)
    }
}
