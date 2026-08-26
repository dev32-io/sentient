import SwiftUI

/// Compatibility option model for callers that still use the old row API.
struct SegmentOption: Identifiable, Equatable {
    let id: String
    let label: String
}

/// Compatibility facade. `DesignSegmentedPicker` is the canonical primitive.
struct RowSegmented: View {
    let options: [SegmentOption]
    let selectedId: String
    let accessibilityId: String
    let onSelect: (String) -> Void

    var body: some View {
        DesignSegmentedPicker(
            title: "Selection",
            options: options.map { (value: $0.id, label: $0.label) },
            selection: Binding(get: { selectedId }, set: onSelect),
            accessibilityId: accessibilityId
        )
    }
}

#Preview {
    RowSegmented(
        options: [
            SegmentOption(id: "memory", label: "MEMORY.md"),
            SegmentOption(id: "user", label: "USER.md"),
        ],
        selectedId: "memory",
        accessibilityId: "settings-memory-slot",
        onSelect: { _ in }
    )
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
