import MarkdownUI
import SwiftUI
import UIKit
import WebKit
import XCTest
@testable import SentientApp

@MainActor
final class SelectableMarkdownTests: XCTestCase {
    private enum TestError: Error { case timedOut }

    func testHTMLKeepsRichDOMAndBlocksUntrustedActiveContent() {
        let markdown = """
        # Heading

        Paragraph with **strong**, *emphasis*, and `inline code`.

        ```swift
        let value = 1
        ```

        - first list item
        - second list item

        | Name | Value |
        | --- | --- |
        | cell | data |

        ![inline image](https://example.com/image.png)
        <script>alert('blocked')</script>
        [unsafe](javascript:alert(1))
        """

        let html = SelectableMarkdownDocument.html(for: markdown)
        let lowercased = html.lowercased()

        XCTAssertTrue(html.contains("<h1>"))
        XCTAssertTrue(html.contains("<pre>"))
        XCTAssertTrue(html.contains("<ul>"))
        XCTAssertTrue(html.contains("<table>"))
        XCTAssertTrue(html.contains("<img"))
        XCTAssertTrue(html.contains("https://example.com/image.png"))
        XCTAssertFalse(lowercased.contains("<script"))
        XCTAssertFalse(lowercased.contains("javascript:"))
        XCTAssertTrue(html.contains("default-src 'none'"))
        XCTAssertTrue(html.contains("script-src 'none'"))
        XCTAssertTrue(html.contains("connect-src 'none'"))
    }

    func testHeightSettlesOffscreenForWidthAndMatchesIntrinsicSize() async throws {
        let markdown = """
        # Stable heading

        This paragraph is long enough to wrap differently when width changes. It
        crosses several lines without relying on network images.
        """
        let wide = SelectableMarkdownHostView(markdown: markdown, width: 320)
        let narrow = SelectableMarkdownHostView(markdown: markdown, width: 220)
        let wideAgain = SelectableMarkdownHostView(markdown: markdown, width: 320)
        let wideWindow = try mount(wide, width: 320, hidden: true)
        let narrowWindow = try mount(narrow, width: 220, hidden: true)
        let wideAgainWindow = try mount(wideAgain, width: 320, hidden: true)
        defer {
            close(wideWindow)
            close(narrowWindow)
            close(wideAgainWindow)
        }

        XCTAssertFalse(wide.webView.configuration.websiteDataStore.isPersistent)
        XCTAssertFalse(wide.webView.configuration.defaultWebpagePreferences.allowsContentJavaScript)

        let wideHeight = try await waitForHeight(wide)
        let narrowHeight = try await waitForHeight(narrow)
        let wideAgainHeight = try await waitForHeight(wideAgain)

        XCTAssertGreaterThan(wideHeight, 0)
        XCTAssertGreaterThanOrEqual(narrowHeight, wideHeight)
        XCTAssertEqual(wideHeight, wideAgainHeight, accuracy: 1)
        XCTAssertEqual(wide.intrinsicContentSize.height, wideHeight, accuracy: 1)
        XCTAssertEqual(wide.loadCount, 1)
        XCTAssertEqual(narrow.loadCount, 1)
    }

    func testUnchangedUpdateDoesNotReloadOrLoseCopyActionAvailability() async throws {
        let markdown = """
        First paragraph with text to copy.

        # Heading between blocks

        ```
        code across a block
        ```

        - list item
        """
        let view = SelectableMarkdownHostView(markdown: markdown, width: 320)
        let window = try mount(view, width: 320, hidden: false)
        defer { close(window) }
        _ = try await waitForHeight(view)

        XCTAssertTrue(view.webView.becomeFirstResponder())
        view.webView.selectAll(nil)
        try await waitForNativeCopyAction(view.webView)

        let loadCount = view.loadCount
        view.update(markdown: markdown, width: 320)

        XCTAssertEqual(view.loadCount, loadCount)
        try await waitForNativeCopyAction(view.webView)
    }

