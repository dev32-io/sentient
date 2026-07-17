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
        HStack(spacing: 0) {
            ForEach(options) { option in
                segmentButton(option)
            }
        }
        .padding(segmentTrackPadding)
        .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
        .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(accessibilityId)
    }

    private func segmentButton(_ option: SegmentOption) -> some View {
        let isOn = option.id == selectedId
        return Button {
            onSelect(option.id)
        } label: {
            Text(option.label)
                .font(Typo.ui(TypeScale.sm, isOn ? .semibold : .regular))
                .foregroundStyle(isOn ? DuskColors.ink : DuskColors.ink2)
                .padding(.horizontal, Space.md)
                .frame(maxWidth: .infinity, minHeight: segmentHeight)
                .background(isOn ? DuskColors.paper : Color.clear, in: RoundedRectangle(cornerRadius: segmentInnerRadius))
                .shadow(color: isOn ? .black.opacity(0.18) : .clear, radius: 2, y: 1)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("\(accessibilityId)-\(option.id)")
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
