// ---------------------------------------------------------------------------
// ToolsViewModel — the Tools settings page state holder. SLOW save: the profile
// PUT changes `tools` (non-audio), so ApplyProfileChangeUseCase runs the
// PUT-then-apply path that blocks through a Hermes worker restart.
//
// The enabled-map semantics are pinned to the webui tools-pane EXACTLY:
//   • A server is ENABLED iff its id is a KEY in `enabled` (absent key = off).
//   • Toggling a server ON materializes the operator `defaultInclude` whitelist
//     as the value (NOT an empty list) so per-tool checkboxes start canonical.
//   • An EMPTY list value = "inherit the operator default" — it is materialized
//     to `defaultInclude` before a per-tool edit so opting one tool out does not
//     flip the whole server off.
//   • `toolsets` is a flat list of enabled Hermes built-in toolset names;
//     flipping any built-in tool toggles its whole toolset.
//
// Dirty compares the Swift-native draft map/list (both Equatable), never the KMP
// ProfileV1 (not Swift-Equatable).
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

    /// Draft tool state (Swift-native, Equatable → drives dirty detection).
    private(set) var draftEnabled: [String: [String]] = [:]
    private(set) var draftToolsets: [String] = []

    private var original: ProfileV1?
    private let settings: SettingsComponent
    private let log = AppLog("settings", "tools-vm")

    init(settings: SettingsComponent) {
        self.settings = settings
    }

    var isDirty: Bool {
        guard let o = original else { return false }
        return draftEnabled != o.tools.enabled || draftToolsets != (o.tools.toolsets ?? [])
    }

    var isApplying: Bool { save == .saving || save == .restarting }

    /// MCP server ids in a stable sorted order.
    var serverIds: [String] { (catalog?.servers.keys).map { $0.sorted() } ?? [] }

    // ── Read helpers (pin webui display semantics) ──

    func isServerEnabled(_ id: String) -> Bool { draftEnabled[id] != nil }

    /// The tool names counted "active": the user's explicit list when non-empty,
    /// else the inherited operator default.
    func activeNames(_ id: String, _ entry: McpCatalogEntry) -> [String] {
        if let userInclude = draftEnabled[id], !userInclude.isEmpty { return userInclude }
        return entry.defaultInclude
    }

    func isToolActive(_ id: String, _ tool: String, _ entry: McpCatalogEntry) -> Bool {
        guard isServerEnabled(id) else { return false }
        return activeNames(id, entry).contains(tool)
    }

    func isToolsetOn(_ toolset: String) -> Bool { draftToolsets.contains(toolset) }

    func hermesActiveCount(_ tools: [HermesBuiltinToolView]) -> Int {
        tools.filter { draftToolsets.contains($0.toolset) }.count
    }

    // ── Mutations (pin webui write semantics) ──

    func toggleServer(_ id: String, _ defaultInclude: [String]) {
        if draftEnabled[id] != nil {
            draftEnabled[id] = nil
        } else {
            draftEnabled[id] = defaultInclude
        }
        log.info("toggle.server id=\(id) on=\(draftEnabled[id] != nil)")
    }

    func toggleTool(_ id: String, _ tool: String, _ defaultInclude: [String]) {
        guard let current = draftEnabled[id] else { return }
        let baseline = current.isEmpty ? defaultInclude : current
        if baseline.contains(tool) {
            draftEnabled[id] = baseline.filter { $0 != tool }
        } else {
            draftEnabled[id] = baseline + [tool]
        }
    }

    func toggleToolset(_ toolset: String) {
        if draftToolsets.contains(toolset) {
            draftToolsets.removeAll { $0 == toolset }
        } else {
            draftToolsets.append(toolset)
        }
        log.info("toggle.toolset toolset=\(toolset) on=\(draftToolsets.contains(toolset))")
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
        let next = nextProfile(from: o)
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
        draftEnabled = profile.tools.enabled
        draftToolsets = profile.tools.toolsets ?? []
    }

    private func nextProfile(from o: ProfileV1) -> ProfileV1 {
        ProfileV1(
            schemaVersion: o.schemaVersion,
            userId: o.userId,
            model: o.model,
            voice: o.voice,
            audio: o.audio,
            persona: o.persona,
            tools: ProfileTools(enabled: draftEnabled, toolsets: draftToolsets),
            compression: o.compression,
            advanced: o.advanced,
            devices: o.devices
        )
    }
}
