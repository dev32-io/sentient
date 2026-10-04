// Compile in the isolated production-renderer bundle.ui-testing target, not the app's unit-test
// target. The delivery runner supplies this flag and a network-free fixture app.
#if R0_NATIVE_UI_TESTS
import XCTest

@MainActor
final class RendererFeasibilityGestureTests: XCTestCase {
    private var sequence = 0
    private var scenario = ""
    private var output: URL!
    private func launch(_ name: String) throws -> XCUIApplication {
        continueAfterFailure = false
        sequence = 0
        scenario = "\(name)-\(ProcessInfo.processInfo.operatingSystemVersion.majorVersion)"
        if let path = ProcessInfo.processInfo.environment["R0_OUTPUT"] {
            output = URL(fileURLWithPath: path)
        } else {
            let request = try String(contentsOfFile: "/tmp/sentient-visual-diff-request", encoding: .utf8).split(separator: "\n")
            output = URL(fileURLWithPath: String(request[1]))
        }
        let app = XCUIApplication()
        app.launchEnvironment["R0_SCENARIO"] = scenario
        app.launchEnvironment["R0_OUTPUT"] = output.path
        if ["table-menu", "horizontal", "mutation", "cancel", "remove"].contains(name) {
            app.launchEnvironment["R0_WIDE_TABLE"] = "1"
        }
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Before café 👩🏽‍💻 — select from here into any cell.")).firstMatch.waitForExistence(timeout: 5))
        return app
    }
    private func point(_ app: XCUIApplication, _ x: Double, _ y: Double) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }
    private func save(_ app: XCUIApplication, _ name: String, expectedClipboard: String? = nil) throws -> [String: Any] {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        app.buttons["r0-save"].tap()
        sequence += 1
        let state = try JSONSerialization.jsonObject(with: Data(contentsOf: output.appendingPathComponent("\(scenario)-\(sequence).json"))) as! [String: Any]
        if let clipboard = state["clipboard"] as? String {
            XCTAssertEqual(Data(clipboard.utf8), Data((expectedClipboard ?? (state["selectedText"] as! String)).utf8), "Native menu Copy must equal exact current range bytes")
        }
        return state
    }
    private func rect(_ state: [String: Any], _ key: String) -> CGRect {
        let r = state[key] as! [String: Double]
        return CGRect(x: r["x"]!, y: r["y"]!, width: r["width"]!, height: r["height"]!)
    }
    private func copy(_ app: XCUIApplication) {
        let item = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Copy'")).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 3))
        item.tap()
        try! Data().write(to: output.appendingPathComponent("capture-owned-clipboard"), options: .withoutOverwriting)
    }
    private func drag(_ app: XCUIApplication, _ state: [String: Any], to end: CGPoint, hold: Double = 3) {
        let handle = (state["handles"] as! [[String: Any]]).first { $0["leading"] as? Bool == false }!
        let box = rect(handle, "rect")
        point(app, box.midX, box.maxY - min(8, box.height / 2)).press(forDuration: 0.15,
            thenDragTo: point(app, end.x, end.y), withVelocity: .slow, thenHoldForDuration: hold)
    }
    private func assertStopped(_ state: [String: Any]) {
        XCTAssertEqual(state["edgeRunning"] as? Bool, false)
        XCTAssertEqual(state["anchor"] as? Int, -1)
        XCTAssertEqual(state["retentionFailures"] as? Int, 0)
    }
    private func assertStationary(_ state: [String: Any], axis: String) {
        let motion = state["motion"] as! [[String: Any]]
        let moving = motion.filter { abs(($0[axis] as! Double)) > 0.001 }
        let groups = Dictionary(grouping: moving) { "\($0["x"]!):\($0["y"]!)" }
        let held = groups.values.max { $0.count < $1.count } ?? []
        XCTAssertGreaterThan(held.count, 10, "Multiple real frames must move under identical physical pointer")
        if let first = held.first, let last = held.last {
            XCTAssertGreaterThan((last["time"] as! Double) - (first["time"] as! Double), 0.3)
        }
        XCTAssertTrue(moving.allSatisfy { abs($0[axis] as! Double) <= 8.01 }, "Frame delta must stay bounded")
        XCTAssertEqual(Set(moving.map { $0["anchor"] as! Int }).count, 1)
    }
    private func selectFirstWord(_ app: XCUIApplication, _ state: [String: Any]) {
        let first = rect(state, "firstCaret")
        point(app, first.minX + max(2, first.height / 4), first.midY).press(forDuration: 1)
    }

    func testCellTextKeepsNativeMenuAndOutsideTapDismisses() throws {
        let app = try launch("arbitration")
        let initial = try save(app, "initial")
        let table = rect(initial, "tableRect")
        point(app, table.minX + 24, table.minY + 24).press(forDuration: 1)
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Copy entire table'")).firstMatch.exists)
        copy(app)
        let text = try save(app, "cell-text", expectedClipboard: "Name")
        XCTAssertGreaterThan(text["selectionLength"] as! Int, 0)
        point(app, table.midX, table.maxY + 50).tap()
        let dismissed = try save(app, "outside")
        XCTAssertEqual(dismissed["selectionLength"] as? Int, 0)
        assertStopped(dismissed)
        let space = rect(initial, "cellSpace")
        point(app, space.midX, space.midY).press(forDuration: 1)
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Copy entire table'")).firstMatch.exists)
        copy(app)
        let spaced = try save(app, "interior-word-space")
        XCTAssertGreaterThan(spaced["selectionLength"] as! Int, 0)
    }

    func testTableBackgroundMenuAndNativeInertia() throws {
        let app = try launch("table-menu")
        let initial = try save(app, "initial")
        XCTAssertFalse(app.buttons["chat-copy-table"].exists)
        let table = rect(initial, "tableRect")
        point(app, table.minX + 3, table.minY + 3).press(forDuration: 1)
        let menu = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Copy entire table'")).firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 3))
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "table-background-native-menu"; shot.lifetime = .keepAlways; add(shot)
        menu.tap()
        try Data().write(to: output.appendingPathComponent("capture-owned-clipboard"), options: .withoutOverwriting)
        let copied = try save(app, "background-copy", expectedClipboard: initial["firstTableMarkdown"] as? String)
        XCTAssertEqual(copied["selectionLength"] as? Int, 0)
        point(app, table.midX + 25, table.minY + 30).press(forDuration: 0.01,
            thenDragTo: point(app, table.midX - 25, table.minY + 30), withVelocity: .fast, thenHoldForDuration: 0)
        let flicked = try save(app, "flick")
        XCTAssertGreaterThan(flicked["tableOffset"] as! Double, 0)
        XCTAssertGreaterThan(flicked["decelerationFrames"] as! Int, 0)
        XCTAssertGreaterThan(flicked["decelerationTravel"] as! Double, 0, "Content must move after release, not merely report decelerating at its bound")
        XCTAssertEqual(flicked["parentOffset"] as? Double, initial["parentOffset"] as? Double)
        XCTAssertEqual(flicked["selectionLength"] as? Int, 0)
    }

    func testLongWideTableNativeCoastFrameProbe() throws {
        let app = try launch("long-coast")
        let initial = try save(app, "long-wide-initial")
        let table = rect(initial, "tableRect")
        point(app, table.maxX - 25, table.minY + 30).press(forDuration: 0.01,
            thenDragTo: point(app, table.minX + 25, table.minY + 30), withVelocity: .fast, thenHoldForDuration: 0)
        let after = try save(app, "long-wide-settled")
        XCTAssertGreaterThan(after["decelerationFrames"] as! Int, 20)
        XCTAssertGreaterThan(after["decelerationTravel"] as! Double, 50)
        XCTAssertEqual(after["isCoasting"] as? Bool, false)
        XCTAssertEqual(after["selectionLength"] as? Int, 0)
        XCTAssertEqual(after["parentOffset"] as? Double, initial["parentOffset"] as? Double)
        assertStopped(after)
    }

    func testHorizontalHoldAndReverse() throws {
        let app = try launch("horizontal")
        let initial = try save(app, "initial-AX")
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Value")).firstMatch.exists)
        selectFirstWord(app, initial)
        let selected = try save(app, "native-word")
        let table = rect(selected, "tableRect")
        drag(app, selected, to: CGPoint(x: table.maxX - 2, y: table.minY + table.height / 2 + 45))
        copy(app)
        let forward = try save(app, "horizontal-held")
        assertStationary(forward, axis: "dx"); assertStopped(forward)
        XCTAssertGreaterThan(forward["tableOffset"] as! Double, 100)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Value")).firstMatch.exists, "Previously offscreen cell must be reachable in native AX")
        let caret = rect(forward, "caretEnd")
        drag(app, forward, to: CGPoint(x: table.minX + 1, y: caret.midY + 45), hold: 2)
        copy(app)
        let reverse = try save(app, "horizontal-reversed")
        assertStopped(reverse)
        XCTAssertLessThan(reverse["tableOffset"] as! Double, forward["tableOffset"] as! Double)
        let motion = reverse["motion"] as! [[String: Any]]
        XCTAssertTrue(motion.contains { ($0["dx"] as! Double) < 0 })
        XCTAssertEqual(reverse["selectionStart"] as? Int, selected["selectionStart"] as? Int)
    }

    func testVerticalHoldReverseAndManualPan() throws {
        let app = try launch("vertical")
        app.buttons["r0-append"].tap(); app.buttons["r0-append"].tap()
        app.buttons["r0-type"].tap(); app.buttons["r0-width"].tap()
        let initial = try save(app, "large-type-initial")
        let first = rect(initial, "firstCaret")
        point(app, first.minX + max(2, first.height / 4), first.midY).press(forDuration: 1)
        let selected = try save(app, "native-large-word")
        let viewport = rect(selected, "viewport")
        drag(app, selected, to: CGPoint(x: 240, y: viewport.maxY - 2), hold: 2.5)
        copy(app)
        let forward = try save(app, "vertical-held")
        assertStationary(forward, axis: "dy"); assertStopped(forward)
        XCTAssertGreaterThan(forward["parentOffset"] as! Double, 100)
        drag(app, forward, to: CGPoint(x: 120, y: viewport.minY + 16), hold: 2.5)
        copy(app)
        let reverse = try save(app, "vertical-reversed")
        assertStopped(reverse)
        XCTAssertLessThan(reverse["parentOffset"] as! Double, forward["parentOffset"] as! Double)
        let frameCount = (reverse["motion"] as! [Any]).count
        point(app, 365, 650).press(forDuration: 0.05, thenDragTo: point(app, 365, 300), withVelocity: .slow, thenHoldForDuration: 0)
        let manual = try save(app, "manual-parent-pan")
        XCTAssertGreaterThan(manual["parentOffset"] as! Double, reverse["parentOffset"] as! Double)
        XCTAssertEqual((manual["motion"] as! [Any]).count, frameCount, "Manual pan must not activate edge coordinator")
        assertStopped(manual)
    }

    func testMutationDuringHeldDrag() throws {
        let app = try launch("mutation")
        let initial = try save(app, "mutation-initial")
        app.buttons["r0-arm"].tap()
        selectFirstWord(app, initial)
        let selected = try save(app, "mutation-word")
        let table = rect(selected, "tableRect")
        drag(app, selected, to: CGPoint(x: table.maxX - 2, y: table.minY + table.height / 2 + 45))
        copy(app)
        let state = try save(app, "stream-resize-image-during-hold")
        XCTAssertEqual(state["mutations"] as? Int, 3)
        XCTAssertEqual(state["imageReady"] as? Bool, true, "Controlled image must really arrive while native selection is held")
        let probe = state["mutationProbe"] as! [String: Any]
        XCTAssertEqual(probe["anchorBefore"] as? Int, selected["selectionStart"] as? Int)
        XCTAssertEqual(probe["anchorAfter"] as? Int, selected["selectionStart"] as? Int)
        XCTAssertEqual(probe["offsetBefore"] as? Double, probe["offsetAfter"] as? Double)
        assertStationary(state, axis: "dx"); assertStopped(state)
    }

    func testHostDeniesNativeSelectionScroll() throws {
        let app = try launch("denied")
        app.buttons["r0-type"].tap(); app.buttons["r0-width"].tap()
        app.buttons["r0-deny"].tap()
        let initial = try save(app, "denied-initial")
        selectFirstWord(app, initial)
        let selected = try save(app, "denied-word")
        let viewport = rect(selected, "viewport")
        drag(app, selected, to: CGPoint(x: 240, y: viewport.maxY - 2))
        let state = try save(app, "denied-held")
        XCTAssertGreaterThan(state["deniedRequests"] as! Int, 0)
        XCTAssertEqual(state["parentOffset"] as! Double, initial["parentOffset"] as! Double)
        assertStopped(state)
    }

    func testNativeCancellationDuringHeldDrag() throws { try interruption("cancel") }
    func testWindowRemovalDuringHeldDrag() throws { try interruption("remove") }
    private func interruption(_ action: String) throws {
        let app = try launch(action)
        let initial = try save(app, "\(action)-initial")
        app.buttons["r0-\(action)"].tap()
        selectFirstWord(app, initial)
        let selected = try save(app, "\(action)-word")
        let table = rect(selected, "tableRect")
        drag(app, selected, to: CGPoint(x: table.maxX - 2, y: table.minY + table.height / 2 + 45))
        let state = try save(app, "\(action)-after-held-finger")
        XCTAssertEqual(state["probeFrame"] as? Int, 10)
        XCTAssertEqual((state["motion"] as! [Any]).count, 10, "No frame work after cancel/removal despite held finger")
        assertStopped(state)
        if action == "remove" {
            XCTAssertEqual(state["attached"] as? Bool, false)
            XCTAssertTrue((state["elements"] as! [Any]).isEmpty)
        } else {
            let states = state["nativeGestureStates"] as! [String: Int]
            XCTAssertGreaterThan(states["4"] ?? 0, 0, "Real native recognizer cancellation must be observed")
        }
    }
}

#endif
