// ---------------------------------------------------------------------------
// UserSession — the User/Connection scope (held as @StateObject at the authed
// root). Swift mirror of Android's UserSessionManager.
//
// Owns ONE KMP IosUserSession (SDK + ChatComponent + session scope), built once
// when the user is authed and surviving navigation: switching conversation,
// opening history, opening settings never drop the socket because the SDK lives
// HERE, above the NavigationStack. init() background-connects (open()); shutdown()
// (logout) tears it down.
//
// makeChatVM(sessionId:) builds a THIN per-conversation ChatViewModel over the
// shared ChatComponent — the route-keyed root ChatView (.id(activeSessionId))
// asks for a fresh VM each time the active conversation changes, the SwiftUI
// analogue of Android's route-recreates-VM.
//
// Presence: pause() KEEPS the socket on background (the gateway holds the session);
// resume() routes foreground engagement to component.ensureConnected() (probe/reconnect).
// The owning view drives these from scenePhase
// with a cold-start-skip (init already connected).
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
final class SessionConnectivityRecoveryFence {
    private var active = true

    func forwardPathChange(
        recovered: Bool,
        onChange: () -> Void,
        onRecovery: () -> Void
    ) {
        guard active else { return }
        onChange()
        if recovered { onRecovery() }
    }

    func close() { active = false }
}

@MainActor
final class UserSession: ObservableObject {
    /// The KMP User-scope holder: SDK + ChatComponent + session scope.
    private let inner: IosUserSession
    private let log = AppLog("user-session")
    /// Persistent network-path observer: a path change (VPN→WiFi, etc.) re-checks the
    /// socket so a queued send is never stranded on a dead-but-"READY" connection.
    private var networkMonitor: (any NetworkPathMonitoring)?
    private let calendarRecoveryFence = SessionConnectivityRecoveryFence()

    /// The shared usecase layer for this login. Chat + history VMs resolve their
    /// usecases / passthroughs from here — never the SDK directly.
    var component: ChatComponent { inner.component }

    /// The settings slice of this connection scope (built beside `component` inside
    /// the KMP `IosUserSession`). Per-screen settings ViewModels resolve their
    /// usecases from here — never the SDK or a repository directly.
    var settings: SettingsComponent { inner.settings }

    /// One session-owned calendar experience. Route recreation never rebuilds
    /// this object because it is held above the authenticated NavigationStack.
    @Published private(set) var calendarExperience: CalendarExperience?

    /// Typed fail-closed state for protected calendar storage/open failures.
    @Published private(set) var calendarAvailability: IosCalendarAvailability

    /// Namespace is derived from the explicit authenticated userId and backend
    /// identity; it is not derived from display name or token text.
    @Published private(set) var calendarNamespace: CalendarCacheNamespace?

    private var calendarLifecycleTask: Task<Void, Never>?

    /// Awaits background calendar open/disposal without blocking MainActor and
    /// publishes the typed result back to this MainActor-owned object.
    func awaitCalendarLifecycle() async {
        do {
            try await inner.awaitCalendarLifecycle()
        } catch {
            log.warn("calendar.lifecycle-await code=background-failure")
        }
        guard !Task.isCancelled else { return }
        calendarAvailability = inner.calendarAvailability
        calendarExperience = inner.calendarExperience
        calendarNamespace = inner.calendarNamespace
    }

