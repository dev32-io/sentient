// ---------------------------------------------------------------------------
// ToolsScreen — Soul-group "Tools" category page. A per-MCP-server card (master
// on/off toggle + expandable per-tool Allow/Ask/Deny/Off dropdowns) for each
// catalog server, a "Gateway tools" card for role-governed native tools with no
// MCP server (settable: false today — read-only), and the Hermes built-in
// toolsets card. SLOW save (PUT profile → apply-with-restart).
//
// The permission-resolution semantics live in ToolsViewModel (pinned to the
// webui tools-pane); this view resolves them into stateless ToolsServerCard /
// ToolPermissionRow inputs. Save chrome + discard-on-dirty-back are shared
// SoulPageChrome pieces.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct ToolsScreen: View {
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
                sub: "Built into the gateway itself, not an MCP server — governed by role until a later release lets a person override it."
            ) {
                ForEach(nativeTools, id: \.name) { tool in
                    ToolPermissionRow(
                        row: ToolPermissionRowModel(
                            id: tool.name,
                            name: tool.name,
                            description: tool.description,
                            permission: tool.permission,
                            settable: tool.settable
                        ),
                        accessibilityId: "settings-tools-native-\(tool.name)",
                        onChange: { _ in
                            // Unreachable: `settable` is false for every native tool
                            // today (delegateTask), and ToolPermissionRow renders a
                            // disabled RowSelect underneath.
                            //
                            // FLIPPING `settable` SERVER-SIDE WOULD NOT BE ENOUGH. A
                            // native tool has no MCP server, and
                            // `resolveToolPermission`'s `serverName: null` branch
                            // returns before any stored table is consulted — so no key
                            // a client can write is ever read back for one. Flipping
                            // the flag alone would make this row tappable and silently
                            // discard every selection. Making a native tool settable
                            // needs a gateway-side address for it first (a reserved
                            // server key, or a second map keyed by tool name) plus a
                            // resolver branch that reads it; then a real write here.
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
