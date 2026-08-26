// ---------------------------------------------------------------------------
// ToolsServerCard — one MCP server section on the Tools page: a header row
// (chevron + server id + active/total count + master on/off toggle) and, when
// expanded, a per-tool ToolPermissionRow list (Allow/Ask/Deny/Off dropdown per
// tool). Transcribed from the webui tools-pane McpServerSection — the master
// toggle writes every named tool + the wildcard in bulk (see ToolsViewModel's
// setServerMaster), but each tool's own row stays visible and independently
// editable regardless of the master's current state; there is no "server is
// off, tools hidden" placeholder any more (dropped along with the old
// enabled-map boolean model).
//
// Stateless leaf: the screen resolves the catalog + pending-edit overlay (via
// the VM) into plain values + `toolRows`, so this view holds no VM and no
// policy — it only lays out and dispatches taps.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct ToolsServerCard: View {
    let id: String
    let serverDescription: String?
    let masterOn: Bool
    let isOpen: Bool
    let activeCount: Int
    let totalCount: Int
    let toolRows: [ToolPermissionRowModel]
    let onToggleOpen: () -> Void
    let onToggleServer: (Bool) -> Void
    let onToolChange: (String, ToolPermission) -> Void

    var body: some View {
        SettingsCard {
            header
            if isOpen { expandedBody }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(alignment: .center, spacing: Space.sm) {
                Button(action: onToggleOpen) {
                    HStack(spacing: Space.sm) {
                        Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                            .accessibilityHidden(true)
                        Text(capabilityName(id))
                            .font(Typo.ui(TypeScale.base, .semibold))
                            .foregroundStyle(DuskColors.ink)
                    }
                    .frame(minHeight: DesignMetrics.minimumTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(isOpen ? "Collapse" : "Expand") \(capabilityName(id))")
                .accessibilityIdentifier("settings-tools-server-expand-\(id)")

                Spacer(minLength: Space.sm)
                Toggle("Enable \(capabilityName(id))", isOn: Binding(get: { masterOn }, set: onToggleServer))
                    .labelsHidden()
                    .tint(DuskColors.accent)
                    .accessibilityIdentifier("settings-tools-server-\(id)")
            }
            if let serverDescription, !serverDescription.isEmpty {
                Text(serverDescription)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink3)
            }
            Text("\(activeCount) of \(totalCount) capabilities enabled")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
        }
        .padding(.vertical, Space.sm)
    }

    @ViewBuilder
    private var expandedBody: some View {
        Divider().background(DuskColors.lineSoft)
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
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.ink4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Space.sm)
    }
}

#Preview {
    ScrollView {
        VStack(spacing: Space.lg) {
            ToolsServerCard(
                id: "home-assistant", serverDescription: "Smart-home control.",
                masterOn: true, isOpen: true, activeCount: 2, totalCount: 3,
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
                masterOn: false, isOpen: false, activeCount: 0, totalCount: 1,
                toolRows: [], onToggleOpen: {}, onToggleServer: { _ in }, onToolChange: { _, _ in }
            )
        }
        .padding(Space.lg)
    }
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
