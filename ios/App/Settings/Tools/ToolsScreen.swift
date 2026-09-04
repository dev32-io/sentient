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
// ToolPermissionRow inputs. The shared apply bar receives the existing dirty,
// save, and native discard-confirmation actions.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct ToolsScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    @State private var vm: ToolsViewModel
    @State private var openServers: Set<String> = []
    @State private var builtInsOpen = true
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
                AsyncNotice(kind: .error, title: "Couldn't load capabilities", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                groupsSection
                builtInCard
            }
        }
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "settings-tools-discard",
            applyAccessibilityId: "settings-tools-save",
            onDiscard: attemptBack,
            onApply: { Task { await vm.save() } }
        )
        // Clean → system back button (native interactive edge-swipe pop). Dirty →
        // hide it + show the custom back that shares the apply bar's discard confirm
        // (gesture is intentionally disabled only while a draft is unsaved).
        .navigationBarBackButtonHidden(vm.isDirty)
        .toolbar {
            if vm.isDirty {
                ToolbarItem(placement: .navigation) {
                    SoulBackButton(accessibilityId: "settings-tools-back", action: attemptBack)
                }
            }
        }
        .task { await vm.load() }
        .confirmationDialog("Discard changes?", isPresented: $showDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { onBack() }
            Button("Keep editing", role: .cancel) {}
        }
    }

    private var applyState: DesignApplyState {
        switch vm.save {
        case .idle: .idle
        case .saving: .saving
        case .restarting: .restarting
        case .alreadyApplying: .alreadyApplying
        case .applied: .applied
        case .failed(let message): .failed(message)
        }
    }

    @ViewBuilder
    private var groupsSection: some View {
        if vm.groupIds.isEmpty {
            AsyncNotice(
                kind: .empty,
                title: "No connected capabilities",
                detail: "Built-in capabilities are still available below."
            )
            .accessibilityIdentifier("settings-tools-empty")
        } else {
            ForEach(vm.groupIds, id: \.self) { id in
                if let entry = vm.catalog?.groups[id] {
                    groupCard(id, entry)
                }
            }
        }
    }

    private func groupCard(_ id: String, _ entry: ProductToolGroupView) -> some View {
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
            serverDescription: entry.description_ ?? "Choose which capabilities are available.",
            masterOn: vm.isGroupMasterOn(id, entry),
            isOpen: openServers.contains(id),
            activeCount: activeCount,
            totalCount: entry.tools.count,
            toolRows: rows,
            onToggleOpen: { toggleOpen(id) },
            onToggleServer: { turnOn in vm.setGroupMaster(id, entry.tools.map { $0.name }, turnOn) },
            onToolChange: { toolName, permission in vm.setToolPermission(id, toolName, permission) }
        )
    }

    @ViewBuilder
    private var builtInCard: some View {
        let builtins = (vm.catalog?.hermesBuiltins ?? []).sorted {
            $0.toolset == $1.toolset ? $0.name < $1.name : $0.toolset < $1.toolset
        }
        DesignCard(
            title: "Built-in capabilities",
            detail: "Related capabilities may be enabled or disabled together."
        ) {
            DesignDisclosureGroup(isExpanded: builtInsOpen) {
                DesignDisclosureButton(
                    isExpanded: builtInsOpen,
                    accessibilityLabel: builtInsOpen ? "Collapse built-in capabilities" : "Expand built-in capabilities",
                    accessibilityId: "settings-tools-hermes-expand",
                    action: { builtInsOpen.toggle() }
                ) {
                    Text("\(vm.hermesActiveCount(builtins)) of \(builtins.count) enabled")
                        .designText(.caption)
                        .foregroundStyle(DuskColors.ink3)
                }
            } content: {
                ForEach(builtins, id: \.name) { tool in
                    DesignToggleRow(
                        title: capabilityName(tool.name),
                        detail: tool.description.isEmpty ? tool.toolset : "\(tool.description) · \(tool.toolset)",
                        isOn: Binding(
                            get: { vm.isToolsetOn(tool.toolset) },
                            set: { _ in vm.toggleToolset(tool.toolset) }
                        ),
                        accessibilityId: "settings-tools-builtin-\(tool.name)"
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
