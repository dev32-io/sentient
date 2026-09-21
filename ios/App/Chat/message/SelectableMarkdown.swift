import Foundation
import MarkdownUI
import SwiftUI
import UIKit
import WebKit
@_implementationOnly import cmark_gfm
@_implementationOnly import cmark_gfm_extensions

enum SelectableMarkdownLoadFailure: Equatable {
    case navigation
    case provisionalNavigation
    case invalidContentSize
}

/// Native WebKit surface for one mounted, committed Markdown bubble. Offscreen
/// measurement stays on MarkdownUI; the caller keeps that renderer as a fallback
/// until WebKit publishes a real height.
struct SelectableMarkdown: UIViewRepresentable {
    let markdown: String
    let width: CGFloat
    var imageCache: MarkdownImageCache?
    var retryToken = 0
    var onHeightChange: ((CGFloat) -> Void)?
    var onLoadStarted: (() -> Void)?
    var onLoadReady: ((Bool) -> Void)?
    var onLoadFailure: ((SelectableMarkdownLoadFailure) -> Void)?

    func makeUIView(context: Context) -> SelectableMarkdownHostView {
        SelectableMarkdownHostView(
            markdown: markdown,
            width: width,
            imageCache: imageCache,
            retryToken: retryToken,
            onHeightChange: onHeightChange,
            onLoadStarted: onLoadStarted,
            onLoadReady: onLoadReady,
            onLoadFailure: onLoadFailure
        )
    }

    func updateUIView(_ view: SelectableMarkdownHostView, context: Context) {
        view.onHeightChange = onHeightChange
        view.onLoadStarted = onLoadStarted
        view.onLoadReady = onLoadReady
        view.onLoadFailure = onLoadFailure
        view.update(markdown: markdown, width: width, retryToken: retryToken)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: SelectableMarkdownHostView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width.isFinite,
              let height = uiView.measuredHeight else { return nil }
        return CGSize(width: width, height: height)
    }
}

/// Keeps fast MarkdownUI visible while mounted WebKit content loads or retries.
/// WebKit is the topmost child once its exact height is usable.
struct SelectableMarkdownSurface<Fallback: View>: View {
    let markdown: String
    let width: CGFloat
    let imageCache: MarkdownImageCache?
    let onHeightChange: ((CGFloat) -> Void)?
    let onLoadStateChange: ((Bool) -> Void)?
    @ViewBuilder let fallback: () -> Fallback

    @State private var retryToken = 0
    @State private var loadFailure: SelectableMarkdownLoadFailure?
    @State private var isReady = false

    init(
        markdown: String,
        width: CGFloat,
        imageCache: MarkdownImageCache? = nil,
        onHeightChange: ((CGFloat) -> Void)? = nil,
        onLoadStateChange: ((Bool) -> Void)? = nil,
        @ViewBuilder fallback: @escaping () -> Fallback
    ) {
        self.markdown = markdown
        self.width = width
        self.imageCache = imageCache
        self.onHeightChange = onHeightChange
        self.onLoadStateChange = onLoadStateChange
        self.fallback = fallback
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            ZStack(alignment: .topLeading) {
                if !isReady { fallback() }
                SelectableMarkdown(
                    markdown: markdown,
                    width: width,
                    imageCache: imageCache,
                    retryToken: retryToken,
                    onHeightChange: onHeightChange,
                    onLoadStarted: {
                        DispatchQueue.main.async {
                            isReady = false
                            onLoadStateChange?(false)
                            loadFailure = nil
                        }
                    },
                    onLoadReady: { ready in
                        DispatchQueue.main.async {
                            isReady = ready
                            onLoadStateChange?(ready)
                        }
                    },
                    onLoadFailure: { failure in
                        DispatchQueue.main.async {
                            isReady = false
                            onLoadStateChange?(false)
                            loadFailure = failure
                        }
                    }
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if loadFailure != nil {
                Button("Retry rendering") { retryToken += 1 }
                    .font(Typo.ui(TypeScale.xs, .semibold))
                    .foregroundStyle(DuskColors.accent)
                    .buttonStyle(.plain)
                    .accessibilityLabel("Retry rich text rendering")
            }
        }
    }
}

/// Native pending/outbox text surface. Unlike SwiftUI Text, UITextView exposes
/// the standard iOS substring handles and Copy action directly.
struct SelectablePlainText: UIViewRepresentable {
    let text: String
    var font: UIFont = UIFont(
        name: DesignTypographyAdapter.uiFamily,
        size: TypeScale.base
    ) ?? UIFont.preferredFont(forTextStyle: .body)

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(frame: .zero)
        view.backgroundColor = .clear
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.showsVerticalScrollIndicator = false
        view.showsHorizontalScrollIndicator = false
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.accessibilityTraits = .staticText
        update(view)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        update(view)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UITextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let height = uiView.sizeThatFits(
            CGSize(width: width, height: .greatestFiniteMagnitude)
        ).height
        return CGSize(width: width, height: height)
    }

