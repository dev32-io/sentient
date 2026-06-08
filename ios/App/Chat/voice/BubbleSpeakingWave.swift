// ---------------------------------------------------------------------------
// BubbleSpeakingWave — terra gradient sweeping left→right across the bubble
// while the assistant is speaking. Ports the webui .bubble-speaking-wave
// animation (Motion.wave 3.4s). Lives BELOW the text content (z 0); the
// bubble clips it. Reduced-motion degrades to nothing.
//
// AvatarRipple — two phased expanding ring strokes around the assistant
// avatar while speaking/listening, porting the webui .avatar--running ripple
// rings. Reduced-motion degrades to nothing.
// ---------------------------------------------------------------------------
import SwiftUI

// MARK: - BubbleSpeakingWave

/// Terra-tinted gradient sweep across a bubble while the assistant is speaking.
/// Clips to the parent bubble shape automatically (the bubble applies `.clipShape`
/// AFTER layering this background). Reduced-motion: `Color.clear` (no motion).
struct BubbleSpeakingWave: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Guard: Motion.wave should always be > 0; fall back to 3.4s if zero.
    private var period: Double {
        let p = Motion.wave
        return p > 0 ? p : 3.4
    }

    var body: some View {
        if reduceMotion {
            Color.clear
        } else {
            TimelineView(.animation) { tl in
                let elapsed = tl.date.timeIntervalSinceReferenceDate
                let phase = elapsed.truncatingRemainder(dividingBy: period) / period
                GeometryReader { geo in
                    let w = geo.size.width
                    // Sweep the gradient beam from left to right across the bubble.
                    // x ranges from -w*0.6 to w*1.6 over one period (2.2× width travel).
                    let x = CGFloat(phase) * w * 2.2 - w * 0.6
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: DuskColors.accent.opacity(0.22), location: 0.5),
                            .init(color: .clear, location: 1),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: w * 1.2)
                    .offset(x: x - w * 0.1)
                }
            }
            .allowsHitTesting(false)
        }
    }
}

// MARK: - AvatarRipple

/// Two phased expanding ring strokes around the assistant avatar while
/// speaking or listening, porting the webui .avatar--running ripple rings.
/// Reduced-motion or inactive: `Color.clear` (no rings).
struct AvatarRipple: View {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if !active || reduceMotion {
            Color.clear
        } else {
            TimelineView(.animation) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                ZStack {
                    ring(t, delay: 0)
                    ring(t, delay: 0.9)
                }
            }
            .allowsHitTesting(false)
        }
    }

    private func ring(_ t: Double, delay: Double) -> some View {
        let raw = (t - delay).truncatingRemainder(dividingBy: 1.8) / 1.8
        let phase = max(0, raw)
        return Circle()
            .stroke(DuskColors.accent, lineWidth: 1.5)
            .scaleEffect(1 + 0.8 * phase)
            .opacity(0.7 * (1 - phase))
    }
}
