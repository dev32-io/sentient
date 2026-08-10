// ---------------------------------------------------------------------------
// ToolsViewModel — the Tools settings page state holder. SLOW save: the
// profile PUT changes `tools` (non-audio), so ApplyProfileChangeUseCase runs the
// PUT-then-apply path that blocks through a Hermes worker restart.
//
// Per-tool permission state (plan 2026-08-07-tool-permissions): `draftPermissions`
// is a SESSION-SCOPED PENDING-EDIT OVERLAY (ToolPermissionPatchMap-shaped,
// empty every load), accumulated via the shared `withToolPermission` /
// `withServerMasterPermission` helpers and read back via `effectiveToolPermission`
// / `effectiveWildcardPermission` — never re-simulated locally, so the screen
// can't drift from what the ToolBroker actually resolves. At save time
// `mergeToolPermissionPatch` flattens this overlay onto the ORIGINALLY-LOADED
// stored permissions into the one patch actually PUT. See ToolPermissionPatch.kt
// (shared/mobile-sdk) for the full reasoning behind every one of these helpers.
//
// The two writes that are ever correct: `setToolPermission` (a concrete value,
// one of the four) and `setServerMaster` (every named tool + the wildcard,
// `off` explicitly or a `null` clear back to the role template — NEVER a bulk
// concrete `allow`, which would silently promote a `confirm`-tier tool's `ask`
// to an unprompted `allow`). Both delegate entirely to the shared helpers;
// this file never hand-rolls a map write.
//
// `toolsets` (Hermes built-ins) is unchanged: still a flat on/off list, not a
// permission — Task 8 only replaces the MCP + gateway-native controls.
//
// Dirty compares the Swift-native draft overlay/list, never the KMP ProfileV1
// (not Swift-Equatable).
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
@Observable
final class ToolsViewModel {
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
    private(set) var catalog: McpCatalogView?

    /// This session's pending per-tool permission edits — a
    /// ToolPermissionPatchMap-shaped overlay, empty until something is
    /// touched. Never the full stored table: see this file's header.
    private(set) var draftPermissions: [String: [String: Any]] = [:]
    private(set) var draftToolsets: [String] = []

    private var original: ProfileV1?
    private let settings: SettingsComponent
    private let log = AppLog("settings", "tools-vm")

    init(settings: SettingsComponent) {
        self.settings = settings
    }

    var isDirty: Bool {
        guard let o = original else { return false }
        return !draftPermissions.isEmpty || draftToolsets != (o.tools.toolsets ?? [])
    }

    var isApplying: Bool { save == .saving || save == .restarting }

    /// MCP server ids in a stable sorted order.
    var serverIds: [String] { (catalog?.servers.keys).map { $0.sorted() } ?? [] }

    // ── Read helpers (delegate to the shared resolvers, never re-simulate) ──

    /// This person's pending-or-resolved permission for one tool. Reads the
    /// tool's own explicit overlay key first, falling back to the catalog's
    /// already-resolved snapshot — exactly like the server-side resolver.
    func toolPermission(_ serverId: String, _ tool: McpToolView) -> ToolPermission {
        effectiveToolPermission(permissions: draftPermissions, serverId: serverId, tool: tool)
    }

    /// Whether the server's master toggle should show "on". A wildcard that
    /// was never touched (`nil`) reads as on, matching `wildcard !== "off"`
    /// on the webui.
    func isServerMasterOn(_ serverId: String, _ entry: McpCatalogEntry) -> Bool {
        guard let key = catalog?.wildcardPermissionKey else { return entry.wildcardPermission != .off }
        let wildcard = effectiveWildcardPermission(
            permissions: draftPermissions, serverId: serverId, wildcardKey: key, catalogWildcard: entry.wildcardPermission
        )
        return wildcard != .off
    }

    // ── Mutations — both delegate to the shared write helpers ──

    /// A single tool's explicit permission — one of the four real values,
    /// never a clear (a per-tool control never writes `null`; only the
    /// server master control does).
    func setToolPermission(_ serverId: String, _ toolName: String, _ permission: ToolPermission) {
        draftPermissions = withToolPermission(
            permissions: draftPermissions, serverId: serverId, toolName: toolName, permission: permission
        )
        log.info("tools.permission.change server=\(serverId) tool=\(toolName) permission=\(permission.wireValue)")
    }

