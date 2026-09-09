import SwiftUI

/// Voice facets share one compact, labeled key. The native menu owns selection,
/// focus and dismissal; this label only supplies the library's visual hierarchy.
struct VoiceLibraryMenuLabel: View {
    let title: String
    var selected = false

    var body: some View {
        HStack(spacing: Space.xs) {
            Text(title)
                .fixedSize(horizontal: false, vertical: true)
            Image(systemName: "chevron.down")
                .font(DesignTextRole.supporting.font)
                .accessibilityHidden(true)
        }
        .foregroundStyle(selected ? DuskColors.accent : DuskColors.ink2)
    }
}

/// A real audition control, never an illustrative waveform. Loading cannot be
/// mistaken for playing and never invokes a second preview request.
struct VoicePreviewKey: View {
    let name: String
    let isLoading: Bool
    let isPlaying: Bool
    let isDisabled: Bool
    let accessibilityId: String
    let onPlay: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: onPlay) {
            Group {
                if isLoading {
                    if reduceMotion {
                        Image(systemName: "hourglass")
                    } else {
                        DesignProgress().controlSize(.small)
                    }
                } else {
                    Image(systemName: isPlaying ? "stop.fill" : "play.fill")
                }
            }
            .font(DesignTextRole.body.font)
            .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
        }
        .buttonStyle(DesignButtonStyle(role: isPlaying ? .action : .quiet, horizontalPadding: 0))
        .disabled(isLoading || isDisabled)
        .accessibilityLabel("\(isPlaying ? "Stop preview" : "Play preview") of \(name)")
        .accessibilityValue(isLoading ? "Loading preview" : isPlaying ? "Playing" : isDisabled ? "Preview unavailable" : "Stopped")
        .accessibilityIdentifier(accessibilityId)
    }
}
