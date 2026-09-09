// ---------------------------------------------------------------------------
// ToolsServerCard — one product capability group, using the catalog's exact id.
// A single disclosure contains the bulk master and all per-tool permissions.
// Counts describe the displayed permission snapshot, not execution authority.
// The screen supplies shared-helper readbacks; this leaf only dispatches intent.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct ToolsServerCard: View {
    let id: String
    let serverDescription: String?
    let masterOn: Bool
    let isOpen: Bool
    let toolRows: [ToolPermissionRowModel]
    let onToggleOpen: () -> Void
    let onToggleServer: (Bool) -> Void
    let onToolChange: (String, ToolPermission) -> Void

    var body: some View {
        DesignCard {
            DesignDisclosureGroup(isExpanded: isOpen) {
                header
            } content: {
                expandedBody
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            disclosureButton
            if let serverDescription, !serverDescription.isEmpty {
                Text(serverDescription)
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.ink2)
            }
        }
    }

    private var disclosureButton: some View {
        DesignDisclosureButton(
            isExpanded: isOpen,
            accessibilityLabel: "\(isOpen ? "Collapse" : "Expand") \(capabilityName(id))",
            accessibilityId: "settings-tools-server-expand-\(id)",
            action: onToggleOpen
        ) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(capabilityName(id))
                    .designText(.label)
                    .fontWeight(.semibold)
                    .foregroundStyle(DuskColors.ink)
                Text("Shown permissions · \(permissionSummary)")
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.ink2)
            }
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityHint("Shown permissions · \(permissionSummary)")
    }

    private var permissionSummary: String {
        ToolPermission.selectOptions.map { option in
            let count = toolRows.filter { $0.permission.wireValue == option.id }.count
            return "\(count) \(option.label)"
        }.joined(separator: " · ")
    }

    private var serverToggle: some View {
        DesignToggleRow(
            title: "Group master",
            detail: "Off sets listed tools and the group default to Off. On clears those overrides back to role defaults, not blanket Allow. Per-tool choices remain editable below; role defaults refresh after Apply.",
            isOn: Binding(get: { masterOn }, set: onToggleServer),
            accessibilityId: "settings-tools-server-\(id)"
        )
        .accessibilityLabel("\(capabilityName(id)) group master")
    }

    @ViewBuilder
    private var expandedBody: some View {
        DesignDivider()
        serverToggle
        DesignDivider()
        if toolRows.isEmpty {
            placeholder("No tools declared for this server.")
        } else {
            ForEach(toolRows) { row in
                ToolPermissionRow(
                    row: row,
                    accessibilityId: "settings-tools-tool-\(id)-\(row.name)",
                    onChange: { onToolChange(row.name, $0) }
                )
            }
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .designText(.supporting)
            .foregroundStyle(DuskColors.ink2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Space.sm)
    }
}

#Preview {
    ScrollView {
        VStack(spacing: Space.lg) {
            ToolsServerCard(
                id: "home-assistant", serverDescription: "Smart-home control.",
                masterOn: true, isOpen: true,
                toolRows: [
                    ToolPermissionRowModel(
                        id: "1", name: "turn_on", description: "Turn a device on.", permission: .allow, settable: true
                    ),
                    ToolPermissionRowModel(
                        id: "2", name: "turn_off", description: "Turn a device off.", permission: .ask, settable: true
                    ),
                    ToolPermissionRowModel(
                        id: "3", name: "set_temp", description: "Set a thermostat.", permission: .off, settable: true
                    ),
                ],
                onToggleOpen: {}, onToggleServer: { _ in }, onToolChange: { _, _ in }
            )
            ToolsServerCard(
                id: "web-search", serverDescription: nil,
                masterOn: false, isOpen: false,
                toolRows: [], onToggleOpen: {}, onToggleServer: { _ in }, onToolChange: { _, _ in }
            )
        }
        .padding(Space.lg)
    }
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
