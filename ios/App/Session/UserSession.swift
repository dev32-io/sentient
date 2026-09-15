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
        available: Bool,
        recovered: Bool,
        onChange: () -> Void,
        onUnavailable: () -> Void,
        onRecovery: () -> Void
    ) {
        guard active else { return }
        onChange()
        if !available { onUnavailable() }
        if recovered { onRecovery() }
    }

    func close() { active = false }
}

@MainActor
final class SessionLogoutBoundary {
    private let prepare: (Bool) async -> Bool
    private let finalizePreparation: (Bool) -> Void
    private let clearAuth: () -> Void
    private let startRevoke: () -> Void
    private let preparationTimeout: Duration
    private var preparationTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var teardown: (() -> Void)?
    private var generation = 0
    private var hasStarted = false

    init(
        prepare: @escaping (Bool) async -> Bool,
        finalizePreparation: @escaping (Bool) -> Void = { _ in },
        clearAuth: @escaping () -> Void,
        startRevoke: @escaping () -> Void,
        preparationTimeout: Duration = .seconds(10)
    ) {
        self.prepare = prepare
        self.finalizePreparation = finalizePreparation
        self.clearAuth = clearAuth
        self.startRevoke = startRevoke
        self.preparationTimeout = preparationTimeout
    }

    func run(preservingNavigation: Bool = false, teardown: @escaping () -> Void) {
        guard !hasStarted else { return }
        hasStarted = true
        generation &+= 1
        let operation = generation
        self.teardown = teardown
        let prepare = prepare
        preparationTask = Task { [weak self] in
            _ = await prepare(preservingNavigation)
            self?.finish(operation: operation, timedOut: false)
        }
        timeoutTask = Task { [weak self, preparationTimeout] in
            do {
                try await Task.sleep(for: preparationTimeout)
                self?.finish(operation: operation, timedOut: true)
            } catch {}
        }
    }

    private func finish(operation: Int, timedOut: Bool) {
        guard generation == operation, let teardown else { return }
        generation &+= 1
        preparationTask?.cancel()
        timeoutTask?.cancel()
        preparationTask = nil
        timeoutTask = nil
        self.teardown = nil
        finalizePreparation(timedOut)
        teardown()
        clearAuth()
        startRevoke()
    }
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
    private var logoutBoundary: SessionLogoutBoundary!

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
        calendarUnavailableSignal: @escaping (CalendarExperience) -> Void = {
            $0.onConnectivityUnavailable()
        },
        calendarRecoverySignal: @escaping (CalendarExperience) -> Void = {
            _ = $0.onConnectivityRecovered()
        }
    ) {
        // AccountUseCases may invoke this off-main. Route it through the same
        // serialized session-owned boundary as root and auth-expiry logout.
        var beginSettingsLogout: (() -> Void)?
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
                Task { @MainActor in beginSettingsLogout?() }
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
        let monitor = networkMonitorFactory.make { [weak self] available, recovered in
            Task { @MainActor in
                guard let self else { return }
                self.calendarRecoveryFence.forwardPathChange(
                    available: available,
                    recovered: recovered,
                    onChange: {
                        self.log.info("network-changed → ensureConnected")
                        self.component.ensureConnected()
                    },
                    onUnavailable: {
                        guard let experience = self.calendarExperience else { return }
                        calendarUnavailableSignal(experience)
                    },
                    onRecovery: {
                        NativePushCoordinator.shared.retryPendingUnlink()
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
        self.logoutBoundary = SessionLogoutBoundary(
            prepare: { preserving in
                await NativePushCoordinator.shared.prepareForLogout(
                    preservingNavigationFor: preserving ? "\(gatewayWsUrl)|\(authenticatedUserId)" : nil
                )
            },
            finalizePreparation: { NativePushCoordinator.shared.finalizeLogoutPreparation(timedOut: $0) },
            clearAuth: onLoggedOut,
            startRevoke: { NativePushCoordinator.shared.retryPendingUnlink() }
        )
        beginSettingsLogout = { [weak self] in self?.explicitLogout() }
    }

    /// Build a thin per-conversation ChatViewModel over the shared ChatComponent.
    /// Called by the route-keyed root ChatView; a new VM per active conversation.
    func makeChatVM(sessionId: String?, activateOnInit: Bool = true) -> ChatViewModel {
        log.info("makeChatVM sessionId=\(sessionId ?? "<new>")")
        return ChatViewModel(component: component, sessionId: sessionId, activateOnInit: activateOnInit)
    }

    /// Build the history VM over the shared ChatComponent (reads + rename/delete).
    func makeHistoryVM() -> HistoryViewModel {
        HistoryViewModel(component: component)
    }

    /// Activates through shared READY/reconnect handling. `.authorized` means
    /// matching `session.switched` arrived; gateway activation is ownership-authorized.
    func activateSession(_ sessionId: String) async -> NotificationSessionValidation {
        guard NotificationDestination(sessionId: sessionId) != nil else { return .unavailable }
        do {
            switch try await component.activateSession.invoke(sessionId: sessionId) {
            case .authorized: return .authorized
            case .unavailable: return .unavailable
            case .retryableFailure: return .retryableFailure
            }
        } catch is CancellationError {
            return .retryableFailure
        } catch {
            log.warn("session activation failed code=transport")
            return .retryableFailure
        }
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
    func explicitLogout() {
        calendarRecoveryFence.close()
        networkMonitor?.cancel()
        networkMonitor = nil
        logoutBoundary.run { [weak self, inner] in
            guard let self else { inner.explicitLogout(); return }
            self.closeCalendarBoundary(using: inner.explicitLogout)
        }
    }

    /// Terminal authentication failure production entry point.
    func authenticationExpired() {
        calendarRecoveryFence.close()
        networkMonitor?.cancel()
        networkMonitor = nil
        logoutBoundary.run(preservingNavigation: true) { [weak self, inner] in
            guard let self else { inner.authenticationExpired(); return }
            self.closeCalendarBoundary(using: inner.authenticationExpired)
        }
    }

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
