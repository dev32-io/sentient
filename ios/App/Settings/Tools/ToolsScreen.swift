// ---------------------------------------------------------------------------
// ToolsScreen — Soul-group "Tools" category page. A per-MCP-server card (master
// toggle + expandable per-tool toggles) for each catalog server, plus the Hermes
// built-in toolsets card. SLOW save (PUT profile → apply-with-restart).
//
// The enabled-map semantics live in ToolsViewModel (pinned to the webui
// tools-pane); this view resolves them into stateless ToolsServerCard inputs.
// Save chrome + discard-on-dirty-back are shared SoulPageChrome pieces.
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
        let enabled = vm.isServerEnabled(id)
        let rows = entry.tools.map { tool in
            ToolToggleRow(
                id: tool.name,
                name: tool.name,
                description: tool.description,
                isOn: vm.isToolActive(id, tool.name, entry)
            )
        }
        return ToolsServerCard(
            id: id,
            serverDescription: entry.description,
            isEnabled: enabled,
            isOpen: openServers.contains(id),
            activeCount: enabled ? vm.activeNames(id, entry).count : 0,
            totalCount: entry.tools.count,
            toolRows: rows,
            onToggleOpen: { toggleOpen(id) },
            onToggleServer: { _ in vm.toggleServer(id, entry.defaultInclude) },
            onToggleTool: { vm.toggleTool(id, $0, entry.defaultInclude) }
        )
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
                isEnabled: true, isOpen: true, activeCount: 1, totalCount: 2,
                toolRows: [
                    ToolToggleRow(id: "1", name: "turn_on", description: "Turn a device on.", isOn: true),
                    ToolToggleRow(id: "2", name: "turn_off", description: "Turn a device off.", isOn: false),
                ],
                onToggleOpen: {}, onToggleServer: { _ in }, onToggleTool: { _ in }
            )
        }
    }
    .preferredColorScheme(.dark)
}
