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

    private func fixture(for caseID: String) throws -> AnyView {
        let components = caseID.split(separator: "--").map(String.init)
        guard components.count == 3,
              components[0] == "action-button"
        else {
            throw XCTSkip("No iOS visual capture fixture exists yet for \(caseID)")
        }

        let role: DesignButtonRole
        let title: String
        switch components[1] {
        case "primary":
            role = .action
            title = "Allow once"
        case "secondary":
            role = .secondary
            title = "Always allow"
        case "quiet":
            role = .quiet
            title = "Not now"
        case "destructive":
            role = .destructive
            title = "Stop"
        default:
            throw XCTSkip("No iOS visual capture fixture exists yet for \(caseID)")
        }

        let isDisabled = components[2] == "disabled" || components[2] == "compact-disabled"
        let isCompact = components[2] == "compact-rest" || components[2] == "compact-disabled"
        let isSupported = components[2] == "rest"
            || components[2] == "compact-rest"
            || isDisabled
        guard isSupported else {
            throw XCTSkip("iPhone state is blocked or not applicable for \(caseID)")
        }

        return AnyView(
            ZStack {
                Color.clear
                DesignActionButton(
                    title: isDisabled ? "Unavailable" : title,
                    role: role,
                    state: isDisabled ? .disabled : .normal,
                    fillsWidth: false,
                    action: {},
                    visualHeight: isCompact ? DesignMetrics.minimumTarget : DesignMetrics.actionButtonVisualHeight
                )
            }
        )
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