    private func update(_ view: UITextView) {
        if view.text != text { view.text = text }
        view.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: font)
        view.textColor = UIColor(DuskColors.ink)
        view.accessibilityLabel = text
    }
}

@MainActor
final class SelectableMarkdownHostView: UIView, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView

    static let sharedWebsiteDataStore = WKWebsiteDataStore.nonPersistent()
    nonisolated static let imageScheme = "sentient-image"
    private static let liveViews = NSHashTable<AnyObject>.weakObjects()
    static var liveViewCount: Int { liveViews.allObjects.count }

    private(set) var loadedMarkdown: String?
    private(set) var documentHTML: String?
    private(set) var loadCount = 0
    private(set) var measuredHeight: CGFloat?
    private(set) var heightUpdateCount = 0
    private(set) var loadFailure: SelectableMarkdownLoadFailure?

    var onHeightChange: ((CGFloat) -> Void)?
    var onLoadStarted: (() -> Void)?
    var onLoadReady: ((Bool) -> Void)?
    var onLoadFailure: ((SelectableMarkdownLoadFailure) -> Void)?

    private var contentWidth: CGFloat
    private var contentGeneration = 0
    private var heightGeneration = 0
    private var contentSizeObservation: NSKeyValueObservation?
    private var activeNavigation: WKNavigation?
    private var activeNavigationGeneration = 0
    private var renderedContentSizeCategory = UIContentSizeCategory.unspecified
    private var hasFinishedLoading = false
    private var heightPublicationScheduled = false
    private var heightPublicationRequested = false
    private var scheduledLoadGeneration: Int?
    private var retryToken = -1
    private let imageCache: MarkdownImageCache?
    private let styleNonce: String

    init(
        markdown: String,
        width: CGFloat,
        imageCache: MarkdownImageCache? = nil,
        retryToken: Int = 0,
        onHeightChange: ((CGFloat) -> Void)? = nil,
        onLoadStarted: (() -> Void)? = nil,
        onLoadReady: ((Bool) -> Void)? = nil,
        onLoadFailure: ((SelectableMarkdownLoadFailure) -> Void)? = nil
    ) {
        let configuration = Self.makeConfiguration(imageCache: imageCache)
        webView = WKWebView(frame: .zero, configuration: configuration)
        contentWidth = Self.validWidth(width)
        self.imageCache = imageCache
        // Keep one random nonce per host: WebKit can reject a freshly nonced
        // inline stylesheet when same web view reloads a new document.
        styleNonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        self.onHeightChange = onHeightChange
        self.onLoadStarted = onLoadStarted
        self.onLoadReady = onLoadReady
        self.onLoadFailure = onLoadFailure
        super.init(frame: .zero)
        if #available(iOS 17.0, *) {
            registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) {
                (view: SelectableMarkdownHostView, previousTraitCollection: UITraitCollection) in
                view.preferredContentSizeCategoryDidChange(previousTraitCollection)
            }
        }
        Self.liveViews.add(self)

        backgroundColor = .clear
        isOpaque = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.alpha = 0
        webView.isUserInteractionEnabled = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInset = .zero
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.translatesAutoresizingMaskIntoConstraints = true
        contentSizeObservation = webView.scrollView.observe(\.contentSize, options: [.new]) {
            [weak self] scrollView, change in
            let size = change.newValue ?? scrollView.contentSize
            DispatchQueue.main.async { [weak self] in
                self?.contentSizeDidChange(size)
            }
        }
        addSubview(webView)

        update(markdown: markdown, width: width, retryToken: retryToken)
    }

    required init?(coder: NSCoder) {
        fatalError("SelectableMarkdownHostView does not support NSCoder initialization")
    }

    override var intrinsicContentSize: CGSize {
        CGSize(
            width: UIView.noIntrinsicMetric,
            height: measuredHeight ?? UIView.noIntrinsicMetric
        )
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let width = Self.validWidth(size.width > 0 ? size.width : contentWidth)
        return CGSize(width: width, height: measuredHeight ?? 0)
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let width = bounds.width > 0 ? bounds.width : contentWidth
        if abs(width - contentWidth) > 0.5 {
            contentWidth = width
            if hasFinishedLoading {
                beginMeasurement()
            }
        }

        let height = max(1, measuredHeight ?? 1)
        webView.frame = CGRect(x: 0, y: 0, width: width, height: height)
    }

    func update(markdown: String, width: CGFloat, retryToken: Int = 0) {
        let width = Self.validWidth(width)
        let widthChanged = abs(width - contentWidth) > 0.5
        let contentSizeCategory = traitCollection.preferredContentSizeCategory
        let contentSizeCategoryChanged = renderedContentSizeCategory != contentSizeCategory
        let retryRequested = self.retryToken != retryToken
        contentWidth = width
        self.retryToken = retryToken
        webView.frame = CGRect(
            x: 0,
            y: 0,
            width: width,
            height: max(1, measuredHeight ?? 1)
        )

        if loadedMarkdown == markdown, !contentSizeCategoryChanged, !retryRequested {
            if widthChanged, hasFinishedLoading {
                beginMeasurement()
            }
            return
        }

        webView.stopLoading()
        contentGeneration += 1
        activeNavigation = nil
        loadedMarkdown = markdown
        renderedContentSizeCategory = contentSizeCategory
        documentHTML = SelectableMarkdownDocument.html(
            for: markdown,
            compatibleWith: traitCollection,
            usePrivateImageScheme: imageCache != nil,
            documentGeneration: contentGeneration,
            nonce: styleNonce
        )
        hasFinishedLoading = false
        webView.alpha = 0
        webView.isUserInteractionEnabled = false
        onLoadReady?(false)
        onLoadStarted?()
        loadFailure = nil
        measuredHeight = nil
        invalidateIntrinsicContentSize()
        heightGeneration += 1
        heightPublicationScheduled = false
        scheduleLoad(generation: contentGeneration)
    }

    private func scheduleLoad(generation: Int) {
        guard scheduledLoadGeneration == nil else { return }
        scheduledLoadGeneration = generation
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scheduledLoadGeneration = nil
            guard generation == self.contentGeneration else {
                self.scheduleLoad(generation: self.contentGeneration)
                return
            }
            guard let documentHTML = self.documentHTML else { return }
            self.loadCount += 1
            self.activeNavigationGeneration = generation
            self.activeNavigation = self.webView.loadHTMLString(documentHTML, baseURL: nil)
        }
    }

    private func preferredContentSizeCategoryDidChange(_ previousTraitCollection: UITraitCollection?) {
        guard previousTraitCollection?.preferredContentSizeCategory
                != traitCollection.preferredContentSizeCategory,
              let loadedMarkdown else { return }
        // The category itself invalidates the document. Keep the surface-owned
        // retry token unchanged so its next update does not reload a second time.
        update(markdown: loadedMarkdown, width: contentWidth, retryToken: retryToken)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isCurrentNavigation(navigation) else { return }
        hasFinishedLoading = true
        scheduleHeightPublication()
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        guard isCurrentNavigation(navigation) else { return }
        recordFailure(.navigation)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        guard isCurrentNavigation(navigation) else { return }
        recordFailure(.provisionalNavigation)
    }

    private func isCurrentNavigation(_ navigation: WKNavigation?) -> Bool {
        guard let navigation, let activeNavigation else { return false }
        return navigation === activeNavigation && activeNavigationGeneration == contentGeneration
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.navigationType == .linkActivated {
            guard let url = navigationAction.request.url, Self.isExternalLink(url) else {
                decisionHandler(.cancel)
                return
            }
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel)
            return
        }

        // loadHTMLString starts as an about:blank main-frame navigation. Allow
        // that local bootstrap only; every other non-link navigation is blocked.
        let isLocalBootstrap = navigationAction.targetFrame?.isMainFrame == true &&
            (navigationAction.request.url == nil || navigationAction.request.url?.scheme == "about")
        decisionHandler(isLocalBootstrap ? .allow : .cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard navigationAction.navigationType == .linkActivated,
              let url = navigationAction.request.url,
              Self.isExternalLink(url) else { return nil }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        return nil
    }

    private func beginMeasurement() {
        heightGeneration += 1
        heightPublicationScheduled = false
        measuredHeight = nil
        webView.alpha = 0
        webView.isUserInteractionEnabled = false
        onLoadReady?(false)
        invalidateIntrinsicContentSize()
        webView.frame.size.height = 1
        scheduleHeightPublication()
    }

    private func contentSizeDidChange(_ size: CGSize) {
        guard hasFinishedLoading, size.width.isFinite, size.height.isFinite else { return }
        scheduleHeightPublication()
    }

    private func scheduleHeightPublication() {
        guard hasFinishedLoading else { return }
        heightPublicationRequested = true
        guard !heightPublicationScheduled else { return }
        let generation = heightGeneration
        let documentGeneration = contentGeneration
        heightPublicationScheduled = true
        heightPublicationRequested = false
        // Scroll contentSize cannot shrink below the assigned viewport. Measure
        // the actual article after bundled fonts settle, in the app's isolated
        // world; Markdown/page JavaScript remains disabled by configuration/CSP.
        webView.callAsyncJavaScript(
            """
            await document.fonts.ready;
            const article = document.querySelector('article');
            return document.documentElement.dataset.sentientContentGeneration + '|' +
                article.getBoundingClientRect().height;
            """,
            arguments: [:], in: nil, in: .defaultClient
        ) { [weak self] result in
            guard let self, generation == self.heightGeneration,
                  documentGeneration == self.contentGeneration,
                  self.activeNavigationGeneration == documentGeneration,
                  self.hasFinishedLoading else { return }
            self.heightPublicationScheduled = false
            guard case let .success(value) = result, let raw = value as? String else {
                self.recordFailure(.invalidContentSize)
                return
            }
            let fields = raw.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
            guard fields.count == 2 else {
                self.recordFailure(.invalidContentSize)
                return
            }
            guard String(fields[0]) == String(documentGeneration) else {
                // A reply from a document that lost the navigation race is not a
                // content-size failure. Let current document finish another pass.
                self.heightPublicationRequested = true
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.scheduleHeightPublication()
                }
                return
            }
            guard let height = Double(fields[1]), height.isFinite, height >= 0 else {
                self.recordFailure(.invalidContentSize)
                return
            }
            self.publishHeight(max(1, CGFloat(height)))
            // A layout event may arrive while the WebProcess reply is in flight.
            if self.heightPublicationRequested { self.scheduleHeightPublication() }
        }
    }

    func recordFailure(_ failure: SelectableMarkdownLoadFailure) {
        activeNavigation = nil
        heightPublicationScheduled = false
        hasFinishedLoading = false
        webView.alpha = 0
        webView.isUserInteractionEnabled = false
        onLoadReady?(false)
        measuredHeight = nil
        loadFailure = failure
        invalidateIntrinsicContentSize()
        onLoadFailure?(failure)
    }

    func retry() {
        guard let loadedMarkdown else { return }
        update(markdown: loadedMarkdown, width: contentWidth, retryToken: retryToken + 1)
    }

    private func publishHeight(_ height: CGFloat) {
        guard height.isFinite, height > 0 else { return }
        let height = ceil(height)
        let changed = measuredHeight != height
        measuredHeight = height
        loadFailure = nil
        webView.alpha = 1
        webView.isUserInteractionEnabled = true
        onLoadReady?(true)
        heightUpdateCount += 1
        invalidateIntrinsicContentSize()
        if changed { onHeightChange?(height) }
    }

    private static func makeConfiguration(
        imageCache: MarkdownImageCache?
    ) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = sharedWebsiteDataStore
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        if let imageCache {
            configuration.setURLSchemeHandler(
                SelectableMarkdownImageSchemeHandler(cache: imageCache),
                forURLScheme: imageScheme
            )
        }
        return configuration
    }

    private static func validWidth(_ width: CGFloat) -> CGFloat {
        guard width.isFinite else { return 1 }
        return max(1, width)
    }

    private static func isExternalLink(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }
}

