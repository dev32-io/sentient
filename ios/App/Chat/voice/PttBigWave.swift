// ---------------------------------------------------------------------------
// PttBigWave — the recording-takeover waveform: 32 flexible bars with a sine
// contour, overlaid across the FULL composer card while the corner mic is
// held or locked. Mirrors the webui .ptt-bigwave (components.css): bar
// heights are (20 + 64·|sin(i·0.7)|)% of a 40pt lane, pulsing scaleY .24↔1 on
// a 1s cycle with a staggered (i mod 13)·0.06s delay. Bars share the lane
// width evenly (no max-width cap — the overlay must span the card with no
// side gaps). TimelineView-driven (same pattern the retired ListeningWaveform
// used); reduced-motion → static bars at 0.6.
// ---------------------------------------------------------------------------
import Foundation
import SwiftUI

struct PttBigWave: View {
    let levels: [Float]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            bars { i in
                let level = i < levels.count ? max(0, min(1, levels[i])) : 0
                return 0.35 + 0.65 * Double(level)
            }
        }
        .frame(height: PttWaveLayout.laneHeight)
        .frame(maxWidth: .infinity)
        .allowsHitTesting(false)
    }

    // MARK: - Animated

    private var animatedBars: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            bars { i in
                let delay = Double(i % PttWaveLayout.delayBucket) * PttWaveLayout.delayStep
                let phase = ((t - delay) / PttWaveLayout.cycleDuration)
                    .truncatingRemainder(dividingBy: 1)
                return PttWaveLayout.minScale +
                    (1 - PttWaveLayout.minScale) * (0.5 - 0.5 * cos(phase * 2 * .pi))
            }
        }
    }

    // MARK: - Bars

    private func bars(_ scale: @escaping (Int) -> Double) -> some View {
        HStack(alignment: .center, spacing: PttWaveLayout.barSpacing) {
            ForEach(0..<PttWaveLayout.barCount, id: \.self) { i in
                Capsule()
                    .fill(DuskColors.waveBar)
                    .frame(minWidth: PttWaveLayout.barMinWidth, maxWidth: .infinity)
                    .frame(height: contourHeight(i) * CGFloat(scale(i)))
            }
        }
    }

    /// Sine contour from the design: (20 + 64·|sin(i·0.7)|)% of the lane.
    private func contourHeight(_ i: Int) -> CGFloat {
        PttWaveLayout.laneHeight * (0.20 + 0.64 * abs(sin(Double(i) * 0.7)))
    }
}

// MARK: - Layout constants (design-tuned from webui .ptt-bigwave)

private enum PttWaveLayout {
    /// Number of waveform bars (design mobile variant).
    static let barCount = 32
    /// Waveform lane height in points (webui height: 40px).
    static let laneHeight: CGFloat = 40
    /// Horizontal gap between bars.
    static let barSpacing: CGFloat = 3
    /// Bar width floor; bars grow evenly to fill the lane (full-card overlay,
    /// no side gaps — supersedes the webui max-width 5px cap).
    static let barMinWidth: CGFloat = 2
    /// One pulse cycle (webui ptt-wave 1s ease-in-out infinite).
    static let cycleDuration: Double = 1.0
    /// Stagger: delay = (i mod 13) · 0.06 s.
    static let delayBucket = 13
    static let delayStep: Double = 0.06
    /// scaleY trough of the pulse (webui keyframes .24 → 1 → .24).
    static let minScale: Double = 0.24
    /// Reduced-motion static scale (webui .6).
    static let staticScale: Double = 0.6
}

#Preview("Animated") {
    PttBigWave(levels: Array(repeating: 0, count: 32))
        .padding()
        .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: 12))
        .padding()
        .background(DuskColors.bg)
}
