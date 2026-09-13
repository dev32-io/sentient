import Foundation
import MobileData
import UIKit
import UserNotifications

protocol NotificationPermissionProviding: AnyObject {
    func authorizationStatus() async -> UNAuthorizationStatus
    func requestAuthorization() async throws -> Bool
}

protocol RemoteNotificationRegistering: AnyObject {
    func register()
}

final class SystemRemoteNotificationRegistrar: RemoteNotificationRegistering {
    func register() { UIApplication.shared.registerForRemoteNotifications() }
}

final class SystemNotificationPermissionProvider: NotificationPermissionProviding {
    private let center: UNUserNotificationCenter
    init(center: UNUserNotificationCenter = .current()) { self.center = center }
    func authorizationStatus() async -> UNAuthorizationStatus { await center.notificationSettings().authorizationStatus }
    func requestAuthorization() async throws -> Bool {
        try await center.requestAuthorization(options: [.alert, .badge, .sound])
    }
}

enum NativePushPermission: Equatable { case unconfigured, notDetermined, denied, authorized, provisional, unavailable, error }

enum NativePushLifecycleResult { case success, failure }
enum NativePushLifecycleSnapshot {
    case linked(PushBinding, activationPending: Bool)
    case pendingUnlink
    case unlinked
}

@MainActor
protocol NativePushLifecycleClient: AnyObject {
    var state: NativePushLifecycleSnapshot { get }
    func unlink(ownerFence: String) async throws -> NativePushLifecycleResult
    func retryPendingUnlink() async throws -> NativePushLifecycleResult
    func reconcileActivation(ownerFence: String) async throws -> NativePushLifecycleResult
    func makeRegistration(deviceToken: String, replacing: PushBinding?) -> PushRegistrationRequest
    func register(ownerFence: String, request: PushRegistrationRequest) async throws -> PushBinding?
    func close()
}

@MainActor
final class KmpNativePushLifecycleClient: NativePushLifecycleClient {
    private let lifecycle: IosPushLifecycle
    init(_ lifecycle: IosPushLifecycle) { self.lifecycle = lifecycle }
    var state: NativePushLifecycleSnapshot {
        switch onEnum(of: lifecycle.coordinator.state.value) {
        case .linked(let linked): .linked(linked.binding, activationPending: linked.activationPending)
        case .pendingUnlink, .unlinkFailed: .pendingUnlink
        case .unlinked: .unlinked
        }
    }
    func unlink(ownerFence: String) async throws -> NativePushLifecycleResult {
        if case .success = onEnum(of: try await lifecycle.coordinator.unlink(ownerFence: ownerFence)) { return .success }
        return .failure
    }
    func retryPendingUnlink() async throws -> NativePushLifecycleResult {
        if case .success = onEnum(of: try await lifecycle.coordinator.retryPendingUnlink()) { return .success }
        return .failure
    }
    func reconcileActivation(ownerFence: String) async throws -> NativePushLifecycleResult {
        if case .success = onEnum(of: try await lifecycle.coordinator.reconcileActivation(ownerFence: ownerFence)) { return .success }
        return .failure
    }
    func makeRegistration(deviceToken: String, replacing: PushBinding?) -> PushRegistrationRequest {
        lifecycle.registrationRequests.create(
            idempotencyKey: "ios-token-\(UUID().uuidString)",
            apnsDeviceToken: deviceToken,
            replaces: replacing.map { PushBindingReference(bindingId: $0.bindingId, generation: $0.generation) }
        )
    }
    func register(ownerFence: String, request: PushRegistrationRequest) async throws -> PushBinding? {
        switch onEnum(of: try await lifecycle.coordinator.register(ownerFence: ownerFence, request: request)) {
        case .success(let success): success.value
        case .failure: nil
        }
    }
    func close() { lifecycle.close() }
}

struct NativePushAccountConfiguration {
    let fence: String
    let gatewayWsUrl: String
    let allowSelfSignedDevHost: Bool
    let token: () -> String
}

