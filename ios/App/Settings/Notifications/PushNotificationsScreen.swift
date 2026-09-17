import MobileData
import SwiftUI

func canOfferPushEnable(permission: NativePushPermission, hasBinding: Bool) -> Bool {
    guard !hasBinding else { return false }
    return permission == .notDetermined || permission == .authorized || permission == .provisional || permission == .error
}

private struct PushBindingIdentity: Equatable {
    let bindingId: String
    let installationId: String
    let generation: Int32

    init(_ binding: PushBinding) {
        bindingId = binding.bindingId
        installationId = binding.installationId
        generation = binding.generation
    }

    func matches(_ binding: PushBinding) -> Bool {
        binding.bindingId == bindingId && binding.installationId == installationId && binding.generation == generation
    }
}

enum PushSettingsMutationResult {
    case success(PushBinding)
    case failure(String)
    case loading
}

@MainActor
protocol PushSettingsServicing: AnyObject {
    var currentBinding: SentientResult<PushBinding> { get }
    func load(installationId: String) async throws -> SentientResult<PushBinding>
    func saveEnabled(binding: PushBinding, enabled: Bool) async throws -> PushSettingsMutationResult
    func savePreview(binding: PushBinding, mode: PushPreviewMode) async throws -> PushSettingsMutationResult
    func observeBinding(_ receive: @escaping @MainActor (SentientResult<PushBinding>) -> Void) -> Task<Void, Never>
}

extension PushSettingsUseCases: PushSettingsServicing {
    var currentBinding: SentientResult<PushBinding> { binding.value }

    func saveEnabled(binding: PushBinding, enabled: Bool) async throws -> PushSettingsMutationResult {
        pushMutationResult(try await setEnabled(binding: binding, enabled: enabled))
    }

    func savePreview(binding: PushBinding, mode: PushPreviewMode) async throws -> PushSettingsMutationResult {
        pushMutationResult(try await setPreview(binding: binding, mode: mode))
    }

    func observeBinding(_ receive: @escaping @MainActor (SentientResult<PushBinding>) -> Void) -> Task<Void, Never> {
        Task {
            for await value in binding {
                guard !Task.isCancelled else { return }
                receive(value)
            }
        }
    }
}

private func pushMutationResult(_ result: SentientResult<PushBinding>) -> PushSettingsMutationResult {
    switch onEnum(of: result) {
    case .success(let success): .success(success.data)
    case .failure(let failure): .failure(failure.error.userMessage)
    case .loading: .loading
    }
}

@MainActor
@Observable
final class PushNotificationsViewModel {
    enum LoadState: Equatable { case idle, loading, ready, failed(String) }
    private enum Change { case enabled(Bool), preview(PushPreviewMode) }

    var binding: PushBinding?
    var loadState: LoadState = .idle
    var isSaving = false
    var saveError: String?

    private let useCases: PushSettingsServicing
    private var identity: PushBindingIdentity?
    private var generation = 0
    private var workerGeneration = 0
    private var awaitingInitialLoading = false
    private var queuedChanges: [Change] = []
    private var failedChange: Change?
    @ObservationIgnored private nonisolated(unsafe) var observationTask: Task<Void, Never>?
    @ObservationIgnored private nonisolated(unsafe) var mutationTask: Task<Void, Never>?

    init(useCases: PushSettingsServicing) { self.useCases = useCases }
    deinit { observationTask?.cancel(); mutationTask?.cancel() }

    func start(binding nativeBinding: PushBinding?) async {
        generation += 1
        resetMutations()
        saveError = nil
        failedChange = nil
        binding = nil
        identity = nativeBinding.map(PushBindingIdentity.init)
        guard let identity else { loadState = .idle; return }

        loadState = .loading
        awaitingInitialLoading = true
        observe()
        let operation = generation
        do {
            let result = try await useCases.load(installationId: identity.installationId)
            guard operation == generation else { return }
            awaitingInitialLoading = false
            receive(result)
        } catch is CancellationError {
        } catch {
            guard operation == generation else { return }
            awaitingInitialLoading = false
            loadState = .failed("Couldn't load notification settings. Please try again.")
        }
    }

    func setEnabled(_ enabled: Bool) { enqueue(.enabled(enabled)) }
    func setPreview(_ preview: PushPreviewMode) { enqueue(.preview(preview)) }

    func retrySave() {
        guard let failedChange, mutationTask == nil, loadState == .ready, binding != nil else { return }
        queuedChanges.insert(failedChange, at: 0)
        saveError = nil
        self.failedChange = nil
        startWorker()
    }

    func clear() {
        generation += 1
        resetMutations()
        identity = nil
        binding = nil
        loadState = .idle
        saveError = nil
        failedChange = nil
    }

    private func observe() {
        guard observationTask == nil else { return }
        observationTask = useCases.observeBinding { [weak self] value in
            guard let self else { return }
            if case .loading = onEnum(of: value) {
                self.awaitingInitialLoading = false
                self.receive(value)
            } else if !self.awaitingInitialLoading {
                self.receive(value)
            }
        }
    }

    private func enqueue(_ change: Change) {
        guard loadState == .ready, binding != nil, failedChange == nil else { return }
        queuedChanges.append(change)
        startWorker()
    }

    private func startWorker() {
        guard mutationTask == nil else { return }
        isSaving = true
        workerGeneration += 1
        let worker = workerGeneration
        let operation = generation
        mutationTask = Task { [weak self] in await self?.drain(operation: operation, worker: worker) }
    }

