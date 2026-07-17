// ---------------------------------------------------------------------------
// AccountViewModel — Account settings page state-holder over `settings.account`
// (AccountUseCases). Owns the display-name draft + save FSM and the change-PIN
// dialog outcome. IMPERATIVE ops (no draft/apply): rename PUTs immediately and
// the usecase rolls + persists the fresh token; change-PIN folds ChangePinOutcome
// so a WrongCurrentPin surfaces INLINE with NO logout. PIN values are held in the
// sheet's local @State and NEVER logged.
//
// @MainActor @Observable, owned by AccountScreen via @State, .task-loaded. Folds
// the SentientResult envelope exhaustively; a failure degrades to an inline
// message, never a crash.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

private let savedResetDelayNs: UInt64 = 2_000_000_000
private let wrongPinMessage = "Current PIN is wrong"
private let genericErrorMessage = "Something went wrong"

@MainActor
@Observable
final class AccountViewModel {
    /// Inline state of the display-name Save affordance.
    enum SaveState: Equatable {
        case idle
        case saving
        case saved
        case failed(String)
    }

    /// The server-truth display name (what Save diffs against).
    private(set) var savedName = ""
    /// The editable draft bound to the name field.
    var draftName = ""
    private(set) var nameSave: SaveState = .idle

    /// Change-PIN sheet presentation + result.
    var isPinSheetOpen = false
    private(set) var pinSaving = false
    private(set) var pinError: String?

    private let account: AccountUseCases
    private let log = AppLog("settings", "account-vm")
    private var savedResetTask: Task<Void, Never>?

    init(account: AccountUseCases) {
        self.account = account
    }

    /// Dirty when the trimmed draft is non-empty and differs from server truth.
    var isDirty: Bool {
        let trimmed = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed != savedName
    }

    /// Load identity (display name). Idempotent; safe on each `.task`.
    func load() async {
        do {
            let result = try await account.me()
            switch onEnum(of: result) {
            case .success(let s):
                savedName = s.data.displayName
                if draftName.isEmpty { draftName = s.data.displayName }
                log.info("me.loaded len=\(s.data.displayName.count)")
            case .failure(let f):
                log.warn("me.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
            // View replaced — not a failure.
        } catch {
            log.warn("me.threw")
        }
    }

    /// Save the display name (imperative PUT; usecase rolls the token on success).
    func saveName() async {
        let name = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != savedName else { return }
        nameSave = .saving
        do {
            let result = try await account.updateDisplayName(displayName: name)
            switch onEnum(of: result) {
            case .success(let s):
                savedName = s.data.displayName
                draftName = s.data.displayName
                nameSave = .saved
                scheduleSavedReset()
                log.info("name.saved")
            case .failure(let f):
                nameSave = .failed(f.error.userMessage)
                log.warn("name.save.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
            nameSave = .idle
        } catch {
            nameSave = .failed(genericErrorMessage)
        }
    }

    /// Change PIN. Returns true only on success (caller closes the sheet). A wrong
    /// current PIN sets `pinError` inline and returns false — NO token drop.
    func changePin(current: String, new: String) async -> Bool {
        pinSaving = true
        pinError = nil
        defer { pinSaving = false }
        do {
            let outcome = try await account.changePin(currentPin: current, newPin: new)
            switch onEnum(of: outcome) {
            case .ok:
                log.info("pin.changed")
                return true
            case .wrongCurrentPin:
                pinError = wrongPinMessage
                return false
            case .error(let e):
                pinError = e.error.userMessage
                return false
            }
        } catch is CancellationError {
            return false
        } catch {
            pinError = genericErrorMessage
            return false
        }
    }

    func openPinSheet() {
        pinError = nil
        isPinSheetOpen = true
    }

    func closePinSheet() {
        pinError = nil
    }

    private func scheduleSavedReset() {
        savedResetTask?.cancel()
        savedResetTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: savedResetDelayNs)
            guard let self, case .saved = self.nameSave else { return }
            self.nameSave = .idle
        }
    }
}
