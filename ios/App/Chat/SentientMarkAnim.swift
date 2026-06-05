// ---------------------------------------------------------------------------
// SentientMarkAnim — the animated draw parameters for the SentientMark avatar,
// porting the webui mark animations (gateway/webui/src/styles/components.css
// .sentient-mark--running / --listening + .bubble-speaking-wave) and the
// Android SentientMarkAnim.kt to a pure time → MarkAnim function.
//
// CRITICAL (event-driven-UX rule): the active mode's parameters are computed
// from a TimelineView clock that ONLY ticks while a non-idle mode holds (see
// SentientMark — idle renders a plain static Canvas with no TimelineView). The
// `.idle` mode returns the resting MarkAnim regardless of time, so even a stray
// tick would draw the static mark. "constant by default is a bug."
//
// webui parity (durations transcribed from components.css / the Android port):
//   listening → halo-breathe 2.4s, nucleus 1.8s, ring 2.4s, orbits 3.8/5.2/4.4s
//   thinking  → halo 6.5s, nucleus 4.5s (the shared "running" engagement pulse)
//   speaking  → running pulse (halo/nucleus); wave sweep lives on BubbleSpeakingWave
// ---------------------------------------------------------------------------
import CoreGraphics
import Foundation

/// The animated draw parameters the SentientMark Canvas reads each frame. All
/// default to the static idle resting values; only the active mode's animator
/// drives a subset away from rest. `orbitSpin` is per-orbit rotation in degrees.
struct MarkAnim {
    var haloScale: CGFloat = 1
    var haloAlpha: Double = 0.45
    var nucleusScale: CGFloat = 1
    var ringAlpha: Double = 0.4
    var orbitSpin: [Double] = [0, 0, 0]
}

/// Listening durations (seconds), transcribed from .sentient-mark--listening.
private enum Listen {
    static let halo = 2.4
    static let nucleus = 1.8
    static let ring = 2.4
    static let orbit: [Double] = [3.8, 5.2, 4.4]
    static let orbitClockwise: [Bool] = [true, false, true]
}

/// Thinking/speaking shared "running" pulse durations (seconds).
private enum Run {
    static let halo = 6.5
    static let nucleus = 4.5
}

/// Builds the `MarkAnim` for `mode` at elapsed `time` (seconds). Pure — the only
/// time source is the caller's clock. `.idle` ignores `time` and returns rest,
/// so the mark is dead-still even if a tick slips through.
func markAnim(mode: MarkMode, time: TimeInterval) -> MarkAnim {
    switch mode {
    case .idle: return MarkAnim()
    case .listening: return listeningAnim(time)
    case .thinking, .speaking: return runningAnim(time)
    }
}

private func listeningAnim(_ t: TimeInterval) -> MarkAnim {
    MarkAnim(
        haloScale: pulse(t, Listen.halo, 1, 1.12),
        haloAlpha: Double(pulse(t, Listen.halo, 0.45, 0.7)),
        nucleusScale: pulse(t, Listen.nucleus, 1, 1.06),
        ringAlpha: Double(pulse(t, Listen.ring, 0.4, 0.85)),
        orbitSpin: (0..<3).map { spin(t, Listen.orbit[$0], clockwise: Listen.orbitClockwise[$0]) }
    )
}

// Shared by .thinking and .speaking — both render the engagement pulse; the
// speaking-specific sweep is now drawn on the bubble (BubbleSpeakingWave).
private func runningAnim(_ t: TimeInterval) -> MarkAnim {
    MarkAnim(
        haloScale: pulse(t, Run.halo, 1, 1.08),
        haloAlpha: Double(pulse(t, Run.halo, 0.45, 0.6)),
        nucleusScale: pulse(t, Run.nucleus, 1, 1.06)
    )
}

/// Ping-pong scale/alpha pulse (ease-in-out, like the CSS 0%/50%/100% pulses).
private func pulse(_ t: TimeInterval, _ period: Double, _ from: CGFloat, _ to: CGFloat) -> CGFloat {
    // 0→1→0 triangle, smoothed to a cosine so it eases at the turns.
    let phase = (t.truncatingRemainder(dividingBy: period)) / period
    let eased = 0.5 - 0.5 * cos(phase * 2 * .pi)
    return from + (to - from) * CGFloat(eased)
}

/// Continuous 0→360° (or 0→-360°) rotation, like the linear orbit keyframes.
private func spin(_ t: TimeInterval, _ period: Double, clockwise: Bool) -> Double {
    let frac = (t.truncatingRemainder(dividingBy: period)) / period
    return (clockwise ? 360 : -360) * frac
}