@MainActor
final class SelectableMarkdownImageSchemeHandler: NSObject, WKURLSchemeHandler {
    private final class RequestState {
        var task: Task<Void, Never>?
        var stopped = false

        deinit { task?.cancel() }
    }

    private let cache: MarkdownImageCache
    private var tasks: [ObjectIdentifier: RequestState] = [:]

    init(cache: MarkdownImageCache) {
        self.cache = cache
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let taskID = ObjectIdentifier(urlSchemeTask as AnyObject)
        let request = urlSchemeTask.request
        let state = RequestState()
        if let previous = tasks.updateValue(state, forKey: taskID) {
            previous.stopped = true
            previous.task?.cancel()
        }
        state.task = Task { @MainActor [weak self, weak state] in
            defer {
                if let self, let state, self.tasks[taskID] === state {
                    self.tasks.removeValue(forKey: taskID)
                }
            }
            guard let self, let state, !state.stopped, !Task.isCancelled else { return }
            guard let responseURL = request.url,
                  let source = Self.sourceURL(from: responseURL) else {
                guard !state.stopped, !Task.isCancelled else { return }
                urlSchemeTask.didFailWithError(Self.invalidResourceError)
                return
            }
            guard let data = await self.cache.imageData(for: source) else {
                guard !state.stopped, !Task.isCancelled else { return }
                urlSchemeTask.didFailWithError(Self.unavailableResourceError)
                return
            }
            guard !state.stopped, !Task.isCancelled else { return }
            urlSchemeTask.didReceive(URLResponse(
                url: responseURL,
                mimeType: "image/png",
                expectedContentLength: data.count,
                textEncodingName: nil
            ))
            guard !state.stopped, !Task.isCancelled else { return }
            urlSchemeTask.didReceive(data)
            guard !state.stopped, !Task.isCancelled else { return }
            urlSchemeTask.didFinish()
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let taskID = ObjectIdentifier(urlSchemeTask as AnyObject)
        guard let state = tasks[taskID] else { return }
        state.stopped = true
        state.task?.cancel()
        guard tasks[taskID] === state else { return }
        tasks.removeValue(forKey: taskID)
    }

    static func sourceURL(from resourceURL: URL?) -> URL? {
        guard let resourceURL,
              resourceURL.scheme == SelectableMarkdownHostView.imageScheme,
              resourceURL.host == "cache" else { return nil }
        let token = resourceURL.lastPathComponent
        guard !token.isEmpty else { return nil }
        var normalized = token
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        guard let data = Data(base64Encoded: normalized),
              let source = URL(string: String(decoding: data, as: UTF8.self)),
              let scheme = source.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return nil }
        return source
    }

