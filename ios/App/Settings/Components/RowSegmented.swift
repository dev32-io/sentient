// ---------------------------------------------------------------------------
// RowSegmented — pill segmented control, custom-drawn and token-styled to
// match the webui `Segmented` feel (components/settings/primitives/segmented
// .tsx + primitives.css `.seg2`: bg-elev track, paper "on" pill with a soft
// shadow) — NOT the default UIKit/SwiftUI `Picker(.segmented)` look, which
// reads as system chrome rather than Dusk. Used for Memory's slot switch
// (MEMORY.md/USER.md), edit/preview toggles, Model's provider switch, etc.
//
// Stateless leaf: `selectedId` + `onSelect` in, no local state.
// ---------------------------------------------------------------------------
import SwiftUI

private let segmentInnerRadius: CGFloat = 6
private let segmentTrackPadding: CGFloat = 3
private let segmentHeight: CGFloat = 28

struct SegmentOption: Identifiable, Equatable {
    let id: String
    let label: String
}

struct RowSegmented: View {
    let options: [SegmentOption]
    let selectedId: String
    let accessibilityId: String
    let onSelect: (String) -> Void

    var body: some View {
        Picker("Selection", selection: Binding(get: { selectedId }, set: onSelect)) {
            ForEach(options) { option in
                Text(option.label).tag(option.id)
            }
        }
        .pickerStyle(.segmented)
        .font(Typo.ui(TypeScale.base))
        .frame(minHeight: DesignMetrics.minimumTarget)
        .accessibilityIdentifier(accessibilityId)
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
