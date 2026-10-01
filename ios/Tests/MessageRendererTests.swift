import XCTest
import UIKit
import SwiftUI
@testable import SentientApp

@MainActor
final class MessageRendererTests: XCTestCase {
    private let source = "Before café 👩🏽‍💻.\n\n| Name | Observation | Value |\n| --- | --- | --- |\n| Alpha | partial 👩🏽‍💻 text e\u{301} | 42 \\| units |\n| Beta | A readable long column that must keep its horizontal offset | 7\\\\8 |\n\nBetween שלום مرحبا.\n\n| Left | Right |\n| --- | --- |\n| wide wide wide wide | another independently wide cell |\n\nAfter table."

    func testSameLayoutMultiTableCopyAndRecycledState() throws {
        let state = MessageDocumentState(source: source)
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 280, height: 1000))
        view.state = state
        view.rebuild()
        let measured = state.measure(width: 280, traits: view.traitCollection)
        XCTAssertTrue(measured.bodyFont.familyName.contains("DM Sans"))
        XCTAssertTrue(state.layout === measured)
        XCTAssertEqual(view.measuredHeight, measured.height)
        let tables = measured.tables
        XCTAssertEqual(tables.count, 2)
        view.activateTable(at: CGPoint(x: 10, y: tables[0].rect.midY))
        view.setTableOffset(70)
        let firstOffset = view.tableOffset
        view.activateTable(at: CGPoint(x: 10, y: tables[1].rect.midY))
        view.setTableOffset(30)
        XCTAssertEqual(view.tableOffset(id: tables[0].id), firstOffset)
        XCTAssertEqual(view.tableOffset(id: tables[1].id), 30)
        let plain = view.document.plain as NSString
        let start = plain.range(of: "partial").location
        let end = NSMaxRange(plain.range(of: "Between שלום مرحبا."))
        let selection = NSRange(location: start, length: end - start)
        view.selectedTextRange = MessageTextRange(selection)
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, "partial 👩🏽‍💻 text e\u{301}\t42 | units\nBeta\tA readable long column that must keep its horizontal offset\t7\\8\nBetween שלום مرحبا.")
        view.copyTableMarkdown(id: tables[1].id)
        XCTAssertEqual(UIPasteboard.general.string, "| Left | Right |\n| --- | --- |\n| wide wide wide wide | another independently wide cell |")

        // Source unchanged when terminal status changes: no layout replacement.
        state.update(source: source, literal: false)
        XCTAssertTrue(state.measure(width: 280, traits: view.traitCollection) === measured)
        let recycled = MessageDocumentView(frame: view.frame)
        recycled.state = state
        recycled.rebuild()
        XCTAssertTrue(recycled.state.layout === measured)
        XCTAssertEqual((recycled.selectedTextRange as? MessageTextRange)?.value, selection)
        XCTAssertEqual(recycled.tableOffset(id: tables[0].id), firstOffset)
        XCTAssertEqual(recycled.tableOffset(id: tables[1].id), 30)
        recycled.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, view.document.plain(in: selection))
    }

    func testCanonicalTableControlsFitAndRetainIdentityOutsideText() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        window.rootViewController = controller
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 180, height: 2000))
        controller.view.addSubview(view)
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        view.frame.origin.y = window.safeAreaInsets.top
        defer { window.isHidden = true }
        view.update(source: source, literal: false)
        let controls = view.subviews.filter { $0 is any UIContentView }
        XCTAssertEqual(controls.count, 2)
        let regularHeight = try XCTUnwrap(view.state.layout?.tables.first?.toolsRect.height)
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            view.traitOverrides.preferredContentSizeCategory = category
            view.updateTraitsIfNeeded()
            view.rebuild()
            XCTAssertEqual(view.traitCollection.preferredContentSizeCategory, category)
            let layout = try XCTUnwrap(view.state.layout)
            if category == .accessibilityExtraExtraExtraLarge {
                XCTAssertGreaterThan(layout.tables[0].toolsRect.height, regularHeight)
            }
            XCTAssertEqual(view.subviews.filter { $0 is any UIContentView }.map(ObjectIdentifier.init), controls.map(ObjectIdentifier.init))
            var fittedVisibleControls = 0
            for (control, table) in zip(controls, layout.tables) {
                XCTAssertTrue(control.superview === view)
                XCTAssertEqual(control.frame, table.toolsRect)
                XCTAssertGreaterThanOrEqual(control.frame.height, 44)
                // UIKit's intrinsic fitting includes inherited screen insets
                // for offscreen views. Fit visible controls in the real window.
                if window.safeAreaLayoutGuide.layoutFrame.contains(control.convert(control.bounds, to: window)) {
                    let fitting = control.systemLayoutSizeFitting(
                        CGSize(width: table.toolsRect.width, height: 0),
                        withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel
                    )
                    XCTAssertLessThanOrEqual(fitting.height, table.toolsRect.height + 1)
                    fittedVisibleControls += 1
                }
                XCTAssertLessThanOrEqual(table.toolsRect.maxY, table.rect.minY)
            }
            XCTAssertGreaterThan(fittedVisibleControls, 0)
            view.selectAll(nil)
            view.copy(nil)
            XCTAssertEqual(Data((UIPasteboard.general.string ?? "").utf8), Data(view.document.plain.utf8))
            XCTAssertFalse(view.document.plain.contains("Copy table"))
        }
    }

    func testSyntaxReinterpretationBidiAndGeometryUseActualCTLines() throws {
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 300, height: 500))
        view.update(source: "**café 👩🏽‍💻", literal: false)
        view.selectedTextRange = MessageTextRange((view.document.plain as NSString).range(of: "café 👩🏽‍💻"))
        view.update(source: "**café 👩🏽‍💻**", literal: false)
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, "café 👩🏽‍💻")
        view.update(source: "English שלום مرحبا café e\u{301} 👩🏽‍💻", literal: true)
        view.selectAll(nil)
        let range = try XCTUnwrap(view.selectedTextRange)
        let rectangles = view.selectionRects(for: range)
        XCTAssertTrue(rectangles.contains { $0.writingDirection == .rightToLeft })
        XCTAssertTrue(rectangles.contains { $0.writingDirection == .leftToRight })
        XCTAssertTrue(rectangles.allSatisfy { !$0.rect.isEmpty })
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, view.document.source)
        let emoji = (view.document.plain as NSString).range(of: "👩🏽‍💻")
        let caret = view.caretRect(for: MessageTextPosition(emoji.location))
        let hit = try XCTUnwrap(view.closestPosition(to: CGPoint(x: caret.minX + 0.1, y: caret.midY)) as? MessageTextPosition)
        XCTAssertEqual(view.document.graphemeBoundary(hit.index), hit.index)
        view.frame.size.width = 220
        view.traitOverrides.preferredContentSizeCategory = .accessibilityExtraLarge
        view.rebuild()
        XCTAssertEqual((view.selectedTextRange as? MessageTextRange)?.value, (range as? MessageTextRange)?.value)
        XCTAssertTrue(view.measuredHeight > 0)
    }
    func testAccessibleLinksIndependentTablesAndControlledImageArrival() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        let view = MessageDocumentView(frame: CGRect(x: 12, y: 60, width: 280, height: 700))
        let loader = DelayedImageLoader()
        let url = URL(string: "https://fixture.invalid/accessible.png")!
        view.imageCache = MarkdownImageCache(loader: loader)
        view.update(source: "[Safe link](https://example.invalid/path)\n\n![Controlled photo](\(url.absoluteString))\n\n| Name | Value |\n| --- | --- |\n| café | 42 |\n\n| Other | Value |\n| --- | --- |\n| 東京 | 7 |", literal: false)
        controller.view.addSubview(view)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        defer { window.isHidden = true }
        let layout = try XCTUnwrap(view.state.layout)
        let height = view.measuredHeight
        let elements = try XCTUnwrap(view.accessibilityElements?.compactMap { $0 as? MessageReadingElement })
        let link = try XCTUnwrap(elements.first { $0.accessibilityLabel == "Safe link" })
        let action = try XCTUnwrap(link.accessibilityCustomActions?.first)
        var opened: URL?
        view.openLink = { opened = $0 }
        XCTAssertTrue(action.actionHandler?(action) == true)
        XCTAssertEqual(opened?.absoluteString, "https://example.invalid/path")
        let picture = try XCTUnwrap(elements.first { $0.imageFrame != nil })
        XCTAssertEqual(picture.accessibilityLabel, "Controlled photo")
        XCTAssertEqual(picture.accessibilityValue, "Loading image")
        XCTAssertFalse(picture.accessibilityFrame.isEmpty)
        XCTAssertEqual(Set(elements.compactMap(\.tableID)).count, 2)
        for id in Set(elements.compactMap(\.tableID)) {
            let cell = try XCTUnwrap(elements.first { $0.tableID == id })
            let copy = try XCTUnwrap(cell.accessibilityCustomActions?.first { $0.name == "Copy table as Markdown" })
            XCTAssertTrue(copy.actionHandler?(copy) == true)
            XCTAssertEqual(UIPasteboard.general.string, view.document.tableMarkdown(id: id))
        }
        await loader.resolve(url: url, image: testImage(width: 240, height: 180))
        let deadline = Date().addingTimeInterval(2)
        while picture.accessibilityValue != nil && Date() < deadline { await Task.yield() }
        XCTAssertNil(picture.accessibilityValue)
        XCTAssertTrue(view.state.layout === layout)
        XCTAssertEqual(view.measuredHeight, height)

        let broken = URL(string: "https://fixture.invalid/broken.png")!
        view.update(source: "![Broken photo](\(broken.absoluteString))", literal: false)
        let failureDeadline = Date().addingTimeInterval(2)
        while await loader.requestCount(for: broken) == 0 && Date() < failureDeadline { await Task.yield() }
        await loader.reject(url: broken)
        while view.imageAccessibilityValue(for: broken) == "Loading image" && Date() < failureDeadline { await Task.yield() }
        XCTAssertEqual(view.imageAccessibilityValue(for: broken), "Preview unavailable")
        view.update(source: view.document.source + "\n\nAppended text", literal: false)
        await Task.yield()
        let requests = await loader.requestCount(for: broken)
        XCTAssertEqual(requests, 1, "Settled failures must not retry on streaming updates")
    }

    func testReduceMotionStopsStreamingDecorationWithoutChangingLayoutOrCopy() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let state = MessageDocumentState(source: "Streaming café 👩🏽‍💻")
        func documents(_ view: UIView) -> [MessageDocumentView] {
            (view as? MessageDocumentView).map { [$0] } ?? view.subviews.flatMap(documents)
        }
        func animations(_ layer: CALayer) -> Int {
            (layer.animationKeys()?.count ?? 0) + (layer.sublayers ?? []).reduce(0) { $0 + animations($1) }
        }
        let reduced = UIAccessibility.isReduceMotionEnabled
        let ready = expectation(description: "native surface ready")
        ready.assertForOverFulfill = false
        let host = UIHostingController(rootView:
            MessageDocumentSurface(source: state.document.source, streaming: true, state: state, onReady: { _ in ready.fulfill() })
                .frame(width: 280)
        )
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        await fulfillment(of: [ready], timeout: 3)
        window.layoutIfNeeded()
        let view = try XCTUnwrap(documents(host.view).first)
        XCTAssertEqual(animations(view.layer) > 0, !reduced)
        let layout = try XCTUnwrap(view.state.layout)
        view.update(source: state.document.source, literal: false)
        XCTAssertTrue(view.state.layout === layout)
        let evidence = XCTAttachment(string: "reduceMotion=\(reduced),activeAnimationCount=\(animations(view.layer))")
        evidence.lifetime = .keepAlways
        add(evidence)
        view.selectAll(nil)
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, state.document.plain)
    }

}
