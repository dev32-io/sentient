import Combine
import SwiftUI
import UIKit
import XCTest
@testable import SentientApp

@MainActor
final class NativeInteractiveBackNavigationTests: XCTestCase {
    func testTopDestinationClaimsNativeGestureByIdentityAndRestoresItsSnapshot() throws {
        let hierarchy = try makePushedHierarchy(originalEnabled: false)
        let originalDelegate = RecordingGestureDelegate(shouldBegin: false)
        hierarchy.gesture.delegate = originalDelegate

        let adapter = attachAdapter(to: hierarchy.destination)

        XCTAssertTrue(hierarchy.gesture.delegate === adapter)
        XCTAssertTrue(hierarchy.gesture.isEnabled)
        XCTAssertTrue(adapter.gestureRecognizerShouldBegin(hierarchy.gesture))
        XCTAssertEqual(originalDelegate.shouldBeginCallCount, 0)

        adapter.restoreGestureIfOwned()

        XCTAssertTrue(hierarchy.gesture.delegate === originalDelegate)
        XCTAssertFalse(hierarchy.gesture.isEnabled)
    }

    func testRestorationDoesNotOverwriteADelegateInstalledByAnotherOwner() throws {
        let hierarchy = try makePushedHierarchy(originalEnabled: false)
        let originalDelegate = RecordingGestureDelegate()
        let replacementDelegate = RecordingGestureDelegate()
        hierarchy.gesture.delegate = originalDelegate
        let adapter = attachAdapter(to: hierarchy.destination)

        hierarchy.gesture.delegate = replacementDelegate
        adapter.restoreGestureIfOwned()

        XCTAssertTrue(hierarchy.gesture.delegate === replacementDelegate)
        XCTAssertTrue(hierarchy.gesture.isEnabled)
    }

    func testConsecutiveMarkersOnSameTopHandOffAndRestoreWithoutOrphaning() throws {
        let hierarchy = try makePushedHierarchy(originalEnabled: false)
        let originalDelegate = RecordingGestureDelegate()
        hierarchy.gesture.delegate = originalDelegate

        let markerA = attachAdapter(to: hierarchy.destination)
        let markerB = attachAdapter(to: hierarchy.destination)

        XCTAssertTrue(hierarchy.gesture.delegate === markerB)
        markerA.restoreGestureIfOwned()
        XCTAssertTrue(hierarchy.gesture.delegate === markerB)

        markerB.restoreGestureIfOwned()
        XCTAssertTrue(hierarchy.gesture.delegate === originalDelegate)
        XCTAssertFalse(hierarchy.gesture.isEnabled)
    }

    func testMarkerHandoffAcrossTopChangesReturnsOwnershipToRevealedTop() throws {
        let hierarchy = try makePushedHierarchy(originalEnabled: false)
        let originalDelegate = RecordingGestureDelegate()
        hierarchy.gesture.delegate = originalDelegate
        let markerA = attachAdapter(to: hierarchy.destination)

        let nextDestination = UIViewController()
        hierarchy.navigation.pushViewController(nextDestination, animated: false)
        let markerB = attachAdapter(to: nextDestination)
        XCTAssertTrue(hierarchy.gesture.delegate === markerB)

        hierarchy.navigation.popViewController(animated: false)
        markerB.viewDidDisappear(false)

        XCTAssertTrue(hierarchy.gesture.delegate === markerA)
        XCTAssertTrue(hierarchy.gesture.isEnabled)
    }

    func testAdmissionFailsClosedForRootWrongTopAndDisabledScope() throws {
        let root = UIViewController()
        let rootNavigation = UINavigationController(rootViewController: root)
        rootNavigation.loadViewIfNeeded()
        let rootGesture = try XCTUnwrap(rootNavigation.interactivePopGestureRecognizer)
        let rootDelegate = RecordingGestureDelegate()
        rootGesture.delegate = rootDelegate
        let rootAdapter = attachAdapter(to: root)

        XCTAssertTrue(rootGesture.delegate === rootDelegate)
        XCTAssertFalse(rootAdapter.gestureRecognizerShouldBegin(rootGesture))

        let hierarchy = try makePushedHierarchy(originalEnabled: true)
        let originalDelegate = RecordingGestureDelegate()
        hierarchy.gesture.delegate = originalDelegate
        let adapter = attachAdapter(to: hierarchy.destination)
        let replacementTop = UIViewController()
        hierarchy.navigation.pushViewController(replacementTop, animated: false)

        XCTAssertFalse(adapter.gestureRecognizerShouldBegin(hierarchy.gesture))
        adapter.reconcileGestureOwnership()
        XCTAssertTrue(hierarchy.gesture.delegate === originalDelegate)

        hierarchy.navigation.popViewController(animated: false)
        adapter.viewWillAppear(false)
        XCTAssertTrue(hierarchy.gesture.delegate === adapter)
        adapter.setEnabled(false)
        XCTAssertTrue(hierarchy.gesture.delegate === originalDelegate)
        XCTAssertFalse(adapter.gestureRecognizerShouldBegin(hierarchy.gesture))
    }

