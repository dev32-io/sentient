// Typewriter — pure time→reveal engine porting webui use-typewriter-buffer.ts.
// Rates from the shared SDK tokens (MobileData.Typewriter). Pure + testable; a
// TimelineView driver in the streaming bubble calls `typewriterTick` per frame.
import Foundation
import MobileData

struct TypewriterConfig {
    let baseRate: Double, minRate: Double, maxRate: Double, gapGain: Double
    let sentencePause: Double, paragraphPause: Double  // seconds
    static let `default` = TypewriterConfig(
        baseRate: Double(MobileData.Typewriter.shared.baseRate),
        minRate: Double(MobileData.Typewriter.shared.minRate),
        maxRate: Double(MobileData.Typewriter.shared.maxRate),
        gapGain: MobileData.Typewriter.shared.gapGain,
        sentencePause: Double(MobileData.Typewriter.shared.sentencePauseMs) / 1000.0,
        paragraphPause: Double(MobileData.Typewriter.shared.paragraphPauseMs) / 1000.0
    )
}

struct TypewriterState {
    var visibleCount: Int = 0
    var pauseUntil: Double = 0   // absolute seconds; reveal holds while now < pauseUntil
}

/// Advance `visibleCount` toward `target.count` for elapsed `dt` at clock `now`.
/// Stops at the first sentence/paragraph boundary within the computed advance window,
/// so the pause is never skipped when a tick would jump over a boundary.
func typewriterTick(_ s: TypewriterState, target: [Character], streamComplete: Bool,
                    dt: Double, now: Double, cfg: TypewriterConfig = .default) -> TypewriterState {
    var st = s
    let n = target.count
    if st.visibleCount >= n { return st }
    if now < st.pauseUntil { return st }
    let gap = n - st.visibleCount
    let raw = streamComplete ? cfg.maxRate : cfg.baseRate * (1 + Double(gap) * cfg.gapGain)
    let rate = min(cfg.maxRate, max(cfg.minRate, raw))
    let advance = max(1, Int(rate * dt))
    let candidate = min(n, st.visibleCount + advance)
    // Scan for the first boundary in (currentVisible, candidate]; stop there so
    // fast ticks never skip past a sentence/paragraph boundary.
    let stop = firstBoundaryStop(target, from: st.visibleCount + 1, through: candidate, cfg: cfg)
    st.visibleCount = stop
    if let pause = boundaryPause(target, upto: st.visibleCount, cfg: cfg) {
        st.pauseUntil = now + pause
    }
    return st
}

/// Returns the index (1-based count) of the first boundary char in [from, through],
/// or `through` if none found.
private func firstBoundaryStop(_ target: [Character], from: Int, through: Int,
                                cfg: TypewriterConfig) -> Int {
    for i in from...through {
        if boundaryPause(target, upto: i, cfg: cfg) != nil { return i }
    }
    return through
}

/// Semantic pause after the just-revealed char: paragraph (\n\n) > sentence (.!?).
private func boundaryPause(_ target: [Character], upto: Int, cfg: TypewriterConfig) -> Double? {
    guard upto >= 1, upto <= target.count else { return nil }
    let last = target[upto - 1]
    if last == "\n", upto >= 2, target[upto - 2] == "\n" { return cfg.paragraphPause }
    if last == "." || last == "!" || last == "?" { return cfg.sentencePause }
    return nil
}
