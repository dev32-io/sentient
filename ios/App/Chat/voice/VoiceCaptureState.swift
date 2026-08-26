import CoreGraphics
import Foundation
import MobileData

/// Composer-owned capture presentation. Shared `TalkMode` remains authoritative;
/// this state only describes native interaction and failure presentation.
enum VoiceCaptureState: String, Equatable, Sendable {
    case idle, hold, auto, transitioning, denied, failed, disabled
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
    static let targetStep: CGFloat = 58

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

    /// Dragging upward selects the reviewed fan order: Send (default), Cancel, Auto.
    static func target(for upwardTravel: CGFloat) -> VoiceCaptureTarget {
        if upwardTravel >= targetStep * 1.5 { return .auto }
        if upwardTravel >= targetStep * 0.5 { return .cancel }
        return .send
    }
}
