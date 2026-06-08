// ---------------------------------------------------------------------------
// SideDrawerController — native UIKit interactive left-edge drawer that hosts
// two SwiftUI subtrees (the chat content column + the History side panel) via
// UIHostingController, with a dimming scrim between them.
//
// Why UIKit and not a SwiftUI DragGesture: the panel's inner SwiftUI ScrollView
// fights a SwiftUI DragGesture, so close-drags get eaten. UIKit gesture
// recognizers + a |dx|>|dy| begin gate let the finger track the panel in both
// directions while the panel's vertical scroll still works.
//
// Gestures:
//  - UIScreenEdgePanGestureRecognizer(.left) on content → interactive OPEN.
//  - UIPanGestureRecognizer on drawer + dim → interactive CLOSE (delegate gates
//    on horizontal dominance so vertical scroll passes through).
//  - UITapGestureRecognizer on dim → close.
// Snap on gesture end uses position + predicted velocity; spring animation.
// onOpen fires whenever the drawer reaches fully-open (edge-swipe OR programmatic),
// so the host can refresh the session list on every open.
// ---------------------------------------------------------------------------
import UIKit

/// Layout / motion constants for the drawer. No magic numbers in the body.
enum SideDrawerMetrics {
    /// Drawer width: 86 % of screen, capped so it never spans a wide device.
    static let widthFraction: CGFloat = 0.86
    static let maxWidth: CGFloat = 320
    /// Scrim opacity at fully-open.
    static let dimMaxAlpha: CGFloat = 0.5
    /// Past this open-fraction (0…1) at gesture end, no-velocity snaps open.
    static let snapThreshold: CGFloat = 0.5
    /// Horizontal velocity (pt/s) that forces a directional snap regardless of position.
    static let velocitySnap: CGFloat = 350
    /// Spring snap animation.
    static let springDuration: TimeInterval = 0.35
    static let springDamping: CGFloat = 0.86

    static func width(for bounds: CGRect) -> CGFloat {
        min(maxWidth, bounds.width * widthFraction)
    }
}

@MainActor
final class SideDrawerController: UIViewController, UIGestureRecognizerDelegate {
    private let content: UIViewController
    private let drawer: UIViewController
    private let dim = UIView()

    /// Leading constraint of the drawer; constant ranges from -width (closed) to 0 (open).
    private var drawerLeading: NSLayoutConstraint?
    private var drawerWidth: NSLayoutConstraint?

    /// drawerLeading.constant captured at the start of an interactive gesture.
    private var dragStart: CGFloat = 0

    private(set) var isOpen = false

    /// Fired when the drawer settles fully open (any path). Host refreshes here.
    var onOpen: () -> Void = {}
    /// Fired when the drawer settles fully closed via interaction/tap (not the
    /// programmatic close), so the SwiftUI binding can sync back to false.
    var onDismiss: () -> Void = {}

    private let log = AppLog("chat", "drawer")

