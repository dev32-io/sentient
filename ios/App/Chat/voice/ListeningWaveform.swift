// ---------------------------------------------------------------------------
// ListeningWaveform — 11 bouncing bars + "Listening…" label overlaid on the
// empty input field while the mic is active. Mirrors the webui
// .m-listening / .m-wave animation. Reduced-motion: static bars (no animation).
// ---------------------------------------------------------------------------
import Foundation
import SwiftUI

struct ListeningWaveform: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: Space.sm) {
            if reduceMotion {
                staticBars
            } else {
                animatedBars
            }
            Text("Listening…")
                .font(Typo.ui(WaveformLayout.labelSize, .medium))
                .foregroundStyle(DuskColors.accent.opacity(WaveformLayout.labelOpacity))
        }
        .allowsHitTesting(false)
    }

    // MARK: - Static (reduced-motion)

    private var staticBars: some View {
        HStack(alignment: .center, spacing: WaveformLayout.barSpacing) {
            ForEach(WaveformLayout.barHeights.indices, id: \.self) { i in
                bar(WaveformLayout.barHeights[i], scale: 1.0)
            }
        }
        .frame(height: WaveformLayout.containerHeight)
    }

    // MARK: - Animated

    private var animatedBars: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            HStack(alignment: .center, spacing: WaveformLayout.barSpacing) {
                ForEach(WaveformLayout.barHeights.indices, id: \.self) { i in
                    let phase = (t / WaveformLayout.cycleDuration + Double(i) * WaveformLayout.phaseStep)
                        .truncatingRemainder(dividingBy: 1)
                    bar(WaveformLayout.barHeights[i], scale: 0.4 + 0.6 * (0.5 - 0.5 * cos(phase * 2 * .pi)))
                }
            }
            .frame(height: WaveformLayout.containerHeight)
        }
    }

    // MARK: - Bar

    private func bar(_ height: CGFloat, scale: Double) -> some View {
        Capsule()
            .fill(DuskColors.accent)
            .frame(width: WaveformLayout.barWidth, height: height * scale)
    }
}

// MARK: - Layout constants (design-tuned from webui mobile.css .m-wave)

private enum WaveformLayout {
    /// Heights of the 11 waveform bars in points.
    static let barHeights: [CGFloat] = [6, 12, 18, 10, 15, 8, 16, 11, 18, 7, 13]
    /// Width of each bar capsule.
    static let barWidth: CGFloat = 2.5
    /// Horizontal gap between bars.
    static let barSpacing: CGFloat = 2.5
    /// Fixed height of the bar container to prevent layout jitter.
    static let containerHeight: CGFloat = 18
    /// Duration of one full bounce cycle in seconds.
    static let cycleDuration: Double = 1.1
    /// Per-bar phase offset to stagger the bounce.
    static let phaseStep: Double = 0.08
    /// Label font size.
    static let labelSize: CGFloat = 13.5
    /// Label opacity.
    static let labelOpacity: Double = 0.85
}

#Preview("Animated") {
    ListeningWaveform()
        .padding()
        .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: 12))
        .padding()
        .background(DuskColors.bg)
}

// Reduced-motion is a system-level read-only environment key; test the static
// path by passing a custom env wrapper or via Accessibility > Reduce Motion in
// the Simulator. The static variant can be verified visually by enabling the
// system setting.
#Preview("Static bars (simulated reduce-motion)") {
    _ReduceMotionPreview()
}

private struct _ReduceMotionPreview: View {
    var body: some View {
        _WaveformStaticBars()
            .padding()
            .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: 12))
            .padding()
            .background(DuskColors.bg)
    }
}

/// Directly renders the static-bar layout so the reduce-motion path is
/// visually previewable without requiring a system accessibility setting.
private struct _WaveformStaticBars: View {
    var body: some View {
        HStack(spacing: Space.sm) {
            HStack(alignment: .center, spacing: WaveformLayout.barSpacing) {
                ForEach(WaveformLayout.barHeights.indices, id: \.self) { i in
                    Capsule()
                        .fill(DuskColors.accent)
                        .frame(width: WaveformLayout.barWidth, height: WaveformLayout.barHeights[i])
                }
            }
            .frame(height: WaveformLayout.containerHeight)
            Text("Listening…")
                .font(Typo.ui(WaveformLayout.labelSize, .medium))
                .foregroundStyle(DuskColors.accent.opacity(WaveformLayout.labelOpacity))
        }
        .allowsHitTesting(false)
    }
}