    /// Build the User session from a resolved backend (gateway URL + dev-TLS
    /// posture). FaultHooks are armed in debug builds (no adb-equivalent arming
    /// channel on iOS yet — fault flows stay Android-only; see ios-testing rule).
    ///
    /// `onLoggedOut` is the settings Account-logout hook (KMP `AccountUseCases`
    /// clears local session via it). Bound by the host to the AppConfig.logout path;
    /// it is `@MainActor` (AppConfig is main-actor state) and the KMP scope may invoke
    /// it off the main thread, so it is hopped onto the main actor here.
    init(
        gatewayWsUrl: String,
        allowSelfSignedDevHost: Bool,
        authenticatedUserId: String,
        onLoggedOut: @escaping @MainActor () -> Void = {},
        networkMonitorFactory: NetworkPathMonitorFactory = .live,
        calendarRecoverySignal: @escaping (CalendarExperience) -> Void = {
            _ = $0.onConnectivityRecovered()
        }
    ) {
        // AccountUseCases can invoke this callback without the explicit root
        // logout button. Close the same session before clearing auth state so a
        // successor login cannot race the predecessor's namespace purge.
        var closeSession: (() -> Void)?
        self.inner = createUserSession(
            gatewayWsUrl: gatewayWsUrl,
            allowSelfSignedDevHost: allowSelfSignedDevHost,
            authenticatedUserId: authenticatedUserId,
            capabilities: [],
            devFaultsEnabled: {
                #if DEBUG
                return true
                #else
                return false
                #endif
            }(),
            onLoggedOut: {
                Task { @MainActor in
                    closeSession?()
                    onLoggedOut()
                }
            }
        )
        self.calendarAvailability = inner.calendarAvailability
        self.calendarExperience = inner.calendarExperience
        self.calendarNamespace = inner.calendarNamespace
        log.info("init — open")
        // Background connect: the chat UI is usable immediately; reconnect is the SDK's.
        inner.open()
        // Verify chat on each real path transition. Only unavailable→available
        // forwards the shared calendar recovery intent; shared KMP owns policy.
        let monitor = networkMonitorFactory.make { [weak self] recovered in
            Task { @MainActor in
                guard let self else { return }
                self.calendarRecoveryFence.forwardPathChange(
                    recovered: recovered,
                    onChange: {
                        self.log.info("network-changed → ensureConnected")
                        self.component.ensureConnected()
                    },
                    onRecovery: {
                        guard let experience = self.calendarExperience else { return }
                        calendarRecoverySignal(experience)
                    }
                )
            }
        }
        monitor.start()
        self.networkMonitor = monitor
        self.calendarLifecycleTask = Task { [weak self] in
            await self?.awaitCalendarLifecycle()
        }
        closeSession = { [weak self] in self?.shutdown() }
    }

    /// Build a thin per-conversation ChatViewModel over the shared ChatComponent.
    /// Called by the route-keyed root ChatView; a new VM per active conversation.
    func makeChatVM(sessionId: String?) -> ChatViewModel {
        log.info("makeChatVM sessionId=\(sessionId ?? "<new>")")
        return ChatViewModel(component: component, sessionId: sessionId)
    }

    /// Build the history VM over the shared ChatComponent (reads + rename/delete).
    func makeHistoryVM() -> HistoryViewModel {
        HistoryViewModel(component: component)
    }

    // ── Presence (scenePhase) ───────────────────────────────────────────────────

    /// App background → drop the socket but stay in session.
    func pause() {
        log.info("pause")
        inner.pause()
    }

    /// App foreground → engagement-driven connectivity check. ensureConnected is the
    /// single engagement entry (READY → one liveness probe; not-READY → reconnect),
    /// routed through the component per the iOS layering (UI reaches the component,
    /// not the SDK). The cold-start-skip lives in UserSessionHost, so this only fires
    /// after a real background.
    func resume() {
        log.info("resume")
        component.ensureConnected()
    }

    // ── Teardown ────────────────────────────────────────────────────────────────

    /// Compatibility teardown used when the authenticated host is released.
    func shutdown() { closeCalendarBoundary(using: inner.close) }

    /// Explicit root/settings logout production entry point.
    func explicitLogout() { closeCalendarBoundary(using: inner.explicitLogout) }

    /// Terminal authentication failure production entry point.
    func authenticationExpired() { closeCalendarBoundary(using: inner.authenticationExpired) }

    /// Account replacement production entry point before a successor host is created.
    func accountReplaced() { closeCalendarBoundary(using: inner.accountReplaced) }

    /// Backend replacement production entry point before a successor host is created.
    func backendReplaced() { closeCalendarBoundary(using: inner.backendReplaced) }

    private func closeCalendarBoundary(using close: () -> Void) {
        log.info("shutdown")
        calendarLifecycleTask?.cancel()
        calendarLifecycleTask = nil
        calendarRecoveryFence.close()
        networkMonitor?.cancel()
        networkMonitor = nil
        close()
        calendarAvailability = inner.calendarAvailability
        calendarExperience = inner.calendarExperience
        calendarNamespace = inner.calendarNamespace
    }

    /// Auth-expiry/account callbacks can remove the host from the SwiftUI tree
    /// without first reaching the explicit logout button. Keep the KMP boundary
    /// fail-closed if that is the final owner release.
    deinit {
        calendarLifecycleTask?.cancel()
        networkMonitor?.cancel()
        inner.close()
    }
}
