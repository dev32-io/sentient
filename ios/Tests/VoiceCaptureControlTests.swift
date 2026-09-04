import CoreGraphics
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
            termination: .released
        )
        let lateRelease = VoiceCaptureReducer.terminatePhysicalHold(
            from: release.state,
            target: .send,
            elapsed: 0.6,
            termination: .released
        )

        #expect(release.intents + lateRelease.intents == [.sendHeld])
    }

    @Test func heldSystemCancellationCancelsExactlyOnceAndNeverSends() {
        let cancellation = VoiceCaptureReducer.terminatePhysicalHold(
            from: .hold,
            target: .send,
            elapsed: 0.5,
            termination: .cancelled
        )
        let lateRelease = VoiceCaptureReducer.terminatePhysicalHold(
            from: cancellation.state,
            target: .send,
            elapsed: 0.6,
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
            termination: .released
        )
        let intents = interruption.intents + repeatedInterruption.intents + lateRelease.intents

        #expect(intents == [.lifecycleCancel])
        #expect(!intents.contains(.sendHeld))
    }

    @Test func explicitCancelDiscards() {
        let result = VoiceCaptureReducer.release(from: .hold, target: .cancel, elapsed: 0.5)
        #expect(result.intents == [.cancelHeld])
    }

    @Test func quickActivationTransitionsHoldToFreshAuto() {
        let result = VoiceCaptureReducer.release(from: .hold, target: .send, elapsed: 0.1)
        #expect(result.intents == [.enterAuto])
    }

    @Test func deliberateAutoTargetWinsOverElapsedTime() {
        let result = VoiceCaptureReducer.release(from: .hold, target: .auto, elapsed: 1)
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
        #expect(VoiceCaptureReducer.release(from: .auto, target: .cancel, elapsed: 1).intents.isEmpty)
        #expect(VoiceCaptureReducer.release(from: .idle, target: .send, elapsed: 1).intents.isEmpty)
    }

    @Test func autoSystemInterruptionExitsWithoutASecondTerminal() {
        let interruption = VoiceCaptureReducer.interrupt(from: .auto)
        let repeated = VoiceCaptureReducer.interrupt(from: interruption.state)

        #expect(interruption == VoiceCaptureTransition(state: .idle, intents: [.lifecycleCancel]))
        #expect(repeated.intents.isEmpty)
    }

    @Test func dragTargetsUseHorizontalAutoCancelSendRegionsAcrossCrownAndPod() {
        let width: CGFloat = 198

        #expect(VoiceCaptureReducer.target(at: CGPoint(x: 12, y: -46), controlWidth: width) == .auto)
        #expect(VoiceCaptureReducer.target(at: CGPoint(x: 99, y: -20), controlWidth: width) == .cancel)
        #expect(VoiceCaptureReducer.target(at: CGPoint(x: 184, y: 26), controlWidth: width) == .send)
        #expect(VoiceCaptureReducer.target(at: CGPoint(x: -40, y: 8), controlWidth: width) == .auto)
        #expect(VoiceCaptureReducer.target(at: CGPoint(x: 240, y: -40), controlWidth: width) == .send)
        #expect(VoiceCaptureReducer.target(
            at: CGPoint(x: 12, y: -46),
            controlWidth: width,
            rightToLeft: true
        ) == .send)
        #expect(VoiceCaptureReducer.target(
            at: CGPoint(x: 184, y: -46),
            controlWidth: width,
            rightToLeft: true
        ) == .auto)
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
