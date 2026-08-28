import ImageIO
import SnapshotTesting
import SwiftUI
import UIKit
import XCTest
@testable import SentientApp

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
            .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
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

        let rendered = expectation(description: "Render \(caseID)")
        var image: UIImage?
        strategy.snapshot(controller).run { snapshot in
            image = snapshot
            rendered.fulfill()
        }
        wait(for: [rendered], timeout: 10)

        guard let data = image?.pngData() else {
            XCTFail("SnapshotTesting did not produce a PNG for \(caseID)")
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

    func testUnavailableVisualDiffCasesResolveToTypedMissingAuthority() {
        guard case .missingAuthority(let skip) = VisualDiffFixtureRegistry.resolve(
            caseID: "action-button--primary--hover"
        ) else {
            XCTFail("An unavailable iPhone state must resolve to missing-authority")
            return
        }
        XCTAssertEqual(skip.reason, .stateNotApplicable)
        XCTAssertEqual(skip.description, "iPhone state is blocked or not applicable for action-button--primary--hover")

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