    func testPresentedControllerOnTopOrNavigationAncestorChainBlocksAdmission() async throws {
        let hierarchy = try makePushedHierarchy(originalEnabled: true)
        let originalDelegate = RecordingGestureDelegate()
        hierarchy.gesture.delegate = originalDelegate

        let intermediate = UIViewController()
        hierarchy.destination.addChild(intermediate)
        hierarchy.destination.view.addSubview(intermediate.view)
        intermediate.didMove(toParent: hierarchy.destination)
        let adapter = attachAdapter(to: intermediate)
        XCTAssertTrue(hierarchy.gesture.delegate === adapter)

        let windowRoot = UIViewController()
        windowRoot.addChild(hierarchy.navigation)
        windowRoot.view.addSubview(hierarchy.navigation.view)
        hierarchy.navigation.didMove(toParent: windowRoot)
        let window = UIWindow(windowScene: try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first))
        window.rootViewController = windowRoot
        window.makeKeyAndVisible()

        let presented = expectation(description: "first modal presented")
        intermediate.present(UIViewController(), animated: false) { presented.fulfill() }
        await fulfillment(of: [presented], timeout: 2)
        adapter.reconcileGestureOwnership()
        XCTAssertTrue(hierarchy.gesture.delegate === originalDelegate)

        let dismissed = expectation(description: "first modal dismissed")
        intermediate.dismiss(animated: false) { dismissed.fulfill() }
        await fulfillment(of: [dismissed], timeout: 2)
        adapter.reconcileGestureOwnership()
        XCTAssertTrue(hierarchy.gesture.delegate === adapter)

        let ancestorPresented = expectation(description: "ancestor modal presented")
        windowRoot.present(UIViewController(), animated: false) { ancestorPresented.fulfill() }
        await fulfillment(of: [ancestorPresented], timeout: 2)
        adapter.reconcileGestureOwnership()
        XCTAssertTrue(hierarchy.gesture.delegate === originalDelegate)