    private static let invalidResourceError = NSError(
        domain: "SelectableMarkdownImage", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Invalid Markdown image resource"]
    )
    private static let unavailableResourceError = NSError(
        domain: "SelectableMarkdownImage", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Markdown image unavailable"]
    )
}

/// HTML wrapper. MarkdownContent supplies GFM structure; this layer owns the
/// document policy, app CSS, and private image-resource rewrite.
enum SelectableMarkdownDocument {
    private static let fontAssets: (css: String, reads: Int) = {
        let definitions = [
            (resource: "DMSans-Regular", family: DesignTypographyAdapter.uiFamily, weight: 400),
            (resource: "DMSans-SemiBold", family: DesignTypographyAdapter.uiFamily, weight: 600),
            (resource: "DMSans-Bold", family: DesignTypographyAdapter.uiFamily, weight: 700),
            (resource: "JetBrainsMono-Regular", family: DesignTypographyAdapter.monoFamily, weight: 400),
        ]
        var reads = 0
        let faces = definitions.compactMap { definition -> String? in
            guard let url = SelectableMarkdownBundle.url(
                forResource: definition.resource,
                withExtension: "ttf"
            ), let data = try? Data(contentsOf: url) else { return nil }
            reads += 1
            let source = "data:font/ttf;base64,\(data.base64EncodedString())"
            return "@font-face { font-family: '\(cssString(definition.family))'; " +
                "font-style: normal; font-weight: \(definition.weight); font-display: block; " +
                "src: url('\(source)') format('truetype'); }"
        }
        return (faces.joined(separator: "\n"), reads)
    }()

