import CoreGraphics
import Testing
@testable import SentientApp

struct VoiceCaptureControlTests {
    @Test func pressStartsHoldImmediately() {
        let result = VoiceCaptureReducer.begin(from: .idle)
        #expect(result == VoiceCaptureTransition(state: .hold, intents: [.holdStart]))
    }

    @Test func sustainedReleaseDefaultsToSend() {
        let result = VoiceCaptureReducer.release(from: .hold, target: .send, elapsed: 0.5)
        #expect(result.intents == [.sendHeld])
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
