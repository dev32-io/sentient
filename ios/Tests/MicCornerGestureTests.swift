// FSM invariants for the corner mic control, mirroring the webui pins
// (gateway/webui/src/components/dock/mic-corner-gesture.test.ts): the
// hold→lock and locked→release thresholds decide whether the mic stays on.
// A drifted threshold silently turns push-to-talk into a stuck-open mic (or
// the reverse), so the boundaries are pinned on both platforms.
import CoreGraphics
import Testing
@testable import SentientApp

struct MicCornerGestureTests {
    private let travel: CGFloat = 100

    // ── resolveRelease from a hold (origin idle) ─────────────────────────

    @Test func releaseBelowLockThresholdReturnsIdle() {
        let outcome = MicCornerGesture.resolveRelease(origin: .idle, drag: 39, travel: travel)
        #expect(outcome == MicCornerRelease(mode: .idle, drag: 0))
    }

    @Test func releaseAtLockThresholdLocks() {
        let outcome = MicCornerGesture.resolveRelease(origin: .idle, drag: 40, travel: travel)
        #expect(outcome == MicCornerRelease(mode: .locked, drag: travel))
    }

    @Test func releasePastLockThresholdLocks() {
        let outcome = MicCornerGesture.resolveRelease(origin: .idle, drag: 80, travel: travel)
        #expect(outcome == MicCornerRelease(mode: .locked, drag: travel))
    }

    @Test func plainTapWithNoDragReturnsIdle() {
        let outcome = MicCornerGesture.resolveRelease(origin: .idle, drag: 0, travel: travel)
        #expect(outcome == MicCornerRelease(mode: .idle, drag: 0))
    }

    // ── resolveRelease from locked (origin locked) ───────────────────────

    @Test func lockedBarelyDraggedBackStaysLocked() {
        let outcome = MicCornerGesture.resolveRelease(origin: .locked, drag: 80, travel: travel)
        #expect(outcome == MicCornerRelease(mode: .locked, drag: travel))
    }

    @Test func lockedDraggedBackToUnlockThresholdReleases() {
        let outcome = MicCornerGesture.resolveRelease(origin: .locked, drag: 50, travel: travel)
        #expect(outcome == MicCornerRelease(mode: .idle, drag: 0))
    }

    @Test func lockedDraggedFullyBackReleases() {
        let outcome = MicCornerGesture.resolveRelease(origin: .locked, drag: 0, travel: travel)
        #expect(outcome == MicCornerRelease(mode: .idle, drag: 0))
    }

    @Test func lockedPlainTapStaysLocked() {
        let outcome = MicCornerGesture.resolveRelease(origin: .locked, drag: travel, travel: travel)
        #expect(outcome == MicCornerRelease(mode: .locked, drag: travel))
    }

    // ── clampDrag ─────────────────────────────────────────────────────────

    @Test func clampTracksLeftwardMovementFromIdleOrigin() {
        #expect(MicCornerGesture.clampDrag(base: 0, startX: 200, currentX: 170, travel: travel) == 30)
    }

    @Test func clampFloorsAtZeroWhenDraggingRightwardPastOrigin() {
        #expect(MicCornerGesture.clampDrag(base: 0, startX: 200, currentX: 260, travel: travel) == 0)
    }

    @Test func clampCapsAtTravelWhenDraggingPastLockEnd() {
        #expect(MicCornerGesture.clampDrag(base: 0, startX: 200, currentX: 40, travel: travel) == travel)
    }

    @Test func clampStartsFromLockedEndWhenOriginIsLocked() {
        #expect(MicCornerGesture.clampDrag(base: travel, startX: 200, currentX: 230, travel: travel) == 70)
    }

    // ── isArmed ───────────────────────────────────────────────────────────

    @Test func armsExactlyAtLockThreshold() {
        #expect(!MicCornerGesture.isArmed(drag: 39, travel: travel))
        #expect(MicCornerGesture.isArmed(drag: 40, travel: travel))
    }
}
