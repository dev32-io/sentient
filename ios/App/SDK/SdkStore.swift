// ---------------------------------------------------------------------------
// SdkStore — the ObservableObject bridge from the KMP SDK to SwiftUI.
//
// The SDK owns the ONE observable surface (StateFlow<SdkState>); this store
// re-publishes it verbatim (no re-derivation, per the SDK's single-surface
// contract) and forwards user commands. It mirrors the Android SdkViewModel
// role — a thin consumer that collects the StateFlow and exposes typed actions.
//
// Backend resolution (override → build-time default → unconfigured):
//   - On .configured: SDK is built immediately; collection starts.
//   - On .unconfigured: sdk is nil, isConfigured = false. RootView forces the
//     setup page; no SDK methods are reachable until reconfigure() is called.
//
// reconfigure(_:) hot-swaps the backend: saves the new config, tears down the
// old SDK (if any), builds and wires the new one. Called by the setup flow.
//
// StateFlow consumption (SKIE): SKIE bridges the Kotlin StateFlow to a Swift
// AsyncSequence, so `for await s in sdk.state` delivers every emission. The
// store seeds `@Published state` from `sdk.state.value` (SKIE exposes the
// current value synchronously) so SwiftUI renders the real status on first
// frame instead of a default. Suspend SDK ops bridge to Swift `async throws`;
// fire-and-forget ops (sendText/interrupt/mic toggles) are plain calls — the
// SDK launches their own work on its own scope internally.
//
// @MainActor: all @Published mutation happens on the main actor; the collection
// loop hops back to main before assigning.
// ---------------------------------------------------------------------------
import Foundation
import MobileSdk

enum SdkStoreError: Error {
    case notConfigured
}

@MainActor
final class SdkStore: ObservableObject {
    /// THE single observable surface, re-published verbatim for SwiftUI to read.
    /// Non-optional; seeded from the real SDK on configure, or a DISCONNECTED
    /// placeholder when unconfigured (RootView never reads it unconfigured).
    @Published private(set) var state: SdkState

    /// True when the SDK is built and ready for use. RootView gates all SDK
    /// operations and navigation on this flag; `state` is undefined-but-present
    /// when false.
    @Published private(set) var isConfigured: Bool

    private var sdk: SentientSdk?
    private let configStore = BackendConfigStore()
    /// The same Keychain-backed store login writes to (`createTokenStore()`).
    /// Held here so `logout()` can clear the token the SDK reads on connect —
    /// clearing it is what makes a relaunch land on login (no auto-resume).
    private let tokenStore: SecureTokenStore
    private let log = AppLog("sdk", "store")
    private var collectTask: Task<Void, Never>?

    /// Build the store. Resolves the backend from BackendConfigStore → build-time
    /// default → unconfigured. On .configured, the SDK is built immediately and
    /// collection starts. On .unconfigured, `isConfigured = false`; call
    /// `reconfigure(_:)` from the setup flow.
    init(tokenStore: SecureTokenStore = createTokenStore()) {
        self.tokenStore = tokenStore
        switch Self.resolve(configStore) {
        case .configured(let url, let trust):
            let s = createSentientSdk(gatewayWsUrl: url, allowSelfSignedDevHost: trust, capabilities: [])
            self.sdk = s
            self.state = s.state.value
            self.isConfigured = true
            log.info("init configured status=\(s.state.value.status.name)")
        case .unconfigured:
            self.sdk = nil
            // SKIE does not bridge the Kotlin default-arg initializer as SdkState().
            // Construct an explicit DISCONNECTED placeholder; value is never read while
            // isConfigured == false (RootView gates on isConfigured first).
            self.state = SdkState(
                status: .disconnected,
                messages: [],
                transcript: "",
                cognition: .idle,
                voiceMode: .off,
                prefs: AudioPreferences.companion.DEFAULT,
                tasks: [],
                isSpeaking: false,
                audioState: .inactive,
                connectionLost: false,
                authExpired: false,
                lastCycleError: false
            )
            self.isConfigured = false
            log.info("init unconfigured — awaiting setup")
        }
        if isConfigured { startCollecting() }
    }

    deinit { collectTask?.cancel() }

    // ── Backend resolution ────────────────────────────────────────────────────

    private static func resolve(_ store: BackendConfigStore) -> ResolvedBackend {
        resolveBackend(
            override: store.load(),
            buildTimeDefaultURL: GatewayConfig.buildTimeDefaultWsURL,
            buildTimeAllowSelfSigned: GatewayConfig.buildTimeAllowSelfSigned
        )
    }

    /// Hot-swap the backend: saves config, tears down the old SDK, builds and
    /// wires a new one. Called by the setup/settings flow after the user enters
    /// (or changes) a backend address. Triggers reconnect on the new backend.
    func reconfigure(_ config: BackendConfig) {
        log.info("reconfigure host=\(config.host) port=\(config.port) security=\(config.security.rawValue)")
        configStore.save(config)
        tokenStore.clear()
        collectTask?.cancel()
        sdk?.disconnect()
        let s = createSentientSdk(
            gatewayWsUrl: config.gatewayWsURL,
            allowSelfSignedDevHost: config.allowSelfSigned,
            capabilities: []
        )
        sdk = s
        state = s.state.value
        isConfigured = true
        startCollecting()
        log.info("reconfigure done status=\(s.state.value.status.name)")
    }

