// Real UIKit/KMP measurements in standalone fixture, not a configured app launch.
#if T_SETTINGS_UNIT_FIXTURE
import XCTest
import SwiftUI
import UIKit
@testable import SentientApp

@MainActor final class SettingsTNativeLayoutTests: XCTestCase {
    func testNativeDocumentEditorFontCounterAndSelectableNoFetchPreview() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let driver = SettingsTDriver()
        await driver.memory.loadIfNeeded(.memory)
        await driver.prompt.load()
        for size in [DynamicTypeSize.large, .accessibility3, .accessibility5] {
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 320, height: 852)
            let editorHost = UIHostingController(rootView: MemoryScreen(viewModel: driver.memory, onBack: {}).environment(\.dynamicTypeSize, size).duskTheme())
            window.rootViewController = editorHost
            window.makeKeyAndVisible(); window.layoutIfNeeded()
            let deadline = Date().addingTimeInterval(3)
            while descendants(editorHost.view).compactMap({ $0 as? UITextView }).isEmpty && Date() < deadline { await Task.yield() }
            let editor = try XCTUnwrap(descendants(editorHost.view).compactMap { $0 as? UITextView }.first)
            XCTAssertTrue(try XCTUnwrap(editor.font).familyName.contains("JetBrains Mono"))
            XCTAssertGreaterThan(editor.font?.pointSize ?? 0, 0)
            XCTAssertTrue(editor.isEditable && editor.isSelectable)
            let rect = editor.convert(editor.bounds, to: window)
            XCTAssertGreaterThan(rect.width, 0)
            XCTAssertGreaterThanOrEqual(rect.minX, 0)
            XCTAssertLessThanOrEqual(rect.maxX, window.bounds.maxX + 1)
            let measured = ["size": String(describing: size), "windowWidth": window.bounds.width,
                            "fontFamily": editor.font!.familyName, "fontSize": editor.font!.pointSize,
                            "editorRect": [rect.minX, rect.minY, rect.width, rect.height]] as [String: Any]
            let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: measured, options: [.prettyPrinted, .sortedKeys]), uniformTypeIdentifier: "public.json")
            attachment.name = "native-mono-measurement-\(size)"; attachment.lifetime = .keepAlways; add(attachment)
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            let raster = XCTAttachment(image: image); raster.name = "native-memory-mono-\(size)"; raster.lifetime = .keepAlways; add(raster)
            window.isHidden = true
        }

        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: MessageDocumentSurface(source: driver.soul, imageCache: nil).frame(width: 280).duskTheme())
        window.rootViewController = host; window.makeKeyAndVisible(); window.layoutIfNeeded()
        defer { window.isHidden = true }
        let deadline = Date().addingTimeInterval(3)
        while descendants(host.view).compactMap({ $0 as? MessageDocumentView }).isEmpty && Date() < deadline { await Task.yield() }
        let preview = try XCTUnwrap(descendants(host.view).compactMap { $0 as? MessageDocumentView }.first)
        XCTAssertNil(preview.imageCache, "Consumer grants no image-fetch capability")
        preview.selectAll(nil); preview.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, preview.document.plain)
        XCTAssertTrue(preview.document.plain.contains("No fetch authority"))
        XCTAssertFalse(preview.selectedTextRange?.isEmpty ?? true)
        let elements = try XCTUnwrap(preview.accessibilityElements?.compactMap { $0 as? MessageReadingElement })
        let action = try XCTUnwrap(elements.flatMap { $0.accessibilityCustomActions ?? [] }.first { $0.name == "Open link: safe link" })
        var urls: [URL] = []
        preview.openLink = { urls.append($0) }
        XCTAssertTrue(action.actionHandler?(action) == true)
        XCTAssertEqual(urls.map(\.absoluteString), ["https://example.invalid"])
        UIPasteboard.general.items = []
    }

    private func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
}
#endif
