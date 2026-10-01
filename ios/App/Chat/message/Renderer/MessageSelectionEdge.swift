import UIKit

/// Observes physical touch lifetime without recognizing selection, preventing any
/// native recognizer, or installing another set of handles. Window coordinates
/// remain stationary when the host scrolls the document underneath the finger.
final class MessagePointerObserver: UIGestureRecognizer {
    var sample: ((CGPoint?) -> Void)?
    private weak var tracked: UITouch?
    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        guard tracked == nil, touches.count == 1, let touch = touches.first else {
            sample?(nil); state = .failed; return
        }
        tracked = touch
        sample?(touch.location(in: view?.window))
        state = .began
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        guard let tracked else { return }
        sample?(tracked.location(in: view?.window))
        state = .changed
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        sample?(nil); tracked = nil; state = .ended
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        sample?(nil); tracked = nil; state = .cancelled
    }
    override func reset() {
        super.reset()
        tracked = nil
        sample?(nil)
    }
}

/// Only supplies geometry-driven motion during an already-native selection drag.
/// Host owns vertical scroll policy/bounds and returns the actual applied delta.
/// Native selection and this coordinator write the SAME UITextInput range.
@MainActor
final class MessageSelectionEdge {
    private weak var document: MessageDocumentView?
    private(set) var pointer: CGPoint?
    private(set) var anchor: Int?
    private var pointerToCaret = CGVector.zero
    private var applying = false
    private var lastTime: TimeInterval?
    private var link: UIUpdateLink?
    private(set) var frameCount = 0
    private(set) var pointerSamples = 0
    private(set) var nativeGestureStates: [String: Int] = [:]
    private var anchorTrailing = false
    private var armedAnchor: Int?
    private var activeGesture: ObjectIdentifier?
    private var cancelled = false
    var isRunning: Bool { link?.isEnabled == true }
    var onMotion: ((CGPoint, Int, CGFloat, CGFloat) -> Void)?

    init(document: MessageDocumentView) { self.document = document }

    func sample(_ point: CGPoint?, handleAnchor: Int? = nil) {
        guard let point else { stop(); return }
        pointerSamples += 1
        if pointer == nil {
            armedAnchor = cancelled ? nil : handleAnchor
            if let document, let handleAnchor,
               let range = (document.selectedTextRange as? MessageTextRange)?.value {
                anchorTrailing = NSMaxRange(range) == handleAnchor
                let endpoint = range.location == handleAnchor ? NSMaxRange(range) : range.location
                let caret = document.convert(document.caretRect(for: MessageTextPosition(endpoint)), to: document.window)
                pointerToCaret = CGVector(dx: 0, dy: caret.midY - point.y)
            }
        }
        pointer = point
        updateScheduling()
    }

    /// These states are observed via the public gesturesForFailureRequirements
    /// API, without changing recognizer delegates, failure rules or native views.
    func nativeGestureChanged(_ state: UIGestureRecognizer.State, id: ObjectIdentifier) {
        nativeGestureStates[String(state.rawValue), default: 0] += 1
        if !cancelled, state == .began || state == .changed, anchor == nil, let armedAnchor {
            anchor = armedAnchor
            activeGesture = id
            updateScheduling()
        } else if id == activeGesture {
            if state == .ended { stop() }
            else if state == .cancelled || state == .failed {
                anchor = nil; armedAnchor = nil; activeGesture = nil
                cancelled = true
                suspend(); link = nil
            }
        }
    }

    /// UIKit's preview range is not committed to selectedTextRange until release.
    /// Its public hit test supplies the native finger-to-caret vertical lift.
    func nativeHitTest(_ point: CGPoint) {
        guard !applying, armedAnchor != nil, let document, let pointer else { return }
        let windowPoint = document.convert(point, to: document.window)
        pointerToCaret = CGVector(dx: 0, dy: windowPoint.y - pointer.y)
        updateScheduling()
    }

