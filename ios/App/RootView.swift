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
                    model: BackendSetupViewModel(
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
