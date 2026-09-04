import SwiftUI
import UIKit

enum VoiceCaptureGestureTermination: Equatable, Sendable {
    case released
    case cancelled
}

struct VoiceCaptureGestureSample: Equatable, Sendable {
    let locationInWindow: CGPoint
    let targetGeometryInWindow: VoiceCaptureTargetGeometry
}

struct VoiceCaptureGesture {
    let onBegin: (VoiceCaptureGestureSample) -> Void
    let onChange: (VoiceCaptureGestureSample) -> Void
    let onTerminate: (VoiceCaptureGestureTermination, VoiceCaptureGestureSample) -> Void
}

/// Fixed geometry for the UIKit gesture host. The host always covers the full
/// crown-and-pod envelope; only its initial hit region changes between the idle
/// button and expanded pod. This keeps the recognizer view's identity and
/// bounds stable while a held touch changes the SwiftUI presentation.
struct VoiceCaptureGestureHostGeometry: Equatable, Sendable {
    let hostSize: CGSize
    let idleBounds: CGRect
    let podBounds: CGRect
    let crownBounds: CGRect
    let rightToLeft: Bool

    init(
        idleSize: CGFloat,
        podSize: CGSize,
        crownSize: CGSize,
        seamOverlap: CGFloat,
        rightToLeft: Bool
    ) {
        let idleSize = max(0, idleSize)
        let podSize = CGSize(width: max(0, podSize.width), height: max(0, podSize.height))
        let crownSize = CGSize(width: max(0, crownSize.width), height: max(0, crownSize.height))
        let overlap = min(max(0, seamOverlap), min(podSize.height, crownSize.height))
        let width = max(podSize.width, crownSize.width)
        let height = podSize.height + crownSize.height - overlap
        let logicalTrailingX: (CGFloat) -> CGFloat = { itemWidth in
            rightToLeft ? 0 : width - itemWidth
        }

        hostSize = CGSize(width: width, height: height)
        podBounds = CGRect(
            x: logicalTrailingX(podSize.width),
            y: height - podSize.height,
            width: podSize.width,
            height: podSize.height
        )
        crownBounds = CGRect(
            x: logicalTrailingX(crownSize.width),
            y: 0,
            width: crownSize.width,
            height: crownSize.height
        )
        idleBounds = CGRect(
            x: logicalTrailingX(idleSize),
            y: height - idleSize,
            width: idleSize,
            height: idleSize
        )
        self.rightToLeft = rightToLeft
    }

    func initialHitBounds(expanded: Bool) -> CGRect {
        expanded ? podBounds : idleBounds
    }

    /// Offset for a crown that SwiftUI initially bottom-aligns with the pod.
    /// Both visual placement and target frames derive from these same bounds.
    var crownBottomAlignmentOffset: CGFloat {
        crownBounds.maxY - podBounds.maxY
    }

    func targetGeometry(in view: UIView) -> VoiceCaptureTargetGeometry {
        VoiceCaptureTargetGeometry(
            podBounds: view.convert(podBounds, to: view.window),
            crownBounds: view.convert(crownBounds, to: view.window),
            rightToLeft: rightToLeft
        )
    }
}

/// A layout-stable UIKit host owns one immediate tracking recognizer for the
/// complete down/move/up sequence. A zero-duration `UILongPressGestureRecognizer`
/// is intentionally not used: it still performs long-press recognition and can
/// lose ownership when attached to the SwiftUI button that morphs and resizes.
struct VoiceCaptureGestureHost: UIViewRepresentable {
    let geometry: VoiceCaptureGestureHostGeometry
    let expanded: Bool
    let disabled: Bool
    let gesture: VoiceCaptureGesture

    func makeCoordinator() -> Coordinator {
        Coordinator(gesture: gesture, geometry: geometry)
    }

    func makeUIView(context: Context) -> VoiceCaptureGestureHostView {
        let view = VoiceCaptureGestureHostView()
        view.backgroundColor = .clear
        view.isOpaque = false
        view.isAccessibilityElement = false
        context.coordinator.attach(to: view)
        return view
    }

    func updateUIView(_ view: VoiceCaptureGestureHostView, context: Context) {
        context.coordinator.update(gesture: gesture, geometry: geometry)
        view.acceptedHitBounds = geometry.initialHitBounds(expanded: expanded)
        view.acceptsNewTouches = !disabled
    }

