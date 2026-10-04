#if T_SETTINGS_UI_TESTS
import XCTest

@MainActor final class SettingsTNativeInteractionTests: XCTestCase {
    private let configurations = [("390", "default"), ("320", "default"), ("320", "AX3")]
    override func setUp() { continueAfterFailure = false }

    private func launch(_ scenario: String, _ configuration: (String, String) = ("390", "default")) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["T_SCENARIO": scenario, "T_WIDTH": configuration.0, "T_SIZE": configuration.1]
        app.launch()
        XCTAssertTrue(app.buttons["t-open"].waitForExistence(timeout: 8))
        app.buttons["t-open"].tap()
        return app
    }
    private func probe(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(identifier: "t-probe").allElementsBoundByAccessibilityElement.last ?? app.buttons["t-probe"].firstMatch
    }
    private func menu(_ app: XCUIApplication, _ action: String) {
        probe(app).tap()
        let button = app.buttons[action]
        XCTAssertTrue(button.waitForExistence(timeout: 4))
        button.tap()
    }
    private func telemetry(_ app: XCUIApplication, _ part: String) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { [weak self] _, _ in
            self.map { (($0.probe(app).value as? String) ?? "").contains(part) } ?? false
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed, "Missing state: \(part)")
    }
    private func wait(_ element: XCUIElement) { XCTAssertTrue(element.waitForExistence(timeout: 5)) }
    private func visible(_ app: XCUIApplication, _ element: XCUIElement, aboveDock: Bool = false) {
        wait(element)
        // Exclude decorative plate shadows from the native content boundary.
        let dock = app.descendants(matching: .any).matching(identifier: "settings-apply-bar-status").firstMatch
        func occluded() -> Bool {
            guard aboveDock else { return false }
            let top = app.scrollViews.allElementsBoundByIndex.max(by: { $0.frame.height < $1.frame.height })?.frame.minY ?? 0
            return element.frame.minY < top || (dock.exists && element.frame.maxY > dock.frame.minY)
        }
        for _ in 0..<8 where !element.isHittable || occluded() {
            let window = app.windows.firstMatch
            let top = max(127, app.scrollViews.allElementsBoundByIndex.max(by: { $0.frame.height < $1.frame.height })?.frame.minY ?? 127)
            let bottom = min(window.frame.maxY - 40, app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY : window.frame.maxY, dock.exists ? dock.frame.minY : window.frame.maxY)
            let upward = element.frame.minY >= top
            let start = top + (bottom - top) * (upward ? 0.8 : 0.2)
            let end = top + (bottom - top) * (upward ? 0.2 : 0.8)
            // Drag scroll-view margin, not native field/editor selection handles.
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: start / window.frame.height)).press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: end / window.frame.height)))
        }
        XCTAssertTrue(element.isHittable)
        XCTAssertFalse(occluded(), "Control still covered by ApplyBar")
    }
    private func edgeBack(_ app: XCUIApplication) {
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.002, dy: 0.45)).press(forDuration: 0.1, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.45)))
    }
    private func target(_ app: XCUIApplication, _ element: XCUIElement) {
        XCTAssertTrue(element.isHittable)
        XCTAssertGreaterThanOrEqual(element.frame.width, 44 - 0.01)
        XCTAssertGreaterThanOrEqual(element.frame.height, 44 - 0.01)
        XCTAssertGreaterThanOrEqual(element.frame.minX, 0)
        XCTAssertLessThanOrEqual(element.frame.maxX, app.windows.firstMatch.frame.maxX + 0.01)
    }
    private func capture(_ app: XCUIApplication, _ name: String) throws {
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
        // Capture transient Applied pixels first, then collect stable AX bounds
        // after its expected auto-dismiss, rather than chasing removed elements.
        let applied = app.buttons.matching(NSPredicate(format: "label == 'Applied'")).firstMatch
        if applied.exists { XCTAssertTrue(applied.waitForNonExistence(timeout: 3)) }
        let nodes = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'settings-' OR identifier == 't-probe'"))
            .allElementsBoundByAccessibilityElement.filter(\.exists)
        let records: [[String: Any]] = nodes.map { element in
            // Never export field values, even though this fixture has synthetic data only.
            // Bind native elements, not changing tree indices as the Applied dock settles.
            let frame = element.frame
            return ["id": element.identifier, "type": element.elementType.rawValue, "enabled": element.isEnabled, "hittable": element.isHittable,
                    "frame": [frame.minX, frame.minY, frame.width, frame.height]]
        }
        let evidence: [String: Any] = ["telemetry": probe(app).value as? String ?? "", "window": [app.windows.firstMatch.frame.width, app.windows.firstMatch.frame.height], "nodes": records]
        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys]), uniformTypeIdentifier: "public.json")
        attachment.name = name + "-AX"; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testPromptInPlaceDiscardGuardedBackSavingRestartFailureRetry() throws {
        let app = launch("prompt")
        let editor = app.textViews["settings-system-prompt-editor"]
        wait(editor); editor.tap(); editor.typeText("\nDisposable draft")
        let discard = app.buttons["settings-system-prompt-discard"]
        let apply = app.buttons["settings-system-prompt-save"]
        target(app, discard); target(app, apply)
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        XCTAssertLessThanOrEqual(apply.frame.maxY, app.keyboards.firstMatch.frame.minY + 0.01)
        try capture(app, "prompt-dirty-keyboard")
        app.buttons["settings-system-prompt-back"].tap()
        wait(app.sheets["Discard changes?"])
        if app.buttons["Keep editing"].exists { app.buttons["Keep editing"].tap() }
        else { app.otherElements["PopoverDismissRegion"].tap() }
        telemetry(app, "backs=0")
        discard.tap(); telemetry(app, "promptDirty=false"); telemetry(app, "backs=0")
        XCTAssertFalse(app.buttons["Keep editing"].exists)
        editor.tap(); editor.typeText("\nDisposable retry draft")
        apply.tap(); telemetry(app, "writes=1")
        menu(app, "Already applying"); telemetry(app, "phase=alreadyApplying")
        XCTAssertEqual(apply.label, "Retry"); telemetry(app, "promptDirty=true")
        try capture(app, "prompt-already-applying-retained-draft")
        apply.tap(); telemetry(app, "writes=2"); telemetry(app, "phase=saving")
        XCTAssertFalse(apply.isEnabled); XCTAssertFalse(discard.isEnabled); XCTAssertFalse(app.buttons["settings-system-prompt-back"].isEnabled)
        edgeBack(app); telemetry(app, "backs=0")
        app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
        telemetry(app, "backs=0"); telemetry(app, "promptDirty=true")
        try capture(app, "prompt-saving-guarded")
        menu(app, "Restart phase"); telemetry(app, "phase=restarting")
        XCTAssertFalse(apply.isEnabled); XCTAssertFalse(discard.isEnabled)
        try capture(app, "prompt-restarting")
        menu(app, "Fail write"); telemetry(app, "phase=failed")
        XCTAssertEqual(apply.label, "Retry")
        XCTAssertTrue((editor.value as? String ?? "").contains("Disposable retry draft"))
        try capture(app, "prompt-failed-retained-draft")
        apply.tap(); telemetry(app, "writes=3")
        menu(app, "Finish write"); telemetry(app, "phase=applied"); telemetry(app, "promptDirty=false")
        try capture(app, "prompt-applied")
        editor.tap(); editor.typeText("\nUnapplied next draft")
        app.buttons["settings-system-prompt-back"].tap(); wait(app.sheets["Discard changes?"]); app.sheets["Discard changes?"].buttons["Discard"].tap()
        telemetry(app, "backs=1"); telemetry(app, "promptDirty=false")
        app.terminate()
    }

    func testMemoryPartialSlotsRefreshFailureKeepsAcknowledgedBaseline() throws {
        let app = launch("memory")
        wait(app.textViews["settings-memory-editor"])
        menu(app, "Dirty both slots"); telemetry(app, "memoryDirty=true")
        app.buttons["settings-memory-discard"].tap(); telemetry(app, "memoryDirty=false"); telemetry(app, "backs=0")
        menu(app, "Dirty both slots"); menu(app, "Fail memory refresh")
        app.buttons["settings-memory-save"].tap(); telemetry(app, "writes=1")
        XCTAssertFalse(app.buttons["settings-memory-discard"].isEnabled)
        menu(app, "Finish write"); telemetry(app, "phase=applied")
        wait(app.staticTexts["settings-error"])
        telemetry(app, "memoryDirty=true")
        try capture(app, "memory-partial-refresh-failure")
        app.buttons["settings-memory-discard"].tap(); telemetry(app, "memoryDirty=false"); telemetry(app, "writes=1")
        app.buttons["About you"].tap(); wait(app.textViews["settings-memory-editor"])
        XCTAssertFalse((app.textViews["settings-memory-editor"].value as? String ?? "").contains("User draft"))
        app.terminate()
    }

    func testSecretsLateTypedFailureRetainsMaskedEditorRetryContext() throws {
        let app = launch("secrets")
        let edit = app.buttons["settings-secret-openrouter-update"]
        visible(app, edit); edit.tap()
        let input = app.secureTextFields["settings-secret-openrouter-input"]
        visible(app, input); input.tap(); input.typeText("fixture-placeholder")
        XCTAssertFalse((input.value as? String ?? "").contains("fixture-placeholder"))
        let save = app.buttons["settings-secret-openrouter-save"]
        visible(app, save); XCTAssertTrue(save.isEnabled); try capture(app, "secrets-dirty-keyboard-before-submit"); save.tap(); telemetry(app, "writes=1"); telemetry(app, "editor=openrouter")
        XCTAssertFalse(save.isEnabled); XCTAssertFalse(app.buttons["settings-secret-openrouter-cancel"].isEnabled)
        menu(app, "Attempt blocked VM edits"); telemetry(app, "writes=1"); telemetry(app, "editor=openrouter")
        edgeBack(app); telemetry(app, "backs=0")
        menu(app, "Fail write"); telemetry(app, "phase=failed"); telemetry(app, "editor=openrouter")
        wait(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Secret change failed")).firstMatch)
        XCTAssertFalse((input.value as? String ?? "").contains("fixture-placeholder")); XCTAssertTrue(save.isEnabled)
        try capture(app, "secrets-failed-masked-original-editor")
        save.tap(); telemetry(app, "writes=2"); telemetry(app, "context=true")
        menu(app, "Finish write"); telemetry(app, "editor=none")
        visible(app, app.buttons["settings-secret-custom-baseurl-update"]); app.buttons["settings-secret-custom-baseurl-update"].tap()
        let url = app.secureTextFields["settings-secret-custom-baseurl-input"]
        visible(app, url); url.tap(); url.typeText("https://example.invalid/v1")
        visible(app, app.buttons["settings-secret-custom-baseurl-save"]); app.buttons["settings-secret-custom-baseurl-save"].tap()
        telemetry(app, "writes=3"); telemetry(app, "editor=url")
        menu(app, "Fail write"); telemetry(app, "editor=url")
        XCTAssertFalse((url.value as? String ?? "").contains("example.invalid"))
        try capture(app, "secrets-url-failure-masked")
        app.terminate()
    }

    func testNativePinMemberPersonalityBusyDismissAndRetry() throws {
        try checkNativeSheets([("390", "default"), ("320", "AX5")])
    }

    func testAX5NativeSheetsVisibleContentAndActions() throws {
        try checkNativeSheets([("390", "AX5")])
    }

    private func checkNativeSheets(_ configurations: [(String, String)]) throws {
        for configuration in configurations {
        for route in ["pin", "member", "personality"] {
            let app = launch(route, configuration)
            wait(app.buttons["t-present"]); app.buttons["t-present"].tap()
            let prefix: String
            if route == "pin" {
                prefix = "settings-account-pin"
                visible(app, app.secureTextFields[prefix + "-current"]); app.secureTextFields[prefix + "-current"].tap(); app.secureTextFields[prefix + "-current"].typeText("1111")
                visible(app, app.secureTextFields[prefix + "-new"]); app.secureTextFields[prefix + "-new"].tap(); app.secureTextFields[prefix + "-new"].typeText("2222")
            } else if route == "member" {
                prefix = "settings-members-add"
                visible(app, app.textFields[prefix + "-name"]); app.textFields[prefix + "-name"].tap(); app.textFields[prefix + "-name"].typeText("Disposable member")
                visible(app, app.secureTextFields[prefix + "-pin"]); app.secureTextFields[prefix + "-pin"].tap(); app.secureTextFields[prefix + "-pin"].typeText("1111")
            } else {
                prefix = "settings-personalities-new"
                visible(app, app.textFields[prefix + "-name"]); app.textFields[prefix + "-name"].tap(); app.textFields[prefix + "-name"].typeText("Disposable personality")
            }
            let submit = app.buttons[prefix + "-submit"]
            // Retain native toolbar controls; record their actual AX geometry,
            // rather than declaring UIKit's capsule bounds a custom-control pass.
            XCTAssertTrue(submit.isHittable)
            let cancel = app.buttons[prefix + "-cancel"]
            XCTAssertTrue(cancel.isHittable)
            XCTAssertFalse(cancel.frame.intersects(submit.frame))
            // Inspect full content after native keyboard dismissal; keyboard-open
            // AX containment is separate from reachable sheet content/actions.
            menu(app, "Dismiss keyboard")
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
            let fields = route == "pin" ? [app.secureTextFields[prefix + "-current"], app.secureTextFields[prefix + "-new"]]
                : route == "member" ? [app.textFields[prefix + "-name"], app.secureTextFields[prefix + "-pin"]]
                : [app.textFields[prefix + "-name"], app.textViews[prefix + "-body"]]
            for (index, field) in fields.enumerated() {
                visible(app, field, aboveDock: true)
                XCTAssertFalse(field.frame.intersects(submit.frame))
                XCTAssertFalse(field.frame.intersects(cancel.frame))
                if app.keyboards.firstMatch.exists {
                    XCTAssertLessThanOrEqual(field.frame.maxY, app.keyboards.firstMatch.frame.minY + 0.01)
                }
                try capture(app, route + "-visible-native-sheet-field-\(index)")
            }
            XCTAssertFalse(fields[0].frame.intersects(fields[1].frame))
            try capture(app, route + "-valid-native-sheet-before-submit")
            XCTAssertTrue(submit.isEnabled)
            submit.tap()
            telemetry(app, "writes=1")
            XCTAssertFalse(submit.isEnabled); XCTAssertFalse(app.buttons[prefix + "-cancel"].isEnabled)
            let field = route == "pin" ? app.secureTextFields[prefix + "-new"] : app.textFields[prefix + "-name"]
            XCTAssertFalse(field.isEnabled)
            let window = app.windows.firstMatch
            let grabberY = max(60, app.navigationBars.firstMatch.frame.minY - 10)
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: grabberY / window.frame.height)).press(forDuration: 0.1, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
            telemetry(app, "sheet=true")
            app.typeKey(XCUIKeyboardKey.escape, modifierFlags: []); telemetry(app, "sheet=true"); telemetry(app, "writes=1")
            try capture(app, route + "-busy-native-sheet")
            menu(app, "Fail write"); telemetry(app, "phase=failed"); XCTAssertTrue(submit.isEnabled)
            try capture(app, route + "-failed-retained-native-sheet")
            submit.tap(); telemetry(app, "writes=2")
            menu(app, "Finish write"); telemetry(app, "sheet=false")
            app.terminate()
        }
        }
    }

    func testVoiceCreateFishBusyCancelBackEditsAndRetry() throws {
        for route in ["voice", "fish"] {
            let app = launch(route)
            let prefix = route == "voice" ? "settings-voice-add" : "settings-voice-fish-clone"
            if route == "voice" {
                wait(app.buttons["settings-voice-add-record"]); app.buttons["settings-voice-add-record"].tap()
                let stop = app.buttons["settings-voice-add-use-recording"]
                wait(stop)
                XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: stop)], timeout: 12), .completed)
                stop.tap()
                app.buttons["settings-voice-add-continue-details"].tap()
                let name = app.textFields["settings-voice-add-name"]; wait(name); name.tap(); name.typeText("Disposable voice")
                menu(app, "Dismiss keyboard")
                visible(app, app.buttons["settings-voice-add-continue-review"]); app.buttons["settings-voice-add-continue-review"].tap()
            }
            let submit = app.buttons[prefix + "-submit"]
            visible(app, submit); submit.tap(); telemetry(app, "writes=1")
            XCTAssertFalse(submit.isEnabled)
            menu(app, "Attempt blocked VM edits"); telemetry(app, "writes=1"); telemetry(app, "context=true")
            edgeBack(app); telemetry(app, "backs=0")
            if route == "fish" { XCTAssertFalse(app.buttons[prefix + "-cancel"].isEnabled) }
            try capture(app, route + "-busy")
            menu(app, "Fail write"); telemetry(app, "phase=failed")
            XCTAssertTrue(submit.isEnabled)
            try capture(app, route + "-failure-retained-context")
            submit.tap(); telemetry(app, "writes=2")
            menu(app, "Finish write"); telemetry(app, "backs=1")
            app.terminate()
        }
    }

    func testAuxiliaryNativeChooserVisionRestrictionDefaultResetAndToolsTargets() throws {
        let app = launch("auxiliary")
        let choose = app.buttons["settings-model-auxiliary-attachment-vision"]
        visible(app, choose); choose.tap()
        wait(app.buttons["settings-model-card-vision-candidate"])
        XCTAssertFalse(app.buttons["settings-model-card-text-candidate"].exists)
        XCTAssertFalse(app.buttons["settings-model-card-foreign-vision"].exists)
        try capture(app, "auxiliary-native-vision-sheet")
        app.buttons["settings-model-card-vision-candidate"].tap()
        let reset = app.buttons["settings-model-auxiliary-attachment-vision-reset"]
        visible(app, reset); reset.tap()
        try capture(app, "auxiliary-default-reset")
        app.terminate()
        let tools = launch("tools")
        let master = tools.switches["settings-tools-server-home-assistant"]
        let disclosure = tools.buttons["settings-tools-server-expand-home-assistant"]
        visible(tools, master); target(tools, master); target(tools, disclosure)
        XCTAssertFalse(master.frame.intersects(disclosure.frame))
        let detail = tools.buttons["settings-tools-tool-home-assistant-turn_on"]
        XCTAssertFalse(detail.isHittable)
        master.tap(); XCTAssertFalse(detail.isHittable)
        disclosure.tap(); visible(tools, detail)
        // Real exported McpToolView metadata must reach production row text,
        // not NSObject's inherited debug description (McpToolView(...)).
        visible(tools, tools.staticTexts["Disposable capability"].firstMatch)
        XCTAssertFalse(tools.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "McpToolView(")).firstMatch.exists)
        detail.tap()
        wait(tools.buttons["settings-select-option-off"]); tools.buttons["settings-select-option-off"].tap()
        try capture(tools, "tools-expanded-independent-native-menu")
        tools.terminate()
    }

    func testProfileControlsDiscardBusyBackFailureRetryAndNativeSlider() throws {
        for route in ["audio", "advanced", "model", "tools"] {
            let app = launch(route)
            let control: XCUIElement
            switch route {
            case "audio": control = app.switches["settings-audio-tts"]
            case "advanced": control = app.sliders["settings-advanced-compression"]
            case "model": control = app.buttons["settings-model-card-vision-candidate"]
            default: control = app.switches["settings-tools-server-home-assistant"]
            }
            visible(app, control)
            let original = control.value as? String
            let mutate = {
                if route == "advanced" { control.adjust(toNormalizedSliderPosition: 0.4) }
                else { control.tap() }
            }
            mutate()
            let changed = control.value as? String
            if route != "model" { XCTAssertNotEqual(changed, original) }
            let discard = app.buttons["settings-\(route)-discard"]
            let save = app.buttons["settings-\(route)-save"]
            target(app, discard); target(app, save)
            discard.tap(); telemetry(app, "backs=0")
            if route != "model" { XCTAssertEqual(control.value as? String, original) }
            mutate(); save.tap(); telemetry(app, "writes=1")
            XCTAssertFalse(control.isEnabled); XCTAssertFalse(discard.isEnabled); XCTAssertFalse(save.isEnabled)
            edgeBack(app); telemetry(app, "backs=0")
            try capture(app, route + "-saving-disabled-native-control")
            menu(app, "Fail write"); telemetry(app, "phase=failed")
            XCTAssertEqual(save.label, "Retry"); XCTAssertTrue(control.isEnabled)
            if route != "model" { XCTAssertEqual(control.value as? String, changed) }
            save.tap(); telemetry(app, "writes=2")
            menu(app, "Finish write"); telemetry(app, "phase=applied")
            XCTAssertTrue(control.isEnabled)
            try capture(app, route + "-applied-retained-preference")
            app.terminate()
        }
    }

    func testRestoreFailureRetainsEditor() throws {
        let app = launch("prompt", ("320", "AX3"))
        let editor = app.textViews["settings-system-prompt-editor"]
        visible(app, editor); editor.tap(); editor.typeText("\nDisposable restore draft")
        menu(app, "Dismiss keyboard")
        visible(app, app.buttons["settings-system-prompt-advanced"], aboveDock: true); app.buttons["settings-system-prompt-advanced"].tap()
        visible(app, app.buttons["settings-system-prompt-restore"], aboveDock: true); app.buttons["settings-system-prompt-restore"].tap()
        wait(app.sheets["Restore default instructions?"])
        app.sheets["Restore default instructions?"].buttons["Restore"].tap()
        wait(app.staticTexts["Couldn't load default instructions"])
        telemetry(app, "writes=0"); telemetry(app, "promptDirty=true")
        XCTAssertEqual(app.buttons["settings-system-prompt-save"].label, "Apply changes")
        XCTAssertTrue((editor.value as? String ?? "").contains("Disposable restore draft"))
        let notice = app.staticTexts["Couldn't load default instructions"]
        let retry = app.buttons["Retry"]
        visible(app, notice, aboveDock: true)
        try capture(app, "prompt-visible-restore-error-320-AX3")
        visible(app, retry, aboveDock: true)
        target(app, retry)
        try capture(app, "prompt-visible-restore-retry-320-AX3")
        retry.tap()
        wait(notice)
        telemetry(app, "writes=0"); telemetry(app, "promptDirty=true")
        XCTAssertTrue((editor.value as? String ?? "").contains("Disposable restore draft"))
        XCTAssertEqual(app.buttons["settings-system-prompt-save"].label, "Apply changes")
        app.buttons["settings-system-prompt-save"].tap(); telemetry(app, "phase=saving")
        try capture(app, "prompt-saving-320-AX3")
        menu(app, "Finish write"); telemetry(app, "phase=applied")
        telemetry(app, "writes=1"); telemetry(app, "promptDirty=false")
        visible(app, editor)
        XCTAssertTrue((editor.value as? String ?? "").contains("Disposable restore draft"))
        try capture(app, "prompt-restore-recovered-applied-320-AX3")
        editor.tap(); editor.typeText("\nNext draft after success")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        telemetry(app, "promptDirty=true")
        app.terminate()
    }

    func testActiveProviderMutationPreservesUnrelatedMaskedDraft() throws {
        let app = launch("secrets")
        let edit = app.buttons["settings-secret-openrouter-update"]
        visible(app, edit); edit.tap()
        let input = app.secureTextFields["settings-secret-openrouter-input"]
        visible(app, input); input.tap(); input.typeText("fixture-placeholder")
        menu(app, "Dismiss keyboard")
        let select = app.buttons["settings-secret-custom-active"]
        visible(app, select); select.tap(); telemetry(app, "writes=1")
        telemetry(app, "editor=openrouter"); XCTAssertFalse(input.isEnabled)
        menu(app, "Finish write"); telemetry(app, "editor=openrouter")
        XCTAssertTrue(input.isEnabled)
        XCTAssertFalse((input.value as? String ?? "").contains("fixture-placeholder"))
        visible(app, app.buttons["settings-secret-openrouter-save"])
        XCTAssertTrue(app.buttons["settings-secret-openrouter-save"].isEnabled)
        try capture(app, "secrets-provider-success-unrelated-masked-draft")
        app.terminate()
    }

    func testAX5ProductionStatesAndPreview() throws {
        try checkCurrentProductionStates([("320", "AX5")])
    }

    func testProductionStatesNarrowDefaultAX3AndPreview() throws {
        try checkCurrentProductionStates(configurations)
    }

    private func checkCurrentProductionStates(_ configurations: [(String, String)]) throws {
        for config in configurations {
            for route in ["audio", "advanced", "auxiliary", "tools", "memory", "prompt", "secrets", "voice", "fish"] {
                let app = launch(route, config)
                let screen = ["prompt": "settings-system-prompt-screen", "voice": "settings-voice-add", "fish": "settings-voice-fish"][route] ?? "settings-\(route)-screen"
                wait(app.otherElements[screen].firstMatch)
                try capture(app, "current-\(route)-\(config.0)-\(config.1)")
                if route == "prompt" || route == "memory" {
                    let editorId = route == "prompt" ? "settings-system-prompt-editor" : "settings-memory-editor"
                    let editor = app.textViews[editorId]
                    visible(app, editor); editor.tap(); editor.typeText("\nDisposable layout draft")
                    let saveId = route == "prompt" ? "settings-system-prompt-save" : "settings-memory-save"
                    let save = app.buttons[saveId]
                    target(app, save)
                    XCTAssertLessThanOrEqual(save.frame.maxY, app.keyboards.firstMatch.frame.minY + 0.01)
                    try capture(app, "dirty-keyboard-\(route)-\(config.0)-\(config.1)")
                    menu(app, "Dismiss keyboard")
                    visible(app, app.buttons["Preview"]); app.buttons["Preview"].tap()
                    try capture(app, "preview-\(route)-\(config.0)-\(config.1)")
                    visible(app, app.buttons["Edit"]); app.buttons["Edit"].tap(); wait(editor)
                    XCTAssertTrue((editor.value as? String ?? "").contains("Disposable layout draft"))
                }
                app.terminate()
            }
            for route in ["pin", "member", "personality"] {
                let app = launch(route, config)
                wait(app.buttons["t-present"]); app.buttons["t-present"].tap()
                let prefix = ["pin": "settings-account-pin", "member": "settings-members-add", "personality": "settings-personalities-new"][route]!
                wait(app.buttons[prefix + "-cancel"])
                try capture(app, "current-native-sheet-\(route)-\(config.0)-\(config.1)")
                app.buttons[prefix + "-cancel"].tap(); telemetry(app, "sheet=false")
                app.terminate()
            }
        }
    }
}
#endif
