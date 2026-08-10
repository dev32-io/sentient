// Pins the task-pill min-width clamp, mirroring the webui pin
// (gateway/webui/src/styles/components.css `.tool-pill`
// `clamp(112px, 42cqw, 200px)`) and Android's `ComposerTaskStripLayoutTest`.
// A drifted floor/ceiling/fraction on any one platform makes the same turn
// look inconsistent depending on which client renders it.
import CoreGraphics
import Testing
@testable import SentientApp

struct ComposerLayoutTests {

    @Test func floorsAtTheMinimumOnANarrowStrip() {
        #expect(ComposerLayout.taskPillMinWidth(stripWidth: 100) == ComposerLayout.taskPillMinWidthFloor)
    }

    @Test func stillFloorsJustBelowTheFloorCrossoverWidth() {
        // 260 * 0.42 = 109.2, under the floor — pinned via a plain value rather
        // than an inverse-computed crossover, which doesn't round-trip exactly
        // in floating point and would make this boundary test flaky.
        #expect(ComposerLayout.taskPillMinWidth(stripWidth: 260) == ComposerLayout.taskPillMinWidthFloor)
    }

    @Test func scalesAtTheStripFractionInTheMiddleBand() {
        let stripWidth: CGFloat = 330
        #expect(ComposerLayout.taskPillMinWidth(stripWidth: stripWidth) == stripWidth * ComposerLayout.taskPillWidthStripFraction)
    }

    @Test func stillCeilsJustAboveTheCeilingCrossoverWidth() {
        // 480 * 0.42 = 201.6, over the ceiling.
        #expect(ComposerLayout.taskPillMinWidth(stripWidth: 480) == ComposerLayout.taskPillMaxWidth)
    }

    @Test func capsAtTheCeilingOnAWideDesktopStrip() {
        #expect(ComposerLayout.taskPillMinWidth(stripWidth: 1000) == ComposerLayout.taskPillMaxWidth)
    }
}
