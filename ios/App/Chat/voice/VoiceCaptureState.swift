import CoreGraphics
import Foundation
import MobileData

/// Composer-owned capture presentation. Shared `TalkMode` remains authoritative;
/// this state only describes native interaction and failure presentation.
enum VoiceCaptureState: String, Equatable, Sendable {
    case idle, hold, auto, transitioning, denied, failed, disabled
}

/// Presentation facts kept next to the pure capture state. The SwiftUI leaves
/// consume this projection instead of reaching into the control's state or
/// transport callbacks.
struct VoiceCapturePresentationState: Equatable, Sendable {
    let state: VoiceCaptureState
    let disabled: Bool

    var isTransitioning: Bool { state == .transitioning }
    var isDisabled: Bool { disabled || state == .disabled || isTransitioning }
    var isAuto: Bool { state == .auto && !isDisabled }
    var isHolding: Bool { state == .hold && !isDisabled }
    var isExpanded: Bool { isHolding || isAuto }
    var showsWaveform: Bool { isExpanded }
    var showsTargetDeck: Bool { isHolding }
    var showsFailureNotice: Bool { state == .denied || state == .failed }

    var primaryLabel: String {
        if isTransitioning { return "Voice capture is changing modes" }
        if isDisabled { return "Voice unavailable while reconnecting" }
        if isAuto { return "Auto listening is on; activate to send and turn it off" }
        return "Tap for Auto listening or hold to talk"
    }

    var primaryHint: String {
        if isTransitioning { return "Wait for voice capture to finish changing modes" }
        if isDisabled { return "Text input remains available" }
        if isAuto { return "Double-tap to send and turn off Auto listening" }
        if isHolding { return "Slide across Auto, Cancel, and Send, then lift" }
        return "Double-tap for Auto listening, or use the Start Hold action"
    }

    var failureMessage: String {
        state == .denied
            ? "Microphone access is off. Text messages are still available."
            : "Voice capture could not start. Text messages are still available."
    }
}

enum VoiceCaptureTarget: String, Equatable, Sendable {
    case auto, cancel, send
}

enum VoiceCaptureIntent: Equatable, Sendable {
    case holdStart, sendHeld, cancelHeld, enterAuto, exitAuto, lifecycleCancel
}

struct VoiceCaptureTransition: Equatable, Sendable {
    let state: VoiceCaptureState
    let intents: [VoiceCaptureIntent]
}

/// Pure capture reducer used by the SwiftUI control and fake-capture tests.
/// KMP owns capture IDs, terminal races, frame ordering, and stale isolation.
enum VoiceCaptureReducer {
    static let quickAutoThreshold: TimeInterval = 0.22

    static func begin(from state: VoiceCaptureState) -> VoiceCaptureTransition {
        guard state == .idle || state == .denied || state == .failed else {
            return .init(state: state, intents: [])
        }
        return .init(state: .hold, intents: [.holdStart])
    }

    static func release(
        from state: VoiceCaptureState,
        target: VoiceCaptureTarget,
        elapsed: TimeInterval,
        cancelled: Bool = false
    ) -> VoiceCaptureTransition {
        terminatePhysicalHold(
            from: state,
            target: target,
            elapsed: elapsed,
            termination: cancelled ? .cancelled : .released
        )
    }

    static func terminatePhysicalHold(
        from state: VoiceCaptureState,
        target: VoiceCaptureTarget,
        elapsed: TimeInterval,
        termination: VoiceCaptureGestureTermination
    ) -> VoiceCaptureTransition {
        guard state == .hold else { return .init(state: state, intents: []) }
        if termination == .cancelled || target == .cancel {
            return .init(state: .transitioning, intents: [.cancelHeld])
        }
        if target == .auto || elapsed < quickAutoThreshold {
            return .init(state: .transitioning, intents: [.enterAuto])
        }
        return .init(state: .transitioning, intents: [.sendHeld])
    }

    static func interrupt(from state: VoiceCaptureState) -> VoiceCaptureTransition {
        guard state == .hold || state == .auto || state == .transitioning else {
            return .init(state: state, intents: [])
        }
        return .init(state: .idle, intents: [.lifecycleCancel])
    }

    static func activate(from state: VoiceCaptureState) -> VoiceCaptureTransition {
        switch state {
        case .idle, .denied, .failed:
            // Assistive activation enters Auto through the same semantic sequence as
            // Hold-to-Auto: fresh manual capture, commit, then fresh semantic capture.
            return .init(state: .transitioning, intents: [.holdStart, .enterAuto])
        case .auto:
            return .init(state: .transitioning, intents: [.exitAuto])
        default:
            return .init(state: state, intents: [])
        }
    }

    static func authority(_ mode: TalkMode, disabled: Bool) -> VoiceCaptureState {
        if disabled { return .disabled }
        switch mode {
        case .idle: return .idle
        case .hold: return .hold
        case .continuous: return .auto
        }
    }

    /// The connected crown and pod share three horizontal regions. Keeping the
    /// classifier independent of vertical travel lets a held pointer move over
    /// either surface without changing the Auto, Cancel, Send order.
    static func target(
        at location: CGPoint,
        controlWidth: CGFloat,
        rightToLeft: Bool = false
    ) -> VoiceCaptureTarget {
        guard controlWidth > 0 else { return .send }
        let boundedX = min(max(location.x, 0), controlWidth)
        let directionalX = rightToLeft ? controlWidth - boundedX : boundedX
        if directionalX < controlWidth / 3 { return .auto }
        if directionalX < controlWidth * 2 / 3 { return .cancel }
        return .send
    }
}
