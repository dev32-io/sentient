// ---------------------------------------------------------------------------
// ModelViewModel — the Model settings page state holder. SLOW save: the profile
// PUT changes the model ref (non-audio), so ApplyProfileChangeUseCase runs the
// PUT-then-apply path that blocks through a Hermes worker restart.
//
// Loads the profile (for the current selection) + the models catalog. Browse
// state (provider filter + search query) is ephemeral and independent of the
// draft selection, so the user can browse without losing their pick. Dirty is a
// plain id/provider diff — KMP data classes aren't Swift-Equatable.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
@Observable
final class ModelViewModel {
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
    private(set) var models: [ModelEntry] = []

    /// Draft selection.
    private(set) var draftModelId = ""
    private(set) var draftProvider = ""

    /// Ephemeral browse state.
    var browseProvider = ""
    var query = ""

    private var original: ProfileV1?
    private let settings: SettingsComponent
    private let log = AppLog("settings", "model-vm")

    init(settings: SettingsComponent) {
        self.settings = settings
    }

    var isDirty: Bool {
        guard let o = original else { return false }
        return draftModelId != o.model.id || draftProvider != o.model.provider
    }

    var isApplying: Bool { save == .saving || save == .restarting }

    /// Distinct providers present in the catalog (sorted), for the segmented control.
    var providerOptions: [String] {
        let found = Set(models.map(\.provider))
        return found.isEmpty ? [draftProvider].filter { !$0.isEmpty } : found.sorted()
    }

    /// Catalog filtered to the browse provider + search query.
    var filtered: [ModelEntry] {
        models.filter { entry in
            entry.provider == browseProvider
                && (query.isEmpty || entry.id.lowercased().contains(query.lowercased()))
        }
    }

    func load() async {
        log.info("load")
        do {
            let profileResult = try await settings.profileRepository.getProfile()
            switch onEnum(of: profileResult) {
            case .success(let s):
                original = s.data
                draftModelId = s.data.model.id
                draftProvider = s.data.model.provider
                if browseProvider.isEmpty { browseProvider = s.data.model.provider }
            case .failure(let f):
                phase = .failed(f.error.userMessage)
                log.warn("load.profile.failed kind=\(f.error.kind)")
                return
            case .loading:
                return
            }
            await loadModels()
            phase = .ready
            log.info("load.ready count=\(models.count)")
        } catch is CancellationError {
        } catch {
            phase = .failed("Couldn't load models.")
            log.warn("load.threw")
        }
    }

    private func loadModels() async {
        do {
            let result = try await settings.profileRepository.listModels()
            if case .success(let s) = onEnum(of: result) {
                models = s.data.models
                if browseProvider.isEmpty { browseProvider = models.first?.provider ?? "" }
            } else if case .failure(let f) = onEnum(of: result) {
                log.warn("load.models.failed kind=\(f.error.kind)")
            }
        } catch {
            log.warn("load.models.threw")
        }
    }

    func select(_ entry: ModelEntry) {
        draftModelId = entry.id
        draftProvider = entry.provider
    }

    func save() async {
        guard let o = original, isDirty else { return }
        log.info("save.start model=\(draftModelId)")
        let next = nextProfile(from: o)
        for await state in settings.applyProfileChange.invoke(mutation: ProfileMutationPutProfile(previous: o, next: next.toPutBody())) {
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

    private func nextProfile(from o: ProfileV1) -> ProfileV1 {
        ProfileV1(
            schemaVersion: o.schemaVersion,
            userId: o.userId,
            model: ProfileModelRef(provider: draftProvider, id: draftModelId),
            voice: o.voice,
            audio: o.audio,
            persona: o.persona,
            tools: o.tools,
            compression: o.compression,
            advanced: o.advanced
        )
    }
}
