// ---------------------------------------------------------------------------
// AppConfig — app-scoped configuration and auth store. Replaces the SdkStore
// singleton's non-SDK responsibilities. Holds backend resolution, token store,
// display-name store, and the isConfigured/configGeneration gates that drive
// RootView routing and splash animation.
//
// NO SentientSdk here — the SDK is User/Connection-scoped and lives inside
// UserSession (built once at the authed root, torn down on logout). AppConfig
// survives the process lifetime; the SDK does not.
//
// Backend resolution (override → build-time default → unconfigured) is
// evaluated once at init and again in reconfigure(). reconfigure() saves the
// new config, clears the token, and bumps configGeneration (the splash
// trigger). The User session that was running is torn down when the authed
// branch exits (hasToken=false → UserSessionHost leaves the tree).
//
// hasToken — the reactive nav gate for RootView. It requires the token, display
// name, and explicit server-authenticated userId retained at login; the display
// name is presentation-only and never supplies the calendar identity. A WS drop
// does NOT clear it, so a drop keeps the user on chat WITH the connection-lost banner.
//
// logout() clears the token, display name, and authenticated identity. The UserSession teardown is
// driven separately by UserSessionHost.logout() (userSession.shutdown()); the
// hasToken=false flip is what makes RootView recompose to the login screen.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

/// Neutral display-name fallback before login persists a real name.
private let defaultDisplayName = "You"

@MainActor
final class AppConfig: ObservableObject {
    /// True when a backend URL is resolvable (override or build-time default).
    /// RootView gates all SDK operations and navigation on this flag.
    @Published private(set) var isConfigured: Bool

    /// Bumped each time the backend is (re)configured. RootView's .task(id:)
    /// observes this to re-show the splash on every backend swap.
    @Published private(set) var configGeneration: Int = 0

    /// True when the token, display name, and explicit authenticated userId are
    /// persisted. The reactive login-vs-chat gate for RootView.
    @Published private(set) var hasToken: Bool

    private let configStore = BackendConfigStore()
    let tokenStore: SecureTokenStore
    let displayNameStore: DisplayNameStore
    /// Explicit server-authenticated identity used to build the calendar namespace.
    /// This is not derived from the display name or token contents.
    private let identityStore: AuthenticatedIdentityStore
    private let log = AppLog("app", "config")

    // ── Resolved backend (kept for session construction) ─────────────────────

    private(set) var gatewayWsUrl: String = ""
    private(set) var allowSelfSignedDevHost: Bool = false

    init(
        tokenStore: SecureTokenStore = createTokenStore(),
        displayNameStore: DisplayNameStore = DisplayNameStore(),
        identityStore: AuthenticatedIdentityStore = AuthenticatedIdentityStore()
    ) {
        self.tokenStore = tokenStore
        self.displayNameStore = displayNameStore
        self.identityStore = identityStore

        // Resolve backend from persisted override → build-time default.
        switch Self.resolve(BackendConfigStore()) {
        case .configured(let url, let trust):
            self.isConfigured = true
            self.gatewayWsUrl = url
            self.allowSelfSignedDevHost = trust
            log.info("init configured")
        case .unconfigured:
            self.isConfigured = false
            log.info("init unconfigured")
        }

        // A persisted token without the explicit authenticated identity cannot
        // safely open a calendar namespace. Fail closed and require login again.
        let hasStoredSession = tokenStore.load() != nil &&
            displayNameStore.load() != nil &&
            identityStore.load() != nil
        self.hasToken = hasStoredSession
        if !hasStoredSession {
            tokenStore.clear()
            displayNameStore.clear()
            identityStore.clear()
        }
        if isConfigured { configGeneration += 1 }
    }

    // ── Backend resolution ────────────────────────────────────────────────────

    private static func resolve(_ store: BackendConfigStore) -> ResolvedBackend {
        resolveBackend(
            override: store.load(),
            buildTimeDefaultURL: GatewayConfig.buildTimeDefaultWsURL,
            buildTimeAllowSelfSigned: GatewayConfig.buildTimeAllowSelfSigned
        )
    }

    /// Hot-swap the backend: saves config, clears token (force re-login on new
    /// backend), bumps configGeneration to re-show the splash. The in-flight
    /// session is torn down by ChatView's disappear path, not here.
    func reconfigure(_ config: BackendConfig) {
        log.info("reconfigure host=\(config.host) port=\(config.port)")
        configStore.save(config)
        tokenStore.clear()
        displayNameStore.clear()
        identityStore.clear()
        gatewayWsUrl = config.gatewayWsURL
        allowSelfSignedDevHost = config.allowSelfSigned
        isConfigured = true
        hasToken = false
        configGeneration += 1
        log.info("reconfigure done generation=\(configGeneration)")
    }

    // ── Auth ──────────────────────────────────────────────────────────────────

    /// Mark a successful login with the server-authenticated identity. The
    /// identity is persisted before the authenticated root mounts, so every
    /// IosUserSession receives it explicitly.
    func didLogin(authenticatedUserId: String) {
        identityStore.save(authenticatedUserId)
        hasToken = tokenStore.load() != nil &&
            displayNameStore.load() != nil &&
            identityStore.load() != nil
        log.info("didLogin hasToken=\(hasToken)")
    }

    /// The current explicit server identity, or nil when the auth boundary is
    /// not safe to construct.
    var authenticatedUserId: String? { identityStore.load() }

    /// Clear token and display name (nav to login is event-driven in RootView).
    func logout() {
        log.info("logout")
        tokenStore.clear()
        displayNameStore.clear()
        identityStore.clear()
        hasToken = false
    }

    // ── Display name ──────────────────────────────────────────────────────────

    /// The logged-in user's display name for chat / history headers.
    var displayName: String { displayNameStore.load() ?? defaultDisplayName }
}
