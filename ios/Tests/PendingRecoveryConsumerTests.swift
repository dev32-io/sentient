// Run with the disposable fixture host, not the ordinary app/account graph.
// SwiftUI's accessibility nodes are queried through public XCUITest, not private
// in-process accessibility hooks or direct VM recovery calls.
#if NC_PENDING_UI_TESTS
import XCTest

final class PendingRecoveryConsumerTests: XCTestCase {
    func testFailedPendingEditIsReachableAndPreservesOccupiedSuccessor() throws {
        for mode in ["edit-empty", "edit-occupied"] {
            try exercise(mode, controlPrefix: "pending-attachment-edit-")
        }
    }

    func testActivePendingCancelOwnsUploadNotSuccessorOrServerRetraction() throws {
        try exercise("cancel", controlPrefix: "pending-attachment-cancel-")
    }

    private func exercise(_ mode: String, controlPrefix: String) throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--pending-recovery=\(mode)"]
        app.launch()
        defer { app.terminate() }
        let status = app.staticTexts["pending-fixture-status"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "ready:\(mode)"), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed, app.debugDescription)
        let control = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", controlPrefix)).firstMatch
        XCTAssertTrue(control.waitForExistence(timeout: 3), app.debugDescription)
        let list = app.collectionViews["chat-message-list"]
        let dock = app.otherElements["composer-face-viewport"]
        let top = max(list.frame.minY, app.buttons["new-chat"].frame.maxY)
        let bottom = dock.frame.minY
        for _ in 0..<3 {
            if control.frame.maxY > bottom { list.swipeUp() }
            else if control.frame.minY < top { list.swipeDown() }
            else { break }
        }
        XCTAssertGreaterThanOrEqual(control.frame.minY, top)
        XCTAssertLessThanOrEqual(control.frame.maxY, bottom)
        let before = XCTAttachment(screenshot: app.screenshot())
        before.name = "pending-recovery-\(mode)-control"
        before.lifetime = .keepAlways
        add(before)
        // Use public AX-derived geometry: embedded SwiftUI hosting can report no
        // synthesized hit point. Actual physical tap + state assertions prove wiring.
        control.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let passed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "passed:\(mode)"), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [passed], timeout: 15), .completed, app.debugDescription)
        let after = XCTAttachment(screenshot: app.screenshot())
        after.name = "pending-recovery-\(mode)-result"
        after.lifetime = .keepAlways
        add(after)
    }
}
#endif
