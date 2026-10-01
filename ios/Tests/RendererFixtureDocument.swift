import Foundation
import NetworkImage
import UIKit

/// Bounded R0 fixture, not a Markdown parser or production message model.
/// One UTF-16 address space; tabs separate cells, newlines separate rows/blocks.
struct R0Document {
    var before: String
    var rows: [[String]]
    var after: String

    static let fixture = R0Document(
        before: "Before café 👩🏽‍💻 — select from here into any cell.",
        rows: [
            ["Name", "Observation", "Value"],
            ["Alpha café", "partial 👩🏽‍💻 text e\u{301}", "42 | units"],
            ["Beta 東京", "Readable wide column with retained horizontal position", "7\\8"]
        ],
        after: "After table — selection continues here. Stream: "
    )

    var plain: String { before + "\n" + rows.map { $0.joined(separator: "\t") }.joined(separator: "\n") + "\n" + after }
    var tableMarkdown: String {
        func row(_ cells: [String]) -> String {
            "| " + cells.map {
                $0.replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "|", with: "\\|")
                    .replacingOccurrences(of: "\n", with: "<br>")
            }.joined(separator: " | ") + " |"
        }
        guard let header = rows.first else { return "" }
        return ([row(header), row(header.map { _ in "---" })] + rows.dropFirst().map(row)).joined(separator: "\n")
    }
    func plain(in range: NSRange) -> String { (plain as NSString).substring(with: range) }
}

// Shared controllable loader: fixtures cannot perform a network request.
actor DelayedImageLoader: NetworkImageLoader {
    private var continuations: [URL: [CheckedContinuation<CGImage, Error>]] = [:]
    private var resolved: [URL: CGImage] = [:]
    private var requests: [URL: Int] = [:]
    private var cancellations: [URL: Int] = [:]

    func image(from url: URL) async throws -> CGImage {
        requests[url, default: 0] += 1
        if let image = resolved[url] { return image }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                continuations[url, default: []].append(continuation)
            }
        } onCancel: {
            Task { await self.cancel(url: url) }
        }
    }

    func resolve(url: URL, image: CGImage) {
        resolved[url] = image
        continuations.removeValue(forKey: url)?.forEach { $0.resume(returning: image) }
    }

    func reject(url: URL) {
        continuations.removeValue(forKey: url)?.forEach { $0.resume(throwing: URLError(.cannotDecodeContentData)) }
    }

    func requestCount(for url: URL) -> Int { requests[url, default: 0] }
    func cancellationCount(for url: URL) -> Int { cancellations[url, default: 0] }

    private func cancel(url: URL) {
        cancellations[url, default: 0] += 1
        continuations.removeValue(forKey: url)?.forEach { $0.resume(throwing: CancellationError()) }
    }
}

func testImage(width: Int, height: Int) -> CGImage {
    let context = CGContext(
        data: nil, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.setFillColor(UIColor.systemBlue.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()!
}

