import MobileData
import SwiftUI

@MainActor
@Observable
private final class PushNotificationsViewModel {
    var binding: PushBinding?
    var isSaving = false
    var error: String?
    private let useCases: PushSettingsUseCases
    private let native: NativePushCoordinator

    init(useCases: PushSettingsUseCases, native: NativePushCoordinator) {
        self.useCases = useCases; self.native = native; binding = native.binding
    }

    func sync() { binding = native.binding }
    func setEnabled(_ enabled: Bool) async { await change { try await useCases.setEnabled(binding: $0, enabled: enabled) } }
    func setPreview(_ preview: PushPreviewMode) async { await change { try await useCases.setPreview(binding: $0, mode: preview) } }

    private func change(_ operation: (PushBinding) async throws -> SentientResult<PushBinding>) async {
        guard let binding else { return }
        isSaving = true; error = nil
        defer { isSaving = false }
        do {
            switch onEnum(of: try await operation(binding)) {
            case .success(let success): self.binding = success.data
            case .failure(let failure): error = failure.error.userMessage
            case .loading: break
            }
        } catch is CancellationError {} catch { self.error = "Couldn't update notification settings." }
    }
}

struct PushNotificationsScreen: View {
    @ObservedObject private var native = NativePushCoordinator.shared
    @State private var vm: PushNotificationsViewModel
    let onBack: () -> Void

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        _vm = State(initialValue: PushNotificationsViewModel(useCases: settings.push, native: .shared))
        self.onBack = onBack
    }

    var body: some View {
        DesignPageChrome(title: "Push notifications", accessibilityId: "push-notifications-screen", onBack: onBack) {
            statusNotice
            if let binding = vm.binding {
                DesignCard(title: "This device", detail: "Preferences apply only to this installation.", bodyStyle: .settingsGroup) {
                    DesignToggleRow(
                        title: "Notifications",
                        detail: "Scheduled conversations still run when delivery is off.",
                        isOn: Binding(get: { binding.preferences.enabled }, set: { value in Task { await vm.setEnabled(value) } }),
                        accessibilityId: "push-enabled",
                        isEnabled: !vm.isSaving
                    )
                    DesignToggleRow(
                        title: "Show message preview",
                        detail: "Off hides message content on the lock screen.",
                        isOn: Binding(get: { binding.preferences.previewMode == .content }, set: { value in Task { await vm.setPreview(value ? .content : .hidden) } }),
                        accessibilityId: "push-preview",
                        isEnabled: !vm.isSaving
                    )
                }
                DesignActionButton(title: "Disable and unlink this device", role: .destructive) { native.unlinkForLogout(); vm.sync() }
            } else if native.permission == .notDetermined {
                DesignActionButton(title: "Enable notifications", accessibilityId: "push-enable") { Task { await native.enable(); vm.sync() } }
            }
            if native.permission == .denied {
                DesignActionButton(title: "Open system settings", role: .secondary, action: native.openSystemSettings)
            }
            if native.lifecycleWarning != nil {
                DesignActionButton(title: "Retry unlink", role: .secondary, action: native.retryPendingUnlink)
            }
        }
        .task { await native.refreshPermission(); vm.sync() }
        .onChange(of: native.binding?.generation) { _, _ in vm.sync() }
    }

    @ViewBuilder private var statusNotice: some View {
        if let warning = native.lifecycleWarning {
            AsyncNotice(kind: .warning, title: "Unlink pending", detail: warning)
        } else if let error = vm.error {
            AsyncNotice(kind: .error, title: "Notifications unavailable", detail: error)
        } else {
            switch native.permission {
            case .unconfigured: AsyncNotice(kind: .info, title: "Notifications aren't configured")
            case .notDetermined: AsyncNotice(kind: .info, title: "Permission required", detail: "Sentient asks only when you choose Enable.")
            case .denied: AsyncNotice(kind: .warning, title: "Notifications are denied", detail: "Allow notifications in iOS Settings.")
            case .authorized, .provisional: AsyncNotice(kind: .success, title: native.registrationPending ? "Registering this device" : "Notifications are available")
            case .unavailable: AsyncNotice(kind: .warning, title: "Notifications aren't available on this device")
            case .error: AsyncNotice(kind: .error, title: "Device registration failed", detail: "Try again after checking system settings and your connection.")
            }
        }
    }
}
