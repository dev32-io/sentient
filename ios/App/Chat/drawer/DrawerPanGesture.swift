// ---------------------------------------------------------------------------
// DrawerPanGesture — a thin iOS-18 `UIGestureRecognizerRepresentable` bridge that
// hands a UIKit pan recognizer to a pure-SwiftUI drawer view. This is the ONLY
// UIKit surface the drawer needs: it carries the `UIGestureRecognizerDelegate`
// (begin gate + simultaneous recognition) so the panel's inner SwiftUI ScrollView
// keeps vertical scrolling while a horizontal drag drives the drawer offset. No
// UIViewController, so the drag offset lives in SwiftUI @State and can never be
// clobbered by a UIKit layout pass.
//
// Both kinds use a plain UIPanGestureRecognizer (NOT UIScreenEdgePanGestureRecognizer):
//  - .edgeOpen  → begins only when the touch STARTS within `edgeZoneWidth` of the
//    left edge AND is horizontally dominant. A regular pan (vs the screen-edge
//    recognizer) is reliably driven by synthetic test swipes (Maestro) while
//    still feeling like an edge-drag for a real finger.
//  - .closeDrag → begins on any horizontally-dominant drag on the open drawer +
//    dim, so a vertical scroll inside the panel passes through.
//
// Begin gate uses TRANSLATION/location, NOT begin-velocity (~0 at .began) — the
// velocity gate was the old controller's close-drag bug.
// ---------------------------------------------------------------------------
import SwiftUI
import UIKit

/// Bridges a UIKit pan recognizer into SwiftUI, reporting horizontal translation
/// while dragging and (translation, velocity) at end so the host can velocity-snap.
struct DrawerPanGesture: UIGestureRecognizerRepresentable {
    enum Kind { case edgeOpen, closeDrag }

    let kind: Kind
    /// translation.x while the finger is down (.changed).
    let onChange: (CGFloat) -> Void
    /// (translationX, velocityX) at gesture end / cancel / fail.
    let onEnd: (CGFloat, CGFloat) -> Void

    /// How close to the left edge a touch must begin to arm an edge-open drag.
    private static let edgeZoneWidth: CGFloat = 40

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let recognizer = UIPanGestureRecognizer()
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let translation = recognizer.translation(in: recognizer.view)
        let velocity = recognizer.velocity(in: recognizer.view)
        switch recognizer.state {
        case .changed:
            onChange(translation.x)
        case .ended, .cancelled, .failed:
            onEnd(translation.x, velocity.x)
        default:
            break
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator(kind: kind, edgeZoneWidth: Self.edgeZoneWidth)
    }

    /// Carries the `UIGestureRecognizerDelegate` for the begin gate + scroll coexistence.
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private let kind: Kind
        private let edgeZoneWidth: CGFloat

        init(kind: Kind, edgeZoneWidth: CGFloat) {
            self.kind = kind
            self.edgeZoneWidth = edgeZoneWidth
        }

        /// Begin gate. Both kinds require horizontal dominance (by TRANSLATION,
        /// since begin-velocity is ~0). Edge-open additionally requires the touch
        /// to have STARTED within the left-edge zone.
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
            let translation = pan.translation(in: pan.view)
            guard abs(translation.x) > abs(translation.y) else { return false }
            if kind == .edgeOpen {
                // Back out the translation from the current location to recover the
                // touch-down x, then require it inside the edge zone.
                let location = pan.location(in: pan.view)
                let startX = location.x - translation.x
                return startX <= edgeZoneWidth && translation.x > 0
            }
            return true
        }

        /// Ride alongside the inner scroll's recognizers; the begin gate keeps
        /// both from claiming the same drag.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }
}