    static var fontAssetReadCount: Int { fontAssets.reads }

    /// MarkdownUI's public `MarkdownContent.renderHTML()` rebuilds its AST
    /// before handing it back to cmark. cmark-gfm custom table cells need span
    /// metadata that rebuild path does not restore, so HTML contains empty cells
    /// and loose text. Render original source through same registered cmark-gfm
    /// extensions instead of adding another Markdown parser.
    private static func renderHTML(_ markdown: String) -> String {
        cmark_gfm_core_extensions_ensure_registered()
        let parser = cmark_parser_new(CMARK_OPT_DEFAULT)
        defer { cmark_parser_free(parser) }

        for name in ["autolink", "strikethrough", "tagfilter", "tasklist", "table"] {
            guard let syntaxExtension = cmark_find_syntax_extension(name) else { continue }
            cmark_parser_attach_syntax_extension(parser, syntaxExtension)
        }

        cmark_parser_feed(parser, markdown, markdown.utf8.count)
        guard let document = cmark_parser_finish(parser) else { return "" }
        defer { cmark_node_free(document) }
        guard let html = cmark_render_html(document, CMARK_OPT_DEFAULT, nil) else { return "" }
        defer { free(html) }
        return String(cString: html)
    }

    static func html(for markdown: String) -> String {
        html(for: markdown, compatibleWith: .current, usePrivateImageScheme: false)
    }

