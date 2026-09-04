import CoreGraphics
import SwiftUI
import Testing
@testable import SentientApp

struct VoiceCaptureControlTests {
    @Test func pressStartsHoldImmediately() {
        let result = VoiceCaptureReducer.begin(from: .idle)
        #expect(result == VoiceCaptureTransition(state: .hold, intents: [.holdStart]))
    }

    @Test func confirmedNormalHeldReleaseSendsExactlyOnce() {
        let release = VoiceCaptureReducer.terminatePhysicalHold(
            from: .hold,
            target: .send,
            elapsed: 0.5,
            maximumTravel: 0,
            termination: .released
        )
        let lateRelease = VoiceCaptureReducer.terminatePhysicalHold(
            from: release.state,
            target: .send,
            elapsed: 0.6,
            maximumTravel: 0,
            termination: .released
        )

        #expect(release.intents + lateRelease.intents == [.sendHeld])
    }

    @Test func heldSystemCancellationCancelsExactlyOnceAndNeverSends() {
        let cancellation = VoiceCaptureReducer.terminatePhysicalHold(
            from: .hold,
            target: .send,
            elapsed: 0.5,
            maximumTravel: 0,
            termination: .cancelled
        )
        let lateRelease = VoiceCaptureReducer.terminatePhysicalHold(
            from: cancellation.state,
            target: .send,
            elapsed: 0.6,
            maximumTravel: 0,
            termination: .released
        )
        let intents = cancellation.intents + lateRelease.intents

        #expect(intents == [.cancelHeld])
        #expect(!intents.contains(.sendHeld))
    }

    @Test func heldLifecycleInterruptionCancelsExactlyOnceAndNeverEnds() {
        let interruption = VoiceCaptureReducer.interrupt(from: .hold)
        let repeatedInterruption = VoiceCaptureReducer.interrupt(from: interruption.state)
        let lateRelease = VoiceCaptureReducer.terminatePhysicalHold(
            from: interruption.state,
            target: .send,
            elapsed: 0.5,
            maximumTravel: 0,
            termination: .released
        )
        let intents = interruption.intents + repeatedInterruption.intents + lateRelease.intents

        #expect(intents == [.lifecycleCancel])
        #expect(!intents.contains(.sendHeld))
    }

    @Test func explicitCancelDiscards() {
        let result = VoiceCaptureReducer.release(
            from: .hold,
            target: .cancel,
            elapsed: 0.5,
            maximumTravel: 40
        )
        #expect(result.intents == [.cancelHeld])
    }

    @Test func quickAutoRequiresBothStrictTimeAndTravelThresholds() {
        let quickTap = VoiceCaptureReducer.release(
            from: .hold,
            target: .send,
            elapsed: VoiceCaptureReducer.quickAutoThreshold - 0.001,
            maximumTravel: VoiceCaptureReducer.quickAutoTravelThreshold - 0.001
        )
        let atTimeThreshold = VoiceCaptureReducer.release(
            from: .hold,
            target: .send,
            elapsed: VoiceCaptureReducer.quickAutoThreshold,
            maximumTravel: 0
        )
        let atTravelThreshold = VoiceCaptureReducer.release(
            from: .hold,
            target: .send,
            elapsed: 0.1,
            maximumTravel: VoiceCaptureReducer.quickAutoTravelThreshold
        )

        #expect(quickTap.intents == [.enterAuto])
        #expect(atTimeThreshold.intents == [.sendHeld])
        #expect(atTravelThreshold.intents == [.sendHeld])
    }

    @Test func maximumTravelPersistsWhenFingerReturnsToOrigin() {
        var progress = VoiceCaptureGestureProgress()
        progress.begin(at: CGPoint(x: 40, y: 30))
        progress.update(at: CGPoint(x: 60, y: 30))
        progress.update(at: CGPoint(x: 41, y: 30))

        #expect(progress.origin == CGPoint(x: 40, y: 30))
        #expect(progress.maximumTravel == 20)

        progress.reset()
        #expect(progress.origin == nil)
        #expect(progress.maximumTravel == 0)
    }

    @Test func deliberateAutoTargetWinsOverElapsedTime() {
        let result = VoiceCaptureReducer.release(
            from: .hold,
            target: .auto,
            elapsed: 1,
            maximumTravel: 80
        )
        #expect(result.intents == [.enterAuto])
    }

