// ---------------------------------------------------------------------------
// ToolsServerCard — one MCP server section on the Tools page: a header row
// (chevron + server id + active/total count + master toggle) and, when expanded
// AND enabled, a per-tool toggle list. Transcribed from the webui tools-pane
// McpServerSection.
//
// Stateless leaf: the screen resolves the enabled-map semantics (via the VM) into
// plain values + `toolRows`, so this view holds no VM and no policy — it only
// lays out and dispatches taps.
// ---------------------------------------------------------------------------
import SwiftUI

/// A resolved per-tool row (the enabled-map math is done by the screen/VM).
struct ToolToggleRow: Identifiable {
    let id: String
    let name: String
    let description: String
    let isOn: Bool
}

struct ToolsServerCard: View {
    let id: String
    let serverDescription: String?
    let isEnabled: Bool
    let isOpen: Bool
    let activeCount: Int
    let totalCount: Int
    let toolRows: [ToolToggleRow]
    let onToggleOpen: () -> Void
    let onToggleServer: (Bool) -> Void
    let onToggleTool: (String) -> Void

    var body: some View {
        SettingsCard {
            header
            if isOpen { expandedBody }
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: Space.sm) {
            Button(action: onToggleOpen) {
                Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                    .font(.system(size: TypeScale.xs, weight: .semibold))
                    .foregroundStyle(DuskColors.ink3)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings-tools-server-expand-\(id)")

            VStack(alignment: .leading, spacing: Space.xs) {
                Text(id)
                    .font(Typo.mono(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink)
                if let serverDescription, !serverDescription.isEmpty {
                    Text(serverDescription)
                        .font(Typo.ui(TypeScale.xs))
                        .foregroundStyle(DuskColors.ink3)
                }
            }
            Spacer(minLength: Space.sm)
            Text(isEnabled ? "\(activeCount)/\(totalCount) tools" : "off")
                .font(Typo.ui(TypeScale.xs))
                .foregroundStyle(DuskColors.ink3)
            Toggle("", isOn: Binding(get: { isEnabled }, set: onToggleServer))
                .labelsHidden()
                .tint(DuskColors.accent)
                .accessibilityIdentifier("settings-tools-server-\(id)")
        }
        .padding(.vertical, Space.sm)
    }

    @ViewBuilder
    private var expandedBody: some View {
        Divider().background(DuskColors.lineSoft)
        if !isEnabled {
            placeholder("Server is off. Toggle on to enable and configure individual tools.")
        } else if toolRows.isEmpty {
            placeholder("No tools declared for this server.")
        } else {
            ForEach(toolRows) { row in
                RowToggle(
                    label: row.name,
                    sub: row.description.isEmpty ? nil : row.description,
                    isOn: row.isOn,
                    accessibilityId: "settings-tools-tool-\(id)-\(row.name)",
                    onChange: { _ in onToggleTool(row.name) }
                )
            }
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .font(Typo.ui(TypeScale.xs))
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
                isEnabled: true, isOpen: true, activeCount: 2, totalCount: 3,
                toolRows: [
                    ToolToggleRow(id: "1", name: "turn_on", description: "Turn a device on.", isOn: true),
                    ToolToggleRow(id: "2", name: "turn_off", description: "Turn a device off.", isOn: true),
                    ToolToggleRow(id: "3", name: "set_temp", description: "Set a thermostat.", isOn: false),
                ],
                onToggleOpen: {}, onToggleServer: { _ in }, onToggleTool: { _ in }
            )
            ToolsServerCard(
                id: "web-search", serverDescription: nil,
                isEnabled: false, isOpen: false, activeCount: 0, totalCount: 1,
                toolRows: [], onToggleOpen: {}, onToggleServer: { _ in }, onToggleTool: { _ in }
            )
        }
        .padding(Space.lg)
    }
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
