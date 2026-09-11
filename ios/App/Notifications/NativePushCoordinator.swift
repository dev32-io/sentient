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
    private var lifecycle: IosPushLifecycle?
    private var ownerFence: String?
    private var deviceToken: String?
    private var registrationTask: Task<Void, Never>?
    private let log = AppLog("push", "native")

    init(
        permissions: NotificationPermissionProviding = SystemNotificationPermissionProvider(),
        registrar: RemoteNotificationRegistering = SystemRemoteNotificationRegistrar()
    ) {
        self.permissions = permissions
        self.registrar = registrar
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func configure(appConfig: AppConfig) {
        guard appConfig.isConfigured, let userId = appConfig.authenticatedUserId else {
            registrationTask?.cancel()
            lifecycle?.close()
            lifecycle = nil
            ownerFence = nil
            binding = nil
            registrationPending = false
            permission = .unconfigured
            return
        }
        let fence = "\(appConfig.gatewayWsUrl)|\(userId)"
        if ownerFence != fence {
            lifecycle?.close()
            lifecycle = createIosPushLifecycle(
                gatewayWsUrl: appConfig.gatewayWsUrl,
                allowSelfSignedDevHost: appConfig.allowSelfSignedDevHost,
                token: { appConfig.tokenStore.load() ?? "" }
            )
            ownerFence = fence
        }
        if let lifecycle {
            applyLifecycleState(lifecycle.coordinator.state.value)
        }
        Task { await refreshPermission() }
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

    /// Freezes revoke-only authority in shared secure storage before returning;
    /// local account teardown remains immediate and network completion is async.
    func unlinkForLogout() {
        navigation.clear()
        guard let lifecycle, let ownerFence else { return }
        registrationTask?.cancel()
        registrationPending = false
        binding = nil
        Task {
            do {
                let result = try await lifecycle.coordinator.unlink(ownerFence: ownerFence)
                applyLifecycleState(lifecycle.coordinator.state.value)
                if case .failure = onEnum(of: result) { lifecycleWarning = "Notifications may continue until this device reconnects." }
            } catch {
                lifecycleWarning = "Notifications may continue until this device reconnects."
            }
        }
    }

    func dismissLifecycleWarning() { lifecycleWarning = nil }

    func retryPendingUnlink() {
        guard let lifecycle else { return }
        Task {
            do {
                let result = try await lifecycle.coordinator.retryPendingUnlink()
                if case .failure = onEnum(of: result) {
                    applyLifecycleState(lifecycle.coordinator.state.value)
                    return
                }
                if let ownerFence {
                    _ = try await lifecycle.coordinator.reconcileActivation(ownerFence: ownerFence)
                }
                applyLifecycleState(lifecycle.coordinator.state.value)
            } catch { lifecycleWarning = "Notification unlink is still pending." }
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

    private func registerCurrentToken() {
        guard let lifecycle, let ownerFence, let deviceToken else { return }
        registrationTask?.cancel()
        registrationPending = true
        registrationTask = Task {
            defer { registrationPending = false }
            let request = lifecycle.registrationRequests.create(
                idempotencyKey: "ios-token-\(UUID().uuidString)",
                apnsDeviceToken: deviceToken,
                replaces: binding.map { PushBindingReference(bindingId: $0.bindingId, generation: $0.generation) }
            )
            do {
                let result = try await lifecycle.coordinator.register(ownerFence: ownerFence, request: request)
                switch onEnum(of: result) {
                case .success(let success): binding = success.value
                case .failure: permission = .error
                }
            } catch is CancellationError {
            } catch {
                permission = .error
                log.warn("binding.failed")
            }
        }
    }

    private func applyLifecycleState(_ state: PushLifecycleState) {
        switch onEnum(of: state) {
        case .linked(let linked):
            binding = linked.binding
            lifecycleWarning = linked.activationPending ? "Notification activation is waiting for the previous binding to be disabled." : nil
        case .pendingUnlink, .unlinkFailed:
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