        window.isHidden = true
    }

    func testLifecycleSupportsLateAttachmentDisappearAndReentry() throws {
        let root = UIViewController()
        let destination = UIViewController()
        let navigation = UINavigationController(rootViewController: root)
        navigation.loadViewIfNeeded()
        let gesture = try XCTUnwrap(navigation.interactivePopGestureRecognizer)
        let originalDelegate = RecordingGestureDelegate()
        gesture.delegate = originalDelegate

        let adapter = attachAdapter(to: destination)
        XCTAssertTrue(gesture.delegate === originalDelegate)

        navigation.pushViewController(destination, animated: false)
        adapter.viewWillAppear(false)
        XCTAssertTrue(gesture.delegate === adapter)

        navigation.popViewController(animated: false)
        adapter.viewDidDisappear(false)
        XCTAssertTrue(gesture.delegate === originalDelegate)

        navigation.pushViewController(destination, animated: false)
        adapter.viewWillAppear(false)
        XCTAssertTrue(gesture.delegate === adapter)
    }

    func testUpdateDuringActiveTransitionDefersRestorationUntilCompletion() async throws {
        let hierarchy = try makePushedHierarchy(originalEnabled: false)
        let originalDelegate = RecordingGestureDelegate()
        hierarchy.gesture.delegate = originalDelegate
        let adapter = attachAdapter(to: hierarchy.destination)

        let window = UIWindow(windowScene: try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first))
        window.rootViewController = hierarchy.navigation
        window.makeKeyAndVisible()
        hierarchy.navigation.view.layoutIfNeeded()
        defer { window.isHidden = true }
        hierarchy.navigation.popViewController(animated: true)
        let coordinator = try XCTUnwrap(hierarchy.navigation.transitionCoordinator)
        adapter.setEnabled(true)

        XCTAssertTrue(hierarchy.gesture.delegate === adapter)
        XCTAssertTrue(hierarchy.gesture.isEnabled)

        let completed = expectation(description: "navigation transition completed")
        coordinator.animate(alongsideTransition: nil) { _ in completed.fulfill() }
        await fulfillment(of: [completed], timeout: 2)

        XCTAssertTrue(hierarchy.gesture.delegate === originalDelegate)
        XCTAssertFalse(hierarchy.gesture.isEnabled)
    }

    func testDismantleDuringActiveTransitionRestoresAfterCompletionWithoutReacquiring() async throws {
        let hierarchy = try makePushedHierarchy(originalEnabled: false)
        let originalDelegate = RecordingGestureDelegate()
        hierarchy.gesture.delegate = originalDelegate
        let adapter = attachAdapter(to: hierarchy.destination)

        let window = UIWindow(windowScene: try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first))
        window.rootViewController = hierarchy.navigation
        window.makeKeyAndVisible()
        hierarchy.navigation.view.layoutIfNeeded()
        defer { window.isHidden = true }
        hierarchy.navigation.popViewController(animated: true)
        let coordinator = try XCTUnwrap(hierarchy.navigation.transitionCoordinator)
        adapter.requestCleanup()
        XCTAssertTrue(hierarchy.gesture.delegate === adapter)

        let completed = expectation(description: "navigation transition completed")
        coordinator.animate(alongsideTransition: nil) { _ in completed.fulfill() }
        await fulfillment(of: [completed], timeout: 2)

        XCTAssertTrue(hierarchy.gesture.delegate === originalDelegate)
        XCTAssertFalse(hierarchy.gesture.isEnabled)
        adapter.viewDidAppear(false)
        XCTAssertTrue(hierarchy.gesture.delegate === originalDelegate)
    }

    func testMountedNavigationStackInstallsOnUnderlyingNavigationAndRestoresOnPathPop() async throws {
        let model = NavigationPathModel()
        let host = UIHostingController(rootView: NativeBackNavigationFixture(model: model))
        let window = UIWindow(windowScene: try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        await Task.yield()
        host.view.layoutIfNeeded()
        await Task.yield()

        let navigation = try XCTUnwrap(findNavigationController(in: host))
        let gesture = try XCTUnwrap(navigation.interactivePopGestureRecognizer)
        XCTAssertTrue(gesture.delegate is NativeInteractiveBackController)
        XCTAssertEqual(navigation.viewControllers.count, 2)

        let disappeared = expectation(description: "popped SwiftUI destination disappeared")
        model.onDestinationDisappear = { disappeared.fulfill() }
        model.path.removeLast()
        await fulfillment(of: [disappeared], timeout: 2)

        XCTAssertEqual(navigation.viewControllers.count, 1)
        XCTAssertFalse(gesture.delegate is NativeInteractiveBackController)
        window.isHidden = true
    }

    func testUnrelatedDelegateArbitrationIsForwarded() throws {
        let hierarchy = try makePushedHierarchy(originalEnabled: true)
        let originalDelegate = RecordingGestureDelegate(allowsSimultaneousRecognition: true)
        hierarchy.gesture.delegate = originalDelegate
        let adapter = attachAdapter(to: hierarchy.destination)
        let competingPan = UIPanGestureRecognizer()

        XCTAssertTrue(adapter.gestureRecognizer(
            hierarchy.gesture,
            shouldRecognizeSimultaneouslyWith: competingPan
        ))
        XCTAssertEqual(originalDelegate.simultaneousCallCount, 1)
    }

    private func makePushedHierarchy(originalEnabled: Bool) throws -> NavigationHierarchy {
        let root = UIViewController()
        let destination = UIViewController()
        let navigation = UINavigationController(rootViewController: root)
        navigation.loadViewIfNeeded()
        navigation.pushViewController(destination, animated: false)
        let gesture = try XCTUnwrap(navigation.interactivePopGestureRecognizer)
        gesture.isEnabled = originalEnabled
        return NavigationHierarchy(
            navigation: navigation,
            destination: destination,
            gesture: gesture
        )
    }

    private func attachAdapter(
        to parent: UIViewController,
        isEnabled: Bool = true
    ) -> NativeInteractiveBackController {
        let adapter = NativeInteractiveBackController(isEnabled: isEnabled)
        parent.loadViewIfNeeded()
        parent.addChild(adapter)
        parent.view.addSubview(adapter.view)
        adapter.didMove(toParent: parent)
        return adapter
    }

    private func findNavigationController(in controller: UIViewController) -> UINavigationController? {
        if let navigation = controller as? UINavigationController { return navigation }
        for child in controller.children {
            if let navigation = findNavigationController(in: child) { return navigation }
        }
        if let presented = controller.presentedViewController {
            return findNavigationController(in: presented)
        }
        return nil
    }
}

@MainActor
private final class NavigationPathModel: ObservableObject {
    @Published var path = [1]
    var onDestinationDisappear: (() -> Void)?
}

private struct NativeBackNavigationFixture: View {
    @ObservedObject var model: NavigationPathModel

    var body: some View {
        NavigationStack(path: $model.path) {
            Text("Root")
                .navigationDestination(for: Int.self) { _ in
                    Text("Destination")
                        .toolbar(.hidden, for: .navigationBar)
                        .nativeInteractiveBackNavigation()
                        .onDisappear { model.onDestinationDisappear?() }
                }
        }
    }
}

@MainActor
private struct NavigationHierarchy {
    let navigation: UINavigationController
    let destination: UIViewController
    let gesture: UIGestureRecognizer
}

@MainActor
private final class RecordingGestureDelegate: NSObject, UIGestureRecognizerDelegate {
    private let shouldBegin: Bool
    private let allowsSimultaneousRecognition: Bool
    private(set) var shouldBeginCallCount = 0
    private(set) var simultaneousCallCount = 0

    init(
        shouldBegin: Bool = true,
        allowsSimultaneousRecognition: Bool = false
    ) {
        self.shouldBegin = shouldBegin
        self.allowsSimultaneousRecognition = allowsSimultaneousRecognition
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        shouldBeginCallCount += 1
        return shouldBegin
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        simultaneousCallCount += 1
        return allowsSimultaneousRecognition
    }
}