    static func html(
        for markdown: String,
        compatibleWith traits: UITraitCollection,
        usePrivateImageScheme: Bool = false,
        documentGeneration: Int? = nil,
        nonce: String? = nil
    ) -> String {
        var body = sanitizedHTML(renderHTML(markdown))
        if usePrivateImageScheme { body = rewriteImageSources(in: body) }
        let styleNonce = nonce ?? UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let imageSources = usePrivateImageScheme
            ? "\(SelectableMarkdownHostView.imageScheme): data:"
            : "data: http: https:"
        return """
        <!doctype html>
        <html lang="en"\(documentGeneration.map { " data-sentient-content-generation=\"\($0)\"" } ?? "")>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; connect-src 'none'; script-src 'none'; style-src 'nonce-\(styleNonce)'; font-src data:; img-src \(imageSources)">
        <style nonce="\(styleNonce)">\(SelectableMarkdownDocument.stylesheet(compatibleWith: traits))</style>
        </head>
        <body><article>\(body)</article></body>
        </html>
        """
    }

    private static func stylesheet(compatibleWith traits: UITraitCollection) -> String {
        let bodySize = UIFontMetrics(forTextStyle: .body).scaledValue(
            for: TypeScale.base,
            compatibleWith: traits
        )
        let codeSize = bodySize * 0.92
        let ink = color(DesignV2.ColorToken.ink)
        let ink2 = color(DesignV2.ColorToken.inkSecondary)
        let accent = color(DesignV2.ColorToken.ember)
        let elevated = color(DesignV2.ColorToken.elevated)
        let line = color(DesignV2.ColorToken.line)

        let fontFaces = fontAssets.css

        return """
        \(fontFaces)
        * { box-sizing: border-box; }
        html, body { width: 100%; min-height: 0; overflow: hidden; }
        html { -webkit-text-size-adjust: 100%; }
        body {
          margin: 0;
          padding: 0;
          direction: \(traits.layoutDirection == .rightToLeft ? "rtl" : "ltr");
          color: \(ink);
          background: transparent;
          font-family: '\(cssString(DesignTypographyAdapter.uiFamily))', -apple-system, BlinkMacSystemFont, sans-serif;
          font-size: \(bodySize)px;
          line-height: 1.45;
          overflow-wrap: anywhere;
          -webkit-user-select: text;
          user-select: text;
        }
        article {
          display: flex;
          flex-direction: column;
          gap: 0.85em;
          width: 100%;
          margin: 0;
          padding: 0;
        }
        article > p + p { margin-top: -0.85em; }
        p { margin: 0 0 2.7px; }
        p:last-child { margin-bottom: 0; }
        h1, h2, h3, h4, h5, h6 {
          margin: 0;
          font-weight: 400;
          font-size: 1em;
          line-height: 1.2;
        }
        a { color: \(accent); }
        strong { font-weight: 600; }
        em { font-style: italic; }
        del { text-decoration: line-through; }
        ul, ol {
          margin: 0;
          padding-left: 0;
          padding-inline-start: 1.6em;
          line-height: 1.2;
        }
        li + li { margin-top: 0; }
        li, li > p { line-height: 1.2; }
        li > p { margin-bottom: 0; }
        blockquote {
          margin: 0;
          padding: 0;
          padding-inline-start: \(Space.md)px;
          line-height: 1.2;
          border: 0;
          border-inline-start: 2px solid \(line);
          color: \(ink2);
        }
        blockquote p { margin-bottom: 0; }
        pre {
          margin: 0;
          padding: \(Space.md)px;
          color: \(ink);
          background: \(elevated);
          border-radius: \(Radii.sm)px;
          font-family: '\(cssString(DesignTypographyAdapter.monoFamily))', ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: \(codeSize)px;
          line-height: 1.2;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          overflow-x: auto;
        }
        :not(pre) > code {
          padding: 0 .2em;
          color: \(ink);
          background: \(elevated);
          border-radius: 3px;
          font-family: '\(cssString(DesignTypographyAdapter.monoFamily))', ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: .92em;
        }
        table {
          width: 100%;
          margin: 0;
          border-collapse: collapse;
          table-layout: auto;
        }
        th, td {
          padding: .53em .72em;
          border: 1px solid \(line);
          text-align: start;
          vertical-align: top;
        }
        th { font-weight: 600; }
        th[align="center"], td[align="center"] { text-align: center; }
        th[align="right"], td[align="right"] { text-align: right; }
        table p { margin: 0; }
        hr { margin: 0; border: 0; border-top: 1px solid \(line); }
        img { max-width: 100%; height: auto; vertical-align: middle; }
        input[type="checkbox"] { margin-right: .4em; vertical-align: middle; }
        """
    }

