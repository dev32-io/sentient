import SwiftUI

enum VoiceRowAccessory: Equatable {
    case none, activePill, check
}

struct VoiceRowView: View {
    let name: String
    var lang: String = ""
    var source: String?
    var facts: [String] = []
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

    /// The library supplies one stable plate; other consumers keep standalone rows.
    var grouped = false
    var selectionTitle = "Choose"
    @State private var detailsExpanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            if grouped {
                librarySummary
                if hasDetails && detailsExpanded {
                    details
                        .padding(Space.md)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .designWell()
                }
            } else {
                HStack(alignment: .top, spacing: Space.md) {
                    VoicePreviewKey(
                        name: name, isLoading: isLoading, isPlaying: isPlaying,
                        isDisabled: playDisabled, accessibilityId: "\(accessibilityId)-play", onPlay: onPlay
                    )
                    selectionButton
                }
                if hasDetails {
                    DisclosureGroup(isExpanded: $detailsExpanded) {
                        details
                            .padding(Space.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .designWell()
                    } label: {
                        Text("Details")
                            .font(DesignTextRole.label.font)
                            .foregroundStyle(DuskColors.ink2)
                            .frame(minHeight: DesignMetrics.minimumTarget)
                    }
                    .tint(DuskColors.ink2)
                    .accessibilityIdentifier("\(accessibilityId)-details")
                }
            }
        }
        .padding(Space.md)
        .background {
            if isSelected {
                Color.clear.designWell()
            } else if !grouped {
                Color.clear.designPlate()
            }
        }
        .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: detailsExpanded)
        .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: isSelected)
        .transaction { transaction in
            if reduceMotion { transaction.disablesAnimations = true }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(accessibilityId)
    }

    @ViewBuilder
    private var librarySummary: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: Space.sm) {
                identity
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Space.sm) { libraryActions }
                    VStack(alignment: .leading, spacing: Space.sm) { libraryActions }
                }
            }
        } else {
            HStack(alignment: .top, spacing: Space.sm) {
                previewKey
                identity.frame(maxWidth: .infinity, alignment: .leading)
                librarySelection
                if hasDetails { libraryDetailsButton }
            }
        }
    }

    @ViewBuilder
    private var libraryActions: some View {
        previewKey
        librarySelection
        if hasDetails { libraryDetailsButton }
    }

    private var previewKey: some View {
        VoicePreviewKey(
            name: name, isLoading: isLoading, isPlaying: isPlaying,
            isDisabled: playDisabled, accessibilityId: "\(accessibilityId)-play", onPlay: onPlay
        )
    }

    private var librarySelection: some View {
        DesignSelectableButton(
            accessibilityLabel: "\(selectionText): \(name)",
            state: isSelected ? .selected : .normal,
            accessibilityId: "\(accessibilityId)-select",
            action: onSelect
        ) {
            selectionLabel.padding(.horizontal, Space.sm)
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    private var libraryDetailsButton: some View {
        DesignCompactIconButton(
            systemName: detailsExpanded ? "chevron.up" : "chevron.down",
            label: "Details for \(name)",
            accessibilityId: "\(accessibilityId)-details"
        ) {
            detailsExpanded.toggle()
        }
        .accessibilityValue(detailsExpanded ? "Expanded" : "Collapsed")
    }

    private var selectionButton: some View {
        Button(action: onSelect) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Space.sm) {
                    identity
                    selectionLabel
                }
                .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget, alignment: .leading)
                .contentShape(Rectangle())
            } else {
                HStack(alignment: .center, spacing: Space.sm) {
                    identity.frame(maxWidth: .infinity, alignment: .leading)
                    selectionLabel
                }
                .frame(minHeight: DesignMetrics.minimumTarget)
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(selectionText): \(name)")
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityIdentifier("\(accessibilityId)-select")
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(name)
                .font(DesignTextRole.large.font.weight(.semibold))
                .foregroundStyle(DuskColors.ink)
                .fixedSize(horizontal: false, vertical: true)
            if !metadataLabels.isEmpty {
                Text(metadataLabels.joined(separator: " · "))
                    .font(DesignTextRole.supporting.font)
                    .foregroundStyle(DuskColors.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if grouped && !detailsExpanded && !description.isEmpty {
                Text(description)
                    .font(DesignTextRole.supporting.font)
                    .foregroundStyle(DuskColors.ink2)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if isLoading || isPlaying {
                Text(isLoading ? "Loading preview" : "Playing preview")
                    .font(DesignTextRole.supporting.font)
                    .foregroundStyle(DuskColors.accent)
            }
        }
        .multilineTextAlignment(.leading)
    }

    private var selectionText: String {
        if accessory == .activePill { return "Active" }
        if isSelected || accessory == .check { return "Selected" }
        return selectionTitle
    }

    private var selectionLabel: some View {
        HStack(spacing: Space.xs) {
            if isSelected || accessory != .none {
                Image(systemName: "checkmark.circle.fill").accessibilityHidden(true)
            }
            Text(selectionText)
        }
        .font(DesignTextRole.label.font)
        .foregroundStyle(isSelected ? DuskColors.accent : DuskColors.ink2)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var hasDetails: Bool {
        !description.isEmpty || !tags.isEmpty || !facts.isEmpty || onDelete != nil
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if !facts.isEmpty {
                Text(facts.joined(separator: " · "))
            }
            if !description.isEmpty {
                Text(description)
            }
            if !tags.isEmpty {
                Text("Tags: \(tags.joined(separator: ", "))")
            }
            if let onDelete {
                DesignActionButton(
                    title: "Delete voice", role: .destructive,
                    accessibilityId: "\(accessibilityId)-delete", fillsWidth: false, action: onDelete
                )
                .accessibilityLabel("Delete \(name)")
            }
        }
        .font(DesignTextRole.supporting.font)
        .foregroundStyle(DuskColors.ink2)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var metadataLabels: [String] {
        [lang.isEmpty ? nil : VoiceLanguages.label(for: lang), source].compactMap { value in
            guard let value, !value.isEmpty else { return nil }
            return value
        }
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