    func testRenderedBlocksPreserveDOMAndCopyActionContract() async throws {
        let markdown = """
        Paragraph one.

        ## Heading two

        ```
        fenced code
        ```

        - list text

        | Left | Right |
        | --- | --- |
        | table cell | second cell |
        """
        let view = SelectableMarkdownHostView(markdown: markdown, width: 320)
        let window = try mount(view, width: 320, hidden: false)
        defer { close(window) }
        _ = try await waitForHeight(view)

        let html = view.documentHTML ?? ""
        let plainText = MarkdownContent(markdown).renderPlainText()
        XCTAssertTrue(html.contains("<p>Paragraph one.</p>"))
        XCTAssertTrue(html.contains("<h2>Heading two</h2>"))
        XCTAssertTrue(html.contains("<pre>"))
        XCTAssertTrue(html.contains("<ul>"))
        XCTAssertTrue(html.contains("<table>"))
        XCTAssertTrue(plainText.contains("Paragraph one"))
        XCTAssertTrue(plainText.contains("Heading two"))
        XCTAssertTrue(plainText.contains("fenced code"))
        XCTAssertTrue(plainText.contains("list text"))
        XCTAssertTrue(plainText.contains("table cell"))
        XCTAssertTrue(plainText.contains("second cell"))
        XCTAssertTrue(view.webView.becomeFirstResponder())
        view.webView.selectAll(nil)
        // This proves only that WebKit exposes its Copy action after Select All.
        // It does not read clipboard data or claim drag-handle behavior; parent E2E owns that proof.
        try await waitForNativeCopyAction(view.webView)
    }

    func testRenderedStylesAndTableCellsAreVisibleInWebKit() async throws {
        let markdown = """
        # Household plan 8

        [school calendar](https://example.invalid)

        | Time | Owner | Status |
        | --- | --- | --- |
        | 08:30 | Ada | Ready |
        | 15:10 | Grace | Pending |

        ```swift
        let fixture = "committed GFM"
        ```
        """
        let view = SelectableMarkdownHostView(markdown: markdown, width: 320)
        let window = try mount(view, width: 320, hidden: false)
        defer { close(window) }
        _ = try await waitForHeight(view)

        let result = try await view.webView.evaluateJavaScript("""
        (() => {
          const style = selector => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const computed = getComputedStyle(node);
            return {
              color: computed.color,
              fontFamily: computed.fontFamily,
              fontSize: computed.fontSize,
              borderTopWidth: computed.borderTopWidth,
              display: computed.display
            };
          };
          const cells = [...document.querySelectorAll('th, td')];
          return {
            body: style('body'),
            heading: style('h1'),
            link: style('a'),
            table: style('table'),
            cell: style('td'),
            code: style('pre'),
            cellCount: cells.length,
            cellTexts: cells.map(cell => cell.textContent)
          };
        })()
        """)
        let snapshot = try XCTUnwrap(result as? [String: Any])
        let body = try XCTUnwrap(snapshot["body"] as? [String: Any])
        let heading = try XCTUnwrap(snapshot["heading"] as? [String: Any])
        let link = try XCTUnwrap(snapshot["link"] as? [String: Any])
        let table = try XCTUnwrap(snapshot["table"] as? [String: Any])
        let cell = try XCTUnwrap(snapshot["cell"] as? [String: Any])
        let code = try XCTUnwrap(snapshot["code"] as? [String: Any])

        XCTAssertTrue(try XCTUnwrap(body["fontFamily"] as? String).contains(DesignTypographyAdapter.uiFamily))
        XCTAssertEqual(heading["fontSize"] as? String, body["fontSize"] as? String)
        XCTAssertEqual(heading["color"] as? String, body["color"] as? String)
        XCTAssertEqual(link["color"] as? String, "rgb(242, 160, 106)")
        XCTAssertEqual(table["display"] as? String, "table")
        XCTAssertEqual(cell["borderTopWidth"] as? String, "1px")
        XCTAssertEqual(snapshot["cellCount"] as? Int, 9)
        XCTAssertEqual(
            snapshot["cellTexts"] as? [String],
            ["Time", "Owner", "Status", "08:30", "Ada", "Ready", "15:10", "Grace", "Pending"]
        )
        XCTAssertTrue(try XCTUnwrap(code["fontFamily"] as? String).contains(DesignTypographyAdapter.monoFamily))
    }

