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
    let onChange: (CGPoint, CGSize) -> Void
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
            onBegin()
        case .changed:
            let view = recognizer.view
            onChange(recognizer.location(in: view), view?.bounds.size ?? .zero)
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

    final class Coordinator {}
}
