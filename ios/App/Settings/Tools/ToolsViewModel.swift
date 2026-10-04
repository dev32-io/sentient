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
// Dirty compares the shared merged permission patch and the draft toolset list;
// an untouched nullable toolset list keeps its existing display default.
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

    typealias Save = DesignApplyState

    private(set) var phase: Phase = .loading
    private(set) var save: Save = .idle
    private(set) var catalog: McpCatalogView?

    /// This session's pending per-tool permission edits — a
    /// ToolPermissionPatchMap-shaped overlay, empty until something is
    /// touched. Never the full stored table: see this file's header.
    private(set) var draftPermissions: [String: [String: Any]] = [:]
    private(set) var draftToolsets: [String] = []

    // A successful PUT is not proof that the running configuration applied.
    private(set) var hasPendingApply = false
    private var baselineNeedsReload = false
    private var loading = false
    private var original: ProfileV1?
    private let loadProfile: () async throws -> SentientResult<ProfileV1>
    private let applyProfile: (ProfileMutationPutProfile, (any ApplyState) async -> Void) async -> Void
    private let loadCatalogRead: () async throws -> SentientResult<McpCatalogView>
    private let applyOnly: ((any ApplyState) async -> Void) async -> Void
    private let log = AppLog("settings", "tools-vm")

    init(settings: SettingsComponent) {
        loadProfile = { try await settings.profileRepository.getProfile() }
        applyOnly = { receive in
            for await state in settings.applyProfileChange.applyOnly() { await receive(state) }
        }
        applyProfile = { mutation, receive in
            for await state in settings.applyProfileChange.invoke(mutation: mutation) {
                await receive(state)
            }
        }
        loadCatalogRead = { try await settings.profileRepository.getMcpCatalog() }
    }

    init(
        loadProfile: @escaping () async throws -> SentientResult<ProfileV1>,
        loadCatalog: @escaping () async throws -> SentientResult<McpCatalogView>,
        applyProfile: @escaping (ProfileMutationPutProfile, (any ApplyState) async -> Void) async -> Void,
        applyOnly: @escaping ((any ApplyState) async -> Void) async -> Void
    ) {
        self.loadProfile = loadProfile
        self.applyProfile = applyProfile
        self.applyOnly = applyOnly
        self.loadCatalogRead = loadCatalog
    }

    var isDirty: Bool {
        guard phase == .ready, let o = original else { return false }
        // A no-op overlay must not send an unchanged PUT whose shared fast path
        // could report Ready without retrying a previously unresolved Apply.
        let permissions = ProfileToolsPatch(
            permissions: mergeToolPermissionPatch(base: o.tools.permissions, overlay: draftPermissions),
            toolsets: o.tools.toolsets
        )
        return (!draftPermissions.isEmpty && !permissions.isEqual(o.toPutBody().tools))
            || draftToolsets != (o.tools.toolsets ?? [])
    }

    var isApplying: Bool { save.isBusy }

    /// MCP server ids in a stable sorted order.
    var groupIds: [String] { (catalog?.groups.keys).map { $0.sorted() } ?? [] }

    /// Catalog is role-filtered; its ordinary permission values do not govern Cube.
    var cubeTools: [McpToolView] {
        var seen = Set<String>()
        return (catalog?.groups.values.flatMap(\.tools) ?? [])
            .filter { seen.insert($0.name).inserted }
            .sorted { $0.name < $1.name }
    }

    func cubePermission(_ name: String) -> ToolPermission {
        cubeToolPermission(base: original?.tools.permissions, overlay: draftPermissions, toolName: name)
    }

    func setCubePermission(_ name: String, _ permission: ToolPermission) {
        guard phase == .ready, !isApplying else { return }
        guard (permission == .allow || permission == .off),
              cubeTools.contains(where: { $0.name == name && $0.settable }) else { return }
        draftPermissions = withToolPermission(
            permissions: draftPermissions, serverId: "cube", toolName: name, permission: permission
        )
        log.info("tools.cube.permission.change tool=\(name) permission=\(permission.wireValue)")
    }

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
    func isGroupMasterOn(_ groupId: String, _ entry: ProductToolGroupView) -> Bool {
        guard let key = catalog?.wildcardPermissionKey else { return entry.wildcardPermission != .off }
        let wildcard = effectiveWildcardPermission(
            permissions: draftPermissions, serverId: groupId, wildcardKey: key, catalogWildcard: entry.wildcardPermission
        )
        return wildcard != .off
    }

    // ── Mutations — both delegate to the shared write helpers ──

    /// A single tool's explicit permission — one of the four real values,
    /// never a clear (a per-tool control never writes `null`; only the
    /// server master control does).
    func setToolPermission(_ serverId: String, _ toolName: String, _ permission: ToolPermission) {
        guard phase == .ready, !isApplying else { return }
        draftPermissions = withToolPermission(
            permissions: draftPermissions, serverId: serverId, toolName: toolName, permission: permission
        )
        log.info("tools.permission.change server=\(serverId) tool=\(toolName) permission=\(permission.wireValue)")
    }

    /// The server master control's write: every named tool this role can
    /// govern PLUS the wildcard — `off` explicitly (turnOn=false) or a `null`
    /// clear back to the role template (turnOn=true), NEVER a bulk concrete
    /// `allow`. See `withServerMasterPermission`'s doc comment.
    func setGroupMaster(_ groupId: String, _ toolNames: [String], _ turnOn: Bool) {
        guard phase == .ready, !isApplying else { return }
        guard let wildcardKey = catalog?.wildcardPermissionKey else { return }
        draftPermissions = withServerMasterPermission(
            permissions: draftPermissions, serverId: groupId, toolNames: toolNames, wildcardKey: wildcardKey, turnOn: turnOn
        )
        log.info("tools.server-master.change group=\(groupId) toolCount=\(toolNames.count) turnOn=\(turnOn)")
    }

    func toggleToolset(_ toolset: String) {
        guard phase == .ready, !isApplying else { return }
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

    func discard() {
        guard phase == .ready, !isApplying, !baselineNeedsReload else { return }
        guard let original else { return }
        seedDraft(from: original)
        if !hasPendingApply { save = .idle }
    }

    func load(reconciling: Bool = false) async {
        guard !Task.isCancelled, (reconciling || !isApplying), !loading else { return }
        loading = true
        phase = .loading
        defer {
            loading = false
            if phase == .loading { phase = .failed("Couldn't confirm the saved profile. Reload before editing.") }
        }
        log.info("load")
        do {
            let profileResult = try await loadProfile()
            try Task.checkCancellation()
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
            if let catalogError = await loadCatalog() {
                phase = .failed(catalogError)
                return
            }
            try Task.checkCancellation()
            baselineNeedsReload = false
            phase = .ready
            log.info("load.ready groups=\(groupIds.count)")
        } catch is CancellationError {
        } catch {
            phase = .failed("Couldn't load tools.")
            log.warn("load.threw")
        }
    }

    private func loadCatalog() async -> String? {
        do {
            let result = try await loadCatalogRead()
            switch onEnum(of: result) {
            case .success(let s):
                catalog = s.data
                return nil
            case .failure(let f):
                log.warn("load.catalog.failed kind=\(f.error.kind)")
                return f.error.userMessage
            case .loading:
                return "Capabilities are still loading. Try again."
            }
        } catch is CancellationError {
            return "Loading was cancelled. Reload before editing."
        } catch {
            log.warn("load.catalog.threw")
            return "Couldn't load capabilities."
        }
    }

    func save() async {
        guard !Task.isCancelled, let o = original, isDirty, !isApplying, !baselineNeedsReload, !loading else { return }
        save = .saving
        log.info("save.start")
        let next = nextPutBody(from: o)
        await applyProfile(ProfileMutationPutProfile(previous: o, next: next), receiveApplyState)
        finishInterruptedApply()
    }

    /// Retry runtime application only: never PUT an already-persisted draft again.
    func retryApply() async {
        guard !Task.isCancelled, hasPendingApply, !isApplying, !loading, !baselineNeedsReload, !isDirty else { return }
        save = .restarting
        await applyOnly(receiveApplyState)
        finishInterruptedApply()
    }

    private func receiveApplyState(_ state: any ApplyState) async {
        guard !Task.isCancelled else { return }
        switch onEnum(of: state) {
        case .idle: break
        case .saving: save = .saving
        case .restarting:
            hasPendingApply = true
            baselineNeedsReload = true
            save = .restarting
        case .ready:
            hasPendingApply = false
            await load(reconciling: true)
            guard !Task.isCancelled else { return }
            save = .applied
        case .alreadyApplying:
            save = .alreadyApplying
            requireConfirmedBaseline()
        case .failed(let failure):
            save = .failed(failure.error.userMessage)
            requireConfirmedBaseline()
        }
    }

    private func requireConfirmedBaseline() {
        guard baselineNeedsReload else { return }
        phase = .failed("The saved profile needs confirmation. Reload before editing or discarding; application may still be unresolved.")
    }

    private func finishInterruptedApply() {
        guard save.isBusy else { return }
        // Cancellation/early stream termination is not evidence of rollback,
        // even if the PUT response was lost before Restarting reached Swift.
        baselineNeedsReload = true
        hasPendingApply = true
        save = .failed("Application was interrupted. Reload to confirm the saved profile.")
        requireConfirmedBaseline()
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
            advanced: o.advanced,
            auxiliaryModels: o.auxiliaryModels,
            memory: o.memory
        )
    }
}
