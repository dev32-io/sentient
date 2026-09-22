import Foundation
import ImageIO
import MarkdownUI
import NetworkImage
import SwiftUI
import UniformTypeIdentifiers

final class MarkdownImageCache {
    enum Metadata: Equatable {
        case size(CGSize)
        case failure
    }

    let loader: any NetworkImageLoader
    private let decoded = NSCache<NSURL, CGImage>()
    private let entries = NSMapTable<NSURL, MarkdownImageEntry>(
        keyOptions: .strongMemory,
        valueOptions: .weakMemory
    )
    private var metadata: [URL: Metadata] = [:]
    private let encoded = NSCache<NSURL, NSData>()
    private let pngEncoder: @Sendable (CGImage) -> Data?

    init(
        loader: any NetworkImageLoader = DefaultNetworkImageLoader.shared,
        decodedCountLimit: Int = 24,
        decodedCostLimit: Int = 16 * 1_024 * 1_024,
        pngEncoder: @escaping @Sendable (CGImage) -> Data? = MarkdownImageCache.encodePNG
    ) {
        self.loader = loader
        self.pngEncoder = pngEncoder
        decoded.countLimit = decodedCountLimit
        decoded.totalCostLimit = decodedCostLimit
        encoded.countLimit = decodedCountLimit
        encoded.totalCostLimit = decodedCostLimit
    }

    func entry(for url: URL) -> MarkdownImageEntry {
        if let entry = entries.object(forKey: url as NSURL) { return entry }
        let entry = MarkdownImageEntry(metadata: metadata[url])
        entries.setObject(entry, forKey: url as NSURL)
        return entry
    }

    func image(for url: URL) -> CGImage? { decoded.object(forKey: url as NSURL) }
    func knownMetadata(for url: URL) -> Metadata? { metadata[url] }

    /// Loads through same cache used by MarkdownUI, then hands WebKit encoded
    /// bytes over private scheme. WebKit never receives original network URLs.
    @MainActor
    func imageData(for url: URL) async -> Data? {
        guard !Task.isCancelled else { return nil }
        if let data = encoded.object(forKey: url as NSURL) { return data as Data }
        if let image = image(for: url) {
            return await encodedData(for: url, image: image)
        }

        let entry = entry(for: url)
        let lease = entry.lease()
        defer { lease.release() }
        do {
            let image = try await withTaskCancellationHandler {
                try await entry.image(url: url, using: loader)
            } onCancel: {
                Task { @MainActor in lease.release() }
            }
            guard !Task.isCancelled else { return nil }
            store(image, for: url)
            entry.markKnown(image)
            return await encodedData(for: url, image: image)
        } catch is CancellationError {
            return nil
        } catch {
            guard !Task.isCancelled else { return nil }
            metadata[url] = .failure
            entry.markFailure()
            return nil
        }
    }

    func acquire(_ entry: MarkdownImageEntry, for url: URL) {
        entry.acquire()
        guard image(for: url) == nil else { return }
        entry.load(url: url, using: loader) { [weak self] image in
            self?.store(image, for: url)
        } onFailure: { [weak self] in
            self?.metadata[url] = .failure
        }
    }

    func release(_ entry: MarkdownImageEntry) { entry.release() }

    deinit {
        for entry in entries.objectEnumerator()?.allObjects as? [MarkdownImageEntry] ?? [] {
            entry.cancel()
        }
    }

    private func store(_ image: CGImage, for url: URL) {
        metadata[url] = .size(CGSize(width: image.width, height: image.height))
        decoded.setObject(
            image,
            forKey: url as NSURL,
            cost: max(1, image.bytesPerRow * image.height)
        )
    }

    @MainActor
    private func encodedData(for url: URL, image: CGImage) async -> Data? {
        guard !Task.isCancelled else { return nil }
        if let data = encoded.object(forKey: url as NSURL) { return data as Data }
        let worker = Task.detached(priority: .utility) { [pngEncoder] () -> Data? in
            guard !Task.isCancelled else { return nil }
            return pngEncoder(image)
        }
        let data = await withTaskCancellationHandler {
            await worker.value
        } onCancel: {
            worker.cancel()
        }
        guard !Task.isCancelled, let data else { return nil }
        encoded.setObject(
            data as NSData,
            forKey: url as NSURL,
            cost: max(1, data.count)
        )
        return data
    }

    static func encodePNG(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data as CFMutableData,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}

final class MarkdownImageEntry: ObservableObject {
    enum Result: Equatable {
        case unresolved
        case known(CGSize)
        case failure
    }

    @Published private(set) var result: Result
    private var task: Task<CGImage, Error>?
    private var observedGeneration: Int?
    private var consumers = 0
    private var generation = 0

    init(metadata: MarkdownImageCache.Metadata?) {
        switch metadata {
        case let .size(size): result = .known(size)
        case .failure: result = .failure
        case nil: result = .unresolved
        }
    }

    func acquire() { consumers += 1 }