    // ── State collection ──────────────────────────────────────────────────────

    /// Drain the SDK's StateFlow (SKIE AsyncSequence) into `@Published state`.
    private func startCollecting() {
        guard let sdk else { return }
        collectTask = Task { [weak self] in
            guard let self else { return }
            for await next in sdk.state {
                self.apply(next)
            }
        }
    }

    private func apply(_ next: SdkState) {
        if next.status != state.status {
            log.info("status \(state.status.name) -> \(next.status.name)")
        }
        state = next
    }

    // ── User commands ──────────────────────────────────────────────────────────

    func connect() {
        guard let sdk else { return }
        log.info("connect")
        Task { [weak self] in
            do { try await sdk.connect() } catch { self?.log.error("connect failed: \(error)") }
        }
    }

    func disconnect() {
        guard let sdk else { return }
        log.info("disconnect")
        sdk.disconnect()
    }

    /// Manual reconnect (web-sdk parity, sentient-sdk.ts forceReconnect()). Re-arms
    /// the reconnect controller, clears the terminal connectionLost/authExpired
    /// flags, and drives a fresh recovery loop. Wired to the connection-lost
    /// banner's tap-to-reconnect CTA. Idempotent — a no-op while a loop is already
    /// in flight (status RECONNECTING).
    func forceReconnect() {
        guard let sdk else { return }
        log.info("forceReconnect status=\(state.status.name)")
        sdk.forceReconnect()
    }

    /// Logs the user out: disconnect (WS teardown + cycle cancel) THEN clear the
    /// persisted token. Inverse of login (`save(token:)` → `connect()`), so we
    /// disconnect first — the SDK can't read a half-cleared store mid-teardown.
    /// Clearing the token is what prevents auto-resume on relaunch. Navigation
    /// back to login is NOT modelled here: RootView derives login-vs-chat from
    /// the SDK's single state surface (status != .ready ⇒ login), and disconnect
    /// drives status away from .ready. Mirrors Android SettingsViewModel.logout().
    /// Idempotent — both calls are safe when already logged out.
    func logout() {
        log.info("logout.start")
        sdk?.disconnect()
        tokenStore.clear()
        log.info("logout.done")
    }

    func sendText(_ text: String) {
        guard let sdk else { return }
        log.info("sendText len=\(text.count)")
        sdk.sendText(text: text)
    }

    func interrupt() {
        guard let sdk else { return }
        log.info("interrupt")
        sdk.interrupt()
    }

    func startMic() {
        guard let sdk else { return }
        log.info("startMic")
        sdk.startMic()
    }

    func stopMic() {
        guard let sdk else { return }
        log.info("stopMic")
        sdk.stopMic()
    }

    func setTtsEnabled(_ enabled: Bool) {
        guard let sdk else { return }
        log.info("setTtsEnabled enabled=\(enabled)")
        Task { [weak self] in
            do {
                try await sdk.setTtsEnabled(enabled: enabled)
            } catch {
                self?.log.error("setTtsEnabled failed: \(error)")
            }
        }
    }

    // ── Session ops ──────────────────────────────────────────────────────────────
    //
    // Async passthroughs to the SDK's SessionsConnector surface (SKIE bridges the
    // Kotlin `suspend` funcs to Swift `async throws`; `newChat` is exposed as
    // `doNewChat`). The HistoryModel awaits these and re-queries `listSessions`
    // after each mutation — the SDK does NOT surface onSessionsChanged through
    // SentientSdk, so the open + post-mutation re-query is the refresh path.

    /// Page the session list. Returns a SessionsListPage (items + total + hasMore).
    func listSessions(limit: Int32, offset: Int32) async throws -> SessionsListPage {
        guard let sdk else { throw SdkStoreError.notConfigured }
        log.info("listSessions limit=\(limit) offset=\(offset)")
        return try await sdk.listSessions(limit: limit, offset: offset)
    }

    /// Switch to a session; awaits the session.switched broadcast inside the SDK.
    func switchSession(_ sessionId: String) async throws {
        guard let sdk else { throw SdkStoreError.notConfigured }
        log.info("switchSession sessionId=\(sessionId)")
        try await sdk.switchSession(sessionId: sessionId)
    }

    /// Start a fresh chat; awaits the session.created broadcast inside the SDK.
    func newChat() async throws {
        guard let sdk else { throw SdkStoreError.notConfigured }
        log.info("newChat")
        try await sdk.doNewChat()
    }

    func deleteSession(_ id: String) async throws {
        guard let sdk else { throw SdkStoreError.notConfigured }
        log.info("deleteSession id=\(id)")
        try await sdk.deleteSession(id: id)
    }

    func renameSession(_ id: String, title: String) async throws {
        guard let sdk else { throw SdkStoreError.notConfigured }
        log.info("renameSession id=\(id)")
        try await sdk.renameSession(id: id, title: title)
    }
}
