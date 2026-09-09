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
    @State private var permissionGuideOpen = false
    @State private var showDiscard = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: ToolsViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(
            title: "Tools", screenId: "settings-tools-screen",
            onBack: attemptBack, allowsInteractiveBack: !vm.isDirty,
            backAccessibilityId: "settings-tools-back"
        ) {
            switch vm.phase {
            case .loading:
                SoulLoadingRow()
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load capabilities", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                capabilityOverview
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

    private var capabilityOverview: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Text("Control what Sentient can use")
                .designText(.label)
                .fontWeight(.semibold)
                .foregroundStyle(DuskColors.ink)
                .accessibilityAddTraits(.isHeader)
            Text("Role and resource access checks still apply to every request.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
            DesignDisclosureGroup(isExpanded: permissionGuideOpen) {
                DesignDisclosureButton(
                    isExpanded: permissionGuideOpen,
                    accessibilityLabel: "Permission meanings: Allow, Ask, Deny, Off",
                    accessibilityId: "settings-tools-permission-guide",
                    action: { permissionGuideOpen.toggle() }
                ) {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text("Permission meanings")
                            .designText(.label)
                            .foregroundStyle(DuskColors.ink)
                        Text(ToolPermission.selectOptions.map(\.label).joined(separator: " · "))
                            .designText(.supporting)
                            .foregroundStyle(DuskColors.ink2)
                    }
                }
            } content: {
                VStack(alignment: .leading, spacing: Space.sm) {
                    ForEach(ToolPermission.selectOptions, id: \.id) { option in
                        if let permission = ToolPermission(wireValue: option.id) {
                            Text("\(option.label) · \(permission.meaning)")
                                .designText(.supporting)
                                .foregroundStyle(DuskColors.ink2)
                        }
                    }
                }
            }
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
        return ToolsServerCard(
            id: id,
            serverDescription: entry.description_,
            masterOn: vm.isGroupMasterOn(id, entry),
            isOpen: openServers.contains(id),
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
        DesignCard {
            DesignDisclosureGroup(isExpanded: builtInsOpen) {
                DesignDisclosureButton(
                    isExpanded: builtInsOpen,
                    accessibilityLabel: builtInsOpen ? "Collapse built-in capabilities" : "Expand built-in capabilities",
                    accessibilityId: "settings-tools-hermes-expand",
                    action: { builtInsOpen.toggle() }
                ) {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: Space.sm) {
                            builtInHeading
                            Spacer(minLength: Space.sm)
                            enabledCount(vm.hermesActiveCount(builtins), total: builtins.count)
                        }
                        VStack(alignment: .leading, spacing: Space.xs) {
                            builtInHeading
                            enabledCount(vm.hermesActiveCount(builtins), total: builtins.count)
                        }
                    }
                }
            } content: {
                ForEach(builtins, id: \.name) { tool in
                    DesignToggleRow(
                        title: capabilityName(tool.name),
                        detail: builtInDetail(tool.description, toolset: tool.toolset),
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

    private var builtInHeading: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text("Built-in capabilities")
                .designText(.label)
                .fontWeight(.semibold)
                .foregroundStyle(DuskColors.ink)
            Text("Related capabilities may be enabled or disabled together.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
        }
    }

    private func enabledCount(_ count: Int, total: Int) -> some View {
        Text("\(count) of \(total) enabled")
            .designText(.caption)
            .foregroundStyle(DuskColors.ink2)
    }

    private func builtInDetail(_ description: String, toolset: String) -> String {
        let group = capabilityName(toolset)
        return description.isEmpty ? group : "\(description) · \(group)"
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
                masterOn: true, isOpen: true,
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
