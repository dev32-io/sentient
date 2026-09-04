import Foundation
import SwiftUI

/// Compact live envelope used inside the Hold and Auto voice pod. It samples
/// the KMP microphone levels without owning capture or audio behavior.
struct PttBigWave: View {
    let levels: [Float]
    var tint: Color = DuskColors.waveBar
    var isActive = true

    @ComposerReduceMotion private var reduceMotion

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
        bars { index in
            PttWaveMetrics.sampledLevelScale(levels, bar: index)
        }
    }

    private var animatedBars: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !isActive)) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            bars { index in
                PttWaveMetrics.sampledAnimatedScale(levels, bar: index, time: time)
            }
        }
    }

    private func bars(_ scale: @escaping (Int) -> Double) -> some View {
        HStack(alignment: .center, spacing: 0) {
            ForEach(0..<PttWaveMetrics.barCount, id: \.self) { index in
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [tint, tint.opacity(0.58)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(width: PttWaveMetrics.barWidth)
                    .frame(height: PttWaveMetrics.contourHeight(at: index) * CGFloat(scale(index)))
                    .shadow(color: tint.opacity(0.38), radius: 3)

                if index < PttWaveMetrics.barCount - 1 {
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// Pure waveform math keeps live and Reduced Motion rendering testable without
/// opening an audio device.
enum PttWaveMetrics {
    static let barCount = 11
    static let laneHeight: CGFloat = 30
    static let barWidth: CGFloat = 3
    static let cycleDuration: Double = 1.0
    static let delayBucket = 11
    static let delayStep: Double = 0.055
    static let minScale: Double = 0.24
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
        laneHeight * (0.42 + 0.48 * abs(sin(Double(index) * 0.78 + 0.35)))
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

    static func sampledLevelScale(_ levels: [Float], bar: Int) -> Double {
        levelScale(levels, at: sourceIndex(for: bar, sourceCount: levels.count))
    }

    static func sampledAnimatedScale(_ levels: [Float], bar: Int, time: Double) -> Double {
        let levelScale = sampledLevelScale(levels, bar: bar)
        let pulse = pulseScale(at: time, bar: bar)
        return minScale + (levelScale - minScale) * pulse
    }

    static func sourceIndex(for bar: Int, sourceCount: Int) -> Int {
        guard sourceCount > 1, barCount > 1 else { return 0 }
        let boundedBar = min(max(bar, 0), barCount - 1)
        return Int((Double(boundedBar) * Double(sourceCount - 1) / Double(barCount - 1)).rounded())
    }
}

#Preview("Compact pod waveform") {
    PttBigWave(levels: Array(repeating: 0, count: 32))
        .frame(width: 130)
        .padding()
        .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: 12))
        .padding()
        .background(DuskColors.bg)
}
