// ---------------------------------------------------------------------------
// MembersViewModel — Admin "Members" page over `settings.admin` (AdminUseCases).
// Lists household members, promotes/demotes, deletes, and adds users (name + PIN,
// 3-slot cap). IMPERATIVE ops: each call refetches server truth. The Admin gate is
// re-checked here (defence-in-depth) via `settings.account.me()`; a non-admin sees
// a guard state, never the roster.
//
// Add-user needs a full valid ProfileBody, but mobile collects only name + PIN, so
// AdminUseCases.createUser (shared mobile-data) TEMPLATES the new member's profile
// off the admin's own live profile — keeps model/voice/audio/compression/advanced
// (guarantees a valid model.id), resets persona + extraSystemPrompt to a clean
// default. This VM has no ProfileRepository dependency: that combine belongs to the
// usecase layer (architecture.md), not a page ViewModel reaching past its usecases.
// Server `applyProfileDefaults` fills tools/toolsets on top. PINs are NEVER logged.
// @MainActor @Observable.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

private let addGenericFailure = "Couldn't add member"

func isAuthorizationFailure(kindName: String) -> Bool {
    kindName.caseInsensitiveCompare("AUTH") == .orderedSame
}

@MainActor
@Observable
final class MembersViewModel {
    /// Page-level access + load state.
    enum Access: Equatable {
        case loading
        case notAdmin
        case ready
        case error
    }

    private(set) var access: Access = .loading
    private(set) var users: [UserSummary] = []
    private(set) var meId = ""
    private(set) var isAdding = false
    /// The userId of a row with a promote/demote/delete in flight, or nil.
    private(set) var mutatingUserId: String?
    var isAddSheetOpen = false
    private(set) var addError: String?
    private(set) var mutationError: String?

    private let account: AccountUseCases
    private let admin: AdminUseCases
    private let log = AppLog("settings", "members-vm")

    init(account: AccountUseCases, admin: AdminUseCases) {
        self.account = account
        self.admin = admin
    }

    /// True while another member can be added (client-side cosmetic; server enforces the cap).
    var canAdd: Bool { canAddUser(userCount: Int32(users.count)) }
    /// Free household slots for the "N slots free" label.
    var slotsFree: Int { Int(householdSlotsFree(userCount: Int32(users.count))) }

    /// Gate on admin, then load the roster. Idempotent; safe on each `.task`.
    func load() async {
        access = .loading
        mutationError = nil
        do {
            let meResult = try await account.me()
            switch onEnum(of: meResult) {
            case .success(let s):
                guard s.data.isAdmin else {
                    access = .notAdmin
                    log.info("access.non-admin")
                    return
                }
                meId = s.data.userId
                await reloadUsers()
            case .failure(let f):
                access = isAuthorizationFailure(kindName: f.error.kind.name) ? .notAdmin : .error
                log.warn("me.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            access = .error
        }
    }

    /// Promote or demote a member (never the self row — the view hides that action).
    func toggleAdmin(_ user: UserSummary) async {
        mutationError = nil
        mutatingUserId = user.userId
        defer { mutatingUserId = nil }
        do {
            let result = try await admin.setUserAdmin(userId: user.userId, isAdmin: !user.isAdmin)
            switch onEnum(of: result) {
            case .success(let s):
                users = users.map { $0.userId == s.data.userId ? s.data : $0 }
                log.info("role.updated isAdmin=\(s.data.isAdmin)")
            case .failure(let f):
                handleMutationFailure(f.error.userMessage, kindName: f.error.kind.name)
                log.warn("role.update.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            mutationError = "Couldn't change this member's role."
            log.warn("role.update.threw")
        }
    }

    /// Delete a member (confirmed by the view), then refetch.
    func deleteUser(_ user: UserSummary) async {
        mutationError = nil
        mutatingUserId = user.userId
        defer { mutatingUserId = nil }
        do {
            let result = try await admin.deleteUser(userId: user.userId)
            switch onEnum(of: result) {
            case .success:
                log.info("member.deleted")
                await reloadUsers()
            case .failure(let f):
                handleMutationFailure(f.error.userMessage, kindName: f.error.kind.name)
                log.warn("member.delete.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            mutationError = "Couldn't remove this member."
            log.warn("member.delete.threw")
        }
    }

    /// Add a member (name + PIN). Returns true on success (caller closes the sheet).
    /// The usecase templates the rest of the profile off the admin's own live profile.
    func addUser(displayName: String, pin: String) async -> Bool {
        isAdding = true
        addError = nil
        defer { isAdding = false }
        do {
            let result = try await admin.createUser(displayName: displayName, pin: pin, isAdmin: false)
            switch onEnum(of: result) {
            case .success:
                log.info("member.added")
                await reloadUsers()
                return true
            case .failure(let f):
                if isAuthorizationFailure(kindName: f.error.kind.name) {
                    access = .notAdmin
                    isAddSheetOpen = false
                } else {
                    addError = f.error.userMessage
                }
                log.warn("member.add.failed kind=\(f.error.kind.name)")
                return false
            case .loading:
                return false
            }
        } catch is CancellationError {
            return false
        } catch {
            addError = addGenericFailure
            return false
        }
    }

    func openAddSheet() {
        addError = nil
        isAddSheetOpen = true
    }

    func closeAddSheet() {
        addError = nil
    }

    private func reloadUsers() async {
        do {
            let result = try await admin.listUsers()
            switch onEnum(of: result) {
            case .success(let s):
                // SKIE erases the generic List payload to NSArray; bridge it back.
                let list = s.data as? [UserSummary] ?? []
                users = list
                access = .ready
                log.info("roster.loaded count=\(list.count)")
            case .failure(let f):
                access = isAuthorizationFailure(kindName: f.error.kind.name) ? .notAdmin : .error
                log.warn("roster.load.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            access = .error
        }
    }

    private func handleMutationFailure(_ message: String, kindName: String) {
        if isAuthorizationFailure(kindName: kindName) {
            access = .notAdmin
            mutationError = "Admin access changed. Member controls are no longer available."
        } else {
            mutationError = message
        }
    }
}
