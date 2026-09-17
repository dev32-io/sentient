import MarkdownUI
import SwiftUI
import UIKit
import XCTest

@MainActor
final class MarkdownIdentityTests: XCTestCase {
    final class Model: ObservableObject {
        @Published var text: String
        init(_ text: String) { self.text = text }
    }
    final class Observation {
        var listMounts = 0
        var itemMounts = 0
        var height: CGFloat = 0
    }
    struct Content: View {
        @ObservedObject var model: Model
        let observation: Observation
        var body: some View {
            Markdown(model.text)
                .markdownBlockStyle(\.list) { configuration in
                    configuration.label.onAppear { observation.listMounts += 1 }
                }
                .markdownBlockStyle(\.listItem) { configuration in
                    configuration.label.onAppear { observation.itemMounts += 1 }
                }
                .frame(width: 340, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { observation.height = $0 }
                .frame(maxHeight: .infinity, alignment: .top)
        }
    }
    @MainActor
    final class Harness {
        let model: Model
        let observation = Observation()
        let window: UIWindow
        let host: UIHostingController<Content>
        init(_ text: String) throws {
            model = Model(text)
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 340, height: 740)
            host = UIHostingController(rootView: Content(model: model, observation: observation))
            window.rootViewController = host
            window.makeKeyAndVisible()
        }
        func update(_ text: String) { model.text = text }
        func settle() async throws {
            // Let preference/marker-width feedback finish; not a performance benchmark.
            for _ in 0..<12 {
                host.view.setNeedsLayout()
                host.view.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(20))
            }
        }
        func image() -> Data? {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(bounds: host.view.bounds, format: format).image { _ in
                host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
            }.pngData()
        }
        func close() { window.isHidden = true; window.rootViewController = nil }
    }
    func list(_ count: Int) -> String {
        (1...count).map { "\($0). **Item \($0)** with text long enough to wrap at phone width." }.joined(separator: "\n")
    }
    func testGrowingListRetainsCompletedItems() async throws {
        let harness = try Harness(list(20))
        defer { harness.close() }
        try await harness.settle()
        XCTAssertEqual(harness.observation.listMounts, 1)
        XCTAssertEqual(harness.observation.itemMounts, 20)
        for count in [21, 30, 50, 100] {
            harness.update(list(count))
            try await harness.settle()
        }
        for suffix in [" c", " contin", " continued text"] {
            harness.update(list(100) + suffix)
            try await harness.settle()
        }
        XCTAssertEqual(harness.observation.listMounts, 1, "Growing content must retain outer list subtree")
        XCTAssertEqual(harness.observation.itemMounts, 100, "Completed list items must not remount")
    }
    func testEditsAndBlockTransitionsMatchColdLayout() async throws {
        let harness = try Harness(list(9))
        defer { harness.close() }
        let cases = [
            list(10), list(100), list(20) + " continued text",
            "7. Alpha\n8. Beta\n9. Gamma",
            "1. Parent\n   1. Nested one\n   2. Nested two\n2. Other",
            "A paragraph.\n\n1. Item\n\n   Second paragraph inside item.\n\n2. Other",
            "# Changed block type\n\nParagraph instead of list.",
            "1. Replacement\n2. Different **content**",
            "Before list\n\n1. Replacement\n2. Different **content**\n\nAfter list",
            "```\n1. Not a list\n2. Plain code\n```",
            list(3), ""
        ]
        for (index, text) in cases.enumerated() {
            harness.update(text)
            try await harness.settle()
            let warmImage = harness.image()
            let cold = try Harness(text)
            try await cold.settle()
            XCTAssertEqual(harness.observation.height, cold.observation.height, accuracy: 0.5, "Case \(index)")
            XCTAssertNotNil(warmImage)
            XCTAssertEqual(warmImage, cold.image(), "Visible rendering differs from cold reference, case \(index)")
            cold.close()
        }
    }
}