    @Test func assistiveActivationUsesSemanticIntentSequence() {
        #expect(VoiceCaptureReducer.activate(from: .idle).intents == [.holdStart, .enterAuto])
        #expect(VoiceCaptureReducer.activate(from: .auto).intents == [.exitAuto])
    }

    @Test func autoRemainsOperableWithTypedDraftUntilExplicitExit() {
        let idleWithDraft = ComposerActionState(draftPresent: true, talkMode: .idle)
        let beforeTyping = ComposerActionState(draftPresent: false, talkMode: .continuous)
        let afterTyping = ComposerActionState(draftPresent: true, talkMode: .continuous)

        #expect(!idleWithDraft.showsVoiceCapture)
        #expect(beforeTyping.showsVoiceCapture)
        #expect(afterTyping.showsVoiceCapture)
        #expect(afterTyping.showsSend)
        #expect(VoiceCaptureReducer.authority(.continuous, disabled: false) == .auto)
        #expect(VoiceCaptureReducer.activate(from: .auto).intents == [.exitAuto])
    }

    @Test func staleTerminalOutsideHoldIsNoOp() {
        #expect(VoiceCaptureReducer.release(
            from: .auto,
            target: .cancel,
            elapsed: 1,
            maximumTravel: 0
        ).intents.isEmpty)
        #expect(VoiceCaptureReducer.release(
            from: .idle,
            target: .send,
            elapsed: 1,
            maximumTravel: 0
        ).intents.isEmpty)
    }

    @Test func autoSystemInterruptionExitsWithoutASecondTerminal() {
        let interruption = VoiceCaptureReducer.interrupt(from: .auto)
        let repeated = VoiceCaptureReducer.interrupt(from: interruption.state)

        #expect(interruption == VoiceCaptureTransition(state: .idle, intents: [.lifecycleCancel]))
        #expect(repeated.intents.isEmpty)
    }

    @Test func targetGeometryMatchesConnectedCompactCrownAndPod() {
        let geometry = VoiceCaptureTargetGeometry(
            podSize: CGSize(width: 198, height: 52),
            crownSize: CGSize(width: 210, height: 58),
            seamOverlap: 8
        )

        #expect(geometry.podBounds == CGRect(x: 0, y: 0, width: 198, height: 52))
        #expect(geometry.crownBounds == CGRect(x: -12, y: -50, width: 210, height: 58))
        #expect(geometry.target(at: CGPoint(x: 20, y: -30)) == .auto)
        #expect(geometry.target(at: CGPoint(x: 93, y: -30)) == .cancel)
        #expect(geometry.target(at: CGPoint(x: 170, y: -30)) == .send)
        #expect(geometry.target(at: CGPoint(x: 20, y: 26)) == .auto)
        #expect(geometry.target(at: CGPoint(x: 93, y: 26)) == .cancel)
        #expect(geometry.target(at: CGPoint(x: 170, y: 26)) == .send)
    }

    @Test func targetGeometryFallsBackToSendOutsideVisibleSurfaces() {
        let geometry = VoiceCaptureTargetGeometry(
            podSize: CGSize(width: 198, height: 52),
            crownSize: CGSize(width: 210, height: 58),
            seamOverlap: 8
        )

        #expect(geometry.target(at: CGPoint(x: 20, y: -500)) == .send)
        #expect(geometry.target(at: CGPoint(x: 20, y: 80)) == .send)
        #expect(geometry.target(at: CGPoint(x: -80, y: -20)) == .send)
        #expect(geometry.target(at: CGPoint(x: 240, y: 20)) == .send)
    }

    @Test func targetGeometryMirrorsFacetOrderInRightToLeftLayout() {
        let geometry = VoiceCaptureTargetGeometry(
            podSize: CGSize(width: 198, height: 52),
            crownSize: CGSize(width: 210, height: 58),
            seamOverlap: 8,
            rightToLeft: true
        )

        #expect(geometry.crownBounds == CGRect(x: 0, y: -50, width: 210, height: 58))
        #expect(geometry.target(at: CGPoint(x: 25, y: -25)) == .send)
        #expect(geometry.target(at: CGPoint(x: 105, y: -25)) == .cancel)
        #expect(geometry.target(at: CGPoint(x: 185, y: -25)) == .auto)
        #expect(geometry.target(at: CGPoint(x: 25, y: 25)) == .send)
        #expect(geometry.target(at: CGPoint(x: 185, y: 25)) == .auto)
    }

    @Test func rapidDeliberateDragsRetainTheBoundedSelectedRegion() {
        let geometry = VoiceCaptureTargetGeometry(
            podSize: CGSize(width: 198, height: 52),
            crownSize: CGSize(width: 210, height: 58),
            seamOverlap: 8
        )
        let cases: [(CGPoint, VoiceCaptureIntent)] = [
            (CGPoint(x: 20, y: -25), .enterAuto),
            (CGPoint(x: 93, y: -25), .cancelHeld),
            (CGPoint(x: 170, y: -25), .sendHeld),
        ]

        for (location, expectedIntent) in cases {
            let target = VoiceCaptureReducer.target(at: location, geometry: geometry)
            let transition = VoiceCaptureReducer.release(
                from: .hold,
                target: target,
                elapsed: 0.1,
                maximumTravel: 48
            )
            #expect(transition.intents == [expectedIntent])
        }
    }

    @Test func composerActionGroupsWrapAgainstTheirParentProposal() {
        #expect(!ComposerActionLayout.shouldStack(
            availableWidth: 359,
            leadingWidth: 93,
            trailingWidth: 248,
            spacing: 5
        ))
        #expect(ComposerActionLayout.shouldStack(
            availableWidth: 330,
            leadingWidth: 93,
            trailingWidth: 248,
            spacing: 5
        ))
        #expect(!ComposerActionLayout.shouldStack(
            availableWidth: 198,
            leadingWidth: 0,
            trailingWidth: 198,
            spacing: 5
        ))
    }

    @Test func widestTrailingActionsWrapWithoutShrinkingTouchTargets() {
        let availableWidth: CGFloat = 286
        let widths = [
            ComposerGeometry.smallControlSize,
            ComposerGeometry.compactTrailingControlSize,
            VoiceCaptureLayout.accessibilityLiveWidth,
        ]
        let rows = ComposerTrailingActionLayout.rows(
            availableWidth: availableWidth,
            itemWidths: widths,
            spacing: ComposerGeometry.trailingActionGap
        )

        #expect(rows == [[0, 1], [2]])
        #expect(widths.allSatisfy { $0 >= 44 })
        #expect(rows.allSatisfy { row in
            let width = row.map { widths[$0] }.reduce(0, +)
                + CGFloat(max(0, row.count - 1)) * ComposerGeometry.trailingActionGap
            return width <= availableWidth
        })
        #expect(VoiceCaptureLayout.compactLiveHeight >= 44)
        #expect(VoiceCaptureLayout.accessibilityCrownHeight >= 44)
        #expect(VoiceCaptureLayout.accessibilityLiveWidth / 3 >= 44)
    }

    @Test func presentationKeepsFailureAndDisabledStatesExplicit() {
        let denied = VoiceCapturePresentationState(state: .denied, disabled: false)
        let failed = VoiceCapturePresentationState(state: .failed, disabled: false)
        let transitioning = VoiceCapturePresentationState(state: .transitioning, disabled: false)
        let disabled = VoiceCapturePresentationState(state: .disabled, disabled: true)

        #expect(denied.showsFailureNotice)
        #expect(failed.showsFailureNotice)
        #expect(transitioning.isDisabled)
        #expect(!transitioning.showsWaveform)
        #expect(transitioning.primaryLabel == "Voice capture is changing modes")
        #expect(disabled.isDisabled)
        #expect(!disabled.showsWaveform)
        #expect(disabled.primaryLabel == "Voice unavailable while reconnecting")
    }

    @Test func reducedMotionWaveUsesClampedPerBarLevels() {
        let levels: [Float] = [-1, 0, 0.5, 2, .nan]

        #expect(PttWaveMetrics.levelScale(levels, at: 0) == PttWaveMetrics.levelFloor)
        #expect(PttWaveMetrics.levelScale(levels, at: 2) == 0.675)
        #expect(PttWaveMetrics.levelScale(levels, at: 3) == 1)
        #expect(PttWaveMetrics.levelScale(levels, at: 4) == PttWaveMetrics.levelFloor)
        #expect(PttWaveMetrics.levelScale(levels, at: 8) == PttWaveMetrics.levelFloor)
    }

    @Test func animatedWaveRetainsLevelAmplitude() {
        let quiet = PttWaveMetrics.animatedScale([0], at: 0, time: 0.5)
        let loud = PttWaveMetrics.animatedScale([1], at: 0, time: 0.5)

        #expect(quiet == PttWaveMetrics.levelFloor)
        #expect(loud == 1)
        #expect(loud > quiet)
    }
}
