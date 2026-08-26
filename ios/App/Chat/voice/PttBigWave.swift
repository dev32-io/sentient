// ---------------------------------------------------------------------------
// PttBigWave — the recording-takeover waveform: 32 flexible bars with a sine
// contour, overlaid across the FULL composer card while the corner mic is
// held or locked. Bars use the live microphone envelope for amplitude and a
// staggered pulse for motion. Reduced Motion renders the envelope directly,
// without a timeline or an implicit animation.
// ---------------------------------------------------------------------------
import Foundation
import SwiftUI

struct PttBigWave: View {
    let levels: [Float]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                staticBars
            } else {
                animatedBars
            }
        }
        .frame(height: PttWaveMetrics.laneHeight)
        .frame(maxWidth: .infinity)
        .allowsHitTesting(false)
    }

    private var staticBars: some View {
        bars { i in
            PttWaveMetrics.levelScale(levels, at: i)
        }
    }

    private var animatedBars: some View {
        TimelineView(.animation) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            bars { i in
                PttWaveMetrics.animatedScale(levels, at: i, time: time)
            }
        }
    }

    private func bars(_ scale: @escaping (Int) -> Double) -> some View {
        HStack(alignment: .center, spacing: PttWaveMetrics.barSpacing) {
            ForEach(0..<PttWaveMetrics.barCount, id: \.self) { i in
                Capsule()
                    .fill(DuskColors.waveBar)
                    .frame(minWidth: PttWaveMetrics.barMinWidth, maxWidth: .infinity)
                    .frame(height: PttWaveMetrics.contourHeight(at: i) * CGFloat(scale(i)))
            }
        }
    }
}

/// Pure waveform math keeps the live and Reduced Motion paths honest and
/// testable without rendering a view or opening an audio device.
enum PttWaveMetrics {
    /// Number of waveform bars (design mobile variant).
    static let barCount = 32
    /// Waveform lane height in points (webui height: 40px).
    static let laneHeight: CGFloat = 40
    /// Horizontal gap between bars.
    static let barSpacing: CGFloat = 3
    /// Bar width floor; bars grow evenly to fill the lane.
    static let barMinWidth: CGFloat = 2
    /// One pulse cycle (webui ptt-wave 1s ease-in-out infinite).
    static let cycleDuration: Double = 1.0
    /// Stagger: delay = (i mod 13) · 0.06 s.
    static let delayBucket = 13
    static let delayStep: Double = 0.06
    /// scaleY trough of the pulse (webui keyframes .24 → 1 → .24).
    static let minScale: Double = 0.24
    /// Baseline and level contribution from the mobile envelope contract.
    static let levelFloor: Double = 0.35
    static let levelRange: Double = 0.65

    static func levelScale(_ levels: [Float], at index: Int) -> Double {
        levelFloor + levelRange * level(at: index, in: levels)
    }

    static func level(at index: Int, in levels: [Float]) -> Double {
        guard levels.indices.contains(index) else { return 0 }
        let value = levels[index]
        guard value.isFinite else { return 0 }
        return Double(min(max(value, 0), 1))
    }

    static func contourHeight(at index: Int) -> CGFloat {
        laneHeight * (0.20 + 0.64 * abs(sin(Double(index) * 0.7)))
    }

    static func pulseScale(at time: Double, bar index: Int) -> Double {
        let delay = Double(index % delayBucket) * delayStep
        let remainder = (time - delay).truncatingRemainder(dividingBy: cycleDuration)
        let phase = remainder >= 0
            ? remainder / cycleDuration
            : (remainder + cycleDuration) / cycleDuration
        return minScale + (1 - minScale) * (0.5 - 0.5 * cos(phase * 2 * .pi))
    }

    static func animatedScale(_ levels: [Float], at index: Int, time: Double) -> Double {
        let levelScale = levelScale(levels, at: index)
        let pulse = pulseScale(at: time, bar: index)
        return minScale + (levelScale - minScale) * pulse
    }
}

#Preview("Animated") {
    PttBigWave(levels: Array(repeating: 0, count: PttWaveMetrics.barCount))
        .padding()
        .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: 12))
        .padding()
        .background(DuskColors.bg)
}
