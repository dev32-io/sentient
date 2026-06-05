import Testing
@testable import SentientApp

struct TypewriterTests {
    let cfg = TypewriterConfig.default

    @Test func revealsTowardTargetAtBaseRate() {
        let target = Array("hello world")
        var s = TypewriterState()
        s = typewriterTick(s, target: target, streamComplete: false, dt: 1.0, now: 0, cfg: cfg)
        #expect(s.visibleCount == target.count)
    }

    @Test func clampsToMinRate() {
        let target = Array(String(repeating: "a", count: 1000))
        var s = TypewriterState()
        s = typewriterTick(s, target: target, streamComplete: false, dt: 0.001, now: 0, cfg: cfg)
        #expect(s.visibleCount == 1)
    }

    @Test func drainsAtMaxRateWhenComplete() {
        let target = Array(String(repeating: "a", count: 100))
        var s = TypewriterState()
        s = typewriterTick(s, target: target, streamComplete: true, dt: 1.0, now: 0, cfg: cfg)
        #expect(s.visibleCount == 100)
    }

    @Test func holdsAfterSentenceBoundary() {
        let target = Array("Hi. More")
        var s = TypewriterState()
        s = typewriterTick(s, target: target, streamComplete: false, dt: 0.12, now: 0, cfg: cfg)
        let afterDot = s.visibleCount
        #expect(afterDot == 3)   // stops exactly at "Hi." — never overshoots the boundary
        #expect(s.pauseUntil > 0)
        s = typewriterTick(s, target: target, streamComplete: false, dt: 0.02, now: 0.01, cfg: cfg)
        #expect(s.visibleCount == afterDot)
    }
}
