// ---------------------------------------------------------------------------
// SettingsRootViewModel — the thin state-holder for the root Settings category
// list. Its ONE job is the Admin-group gate: it folds the KMP
// ObserveSettingsAccessUseCase (me.isAdmin + fish flag) into a published access
// state the root view reads. Everything else on the root page (category rows,
// logout, update footer) is static or bound to the shared UpdateModel — no VM.
//
// One-shot load (the usecase is a `suspend` one-shot, not a Flow): the view calls
// `load()` from `.task`; a route re-entry rebuilds the VM and reloads. The result
// envelope is folded EXHAUSTIVELY (success / failure / loading) per the mobile-data
// result-envelope rule — a failure or still-loading access degrades to "no Admin
// group", never a crash and never a leaked admin surface.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
@Observable
final class SettingsRootViewModel {
    /// Access-gate state for the root page. Admin surfaces only in `.ready(isAdmin: true)`.
    enum AccessState: Equatable {
        case loading
        case ready(isAdmin: Bool, fishBrowseEnabled: Bool)
        case failed
    }

    private(set) var access: AccessState = .loading

    private let observeAccess: ObserveSettingsAccessUseCase
    private let log = AppLog("settings", "root-vm")

    init(observeAccess: ObserveSettingsAccessUseCase) {
        self.observeAccess = observeAccess
    }

    /// True only once access has resolved AND the user is an admin. Loading / failed
    /// both read false, so the Admin group is hidden by default (fail-safe).
    var showAdmin: Bool {
        if case .ready(let isAdmin, _) = access { return isAdmin }
        return false
    }

    /// Resolve the access flags. Idempotent; safe to call on each `.task`. Folds the
    /// SentientResult envelope exhaustively; a thrown error (SKIE suspend-bridge /
    /// cancellation) degrades to `.failed` (or is ignored on cancellation).
    func load() async {
        log.info("access.load")
        do {
            let result = try await observeAccess.invoke()
            switch onEnum(of: result) {
            case .success(let s):
                access = .ready(isAdmin: s.data.isAdmin, fishBrowseEnabled: s.data.fishBrowseEnabled)
                log.info("access.ready isAdmin=\(s.data.isAdmin) fish=\(s.data.fishBrowseEnabled)")
            case .failure:
                access = .failed
                log.warn("access.failed")
            case .loading:
                access = .loading
            }
        } catch is CancellationError {
            // View disappeared / task replaced — not a real failure.
        } catch {
            access = .failed
            log.warn("access.threw reason=\(error.localizedDescription)")
        }
    }
}
