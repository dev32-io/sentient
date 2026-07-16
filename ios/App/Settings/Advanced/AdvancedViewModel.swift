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

    enum Save: Equatable {
        case idle
        case saving
        case restarting
        case alreadyApplying
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var save: Save = .idle

    /// Draft primitives bound to the controls.
    var reasoningEffort = ProfileEnums.shared.reasoningEfforts.first ?? "minimal"
    var threshold: Double = 0
    var maxTokens: Double = 0
    var extraSystemPrompt = ""

    private var original: ProfileV1?
    private let settings: SettingsComponent
    private let log = AppLog("settings", "advanced-vm")

    init(settings: SettingsComponent) {
        self.settings = settings
    }

    var isDirty: Bool {
        guard let o = original else { return false }
        return reasoningEffort != o.advanced.reasoningEffort
            || threshold != o.compression.threshold
            || Int32(maxTokens.rounded()) != o.advanced.maxTokens
            || extraSystemPrompt != o.advanced.extraSystemPrompt
    }

    var isApplying: Bool { save == .saving || save == .restarting }

    func load() async {
        log.info("load")
        do {
            let result = try await settings.profileRepository.getProfile()
            switch onEnum(of: result) {
            case .success(let s):
                apply(s.data)
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
        guard let o = original, isDirty else { return }
        log.info("save.start reasoning=\(reasoningEffort)")
        let mutation = ProfileMutationPutProfile(previous: o, next: nextProfile(from: o))
        for await state in settings.applyProfileChange.invoke(mutation: mutation) {
            switch onEnum(of: state) {
            case .idle: break
            case .saving: save = .saving
            case .restarting: save = .restarting
            case .ready:
                save = .idle
                log.info("save.ready")
                await load()
            case .alreadyApplying:
                save = .alreadyApplying
                log.warn("save.already-applying")
            case .failed(let f):
                save = .failed(f.error.userMessage)
                log.warn("save.failed")
            }
        }
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
            devices: o.devices
        )
    }
}
