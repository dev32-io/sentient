import SwiftUI

enum VoiceRowAccessory: Equatable {
    case none, activePill, check
}

struct VoiceRowView: View {
    let name: String
    var lang: String = ""
    var source: String?
    var description: String = ""
    var tags: [String] = []
    var isPlaying = false
    var isLoading = false
    var playDisabled = false
    var isSelected = false
    var accessory: VoiceRowAccessory = .none
    let accessibilityId: String
    let onSelect: () -> Void
    let onPlay: () -> Void
    var onDelete: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: Space.md) {
            iconButton(
                playIcon, label: isPlaying ? "Stop preview" : "Play preview",
                disabled: playDisabled || isLoading, action: onPlay
            )
            .accessibilityIdentifier("\(accessibilityId)-play")
            Button(action: onSelect) {
                meta
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .accessibilityLabel(name)
            accessoryView
            if let onDelete {
                iconButton("trash", label: "Delete \(name)", tint: DuskColors.stop, action: onDelete)
                    .accessibilityIdentifier("\(accessibilityId)-delete")
            }
        }
        .padding(Space.md)
        .designPlate()
        .overlay {
            RoundedRectangle(cornerRadius: Radii.md, style: .continuous)
                .stroke(isSelected ? DuskColors.accent : .clear, lineWidth: DesignMetrics.hairline)
        }
        .accessibilityElement(children: .contain)
        .accessibilityValue(rowAccessibilityValue)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(accessibilityId)
    }

    private func iconButton(
        _ systemName: String, label: String, tint: Color = DuskColors.ink2,
        disabled: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .foregroundStyle(tint)
                .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(label)
        .accessibilityValue(disabled ? "Disabled" : isLoading ? "Loading" : isPlaying ? "Playing" : "Ready")
    }

    private var playIcon: String {
        if isPlaying { return "pause.fill" }
        if isLoading { return "waveform" }
        return "play.fill"
    }

    private var meta: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(name)
                .font(Typo.ui(TypeScale.base, .semibold))
                .foregroundStyle(DuskColors.ink)
                .lineLimit(2)
            if !lang.isEmpty || source?.isEmpty == false {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Space.xs) { metadata }
                    VStack(alignment: .leading, spacing: Space.xs) { metadata }
                }
            }
            if !description.isEmpty {
                Text(description)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink3)
                    .lineLimit(3)
            }
            if !tags.isEmpty {
                Text(tags.prefix(VoiceSurfaceLayout.visibleTagLimit).joined(separator: " · "))
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
                    .lineLimit(2)
            }
        }
        .multilineTextAlignment(.leading)
    }

    @ViewBuilder private var metadata: some View {
        if !lang.isEmpty {
            Text(lang.uppercased()).foregroundStyle(DuskColors.accent)
        }
        if let source, !source.isEmpty {
            Text(source).foregroundStyle(DuskColors.ink3)
        }
    }

    @ViewBuilder private var accessoryView: some View {
        switch accessory {
        case .none: EmptyView()
        case .activePill:
            DesignStatusBadge(title: "Active")
                .accessibilityLabel("Active voice")
        case .check:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(DuskColors.accent)
                .accessibilityLabel("Selected")
        }
    }

    private var rowAccessibilityValue: String {
        if isLoading { return "Loading preview" }
        if isPlaying { return "Preview playing" }
        if isSelected { return "Selected" }
        return "Not selected"
    }
}

enum VoiceSurfaceLayout {
    static let visibleTagLimit = 4
}

#Preview("Voice cards — long content") {
    VStack(spacing: Space.md) {
        VoiceRowView(
            name: "A very long family voice name that intentionally wraps", lang: "en", source: "Yours",
            description: "Warm, low register with a description that can reflow at larger text sizes.",
            tags: ["calm", "bright", "storytelling", "soft"], isSelected: true, accessory: .activePill,
            accessibilityId: "settings-voice-row-preview", onSelect: {}, onPlay: {}, onDelete: {}
        )
        VoiceRowView(
            name: "Preview loading", lang: "zh", tags: ["sample"], isLoading: true,
            accessibilityId: "settings-voice-row-loading", onSelect: {}, onPlay: {}
        )
    }
    .padding(Space.lg)
    .background(DuskColors.bg)
    .environment(\.dynamicTypeSize, .accessibility3)
    .transaction { $0.disablesAnimations = true }
    .preferredColorScheme(.dark)
}
