// ---------------------------------------------------------------------------
// PersonalitiesViewModel — the Personalities page state holder. Unlike the
// draft+Save pages, every action here is IMPERATIVE: Activate / Delete / Create
// each run their own ApplyProfileChangeUseCase FSM (all restart-on-write), and
// the list is refetched on Ready to trust post-restart server truth.
//
// A single `op` projection tracks the one in-flight mutation (saving → restarting
// → ready | alreadyApplying | failed), surfaced as a page banner. Personalities'
// names are immutable after create (the create form is the only place a name is
// set), so there is no page-level dirty draft.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
@Observable
final class PersonalitiesViewModel {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    enum Op: Equatable {
        case idle
        case saving
        case restarting
        case alreadyApplying
        case applied
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var op: Op = .idle
    private(set) var personalities: [Personality] = []
    private(set) var activeName: String?

    private let settings: SettingsComponent
    private let log = AppLog("settings", "personalities-vm")

    init(settings: SettingsComponent) {
        self.settings = settings
    }

    var isBusy: Bool { op == .saving || op == .restarting }
    var operationError: String? {
        if case .failed(let message) = op { return message }
        if case .alreadyApplying = op { return "Another change is already applying. Try again in a moment." }
        return nil
    }

    func load() async {
        log.info("load")
        do {
            let result = try await settings.profileRepository.listPersonalities()
            switch onEnum(of: result) {
            case .success(let s):
                personalities = s.data.personalities
                activeName = s.data.activeName
                phase = .ready
                log.info("load.ready count=\(personalities.count)")
            case .failure(let f):
                phase = .failed(f.error.userMessage)
                log.warn("load.failed kind=\(f.error.kind)")
            case .loading:
                phase = .loading
            }
        } catch is CancellationError {
        } catch {
            phase = .failed("Couldn't load personalities.")
            log.warn("load.threw")
        }
    }

    func activate(_ name: String) async {
        log.info("activate nameLen=\(name.count)")
        await run(ProfileMutationActivatePersonality(name: name), label: "activate")
    }

    func delete(_ name: String) async {
        log.info("delete nameLen=\(name.count)")
        await run(ProfileMutationDeletePersonality(name: name), label: "delete")
    }

    /// Create a personality. Returns true on success so the caller can dismiss the
    /// create form. A blank name is rejected client-side (no request fired).
    func create(name: String, body: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            op = .failed("Name can't be empty.")
            return false
        }
        log.info("create nameLen=\(trimmed.count)")
        await run(ProfileMutationCreatePersonality(name: trimmed, body: body), label: "create")
        return op == .applied
    }

    /// Fold one mutation's FSM; refetch the list on Ready. Never throws across the
    /// boundary — a failure sets `op = .failed(...)` and preserves the list.
    private func run(_ mutation: any ProfileMutation, label: String) async {
        for await state in settings.applyProfileChange.invoke(mutation: mutation) {
            switch onEnum(of: state) {
            case .idle: break
            case .saving: op = .saving
            case .restarting: op = .restarting
            case .ready:
                log.info("\(label).ready")
                await load()
                op = .applied
            case .alreadyApplying:
                op = .alreadyApplying
                log.warn("\(label).already-applying")
            case .failed(let f):
                op = .failed(f.error.userMessage)
                log.warn("\(label).failed")
            }
        }
    }
}