    private static func sanitizedHTML(_ html: String) -> String {
        let dangerous = try! NSRegularExpression(
            pattern: #"(?is)<(script|style|iframe|object|embed|form)\b[^>]*>.*?</\1\s*>"#
        )
        var result = dangerous.stringByReplacingMatches(
            in: html,
            range: NSRange(html.startIndex..., in: html),
            withTemplate: ""
        )
        let javascript = try! NSRegularExpression(
            pattern: #"(?i)(?:href|src)\s*=\s*(['"])\s*javascript:[^'\"]*\1"#
        )
        result = javascript.stringByReplacingMatches(
            in: result,
            range: NSRange(result.startIndex..., in: result),
            withTemplate: ""
        )
        return result
    }

    private static func rewriteImageSources(in html: String) -> String {
        let pattern = try! NSRegularExpression(
            pattern: #"(?i)(<img\b[^>]*\bsrc\s*=\s*)(['\"])([^'\"]+)\2"#
        )
        var result = html
        for match in pattern.matches(in: html, range: NSRange(html.startIndex..., in: html)).reversed() {
            guard let sourceRange = Range(match.range(at: 3), in: html) else { continue }
            // Undo only cmark's href attribute escaping, once. Decode ampersands
            // last so a literal entity in the URL is not decoded a second time.
            let sourceText = String(html[sourceRange])
                .replacingOccurrences(of: "&#x27;", with: "'")
                .replacingOccurrences(of: "&amp;", with: "&")
            guard let source = URL(string: sourceText),
                  let replacementURL = privateImageURL(for: source),
                  let prefixRange = Range(match.range(at: 1), in: html),
                  let quoteRange = Range(match.range(at: 2), in: html),
                  let fullRange = Range(match.range, in: result) else { continue }
            let prefix = String(html[prefixRange])
            let quote = String(html[quoteRange])
            result.replaceSubrange(fullRange, with: prefix + quote + replacementURL.absoluteString + quote)
        }
        return result
    }

    static func privateImageURL(for source: URL) -> URL? {
        guard let scheme = source.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return nil
        }
        let token = Data(source.absoluteString.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return URL(string: "\(SelectableMarkdownHostView.imageScheme)://cache/\(token)")
    }

    private static func cssString(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
    }

    private static func color(_ token: DesignV2.ColorToken) -> String {
        String(format: "#%06llX", UInt64(bitPattern: token.argb) & 0x00FF_FFFF)
    }
}

private final class SelectableMarkdownBundleToken: NSObject {}

private enum SelectableMarkdownBundle {
    static let bundle = Bundle(for: SelectableMarkdownBundleToken.self)

    static func url(forResource resource: String, withExtension extension: String) -> URL? {
        bundle.url(forResource: resource, withExtension: `extension`)
    }
}
