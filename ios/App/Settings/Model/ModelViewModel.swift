// ---------------------------------------------------------------------------
// ModelViewModel — the Model settings page state holder. SLOW save: the profile
// PUT changes the model ref (non-audio), so ApplyProfileChangeUseCase runs the
// PUT-then-apply path that blocks through a Hermes worker restart.
//
// Loads the profile (for the current selection) + the models catalog. Browse
// state (provider filter + search query) is ephemeral and independent of draft
// selections, so the user can browse without losing picks. Swift-native refs
// keep dirty checks independent of non-Equatable KMP data classes.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

struct AuxiliaryModelSelection: Equatable {
    let provider: String
    let id: String

    init(provider: String, id: String) {
        self.provider = provider
        self.id = id
    }

    init(_ ref: ProfileModelRef) {
        self.init(provider: ref.provider, id: ref.id)
    }

    var profileRef: ProfileModelRef { ProfileModelRef(provider: provider, id: id) }
}

func auxiliaryModelSelection(_ ref: ProfileModelRef?) -> AuxiliaryModelSelection? {
    ref.map { AuxiliaryModelSelection($0) }
}

func profileAuxiliaryModels(
    title: AuxiliaryModelSelection?,
    dreamer: AuxiliaryModelSelection?,
    attachmentVision: AuxiliaryModelSelection?
) -> ProfileAuxiliaryModels? {
    guard title != nil || dreamer != nil || attachmentVision != nil else { return nil }
    return ProfileAuxiliaryModels(
        title: title?.profileRef,
        dreamer: dreamer?.profileRef,
        attachmentVision: attachmentVision?.profileRef
    )
}

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
        case applied
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var save: Save = .idle
    private(set) var models: [ModelEntry] = []

    enum AuxiliaryRunner: CaseIterable, Hashable {
        case title
        case dreamer
        case attachmentVision

        var title: String {
            switch self {
            case .title: "Titles"
            case .dreamer: "Dreamer"
            case .attachmentVision: "Attachment understanding"
            }
        }

        var defaultLabel: String {
            switch self {
            case .title: "Inherit chat model"
            case .dreamer, .attachmentVision: "System default"
            }
        }

        var accessibilityKey: String {
            switch self {
            case .title: "title"
            case .dreamer: "dreamer"
            case .attachmentVision: "attachment-vision"
            }
        }
    }

    /// Draft selections.
    private(set) var draftModelId = ""
    private(set) var draftProvider = ""
    private(set) var titleModel: AuxiliaryModelSelection?
    private(set) var dreamerModel: AuxiliaryModelSelection?
    private(set) var attachmentVisionModel: AuxiliaryModelSelection?

    /// Ephemeral browse state.
    var browseProvider = ""
    var query = ""

    private var original: ProfileV1?
    private let settings: SettingsComponent
    private let log = AppLog("settings", "model-vm")

    init(settings: SettingsComponent) {
        self.settings = settings
    }

    var isMainModelDirty: Bool {
        guard let o = original else { return false }
        return draftModelId != o.model.id || draftProvider != o.model.provider
    }

    var isDirty: Bool {
        guard let o = original else { return false }
        return isMainModelDirty
            || titleModel != auxiliaryModelSelection(o.auxiliaryModels?.title)
            || dreamerModel != auxiliaryModelSelection(o.auxiliaryModels?.dreamer)
            || attachmentVisionModel != auxiliaryModelSelection(o.auxiliaryModels?.attachmentVision)
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
                titleModel = auxiliaryModelSelection(s.data.auxiliaryModels?.title)
                dreamerModel = auxiliaryModelSelection(s.data.auxiliaryModels?.dreamer)
                attachmentVisionModel = auxiliaryModelSelection(s.data.auxiliaryModels?.attachmentVision)
                if browseProvider.isEmpty { browseProvider = s.data.model.provider }
            case .failure(let f):
                phase = .failed(f.error.userMessage)
                log.warn("load.profile.failed kind=\(f.error.kind)")
                return
            case .loading:
                return
            }
            if let catalogError = await loadModels() {
                phase = .failed(catalogError)
                return
            }
            phase = .ready
            log.info("load.ready count=\(models.count)")
        } catch is CancellationError {
        } catch {
            phase = .failed("Couldn't load models.")
            log.warn("load.threw")
        }
    }

    private func loadModels() async -> String? {
        do {
            let result = try await settings.profileRepository.listModels()
            switch onEnum(of: result) {
            case .success(let s):
                models = s.data.models
                if browseProvider.isEmpty { browseProvider = models.first?.provider ?? "" }
                return nil
            case .failure(let f):
                log.warn("load.models.failed kind=\(f.error.kind)")
                return f.error.userMessage
            case .loading:
                return "Models are still loading. Try again."
            }
        } catch is CancellationError {
            return nil
        } catch {
            log.warn("load.models.threw")
            return "Couldn't load models."
        }
    }

    func select(_ entry: ModelEntry) {
        draftModelId = entry.id
        draftProvider = entry.provider
    }

    func auxiliarySelection(for runner: AuxiliaryRunner) -> AuxiliaryModelSelection? {
        switch runner {
        case .title: titleModel
        case .dreamer: dreamerModel
        case .attachmentVision: attachmentVisionModel
        }
    }

    func auxiliaryOptions(for runner: AuxiliaryRunner) -> [ModelEntry] {
        models.filter {
            $0.provider == draftProvider && (runner != .attachmentVision || $0.supportsVision)
        }
    }

    func selectAuxiliary(_ entry: ModelEntry?, for runner: AuxiliaryRunner) {
        let selection = entry.map { AuxiliaryModelSelection(provider: $0.provider, id: $0.id) }
        switch runner {
        case .title: titleModel = selection
        case .dreamer: dreamerModel = selection
        case .attachmentVision: attachmentVisionModel = selection
        }
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
                log.info("save.ready")
                await load()
                save = .applied
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
            advanced: o.advanced,
            auxiliaryModels: profileAuxiliaryModels(
                title: titleModel,
                dreamer: dreamerModel,
                attachmentVision: attachmentVisionModel
            )
        )
    }
}
