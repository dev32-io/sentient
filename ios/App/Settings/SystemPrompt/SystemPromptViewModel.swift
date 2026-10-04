// ---------------------------------------------------------------------------
// SystemPromptViewModel — the System Prompt (Soul.md) page state holder. SLOW
// save: PUT /profile/soul is a restart-on-write endpoint, so
// ApplyProfileChangeUseCase.PutSoul blocks through the Hermes worker restart.
//
// Holds `original` (last-saved Soul body) + a Swift-native `draft` string the
// mono editor binds to. Dirty is a plain string diff. "Restore default" fetches
// the canonical template into the draft (NOT saved until the user taps Save).
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
@Observable
final class SystemPromptViewModel {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    typealias Save = DesignApplyState

    private(set) var phase: Phase = .loading
    private(set) var save: Save = .idle

    /// Draft Soul body bound to the mono editor.
    var draft = ""
    /// Whether the restore-default fetch is in flight (blocks the confirm dialog).
    private(set) var isRestoring = false
    private(set) var restoreError: String?

    private var original = ""
    private let loadSoul: () async throws -> SentientResult<SoulDoc>
    private let loadDefault: () async throws -> SentientResult<SoulDefaultDoc>
    private let applySoul: (String, (any ApplyState) async -> Void) async -> Void
    private let log = AppLog("settings", "system-prompt-vm")

    init(settings: SettingsComponent) {
        loadSoul = { try await settings.profileRepository.getSoul() }
        loadDefault = { try await settings.profileRepository.getSoulDefault() }
        applySoul = { content, receive in
            for await state in settings.applyProfileChange.invoke(mutation: ProfileMutationPutSoul(content: content)) {
                await receive(state)
            }
        }
    }

    init(
        loadSoul: @escaping () async throws -> SentientResult<SoulDoc>,
        loadDefault: @escaping () async throws -> SentientResult<SoulDefaultDoc>,
        applySoul: @escaping (String, (any ApplyState) async -> Void) async -> Void
    ) {
        self.loadSoul = loadSoul
        self.loadDefault = loadDefault
        self.applySoul = applySoul
    }

    var isDirty: Bool { phase == .ready && draft != original }
    var isApplying: Bool { save.isBusy }

    func discard() {
        guard phase == .ready, !isApplying, !isRestoring else { return }
        draft = original
        restoreError = nil
        save = .idle
    }

    func load() async {
        log.info("load")
        do {
            let result = try await loadSoul()
            switch onEnum(of: result) {
            case .success(let s):
                original = s.data.content
                draft = s.data.content
                phase = .ready
                log.info("load.ready len=\(draft.count)")
            case .failure(let f):
                phase = .failed(f.error.userMessage)
                log.warn("load.failed kind=\(f.error.kind)")
            case .loading:
                phase = .loading
            }
        } catch is CancellationError {
        } catch {
            phase = .failed("Couldn't load system instructions.")
            log.warn("load.threw")
        }
    }

    /// Fetch the canonical default template into the draft (does not persist).
    func restoreDefault() async {
        guard !isApplying, !isRestoring else { return }
        log.info("restore-default.start")
        isRestoring = true
        restoreError = nil
        defer { isRestoring = false }
        do {
            let result = try await loadDefault()
            switch onEnum(of: result) {
            case .success(let s):
                draft = s.data.content
                log.info("restore-default.applied len=\(draft.count)")
            case .failure(let f):
                restoreError = f.error.userMessage
                log.warn("restore-default.failed kind=\(f.error.kind)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            restoreError = "Couldn't load the default instructions."
            log.warn("restore-default.threw")
        }
    }

    func save() async {
        guard isDirty, !isApplying, !isRestoring else { return }
        save = .saving
        log.info("save.start len=\(draft.count)")
        await applySoul(draft) { state in
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
}