    fileprivate func lease() -> MarkdownImageLease {
        acquire()
        return MarkdownImageLease(entry: self)
    }

    func release() {
        consumers = max(0, consumers - 1)
        if consumers == 0 { cancel() }
    }

    func image(
        url: URL,
        using loader: any NetworkImageLoader
    ) async throws -> CGImage {
        guard consumers > 0 else { throw CancellationError() }
        let (request, requestGeneration) = startTask(url: url, using: loader)
        do {
            let image = try await request.value
            clearTask(for: requestGeneration)
            return image
        } catch {
            clearTask(for: requestGeneration)
            throw error
        }
    }

    func load(
        url: URL,
        using loader: any NetworkImageLoader,
        onSuccess: @escaping (CGImage) -> Void,
        onFailure: @escaping () -> Void
    ) {
        guard consumers > 0, result != .failure else { return }
        let (request, requestGeneration) = startTask(url: url, using: loader)
        guard observedGeneration != requestGeneration else { return }
        observedGeneration = requestGeneration
        Task { @MainActor [weak self] in
            do {
                let image = try await request.value
                guard let self, !Task.isCancelled,
                      generation == requestGeneration, consumers > 0 else { return }
                onSuccess(image)
                result = .known(CGSize(width: image.width, height: image.height))
                clearObserver(for: requestGeneration)
                clearTask(for: requestGeneration)
            } catch is CancellationError {
                self?.clearObserver(for: requestGeneration)
                self?.clearTask(for: requestGeneration)
            } catch {
                guard let self else { return }
                guard generation == requestGeneration, consumers > 0 else {
                    clearObserver(for: requestGeneration)
                    clearTask(for: requestGeneration)
                    return
                }
                onFailure()
                result = .failure
                clearObserver(for: requestGeneration)
                clearTask(for: requestGeneration)
            }
        }
    }

    func markKnown(_ image: CGImage) {
        result = .known(CGSize(width: image.width, height: image.height))
    }

    func markFailure() { result = .failure }

    func cancel() {
        generation += 1
        observedGeneration = nil
        task?.cancel()
        task = nil
    }

    private func startTask(
        url: URL,
        using loader: any NetworkImageLoader
    ) -> (Task<CGImage, Error>, Int) {
        if let task { return (task, generation) }
        generation += 1
        let requestGeneration = generation
        let task = Task { @MainActor in
            try await loader.image(from: url)
        }
        self.task = task
        return (task, requestGeneration)
    }

    private func clearObserver(for requestGeneration: Int) {
        guard observedGeneration == requestGeneration else { return }
        observedGeneration = nil
    }

    private func clearTask(for requestGeneration: Int) {
        guard generation == requestGeneration else { return }
        task = nil
    }

    deinit { task?.cancel() }
}

fileprivate final class MarkdownImageLease {
    private let entry: MarkdownImageEntry
    private var released = false

    init(entry: MarkdownImageEntry) {
        self.entry = entry
    }

    func release() {
        guard !released else { return }
        released = true
        entry.release()
    }

    deinit { release() }
}

struct CachedMarkdownImageProvider: ImageProvider {
    let cache: MarkdownImageCache
    let loadsUnresolved: Bool

    func makeImage(url: URL?) -> some View {
        Group {
            if let url {
                CachedMarkdownImage(
                    url: url,
                    entry: cache.entry(for: url),
                    cache: cache,
                    loadsUnresolved: loadsUnresolved
                )
            } else {
                Color.clear.frame(width: 0, height: 0)
            }
        }
    }
}

private struct CachedMarkdownImage: View {
    let url: URL
    @ObservedObject var entry: MarkdownImageEntry
    let cache: MarkdownImageCache
    let loadsUnresolved: Bool
    @State private var leased = false

    @ViewBuilder var body: some View {
        switch entry.result {
        case .unresolved:
            Color.clear.frame(width: 0, height: 0)
                .onAppear { acquireIfNeeded() }
                .onDisappear { releaseIfNeeded() }
        case let .known(size):
            MarkdownImageFit(idealSize: size) {
                if let image = cache.image(for: url) {
                    Image(decorative: image, scale: 1).resizable()
                } else {
                    Color.clear
                }
            }
            .onAppear { acquireIfNeeded() }
            .onDisappear { releaseIfNeeded() }
        case .failure:
            Color.clear.frame(width: 0, height: 0)
        }
    }

    private func acquireIfNeeded() {
        guard loadsUnresolved, !leased else { return }
        leased = true
        cache.acquire(entry, for: url)
    }

    private func releaseIfNeeded() {
        guard leased else { return }
        leased = false
        cache.release(entry)
    }
}

private struct MarkdownImageFit: Layout {
    let idealSize: CGSize

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        guard let width = proposal.width, width < idealSize.width else { return idealSize }
        return CGSize(width: width, height: width * idealSize.height / idealSize.width)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        subviews.first?.place(at: bounds.origin, proposal: .init(bounds.size))
    }
}