    final class Coordinator: NSObject {
        private var gesture: VoiceCaptureGesture
        private var geometry: VoiceCaptureGestureHostGeometry
        private let recognizer = VoiceCaptureTrackingGestureRecognizer()

        init(gesture: VoiceCaptureGesture, geometry: VoiceCaptureGestureHostGeometry) {
            self.gesture = gesture
            self.geometry = geometry
            super.init()
            recognizer.addTarget(self, action: #selector(handleRecognizer(_:)))
            recognizer.cancelsTouchesInView = true
            recognizer.delaysTouchesBegan = false
            recognizer.delaysTouchesEnded = false
        }

        func attach(to view: UIView) {
            view.addGestureRecognizer(recognizer)
        }

        func update(
            gesture: VoiceCaptureGesture,
            geometry: VoiceCaptureGestureHostGeometry
        ) {
            self.gesture = gesture
            self.geometry = geometry
        }

        @objc private func handleRecognizer(_ recognizer: UIGestureRecognizer) {
            guard let view = recognizer.view else { return }
            let sample = VoiceCaptureGestureSample(
                locationInWindow: recognizer.location(in: view.window),
                targetGeometryInWindow: geometry.targetGeometry(in: view)
            )
            switch recognizer.state {
            case .began:
                gesture.onBegin(sample)
            case .changed:
                gesture.onChange(sample)
            case .ended:
                gesture.onTerminate(.released, sample)
            case .cancelled, .failed:
                gesture.onTerminate(.cancelled, sample)
            default:
                break
            }
        }
    }
}

final class VoiceCaptureGestureHostView: UIView {
    var acceptedHitBounds: CGRect = .zero
    var acceptsNewTouches = true

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        acceptsNewTouches && acceptedHitBounds.contains(point)
    }
}

enum VoiceCaptureTrackedTouchEvent: Equatable, Sendable {
    case started
    case changed
    case released
    case cancelled
    case rejected
    case ignored
}

/// Tracks one primary touch. Extra touches that arrive after ownership begins
/// cannot terminate or invalidate the recognized primary sequence.
struct VoiceCaptureTouchTracker<TouchID: Hashable> {
    private(set) var primaryTouch: TouchID?

    mutating func touchesBegan(_ touches: Set<TouchID>) -> VoiceCaptureTrackedTouchEvent {
        if primaryTouch != nil { return .ignored }
        guard touches.count == 1, let touch = touches.first else { return .rejected }
        primaryTouch = touch
        return .started
    }

    mutating func touchesMoved(_ touches: Set<TouchID>) -> VoiceCaptureTrackedTouchEvent {
        guard let primaryTouch, touches.contains(primaryTouch) else { return .ignored }
        return .changed
    }

    mutating func touchesEnded(_ touches: Set<TouchID>) -> VoiceCaptureTrackedTouchEvent {
        guard let primaryTouch, touches.contains(primaryTouch) else { return .ignored }
        self.primaryTouch = nil
        return .released
    }

    mutating func touchesCancelled(_ touches: Set<TouchID>) -> VoiceCaptureTrackedTouchEvent {
        guard let primaryTouch, touches.contains(primaryTouch) else { return .ignored }
        self.primaryTouch = nil
        return .cancelled
    }

    mutating func reset() {
        primaryTouch = nil
    }
}

/// Immediate single-touch tracking without a duration gate or location timer.
/// UIKit retains the recognized touch after it leaves the host's bounds and
/// reports system cancellation separately from a confirmed finger-up.
final class VoiceCaptureTrackingGestureRecognizer: UIGestureRecognizer {
    private var touchTracker = VoiceCaptureTouchTracker<ObjectIdentifier>()

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        switch touchTracker.touchesBegan(identifiers(for: touches)) {
        case .started:
            state = .began
        case .rejected:
            state = .failed
        case .changed, .released, .cancelled, .ignored:
            break
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if touchTracker.touchesMoved(identifiers(for: touches)) == .changed,
           state == .began || state == .changed {
            state = .changed
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        if touchTracker.touchesEnded(identifiers(for: touches)) == .released,
           state == .began || state == .changed {
            state = .ended
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        if touchTracker.touchesCancelled(identifiers(for: touches)) == .cancelled,
           state == .began || state == .changed {
            state = .cancelled
        }
    }

    override func reset() {
        touchTracker.reset()
        super.reset()
    }

    private func identifiers(for touches: Set<UITouch>) -> Set<ObjectIdentifier> {
        Set(touches.map(ObjectIdentifier.init))
    }
}
