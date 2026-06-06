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
    /// A bounded external call (e.g. listSessions against the dashboard sidecar)
    /// exceeded its deadline — surfaced to the UI as an error affordance instead
    /// of an indefinite spinner (error-handling rule: timeout every external call).
    case timedOut
}

/// Shown as the user's name before login persists one, and as the absolute
/// fallback if the stored name is ever missing.
private let defaultDisplayName = "You"

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

    /// Monotonically increasing counter bumped each time the SDK is (re)built.
    /// RootView's .task(id:) observes this to re-show the splash on every build.
    @Published private(set) var configGeneration: Int = 0

    // internal: used by SdkStore+Sessions.swift and SdkStore+Commands.swift extensions
    var sdk: SentientSdk?
    private let configStore = BackendConfigStore()
    /// The same Keychain-backed store login writes to (`createTokenStore()`).
    /// Held here so `logout()` can clear the token the SDK reads on connect —
    /// clearing it is what makes a relaunch land on login (no auto-resume).
    // internal: used by SdkStore+Commands.swift extension (logout)
    let tokenStore: SecureTokenStore
    /// The same UserDefaults store login writes the display name to. Held here so
    /// the chat / history headers can read the real name and `logout()` can clear
    /// it (no stale name on a logged-out relaunch).
    // internal: used by SdkStore+Commands.swift extension (logout)
    let displayNameStore: DisplayNameStore
    // internal: used by SdkStore+Sessions.swift and SdkStore+Commands.swift extensions
    let log = AppLog("sdk", "store")
    private var collectTask: Task<Void, Never>?
    /// Outbound-text queue: messages sent before READY are held here and
    /// flushed in order on the first rising edge to READY (web-sdk parity).
    private var sendQueue = SendQueueState()

    /// Build the store. Resolves the backend from BackendConfigStore → build-time
    /// default → unconfigured. On .configured, the SDK is built immediately and
    /// collection starts. On .unconfigured, `isConfigured = false`; call
    /// `reconfigure(_:)` from the setup flow.
    init(
        tokenStore: SecureTokenStore = createTokenStore(),
        displayNameStore: DisplayNameStore = DisplayNameStore()
    ) {
        self.tokenStore = tokenStore
        self.displayNameStore = displayNameStore
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
                hasSession: false,
                connectionLost: false,
                authExpired: false,
                lastCycleError: false
            )
            self.isConfigured = false
            log.info("init unconfigured — awaiting setup")
        }
        if isConfigured {
            startCollecting()
            configGeneration += 1
            log.info("init build complete generation=\(configGeneration)")
        }
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
        // Backend swap is a full teardown → land on the new backend's login.
        sdk?.disconnect(clearSession: true)
        let s = createSentientSdk(
            gatewayWsUrl: config.gatewayWsURL,
            allowSelfSignedDevHost: config.allowSelfSigned,
            capabilities: []
        )
        sdk = s
        state = s.state.value
        isConfigured = true
        startCollecting()
        configGeneration += 1
        log.info("reconfigure done status=\(s.state.value.status.name) generation=\(configGeneration)")
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
        let wasReady = state.status == .ready
        state = next
        let (drained, toFlush) = sendQueueOnStatus(sendQueue, ready: next.status == .ready, wasReady: wasReady)
        sendQueue = drained
        if !toFlush.isEmpty {
            log.info("sendQueue.flush count=\(toFlush.count)")
            toFlush.forEach { sdk?.sendText(text: $0) }
        }
    }

    // ── Send-queue commands ───────────────────────────────────────────────────
    // Connection, reconnect, mic, TTS, and logout commands live in SdkStore+Commands.swift.

    func sendText(_ text: String) {
        let ready = state.status == .ready
        let (next, toSend) = sendQueueOnSend(sendQueue, text: text, ready: ready)
        sendQueue = next
        if toSend.isEmpty {
            log.info("sendText.queued len=\(text.count) pendingCount=\(sendQueue.pending.count)")
        } else {
            guard let sdk else { return }
            log.info("sendText.sent len=\(text.count)")
            toSend.forEach { sdk.sendText(text: $0) }
        }
    }

    /// True when there are outbound messages queued, awaiting a READY transition.
    var hasPendingSends: Bool { !sendQueue.pending.isEmpty }

    /// The logged-in user's display name for chat / history headers, read from
    /// the same UserDefaults store login wrote at sign-in. Falls back to the
    /// neutral default only when nothing is stored (pre-login or post-logout).
    var displayName: String { displayNameStore.load() ?? defaultDisplayName }
}