    init(content: UIViewController, drawer: UIViewController) {
        self.content = content
        self.drawer = drawer
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    override func viewDidLoad() {
        super.viewDidLoad()
        installContent()
        installDim()
        installDrawer()
        installGestures()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = SideDrawerMetrics.width(for: view.bounds)
        drawerWidth?.constant = width
        // Keep the constant consistent with open/closed across rotation.
        drawerLeading?.constant = isOpen ? 0 : -width
        dim.alpha = isOpen ? SideDrawerMetrics.dimMaxAlpha : 0
    }

    // ── Child install ─────────────────────────────────────────────────────────

    private func installContent() {
        addChild(content)
        content.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content.view)
        NSLayoutConstraint.activate([
            content.view.topAnchor.constraint(equalTo: view.topAnchor),
            content.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            content.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        content.didMove(toParent: self)
    }

    private func installDim() {
        dim.translatesAutoresizingMaskIntoConstraints = false
        dim.backgroundColor = .black
        dim.alpha = 0
        dim.isUserInteractionEnabled = false
        view.addSubview(dim)
        NSLayoutConstraint.activate([
            dim.topAnchor.constraint(equalTo: view.topAnchor),
            dim.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            dim.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            dim.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func installDrawer() {
        addChild(drawer)
        drawer.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(drawer.view)
        let width = SideDrawerMetrics.width(for: view.bounds)
        let leading = drawer.view.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: -width)
        let widthC = drawer.view.widthAnchor.constraint(equalToConstant: width)
        NSLayoutConstraint.activate([
            drawer.view.topAnchor.constraint(equalTo: view.topAnchor),
            drawer.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            leading, widthC,
        ])
        drawerLeading = leading
        drawerWidth = widthC
        drawer.didMove(toParent: self)
    }

    // ── Gestures ──────────────────────────────────────────────────────────────

    private func installGestures() {
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdgePan(_:)))
        edge.edges = .left
        edge.delegate = self
        content.view.addGestureRecognizer(edge)

        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleClosePan(_:)))
        pan.delegate = self
        drawer.view.addGestureRecognizer(pan)
        let dimPan = UIPanGestureRecognizer(target: self, action: #selector(handleClosePan(_:)))
        dimPan.delegate = self
        dim.addGestureRecognizer(dimPan)

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleDimTap))
        dim.addGestureRecognizer(tap)
    }

    @objc private func handleEdgePan(_ g: UIScreenEdgePanGestureRecognizer) {
        let width = SideDrawerMetrics.width(for: view.bounds)
        switch g.state {
        case .began:
            dragStart = -width
            dim.isUserInteractionEnabled = true
        case .changed:
            apply(offset: dragStart + g.translation(in: view).x, width: width)
        case .ended, .cancelled, .failed:
            finishDrag(velocity: g.velocity(in: view).x, width: width)
        default:
            break
        }
    }

    @objc private func handleClosePan(_ g: UIPanGestureRecognizer) {
        let width = SideDrawerMetrics.width(for: view.bounds)
        switch g.state {
        case .began:
            dragStart = drawerLeading?.constant ?? 0
        case .changed:
            apply(offset: dragStart + g.translation(in: view).x, width: width)
        case .ended, .cancelled, .failed:
            finishDrag(velocity: g.velocity(in: view).x, width: width)
        default:
            break
        }
    }

    @objc private func handleDimTap() { close(animated: true, notify: true) }

    // ── Interactive offset mapping ────────────────────────────────────────────

    private func apply(offset: CGFloat, width: CGFloat) {
        let clamped = max(-width, min(0, offset))
        drawerLeading?.constant = clamped
        dim.alpha = SideDrawerMetrics.dimMaxAlpha * ((clamped + width) / width)
        dim.isUserInteractionEnabled = clamped > -width
    }

    /// Snap open/closed from current position + fling velocity.
    private func finishDrag(velocity: CGFloat, width: CGFloat) {
        let current = drawerLeading?.constant ?? -width
        let openFraction = (current + width) / width
        let shouldOpen: Bool
        if abs(velocity) > SideDrawerMetrics.velocitySnap {
            shouldOpen = velocity > 0
        } else {
            shouldOpen = openFraction > SideDrawerMetrics.snapThreshold
        }
        if shouldOpen {
            open(animated: true)
        } else {
            close(animated: true, notify: true)
        }
    }

    // ── Programmatic API ──────────────────────────────────────────────────────

    func open(animated: Bool) {
        let wasOpen = isOpen
        isOpen = true
        dim.isUserInteractionEnabled = true
        animateToOpen(true, width: SideDrawerMetrics.width(for: view.bounds), animated: animated) { [weak self] in
            guard let self else { return }
            self.log.info("open settled wasOpen=\(wasOpen)")
            self.onOpen()
        }
    }

    /// `notify` forwards onDismiss so the SwiftUI binding can clear to false.
    /// Programmatic close from a binding-sync passes notify=false to avoid a loop.
    func close(animated: Bool, notify: Bool) {
        isOpen = false
        animateToOpen(false, width: SideDrawerMetrics.width(for: view.bounds), animated: animated) { [weak self] in
            guard let self else { return }
            self.log.info("close settled notify=\(notify)")
            if notify { self.onDismiss() }
        }
    }

    private func animateToOpen(_ openState: Bool, width: CGFloat, animated: Bool, completion: @escaping () -> Void) {
        drawerLeading?.constant = openState ? 0 : -width
        let targetAlpha: CGFloat = openState ? SideDrawerMetrics.dimMaxAlpha : 0
        dim.isUserInteractionEnabled = openState
        guard animated else {
            view.layoutIfNeeded()
            dim.alpha = targetAlpha
            completion()
            return
        }
        UIView.animate(
            withDuration: SideDrawerMetrics.springDuration,
            delay: 0,
            usingSpringWithDamping: SideDrawerMetrics.springDamping,
            initialSpringVelocity: 0,
            options: [.allowUserInteraction, .curveEaseOut],
            animations: { [weak self] in
                self?.view.layoutIfNeeded()
                self?.dim.alpha = targetAlpha
            },
            completion: { _ in completion() }
        )
    }

    // ── UIGestureRecognizerDelegate ───────────────────────────────────────────

    /// Begin the close-pan only on a horizontally-dominant drag so the panel's
    /// inner SwiftUI ScrollView keeps vertical scrolling. The edge recognizer is
    /// already directional, so it falls through to true.
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard let pan = g as? UIPanGestureRecognizer,
              !(g is UIScreenEdgePanGestureRecognizer) else { return true }
        let v = pan.velocity(in: view)
        return abs(v.x) > abs(v.y)
    }

    /// Let the close-pan ride alongside the inner scroll's recognizers; the
    /// begin gate above keeps them from both claiming the same drag.
    func gestureRecognizer(
        _ g: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        true
    }
}
