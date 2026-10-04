// Standalone, network-free app/UI-test targets compile the SAME production
// sources. Neither flag is enabled by the ordinary app or unit-test target.
#if F_FOUNDATION_FIXTURE
import SwiftUI
import MobileData

@main
final class FoundationInteractionApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let host = UIHostingController(rootView: FoundationInteractionFixture())
        host.traitOverrides.accessibilityContrast = ProcessInfo.processInfo.environment["F_CONTRAST"] == "increased" ? .high : .normal
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = host
        window?.makeKeyAndVisible()
        return true
    }
}

private struct FoundationInteractionFixture: View {
    private let env = ProcessInfo.processInfo.environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var count = 0
    @State private var selection = "allow"
    @State private var selected = false
    @State private var enabled = true
    @State private var toggle = false

    private var size: DynamicTypeSize {
        switch env["F_SIZE"] {
        case "ax3": .accessibility3
        case "ax5": .accessibility5
        default: .large
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Text("Callbacks: \(count)").font(.caption).dynamicTypeSize(.large).accessibilityIdentifier("f-count")
                Text("Motion: \(reduceMotion ? "reduced" : "normal"); contrast: \(contrast == .increased ? "increased" : "normal")")
                    .font(.caption).dynamicTypeSize(.large).accessibilityIdentifier("f-environment")
                switch env["F_SCENARIO"] {
                case "media":
                    DesignDominantVisualCard(title: "Disposable media", detail: "One native action",
                        accessibilityLabel: "Open disposable media", accessibilityId: "f-media",
                        action: { count += 1 }) { Image(systemName: "photo") }
                    DesignDominantVisualCard(title: "Unavailable media",
                        accessibilityLabel: "Unavailable media", accessibilityId: "f-disabled-media",
                        action: { count += 100 }) { Image(systemName: "photo") }
                        .disabled(true)
                case "select":
                    DesignSelect(title: "Permission", detail: "Choose how this capability may run.",
                        options: [("allow", "Allow after confirmation"), ("off", "Never allow this capability")],
                        selection: $selection, isEnabled: enabled, accessibilityId: "f-menu",
                        optionAccessibilityId: { "f-option-\($0)" })
                    Text(selection).accessibilityIdentifier("f-selection")
                    Button("Disable selection") { enabled = false }.accessibilityIdentifier("f-disable")
                case "buttons":
                    DesignTextButton(title: "Go", accessibilityId: "f-short") { count += 1 }
                    DesignTextButton(title: "Delete", role: .destructive, accessibilityId: "f-delete") { count += 1 }
                    DesignTextButton(title: "Unavailable", state: .disabled, accessibilityId: "f-disabled") { count += 100 }
                    DesignActionButton(title: "Save", loadingTitle: "Saving settings", state: .loading,
                        accessibilityId: "f-loading-button") { count += 100 }
                    DesignChip(title: "Family", selected: selected, accessibilityId: "f-chip") { selected.toggle(); count += 1 }
                    DesignToggleSwitch(label: "Notifications", isOn: $toggle, accessibilityId: "f-toggle")
                case "update":
                    UpdateFooter(status: UpdateStatusUpToDate.shared, versionText: "1.8.0 (15)",
                        accessibilityId: "f-update", onCheck: { count += 1; return UpdateStatusUpToDate.shared },
                        onInstall: { count += 100 })
                    UpdateFooter(status: UpdateStatusAvailable(latestBuild: 16, versionName: "1.8.1", notes: "",
                        mandatory: false, target: UpdateTargetIosItms(itmsUrl: "https://example.invalid/disposable")),
                        versionText: "1.8.0 (15)", accessibilityId: "f-install",
                        onCheck: { count += 100; return UpdateStatusUpToDate.shared }, onInstall: { count += 1 })
                default:
                    #if F_BASELINE
                    SoulLoadingRow()
                    #else
                    SoulLoadingRow(title: "Loading audio settings")
                    #endif
                    Text("First body line\nSecond body line\nThird body line").designText(.body)
                    Text("Supporting line\nSecond supporting line").designText(.supporting)
                }
            }
            .padding(.horizontal, 12)
            .frame(width: 320)
            .frame(maxWidth: .infinity)
        }
        .environment(\.dynamicTypeSize, size)
        .duskTheme()
    }
}
#endif

#if F_FOUNDATION_UI_TESTS
import XCTest

