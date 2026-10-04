import Foundation
import Testing
@testable import SentientApp

@MainActor
struct MarkdownImageCacheTests {
    @Test(arguments: [
        "https://example.com/image.png?w=2&h=3",
        "https://example.com/image.png?name=O'Reilly&encoded=%26amp%3B",
        "https://example.com/image.png?literal=&#x27;",
    ])
    func parsedImageURLReachesExistingLoaderUnchanged(sourceText: String) async throws {
        let source = try #require(URL(string: sourceText))
        let escaped = sourceText.replacingOccurrences(of: "&", with: "&amp;")
        let document = MessageDocument(source: "![fixture](\(escaped))")
        let url = try #require(document.media.first?.url)
        #expect(url == source)
        let loader = DelayedImageLoader()
        await loader.resolve(url: url, image: testImage(width: 32, height: 24))
        let cache = MarkdownImageCache(loader: loader)
        #expect(await cache.imageData(for: url) != nil)
        #expect(await loader.requestCount(for: source) == 1)
    }

    @Test func pngEncodingRunsOffMainAndReusesCachedBytes() async throws {
        let loader = DelayedImageLoader()
        let probe = EncodingProbe()
        let cache = MarkdownImageCache(loader: loader, pngEncoder: { image in
            let onMain = Thread.isMainThread
            Task { await probe.record(onMain: onMain) }
            return Data(repeating: 7, count: max(1, image.width))
        })
        let url = URL(string: "https://fixture.invalid/encoded.png")!
        await loader.resolve(url: url, image: testImage(width: 4, height: 3))
        let first = await cache.imageData(for: url)
        let second = await cache.imageData(for: url)
        await probe.waitForRecord()
        let (count, encodedOnMain) = await probe.snapshot()
        #expect(first == second)
        #expect(count == 1)
        #expect(!encodedOnMain)
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
