import ImageIO
import SnapshotTesting
import SwiftUI
import UIKit
import XCTest
@testable import SentientApp

private final class VisualDiffFocusWindow: UIWindow {
    override var safeAreaInsets: UIEdgeInsets { .zero }
}

private final class VisualDiffCanvasView: UIView {
    override var safeAreaInsets: UIEdgeInsets { .zero }
}

private final class VisualDiffCanvasViewController: UIViewController {
    override func loadView() {
        view = VisualDiffCanvasView()
    }
}

/// Exports one deterministic implementation PNG for the repository-local ODiff
/// feedback loop. Ordinary unit-test runs skip this test unless the capture
/// script owns a fresh, serialized request file.
final class VisualDiffCaptureTests: XCTestCase {
    func testCaptureRequestedReference() throws {
        let requestURL = URL(fileURLWithPath: "/tmp/sentient-visual-diff-request")
        guard FileManager.default.fileExists(atPath: requestURL.path) else {
            throw XCTSkip("No visual diff capture request is active")
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: requestURL.path)
        guard let modified = attributes[.modificationDate] as? Date,
              modified.timeIntervalSinceNow > -1800
        else {
            throw XCTSkip("The visual diff capture request is stale")
        }
        let request = try String(contentsOf: requestURL, encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
        guard request.count >= 3,
              !request[0].isEmpty,
              !request[1].isEmpty,
              !request[2].isEmpty
        else {
            XCTFail("The visual diff request must contain reference, output, and repository paths")
            return
        }

        let referenceURL = URL(fileURLWithPath: request[0]).resolvingSymlinksInPath().standardizedFileURL
        let outputURL = URL(fileURLWithPath: request[1]).resolvingSymlinksInPath().standardizedFileURL
        let outputRoot = URL(fileURLWithPath: request[2])
            .appendingPathComponent("build/visual-captures/ios", isDirectory: true)
            .resolvingSymlinksInPath()
            .standardizedFileURL
        guard referenceURL != outputURL,
              outputURL.path.hasPrefix(outputRoot.path + "/")
        else {
            XCTFail("Implementation output must not overwrite a designer reference")
            return
        }
        let pixelSize = try pngPixelSize(at: referenceURL)
        guard pixelSize.width.truncatingRemainder(dividingBy: 2) == 0,
              pixelSize.height.truncatingRemainder(dividingBy: 2) == 0
        else {
            XCTFail("Visual references must use the handoff's 2x canvas scale")
            return
        }

        let logicalSize = CGSize(width: pixelSize.width / 2, height: pixelSize.height / 2)
        let caseID = referenceURL.deletingPathExtension().lastPathComponent
        let fixture = try fixture(for: caseID)
            .frame(width: logicalSize.width, height: logicalSize.height)
            .environment(\.locale, Locale(identifier: "en_US_POSIX"))
            .environment(\.calendar, Calendar(identifier: .gregorian))
            .environment(\.timeZone, TimeZone(secondsFromGMT: 0) ?? .current)
            .environment(\.layoutDirection, .leftToRight)
            .environment(\.dynamicTypeSize, .large)
            .preferredColorScheme(.dark)
            .tint(DuskColors.accent)
            .transaction { transaction in
                transaction.animation = nil
                transaction.disablesAnimations = true
            }

        let traits = UITraitCollection { mutableTraits in
            mutableTraits.userInterfaceStyle = .dark
            mutableTraits.preferredContentSizeCategory = .large
            mutableTraits.displayScale = 2
        }
        let controller = UIHostingController(rootView: AnyView(fixture))
        controller.view.backgroundColor = .clear
        let strategy = Snapshotting<UIViewController, UIImage>.image(
            size: logicalSize,
            traits: traits
        )
        let usesNativeTextInputCapture =
            caseID.hasPrefix("text-field--")
                || caseID.hasPrefix("text-area--")
                || caseID.hasPrefix("search-field--")
        var focusHostWindow: VisualDiffFocusWindow?
        var focusContainer: VisualDiffCanvasViewController?
        if usesNativeTextInputCapture {
            controller.safeAreaRegions = []
            let hostWindow = VisualDiffFocusWindow(frame: CGRect(origin: .zero, size: logicalSize))
            let container = VisualDiffCanvasViewController()
            container.view.backgroundColor = .clear
            container.view.frame = hostWindow.bounds
            container.addChild(controller)
            container.view.addSubview(controller.view)
            controller.view.frame = container.view.bounds
            controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            controller.didMove(toParent: container)
            hostWindow.rootViewController = container
            hostWindow.isHidden = false
            container.beginAppearanceTransition(true, animated: false)
            container.endAppearanceTransition()
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            focusHostWindow = hostWindow
            focusContainer = container
        }
        defer {
            if let focusContainer, let focusHostWindow {
                focusContainer.beginAppearanceTransition(false, animated: false)
                controller.willMove(toParent: nil)
                controller.view.removeFromSuperview()
                controller.removeFromParent()
                controller.didMove(toParent: nil)
                focusContainer.endAppearanceTransition()
                focusHostWindow.isHidden = true
                focusHostWindow.rootViewController = nil
            }
        }
        if caseID == "text-field--filled--focus" || caseID == "search-field--placeholder--focus" {
            guard let textField = textField(in: controller.view) else {
                XCTFail("The focused text-field fixture must mount a native UITextField")
                return
            }
            if caseID == "text-field--filled--focus" {
                // Keep the native responder active without letting the simulator
                // keyboard resize the fixed visual review canvas.
                textField.inputView = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
                // Keep the genuine native focus while applying the same
                // non-content capture treatment as the text-field report.
                textField.tintColor = .clear
            }
            XCTAssertTrue(textField.becomeFirstResponder(), "The focused fixture must accept native focus")
            let focused = XCTNSPredicateExpectation(
                predicate: NSPredicate { [weak controller] _, _ in
                    guard let controller else { return false }
                    return self.firstResponder(in: controller.view) != nil
                },
                object: nil
            )
            wait(for: [focused], timeout: 2)
            XCTAssertTrue(textField.isFirstResponder, "The focused text-field fixture must hold native focus")
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
        } else if caseID == "text-area--filled--focus" {
            guard let textView = textView(in: controller.view) else {
                XCTFail("The focused text-area fixture must mount a native UITextView")
                return
            }
            // Keep the native responder active without presenting a keyboard or
            // caret in the fixed visual review canvas.
            textView.inputView = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
            textView.tintColor = .clear
            XCTAssertTrue(textView.becomeFirstResponder(), "The focused fixture must accept native focus")
            let focused = XCTNSPredicateExpectation(
                predicate: NSPredicate { [weak controller] _, _ in
                    guard let controller else { return false }
                    return self.firstResponder(in: controller.view) != nil
                },
                object: nil
            )
            wait(for: [focused], timeout: 2)
            XCTAssertTrue(textView.isFirstResponder, "The focused text-area fixture must hold native focus")
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
        }

        let rendered = expectation(description: "Render \(caseID)")
        var image: UIImage?
        if usesNativeTextInputCapture {
            // The handoff PNGs are standard-sRGB references. Keep the native
            // view unchanged, but prevent the simulator's automatic Display-P3
            // renderer from changing the encoded comparison colors.
            let format = UIGraphicsImageRendererFormat(for: traits)
            format.preferredRange = .standard
            image = UIGraphicsImageRenderer(bounds: controller.view.bounds, format: format).image { context in
                controller.view.layer.render(in: context.cgContext)
            }
            rendered.fulfill()
        } else {
            strategy.snapshot(controller).run { snapshot in
                image = snapshot
                rendered.fulfill()
            }
        }
        wait(for: [rendered], timeout: 10)

        guard let data = image?.pngData() else {
            XCTFail("Visual diff capture did not produce a PNG for \(caseID)")
            return
        }
        try FileManager.default.createDirectory(
            at: outputURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: outputURL, options: .atomic)

        guard let captured = image else { return }
        XCTAssertEqual(captured.size, logicalSize)
        XCTAssertEqual(captured.scale, 2)
    }

    func testActionButtonRegistryPreservesCurrentCaseApplicability() {
        let expectedSupported = Set([
            "action-button--destructive--compact-rest",
            "action-button--destructive--rest",
            "action-button--primary--compact-rest",
            "action-button--primary--rest",
            "action-button--quiet--compact-rest",
            "action-button--quiet--rest",
            "action-button--secondary--compact-disabled",
            "action-button--secondary--compact-rest",
            "action-button--secondary--disabled",
            "action-button--secondary--rest",
        ])
        let expectedMissingAuthority = Set([
            "action-button--destructive--focus",
            "action-button--destructive--hover",
            "action-button--destructive--pressed",
            "action-button--primary--focus",
            "action-button--primary--hover",
            "action-button--primary--pressed",
            "action-button--quiet--focus",
            "action-button--quiet--hover",
            "action-button--quiet--pressed",
            "action-button--secondary--focus",
            "action-button--secondary--hover",
            "action-button--secondary--pressed",
        ])
        let registrations = VisualDiffFixtureRegistry.registrations(for: "action-button")
        let actualCaseIDs = Set(registrations.map { $0.fixture.caseID })
        XCTAssertEqual(actualCaseIDs, expectedSupported.union(expectedMissingAuthority))
        XCTAssertEqual(
            Set(registrations.filter { $0.applicability == .supported }.map { $0.fixture.caseID }),
            expectedSupported
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateNotApplicable)
            }.map { $0.fixture.caseID }),
            expectedMissingAuthority
        )
        XCTAssertNil(
            VisualDiffFixtureRegistry.actionButtonRenderConfiguration(
                for: "action-button--primary--hover"
            )
        )
    }

    func testActionButtonRegistryPreservesCurrentRenderMappings() {
        let expected: [(String, String, String, DesignControlState, CGFloat)] = [
            ("action-button--primary--rest", "primary", "Allow once", .normal, DesignMetrics.actionButtonVisualHeight),
            ("action-button--primary--compact-rest", "primary", "Allow once", .normal, DesignMetrics.minimumTarget),
            ("action-button--secondary--rest", "secondary", "Always allow", .normal, DesignMetrics.actionButtonVisualHeight),
            ("action-button--secondary--compact-rest", "secondary", "Always allow", .normal, DesignMetrics.minimumTarget),
            ("action-button--secondary--disabled", "secondary", "Unavailable", .disabled, DesignMetrics.actionButtonVisualHeight),
            ("action-button--secondary--compact-disabled", "secondary", "Unavailable", .disabled, DesignMetrics.minimumTarget),
            ("action-button--quiet--rest", "quiet", "Not now", .normal, DesignMetrics.actionButtonVisualHeight),
            ("action-button--quiet--compact-rest", "quiet", "Not now", .normal, DesignMetrics.minimumTarget),
            ("action-button--destructive--rest", "destructive", "Stop", .normal, DesignMetrics.actionButtonVisualHeight),
            ("action-button--destructive--compact-rest", "destructive", "Stop", .normal, DesignMetrics.minimumTarget),
        ]

        for (caseID, roleID, title, state, visualHeight) in expected {
            guard let configuration = VisualDiffFixtureRegistry.actionButtonRenderConfiguration(for: caseID) else {
                XCTFail("Missing action-button render configuration for \(caseID)")
                continue
            }
            XCTAssertEqual(configuration.roleID, roleID, caseID)
            XCTAssertEqual(configuration.title, title, caseID)
            XCTAssertEqual(configuration.state, state, caseID)
            XCTAssertEqual(configuration.fillsWidth, false, caseID)
            XCTAssertEqual(configuration.visualHeight, visualHeight, caseID)
        }
    }

    func testIconButtonRegistryPreservesApprovedCasesAndApplicability() {
        let expectedSupported = Set([
            "icon-button--default--compact-disabled",
            "icon-button--default--compact-rest",
            "icon-button--default--disabled",
            "icon-button--default--rest",
            "icon-button--quiet--compact-rest",
            "icon-button--quiet--rest",
            "icon-button--destructive--compact-rest",
            "icon-button--destructive--rest",
        ])
        let expectedHover = Set([
            "icon-button--default--hover",
            "icon-button--quiet--hover",
            "icon-button--destructive--hover",
        ])
        let expectedInteractionStates = Set([
            "icon-button--default--focus",
            "icon-button--default--pressed",
            "icon-button--quiet--focus",
            "icon-button--quiet--pressed",
            "icon-button--destructive--focus",
            "icon-button--destructive--pressed",
        ])
        let registrations = VisualDiffFixtureRegistry.registrations(for: "icon-button")
        let actualCaseIDs = Set(registrations.map { $0.fixture.caseID })
        XCTAssertEqual(actualCaseIDs, expectedSupported.union(expectedHover).union(expectedInteractionStates))
        XCTAssertEqual(
            Set(registrations.filter { $0.applicability == .supported }.map { $0.fixture.caseID }),
            expectedSupported
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateNotApplicable)
            }.map { $0.fixture.caseID }),
            expectedHover
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateRequiresInteraction)
            }.map { $0.fixture.caseID }),
            expectedInteractionStates
        )
    }

    func testIconButtonRegistryPreservesNativeRoleStateAndCompactAdaptation() {
        let expected: [(String, String, DesignButtonRole, DesignControlState, Bool, String, String)] = [
            ("icon-button--default--rest", "default", .secondary, .normal, false, "plus", "Add item"),
            ("icon-button--default--compact-rest", "default", .secondary, .normal, true, "plus", "Add item"),
            ("icon-button--default--disabled", "default", .secondary, .disabled, false, "minus", "Unavailable action"),
            ("icon-button--default--compact-disabled", "default", .secondary, .disabled, true, "minus", "Unavailable action"),
            ("icon-button--quiet--rest", "quiet", .quiet, .normal, false, "ellipsis", "More options"),
            ("icon-button--quiet--compact-rest", "quiet", .quiet, .normal, true, "ellipsis", "More options"),
            ("icon-button--destructive--rest", "destructive", .destructive, .normal, false, "multiply", "Delete item"),
            ("icon-button--destructive--compact-rest", "destructive", .destructive, .normal, true, "multiply", "Delete item"),
        ]

        for (caseID, roleID, role, state, compact, systemName, label) in expected {
            guard let configuration = VisualDiffFixtureRegistry.iconButtonRenderConfiguration(for: caseID) else {
                XCTFail("Missing icon-button render configuration for \(caseID)")
                continue
            }
            XCTAssertEqual(configuration.roleID, roleID, caseID)
            XCTAssertEqual(configuration.role, role, caseID)
            XCTAssertEqual(configuration.state, state, caseID)
            XCTAssertEqual(configuration.compact, compact, caseID)
            XCTAssertEqual(configuration.systemName, systemName, caseID)
            XCTAssertEqual(configuration.label, label, caseID)
        }
        XCTAssertNil(
            VisualDiffFixtureRegistry.iconButtonRenderConfiguration(
                for: "icon-button--default--hover"
            )
        )
        XCTAssertNil(
            VisualDiffFixtureRegistry.iconButtonRenderConfiguration(
                for: "icon-button--default--pressed"
            )
        )
    }

    func testCheckboxRegistryPreservesApprovedCasesAndApplicability() {
        let expectedSupported = Set([
            "checkbox--checked--rest",
            "checkbox--disabled--rest",
            "checkbox--unchecked--rest",
        ])
        let expectedInteractionStates = Set([
            "checkbox--checked--focus",
            "checkbox--checked--pressed",
            "checkbox--unchecked--focus",
            "checkbox--unchecked--pressed",
        ])
        let expectedUnavailableStates = Set([
            "checkbox--checked--hover",
            "checkbox--mixed--focus",
            "checkbox--mixed--hover",
            "checkbox--mixed--pressed",
            "checkbox--mixed--rest",
            "checkbox--unchecked--hover",
        ])
        let registrations = VisualDiffFixtureRegistry.registrations(for: "checkbox")
        let actualCaseIDs = Set(registrations.map { $0.fixture.caseID })
        XCTAssertEqual(
            actualCaseIDs,
            expectedSupported.union(expectedInteractionStates).union(expectedUnavailableStates)
        )
        XCTAssertEqual(
            Set(registrations.filter { $0.applicability == .supported }.map { $0.fixture.caseID }),
            expectedSupported
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateRequiresInteraction)
            }.map { $0.fixture.caseID }),
            expectedInteractionStates
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateNotApplicable)
            }.map { $0.fixture.caseID }),
            expectedUnavailableStates
        )
    }

    func testCheckboxRegistryPreservesNativeStateMappings() {
        let expected: [(String, String, Bool, Bool)] = [
            ("checkbox--unchecked--rest", "Not selected", false, true),
            ("checkbox--checked--rest", "Selected", true, true),
            ("checkbox--disabled--rest", "Unavailable", false, false),
        ]

        for (caseID, title, isOn, isEnabled) in expected {
            guard let configuration = VisualDiffFixtureRegistry.checkboxRenderConfiguration(for: caseID) else {
                XCTFail("Missing checkbox render configuration for \(caseID)")
                continue
            }
            XCTAssertEqual(configuration.title, title, caseID)
            XCTAssertEqual(configuration.isOn, isOn, caseID)
            XCTAssertEqual(configuration.isEnabled, isEnabled, caseID)
        }
        XCTAssertNil(
            VisualDiffFixtureRegistry.checkboxRenderConfiguration(
                for: "checkbox--mixed--rest"
            )
        )
    }

    func testTextFieldRegistryPreservesApprovedCasesAndApplicability() {
        let expectedSupported = Set([
            "text-field--filled--focus",
            "text-field--filled--rest",
        ])
        let expectedMissingAuthority = Set([
            "text-field--filled--disabled",
            "text-field--filled--empty",
            "text-field--filled--error",
            "text-field--filled--hover",
            "text-field--filled--loading",
            "text-field--filled--pressed",
            "text-field--filled--selected",
        ])
        let registrations = VisualDiffFixtureRegistry.registrations(for: "text-field")
        let actualCaseIDs = Set(registrations.map { $0.fixture.caseID })
        XCTAssertEqual(actualCaseIDs, expectedSupported.union(expectedMissingAuthority))
        XCTAssertEqual(
            Set(registrations.filter { $0.applicability == .supported }.map { $0.fixture.caseID }),
            expectedSupported
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateNotApplicable)
            }.map { $0.fixture.caseID }),
            expectedMissingAuthority
        )
        XCTAssertEqual(
            registrations.first { $0.fixture.stateID == "hover" }?.applicability,
            .missingAuthority(.stateNotApplicable)
        )
    }

    func testTextFieldRegistryPreservesNativeConfigurationAndFocusMapping() {
        let expected: [(String, String, String, Bool)] = [
            ("text-field--filled--rest", "Display name", "Maya Chen", false),
            ("text-field--filled--focus", "Display name", "Maya Chen", true),
        ]

        for (caseID, title, value, shouldFocus) in expected {
            guard let configuration = VisualDiffFixtureRegistry.textFieldRenderConfiguration(for: caseID) else {
                XCTFail("Missing text-field render configuration for \(caseID)")
                continue
            }
            XCTAssertEqual(configuration.title, title, caseID)
            XCTAssertEqual(configuration.value, value, caseID)
            XCTAssertEqual(configuration.shouldFocus, shouldFocus, caseID)
        }
        XCTAssertNil(
            VisualDiffFixtureRegistry.textFieldRenderConfiguration(
                for: "text-field--filled--hover"
            )
        )
    }

    func testSearchFieldRegistryPreservesApprovedCasesAndApplicability() {
        let expectedSupported = Set([
            "search-field--placeholder--focus",
            "search-field--placeholder--rest",
        ])
        let expectedMissingAuthority = Set([
            "search-field--placeholder--clear",
            "search-field--placeholder--disabled",
            "search-field--placeholder--error",
            "search-field--placeholder--filled",
            "search-field--placeholder--hover",
            "search-field--placeholder--loading",
            "search-field--placeholder--pressed",
            "search-field--placeholder--reduced-motion",
            "search-field--placeholder--selected",
        ])
        let registrations = VisualDiffFixtureRegistry.registrations(for: "search-field")
        let actualCaseIDs = Set(registrations.map { $0.fixture.caseID })
        XCTAssertEqual(actualCaseIDs, expectedSupported.union(expectedMissingAuthority))
        XCTAssertEqual(
            Set(registrations.filter { $0.applicability == .supported }.map { $0.fixture.caseID }),
            expectedSupported
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateNotApplicable)
            }.map { $0.fixture.caseID }),
            expectedMissingAuthority
        )
    }

    func testSearchFieldRegistryPreservesNativeConfigurationAndFocusMapping() {
        let expected: [(String, String, String, String, Bool)] = [
            ("search-field--placeholder--rest", "Search", "Search conversations", "", false),
            ("search-field--placeholder--focus", "Search", "Search conversations", "", true),
        ]

        for (caseID, title, prompt, value, shouldFocus) in expected {
            guard let configuration = VisualDiffFixtureRegistry.searchFieldRenderConfiguration(for: caseID) else {
                XCTFail("Missing search-field render configuration for \(caseID)")
                continue
            }
            XCTAssertEqual(configuration.title, title, caseID)
            XCTAssertEqual(configuration.prompt, prompt, caseID)
            XCTAssertEqual(configuration.value, value, caseID)
            XCTAssertEqual(configuration.shouldFocus, shouldFocus, caseID)
        }
        XCTAssertNil(
            VisualDiffFixtureRegistry.searchFieldRenderConfiguration(
                for: "search-field--placeholder--hover"
            )
        )
    }

    func testChipRegistryPreservesApprovedCasesAndApplicability() {
        let expectedSupported = Set([
            "chip--selected--compact-rest",
            "chip--selected--rest",
            "chip--unselected--compact-rest",
            "chip--unselected--rest",
        ])
        let expectedHover = Set([
            "chip--selected--hover",
            "chip--unselected--hover",
        ])
        let expectedInteractionStates = Set([
            "chip--selected--focus",
            "chip--selected--pressed",
            "chip--unselected--focus",
            "chip--unselected--pressed",
        ])
        let registrations = VisualDiffFixtureRegistry.registrations(for: "chip")
        let actualCaseIDs = Set(registrations.map { $0.fixture.caseID })
        XCTAssertEqual(actualCaseIDs, expectedSupported.union(expectedHover).union(expectedInteractionStates))
        XCTAssertEqual(
            Set(registrations.filter { $0.applicability == .supported }.map { $0.fixture.caseID }),
            expectedSupported
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateNotApplicable)
            }.map { $0.fixture.caseID }),
            expectedHover
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateRequiresInteraction)
            }.map { $0.fixture.caseID }),
            expectedInteractionStates
        )
    }

    func testChipRegistryPreservesNativeSelectionAndCompactAdaptation() {
        let expected: [(String, String, Bool, Bool)] = [
            ("chip--selected--rest", "Family", true, false),
            ("chip--selected--compact-rest", "Family", true, true),
            ("chip--unselected--rest", "School", false, false),
            ("chip--unselected--compact-rest", "School", false, true),
        ]

        for (caseID, title, selected, compact) in expected {
            guard let configuration = VisualDiffFixtureRegistry.chipRenderConfiguration(for: caseID) else {
                XCTFail("Missing chip render configuration for \(caseID)")
                continue
            }
            XCTAssertEqual(configuration.title, title, caseID)
            XCTAssertEqual(configuration.selected, selected, caseID)
            XCTAssertEqual(configuration.compact, compact, caseID)
        }
        XCTAssertNil(
            VisualDiffFixtureRegistry.chipRenderConfiguration(
                for: "chip--selected--hover"
            )
        )
    }

    func testRangeRegistryPreservesApprovedCasesAndApplicability() {
        let expectedSupported = Set([
            "range--62--disabled",
            "range--62--rest",
        ])
        let expectedNotApplicable = Set([
            "range--62--hover",
        ])
        let expectedInteractionStates = Set([
            "range--62--focus",
        ])
        let registrations = VisualDiffFixtureRegistry.registrations(for: "range")
        let actualCaseIDs = Set(registrations.map { $0.fixture.caseID })
        XCTAssertEqual(
            actualCaseIDs,
            expectedSupported.union(expectedNotApplicable).union(expectedInteractionStates)
        )
        XCTAssertEqual(
            Set(registrations.filter { $0.applicability == .supported }.map { $0.fixture.caseID }),
            expectedSupported
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateNotApplicable)
            }.map { $0.fixture.caseID }),
            expectedNotApplicable
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateRequiresInteraction)
            }.map { $0.fixture.caseID }),
            expectedInteractionStates
        )
    }

    func testRangeRegistryPreservesNativeValueAndDisabledMapping() {
        let expected: [(String, Bool)] = [
            ("range--62--rest", true),
            ("range--62--disabled", false),
        ]

        for (caseID, isEnabled) in expected {
            guard let configuration = VisualDiffFixtureRegistry.sliderRenderConfiguration(for: caseID) else {
                XCTFail("Missing range render configuration for \(caseID)")
                continue
            }
            XCTAssertEqual(configuration.title, "Interface scale", caseID)
            XCTAssertEqual(configuration.value, 62, caseID)
            XCTAssertEqual(configuration.range, 0...100, caseID)
            XCTAssertEqual(configuration.step, 1, caseID)
            XCTAssertEqual(configuration.format(configuration.value), "62%", caseID)
            XCTAssertEqual(configuration.isEnabled, isEnabled, caseID)
        }
        XCTAssertNil(
            VisualDiffFixtureRegistry.sliderRenderConfiguration(
                for: "range--62--hover"
            )
        )
        XCTAssertNil(
            VisualDiffFixtureRegistry.sliderRenderConfiguration(
                for: "range--62--focus"
            )
        )
    }

    func testPlateRegistryPreservesApprovedCasesAndApplicability() {
        let expectedSupported = Set([
            "plate--default--compact-rest",
            "plate--default--rest",
        ])
        let expectedNotApplicable = Set([
            "plate--default--disabled",
            "plate--default--error",
            "plate--default--focus",
            "plate--default--hover",
            "plate--default--loading",
            "plate--default--pressed",
            "plate--default--selected",
        ])
        let registrations = VisualDiffFixtureRegistry.registrations(for: "plate")
        let actualCaseIDs = Set(registrations.map { $0.fixture.caseID })
        XCTAssertEqual(actualCaseIDs, expectedSupported.union(expectedNotApplicable))
        XCTAssertEqual(
            Set(registrations.filter { $0.applicability == .supported }.map { $0.fixture.caseID }),
            expectedSupported
        )
        XCTAssertEqual(
            Set(registrations.filter {
                $0.applicability == .missingAuthority(.stateNotApplicable)
            }.map { $0.fixture.caseID }),
            expectedNotApplicable
        )
    }

    func testPlateRegistryPreservesCompactNativeLayoutAdaptation() {
        let expected: [(String, Bool, CGFloat)] = [
            ("plate--default--rest", false, Space.lg),
            ("plate--default--compact-rest", true, 14),
        ]

        for (caseID, compact, horizontalPadding) in expected {
            guard let configuration = VisualDiffFixtureRegistry.plateRenderConfiguration(for: caseID) else {
                XCTFail("Missing plate render configuration for \(caseID)")
                continue
            }
            XCTAssertEqual(configuration.compact, compact, caseID)
            XCTAssertEqual(configuration.horizontalPadding, horizontalPadding, caseID)
        }
        XCTAssertNil(
            VisualDiffFixtureRegistry.plateRenderConfiguration(
                for: "plate--default--hover"
            )
        )
    }

    func testUserAvatarRegistryPreservesApprovedCasesAndMappings() throws {
        let expected: [(String, String, String, CGFloat, DesignUserAvatarTint, Bool, Bool, Bool)] = [
            ("user-avatar--amber-44--rest", "Jordan Chen", "J", 44, .amber, false, false, false),
            ("user-avatar--clay-44--rest", "Riley Chen", "R", 44, .clay, false, false, false),
            ("user-avatar--fallback-44--rest", "Unknown user", "?", 44, .fallback, false, false, true),
            ("user-avatar--sage-44--rest", "Alex Chen", "A", 44, .sage, false, false, false),
            ("user-avatar--terra-28--rest", "Maya Chen", "M", 28, .terra, false, false, false),
            ("user-avatar--terra-44--disabled", "Maya Chen", "M", 44, .terra, false, true, false),
            ("user-avatar--terra-44--rest", "Maya Chen", "M", 44, .terra, false, false, false),
            ("user-avatar--terra-44--selected", "Maya Chen", "M", 44, .terra, true, false, false),
            ("user-avatar--terra-56--rest", "Maya Chen", "M", 56, .terra, false, false, false),
        ]

        let registrations = VisualDiffFixtureRegistry.registrations(for: "user-avatar")
        XCTAssertEqual(
            Set(registrations.map { $0.fixture.caseID }),
            Set(expected.map { $0.0 })
        )
        XCTAssertTrue(registrations.allSatisfy { $0.applicability == .supported })

        for (caseID, name, initial, size, tint, selected, disabled, fallback) in expected {
            guard let configuration = VisualDiffFixtureRegistry.userAvatarRenderConfiguration(for: caseID) else {
                XCTFail("Missing user-avatar render configuration for \(caseID)")
                continue
            }
            XCTAssertEqual(configuration.name, name, caseID)
            XCTAssertEqual(configuration.initial, initial, caseID)
            XCTAssertEqual(configuration.size, size, caseID)
            XCTAssertEqual(configuration.tint, tint, caseID)
            XCTAssertEqual(configuration.selected, selected, caseID)
            XCTAssertEqual(configuration.disabled, disabled, caseID)
            XCTAssertEqual(configuration.fallback, fallback, caseID)

            guard case .supported(let adapter, let fixture) = VisualDiffFixtureRegistry.resolve(caseID: caseID) else {
                XCTFail("Approved user-avatar case must resolve to a supported fixture: \(caseID)")
                continue
            }
            XCTAssertNoThrow(try adapter.makeFixture(for: fixture), caseID)
        }

        guard case .missingAuthority(let unavailable) = VisualDiffFixtureRegistry.resolve(
            caseID: "user-avatar--terra-44--hover"
        ) else {
            XCTFail("Unapproved user-avatar interaction state must remain missing authority")
            return
        }
        XCTAssertEqual(unavailable.reason, .unknownCase)
    }

    func testUnavailableVisualDiffCasesResolveToTypedMissingAuthority() {
        guard case .missingAuthority(let skip) = VisualDiffFixtureRegistry.resolve(
            caseID: "action-button--primary--hover"
        ) else {
            XCTFail("An unavailable iPhone state must resolve to missing-authority")
            return
        }
        XCTAssertEqual(skip.reason, .stateNotApplicable)
        XCTAssertEqual(skip.description, "iPhone state is blocked or not applicable for action-button--primary--hover")

        guard case .missingAuthority(let interaction) = VisualDiffFixtureRegistry.resolve(
            caseID: "icon-button--default--pressed"
        ) else {
            XCTFail("A static iPhone press must remain explicitly unavailable")
            return
        }
        XCTAssertEqual(interaction.reason, .stateRequiresInteraction)
        XCTAssertEqual(
            interaction.description,
            "iPhone static capture cannot hold native interaction state for icon-button--default--pressed"
        )

        guard case .missingAuthority(let mixed) = VisualDiffFixtureRegistry.resolve(
            caseID: "checkbox--mixed--rest"
        ) else {
            XCTFail("A mixed checkbox capture must remain behind an authoritative state owner")
            return
        }
        XCTAssertEqual(mixed.reason, .stateNotApplicable)
        XCTAssertEqual(
            mixed.description,
            "iPhone state is blocked or not applicable for checkbox--mixed--rest"
        )

        guard case .missingAuthority(let unknown) = VisualDiffFixtureRegistry.resolve(
            caseID: "future-component--default--rest"
        ) else {
            XCTFail("An unregistered component must resolve to missing-authority")
            return
        }
        XCTAssertEqual(unknown.reason, .unknownComponent)
        XCTAssertEqual(unknown.description, "No iOS visual capture fixture exists yet for future-component--default--rest")
    }

    private func fixture(for caseID: String) throws -> AnyView {
        switch VisualDiffFixtureRegistry.resolve(caseID: caseID) {
        case .supported(let adapter, let fixture):
            return try adapter.makeFixture(for: fixture)
        case .missingAuthority(let skip):
            throw XCTSkip(skip.description)
        }
    }

    private func textField(in view: UIView) -> UITextField? {
        if let textField = view as? UITextField { return textField }
        for subview in view.subviews {
            if let textField = textField(in: subview) { return textField }
        }
        return nil
    }

    private func textView(in view: UIView) -> UITextView? {
        if let textView = view as? UITextView { return textView }
        for subview in view.subviews {
            if let textView = textView(in: subview) { return textView }
        }
        return nil
    }

    private func firstResponder(in view: UIView) -> UIView? {
        if view.isFirstResponder { return view }
        for subview in view.subviews {
            if let responder = firstResponder(in: subview) { return responder }
        }
        return nil
    }

    private func pngPixelSize(at url: URL) throws -> CGSize {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
        else {
            throw NSError(
                domain: "VisualDiffCaptureTests",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Unable to read PNG dimensions at \(url.path)"]
            )
        }
        return CGSize(width: width.doubleValue, height: height.doubleValue)
    }
}
