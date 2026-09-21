import Foundation
import NetworkImage
import Testing
import UIKit
import WebKit
@testable import SentientApp

@MainActor
@Suite(.serialized)
struct SelectableMarkdownImageTests {
    private enum TestError: Error {
        case timedOut
    }

    @Test func nativeAndWebImageDemandCoalescesLoaderRequest() async throws {
        let loader = ControlledImageLoader()
        let cache = MarkdownImageCache(loader: loader)
        let url = URL(string: "https://fixture.invalid/coalesced.png")!
        let webTask = Task { @MainActor in
            await cache.imageData(for: url)
        }
        try await waitUntil { await loader.requestCount() == 1 }

        let entry = cache.entry(for: url)
        cache.acquire(entry, for: url)
        await loader.resolve(image: makeImage(width: 32, height: 24))

        let webData = await webTask.value
        let requestCount = await loader.requestCount()
        #expect(webData != nil)
        #expect(requestCount == 1)
        cache.release(entry)
    }

    @Test(arguments: [
        "https://example.com/image.png?w=2&h=3",
        "https://example.com/image.png?name=O'Reilly&encoded=%26amp%3B",
        "https://example.com/image.png?literal=&#x27;",
    ])
    func escapedImageURLReachesLoaderUnchangedAndFinishesInOrder(sourceText: String) async throws {
        let source = try #require(URL(string: sourceText))
        // Escape the Markdown input once as well, so literal URL entities survive
        // Markdown parsing before the HTML-attribute/private-scheme round trip.
        let markdownURL = sourceText.replacingOccurrences(of: "&", with: "&amp;")
        let html = SelectableMarkdownDocument.html(
            for: "![fixture](\(markdownURL))", compatibleWith: .current,
            usePrivateImageScheme: true
        )
        let range = try #require(html.range(
            of: #"sentient-image://cache/[A-Za-z0-9_-]+"#, options: .regularExpression
        ))
        let resource = try #require(URL(string: String(html[range])))
        #expect(SelectableMarkdownImageSchemeHandler.sourceURL(from: resource) == source)

        let loader = ControlledImageLoader()
        let handler = SelectableMarkdownImageSchemeHandler(cache: MarkdownImageCache(loader: loader))
        let schemeTask = RecordingSchemeTask(request: URLRequest(url: resource))
        let webView = WKWebView()
        handler.webView(webView, start: schemeTask)
        try await waitUntil { await loader.requestCount() == 1 }
        await loader.resolve(image: makeImage(width: 32, height: 24))
        try await waitUntil { schemeTask.finishCount == 1 }

        #expect(await loader.receivedURLs() == [source])
        #expect(schemeTask.events == ["response", "data", "finish"])
        #expect(schemeTask.failureCount == 0)
    }

    @Test func stoppedImageRequestDropsLateCompletionCallbacks() async throws {
        let loader = ControlledImageLoader()
        let cache = MarkdownImageCache(loader: loader)
        let handler = SelectableMarkdownImageSchemeHandler(cache: cache)
        let source = URL(string: "https://fixture.invalid/late.png")!
        let resource = try #require(SelectableMarkdownDocument.privateImageURL(for: source))
        let schemeTask = RecordingSchemeTask(request: URLRequest(url: resource))
        let webView = WKWebView()

        handler.webView(webView, start: schemeTask)
        try await waitUntil { await loader.requestCount() == 1 }
        handler.webView(webView, stop: schemeTask)
        await loader.resolve(image: makeImage(width: 32, height: 24))
        for _ in 0..<8 { await Task.yield() }

        #expect(schemeTask.responseCount == 0)
        #expect(schemeTask.dataCount == 0)
        #expect(schemeTask.finishCount == 0)
        #expect(schemeTask.failureCount == 0)
    }

    @Test func activeImageFailureEmitsOneFailure() async throws {
        let loader = ControlledImageLoader()
        let cache = MarkdownImageCache(loader: loader)
        let handler = SelectableMarkdownImageSchemeHandler(cache: cache)
        let source = URL(string: "https://fixture.invalid/failure.png")!
        let resource = try #require(SelectableMarkdownDocument.privateImageURL(for: source))
        let schemeTask = RecordingSchemeTask(request: URLRequest(url: resource))
        let webView = WKWebView()

        handler.webView(webView, start: schemeTask)
        try await waitUntil { await loader.requestCount() == 1 }
        await loader.reject()
        try await waitUntil { schemeTask.failureCount == 1 }
        for _ in 0..<8 { await Task.yield() }

        #expect(schemeTask.responseCount == 0)
        #expect(schemeTask.dataCount == 0)
        #expect(schemeTask.finishCount == 0)
        #expect(schemeTask.failureCount == 1)
    }

    @Test func pngEncodingRunsOffMainAndReusesCachedBytes() async throws {
        let loader = ControlledImageLoader()
        let probe = EncodingProbe()
        let cache = MarkdownImageCache(loader: loader, pngEncoder: { image in
            let onMain = Thread.isMainThread
            Task { await probe.record(onMain: onMain) }
            return Data(repeating: 7, count: max(1, image.width))
        })
        let url = URL(string: "https://fixture.invalid/encoded.png")!
        await loader.resolve(image: makeImage(width: 4, height: 3))

        let first = await cache.imageData(for: url)
        let second = await cache.imageData(for: url)
        await probe.waitForRecord()
        let (count, encodedOnMain) = await probe.snapshot()

        #expect(first == second)
        #expect(count == 1)
        #expect(!encodedOnMain)
    }

    private func waitUntil(
        iterations: Int = 1_000,
        condition: @escaping () async -> Bool
    ) async throws {
        for _ in 0..<iterations {
            if await condition() { return }
            await Task.yield()
        }
        throw TestError.timedOut
    }
}

