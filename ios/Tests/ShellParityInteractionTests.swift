#if S_SHELL_UI_TESTS
import XCTest

@MainActor
final class ShellParityInteractionTests: XCTestCase {
    private func launch(_ scenario: String, size: String = "large", contrast: String = "normal") -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["S_SCENARIO": scenario, "S_SIZE": size, "S_CONTRAST": contrast]
        app.launch()
        XCTAssertTrue(app.staticTexts["s-observed-state"].waitForExistence(timeout: 5))
        frame(app, "s-\(scenario)-initial-\(size)-\(contrast)")
        return app
    }

    private func frame(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name)-geometry"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    func testSDrawerIsolatesBackgroundAndRestoresDismissedTriggerReachability() {
        let app = launch("drawer")
        // XCUITest includes disabled offscreen descendants; existence is not visibility.
        XCTAssertFalse(app.buttons["history-close"].isHittable)
        XCTAssertTrue(app.buttons["history-open"].isHittable)
        app.buttons["history-open"].tap()
        let opened = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: app.buttons["history-close"])
        XCTAssertEqual(XCTWaiter.wait(for: [opened], timeout: 3), .completed)
        XCTAssertFalse(app.buttons["s-background"].isEnabled)
        frame(app, "s-drawer-open")
        app.buttons["history-close"].tap()
        XCTAssertTrue(app.buttons["history-open"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["history-open"].isHittable)
        XCTAssertTrue(app.buttons["s-background"].isEnabled)
        XCTAssertFalse(app.buttons["history-close"].isHittable)
        frame(app, "s-drawer-dismissed")
        // Real edge-open bridge, not a programmatic state substitute.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
        XCTAssertTrue(app.buttons["history-close"].waitForExistence(timeout: 3))
        frame(app, "s-drawer-pan-open")
        // Navigation during close must not leave the retained root settling.
        app.buttons["settings-open"].tap()
        XCTAssertTrue(app.otherElements["settings-screen"].waitForExistence(timeout: 3))
        app.buttons.matching(NSPredicate(format: "label == 'Back'")).firstMatch.tap()
        XCTAssertTrue(app.buttons["history-open"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["s-background"].isEnabled)
        app.buttons["s-background"].tap()
        frame(app, "s-drawer-root-after-settings")
    }

    func testSHistoryConcurrentWarningsAndNoMatchRecovery() {
        for size in ["large", "ax3", "ax5"] {
            let app = launch("history", size: size)
            XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "sessions-delete-failure").firstMatch.exists)
            XCTAssertTrue(app.otherElements["sessions-stale-banner"].exists)
            let search = app.textFields["history-search"]
            search.tap()
            search.typeText("absent")
            let clear = app.buttons["history-clear-search"]
            XCTAssertTrue(clear.waitForExistence(timeout: 3))
            for _ in 0..<8 where !clear.isHittable {
                // ScrollView's AX frame can extend behind the software keyboard.
                let scroll = app.scrollViews.firstMatch.frame
                var bottom = app.keyboards.firstMatch.exists ? min(scroll.maxY, app.keyboards.firstMatch.frame.minY) : scroll.maxY
                let assistant = app.otherElements["SystemInputAssistantView"]
                if assistant.exists { bottom = min(bottom, assistant.frame.minY) }
                let origin = app.coordinate(withNormalizedOffset: .zero)
                origin.withOffset(CGVector(dx: scroll.midX, dy: bottom - 20))
                    .press(forDuration: 0.1, thenDragTo: origin.withOffset(CGVector(dx: scroll.midX, dy: scroll.minY + 20)))
            }
            frame(app, "s-history-no-match-\(size)")
            XCTAssertTrue(clear.isHittable)
            clear.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
            XCTAssertTrue(app.buttons["history-row-draft-s-draft"].waitForExistence(timeout: 3))
            frame(app, "s-history-cleared-query-\(size)")
        }
    }

    func testSInboxSuspendedClearNeverShowsAllClearUntilAcknowledged() {
        let app = launch("inbox")
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "scheduled-inbox-loading").firstMatch.exists)
        XCTAssertFalse(app.staticTexts["scheduled-inbox-all-clear"].exists)
        app.buttons["s-load-complete"].tap()
        XCTAssertTrue(app.buttons["scheduled-card-s-card-1"].waitForExistence(timeout: 3))
        app.buttons["scheduled-inbox-clear-all"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "scheduled-inbox-clearing").firstMatch.waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["scheduled-inbox-all-clear"].exists)
        frame(app, "s-inbox-clear-suspended")
        let acknowledge = app.buttons["s-clear-ack"]
        let started = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: acknowledge)
        XCTAssertEqual(XCTWaiter.wait(for: [started], timeout: 3), .completed)
        acknowledge.tap()
        XCTAssertTrue(app.staticTexts["scheduled-inbox-all-clear"].waitForExistence(timeout: 3))
        frame(app, "s-inbox-acknowledged-empty")
        app.buttons["s-load-complete"].tap()
        app.buttons["scheduled-inbox-clear-all"].tap()
        let fail = app.buttons["s-clear-fail"]
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: fail)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 3), .completed)
        fail.tap()
        XCTAssertTrue(app.buttons["scheduled-card-s-card-2"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["scheduled-inbox-all-clear"].exists)
        frame(app, "s-inbox-clear-unknown-rollback")
    }

    func testSNoticeRegionKeepsHeaderAndDockOutsideScrollableRecoveryAtAX5() {
        let app = launch("notices", size: "ax5", contrast: "increased")
        XCTAssertTrue(app.otherElements["s-page-header"].exists)
        let back = app.buttons.matching(NSPredicate(format: "label == 'Back'")).firstMatch
        XCTAssertTrue(back.isHittable)
        frame(app, "s-notices-ax5-top")
        let reconnect = app.buttons["connection-reconnect"]
        for _ in 0..<8 where !reconnect.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(reconnect.isHittable)
        reconnect.tap()
        let dismiss = app.buttons["banner-reopen-failed-dismiss"]
        for _ in 0..<8 where !dismiss.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(dismiss.isHittable)
        XCTAssertLessThanOrEqual(dismiss.frame.maxY, app.otherElements["s-dock-boundary"].frame.minY)
        frame(app, "s-notices-ax5-recovery-actions")
    }

    func testSBackendSavingFailureAndSuccessfulRetryUseControlledProbe() {
        let app = launch("backend")
        let host = app.textFields["backend-host"]
        host.tap()
        host.typeText("fixture.invalid")
        XCTAssertEqual(host.value as? String, "fixture.invalid")
        app.toolbars.buttons["Done"].tap()
        app.buttons["backend-save"].tap()
        let reject = app.buttons["s-probe-fail"]
        let pending = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: reject)
        XCTAssertEqual(XCTWaiter.wait(for: [pending], timeout: 3), .completed)
        XCTAssertFalse(host.isEnabled)
        XCTAssertFalse(app.buttons["backend-save"].isEnabled)
        frame(app, "s-backend-saving")
        reject.tap()
        XCTAssertTrue(app.staticTexts["Probe starts: 2"].waitForExistence(timeout: 3))
        reject.tap()
        XCTAssertTrue(app.otherElements["backend-error"].waitForExistence(timeout: 3))
        XCTAssertTrue(host.isEnabled)
        frame(app, "s-backend-probe-failed")
        app.buttons.matching(NSPredicate(format: "label == 'Retry'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Probe starts: 3"].waitForExistence(timeout: 3))
        app.buttons["s-probe-ok"].tap()
        XCTAssertTrue(app.staticTexts["s-backend-saved"].waitForExistence(timeout: 3))
        frame(app, "s-backend-saved")
    }

    func testSBackendKeyboardValidationAndSecurityWarning() {
        let app = launch("backend")
        app.buttons["backend-save"].tap()
        XCTAssertTrue(app.staticTexts["Enter a host or IP."].firstMatch.waitForExistence(timeout: 3))
        let host = app.textFields["backend-host"]
        host.tap()
        host.typeText("fixture.invalid")
        let port = app.textFields["backend-port"]
        port.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(app.toolbars.buttons["Done"].exists)
        app.toolbars.buttons["Done"].tap()
        app.buttons["Plain ws"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "backend-plain-warning").firstMatch.waitForExistence(timeout: 3))
        frame(app, "s-backend-plain-warning")
        app.buttons["Self-signed"].tap()
        frame(app, "s-backend-self-signed-warning")
    }
}
#endif