    /// The server master control's write: every named tool this role can
    /// govern PLUS the wildcard — `off` explicitly (turnOn=false) or a `null`
    /// clear back to the role template (turnOn=true), NEVER a bulk concrete
    /// `allow`. See `withServerMasterPermission`'s doc comment.
    func setServerMaster(_ serverId: String, _ toolNames: [String], _ turnOn: Bool) {
        guard let wildcardKey = catalog?.wildcardPermissionKey else { return }
        draftPermissions = withServerMasterPermission(
            permissions: draftPermissions, serverId: serverId, toolNames: toolNames, wildcardKey: wildcardKey, turnOn: turnOn
        )
        log.info("tools.server-master.change server=\(serverId) toolCount=\(toolNames.count) turnOn=\(turnOn)")
    }

    func toggleToolset(_ toolset: String) {
        if draftToolsets.contains(toolset) {
            draftToolsets.removeAll { $0 == toolset }
        } else {
            draftToolsets.append(toolset)
        }
        log.info("toggle.toolset toolset=\(toolset) on=\(draftToolsets.contains(toolset))")
    }

    func isToolsetOn(_ toolset: String) -> Bool { draftToolsets.contains(toolset) }

    func hermesActiveCount(_ tools: [HermesBuiltinToolView]) -> Int {
        tools.filter { draftToolsets.contains($0.toolset) }.count
    }

    // ── Load / save ──

    func load() async {
        log.info("load")
        do {
            let profileResult = try await settings.profileRepository.getProfile()
            switch onEnum(of: profileResult) {
            case .success(let s):
                seedDraft(from: s.data)
            case .failure(let f):
                phase = .failed(f.error.userMessage)
                log.warn("load.profile.failed kind=\(f.error.kind)")
                return
            case .loading:
                return
            }
            await loadCatalog()
            phase = .ready
            log.info("load.ready servers=\(serverIds.count)")
        } catch is CancellationError {
        } catch {
            phase = .failed("Couldn't load tools.")
            log.warn("load.threw")
        }
    }

    private func loadCatalog() async {
        do {
            let result = try await settings.profileRepository.getMcpCatalog()
            if case .success(let s) = onEnum(of: result) {
                catalog = s.data
            } else if case .failure(let f) = onEnum(of: result) {
                log.warn("load.catalog.failed kind=\(f.error.kind)")
            }
        } catch {
            log.warn("load.catalog.threw")
        }
    }

    func save() async {
        guard let o = original, isDirty else { return }
        log.info("save.start")
        let next = nextPutBody(from: o)
        for await state in settings.applyProfileChange.invoke(mutation: ProfileMutationPutProfile(previous: o, next: next)) {
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

    private func seedDraft(from profile: ProfileV1) {
        original = profile
        draftPermissions = [:]
        draftToolsets = profile.tools.toolsets ?? []
    }

    /// Builds the PUT body directly — never via `ProfileV1(...).toPutBody()`
    /// like the other settings VMs — because a server-master "on" write
    /// threads a real `null` clear through `draftPermissions`, which
    /// `ProfileTools` (the concrete-leaf GET shape) cannot represent; only
    /// `ProfileToolsPatch` can. See `ProfileMutationPutProfile`'s doc comment,
    /// which calls out this exact "tools screen's server master control /
    /// reset to role default" case as the reason `next` is patch-shaped.
    private func nextPutBody(from o: ProfileV1) -> ProfileV1PutBody {
        let mergedPermissions = mergeToolPermissionPatch(base: o.tools.permissions, overlay: draftPermissions)
        return ProfileV1PutBody(
            schemaVersion: o.schemaVersion,
            userId: o.userId,
            model: o.model,
            voice: o.voice,
            audio: o.audio,
            persona: o.persona,
            tools: ProfileToolsPatch(permissions: mergedPermissions, toolsets: draftToolsets),
            compression: o.compression,
            advanced: o.advanced
        )
    }
}
