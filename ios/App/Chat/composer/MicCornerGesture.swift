// ---------------------------------------------------------------------------
// MicCornerGesture — pure gesture math for the corner mic control
// (hold-to-talk / drag-to-lock). Mirrors the webui FSM exactly
// (gateway/webui/src/components/dock/mic-corner-gesture.ts): the SwiftUI
// control (MicCorner.swift) owns the touch plumbing, this owns the FSM.
// ---------------------------------------------------------------------------
import CoreGraphics

/// The corner mic's mode. Mic on ⇔ `.hold` or `.locked`.
enum MicCornerMode: String, Equatable, Sendable {
    case idle
    case hold
    case locked
}

/// Where the control settles when the finger lifts.
struct MicCornerRelease: Equatable, Sendable {
    let mode: MicCornerMode
    let drag: CGFloat
}

enum MicCornerGesture {
    /// Fraction of the travel that arms the lock when releasing from a hold.
    static let lockThreshold: CGFloat = 0.4
    /// Fraction of the travel a locked control must be dragged back below to release.
    static let unlockThreshold: CGFloat = 0.5

    /// Clamp finger movement into [0, travel] pt toward the lock end (leftward).
    static func clampDrag(base: CGFloat, startX: CGFloat, currentX: CGFloat, travel: CGFloat) -> CGFloat {
        max(0, min(travel, base + (startX - currentX)))
    }

    /// Resolve where the control settles when the finger lifts.
    static func resolveRelease(origin: MicCornerMode, drag: CGFloat, travel: CGFloat) -> MicCornerRelease {
        if origin == .locked {
            return drag <= travel * unlockThreshold
                ? MicCornerRelease(mode: .idle, drag: 0)
                : MicCornerRelease(mode: .locked, drag: travel)
        }
        return drag >= travel * lockThreshold
            ? MicCornerRelease(mode: .locked, drag: travel)
            : MicCornerRelease(mode: .idle, drag: 0)
    }

    /// Whether the current drag position would arm the lock on release.
    static func isArmed(drag: CGFloat, travel: CGFloat) -> Bool {
        drag >= travel * lockThreshold
    }
}