private actor ControlledImageLoader: NetworkImageLoader {
    private var pending: [CheckedContinuation<CGImage, Error>] = []
    private var resolved: CGImage?
    private var failure: Error?
    private var requests = 0
    private var urls: [URL] = []

    func image(from url: URL) async throws -> CGImage {
        requests += 1
        urls.append(url)
        if let resolved { return resolved }
        if let failure { throw failure }
        return try await withCheckedThrowingContinuation { continuation in
            pending.append(continuation)
        }
    }

    func resolve(image: CGImage) {
        resolved = image
        pending.forEach { $0.resume(returning: image) }
        pending.removeAll()
    }

    func reject() {
        let error = LoaderError.failed
        failure = error
        pending.forEach { $0.resume(throwing: error) }
        pending.removeAll()
    }

    func requestCount() -> Int { requests }
    func receivedURLs() -> [URL] { urls }

    private enum LoaderError: Error {
        case failed
    }
}

private final class RecordingSchemeTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    var responseCount = 0
    var dataCount = 0
    var finishCount = 0
    var failureCount = 0
    var events: [String] = []

    init(request: URLRequest) {
        self.request = request
    }

    func didReceive(_ response: URLResponse) {
        responseCount += 1
        events.append("response")
    }
    func didReceive(_ data: Data) {
        dataCount += 1
        events.append("data")
    }
    func didFinish() {
        finishCount += 1
        events.append("finish")
    }
    func didFailWithError(_ error: Error) {
        failureCount += 1
        events.append("failure")
    }
}

private actor EncodingProbe {
    private var count = 0
    private var encodedOnMain = false

    func record(onMain: Bool) {
        count += 1
        encodedOnMain = encodedOnMain || onMain
    }

    func waitForRecord() async {
        while count == 0 { await Task.yield() }
    }

    func snapshot() -> (Int, Bool) {
        (count, encodedOnMain)
    }
}

private func makeImage(width: Int, height: Int) -> CGImage {
    let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.setFillColor(UIColor.systemBlue.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()!
}
