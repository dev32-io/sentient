import MarkdownUI
import NetworkImage
import SwiftUI

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

    init(
        loader: any NetworkImageLoader = DefaultNetworkImageLoader.shared,
        decodedCountLimit: Int = 24,
        decodedCostLimit: Int = 16 * 1_024 * 1_024
    ) {
        self.loader = loader
        decoded.countLimit = decodedCountLimit
        decoded.totalCostLimit = decodedCostLimit
    }

    func entry(for url: URL) -> MarkdownImageEntry {
        if let entry = entries.object(forKey: url as NSURL) { return entry }
        let entry = MarkdownImageEntry(metadata: metadata[url])
        entries.setObject(entry, forKey: url as NSURL)
        return entry
    }

    func image(for url: URL) -> CGImage? { decoded.object(forKey: url as NSURL) }
    func knownMetadata(for url: URL) -> Metadata? { metadata[url] }

    func acquire(_ entry: MarkdownImageEntry, for url: URL) {
        entry.acquire()
        guard image(for: url) == nil else { return }
        entry.load(url: url, using: loader) { [weak self] image in
            guard let self else { return }
            let size = CGSize(width: image.width, height: image.height)
            metadata[url] = .size(size)
            decoded.setObject(
                image,
                forKey: url as NSURL,
                cost: max(1, image.bytesPerRow * image.height)
            )
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
}

final class MarkdownImageEntry: ObservableObject {
    enum Result: Equatable {
        case unresolved
        case known(CGSize)
        case failure
    }

    @Published private(set) var result: Result
    private var task: Task<Void, Never>?
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

    func release() {
        consumers = max(0, consumers - 1)
        if consumers == 0 { cancel() }
    }

    func load(
        url: URL,
        using loader: any NetworkImageLoader,
        onSuccess: @escaping (CGImage) -> Void,
        onFailure: @escaping () -> Void
    ) {
        guard consumers > 0, task == nil, result != .failure else { return }
        generation += 1
        let currentGeneration = generation
        task = Task { @MainActor [weak self] in
            do {
                let image = try await loader.image(from: url)
                guard let self, !Task.isCancelled,
                      generation == currentGeneration, consumers > 0 else { return }
                onSuccess(image)
                result = .known(CGSize(width: image.width, height: image.height))
                task = nil
            } catch is CancellationError {
                return
            } catch {
                guard let self, generation == currentGeneration, consumers > 0 else { return }
                onFailure()
                result = .failure
                task = nil
            }
        }
    }

    func cancel() {
        generation += 1
        task?.cancel()
        task = nil
    }

    deinit { task?.cancel() }
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