@MainActor
final class NativePushCoordinator: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NativePushCoordinator()

    @Published private(set) var permission: NativePushPermission = .unconfigured
    @Published private(set) var tokenAvailable = false
    @Published private(set) var registrationPending = false
    @Published private(set) var lifecycleWarning: String?
    @Published private(set) var binding: PushBinding?
    let navigation = PendingNotificationNavigation()

    private let permissions: NotificationPermissionProviding
    private let registrar: RemoteNotificationRegistering
    private var lifecycle: NativePushLifecycleClient?
    private let lifecycleFactory: @MainActor (NativePushAccountConfiguration) -> NativePushLifecycleClient
    private var ownerFence: String?
    private var deviceToken: String?
    private var registrationTask: Task<Void, Never>?
    private var accountTransitionTask: Task<Void, Never>?
    private var retryAfterAccountTransition = false
    private var transitionGeneration = 0
    private var pendingConfiguration: NativePushAccountConfiguration?
    private var pendingLogout = false
    private var pendingSettingsUnlink = false
    private let log = AppLog("push", "native")

    init(
        permissions: NotificationPermissionProviding = SystemNotificationPermissionProvider(),
        registrar: RemoteNotificationRegistering = SystemRemoteNotificationRegistrar(),
        lifecycleFactory: @escaping @MainActor (NativePushAccountConfiguration) -> NativePushLifecycleClient = { configuration in
            KmpNativePushLifecycleClient(createIosPushLifecycle(
                gatewayWsUrl: configuration.gatewayWsUrl,
                allowSelfSignedDevHost: configuration.allowSelfSignedDevHost,
                token: configuration.token
            ))
        }
    ) {
        self.permissions = permissions
        self.registrar = registrar
        self.lifecycleFactory = lifecycleFactory
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func configure(appConfig: AppConfig) {
        guard appConfig.isConfigured, let userId = appConfig.authenticatedUserId else {
            registrationTask?.cancel()
            pendingConfiguration = nil
            binding = nil
            registrationPending = false
            permission = .unconfigured
            // Do not close a lifecycle that may still be persisting/revoking the
            // exact old binding after immediate local logout.
            return
        }
        configure(account: NativePushAccountConfiguration(
            fence: "\(appConfig.gatewayWsUrl)|\(userId)",
            gatewayWsUrl: appConfig.gatewayWsUrl,
            allowSelfSignedDevHost: appConfig.allowSelfSignedDevHost,
            token: { appConfig.tokenStore.load() ?? "" }
        ))
    }

    func configure(account: NativePushAccountConfiguration) {
        guard ownerFence != account.fence else {
            if let lifecycle { applyLifecycleState(lifecycle.state) }
            Task { await refreshPermission() }
            return
        }
        if lifecycle != nil, ownerFence != nil {
            pendingConfiguration = account
            pendingLogout = false
            beginAccountTransition()
            return
        }
        installLifecycle(account)
    }

    func refreshPermission() async {
        // Observing an already-authorized OS setting is not consent to create a
        // new server binding. Only enable() initiates registration; otherwise a
        // user who disabled/unlinked push would be silently rebound on reload.
        permission = Self.map(await permissions.authorizationStatus())
    }

    /// Registration is user-initiated. Merely opening Settings never prompts.
    func enable() async {
        do {
            let granted = try await permissions.requestAuthorization()
            await refreshPermission()
            guard granted else { return }
            registrationPending = true
            registrar.register()
        } catch {
            permission = .error
            registrationPending = false
            log.warn("permission.failed")
        }
    }

    func didRegister(deviceToken data: Data) {
        deviceToken = data.map { String(format: "%02x", $0) }.joined()
        tokenAvailable = true
        registerCurrentToken()
    }

    func didFailRegistration() {
        tokenAvailable = false
        registrationPending = false
        permission = .error
        log.warn("registration.failed")
    }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    /// Unlinks this installation while retaining the authenticated lifecycle so
    /// a later explicit Enable can create a fresh binding in the same host.
    func unlinkFromSettings() {
        guard lifecycle != nil, ownerFence != nil else { return }
        pendingSettingsUnlink = true
        registrationTask?.cancel()
        registrationPending = false
        binding = nil
        if accountTransitionTask != nil {
            lifecycleWarning = "Notifications may continue until this device reconnects."
            return
        }
        beginAccountTransition(settingsUnlink: true)
    }

    /// Freezes revoke-only authority in shared secure storage before returning;
    /// local account teardown remains immediate and network completion is async.
    func unlinkForLogout() {
        navigation.clear()
        guard lifecycle != nil, ownerFence != nil else { return }
        // A replacement already queued by a newer authenticated host remains the
        // latest desired configuration. Otherwise this transition ends unlinked.
        pendingLogout = pendingConfiguration == nil
        registrationTask?.cancel()
        registrationPending = false
        binding = nil
        if accountTransitionTask != nil {
            lifecycleWarning = "Notifications may continue until this device reconnects."
            return
        }
        beginAccountTransition(logout: true)
    }

    func dismissLifecycleWarning() { lifecycleWarning = nil }

    func retryPendingUnlink() {
        guard let lifecycle else { return }
        guard accountTransitionTask == nil else {
            retryAfterAccountTransition = true
            return
        }
        transitionGeneration += 1
        let operation = transitionGeneration
        accountTransitionTask = Task {
            defer { finishAccountTransitionTask(operation: operation, lifecycle: lifecycle) }
            do {
                let result = try await lifecycle.retryPendingUnlink()
                guard !Task.isCancelled, self.transitionGeneration == operation, self.lifecycle === lifecycle else { return }
                if case .failure = result {
                    applyLifecycleState(lifecycle.state)
                    return
                }
                if pendingConfiguration != nil {
                    finishAccountTransition(after: lifecycle)
                    return
                }
                if pendingLogout {
                    closeTransitionLifecycle(lifecycle)
                    return
                }
                if pendingSettingsUnlink {
                    pendingSettingsUnlink = false
                    applyLifecycleState(lifecycle.state)
                    registerCurrentTokenIfRequested()
                    return
                }
                if let ownerFence {
                    _ = try await lifecycle.reconcileActivation(ownerFence: ownerFence)
                    guard !Task.isCancelled, self.transitionGeneration == operation, self.lifecycle === lifecycle else { return }
                }
                applyLifecycleState(lifecycle.state)
            } catch {
                guard self.transitionGeneration == operation, self.lifecycle === lifecycle else { return }
                lifecycleWarning = "Notification unlink is still pending."
            }
        }
    }

    func receive(url: URL) { if let destination = NotificationDestination(url: url) { navigation.receive(destination) } }
    func receive(userInfo: [AnyHashable: Any]) { if let destination = NotificationDestination(userInfo: userInfo) { navigation.receive(destination) } }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let destination = NotificationDestination(userInfo: response.notification.request.content.userInfo)
        await MainActor.run {
            if let destination { self.navigation.receive(destination) }
        }
    }

    private func installLifecycle(_ configuration: NativePushAccountConfiguration) {
        lifecycle = lifecycleFactory(configuration)
        ownerFence = configuration.fence
        pendingLogout = false
        if let lifecycle { applyLifecycleState(lifecycle.state) }
        Task { await refreshPermission() }
    }

    private func beginAccountTransition(logout: Bool = false, settingsUnlink: Bool = false) {
        guard accountTransitionTask == nil, let lifecycle, let ownerFence else { return }
        if logout, pendingConfiguration == nil { pendingLogout = true }
        if settingsUnlink { pendingSettingsUnlink = true }
        transitionGeneration += 1
        let operation = transitionGeneration
        registrationTask?.cancel()
        registrationPending = false
        binding = nil
        lifecycleWarning = logout
            ? "Notifications may continue until this device reconnects."
            : "Notification activation is waiting for the previous binding to be disabled."
        accountTransitionTask = Task {
            defer { finishAccountTransitionTask(operation: operation, lifecycle: lifecycle) }
            do {
                let result = try await lifecycle.unlink(ownerFence: ownerFence)
                guard !Task.isCancelled, self.transitionGeneration == operation, self.lifecycle === lifecycle else { return }
                switch result {
                case .success:
                    if pendingConfiguration != nil {
                        finishAccountTransition(after: lifecycle)
                    } else if pendingLogout {
                        closeTransitionLifecycle(lifecycle)
                    } else {
                        pendingSettingsUnlink = false
                        applyLifecycleState(lifecycle.state)
                        registerCurrentTokenIfRequested()
                    }
                case .failure: applyLifecycleState(lifecycle.state)
                }
            } catch {
                guard self.transitionGeneration == operation, self.lifecycle === lifecycle else { return }
                lifecycleWarning = "Notifications may continue until this device reconnects."
            }
        }
    }

    private func finishAccountTransitionTask(operation: Int, lifecycle: NativePushLifecycleClient) {
        guard transitionGeneration == operation else { return }
        accountTransitionTask = nil
        let retry = retryAfterAccountTransition
        retryAfterAccountTransition = false
        if retry, self.lifecycle === lifecycle, case .pendingUnlink = lifecycle.state {
            retryPendingUnlink()
        }
    }

    private func finishAccountTransition(after oldLifecycle: NativePushLifecycleClient) {
        guard lifecycle === oldLifecycle, let next = pendingConfiguration else { return }
        pendingConfiguration = nil
        pendingLogout = false
        pendingSettingsUnlink = false
        oldLifecycle.close()
        lifecycle = nil
        ownerFence = nil
        installLifecycle(next)
    }

    private func closeTransitionLifecycle(_ oldLifecycle: NativePushLifecycleClient) {
        guard lifecycle === oldLifecycle else { return }
        pendingLogout = false
        pendingSettingsUnlink = false
        oldLifecycle.close()
        lifecycle = nil
        ownerFence = nil
        lifecycleWarning = nil
    }

    private func registerCurrentTokenIfRequested() {
        guard registrationPending, deviceToken != nil else { return }
        registerCurrentToken()
    }

    private func registerCurrentToken() {
        guard accountTransitionTask == nil, !pendingSettingsUnlink,
              let lifecycle, let ownerFence, let deviceToken else { return }
        registrationTask?.cancel()
        registrationPending = true
        registrationTask = Task {
            defer { registrationPending = false }
            let request = lifecycle.makeRegistration(deviceToken: deviceToken, replacing: binding)
            do {
                let registered = try await lifecycle.register(ownerFence: ownerFence, request: request)
                guard !Task.isCancelled, self.lifecycle === lifecycle,
                      self.ownerFence == ownerFence, self.accountTransitionTask == nil else { return }
                if let registered {
                    binding = registered
                } else {
                    permission = .error
                }
            } catch is CancellationError {
            } catch {
                permission = .error
                log.warn("binding.failed")
            }
        }
    }

    private func applyLifecycleState(_ state: NativePushLifecycleSnapshot) {
        switch state {
        case .linked(let linked, let activationPending):
            binding = linked
            lifecycleWarning = activationPending ? "Notification activation is waiting for the previous binding to be disabled." : nil
        case .pendingUnlink:
            binding = nil
            lifecycleWarning = "Notifications may continue until this device reconnects."
        case .unlinked:
            binding = nil
            lifecycleWarning = nil
        }
    }

    private static func map(_ status: UNAuthorizationStatus) -> NativePushPermission {
        switch status {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .authorized, .ephemeral: .authorized
        case .provisional: .provisional
        @unknown default: .unavailable
        }
    }
}

final class SentientAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in NativePushCoordinator.shared.didRegister(deviceToken: deviceToken) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in NativePushCoordinator.shared.didFailRegistration() }
    }
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        if let payload = launchOptions?[.remoteNotification] as? [AnyHashable: Any],
           let destination = NotificationDestination(userInfo: payload) {
            Task { @MainActor in NativePushCoordinator.shared.navigation.receive(destination) }
        }
        return true
    }
}
