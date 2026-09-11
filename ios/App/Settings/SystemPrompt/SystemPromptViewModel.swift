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

    /// Draft Soul body bound to the mono editor.
    var draft = ""
    /// Whether the restore-default fetch is in flight (blocks the confirm dialog).
    private(set) var isRestoring = false

    private var original = ""
    private let settings: SettingsComponent
    private let log = AppLog("settings", "system-prompt-vm")

    init(settings: SettingsComponent) {
        self.settings = settings
    }

    var isDirty: Bool { phase == .ready && draft != original }
    var isApplying: Bool { save == .saving || save == .restarting }

    func load() async {
        log.info("load")
        do {
            let result = try await settings.profileRepository.getSoul()
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
        log.info("restore-default.start")
        isRestoring = true
        defer { isRestoring = false }
        do {
            let result = try await settings.profileRepository.getSoulDefault()
            switch onEnum(of: result) {
            case .success(let s):
                draft = s.data.content
                log.info("restore-default.applied len=\(draft.count)")
            case .failure(let f):
                save = .failed(f.error.userMessage)
                log.warn("restore-default.failed kind=\(f.error.kind)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            save = .failed("Couldn't load the default instructions.")
            log.warn("restore-default.threw")
        }
    }

    func save() async {
        guard isDirty else { return }
        log.info("save.start len=\(draft.count)")
        for await state in settings.applyProfileChange.invoke(mutation: ProfileMutationPutSoul(content: draft)) {
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
