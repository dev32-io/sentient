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
// hasToken — the reactive nav gate for RootView (mirrors Android's displayName
// != null guard). The display name is saved at login and cleared at logout,
// acting as a reactive proxy for token presence. A WS drop does NOT clear it,
// so a drop keeps the user on chat WITH the connection-lost banner.
//
// logout() clears only the token and display name. The UserSession teardown is
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

    /// True when a login token + display name are persisted. The reactive nav
    /// gate for login-vs-chat in RootView; mirrors Android's displayName != null.
    @Published private(set) var hasToken: Bool

    private let configStore = BackendConfigStore()
    let tokenStore: SecureTokenStore
    let displayNameStore: DisplayNameStore
    private let log = AppLog("app", "config")

    // ── Resolved backend (kept for session construction) ─────────────────────

    private(set) var gatewayWsUrl: String = ""
    private(set) var allowSelfSignedDevHost: Bool = false

    init(
        tokenStore: SecureTokenStore = createTokenStore(),
        displayNameStore: DisplayNameStore = DisplayNameStore()
    ) {
        self.tokenStore = tokenStore
        self.displayNameStore = displayNameStore

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

        // hasToken: present when display name is stored (cleared on logout).
        self.hasToken = displayNameStore.load() != nil
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
        gatewayWsUrl = config.gatewayWsURL
        allowSelfSignedDevHost = config.allowSelfSigned
        isConfigured = true
        hasToken = false
        configGeneration += 1
        log.info("reconfigure done generation=\(configGeneration)")
    }

    // ── Auth ──────────────────────────────────────────────────────────────────

    /// Mark a successful login: update the reactive hasToken gate so RootView
    /// transitions to the chat screen. The token itself is written by AuthViewModel
    /// directly to tokenStore before calling this; we just need to flip the gate.
    func didLogin() {
        hasToken = displayNameStore.load() != nil
        log.info("didLogin hasToken=\(hasToken) name=\(displayName)")
    }

    /// Clear token and display name (nav to login is event-driven in RootView).
    func logout() {
        log.info("logout")
        tokenStore.clear()
        displayNameStore.clear()
        hasToken = false
    }

    // ── Display name ──────────────────────────────────────────────────────────

    /// The logged-in user's display name for chat / history headers.
    var displayName: String { displayNameStore.load() ?? defaultDisplayName }
}
