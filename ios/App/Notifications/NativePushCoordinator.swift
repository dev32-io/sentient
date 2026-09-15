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

enum NativePushLifecycleResult: Sendable { case success, failure }
enum NativePushLifecycleSnapshot {
    case linked(PushBinding, activationPending: Bool)
    case pendingUnlink
    case registrationUncertain
    case storageUnavailable
    case storageWriteFailed
    case authorityUnavailable
    case unlinked

    var isPendingUnlink: Bool {
        if case .pendingUnlink = self { return true }
        return false
    }
}

@MainActor
protocol NativePushLifecycleClient: AnyObject {
    var state: NativePushLifecycleSnapshot { get }
    func prepareUnlink(ownerFence: String) async throws -> NativePushLifecycleResult
    func preparePersistedUnlink() async throws -> NativePushLifecycleResult
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
        case .registrationUncertain: .registrationUncertain
        case .storageUnavailable: .storageUnavailable
        case .storageWriteFailed: .storageWriteFailed
        case .authorityUnavailable: .authorityUnavailable
        case .unlinked: .unlinked
        }
    }
    func prepareUnlink(ownerFence: String) async throws -> NativePushLifecycleResult {
        if case .success = onEnum(of: try await lifecycle.coordinator.prepareUnlink(ownerFence: ownerFence)) { return .success }
        return .failure
    }
    func preparePersistedUnlink() async throws -> NativePushLifecycleResult {
        if case .success = onEnum(of: try await lifecycle.coordinator.preparePersistedUnlink()) { return .success }
        return .failure
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

struct ForegroundInboxInvalidation: Equatable {
    let accountFence: String
    let sequence: UInt64
}

@MainActor
final class NativePushCoordinator: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NativePushCoordinator()

    @Published private(set) var permission: NativePushPermission = .unconfigured
    @Published private(set) var tokenAvailable = false
    @Published private(set) var registrationPending = false
    @Published private(set) var lifecycleWarning: String?
    @Published private(set) var binding: PushBinding?
    @Published private(set) var foregroundInboxInvalidation: ForegroundInboxInvalidation?
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
    private var logoutPreparationGeneration: Int?
    private var logoutPreparationOwnerFence: String?
    private var logoutPreparationNavigationFence: String?
    private var pendingConfiguration: NativePushAccountConfiguration?
    private var pendingLogout = false
    private var pendingSettingsUnlink = false
    private var foregroundInvalidationSequence: UInt64 = 0
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
        if ownerFence == account.fence {
            if pendingLogout || accountTransitionTask != nil || lifecycle?.state.isPendingUnlink == true {
                pendingConfiguration = account
                pendingLogout = false
                retryPendingUnlink()
            } else if let lifecycle {
                applyLifecycleState(lifecycle.state)
            }
            Task { await refreshPermission() }
            return
        }
        if let lifecycle {
            if case .unlinked = lifecycle.state {
                lifecycle.close()
                self.lifecycle = nil
                installLifecycle(account)
            } else {
                pendingConfiguration = account
                pendingLogout = false
                if ownerFence == nil { retryPendingUnlink() } else { beginAccountTransition() }
            }
            return
        }
        installLifecycle(account)
    }

    /// Starts revoke-only replay from persisted state without bearer or APNs token.
    func configureForLoggedOutCleanup(appConfig: AppConfig) {
        guard appConfig.isConfigured, !appConfig.hasToken else { return }
        configureForLoggedOutCleanup(
            gatewayWsUrl: appConfig.gatewayWsUrl,
            allowSelfSignedDevHost: appConfig.allowSelfSignedDevHost
        )
    }

    func configureForLoggedOutCleanup(gatewayWsUrl: String, allowSelfSignedDevHost: Bool) {
        if let lifecycle {
            applyLifecycleState(lifecycle.state)
            if lifecycle.state.isPendingUnlink { retryPendingUnlink() }
            return
        }
        let cleanup = lifecycleFactory(NativePushAccountConfiguration(
            fence: "logged-out-cleanup",
            gatewayWsUrl: gatewayWsUrl,
            allowSelfSignedDevHost: allowSelfSignedDevHost,
            token: { "" }
        ))
        lifecycle = cleanup
        ownerFence = nil
        applyLifecycleState(cleanup.state)
        retryPendingUnlink()
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

    /// Local-only logout preparation. KMP lifecycle fences late network results durably.
    func prepareForLogout(preservingNavigationFor accountFence: String? = nil) async -> Bool {
        let capturedOwnerFence = ownerFence
        if let accountFence {
            navigation.bindPending(to: accountFence)
        } else {
            navigation.clear()
        }
        pendingLogout = pendingConfiguration == nil
        registrationPending = false
        binding = nil

        transitionGeneration &+= 1
        let operation = transitionGeneration
        logoutPreparationGeneration = operation
        logoutPreparationOwnerFence = capturedOwnerFence
        logoutPreparationNavigationFence = accountFence
        registrationTask?.cancel()
        registrationTask = nil
        accountTransitionTask?.cancel()
        accountTransitionTask = nil

        guard let lifecycle, let capturedOwnerFence else { return true }
        do {
            let result = try await lifecycle.prepareUnlink(ownerFence: capturedOwnerFence)
            guard transitionGeneration == operation, self.lifecycle === lifecycle,
                  ownerFence == capturedOwnerFence else { return false }
            applyLifecycleState(lifecycle.state)
            if case .success = result { return true }
        } catch {
            guard transitionGeneration == operation, self.lifecycle === lifecycle,
                  ownerFence == capturedOwnerFence else { return false }
        }
        applyLifecycleState(lifecycle.state)
        if lifecycleWarning == nil {
            lifecycleWarning = "Notification unlink could not be stored securely. Notifications may continue."
        }
        return false
    }

    /// Last MainActor step before session teardown/auth clearing. Re-processes
    /// intents received while durable preparation was suspended.
    func finalizeLogoutPreparation(timedOut: Bool = false) {
        guard logoutPreparationGeneration == transitionGeneration else { return }
        defer {
            logoutPreparationGeneration = nil
            logoutPreparationOwnerFence = nil
            logoutPreparationNavigationFence = nil
            transitionGeneration &+= 1
        }
        guard ownerFence == logoutPreparationOwnerFence else { return }
        if let logoutPreparationNavigationFence {
            navigation.bindPending(to: logoutPreparationNavigationFence)
        } else {
            navigation.clear()
        }
        if timedOut, lifecycleWarning == nil {
            lifecycleWarning = "Notification unlink preparation timed out. Notifications may continue."
        }
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
                if ownerFence == nil {
                    let prepared = try await lifecycle.preparePersistedUnlink()
                    guard !Task.isCancelled, self.transitionGeneration == operation, self.lifecycle === lifecycle else { return }
                    if case .failure = prepared {
                        applyLifecycleState(lifecycle.state)
                        return
                    }
                }
                var result = try await lifecycle.retryPendingUnlink()
                guard !Task.isCancelled, self.transitionGeneration == operation, self.lifecycle === lifecycle else { return }
                // A cancelled registration may still finish after bounded logout preparation.
                // Freeze that late received grant before deciding the old lifecycle is done.
                if case .linked = lifecycle.state,
                   (pendingLogout || pendingConfiguration != nil), let ownerFence {
                    result = try await lifecycle.prepareUnlink(ownerFence: ownerFence)
                    guard !Task.isCancelled, self.transitionGeneration == operation, self.lifecycle === lifecycle else { return }
                    if case .success = result {
                        result = try await lifecycle.retryPendingUnlink()
                        guard !Task.isCancelled, self.transitionGeneration == operation, self.lifecycle === lifecycle else { return }
                    }
                }
                if case .failure = result {
                    applyLifecycleState(lifecycle.state)
                    return
                }
                if case .registrationUncertain = lifecycle.state {
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
                    applyLifecycleState(lifecycle.state)
                } else {
                    closeTransitionLifecycle(lifecycle)
                }
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
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let userInfo = notification.request.content.userInfo
        let bindingId = userInfo["bindingId"] as? String
        let generation: Int64? = switch userInfo["generation"] {
        case let value as NSNumber: value.int64Value
        case let value as String: Int64(value)
        default: nil
        }
        let destination = NotificationDestination(userInfo: userInfo)
        executeNotificationCallback {
            var payload: [AnyHashable: Any] = [:]
            if let bindingId { payload["bindingId"] = bindingId }
            if let generation { payload["generation"] = generation }
            if let destination { payload["sessionId"] = destination.sessionId }
            self.receiveForeground(userInfo: payload)
            completionHandler([])
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        completeNotificationResponse(userInfo: response.notification.request.content.userInfo) {
            completionHandler()
        }
    }

    nonisolated func completeNotificationResponse(
        userInfo: [AnyHashable: Any],
        completionHandler: @MainActor @escaping () -> Void
    ) {
        let destination = NotificationDestination(userInfo: userInfo)
        executeNotificationCallback {
            if let destination { self.navigation.receive(destination) }
            completionHandler()
        }
    }

    private nonisolated func executeNotificationCallback(_ operation: @MainActor @escaping () -> Void) {
        Task { @MainActor in operation() }
    }

    func receiveForeground(userInfo: [AnyHashable: Any]) {
        guard let ownerFence, let binding,
              userInfo["bindingId"] as? String == binding.bindingId,
              Self.payloadGeneration(userInfo["generation"]) == Int64(binding.generation),
              NotificationDestination(userInfo: userInfo) != nil else { return }
        foregroundInvalidationSequence &+= 1
        foregroundInboxInvalidation = ForegroundInboxInvalidation(
            accountFence: ownerFence,
            sequence: foregroundInvalidationSequence
        )
    }

    private func installLifecycle(_ configuration: NativePushAccountConfiguration) {
        lifecycle = lifecycleFactory(configuration)
        ownerFence = configuration.fence
        pendingLogout = false
        if let lifecycle { applyLifecycleState(lifecycle.state) }
        Task { await refreshPermission() }
    }

    private func beginAccountTransition(settingsUnlink: Bool = false) {
        guard accountTransitionTask == nil, let lifecycle, let ownerFence else { return }
        if settingsUnlink { pendingSettingsUnlink = true }
        transitionGeneration += 1
        let operation = transitionGeneration
        registrationTask?.cancel()
        registrationPending = false
        binding = nil
        lifecycleWarning = "Notification activation is waiting for the previous binding to be disabled."
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
        guard case .unlinked = oldLifecycle.state else {
            applyLifecycleState(oldLifecycle.state)
            return
        }
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
        guard case .unlinked = oldLifecycle.state else {
            applyLifecycleState(oldLifecycle.state)
            return
        }
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
                    applyLifecycleState(lifecycle.state)
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
        case .registrationUncertain:
            binding = nil
            lifecycleWarning = "Notification registration could not be confirmed. Notifications may continue."
        case .storageUnavailable:
            binding = nil
            lifecycleWarning = "Notification unlink state could not be read securely. Notifications may continue."
        case .storageWriteFailed:
            binding = nil
            lifecycleWarning = "Notification unlink could not be stored securely. Notifications may continue."
        case .authorityUnavailable:
            binding = nil
            lifecycleWarning = "Notification unlink server is unknown. Revocation was not sent. Notifications may continue."
        case .unlinked:
            binding = nil
            lifecycleWarning = nil
        }
    }

    private static func payloadGeneration(_ value: Any?) -> Int64? {
        switch value {
        case let value as NSNumber: value.int64Value
        case let value as String: Int64(value)
        default: nil
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
        // Install UN delegate before launch returns. Navigation remains app-scoped
        // inside this singleton until delayed authentication mounts UserSessionHost.
        let coordinator = NativePushCoordinator.shared
        if let payload = launchOptions?[.remoteNotification] as? [AnyHashable: Any],
           let destination = NotificationDestination(userInfo: payload) {
            Task { @MainActor in coordinator.navigation.receive(destination) }
        }
        return true
    }
}
