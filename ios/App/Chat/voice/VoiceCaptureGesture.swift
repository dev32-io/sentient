import SwiftUI
import UIKit

enum VoiceCaptureGestureTermination: Equatable, Sendable {
    case released
    case cancelled
}

struct VoiceCaptureGestureSample: Equatable, Sendable {
    let location: CGPoint
    let locationInWindow: CGPoint
    let viewSize: CGSize
}

/// UIKit-backed physical hold recognition distinguishes a confirmed finger-up
/// from cancellation by the system. SwiftUI's `DragGesture.onEnded` does not
/// expose that distinction. Window-space samples keep travel stable while the
/// recognized view expands from the idle control into the Hold pod.
struct VoiceCaptureGesture: UIGestureRecognizerRepresentable {
    let onBegin: (VoiceCaptureGestureSample) -> Void
    let onChange: (VoiceCaptureGestureSample) -> Void
    let onTerminate: (VoiceCaptureGestureTermination, VoiceCaptureGestureSample) -> Void

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
        let sample = VoiceCaptureGestureSample(
            location: recognizer.location(in: recognizer.view),
            locationInWindow: recognizer.location(in: recognizer.view?.window),
            viewSize: recognizer.view?.bounds.size ?? .zero
        )
        switch recognizer.state {
        case .began:
            onBegin(sample)
        case .changed:
            onChange(sample)
        case .ended:
            onTerminate(.released, sample)
        case .cancelled, .failed:
            onTerminate(.cancelled, sample)
        default:
            break
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    final class Coordinator {}
}