@MainActor
final class FoundationInteractionTests: XCTestCase {
    private let configurations = [("default", "normal", "false"), ("default", "increased", "true"),
                                  ("ax3", "normal", "true"), ("ax5", "increased", "true")]
    private var output: URL {
        let request = try! String(contentsOfFile: "/tmp/sentient-visual-diff-request", encoding: .utf8).split(separator: "\n")
        return URL(fileURLWithPath: String(request[1]))
    }
    private func launch(_ scenario: String, _ config: (String, String, String)) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["F_SCENARIO": scenario, "F_SIZE": config.0,
            "F_CONTRAST": config.1, "F_REDUCE_MOTION": config.2]
        app.launch()
        XCTAssertTrue(app.staticTexts["f-count"].waitForExistence(timeout: 5))
        let request = try! String(contentsOfFile: "/tmp/sentient-visual-diff-request", encoding: .utf8)
        if request.hasPrefix("F reduced") {
            XCTAssertTrue(app.staticTexts["f-environment"].label.contains("Motion: reduced"),
                          "Verify OS preference reached the production SwiftUI environment")
        }
        return app
    }
    private func save(_ app: XCUIApplication, _ name: String, elements: [XCUIElement] = []) throws {
        try app.screenshot().pngRepresentation.write(to: output.appendingPathComponent(name + ".png"))
        try app.debugDescription.write(to: output.appendingPathComponent(name + ".ax.txt"), atomically: true, encoding: .utf8)
        let metadata: [String: Any] = [
            "origin": "production-component", "captureKind": "standalone-native-consumer",
            "runtime": ProcessInfo.processInfo.operatingSystemVersionString,
            "environmentObserved": app.staticTexts["f-environment"].label,
            "viewport": ["width": app.frame.width, "height": app.frame.height],
            "contentWidth": 320, "sourceOfAuthority": "native-adaptation-not-handoff-comparison",
            "motionTrajectoryEvidence": false
        ]
        try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys, .prettyPrinted])
            .write(to: output.appendingPathComponent(name + ".capture.json"))
        let frames = elements.map { element -> [String: Any] in
            let f = element.frame
            return ["id": element.identifier, "label": element.label, "value": element.value as? String ?? "",
                    "enabled": element.isEnabled, "x": f.minX, "y": f.minY, "width": f.width, "height": f.height]
        }
        try JSONSerialization.data(withJSONObject: frames, options: [.sortedKeys, .prettyPrinted])
            .write(to: output.appendingPathComponent(name + ".frames.json"))
    }
    private func target(_ element: XCUIElement) {
        // AX reports floating-point screen coordinates (e.g. 43.999999999999986).
        XCTAssertGreaterThanOrEqual(element.frame.width, 44 - 0.000001)
        XCTAssertGreaterThanOrEqual(element.frame.height, 44 - 0.000001)
    }
    private func callback(_ app: XCUIApplication, _ count: Int) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Callbacks: \(count)"),
                                                    object: app.staticTexts["f-count"])
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 3), .completed)
    }
    func testCaptureProductionControlsBeforeInteraction() throws {
        for config in configurations {
            for scenario in ["media", "select", "buttons", "update", "loading"] {
                let app = launch(scenario, config)
                try save(app, "rest-\(scenario)-\(config.0)-\(config.1)",
                         elements: app.buttons.allElementsBoundByIndex)
                app.terminate()
            }
        }
    }
    func testRealMediaButtonActivationAndDisabledSemantics() throws {
        for config in configurations {
            let app = launch("media", config)
            let card = app.buttons["f-media"]
            XCTAssertTrue(card.exists, "Real AX Button, not replacement static text")
            target(card)
            XCTAssertLessThanOrEqual(card.frame.width, 296 + 0.000001)
            XCTAssertLessThanOrEqual(card.frame.maxY, app.buttons["f-disabled-media"].frame.minY)
            card.tap(); callback(app, 1)
            XCTAssertFalse(app.buttons["f-disabled-media"].isEnabled)
            try save(app, "media-\(config.0)-\(config.1)", elements: [card, app.buttons["f-disabled-media"]])
            app.terminate()
        }
    }
    func testNativeMenuReflowsKeepsDisabledValueAndReturnsUsableTrigger() throws {
        for config in configurations {
            let app = launch("select", config)
            let menu = app.buttons["f-menu"]
            target(menu)
            XCTAssertEqual(menu.value as? String, "Allow after confirmation")
            menu.tap()
            let option = app.buttons["f-option-off"]
            XCTAssertTrue(option.waitForExistence(timeout: 3))
            option.tap()
            XCTAssertTrue(app.staticTexts["f-selection"].waitForExistence(timeout: 3))
            XCTAssertEqual(menu.value as? String, "Never allow this capability")
            // Native dismissal returns a usable trigger; reopening exercises
            // actual Menu routing, not an injected Binding or fake callback.
            menu.tap()
            app.buttons["f-option-allow"].tap()
            XCTAssertEqual(menu.value as? String, "Allow after confirmation")
            app.buttons["f-disable"].tap()
            XCTAssertFalse(menu.isEnabled)
            XCTAssertEqual(menu.value as? String, "Allow after confirmation")
            XCTAssertLessThanOrEqual(menu.frame.width, 296)
            try save(app, "select-\(config.0)-\(config.1)", elements: [menu])
            app.terminate()
        }
    }
    func testCanonicalFacadeAndSelectionActions() throws {
        for config in configurations {
            let app = launch("buttons", config)
            let short = app.buttons["f-short"]
            target(short); short.tap(); callback(app, 1)
            app.buttons["f-delete"].tap(); callback(app, 2)
            XCTAssertFalse(app.buttons["f-disabled"].isEnabled)
            XCTAssertFalse(app.buttons["f-loading-button"].isEnabled)
            let chip = app.buttons["f-chip"]
            if !chip.isHittable { app.swipeUp() }
            target(chip); chip.tap(); callback(app, 3)
            XCTAssertEqual(chip.value as? String, "Selected")
            let toggle = app.switches["f-toggle"]
            if !toggle.isHittable { app.swipeUp() }
            target(toggle)
            XCTAssertEqual(toggle.value as? String, "Off")
            toggle.tap()
            XCTAssertEqual(toggle.value as? String, "On")
            try save(app, "buttons-\(config.0)-\(config.1)", elements: [short, chip])
            app.terminate()
        }
    }
    func testUpdateCallbacksAndNamedLoading() throws {
        for config in configurations {
            let app = launch("update", config)
            let check = app.buttons["f-update-action"]
            target(check); check.tap(); callback(app, 1)
            XCTAssertEqual(check.label, "✓ Up to date")
            let install = app.buttons["f-install-action"]
            target(install); install.tap(); callback(app, 2)
            try save(app, "update-\(config.0)-\(config.1)", elements: [check, install])
            app.terminate()
            let loading = launch("loading", config)
            XCTAssertTrue(loading.descendants(matching: .any).matching(NSPredicate(format: "label == 'Loading audio settings'")).firstMatch.exists)
            try save(loading, "loading-\(config.0)-\(config.1)")
            loading.terminate()
        }
    }
}
#endif
