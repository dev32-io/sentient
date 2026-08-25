// ---------------------------------------------------------------------------
// ToolPermissionRow — one tool's four-state permission control: mono name +
// description + a RowSelect (Allow/Ask/Deny/Off). Shared by ToolsServerCard's
// expanded per-tool list and the Tools screen's "Gateway tools" (native tools)
// card — identical rendering regardless of which catalog array
// (ProductToolGroupView.tools) a tool came from.
// `settable` is what this view branches on to render read-only (a genuinely
// disabled, non-interactive RowSelect) — never the tool's name (`delegateTask`
// is unsettable today only because the catalog says so).
//
// Stateless leaf: `row` + `onChange` in, no local state.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct ToolPermissionRowModel: Identifiable {
    let id: String
    let name: String
    let description: String
    let permission: ToolPermission
    let settable: Bool
}

struct ToolPermissionRow: View {
    let row: ToolPermissionRowModel
    let accessibilityId: String
    let onChange: (ToolPermission) -> Void

    var body: some View {
        RowSelect(
            label: capabilityName(row.name),
            sub: row.description.isEmpty ? nil : row.description,
            options: ToolPermission.selectOptions,
            selectedId: row.permission.wireValue,
            accessibilityId: accessibilityId,
            isEnabled: row.settable,
            onSelect: { value in
                guard let permission = ToolPermission(wireValue: value) else { return }
                onChange(permission)
            }
        )
    }
}

#Preview {
    VStack(spacing: 0) {
        ToolPermissionRow(
            row: ToolPermissionRowModel(
                id: "turn_on", name: "turn_on", description: "Turn a device on.", permission: .allow, settable: true
            ),
            accessibilityId: "settings-tools-tool-home-assistant-turn_on",
            onChange: { _ in }
        )
        ToolPermissionRow(
            row: ToolPermissionRowModel(
                id: "delegateTask", name: "delegateTask", description: "Hand a task to a background assistant.",
                permission: .ask, settable: false
            ),
            accessibilityId: "settings-tools-native-delegateTask",
            onChange: { _ in }
        )
    }
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
