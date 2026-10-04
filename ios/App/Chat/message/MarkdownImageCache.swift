import Foundation
import ImageIO
import NetworkImage
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
        let entry = MarkdownImageEntry()
        entries.setObject(entry, forKey: url as NSURL)
        return entry
    }

    func image(for url: URL) -> CGImage? { decoded.object(forKey: url as NSURL) }
    func knownMetadata(for url: URL) -> Metadata? { metadata[url] }

    /// Reuses the existing loader, shared leases and off-main PNG cache for the
    /// native renderer. Consumer cancellation never cancels another live lease.
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
            return await encodedData(for: url, image: image)
        } catch is CancellationError {
            return nil
        } catch {
            guard !Task.isCancelled else { return nil }
            metadata[url] = .failure
            return nil
        }
    }

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

final class MarkdownImageEntry {
    private var task: Task<CGImage, Error>?
    private var consumers = 0
    private var generation = 0

    func acquire() { consumers += 1 }

    fileprivate func lease() -> MarkdownImageLease {
        acquire()
        return MarkdownImageLease(entry: self)
    }

    func release() {
        consumers = max(0, consumers - 1)
        if consumers == 0 { cancel() }
    }

    // Async nonisolated methods hop to the generic executor. Keep lookup and
    // creation serialized with leases, or concurrent consumers start two loads.
    @MainActor
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

    func cancel() {
        generation += 1
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
