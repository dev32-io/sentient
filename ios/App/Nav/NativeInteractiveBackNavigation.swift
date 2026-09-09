import SwiftUI
import UIKit

extension View {
    /// Restores UINavigationController's native edge-swipe pop gesture for a
    /// destination whose custom header hides the system navigation bar.
    ///
    /// Experimental compatibility bridge: overriding the system recognizer's
    /// delegate is outside Apple's documented failure-requirement-only use.
    /// Keep adoption explicit and verify each supported OS before wider rollout.
    ///
    /// Apply this to a pushed `NavigationStack` destination, not to the stack's
    /// root. The adapter only admits the system edge gesture while its marker is
    /// contained by the navigation controller's current top view controller.
    /// UIKit continues to own the gesture targets, transition, cancellation, and
    /// SwiftUI path synchronization. Full-screen custom pans and non-navigation
    /// presentations are intentionally outside this adapter's scope.
    func nativeInteractiveBackNavigation(isEnabled: Bool = true) -> some View {
        background {
            NativeInteractiveBackNavigationBridge(isEnabled: isEnabled)
                .frame(width: 0, height: 0)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

@MainActor
private struct NativeInteractiveBackNavigationBridge: UIViewControllerRepresentable {
    let isEnabled: Bool

    func makeUIViewController(context: Context) -> NativeInteractiveBackController {
        NativeInteractiveBackController(isEnabled: isEnabled)
    }

    func updateUIViewController(
        _ controller: NativeInteractiveBackController,
        context: Context
    ) {
        controller.setEnabled(isEnabled)
    }

    static func dismantleUIViewController(
        _ controller: NativeInteractiveBackController,
        coordinator: ()
    ) {
        controller.requestCleanup()
    }
}

/// Internal so the UIKit ownership boundary can be tested without depending on
/// SwiftUI's private hosting-controller hierarchy.
@MainActor
final class NativeInteractiveBackController: UIViewController, UIGestureRecognizerDelegate {
    private var optInEnabled: Bool
    private var cleanupRequested = false
    private var awaitingTransitionCompletion = false
    private var handlingTransitionCompletion = false
    private weak var ownedNavigationController: UINavigationController?
    private var lease: NativeInteractiveBackGestureLease?

    init(isEnabled: Bool) {
        optInEnabled = isEnabled
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        let markerView = NativeInteractiveBackMarkerView()
        markerView.isUserInteractionEnabled = false
        markerView.onHierarchyChange = { [weak self] in
            self?.reconcileGestureOwnership()
        }
        view = markerView
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        reconcileGestureOwnership()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        reconcileGestureOwnership()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        reconcileGestureOwnership()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        reconcileGestureOwnership()
    }

    func setEnabled(_ isEnabled: Bool) {
        guard !cleanupRequested else { return }
        optInEnabled = isEnabled
        reconcileGestureOwnership()
    }

    func requestCleanup() {
        cleanupRequested = true
        optInEnabled = false
        reconcileGestureOwnership()
    }

    func reconcileGestureOwnership() {
        guard !awaitingTransitionCompletion else { return }

        if !handlingTransitionCompletion,
           let coordinator = (navigationController ?? ownedNavigationController)?.transitionCoordinator {
            deferReconciliation(untilCompletionOf: coordinator)
            return
        }

        guard let gesture = eligibleGesture() else {
            relinquishLease()
            return
        }

        if let lease {
            guard !lease.isClosed, lease.gesture === gesture else {
                self.lease = nil
                ownedNavigationController = nil
                reconcileGestureOwnership()
                return
            }
            lease.refresh(owner: self)
            return
        }

        if let outgoingOwner = gesture.delegate as? NativeInteractiveBackController,
           outgoingOwner.handoffLease(to: self, for: gesture) {
            return
        }

        // Do not replace an unrelated delegate that arrived while another scoped
        // owner was restoring. A later hierarchy/lifecycle update can retry.
        guard !(gesture.delegate is NativeInteractiveBackController) else { return }

        let lease = NativeInteractiveBackGestureLease(
            gesture: gesture,
            originalDelegate: gesture.delegate,
            originalEnabled: gesture.isEnabled
        )
        self.lease = lease
        ownedNavigationController = navigationController
        lease.add(self, takingOwnership: true)
    }

    func restoreGestureIfOwned() {
        requestCleanup()
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === lease?.gesture,
              lease?.owner === self,
              eligibleGesture() === gestureRecognizer
        else { return false }

        // Do not forward shouldBegin: UIKit's hidden-bar delegate commonly rejects
        // this exact gesture. The scoped public-API gates above replace only that
        // admission decision; UIKit's original gesture targets remain untouched.
        return true
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        originalDelegate?.gestureRecognizer?(
            gestureRecognizer,
            shouldRecognizeSimultaneouslyWith: otherGestureRecognizer
        ) ?? false
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        originalDelegate?.gestureRecognizer?(
            gestureRecognizer,
            shouldRequireFailureOf: otherGestureRecognizer
        ) ?? false
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        originalDelegate?.gestureRecognizer?(
            gestureRecognizer,
            shouldBeRequiredToFailBy: otherGestureRecognizer
        ) ?? false
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldReceive touch: UITouch
    ) -> Bool {
        originalDelegate?.gestureRecognizer?(gestureRecognizer, shouldReceive: touch) ?? true
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldReceive press: UIPress
    ) -> Bool {
        originalDelegate?.gestureRecognizer?(gestureRecognizer, shouldReceive: press) ?? true
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldReceive event: UIEvent
    ) -> Bool {
        originalDelegate?.gestureRecognizer?(gestureRecognizer, shouldReceive: event) ?? true
    }

    fileprivate func canOwn(_ gesture: UIGestureRecognizer) -> Bool {
        eligibleGesture() === gesture
    }

    private var originalDelegate: UIGestureRecognizerDelegate? {
        lease?.originalDelegate
    }

    private func eligibleGesture() -> UIGestureRecognizer? {
        guard optInEnabled,
              !cleanupRequested,
              let navigationController,
              handlingTransitionCompletion || navigationController.transitionCoordinator == nil,
              navigationController.viewControllers.count > 1,
              let topController = navigationController.topViewController,
              isContained(in: topController),
              !hasPresentation(inAncestorChainOf: navigationController),
              !hasPresentation(inAncestorChainOf: topController),
              let gesture = navigationController.interactivePopGestureRecognizer,
              gesture is UIScreenEdgePanGestureRecognizer
        else { return nil }

        return gesture
    }

    private func handoffLease(
        to incomingOwner: NativeInteractiveBackController,
        for gesture: UIGestureRecognizer
    ) -> Bool {
        guard let lease,
              !lease.isClosed,
              lease.gesture === gesture,
              lease.owner === self
        else { return false }

        incomingOwner.lease = lease
        incomingOwner.ownedNavigationController = ownedNavigationController ?? navigationController
        lease.add(incomingOwner, takingOwnership: true)
        return true
    }

    private func relinquishLease() {
        guard let lease else {
            ownedNavigationController = nil
            return
        }
        self.lease = nil
        ownedNavigationController = nil
        lease.remove(self)
    }

    private func deferReconciliation(
        untilCompletionOf coordinator: UIViewControllerTransitionCoordinator
    ) {
        guard !awaitingTransitionCompletion else { return }
        awaitingTransitionCompletion = true
        // The return value concerns animation queuing, not completion delivery;
        // UIKit can invoke completion even when this nil-animation call returns false.
        coordinator.animate(alongsideTransition: nil) { [self] _ in
            // Keep the owner alive through deferred dismantle restoration.
            awaitingTransitionCompletion = false
            handlingTransitionCompletion = true
            reconcileGestureOwnership()
            handlingTransitionCompletion = false
        }
    }

    private func hasPresentation(inAncestorChainOf controller: UIViewController) -> Bool {
        var ancestor: UIViewController? = controller
        while let current = ancestor {
            if current.presentedViewController != nil { return true }
            ancestor = current.parent
        }
        return false
    }

    private func isContained(in controller: UIViewController) -> Bool {
        var ancestor: UIViewController? = self
        while let current = ancestor {
            if current === controller { return true }
            ancestor = current.parent
        }
        return false
    }
}

@MainActor
private final class NativeInteractiveBackGestureLease {
    weak var gesture: UIGestureRecognizer?
    weak var owner: NativeInteractiveBackController?
    let originalDelegate: UIGestureRecognizerDelegate?
    private let originalEnabled: Bool
    private let participants = NSHashTable<NativeInteractiveBackController>.weakObjects()
    private(set) var isClosed = false

    init(
        gesture: UIGestureRecognizer,
        originalDelegate: UIGestureRecognizerDelegate?,
        originalEnabled: Bool
    ) {
        self.gesture = gesture
        self.originalDelegate = originalDelegate
        self.originalEnabled = originalEnabled
    }

    func add(_ participant: NativeInteractiveBackController, takingOwnership: Bool) {
        guard !isClosed, let gesture else { return }
        participants.add(participant)
        guard takingOwnership else { return }
        owner = participant
        gesture.delegate = participant
        gesture.isEnabled = true
    }

    func refresh(owner participant: NativeInteractiveBackController) {
        guard !isClosed, let gesture else { return }
        participants.add(participant)
        guard owner === participant else { return }
        if gesture.delegate === participant {
            gesture.isEnabled = true
        }
    }

    func remove(_ participant: NativeInteractiveBackController) {
        participants.remove(participant)
        guard owner === participant else { return }

        if let gesture,
           let successor = participants.allObjects.first(where: { $0.canOwn(gesture) }) {
            owner = successor
            gesture.delegate = successor
            gesture.isEnabled = true
            return
        }

        close(restoringOwner: participant)
    }

    private func close(restoringOwner currentOwner: NativeInteractiveBackController) {
        defer {
            owner = nil
            isClosed = true
            participants.removeAllObjects()
        }
        guard let gesture, gesture.delegate === currentOwner else { return }
        gesture.delegate = originalDelegate
        gesture.isEnabled = originalEnabled
    }
}

@MainActor
private final class NativeInteractiveBackMarkerView: UIView {
    var onHierarchyChange: (() -> Void)?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        onHierarchyChange?()
    }
}
