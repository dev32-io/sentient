// ---------------------------------------------------------------------------
// RootView — startup gate: setup, cold bearer validation/retry, login, or
// draft shell. Coherent stored credentials may mount only in explicit local-offline
// mode after a typed network failure; this does not claim server validation.
//
// Config is checked FIRST so auth state is never evaluated while unconfigured.
// showSetupOverride lets the gear button on LoginView re-open setup at any time
// (without clearing the persisted config); after save, the override is cleared
// and the auth gate resumes normal routing.
//
// Cold launch first validates appConfig's stored token + identity. Successful
// login enters directly because login already established server authority. Gating on transport
// status would unmount ChatView on every WS drop and fall back to login, hiding
// the in-chat connection-lost banner. hasToken is set on first login and
// PRESERVED across drops / idle-disconnect / reconnect, cleared only on logout
// or authExpired — so a drop keeps the user on chat WITH the banner.
// Mirrors web-sdk: AUTH gates the screen, status drives the banner.
//
// UserSessionHost owns the User/Connection-scoped UserSession (@StateObject) once
// per authed entry: ONE ChatComponent + SDK that survives navigation. Logout runs
// UserSession's bounded push/session/auth boundary; clearing auth exits the authed
// branch and releases the KMP session.
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
    @State private var loginRevealed = false
    @StateObject private var startup: StartupReadinessCoordinator
    @ObservedObject private var push = NativePushCoordinator.shared
    private let log = AppLog("root")

    init() {
        _startup = StateObject(wrappedValue: StartupReadinessCoordinator())
    }

    init(startup: StartupReadinessCoordinator) {
        _startup = StateObject(wrappedValue: startup)
    }

    var body: some View {
        ZStack {
            if !appConfig.isConfigured || showSetupOverride {
                BackendSetupView(
                    model: BackendSetupViewModel(
                        existing: BackendConfigStore().load(),
                        reconfigure: {
                            push.navigation.clear()
                            appConfig.reconfigure($0)
                        }
                    ),
                    onSaved: { showSetupOverride = false }
                )
            } else if appConfig.startupAuthentication.permitsDraftShell {
                UpdateGate(appConfig: appConfig)
                    .transition(.opacity)
                    .zIndex(1)
            } else if appConfig.startupAuthentication == .retry {
                VStack(spacing: Space.lg) {
                    Text("Can't verify your account")
                        .designText(.title)
                    Text("Check your connection, then try again.")
                        .designText(.body)
                        .foregroundStyle(DuskColors.ink2)
                    DesignActionButton(
                        title: "Retry",
                        accessibilityId: "startup-auth-retry",
                        fillsWidth: false
                    ) { Task { await validateStoredAuthentication() } }
                }
                .padding(Space.lg)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(DuskColors.bg.ignoresSafeArea())
                .zIndex(1)
            } else if appConfig.startupAuthentication == .validating {
                ProgressView("Verifying account…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(DuskColors.bg.ignoresSafeArea())
            } else {
                LoginView(
                    onAuthenticatedUser: { userId in
                        // PIN feedback has already completed. Start the shell now;
                        // the opacity handoff adds no extra pre-login hold.
                        withAnimation(.easeInOut(duration: DesignV2.Motion.state)) {
                            appConfig.didLogin(authenticatedUserId: userId)
                        }
                    },
                    onConnect: {},
                    onInitialUsersResolved: { startup.rootDidResolve() },
                    onOpenBackendSetup: { showSetupOverride = true },
                    isRevealed: loginRevealed
                )
                .allowsHitTesting(!appConfig.hasToken)
                .transition(.opacity)
                .zIndex(2)
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
            if !appConfig.isConfigured {
                startup.rootDidResolve()
            } else if appConfig.startupAuthentication == .validating {
                await validateStoredAuthentication()
            }
            // Login resolves after its initial user-list terminal result.
        }
        .task(id: appConfig.hasToken) {
            if !appConfig.hasToken {
                push.configureForLoggedOutCleanup(appConfig: appConfig)
            }
        }
        .task(id: startup.isCovering) {
            loginRevealed = false
            guard !startup.isCovering else { return }
            do {
                // Don't spend the landing animation underneath the splash fade.
                try await Task.sleep(for: .seconds(SplashLayout.fadeOut))
                try Task.checkCancellation()
                loginRevealed = true
            } catch { /* The next startup generation owns its own reveal. */ }
        }
        .onChange(of: startup.isCovering) { _, covering in
            if !covering { log.info("startup.reveal") }
        }
        .alert(
            "Notifications may continue",
            isPresented: Binding(
                get: { push.lifecycleWarning != nil && !appConfig.hasToken },
                set: { if !$0 { push.dismissLifecycleWarning() } }
            )
        ) {
            Button("OK") { push.dismissLifecycleWarning() }
        } message: {
            Text(push.lifecycleWarning ?? "This device could not be unlinked yet.")
        }
    }

    private func validateStoredAuthentication() async {
        let result = await appConfig.validateStartupAuthentication(
            beforeInvalidation: { accountFence in push.navigation.bindPending(to: accountFence) },
            beforeAccountChange: { push.navigation.clear() }
        )
        if result != .login { startup.rootDidResolve() }
    }
}
