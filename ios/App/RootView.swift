// ---------------------------------------------------------------------------
// RootView — 3-way gate: unconfigured → setup, configured+no-token → login,
//             configured+token-present → chat.
//
// Config is checked FIRST so auth state is never evaluated while unconfigured.
// showSetupOverride lets the gear button on LoginView re-open setup at any time
// (without clearing the persisted config); after save, the override is cleared
// and the auth gate resumes normal routing.
//
// The auth gate keys on appConfig.hasToken (token + display name + explicit
// server-authenticated userId), cleared on logout. Gating on transport
// status would unmount ChatView on every WS drop and fall back to login, hiding
// the in-chat connection-lost banner. hasToken is set on first login and
// PRESERVED across drops / idle-disconnect / reconnect, cleared only on logout
// or authExpired — so a drop keeps the user on chat WITH the banner.
// Mirrors web-sdk: AUTH gates the screen, status drives the banner.
//
// UserSessionHost owns the User/Connection-scoped UserSession (@StateObject) once
// per authed entry: ONE ChatComponent + SDK that survives navigation. Logout
// (UserSessionHost.logout → appConfig.logout → hasToken=false) exits the authed
// branch → the UserSession @StateObject deinits → its KMP session is shut down.
//
// The authed branch is wrapped in UpdateGate: it owns the shared UpdateModel, runs
// the cold-start OTA check, and renders the force-update gate (blocking, ahead of
// chat) / optional banner overlay. Auth-scoped (mounts only on the hasToken
// branch) so it rebuilds fresh on logout/reconfigure, and a WS drop never bounces
// to login — the gate keys on AUTH, never transport.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

@MainActor
struct RootView: View {
    @EnvironmentObject private var appConfig: AppConfig
    @State private var showSetupOverride = false
    @StateObject private var startup: StartupReadinessCoordinator
    private let log = AppLog("root")

    init() {
        _startup = StateObject(wrappedValue: StartupReadinessCoordinator())
    }

    init(startup: StartupReadinessCoordinator) {
        _startup = StateObject(wrappedValue: startup)
    }

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
                UpdateGate(appConfig: appConfig)
            } else {
                LoginView(
                    onAuthenticatedUser: { appConfig.didLogin(authenticatedUserId: $0) },
                    onConnect: {},
                    onInitialUsersResolved: { startup.rootDidResolve() },
                    onOpenBackendSetup: { showSetupOverride = true }
                )
            }
        }
        .overlay {
            if startup.isCovering {
                SplashOverlay()
                    .transition(.opacity)
            }
        }
        .task(id: appConfig.configGeneration) {
            startup.begin()
            log.info("startup.begin generation=\(appConfig.configGeneration)")
            // Setup is immediately actionable. An authenticated shell is also
            // usable while its connection resolves because it owns recovery UI.
            // Login resolves separately after its initial user-list terminal result.
            if !appConfig.isConfigured || appConfig.hasToken {
                startup.rootDidResolve()
            }
        }
        .onChange(of: startup.isCovering) { _, covering in
            if !covering { log.info("startup.reveal") }
        }
    }
}
