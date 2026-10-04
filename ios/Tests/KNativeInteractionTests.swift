#if K_NATIVE_UI_TESTS
import XCTest

@MainActor final class KNativeInteractionTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ scenario: String, width: String = "390", size: String = "default", locale: String = "en_US", contrast: String = "standard") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["K_SCENARIO": scenario, "K_WIDTH": width, "K_SIZE": size, "K_CONTRAST": contrast]
        app.launchArguments = ["-AppleLanguages", locale == "fr_FR" ? "(fr)" : "(en)", "-AppleLocale", locale]
        app.launch()
        if scenario.hasPrefix("cube-") { telemetry(app, "ready=true"); telemetry(app, "registryWrites=0") }
        else if scenario != "cards" { open(app) }
        return app
    }
    private func open(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["k-open"].waitForExistence(timeout: 5))
        app.buttons["k-open"].tap()
        XCTAssertTrue(app.textViews["schedule-message"].waitForExistence(timeout: 5))
    }
    private func probe(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(identifier: "k-probe").allElementsBoundByAccessibilityElement.last ?? app.buttons["k-probe"].firstMatch
    }
    private func telemetry(_ app: XCUIApplication, _ part: String) {
        let predicate = NSPredicate { [weak self] _, _ in self.map { (($0.probe(app).value as? String) ?? "").contains(part) } ?? false }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: 5), .completed, "Missing state: \(part)")
    }
    private func menu(_ app: XCUIApplication, _ action: String) {
        probe(app).tap()
        XCTAssertTrue(app.buttons[action].waitForExistence(timeout: 3)); app.buttons[action].tap()
    }
    private func visible(_ app: XCUIApplication, _ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        for _ in 0..<8 where !element.isHittable {
            let window = app.windows.firstMatch
            let bottom = min(window.frame.maxY - 40, app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : window.frame.maxY - 40)
            let top = max(130, app.scrollViews.firstMatch.frame.minY)
            let up = element.frame.minY >= top
            let start = top + (bottom - top) * (up ? 0.8 : 0.2)
            let end = top + (bottom - top) * (up ? 0.2 : 0.8)
            // Scroll margin, not native text selection or DatePicker wheels.
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: start / window.frame.height)).press(forDuration: 0.05,
                thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: end / window.frame.height)))
        }
        XCTAssertTrue(element.isHittable)
    }
    private func replace(_ element: XCUIElement, with text: String) {
        element.tap()
        let current = element.value as? String ?? ""
        element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count) + text)
    }
    private func swipeSheet(_ app: XCUIApplication) {
        let start = app.staticTexts["Schedule message"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
        start.press(forDuration: 0.1, thenDragTo: app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)))
    }
    private func text(_ app: XCUIApplication, containing value: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    }
    private func capture(_ app: XCUIApplication, _ name: String, includingNativeClock: Bool = false) throws {
        let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
        // Bounds/enabled state are static AX evidence, not VO/FKA or motion certification.
        let evidence = NSPredicate(format: "identifier BEGINSWITH 'schedule-' OR identifier BEGINSWITH 'cube-' OR identifier == 'k-probe' OR elementType == %d", XCUIElement.ElementType.staticText.rawValue)
        let elements = app.descendants(matching: .any).matching(evidence).allElementsBoundByAccessibilityElement +
            (includingNativeClock ? app.datePickers.descendants(matching: .any).allElementsBoundByAccessibilityElement : [])
        let nodes = elements.map { element -> [String: Any] in
            let frame = element.frame
            let bounds = [frame.minX, frame.minY, frame.width, frame.height]
            let finite = bounds.allSatisfy(\.isFinite)
            return ["id": element.identifier, "type": element.elementType.rawValue, "label": element.label,
                    "value": element.value as? String ?? "", "enabled": element.isEnabled,
                    "hittable": element.isHittable, "geometryFinite": finite,
                    "frame": finite ? bounds as Any : NSNull()]
        }
        let data = try JSONSerialization.data(withJSONObject: ["state": probe(app).value as? String ?? "", "nodes": nodes], options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = name + "-AX"; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testScheduleModesUseNativeInputsAndKeyboardDone() throws {
        for mode in ["once", "delay", "weekly", "monthly"] {
            let app = launch(mode, width: mode == "once" ? "390" : "320", size: mode == "weekly" ? "AX5" : "default")
            let message = app.textViews["schedule-message"]
            message.tap(); message.typeText(" edited")
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
            let done = app.buttons["schedule-keyboard-done"]
            XCTAssertTrue(done.isHittable); done.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
            if mode == "once" || mode == "weekly" || mode == "monthly" {
                let picker = app.datePickers[mode == "once" ? "schedule-once-at" : "schedule-local-time"]
                visible(app, picker)
                XCTAssertTrue(picker.isEnabled)
                picker.tap() // Native compact DatePicker, not a fixture-rendered field.
                try capture(app, "schedule-\(mode)-native-picker")
                app.staticTexts["Schedule message"].tap() // Native popover outside-tap dismissal.
            } else {
                let delay = app.textFields["schedule-delay"]
                visible(app, delay); replace(delay, with: "45")
                XCTAssertTrue(app.keyboards.firstMatch.exists)
                app.buttons["schedule-keyboard-done"].tap()
                XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
            }
            if mode == "weekly" {
                let weekday = app.buttons["Weekday"]
                visible(app, weekday); XCTAssertTrue(weekday.isEnabled)
                XCTAssertFalse(app.textFields["schedule-month-day"].isEnabled)
                weekday.tap(); app.buttons["Friday"].tap()
                XCTAssertEqual(weekday.value as? String, "Friday")
            }
            if mode == "monthly" {
                XCTAssertFalse(app.buttons["Weekday"].isEnabled)
                let frequency = app.buttons["Frequency"]
                visible(app, frequency); frequency.tap(); app.buttons["Weekly"].tap()
                XCTAssertTrue(app.buttons["Weekday"].isEnabled)
                frequency.tap(); app.buttons["Monthly"].tap()
                XCTAssertFalse(app.buttons["Weekday"].isEnabled)
                let day = app.textFields["schedule-month-day"]
                visible(app, day); replace(day, with: "29"); app.buttons["schedule-keyboard-done"].tap()
            }
            // Zone field remains a real native editor in every timing mode.
            let zone = app.textFields["schedule-time-zone"]
            visible(app, zone); replace(zone, with: "Europe/Paris")
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
            app.buttons["schedule-keyboard-done"].tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
            try capture(app, "schedule-\(mode)-edited")
            telemetry(app, "writes=0")
            app.terminate()
        }
    }

    func testRecurringClockMatchesSavedIntentAfterZoneEditInOtherModes() throws {
        for mode in ["Once", "After delay"] {
            let app = launch("recurring-utc")
            let picker = app.datePickers["schedule-local-time"]
            func assertNineClock() {
                visible(app, picker)
                // Read native picker AX, never fixture draft telemetry as display evidence.
                let predicate = NSPredicate { _, _ in
                    ([picker] + picker.descendants(matching: .any).allElementsBoundByAccessibilityElement).contains { element in
                        [element.label, element.value as? String ?? ""].contains { value in
                            let clock = value.filter { !$0.isWhitespace }
                            return ["9:00AM", "09:00", "9:00"].contains(clock)
                        }
                    }
                }
                XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: 5),
                               .completed, "Native picker must show retained 09:00 intent")
            }
            assertNineClock()
            XCTAssertEqual(app.textFields["schedule-time-zone"].value as? String, "Etc/UTC")
            let otherMode = app.buttons[mode]
            visible(app, otherMode); otherMode.tap()
            telemetry(app, "mode=\(mode)")
            let zone = app.textFields["schedule-time-zone"]
            visible(app, zone); replace(zone, with: "Asia/Kathmandu")
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
            app.buttons["schedule-keyboard-done"].tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
            XCTAssertEqual(zone.value as? String, "Asia/Kathmandu")
            let recurring = app.buttons["Recurring"]
            visible(app, recurring); recurring.tap()
            telemetry(app, "mode=Recurring")
            // No picker tap or time edit on return. Existing policy retains wall clock, not instant.
            visible(app, picker)
            telemetry(app, "writes=0")
            try capture(app, "schedule-return-from-\(mode)-clock-before-save", includingNativeClock: true)
            assertNineClock()
            let save = app.buttons["schedule-save"]
            visible(app, save); save.tap()
            telemetry(app, "phase=saving"); telemetry(app, "writes=1")
            telemetry(app, "submittedClock=09:00;submittedZone=Asia/Kathmandu")
            assertNineClock()
            telemetry(app, "draftUnchanged=true")
            try capture(app, "schedule-return-from-\(mode)-clock-submitted", includingNativeClock: true)
            menu(app, "Finish save"); telemetry(app, "phase=success"); telemetry(app, "sheet=false")
            app.terminate()
        }
    }

    func testPendingSaveBlocksEditingCancelSwipeEscapeThenFailureRetrySuccess() throws {
        let app = launch("weekly")
        let message = app.textViews["schedule-message"]
        message.tap(); message.typeText(" retained draft"); app.buttons["schedule-keyboard-done"].tap()
        let save = app.buttons["schedule-save"]
        visible(app, save); save.tap(); telemetry(app, "phase=saving"); telemetry(app, "writes=1")
        XCTAssertFalse(message.isEnabled)
        XCTAssertFalse(app.textFields["schedule-time-zone"].isEnabled)
        XCTAssertFalse(app.buttons["Frequency"].isEnabled); XCTAssertFalse(app.buttons["Weekday"].isEnabled)
        XCTAssertFalse(save.isEnabled); XCTAssertFalse(app.buttons["schedule-cancel"].isEnabled)
        app.buttons["schedule-cancel"].tap()
        swipeSheet(app); app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
        telemetry(app, "sheet=true"); telemetry(app, "cancels=0"); telemetry(app, "draftUnchanged=true")
        try capture(app, "schedule-pending-blocked-dismiss")
        menu(app, "Fail save"); telemetry(app, "phase=failure"); telemetry(app, "sheet=true")
        XCTAssertTrue(text(app, containing: "Disposable save failure").waitForExistence(timeout: 3))
        XCTAssertTrue((message.value as? String ?? "").contains("retained draft"))
        XCTAssertTrue(save.isEnabled)
        try capture(app, "schedule-failure-retains-draft")
        visible(app, save); save.tap(); telemetry(app, "writes=2")
        menu(app, "Finish save"); telemetry(app, "phase=success"); telemetry(app, "sheet=false")
        XCTAssertTrue(message.waitForNonExistence(timeout: 3))
        try capture(app, "schedule-success-dismissed")
        app.terminate()
    }

    func testIdleCancelSwipeAndHardwareEscapeDismissNativeSheet() throws {
        let app = launch("once")
        visible(app, app.buttons["schedule-cancel"]); app.buttons["schedule-cancel"].tap(); telemetry(app, "cancels=1")
        open(app); swipeSheet(app); telemetry(app, "sheet=false"); telemetry(app, "writes=0")
        open(app)
        let message = app.textViews["schedule-message"]
        message.tap()
        let previous = message.value as? String ?? ""
        app.typeKey("x", modifierFlags: [])
        let injected = message.value as? String ?? ""
        guard injected.count == previous.count + 1, injected.replacingOccurrences(of: "x", with: "") == previous else {
            try capture(app, "schedule-hardware-injection-unverified")
            throw XCTSkip("Hardware key injection did not pass native text-input positive control; Escape unverified.")
        }
        app.buttons["schedule-keyboard-done"].tap()
        app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
        // Hardware Escape is a runtime witness, not inferred from accessibilityAction(.escape).
        telemetry(app, "sheet=false"); telemetry(app, "writes=0")
        app.terminate()
    }

    func testInvalidDelayNeverStartsFakeWrite() {
        let app = launch("delay")
        let field = app.textFields["schedule-delay"]
        visible(app, field); replace(field, with: "0"); app.buttons["schedule-keyboard-done"].tap()
        let save = app.buttons["schedule-save"]
        visible(app, save); save.tap()
        XCTAssertTrue(text(app, containing: "Choose a delay from one minute to one year.").waitForExistence(timeout: 3))
        telemetry(app, "writes=0"); telemetry(app, "sheet=true")
        app.terminate()
    }

    func testLocalizedProductionCardsAtRegularAndNarrowAX5() throws {
        for locale in ["en_US", "fr_FR"] {
            let app = launch("cards", width: locale == "fr_FR" ? "320" : "390", size: locale == "fr_FR" ? "AX5" : "default", locale: locale)
            XCTAssertTrue(text(app, containing: "America/Los_Angeles").waitForExistence(timeout: 3))
            XCTAssertTrue(text(app, containing: locale == "fr_FR" ? "août" : "Aug").exists)
            XCTAssertFalse(app.buttons["Edit"].firstMatch.isEnabled)
            try capture(app, "schedule-cards-\(locale)-top")
            let paused = text(app, containing: "Paused")
            visible(app, paused)
            XCTAssertTrue(text(app, containing: "Europe/Paris").exists)
            try capture(app, "schedule-cards-\(locale)-bottom")
            app.terminate()
        }
    }

    func testManualCubePickerReadabilityAndLocalSelectionWithoutWrites() throws {
        let locator = "SC_123456781234"
        for width in ["393", "320"] {
            for size in ["default", "AX5"] {
                let app = launch("cube-manual", width: width, size: size)
                XCTAssertEqual(app.windows.firstMatch.frame.width, CGFloat(Int(width)!))
                let picker = app.buttons["cube-manual-locator"]
                let connect = app.buttons["cube-manual-connect"]
                func centerPicker() {
                    visible(app, picker)
                    let scroll = app.scrollViews.firstMatch.frame
                    for _ in 0..<3 {
                        let delta = picker.frame.midY - scroll.midY
                        if abs(delta) < 24 { break }
                        let distance = min(abs(delta), 280)
                        let start = scroll.midY + (delta > 0 ? distance / 2 : -distance / 2)
                        let end = scroll.midY + (delta > 0 ? -distance / 2 : distance / 2)
                        let origin = app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
                        origin.withOffset(CGVector(dx: 10, dy: start)).press(forDuration: 0.05,
                            thenDragTo: origin.withOffset(CGVector(dx: 10, dy: end)))
                    }
                    XCTAssertTrue(picker.isHittable)
                    XCTAssertGreaterThanOrEqual(picker.frame.minY, scroll.minY)
                    XCTAssertLessThanOrEqual(picker.frame.maxY, scroll.maxY)
                }
                func selected(_ value: String) {
                    XCTAssertTrue(picker.label.contains(value) || (picker.value as? String ?? "").contains(value))
                    XCTAssertFalse(connect.isEnabled)
                    for state in ["registryWrites=0", "bleConnections=0", "bleCommands=0", "savedSecrets=0", "savedAttempts=0"] {
                        telemetry(app, state)
                    }
                }
                centerPicker(); selected("Choose Cube")
                try capture(app, "cube-picker-\(width)-\(size)-empty")
                picker.tap()
                XCTAssertTrue(app.buttons[locator].waitForExistence(timeout: 3))
                try capture(app, "cube-picker-\(width)-\(size)-menu")
                app.buttons[locator].tap()
                centerPicker(); selected(locator)
                try capture(app, "cube-picker-\(width)-\(size)-selected")
                picker.tap(); app.buttons["Choose Cube"].tap()
                centerPicker(); selected("Choose Cube")
                app.terminate()
            }
        }
    }

    func testCubeEssentialSyntheticStatesUseProductionLeavesWithoutRegistryWrites() throws {
        for state in ["offline", "no-phone", "unknown-battery", "disabled", "ownership", "setup", "empty", "manual", "unavailable"] {
            let regular = state == "unknown-battery"
            let app = launch("cube-" + state, width: regular ? "390" : "320", size: regular ? "default" : "AX5", contrast: regular ? "standard" : "increased")
            let expected = ["offline": "Not connected nearby", "no-phone": "Restore phone access", "unknown-battery": "Not reported",
                            "disabled": "Agent access disabled", "ownership": "Account needs attention", "setup": "Finish setup",
                            "empty": "Scan Cube", "manual": "Pairing info", "unavailable": "Couldn’t finish"][state]!
            if state == "empty" { XCTAssertTrue(app.buttons["Scan Cube"].waitForExistence(timeout: 5)) }
            else { XCTAssertTrue(text(app, containing: expected).waitForExistence(timeout: 5)) }
            if state == "manual" || state == "unavailable" {
                XCTAssertFalse(app.buttons["cube-manual-connect"].isEnabled)
            }
            try capture(app, "cube-\(state)-top")
            if state == "offline" || state == "disabled" || state == "no-phone" || state == "setup" {
                XCTAssertFalse(app.buttons["cube-wifi"].isEnabled)
                menu(app, "Wi-Fi")
                XCTAssertTrue(app.textFields["cube-wifi-ssid"].waitForExistence(timeout: 3))
                XCTAssertFalse(app.textFields["cube-wifi-ssid"].isEnabled)
                XCTAssertFalse(app.secureTextFields["cube-wifi-password"].isEnabled)
                XCTAssertFalse(app.buttons["cube-wifi-send"].isEnabled)
                visible(app, text(app, containing: "Wi-Fi changes do not reset ownership"))
                try capture(app, "cube-\(state)-wifi-disabled-essential-copy")
                menu(app, "Details")
                XCTAssertTrue(text(app, containing: "Unavailable").waitForExistence(timeout: 3))
                try capture(app, "cube-\(state)-details")
            }
            if state == "ownership" || state == "disabled" || state == "no-phone" {
                menu(app, "Access")
                visible(app, text(app, containing: "Ownership and history remain"))
                try capture(app, "cube-\(state)-ownership-warning")
                menu(app, "Recovery")
                visible(app, text(app, containing: "Previous phones may retain offline Bluetooth access"))
                try capture(app, "cube-\(state)-recovery")
            }
            if state == "unknown-battery" {
                menu(app, "Wi-Fi")
                XCTAssertTrue(app.textFields["cube-wifi-ssid"].waitForExistence(timeout: 3))
                XCTAssertTrue(app.textFields["cube-wifi-ssid"].isEnabled)
                XCTAssertTrue(app.secureTextFields["cube-wifi-password"].isEnabled)
                XCTAssertFalse(app.buttons["cube-wifi-send"].isEnabled) // Empty native fields, no Wi-Fi write.
                visible(app, text(app, containing: "Password goes directly to Cube"))
                try capture(app, "cube-wifi-enabled-empty-form")
                menu(app, "Hub")
                menu(app, "Disconnect fake BLE")
                XCTAssertTrue(text(app, containing: "Not connected nearby").waitForExistence(timeout: 3))
                telemetry(app, "checked=true"); telemetry(app, "hardware=false")
                try capture(app, "cube-last-check-disconnected")
            }
            telemetry(app, "registryWrites=0")
            app.terminate()
        }
    }
}
#endif