    func remap(from old: MessageDocument, to new: MessageDocument) {
        if let anchor { self.anchor = new.remap(NSRange(location: anchor, length: 0), from: old, caretTrailing: anchorTrailing).location }
        if let armedAnchor { self.armedAnchor = new.remap(NSRange(location: armedAnchor, length: 0), from: old, caretTrailing: anchorTrailing).location }
    }

    func stop() {
        pointer = nil; anchor = nil; armedAnchor = nil; activeGesture = nil; cancelled = false
        suspend()
        link = nil
    }
    private func suspend() { link?.isEnabled = false; lastTime = nil }

    /// Call when host viewport or document layout changes, even with no touch move.
    func geometryChanged() { updateScheduling() }

    private func velocity() -> CGVector {
        guard let document, document.window != nil, let pointer, anchor != nil else { return .zero }
        let viewport = document.selectionViewportInWindow?() ?? .null
        let vertical = viewport.isNull ? 0 : Self.speed(pointer.y, min: viewport.minY, max: viewport.maxY)
        let local = document.convert(CGPoint(x: pointer.x + pointerToCaret.dx, y: pointer.y + pointerToCaret.dy), from: document.window)
        document.activateTable(at: local)
        let table = document.tableRect
        let horizontal = (table.minY...table.maxY).contains(local.y)
            ? Self.speed(local.x, min: table.minX, max: table.maxX) : 0
        return CGVector(dx: horizontal, dy: vertical)
    }
    private static func speed(_ value: CGFloat, min lower: CGFloat, max upper: CGFloat) -> CGFloat {
        let band: CGFloat = 32
        if value < lower + band { return -240 * min(1, max(0, (lower + band - value) / band)) }
        if value > upper - band { return 240 * min(1, max(0, (value - upper + band) / band)) }
        return 0
    }
    private func updateScheduling() {
        let v = velocity()
        guard v != .zero, let document else { suspend(); return }
        if link == nil {
            link = UIUpdateLink(view: document) { [weak self] _, info in self?.advance(at: info.modelTime) }
            link?.requiresContinuousUpdates = true
        }
        link?.isEnabled = true
    }

    /// Same frame step exercised by the scroll-contract regression; no synthetic
    /// gesture or alternate hit-testing path lives here.
    func advance(at time: TimeInterval) {
        guard let document, document.window != nil, let pointer, let anchor else { stop(); return }
        let dt = min(1.0 / 30, max(0, time - (lastTime ?? time)))
        lastTime = time
        guard dt > 0 else { return }
        let v = velocity()
        guard v != .zero else { suspend(); return }
        applying = true
        defer { applying = false }
        let before = document.tableOffset
        document.setTableOffset(before + v.dx * dt)
        let dx = document.tableOffset - before
        var requestedY = v.dy * dt
        if requestedY != 0, let viewport = document.selectionViewportInWindow?() {
            // Do not scroll beyond this bubble merely because the host has more
            // rows/padding. Keep its terminal caret inside the visible viewport.
            let position = requestedY > 0 ? document.endOfDocument : document.beginningOfDocument
            let caret = document.convert(document.caretRect(for: position), to: document.window)
            let target = pointer.y + pointerToCaret.dy
            if requestedY > 0 {
                requestedY = min(requestedY, max(0, caret.midY - min(target, viewport.maxY - caret.height / 2)))
            } else {
                requestedY = max(requestedY, min(0, caret.midY - max(target, viewport.minY + caret.height / 2)))
            }
        }
        let dy = requestedY == 0 ? 0 : (document.requestSelectionScroll?(requestedY) ?? 0)
        guard dx != 0 || dy != 0 else { suspend(); return }
        let local = document.convert(CGPoint(x: pointer.x + pointerToCaret.dx, y: pointer.y + pointerToCaret.dy), from: document.window)
        guard let endpoint = document.closestPosition(to: local) as? MessageTextPosition else { return }
        document.selectedTextRange = MessageTextRange(NSRange(location: min(anchor, endpoint.index), length: abs(endpoint.index - anchor)))
        document.refreshSelectionGeometry()
        frameCount += 1
        onMotion?(pointer, anchor, dx, dy)
    }
}
