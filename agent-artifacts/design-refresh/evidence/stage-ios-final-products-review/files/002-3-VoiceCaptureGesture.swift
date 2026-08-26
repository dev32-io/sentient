import SwiftUI
import UIKit

enum VoiceCaptureGestureTermination: Equatable, Sendable {
    case released
    case cancelled
}

/// UIKit-backed physical hold recognition distinguishes a confirmed finger-up
/// from cancellation by the system. SwiftUI's `DragGesture.onEnded` does not
/// expose that distinction.
struct VoiceCaptureGesture: UIGestureRecognizerRepresentable {
    let onBegin: () -> Void
    let onChange: (CGFloat) -> Void
    let onTerminate: (VoiceCaptureGestureTermination) -> Void

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let recognizer = UILongPressGestureRecognizer()
        recognizer.minimumPressDuration = 0
        recognizer.allowableMovement = .greatestFiniteMagnitude
        recognizer.cancelsTouchesInView = true
        return recognizer
    }

    func handleUIGestureRecognizerAction(
        _ recognizer: UILongPressGestureRecognizer,
        context: Context
    ) {
        switch recognizer.state {
        case .began:
            context.coordinator.startY = recognizer.location(in: recognizer.view).y
            onBegin()
        case .changed:
            let currentY = recognizer.location(in: recognizer.view).y
            onChange(max(0, context.coordinator.startY - currentY))
        case .ended:
            onTerminate(.released)
        case .cancelled, .failed:
            onTerminate(.cancelled)
        default:
            break
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    final class Coordinator {
        var startY: CGFloat = 0
    }
}
