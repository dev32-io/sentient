import SwiftUI

/// Compatibility option model for callers that still use the old row API.
struct SelectOption: Identifiable, Equatable {
    let id: String
    let label: String
}

/// Compatibility facade. `DesignSelect` owns the menu, disabled state, and
/// accessibility semantics.
struct RowSelect: View {
    let label: String
    var sub: String?
    let options: [SelectOption]
    let selectedId: String
    let accessibilityId: String
    var isEnabled: Bool = true
    let onSelect: (String) -> Void

    var body: some View {
        DesignSelect(
            title: label,
            detail: sub,
            options: options.map { (value: $0.id, label: $0.label) },
            selection: Binding(get: { selectedId }, set: onSelect),
            isEnabled: isEnabled,
            accessibilityId: accessibilityId,
            optionAccessibilityId: { "settings-select-option-\($0)" }
        )
    }
}

#Preview {
    VStack(spacing: Space.lg) {
        RowSelect(
            label: "Reasoning",
            options: [
                SelectOption(id: "none", label: "None"),
                SelectOption(id: "low", label: "Low"),
                SelectOption(id: "high", label: "High"),
                SelectOption(id: "xhigh", label: "X-High"),
            ],
            selectedId: "high",
            accessibilityId: "settings-advanced-reasoning",
            onSelect: { _ in }
        )
        RowSelect(
            label: "delegateTask",
            sub: "Hand a task to Hermes in the background.",
            options: [
                SelectOption(id: "allow", label: "Allow"),
                SelectOption(id: "ask", label: "Ask"),
                SelectOption(id: "deny", label: "Deny"),
                SelectOption(id: "off", label: "Off"),
            ],
            selectedId: "ask",
            accessibilityId: "settings-tools-native-delegateTask",
            isEnabled: false,
            onSelect: { _ in }
        )
    }
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