    private func drain(operation: Int, worker: Int) async {
        var failure: (Change, String)?
        defer {
            if operation == generation, worker == workerGeneration {
                mutationTask = nil
                isSaving = false
                saveError = failure?.1
                failedChange = failure?.0
            }
        }

        while operation == generation, worker == workerGeneration, !Task.isCancelled, !queuedChanges.isEmpty {
            let change = queuedChanges.removeFirst()
            guard let binding else { break }
            do {
                let result: PushSettingsMutationResult = switch change {
                case .enabled(let enabled): try await useCases.saveEnabled(binding: binding, enabled: enabled)
                case .preview(let preview): try await useCases.savePreview(binding: binding, mode: preview)
                }
                guard operation == generation, worker == workerGeneration else { return }
                switch result {
                case .success(let acknowledged):
                    receive(SentientResultSuccess(data: acknowledged))
                case .failure(let message):
                    receive(useCases.currentBinding)
                    failure = (change, message)
                    return
                case .loading:
                    failure = (change, "Couldn't save notification settings. Please try again.")
                    return
                }
            } catch is CancellationError {
                return
            } catch {
                guard operation == generation, worker == workerGeneration else { return }
                failure = (change, "Couldn't save notification settings. Please try again.")
                return
            }
        }
    }

    private func resetMutations() {
        workerGeneration += 1
        mutationTask?.cancel()
        mutationTask = nil
        queuedChanges.removeAll()
        isSaving = false
    }

    private func receive(_ result: SentientResult<PushBinding>) {
        guard let identity else { return }
        switch onEnum(of: result) {
        case .loading:
            binding = nil
            loadState = .loading
        case .success(let success) where identity.matches(success.data):
            binding = success.data
            loadState = .ready
        case .success:
            break
        case .failure(let failure):
            binding = nil
            loadState = .failed(failure.error.userMessage)
        }
    }
}

struct PushNotificationsScreen: View {
    @ObservedObject private var native = NativePushCoordinator.shared
    @State private var vm: PushNotificationsViewModel
    let onBack: () -> Void

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        _vm = State(initialValue: PushNotificationsViewModel(useCases: settings.push))
        self.onBack = onBack
    }

    var body: some View {
        DesignPageChrome(title: "Push notifications", accessibilityId: "push-notifications-screen", onBack: onBack) {
            statusNotice
            if let binding = vm.binding, vm.loadState == .ready {
                DesignCard(title: "This device", detail: "Preferences apply only to this installation.", bodyStyle: .settingsGroup) {
                    DesignToggleRow(
                        title: "Notifications",
                        detail: "Scheduled conversations still run when delivery is off.",
                        isOn: Binding(get: { binding.preferences.enabled }, set: vm.setEnabled),
                        accessibilityId: "push-enabled",
                        isEnabled: !vm.isSaving && vm.saveError == nil
                    )
                    DesignToggleRow(
                        title: "Show message preview",
                        detail: "Off hides message content on the lock screen.",
                        isOn: Binding(get: { binding.preferences.previewMode == .content }, set: { vm.setPreview($0 ? .content : .hidden) }),
                        accessibilityId: "push-preview",
                        isEnabled: !vm.isSaving && vm.saveError == nil
                    )
                }
                DesignActionButton(
                    title: "Disable and unlink this device",
                    role: .destructive,
                    state: vm.isSaving || vm.saveError != nil ? .disabled : .normal
                ) {
                    vm.clear()
                    native.unlinkFromSettings()
                }
            } else if vm.loadState == .idle && canOfferPushEnable(permission: native.permission, hasBinding: native.binding != nil) {
                DesignActionButton(title: "Enable notifications", accessibilityId: "push-enable") { Task { await native.enable() } }
            }
            if native.permission == .denied {
                DesignActionButton(title: "Open system settings", role: .secondary, action: native.openSystemSettings)
            }
            if native.lifecycleWarning != nil {
                DesignActionButton(title: "Retry unlink", role: .secondary, action: native.retryPendingUnlink)
            }
        }
        .task {
            await vm.start(binding: native.binding)
            await native.refreshPermission()
        }
        .onChange(of: native.binding.map(PushBindingIdentity.init)) { _, _ in
            vm.clear()
            if let binding = native.binding { Task { await vm.start(binding: binding) } }
        }
    }

    @ViewBuilder private var statusNotice: some View {
        if let warning = native.lifecycleWarning {
            AsyncNotice(kind: .warning, title: "Unlink pending", detail: warning)
        } else {
            switch vm.loadState {
            case .loading:
                AsyncNotice(kind: .loading, title: "Loading notification settings")
            case .failed(let error):
                AsyncNotice(kind: .error, title: "Couldn't load notification settings", detail: error,
                            retry: { Task { await vm.start(binding: native.binding) } })
            case .ready where vm.isSaving:
                AsyncNotice(kind: .loading, title: "Saving notification settings")
            case .ready where vm.saveError != nil:
                AsyncNotice(kind: .error, title: "Notification settings not saved", detail: vm.saveError,
                            retry: vm.retrySave, actionTitle: "Try again")
            default:
                permissionNotice
            }
        }
    }

    @ViewBuilder private var permissionNotice: some View {
        switch native.permission {
        case .unconfigured: AsyncNotice(kind: .info, title: "Notifications aren't configured")
        case .notDetermined: AsyncNotice(kind: .info, title: "Permission required", detail: "Sentient asks only when you choose Enable.")
        case .denied: AsyncNotice(kind: .warning, title: "Notifications are denied", detail: "Allow notifications in iOS Settings.")
        case .authorized, .provisional:
            AsyncNotice(
                kind: vm.binding == nil ? .info : .success,
                title: native.registrationPending ? "Registering this device" : vm.binding == nil ? "System permission allowed" : "This device is registered"
            )
        case .unavailable: AsyncNotice(kind: .warning, title: "Notifications aren't available on this device")
        case .error: AsyncNotice(kind: .error, title: "Device registration failed", detail: "Try again after checking system settings and your connection.")
        }
    }
}
