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

    @Test func dragTargetsUseAutoCancelSendOrder() {
        #expect(VoiceCaptureReducer.target(for: 0) == .send)
        #expect(VoiceCaptureReducer.target(for: VoiceCaptureReducer.targetStep) == .cancel)
        #expect(VoiceCaptureReducer.target(for: VoiceCaptureReducer.targetStep * 2) == .auto)
    }
}
