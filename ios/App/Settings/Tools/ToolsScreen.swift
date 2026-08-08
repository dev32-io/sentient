// ---------------------------------------------------------------------------
// ToolsScreen — Soul-group "Tools" category page. A per-MCP-server card (master
// on/off toggle + expandable per-tool Allow/Ask/Deny/Off dropdowns) for each
// catalog server, a "Gateway tools" card for native tools with no MCP server —
// most (skill tools) are per-person settable under the reserved "native"
// permission namespace, delegateTask stays role-governed/read-only — and the
// Hermes built-in toolsets card. SLOW save (PUT profile → apply-with-restart).
//
// The permission-resolution semantics live in ToolsViewModel (pinned to the
// webui tools-pane); this view resolves them into stateless ToolsServerCard /
// ToolPermissionRow inputs. Save chrome + discard-on-dirty-back are shared
// SoulPageChrome pieces.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct ToolsScreen: View {
    /// Reserved MCP-server key the gateway resolves the "Gateway tools" card's
    /// SETTABLE rows (skill tools) under — mirrors
    /// `io.sentient.mobilesdk.settings.NATIVE_TOOL_SERVER_KEY` (shared/mobile-sdk)
    /// EXACTLY, which mirrors gateway/shared/config's `NATIVE_TOOL_SERVER_KEY`
    /// ("native") in turn. Kept as a local literal rather than importing the
    /// Kotlin `const val` because SKIE only re-exports it after a fresh
    /// `ios-setup.sh` framework build; if the gateway's sentinel ever changes,
    /// this must change with it.
    private static let nativeToolServerKey = "native"

    let settings: SettingsComponent
    let onBack: () -> Void

    @State private var vm: ToolsViewModel
    @State private var openServers: Set<String> = []
    @State private var hermesOpen = true
    @State private var showDiscard = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: ToolsViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(title: "Tools", screenId: "settings-tools-screen") {
            switch vm.phase {
            case .loading:
                SoulLoadingRow()
            case .failed(let message):
                SoulInlineError(message: message)
            case .ready:
                saveBanner
                serversSection
                nativeToolsCard
                hermesCard
            }
        }
        // Clean → system back button (native interactive edge-swipe pop). Dirty →
        // hide it + show the custom back that routes through the discard confirm
        // (gesture is intentionally disabled only while a draft is unsaved).
        .navigationBarBackButtonHidden(vm.isDirty)
        .toolbar {
            if vm.isDirty {
                ToolbarItem(placement: .navigation) {
                    SoulBackButton(accessibilityId: "settings-tools-back", action: attemptBack)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    SoulSaveButton(disabled: vm.isApplying, accessibilityId: "settings-tools-save") {
                        Task { await vm.save() }
                    }
                }
            }
        }
        .task { await vm.load() }
        .confirmationDialog("Discard changes?", isPresented: $showDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { onBack() }
            Button("Keep editing", role: .cancel) {}
        }
    }

    @ViewBuilder
    private var saveBanner: some View {
        switch vm.save {
        case .idle: EmptyView()
        case .saving: SoulApplyingBanner(text: "Saving…")
        case .restarting: SoulApplyingBanner(text: "Applying — assistant restarting…")
        case .alreadyApplying: SoulNoticeBanner(text: soulAlreadyApplyingText)
        case .failed(let message): SoulInlineError(message: message)
        }
    }

    @ViewBuilder
    private var serversSection: some View {
        if vm.serverIds.isEmpty {
            Text("No tools configured. An admin can add them in gateway/config.yaml#mcp_catalog.")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
        } else {
            ForEach(vm.serverIds, id: \.self) { id in
                if let entry = vm.catalog?.servers[id] {
                    serverCard(id, entry)
                }
            }
        }
    }

    private func serverCard(_ id: String, _ entry: McpCatalogEntry) -> some View {
        let rows = entry.tools.map { tool in
            ToolPermissionRowModel(
                id: tool.name,
                name: tool.name,
                description: tool.description,
                permission: vm.toolPermission(id, tool),
                settable: tool.settable
            )
        }
        let activeCount = rows.filter { $0.permission != .off }.count
        return ToolsServerCard(
            id: id,
            serverDescription: entry.description,
            masterOn: vm.isServerMasterOn(id, entry),
            isOpen: openServers.contains(id),
            activeCount: activeCount,
            totalCount: entry.tools.count,
            toolRows: rows,
            onToggleOpen: { toggleOpen(id) },
            onToggleServer: { turnOn in vm.setServerMaster(id, entry.tools.map { $0.name }, turnOn) },
            onToolChange: { toolName, permission in vm.setToolPermission(id, toolName, permission) }
        )
    }

    @ViewBuilder
    private var nativeToolsCard: some View {
        let nativeTools = vm.catalog?.nativeTools ?? []
        if !nativeTools.isEmpty {
            SettingsCard(
                title: "Gateway tools",
                sub: "Built into the gateway itself, not an MCP server. Most rows (skill tools) are governed per-person like any other tool; delegateTask is governed by role only — no stored key can address it yet."
            ) {
                ForEach(nativeTools, id: \.name) { tool in
                    ToolPermissionRow(
                        row: ToolPermissionRowModel(
                            id: tool.name,
                            name: tool.name,
                            description: tool.description,
                            // Most native rows (skill tools) resolve their stored
                            // override under `nativeToolServerKey` — read pending
                            // edits through `vm.toolPermission` exactly like an MCP
                            // server's own tool, never `tool.permission` directly.
                            // That was the bug: reading the catalog snapshot
                            // unconditionally was safe only while every native tool
                            // was `settable: false`, and silently ignored this
                            // session's edits once skill_* tools became settable.
                            // delegateTask (`settable: false`) has no stored address
                            // at all, so it always falls back to its catalog-resolved
                            // snapshot regardless.
                            permission: vm.toolPermission(Self.nativeToolServerKey, tool),
                            settable: tool.settable
                        ),
                        accessibilityId: "settings-tools-native-\(tool.name)",
                        onChange: { permission in
                            // ToolPermissionRow already renders delegateTask fully
                            // non-interactive (isEnabled: row.settable), but this
                            // guard stays explicit: a serverless native tool
                            // (serverName: nil) has no resolver branch that would
                            // ever read a write back, so writing one anyway would be
                            // silently discarded, not merely redundant.
                            guard tool.settable else { return }
                            vm.setToolPermission(Self.nativeToolServerKey, tool.name, permission)
                        }
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var hermesCard: some View {
        let builtins = (vm.catalog?.hermesBuiltins ?? []).sorted {
            $0.toolset == $1.toolset ? $0.name < $1.name : $0.toolset < $1.toolset
        }
        SettingsCard(
            title: "Hermes built-in tools",
            sub: "Toggles operate on toolset groups — flipping any tool flips its whole group."
        ) {
            HStack {
                Text("\(vm.hermesActiveCount(builtins))/\(builtins.count) tools")
                    .font(Typo.ui(TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
                Spacer()
                Button(action: { hermesOpen.toggle() }) {
                    Image(systemName: hermesOpen ? "chevron.down" : "chevron.right")
                        .font(.system(size: TypeScale.xs, weight: .semibold))
                        .foregroundStyle(DuskColors.ink3)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("settings-tools-hermes-expand")
            }
            .padding(.vertical, Space.sm)
            if hermesOpen {
                ForEach(builtins, id: \.name) { tool in
                    RowToggle(
                        label: tool.name,
                        sub: tool.description.isEmpty ? tool.toolset : "\(tool.description) · \(tool.toolset)",
                        isOn: vm.isToolsetOn(tool.toolset),
                        accessibilityId: "settings-tools-builtin-\(tool.name)",
                        onChange: { _ in vm.toggleToolset(tool.toolset) }
                    )
                }
            }
        }
    }

    private func toggleOpen(_ id: String) {
        if openServers.contains(id) { openServers.remove(id) } else { openServers.insert(id) }
    }

    private func attemptBack() {
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}

#Preview("servers") {
    NavigationStack {
        SettingsPageScaffold(title: "Tools", screenId: "settings-tools-screen") {
            ToolsServerCard(
                id: "home-assistant", serverDescription: "Smart-home control.",
                masterOn: true, isOpen: true, activeCount: 1, totalCount: 2,
                toolRows: [
                    ToolPermissionRowModel(
                        id: "1", name: "turn_on", description: "Turn a device on.", permission: .allow, settable: true
                    ),
                    ToolPermissionRowModel(
                        id: "2", name: "turn_off", description: "Turn a device off.", permission: .off, settable: true
                    ),
                ],
                onToggleOpen: {}, onToggleServer: { _ in }, onToolChange: { _, _ in }
            )
        }
    }
    .preferredColorScheme(.dark)
}
