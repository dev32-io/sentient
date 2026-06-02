// ---------------------------------------------------------------------------
// SdkStore — the ObservableObject bridge from the KMP SDK to SwiftUI.
//
// The SDK owns the ONE observable surface (StateFlow<SdkState>); this store
// re-publishes it verbatim (no re-derivation, per the SDK's single-surface
// contract) and forwards user commands. It mirrors the Android SdkViewModel
// role — a thin consumer that collects the StateFlow and exposes typed actions.
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

@MainActor
final class SdkStore: ObservableObject {
    /// THE single observable surface, re-published verbatim for SwiftUI to read.
    @Published private(set) var state: SdkState

    private let sdk: SentientSdk
    /// The same Keychain-backed store login writes to (`createTokenStore()`).
    /// Held here so `logout()` can clear the token the SDK reads on connect —
    /// clearing it is what makes a relaunch land on login (no auto-resume).
    private let tokenStore: SecureTokenStore
    private let log = AppLog("sdk", "store")
    private var collectTask: Task<Void, Never>?

    /// Build the store over the process SDK. The SDK is constructed via the
    /// iOS factory (createSentientSdk) which supplies the platform bundle +
    /// coroutine scope internally — Swift only provides the SdkConfig. The
    /// token store defaults to the same `createTokenStore()` Keychain item the
    /// login flow saves to (AuthModel), so logout clears the credential the SDK
    /// reads on connect.
    init(
        sdk: SentientSdk = SdkStore.makeSdk(),
        tokenStore: SecureTokenStore = createTokenStore()
    ) {
        self.sdk = sdk
        self.tokenStore = tokenStore
        self.state = sdk.state.value
        log.info("init status=\(self.state.status.name)")
        startCollecting()
    }

    deinit { collectTask?.cancel() }

    // ── State collection ──────────────────────────────────────────────────────

    /// Drain the SDK's StateFlow (SKIE AsyncSequence) into `@Published state`.
    private func startCollecting() {
        collectTask = Task { [weak self] in
            guard let self else { return }
            for await next in self.sdk.state {
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
        log.info("connect")
        Task { [weak self] in
            do { try await self?.sdk.connect() } catch { self?.log.error("connect failed: \(error)") }
        }
    }

    func disconnect() {
        log.info("disconnect")
        sdk.disconnect()
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
        sdk.disconnect()
        tokenStore.clear()
        log.info("logout.done")
    }

    func sendText(_ text: String) {
        log.info("sendText len=\(text.count)")
        sdk.sendText(text: text)
    }

    func interrupt() {
        log.info("interrupt")
        sdk.interrupt()
    }

    func startMic() {
        log.info("startMic")
        sdk.startMic()
    }

    func stopMic() {
        log.info("stopMic")
        sdk.stopMic()
    }

    func setTtsEnabled(_ enabled: Bool) {
        log.info("setTtsEnabled enabled=\(enabled)")
        Task { [weak self] in
            do {
                try await self?.sdk.setTtsEnabled(enabled: enabled)
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
        log.info("listSessions limit=\(limit) offset=\(offset)")
        return try await sdk.listSessions(limit: limit, offset: offset)
    }

    /// Switch to a session; awaits the session.switched broadcast inside the SDK.
    func switchSession(_ sessionId: String) async throws {
        log.info("switchSession sessionId=\(sessionId)")
        try await sdk.switchSession(sessionId: sessionId)
    }

    /// Start a fresh chat; awaits the session.created broadcast inside the SDK.
    func newChat() async throws {
        log.info("newChat")
        try await sdk.doNewChat()
    }

    func deleteSession(_ id: String) async throws {
        log.info("deleteSession id=\(id)")
        try await sdk.deleteSession(id: id)
    }

    func renameSession(_ id: String, title: String) async throws {
        log.info("renameSession id=\(id)")
        try await sdk.renameSession(id: id, title: title)
    }

    // ── SDK construction ─────────────────────────────────────────────────────────

    /// Build the one SDK via the iOS factory. iOS sim reaches the host gateway
    /// over `localhost` (Android uses 10.0.2.2 — emulator-only). The self-signed
    /// dev TLS bypass is debug-only. The factory assembles SdkConfig (and the
    /// default ReconnectConfig) in Kotlin, since those defaults don't survive the
    /// ObjC/SKIE bridge. Capabilities are left empty: the orchestrator merges
    /// every connector's own capability into session.configure (web-sdk / Android
    /// parity).
    nonisolated static func makeSdk() -> SentientSdk {
        createSentientSdk(
            gatewayWsUrl: gatewayWsUrl,
            allowSelfSignedDevHost: allowSelfSignedDevHost,
            capabilities: []
        )
    }

    /// Gateway WS endpoint. iOS simulator shares the host loopback, so localhost
    /// reaches the dev gateway directly.
    nonisolated private static let gatewayWsUrl = "wss://localhost:8888/api/v1/ws"

    /// Trust the self-signed dev cert only in debug builds; release must verify.
    nonisolated private static var allowSelfSignedDevHost: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
}
