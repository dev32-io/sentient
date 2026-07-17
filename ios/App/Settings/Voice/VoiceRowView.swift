// ---------------------------------------------------------------------------
// VoiceRowView — the one list-row shared by the local voice-pack list and the
// Fish browse list, mirroring the webui `VoiceRow` (used by both VoicePackTile and
// fish-voice-tile). A left play/pause button, a name, an info line (language badge
// + source + description) and a tag line, with an optional trailing control
// (active chip / check marker / delete). Tapping the row = select (pick/clone);
// the play button is isolated so it never triggers select.
//
// Presentational only: state + closures in, no VM, no I/O — a stateless leaf per
// the SwiftUI state-hoisting rule.
// ---------------------------------------------------------------------------
import SwiftUI

/// Trailing accessory on a voice row.
enum VoiceRowAccessory: Equatable {
    case none
    /// "Active" pill — the picked local pack.
    case activePill
    /// Checkmark — the selected Fish entry to clone.
    case check
}

struct VoiceRowView: View {
    let name: String
    /// 2-letter language code; "" hides the badge.
    var lang: String = ""
    /// "Built-in" | "Yours" | nil (Fish rows pass nil).
    var source: String?
    var description: String = ""
    var tags: [String] = []
    var isPlaying: Bool = false
    var isLoading: Bool = false
    var playDisabled: Bool = false
    var isSelected: Bool = false
    var accessory: VoiceRowAccessory = .none
    let accessibilityId: String
    let onSelect: () -> Void
    let onPlay: () -> Void
    /// User-pack delete (hover-reveal in webui; always-visible trailing button here). nil hides it.
    var onDelete: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: Space.md) {
            playButton
            meta
            Spacer(minLength: Space.xs)
            accessoryView
            deleteButton
        }
        .padding(Space.md)
        .background(isSelected ? DuskColors.accent50 : DuskColors.paper, in: RoundedRectangle(cornerRadius: Radii.md))
        .overlay(
            RoundedRectangle(cornerRadius: Radii.md)
                .stroke(isSelected ? DuskColors.accent : DuskColors.lineSoft, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(accessibilityId)
    }

    private var playButton: some View {
        Button(action: onPlay) {
            Image(systemName: playIcon)
                .font(.system(size: TypeScale.base))
                .foregroundStyle(isPlaying ? DuskColors.accent : DuskColors.ink2)
                .frame(width: 34, height: 34)
                .background(DuskColors.bgElev, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(playDisabled || isLoading)
        .accessibilityIdentifier("\(accessibilityId)-play")
    }

    private var playIcon: String {
        if isPlaying { return "pause.fill" }
        if isLoading { return "waveform" }
        return "play.fill"
    }

    private var meta: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(name)
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(DuskColors.ink)
                .lineLimit(1)
            infoLine
            if !description.isEmpty {
                Text(description)
                    .font(Typo.ui(TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
                    .lineLimit(2)
            }
            if !tags.isEmpty {
                tagLine
            }
        }
    }

    private var infoLine: some View {
        HStack(spacing: Space.xs) {
            if !lang.isEmpty {
                chip(lang.uppercased(), tint: DuskColors.accent)
            }
            if let source, !source.isEmpty {
                chip(source, tint: DuskColors.ink3)
            }
        }
    }

    private var tagLine: some View {
        HStack(spacing: Space.xs) {
            ForEach(tags.prefix(4), id: \.self) { tag in
                Text(tag)
                    .font(Typo.ui(TypeScale.xs))
                    .foregroundStyle(DuskColors.ink2)
                    .padding(.horizontal, Space.xs)
                    .padding(.vertical, 1)
                    .background(DuskColors.bgElev, in: Capsule())
            }
        }
    }

    @ViewBuilder
    private var accessoryView: some View {
        switch accessory {
        case .none:
            EmptyView()
        case .activePill:
            chip("Active", tint: DuskColors.accent)
        case .check:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(DuskColors.accent)
        }
    }

    @ViewBuilder
    private var deleteButton: some View {
        if let onDelete {
            Button(action: onDelete) {
                Image(systemName: "trash")
                    .font(.system(size: TypeScale.sm))
                    .foregroundStyle(DuskColors.stop)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("\(accessibilityId)-delete")
        }
    }

    private func chip(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(Typo.ui(TypeScale.xs, .medium))
            .foregroundStyle(tint)
            .padding(.horizontal, Space.xs)
            .padding(.vertical, 1)
            .overlay(Capsule().stroke(tint.opacity(0.5), lineWidth: 1))
    }
}

#Preview {
    VStack(spacing: Space.md) {
        VoiceRowView(
            name: "Dad", lang: "en", source: "Yours", description: "Warm, low register",
            tags: ["male", "calm"], isSelected: true, accessory: .activePill,
            accessibilityId: "settings-voice-row-dad", onSelect: {}, onPlay: {}, onDelete: {}
        )
        VoiceRowView(
            name: "Narrator", lang: "en", source: "Built-in", description: "Neutral reference",
            tags: ["neutral"], isPlaying: true, accessibilityId: "settings-voice-row-narrator",
            onSelect: {}, onPlay: {}
        )
        VoiceRowView(
            name: "Fish Voice", lang: "zh", source: nil, description: "Cloneable sample",
            tags: ["bright"], accessory: .check, accessibilityId: "settings-voice-fish-row-1",
            onSelect: {}, onPlay: {}
        )
    }
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
