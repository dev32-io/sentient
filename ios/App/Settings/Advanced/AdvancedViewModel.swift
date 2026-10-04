// ---------------------------------------------------------------------------
// AdvancedViewModel — the Advanced settings page state holder. SLOW save: the
// profile PUT changes non-audio fields, so ApplyProfileChangeUseCase runs the
// PUT-then-apply path that blocks through a Hermes worker restart.
//
// Holds the loaded ProfileV1 as `original` (the mutation's `previous`) plus the
// Swift-native draft primitives the controls bind to (reasoning / compression /
// max-tokens / extra-system-prompt). Dirty is derived from those primitives —
// KMP data classes aren't Swift-Equatable, so ProfileV1 is never compared here.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
@Observable
final class AdvancedViewModel {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    typealias Save = DesignApplyState

    private(set) var phase: Phase = .loading
    private(set) var save: Save = .idle

    /// Draft primitives bound to the controls.
    var reasoningEffort = ProfileEnums.shared.reasoningEfforts.first ?? "minimal"
    var threshold: Double = 0
    var maxTokens: Double = 0
    var extraSystemPrompt = ""

    // A successful PUT is not proof that the running configuration applied.
    private(set) var hasPendingApply = false
    private var baselineNeedsReload = false
    private var loading = false
    private var original: ProfileV1?
    private let loadProfile: () async throws -> SentientResult<ProfileV1>
    private let applyProfile: (ProfileMutationPutProfile, (any ApplyState) async -> Void) async -> Void
    private let applyOnly: ((any ApplyState) async -> Void) async -> Void
    private let log = AppLog("settings", "advanced-vm")

    init(settings: SettingsComponent) {
        loadProfile = { try await settings.profileRepository.getProfile() }
        applyOnly = { receive in
            for await state in settings.applyProfileChange.applyOnly() { await receive(state) }
        }
        applyProfile = { mutation, receive in
            for await state in settings.applyProfileChange.invoke(mutation: mutation) {
                await receive(state)
            }
        }
    }

    init(
        loadProfile: @escaping () async throws -> SentientResult<ProfileV1>,
        applyProfile: @escaping (ProfileMutationPutProfile, (any ApplyState) async -> Void) async -> Void,
        applyOnly: @escaping ((any ApplyState) async -> Void) async -> Void
    ) {
        self.loadProfile = loadProfile
        self.applyProfile = applyProfile
        self.applyOnly = applyOnly
    }

    var isDirty: Bool {
        guard phase == .ready, let o = original else { return false }
        return reasoningEffort != o.advanced.reasoningEffort
            || threshold != o.compression.threshold
            || Int32(maxTokens.rounded()) != o.advanced.maxTokens
            || extraSystemPrompt != o.advanced.extraSystemPrompt
    }

    var isApplying: Bool { save.isBusy }

    func discard() {
        guard phase == .ready, !isApplying, !baselineNeedsReload else { return }
        guard let original else { return }
        apply(original)
        if !hasPendingApply { save = .idle }
    }

    func load(reconciling: Bool = false) async {
        guard !Task.isCancelled, (reconciling || !isApplying), !loading else { return }
        loading = true
        phase = .loading
        defer {
            loading = false
            if phase == .loading { phase = .failed("Couldn't confirm the saved profile. Reload before editing.") }
        }
        log.info("load")
        do {
            let result = try await loadProfile()
            try Task.checkCancellation()
            switch onEnum(of: result) {
            case .success(let s):
                apply(s.data)
                baselineNeedsReload = false
                phase = .ready
                log.info("load.ready reasoning=\(reasoningEffort) maxTokens=\(Int(maxTokens))")
            case .failure(let f):
                phase = .failed(f.error.userMessage)
                log.warn("load.failed kind=\(f.error.kind)")
            case .loading:
                phase = .loading
            }
        } catch is CancellationError {
        } catch {
            phase = .failed("Couldn't load advanced settings.")
            log.warn("load.threw")
        }
    }

    func save() async {
        guard !Task.isCancelled, let o = original, isDirty, !isApplying, !baselineNeedsReload, !loading else { return }
        save = .saving
        log.info("save.start reasoning=\(reasoningEffort)")
        let mutation = ProfileMutationPutProfile(previous: o, next: nextProfile(from: o).toPutBody())
        await applyProfile(mutation, receiveApplyState)
        finishInterruptedApply()
    }

    /// Retry runtime application only: never PUT an already-persisted draft again.
    func retryApply() async {
        guard !Task.isCancelled, hasPendingApply, !isApplying, !loading, !baselineNeedsReload, !isDirty else { return }
        save = .restarting
        await applyOnly(receiveApplyState)
        finishInterruptedApply()
    }

    private func receiveApplyState(_ state: any ApplyState) async {
        guard !Task.isCancelled else { return }
        switch onEnum(of: state) {
        case .idle: break
        case .saving: save = .saving
        case .restarting:
            hasPendingApply = true
            baselineNeedsReload = true
            save = .restarting
        case .ready:
            hasPendingApply = false
            await load(reconciling: true)
            guard !Task.isCancelled else { return }
            save = .applied
        case .alreadyApplying:
            save = .alreadyApplying
            requireConfirmedBaseline()
        case .failed(let failure):
            save = .failed(failure.error.userMessage)
            requireConfirmedBaseline()
        }
    }

    private func requireConfirmedBaseline() {
        guard baselineNeedsReload else { return }
        phase = .failed("The saved profile needs confirmation. Reload before editing or discarding; application may still be unresolved.")
    }

    private func finishInterruptedApply() {
        guard save.isBusy else { return }
        // Cancellation/early stream termination is not evidence of rollback,
        // even if the PUT response was lost before Restarting reached Swift.
        baselineNeedsReload = true
        hasPendingApply = true
        save = .failed("Application was interrupted. Reload to confirm the saved profile.")
        requireConfirmedBaseline()
    }

    private func apply(_ profile: ProfileV1) {
        original = profile
        reasoningEffort = profile.advanced.reasoningEffort
        threshold = profile.compression.threshold
        maxTokens = Double(profile.advanced.maxTokens)
        extraSystemPrompt = profile.advanced.extraSystemPrompt
    }

    private func nextProfile(from o: ProfileV1) -> ProfileV1 {
        ProfileV1(
            schemaVersion: o.schemaVersion,
            userId: o.userId,
            model: o.model,
            voice: o.voice,
            audio: o.audio,
            persona: o.persona,
            tools: o.tools,
            compression: ProfileCompression(threshold: threshold),
            advanced: ProfileAdvanced(
                extraSystemPrompt: extraSystemPrompt,
                maxTokens: Int32(maxTokens.rounded()),
                reasoningEffort: reasoningEffort
            ),
            auxiliaryModels: o.auxiliaryModels,
            memory: o.memory
        )
    }
}
