import MobileData
import SwiftUI
import UIKit
import XCTest
@testable import SentientApp

/// Uses the same opt-in, local capture request as VisualDiffCaptureTests. These
/// specimens render the production leaf with fictional identities, never auth.
@MainActor
final class HomecomingCaptureTests: XCTestCase {
    func testCaptureHomecomingLayouts() throws {
        let requestURL = URL(fileURLWithPath: "/tmp/sentient-visual-diff-request")
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: requestURL.path),
              let modified = attributes[.modificationDate] as? Date,
              modified.timeIntervalSinceNow > -1800,
              let request = try? String(contentsOf: requestURL, encoding: .utf8),
              request.hasPrefix("homecoming\n") else {
            throw XCTSkip("No homecoming visual capture request")
        }
        let lines = request.split(separator: "\n").map(String.init)
        guard lines.count == 3 else { throw XCTSkip("Invalid capture request") }
        let output = URL(fileURLWithPath: lines[1]).standardizedFileURL.resolvingSymlinksInPath()
        let allowed = URL(fileURLWithPath: lines[2]).appendingPathComponent("build/visual-captures/ios").standardizedFileURL.resolvingSymlinksInPath()
        guard output.path.hasPrefix(allowed.path + "/") else { throw XCTSkip("Output outside visual capture root") }
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let settings = ["reduceMotion": UIAccessibility.isReduceMotionEnabled,
                        "increaseContrast": UIAccessibility.isDarkerSystemColorsEnabled]
        try JSONSerialization.data(withJSONObject: settings, options: [.sortedKeys])
            .write(to: output.appendingPathComponent("settings.json"))

        for (name, state, size, type, rtl) in [
            ("picker", "picker", CGSize(width: 390, height: 760), DynamicTypeSize.large, false),
            ("pin", "pin", CGSize(width: 390, height: 760), .large, false),
            ("pin-accepted", "accepted", CGSize(width: 390, height: 760), .large, false),
            ("pin-error", "error", CGSize(width: 390, height: 760), .large, false),
            ("small-pin", "pin", CGSize(width: 375, height: 580), .large, false),
            ("large-text", "picker", CGSize(width: 390, height: 760), .accessibility3, false),
            ("rtl-pin", "pin", CGSize(width: 390, height: 760), .large, true),
            ("empty", "empty", CGSize(width: 390, height: 760), .large, false),
            ("offline", "offline", CGSize(width: 390, height: 760), .large, false)
        ] {
            let fixture = HomecomingSpecimen(state: state)
                .environment(\.dynamicTypeSize, type)
                .environment(\.layoutDirection, rtl ? .rightToLeft : .leftToRight)
                .preferredColorScheme(.dark)
            let controller = UIHostingController(rootView: fixture)
            controller.safeAreaRegions = []
            let window = UIWindow(frame: CGRect(origin: .zero, size: size))
            window.rootViewController = controller
            window.makeKeyAndVisible()
            controller.view.frame = window.bounds
            controller.view.layoutIfNeeded()
            // Capture after the source's 600ms header arrival; this is a visual
            // timeline checkpoint, not an async authentication wait/oracle.
            RunLoop.main.run(until: Date(timeIntervalSinceNow: LoginMotion.headerDuration + 0.05))
            let image = UIGraphicsImageRenderer(size: size).image { _ in
                controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
            }
            let data: Data = try XCTUnwrap(image.pngData())
            try data.write(to: output.appendingPathComponent("\(name).png"))
            window.isHidden = true
            window.rootViewController = nil
        }
    }
}

private struct HomecomingSpecimen: View {
    let state: String
    private let users = ["Ada", "Grace", "Alex", "Jamie", "Morgan", "Riley", "Sam", "Alexandra Rose"]
        .enumerated().map { index, name in
            AuthUserLite(userId: "fixture-\(index)", displayName: name, avatarTint: ["amber", "sage", "terra", "clay"][index % 4])
        }
    var body: some View {
        LoginContent(
            users: state == "empty" ? [] : users,
            selectedUser: ["pin", "accepted", "error"].contains(state) ? users[0] : nil,
            pickerState: state == "offline" ? .error("Check your connection and try again.") : state == "empty" ? .empty : .ready,
            entered: state == "accepted" ? 4 : 0,
            isSubmitting: state == "accepted",
            error: state == "error" ? "Wrong PIN" : nil,
            success: state == "accepted" ? "Pin accepted." : nil,
            feedbackRevision: state == "error" ? 1 : 0,
            onSelect: { _ in }, onBack: {}, onCancel: {}, onDigit: { _ in },
            onDelete: {}, onReload: {}, onSettings: {}
        )
    }
}
