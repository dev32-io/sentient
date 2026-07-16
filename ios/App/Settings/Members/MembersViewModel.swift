// ---------------------------------------------------------------------------
// MembersViewModel — Admin "Members" page over `settings.admin` (AdminUseCases).
// Lists household members, promotes/demotes, deletes, and adds users (name + PIN,
// 3-slot cap). IMPERATIVE ops: each call refetches server truth. The Admin gate is
// re-checked here (defence-in-depth) via `settings.account.me()`; a non-admin sees
// a guard state, never the roster.
//
// Add-user needs a full valid ProfileBody, but mobile collects only name + PIN, so
// the new member's profile is TEMPLATED off the admin's own current profile (a
// sanctioned rare `profileRepository` read) — this guarantees a valid model.id
// (required, min-1) that a blank default cannot. Server `applyProfileDefaults`
// then fills tools/toolsets. PINs are NEVER logged. @MainActor @Observable.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

private let defaultPersonaTemplate = "default"
private let addPrepareFailure = "Couldn't prepare the new member"
private let addGenericFailure = "Couldn't add member"

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

    private let account: AccountUseCases
    private let admin: AdminUseCases
    private let profile: ProfileRepository
    private let log = AppLog("settings", "members-vm")

    init(account: AccountUseCases, admin: AdminUseCases, profile: ProfileRepository) {
        self.account = account
        self.admin = admin
        self.profile = profile
    }

    /// True while another member can be added (client-side cosmetic; server enforces the cap).
    var canAdd: Bool { canAddUser(userCount: Int32(users.count)) }
    /// Free household slots for the "N slots free" label.
    var slotsFree: Int { Int(householdSlotsFree(userCount: Int32(users.count))) }

    /// Gate on admin, then load the roster. Idempotent; safe on each `.task`.
    func load() async {
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
                access = .error
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
        mutatingUserId = user.userId
        defer { mutatingUserId = nil }
        do {
            let result = try await admin.setUserAdmin(userId: user.userId, isAdmin: !user.isAdmin)
            switch onEnum(of: result) {
            case .success(let s):
                users = users.map { $0.userId == s.data.userId ? s.data : $0 }
                log.info("role.updated isAdmin=\(s.data.isAdmin)")
            case .failure(let f):
                log.warn("role.update.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            log.warn("role.update.threw")
        }
    }

    /// Delete a member (confirmed by the view), then refetch.
    func deleteUser(_ user: UserSummary) async {
        mutatingUserId = user.userId
        defer { mutatingUserId = nil }
        do {
            let result = try await admin.deleteUser(userId: user.userId)
            switch onEnum(of: result) {
            case .success:
                log.info("member.deleted")
                await reloadUsers()
            case .failure(let f):
                log.warn("member.delete.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            log.warn("member.delete.threw")
        }
    }

    /// Add a member (name + PIN). Returns true on success (caller closes the sheet).
    func addUser(displayName: String, pin: String) async -> Bool {
        isAdding = true
        addError = nil
        defer { isAdding = false }
        guard let template = await loadTemplate() else {
            addError = addPrepareFailure
            return false
        }
        let request = CreateUserRequest(
            displayName: displayName,
            pin: pin,
            isAdmin: false,
            profile: buildProfileBody(from: template)
        )
        do {
            let result = try await admin.createUser(request: request)
            switch onEnum(of: result) {
            case .success:
                log.info("member.added")
                await reloadUsers()
                return true
            case .failure(let f):
                addError = f.error.userMessage
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
                access = .error
                log.warn("roster.load.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            access = .error
        }
    }

    private func loadTemplate() async -> ProfileV1? {
        do {
            let result = try await profile.getProfile()
            switch onEnum(of: result) {
            case .success(let s): return s.data
            case .failure, .loading: return nil
            }
        } catch {
            return nil
        }
    }

    /// Build the new member's profile from the admin's: keep valid model/voice/audio/
    /// compression/advanced; reset persona + extra prompt to a clean default.
    private func buildProfileBody(from template: ProfileV1) -> ProfileBody {
        ProfileBody(
            model: template.model,
            voice: template.voice,
            audio: template.audio,
            persona: ProfilePersona(template: defaultPersonaTemplate, overrides: ""),
            tools: ProfileTools(enabled: [:], toolsets: nil),
            compression: template.compression,
            advanced: ProfileAdvanced(
                extraSystemPrompt: "",
                maxTokens: template.advanced.maxTokens,
                reasoningEffort: template.advanced.reasoningEffort
            )
        )
    }
}