    func testColdAndWarmMeasurementTimingWithSharedWebKitResources() async throws {
        let markdown = """
        # Repeated measurement

        A compact row with **formatting**, a list, and a table.

        - one
        - two

        | A | B |
        | --- | --- |
        | one | two |
        """
        let width: CGFloat = 320
        let warmCount = 7
        let baselineLiveViews = SelectableMarkdownHostView.liveViewCount
        let fontReadsBefore = SelectableMarkdownDocument.fontAssetReadCount
        let markdownStart = ProcessInfo.processInfo.systemUptime
        let markdownHost = UIHostingController(
            rootView: Markdown(markdown)
                .markdownTheme(.dusk)
                .frame(width: width, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        )
        markdownHost.view.frame = CGRect(x: 0, y: 0, width: width, height: 1)
        markdownHost.view.setNeedsLayout()
        markdownHost.view.layoutIfNeeded()
        let markdownHeight = markdownHost.sizeThatFits(
            in: CGSize(width: width, height: .greatestFiniteMagnitude)
        ).height
        let markdownDuration = ProcessInfo.processInfo.systemUptime - markdownStart

        let container = UIView(frame: CGRect(x: 0, y: 0, width: width, height: 1))
        let window = try mount(container, width: width, hidden: true)
        defer { close(window) }

        let coldStart = ProcessInfo.processInfo.systemUptime
        let coldView = SelectableMarkdownHostView(markdown: markdown, width: width)
        coldView.frame = CGRect(x: 0, y: 0, width: width, height: 1)
        container.addSubview(coldView)
        let coldFirstHeight = try await waitForFirstHeight(coldView)
        let coldFirstDuration = ProcessInfo.processInfo.systemUptime - coldStart

        let warmStart = ProcessInfo.processInfo.systemUptime
        var warmViews: [SelectableMarkdownHostView] = []
        for index in 0..<warmCount {
            let view = SelectableMarkdownHostView(markdown: markdown, width: width)
            view.frame = CGRect(x: 0, y: CGFloat(index + 1), width: width, height: 1)
            container.addSubview(view)
            warmViews.append(view)
        }
        let warmFirstHeights = try await firstHeightValues(for: warmViews)
        let warmFirstDuration = ProcessInfo.processInfo.systemUptime - warmStart
        let settleStart = ProcessInfo.processInfo.systemUptime
        let coldHeight = try await waitForHeight(coldView)
        let warmHeight = try await waitForHeight(warmViews[0])
        let settleDuration = ProcessInfo.processInfo.systemUptime - settleStart
        let peakLiveViews = SelectableMarkdownHostView.liveViewCount

        XCTAssertGreaterThan(markdownHeight, 0)
        XCTAssertGreaterThan(coldFirstHeight, 0)
        XCTAssertTrue(warmFirstHeights.allSatisfy { $0 > 0 })
        XCTAssertEqual(coldHeight, warmHeight, accuracy: 1)
        XCTAssertEqual(SelectableMarkdownDocument.fontAssetReadCount, fontReadsBefore)
        XCTAssertTrue(coldView.webView.configuration.websiteDataStore ===
                      SelectableMarkdownHostView.sharedWebsiteDataStore)
        XCTAssertTrue(warmViews.allSatisfy {
            $0.webView.configuration.websiteDataStore ===
                SelectableMarkdownHostView.sharedWebsiteDataStore
        })
        XCTAssertGreaterThanOrEqual(peakLiveViews, baselineLiveViews + warmCount + 1)
        print(
            "SelectableMarkdown timing width=\(width) coldFirst=\(coldFirstDuration)s " +
                "warmRows=\(warmCount) warmFirstTotal=\(warmFirstDuration)s " +
                "warmAmortizedPerRow=\(warmFirstDuration / Double(warmCount))s settle=\(settleDuration)s " +
                "markdownUI=\(markdownDuration)s " +
                "fontAssetReads=\(SelectableMarkdownDocument.fontAssetReadCount) " +
                "liveWKViewsPeak=\(peakLiveViews) sharedNonPersistentStore=true " +
                "coldHeightUpdates=\(coldView.heightUpdateCount)"
        )
    }

    func testDynamicTypeChangeReloadsUnchangedMarkdown() async throws {
        let markdown = """
        This paragraph wraps at normal size and should need different content height
        when Dynamic Type increases without changing its Markdown value.
        """
        let view = SelectableMarkdownHostView(markdown: markdown, width: 220)
        let window = try mount(view, width: 220, hidden: false)
        defer { close(window) }
        let initialHeight = try await waitForHeight(view)
        let initialLoadCount = view.loadCount
        let initialBodySize = try XCTUnwrap(bodyFontSize(in: view.documentHTML ?? ""))

        setContentSizeCategory(.accessibilityExtraExtraExtraLarge, for: view)
        let updatedHeight = try await waitForHeightChange(view, afterLoadCount: initialLoadCount)
        let updatedBodySize = try XCTUnwrap(bodyFontSize(in: view.documentHTML ?? ""))
        // SwiftUI replays the surface's unchanged retry token after the trait
        // callback; this must not load the same Dynamic Type revision twice.
        view.update(markdown: markdown, width: 220, retryToken: 0)
        _ = try await waitForHeight(view)

        XCTAssertEqual(view.loadCount, initialLoadCount + 1)
        XCTAssertGreaterThan(updatedBodySize, initialBodySize)
        XCTAssertGreaterThanOrEqual(updatedHeight, initialHeight)
    }

    func testWebKitConfigurationAndFontAssetsAreReused() {
        let firstHTML = SelectableMarkdownDocument.html(for: "first")
        let readsAfterFirstDocument = SelectableMarkdownDocument.fontAssetReadCount
        let secondHTML = SelectableMarkdownDocument.html(for: "second")

        XCTAssertFalse(SelectableMarkdownHostView.sharedWebsiteDataStore.isPersistent)
        XCTAssertFalse(firstHTML.isEmpty)
        XCTAssertFalse(secondHTML.isEmpty)
        XCTAssertEqual(SelectableMarkdownDocument.fontAssetReadCount, readsAfterFirstDocument)
        XCTAssertEqual(readsAfterFirstDocument, 4)
    }

    func testPrivateImageSchemeReusesSourceURLWithoutExposingNetworkToWebKit() throws {
        let source = try XCTUnwrap(URL(string: "https://example.com/image.png?size=2"))
        let privateURL = try XCTUnwrap(SelectableMarkdownDocument.privateImageURL(for: source))
        XCTAssertEqual(privateURL.scheme, SelectableMarkdownHostView.imageScheme)
        XCTAssertEqual(privateURL.host, "cache")

        let html = SelectableMarkdownDocument.html(
            for: "![image](\(source.absoluteString))",
            compatibleWith: .current,
            usePrivateImageScheme: true
        )
        XCTAssertTrue(html.contains(privateURL.absoluteString))
        XCTAssertFalse(html.contains(source.absoluteString))
        XCTAssertTrue(html.contains("img-src \(SelectableMarkdownHostView.imageScheme): data:"))
    }

    func testFailedNavigationRetainsDocumentForNativeFallbackAndCanRetry() async throws {
        let view = SelectableMarkdownHostView(markdown: "Retained content", width: 320)
        let window = try mount(view, width: 320, hidden: false)
        defer { close(window) }
        _ = try await waitForHeight(view)
        let html = try XCTUnwrap(view.documentHTML)
        let initialLoadCount = view.loadCount
        let failureExpectation = expectation(description: "failure callback")
        view.onLoadFailure = { failure in
            XCTAssertEqual(failure, .navigation)
            failureExpectation.fulfill()
        }

        view.recordFailure(.navigation)
        await fulfillment(of: [failureExpectation], timeout: 1)
        XCTAssertEqual(view.documentHTML, html)
        XCTAssertNil(view.measuredHeight)
        XCTAssertEqual(view.webView.alpha, 0)

        view.retry()
        _ = try await waitForHeightChange(view, afterLoadCount: initialLoadCount)
        XCTAssertGreaterThan(view.loadCount, initialLoadCount)
        XCTAssertNil(view.loadFailure)
    }

    func testObsoleteSurfaceCallbacksCannotResetNewContentReadiness() async throws {
        let model = SurfaceReadinessModel()
        let initialMarkdown = model.markdown
        let firstReady = expectation(description: "first surface ready")
        var firstReported = false
        model.onStateChange = { ready in
            guard ready, !firstReported else { return }
            firstReported = true
            firstReady.fulfill()
        }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }.first)
        let controller = UIHostingController(rootView: SurfaceReadinessView(model: model))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 800)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { close(window) }
        await fulfillment(of: [firstReady], timeout: 5)
        let firstRenderer = try XCTUnwrap(findSubview(
            of: controller.view, type: SelectableMarkdownHostView.self
        ))
        let obsoleteStarted = try XCTUnwrap(firstRenderer.onLoadStarted)
        let obsoleteReady = try XCTUnwrap(firstRenderer.onLoadReady)
        let obsoleteFailure = try XCTUnwrap(firstRenderer.onLoadFailure)

        let secondReady = expectation(description: "replacement surface ready")
        var secondReported = false
        model.onStateChange = { ready in
            guard ready, !secondReported else { return }
            secondReported = true
            secondReady.fulfill()
        }
        model.markdown = "Replacement paragraph with **different content**."
        await fulfillment(of: [secondReady], timeout: 5)

        var changes: [Bool] = []
        model.onStateChange = { changes.append($0) }
        obsoleteStarted()
        obsoleteReady(false)
        obsoleteFailure(.navigation)
        // Drain exactly the main-queue callbacks enqueued above, not an elapsed-time wait.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async { continuation.resume() }
        }
        XCTAssertFalse(changes.contains(false), "Obsolete content must not hide the current renderer")

        let repeatedReady = expectation(description: "repeated input is a new ready attempt")
        var repeatedReported = false
        model.onStateChange = { ready in
            guard ready, !repeatedReported else { return }
            repeatedReported = true
            repeatedReady.fulfill()
        }
        model.markdown = initialMarkdown
        await fulfillment(of: [repeatedReady], timeout: 5)
        changes.removeAll()
        model.onStateChange = { changes.append($0) }
        obsoleteStarted()
        obsoleteReady(false)
        obsoleteFailure(.navigation)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async { continuation.resume() }
        }
        XCTAssertFalse(changes.contains(false), "Returning to earlier input must not revive its obsolete callbacks")

        let currentFailure = expectation(description: "current failure remains actionable")
        var failureReported = false
        model.onStateChange = { ready in
            guard !ready, !failureReported else { return }
            failureReported = true
            currentFailure.fulfill()
        }
        let currentRenderer = try XCTUnwrap(findSubview(
            of: controller.view, type: SelectableMarkdownHostView.self
        ))
        currentRenderer.recordFailure(.navigation)
        await fulfillment(of: [currentFailure], timeout: 1)
    }

    @MainActor
    private final class SurfaceReadinessModel: ObservableObject {
        @Published var markdown = "Initial paragraph."
        var onStateChange: ((Bool) -> Void)?
    }

    private struct SurfaceReadinessView: View {
        @ObservedObject var model: SurfaceReadinessModel

        var body: some View {
            SelectableMarkdownSurface(
                markdown: model.markdown,
                width: 320,
                onLoadStateChange: { model.onStateChange?($0) }
            ) {
                Text("Readable fallback")
            }
            .frame(width: 320, alignment: .leading)
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }

    func testPendingTextViewExposesNativeSelection() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }.first)
        let controller = UIHostingController(rootView: SelectablePlainText(text: "copy this"))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 800)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { close(window) }

        var foundTextView: UITextView?
        for _ in 0..<100 {
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            foundTextView = findSubview(of: controller.view, type: UITextView.self)
            if foundTextView != nil { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let textView = try XCTUnwrap(foundTextView)
        XCTAssertTrue(textView.isSelectable)
        XCTAssertFalse(textView.isEditable)
        XCTAssertEqual(textView.text, "copy this")
        XCTAssertTrue(textView.becomeFirstResponder())
        textView.selectAll(nil)
        XCTAssertTrue(textView.canPerformAction(#selector(UIResponderStandardEditActions.copy(_:)), withSender: nil))
    }

    func testRecycledHostViewsDoNotRemainLive() async throws {
        let baseline = SelectableMarkdownHostView.liveViewCount
        do {
            let container = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 1))
            let window = try mount(container, width: 320, hidden: true)
            var views: [SelectableMarkdownHostView] = []
            for index in 0..<12 {
                let view = SelectableMarkdownHostView(markdown: "row \(index)", width: 320)
                container.addSubview(view)
                views.append(view)
            }
            XCTAssertGreaterThanOrEqual(SelectableMarkdownHostView.liveViewCount, baseline + 12)
            views.forEach { $0.removeFromSuperview() }
            close(window)
        }
        for _ in 0..<10 {
            await Task.yield()
            if SelectableMarkdownHostView.liveViewCount <= baseline { break }
        }
        XCTAssertLessThanOrEqual(SelectableMarkdownHostView.liveViewCount, baseline)
    }

    private func findSubview<T: UIView>(of view: UIView, type: T.Type) -> T? {
        if let view = view as? T { return view }
        for child in view.subviews {
            if let match = findSubview(of: child, type: type) { return match }
        }
        return nil
    }

    private func mount(
        _ view: UIView,
        width: CGFloat,
        hidden: Bool
    ) throws -> UIWindow {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first else { throw TestError.timedOut }

        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 800)
        let controller = UIViewController()
        let contentController = UIViewController()
        controller.addChild(contentController)
        controller.view.backgroundColor = .clear
        controller.view.frame = window.bounds
        contentController.view.frame = controller.view.bounds
        controller.view.addSubview(contentController.view)
        contentController.didMove(toParent: controller)
        window.rootViewController = controller
        contentController.view.addSubview(view)
        view.frame = CGRect(x: 0, y: 0, width: width, height: 1)
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        if hidden {
            window.isHidden = true
        } else {
            window.makeKeyAndVisible()
        }
        return window
    }

    private func close(_ window: UIWindow) {
        window.isHidden = true
        window.rootViewController = nil
    }

    // Unit target can query Copy availability only. Parent E2E must verify
    // handles and substring clipboard payload.
    private func waitForNativeCopyAction(_ webView: WKWebView) async throws {
        let action = #selector(UIResponderStandardEditActions.copy(_:))
        for _ in 0..<150 {
            if webView.canPerformAction(action, withSender: nil) { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw TestError.timedOut
    }

    private func setContentSizeCategory(
        _ category: UIContentSizeCategory,
        for view: SelectableMarkdownHostView
    ) {
        view.traitOverrides.preferredContentSizeCategory = category
    }

    private func bodyFontSize(in html: String) -> CGFloat? {
        guard let body = html.range(of: "body {"),
              let font = html.range(of: "font-size: ", range: body.upperBound..<html.endIndex),
              let end = html[font.upperBound...].firstIndex(of: "p") else { return nil }
        return CGFloat(Double(html[font.upperBound..<end].trimmingCharacters(in: .whitespaces)) ?? 0)
    }

    private func waitForFirstHeight(_ view: SelectableMarkdownHostView) async throws -> CGFloat {
        if let height = view.measuredHeight { return height }
        let expectation = expectation(description: "WebKit first height")
        var result: CGFloat?
        view.onHeightChange = { height in
            guard result == nil else { return }
            result = height
            expectation.fulfill()
        }
        await fulfillment(of: [expectation], timeout: 5)
        guard let result else { throw TestError.timedOut }
        return result
    }

    private func waitForHeight(_ view: SelectableMarkdownHostView) async throws -> CGFloat {
        try await waitForHeight(view, description: "WebKit height") { true }
    }

    private func waitForHeightChange(
        _ view: SelectableMarkdownHostView,
        afterLoadCount count: Int
    ) async throws -> CGFloat {
        try await waitForHeight(view, description: "WebKit height update") {
            view.loadCount > count
        }
    }

    private func waitForHeight(
        _ view: SelectableMarkdownHostView,
        description: String,
        qualifies: @escaping () -> Bool
    ) async throws -> CGFloat {
        let expectation = expectation(description: description)
        var result = view.measuredHeight
        var finished = false
        var settleWorkItem: DispatchWorkItem?

        view.onHeightChange = { height in
            guard !finished, qualifies() else { return }
            result = height
            settleWorkItem?.cancel()
            let work = DispatchWorkItem {
                guard !finished else { return }
                finished = true
                expectation.fulfill()
            }
            settleWorkItem = work
            // KVO gives one event per layout pass; wait for event quiet, not a
            // fixed sample count that can finish before same-turn layout settles.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
        }
        if let result, qualifies() { view.onHeightChange?(result) }

        await fulfillment(of: [expectation], timeout: 5)
        settleWorkItem?.cancel()
        guard let result else { throw TestError.timedOut }
        return result
    }

    private func firstHeightValues(
        for views: [SelectableMarkdownHostView]
    ) async throws -> [CGFloat] {
        var values: [CGFloat] = []
        for view in views { values.append(try await waitForFirstHeight(view)) }
        return values
    }
}
