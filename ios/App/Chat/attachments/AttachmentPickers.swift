import AVFoundation
import ImageIO
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

let attachmentFileImportTypes: [UTType] = [
    "jpg", "jpeg", "png", "heic", "heif", "avif", "webp", "gif", "tif", "tiff",
    "bmp", "jp2", "j2k", "j2c", "jpc", "jpf", "jpx", "jpm", "jxl", "dng",
].compactMap { UTType(filenameExtension: $0) } + [
    .pdf, .plainText, .commaSeparatedText, .sourceCode, .json,
]

/// Clipboard types accepted by both the native PasteButton and the text-input
/// paste override. URLs are intentionally absent: paste imports local item
/// provider representations only, never arbitrary network locations.
let attachmentPasteContentTypes: [UTType] = [
    .image, .livePhoto, .pdf, .fileURL, .plainText, .commaSeparatedText, .sourceCode, .json,
] + attachmentFileImportTypes

func attachmentPasteProviders(from providers: [NSItemProvider]) -> [NSItemProvider] {
    providers.filter { provider in
        provider.registeredTypeIdentifiers.contains { identifier in
            guard let providedType = UTType(identifier) else { return false }
            guard attachmentPasteContentTypes.contains(where: { providedType.conforms(to: $0) }) else {
                return false
            }
            // Plain clipboard text has no filename. Keep it on native text paste;
            // named text-file providers still enter durable attachment import.
            if providedType.conforms(to: .plainText),
               !providedType.conforms(to: .sourceCode),
               !providedType.conforms(to: .json),
               !providedType.conforms(to: .commaSeparatedText) {
                guard let name = provider.suggestedName,
                      let namedType = UTType(filenameExtension: URL(fileURLWithPath: name).pathExtension),
                      ChatViewModel.attachmentMediaType(for: namedType) != nil else {
                    return false
                }
            }
            return true
        }
    }
}

/// Native text must be detected from original clipboard providers. Filtering
/// first loses unnamed text when another provider is a named text attachment.
func attachmentPasteContainsNativeText(in providers: [NSItemProvider]) -> Bool {
    providers.contains { provider in
        guard provider.suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true else {
            return false
        }
        return provider.registeredTypeIdentifiers.contains { identifier in
            guard let type = UTType(identifier) else { return false }
            return type.conforms(to: .plainText) &&
                !type.conforms(to: .sourceCode) &&
                !type.conforms(to: .json) &&
                !type.conforms(to: .commaSeparatedText) &&
                !type.conforms(to: .fileURL) &&
                !type.conforms(to: .url)
        }
    }
}

@MainActor
protocol CameraAccessProviding {
    var isAvailable: Bool { get }
    var authorizationStatus: AVAuthorizationStatus { get }
    func requestAccess() async -> Bool
}

@MainActor
struct SystemCameraAccess: CameraAccessProviding {
    var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
    var authorizationStatus: AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .video)
    }

    func requestAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }
}

enum CameraAccessDecision: Equatable {
    case present, denied, restricted, unavailable
}

@MainActor
func cameraAccessDecision(using access: CameraAccessProviding) async -> CameraAccessDecision {
    guard access.isAvailable else { return .unavailable }
    switch access.authorizationStatus {
    case .authorized:
        return .present
    case .notDetermined:
        return await access.requestAccess() ? .present : .denied
    case .denied:
        return .denied
    case .restricted:
        return .restricted
    @unknown default:
        return .restricted
    }
}

struct AttachmentPhotoPicker: UIViewControllerRepresentable {
    let selectionLimit: Int
    let onSelection: ([NSItemProvider]) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = selectionLimit
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let parent: AttachmentPhotoPicker

        init(parent: AttachmentPhotoPicker) { self.parent = parent }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !results.isEmpty else {
                parent.onCancel()
                return
            }
            parent.onSelection(results.map(\.itemProvider))
        }
    }
}

/// Native document picker keeps provider URLs security-scoped for ChatViewModel's import scope.
struct AttachmentDocumentPicker: UIViewControllerRepresentable {
    let onSelection: ([URL]) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(
            forOpeningContentTypes: attachmentFileImportTypes,
            asCopy: false
        )
        picker.allowsMultipleSelection = true
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let parent: AttachmentDocumentPicker

        init(parent: AttachmentDocumentPicker) { self.parent = parent }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            guard !urls.isEmpty else {
                parent.onCancel()
                return
            }
            parent.onSelection(urls)
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            parent.onCancel()
        }
    }
}

/// Materializes user-selected clipboard providers into owned temporary files.
/// The result enters the same AttachmentImportItem → ChatViewModel admission
/// path as Files/Photos; this helper never reads URL strings or fetches URLs.
enum AttachmentPasteImport {
    static func prepare(_ providers: [NSItemProvider]) async throws -> [AttachmentImportItem] {
        var imports: [AttachmentImportItem] = []
        do {
            for provider in attachmentPasteProviders(from: providers) {
                let item = try await prepare(provider)
                imports.append(item)
                try Task.checkCancellation()
            }
            guard !imports.isEmpty else { throw CocoaError(.fileReadUnsupportedScheme) }
            return imports
        } catch {
            for url in Set(imports.flatMap(\.ownedTemporaryURLs)) {
                try? FileManager.default.removeItem(at: url)
            }
            throw error
        }
    }

    static func prepare(_ provider: NSItemProvider) async throws -> AttachmentImportItem {
        let registered = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
        guard let type = registered.first(where: { type in
            type.conforms(to: .image) || type.conforms(to: .livePhoto) ||
                AttachmentDNGImport.isDNGTypeIdentifier(type.identifier)
        }) ?? registered.first(where: { type in
            attachmentPasteContentTypes.contains(where: { type.conforms(to: $0) })
        }) else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }

        if type.conforms(to: .image) || type.conforms(to: .livePhoto) ||
            AttachmentDNGImport.isDNGTypeIdentifier(type.identifier) {
            return try await AttachmentPhotoImport.prepare(provider)
        }

        if type.conforms(to: .fileURL) {
            let copied = try await AttachmentPhotoImport.copyFileRepresentation(
                typeIdentifier: type.identifier
            ) { completion in
                provider.loadFileRepresentation(
                    forTypeIdentifier: type.identifier,
                    completionHandler: completion
                )
            }
            var keepCopy = false
            defer {
                if !keepCopy { try? FileManager.default.removeItem(at: copied) }
            }
            try Task.checkCancellation()
            let values = try copied.resourceValues(forKeys: [.contentTypeKey, .nameKey])
            guard let mediaType = values.contentType.flatMap(ChatViewModel.attachmentMediaType(for:))
                    ?? ChatViewModel.attachmentMediaType(forExtension: copied.pathExtension) else {
                throw CocoaError(.fileReadUnsupportedScheme)
            }
            let item = AttachmentImportItem.temporary(
                copied,
                displayName: pasteDisplayName(
                    provider.suggestedName ?? values.name,
                    fallbackExtension: copied.pathExtension
                ),
                mediaType: mediaType,
                source: .files
            )
            keepCopy = true
            return item
        }

        guard let mediaType = ChatViewModel.attachmentMediaType(for: type) else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        let copied = try await AttachmentPhotoImport.copyFileRepresentation(
            typeIdentifier: type.identifier
        ) { completion in
            provider.loadFileRepresentation(
                forTypeIdentifier: type.identifier,
                completionHandler: completion
            )
        }
        return .temporary(
            copied,
            displayName: pasteDisplayName(
                provider.suggestedName,
                fallbackExtension: type.preferredFilenameExtension
            ),
            mediaType: mediaType,
            source: .files
        )
    }

    private static func pasteDisplayName(_ suggested: String?, fallbackExtension: String?) -> String {
        let name = suggested?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let name, !name.isEmpty else {
            return "Attachment\(fallbackExtension.map { ".\($0)" } ?? "")"
        }
        guard let fallbackExtension, !fallbackExtension.isEmpty,
              !name.lowercased().hasSuffix(".\(fallbackExtension.lowercased())") else {
            return name
        }
        return "\(name).\(fallbackExtension)"
    }
}

enum AttachmentPhotoImport {
    static let maximumSourceBytes: Int64 = 512 * 1_024 * 1_024
    static let providerExportDeadline: Duration = .seconds(120)
    private static let maximumPackageEntries = 10_000
    private static let livePhotoMediaType = "application/vnd.sentient.live-photo+zip"

    static func prepare(_ selection: [NSItemProvider]) async throws -> [AttachmentImportItem] {
        var imports: [AttachmentImportItem] = []
        do {
            for provider in selection {
                let item = try await prepare(provider)
                imports.append(item)
                try Task.checkCancellation()
            }
            return imports
        } catch {
            for url in Set(imports.flatMap(\.ownedTemporaryURLs)) {
                try? FileManager.default.removeItem(at: url)
            }
            throw error
        }
    }

    static func prepare(_ provider: NSItemProvider) async throws -> AttachmentImportItem {
        if let dngTypeIdentifier = dngTypeIdentifier(in: provider.registeredTypeIdentifiers) {
            let copied = try await copyFileRepresentation(provider, typeIdentifier: dngTypeIdentifier)
            return .temporary(
                copied,
                displayName: displayName(
                    provider.suggestedName,
                    fallback: "Image",
                    extension: "dng"
                ),
                mediaType: AttachmentDNGImport.dngMediaType,
                source: .photos
            )
        }
        guard !provider.registeredTypeIdentifiers.contains(where: isRawImage) else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.livePhoto.identifier) {
            return try await prepareLivePhoto(provider)
        }
        guard let representation = preferredImageRepresentation(in: provider.registeredTypeIdentifiers) else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        let copied = try await copyFileRepresentation(provider, typeIdentifier: representation.type.identifier)
        return .temporary(
            copied,
            displayName: displayName(
                provider.suggestedName,
                fallback: "Image",
                extension: representation.extension
            ),
            mediaType: representation.mediaType,
            source: .photos
        )
    }

    private static func prepareLivePhoto(_ provider: NSItemProvider) async throws -> AttachmentImportItem {
        let package = try await copyFileRepresentation(provider, typeIdentifier: UTType.livePhoto.identifier)
        defer { try? FileManager.default.removeItem(at: package) }

        let resources = try livePhotoResources(in: package)
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-live-photo-\(UUID().uuidString)", isDirectory: true)
        let directory = root.appendingPathComponent("live-photo", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let stillName = "still.\(resources.still.extension)"
        let still = directory.appendingPathComponent(stillName)
        let motion = directory.appendingPathComponent("motion.mov")
        let manifest = try livePhotoManifest(stillName: stillName, mediaType: resources.still.mediaType)
        guard manifest.count <= maximumSourceBytes else { throw CocoaError(.fileReadTooLarge) }
        var remaining = maximumSourceBytes - Int64(manifest.count)
        remaining -= try boundedCopyItem(at: resources.still.url, to: still, maximumBytes: remaining)
        remaining -= try boundedCopyItem(at: resources.motion, to: motion, maximumBytes: remaining)
        try manifest.write(to: directory.appendingPathComponent("manifest.json"), options: .atomic)
        _ = try boundedItemSize(at: directory, maximumBytes: maximumSourceBytes)

        let bundle = try coordinatedUploadArchive(of: directory)
        let preview = temporaryURL(extension: resources.still.extension)
        do {
            _ = try boundedCopyItem(at: still, to: preview, maximumBytes: maximumSourceBytes)
            return .temporary(
                bundle,
                displayName: displayName(
                    provider.suggestedName,
                    fallback: "Live Photo",
                    extension: "livephoto.zip"
                ),
                mediaType: livePhotoMediaType,
                previewSourceURL: preview,
                source: .photos
            )
        } catch {
            try? FileManager.default.removeItem(at: bundle)
            try? FileManager.default.removeItem(at: preview)
            throw error
        }
    }

    static func livePhotoManifest(stillName: String, mediaType: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "still": ["name": "live-photo/\(stillName)", "mediaType": mediaType],
            "motion": ["name": "live-photo/motion.mov", "mediaType": "video/quicktime"],
        ], options: [.sortedKeys])
    }

    private static func displayName(
        _ suggested: String?,
        fallback: String,
        extension pathExtension: String
    ) -> String {
        let name = suggested?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let name, !name.isEmpty else { return "\(fallback).\(pathExtension)" }
        return name.lowercased().hasSuffix(".\(pathExtension.lowercased())")
            ? name
            : "\(name).\(pathExtension)"
    }

    private static func preferredImageRepresentation(
        in identifiers: [String]
    ) -> (type: UTType, mediaType: String, extension: String)? {
        let representations = identifiers.compactMap { identifier -> (UTType, String, String)? in
            guard let type = UTType(identifier),
                  let mediaType = ChatViewModel.attachmentMediaType(for: type),
                  mediaType.hasPrefix("image/"),
                  let ext = ChatViewModel.canonicalImageExtension(for: mediaType) else { return nil }
            return (type, mediaType, ext)
        }
        return representations.first { $0.0.conforms(to: .gif) } ?? representations.first
    }

    private static func dngTypeIdentifier(in identifiers: [String]) -> String? {
        identifiers.first(where: AttachmentDNGImport.isDNGTypeIdentifier)
    }

    private static func isRawImage(_ identifier: String) -> Bool {
        UTType(identifier)?.conforms(to: .rawImage) == true
    }

    private static func livePhotoResources(
        in package: URL
    ) throws -> (still: (url: URL, mediaType: String, extension: String), motion: URL) {
        let urls: [URL]
        if (try package.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            urls = try boundedEntries(at: package, maximumBytes: maximumSourceBytes)
                .filter { !$0.isDirectory }
                .map(\.url)
        } else {
            urls = [package]
        }
        let motion = urls.first { $0.pathExtension.lowercased() == "mov" }
        let still = urls.compactMap { url -> (URL, String, String)? in
            let ext = url.pathExtension.lowercased()
            guard let mediaType = ChatViewModel.imageMediaType(forExtension: ext),
                  let canonical = ChatViewModel.canonicalImageExtension(for: mediaType) else { return nil }
            return (url, mediaType, canonical)
        }.first
        guard let still, let motion else { throw CocoaError(.fileReadCorruptFile) }
        return (still, motion)
    }

    private static func copyFileRepresentation(
        _ provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> URL {
        try await copyFileRepresentation(typeIdentifier: typeIdentifier) { completion in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier, completionHandler: completion)
        }
    }

    static func copyFileRepresentation(
        typeIdentifier: String,
        deadline: Duration = providerExportDeadline,
        load: @escaping (@escaping (URL?, Error?) -> Void) -> Progress
    ) async throws -> URL {
        let state = ProviderExportState()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                state.install(continuation)
                guard state.shouldStart else { return }
                state.startDeadline(deadline)
                let progress = load { source, error in
                    guard state.beginCallback() else { return }
                    guard let source else {
                        state.finish(.failure(error ?? CocoaError(.fileReadUnknown)))
                        return
                    }
                    let destination = temporaryURL(extension: source.pathExtension)
                    do {
                        _ = try boundedCopyItem(
                            at: source,
                            to: destination,
                            maximumBytes: maximumSourceBytes,
                            isCancelled: { state.abortError != nil }
                        )
                        state.finish(.success(destination))
                    } catch {
                        state.finish(.failure(error))
                    }
                }
                state.register(progress)
            }
        } onCancel: {
            state.abort(CancellationError())
        }
    }

    static func boundedCopyItem(
        at source: URL,
        to destination: URL,
        maximumBytes: Int64,
        isCancelled: () -> Bool = { Task.isCancelled }
    ) throws -> Int64 {
        guard maximumBytes >= 0 else { throw CocoaError(.fileReadTooLarge) }
        let values = try source.resourceValues(forKeys: [
            .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
        ])
        guard values.isSymbolicLink != true else { throw CocoaError(.fileReadInvalidFileName) }
        if values.isDirectory == true {
            let entries = try boundedEntries(
                at: source,
                maximumBytes: maximumBytes,
                isCancelled: isCancelled
            )
            do {
                try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
                for entry in entries where entry.isDirectory {
                    try FileManager.default.createDirectory(
                        at: destination.appendingPathComponent(entry.relativePath, isDirectory: true),
                        withIntermediateDirectories: true
                    )
                }
                var copied: Int64 = 0
                for entry in entries where !entry.isDirectory {
                    copied += try boundedCopyFile(
                        at: entry.url,
                        to: destination.appendingPathComponent(entry.relativePath),
                        maximumBytes: maximumBytes - copied,
                        isCancelled: isCancelled
                    )
                }
                return copied
            } catch {
                try? FileManager.default.removeItem(at: destination)
                throw error
            }
        }
        guard values.isRegularFile == true else { throw CocoaError(.fileReadUnsupportedScheme) }
        return try boundedCopyFile(
            at: source,
            to: destination,
            maximumBytes: maximumBytes,
            isCancelled: isCancelled
        )
    }

    private struct BoundedEntry {
        let url: URL
        let relativePath: String
        let isDirectory: Bool
        let size: Int64
    }

    private static func boundedEntries(
        at root: URL,
        maximumBytes: Int64,
        isCancelled: () -> Bool = { Task.isCancelled }
    ) throws -> [BoundedEntry] {
        let rootPath = root.standardizedFileURL.path
        var entries: [BoundedEntry] = []
        var total: Int64 = 0
        var pending = [root]
        while let directory = pending.popLast() {
            if isCancelled() { throw CancellationError() }
            for url in try FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
            ) {
                guard entries.count < maximumPackageEntries else { throw CocoaError(.fileReadTooLarge) }
                let path = url.standardizedFileURL.path
                guard path.hasPrefix(rootPath + "/") else { throw CocoaError(.fileReadInvalidFileName) }
                let values = try url.resourceValues(forKeys: [
                    .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
                ])
                guard values.isSymbolicLink != true else { throw CocoaError(.fileReadInvalidFileName) }
                let relativePath = String(path.dropFirst(rootPath.count + 1))
                if values.isDirectory == true {
                    entries.append(BoundedEntry(url: url, relativePath: relativePath, isDirectory: true, size: 0))
                    pending.append(url)
                } else if values.isRegularFile == true {
                    let size = Int64(values.fileSize ?? 0)
                    guard size <= maximumBytes - total else { throw CocoaError(.fileReadTooLarge) }
                    total += size
                    entries.append(BoundedEntry(url: url, relativePath: relativePath, isDirectory: false, size: size))
                } else {
                    throw CocoaError(.fileReadUnsupportedScheme)
                }
            }
        }
        return entries
    }

    private static func boundedItemSize(at url: URL, maximumBytes: Int64) throws -> Int64 {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
        if values.isDirectory == true {
            return try boundedEntries(at: url, maximumBytes: maximumBytes).reduce(0) { $0 + $1.size }
        }
        let size = Int64(values.fileSize ?? 0)
        guard size <= maximumBytes else { throw CocoaError(.fileReadTooLarge) }
        return size
    }

    private static func boundedCopyFile(
        at source: URL,
        to destination: URL,
        maximumBytes: Int64,
        isCancelled: () -> Bool
    ) throws -> Int64 {
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        if let size = values.fileSize, Int64(size) > maximumBytes {
            throw CocoaError(.fileReadTooLarge)
        }
        if isCancelled() { throw CancellationError() }
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            let copied = try streamCopy(
                at: source,
                to: destination,
                maximumBytes: maximumBytes,
                isCancelled: isCancelled
            )
            return copied
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
    }

    private static func streamCopy(
        at source: URL,
        to destination: URL,
        maximumBytes: Int64,
        isCancelled: () -> Bool
    ) throws -> Int64 {
        let reader = try FileHandle(forReadingFrom: source)
        defer { try? reader.close() }
        let writer = try FileHandle(forWritingTo: destination)
        defer { try? writer.close() }
        var copied: Int64 = 0
        while true {
            if isCancelled() { throw CancellationError() }
            let data = try reader.read(upToCount: 64 * 1_024) ?? Data()
            guard !data.isEmpty else { return copied }
            guard Int64(data.count) <= maximumBytes - copied else { throw CocoaError(.fileReadTooLarge) }
            try writer.write(contentsOf: data)
            copied += Int64(data.count)
        }
    }

    private static func coordinatedUploadArchive(of directory: URL) throws -> URL {
        _ = try boundedItemSize(at: directory, maximumBytes: maximumSourceBytes)
        var coordinationError: NSError?
        var result: Result<URL, Error>?
        NSFileCoordinator().coordinate(
            readingItemAt: directory,
            options: .forUploading,
            error: &coordinationError
        ) { coordinatedURL in
            let destination = temporaryURL(extension: "livephoto.zip")
            do {
                _ = try boundedCopyItem(
                    at: coordinatedURL,
                    to: destination,
                    maximumBytes: maximumSourceBytes
                )
                result = .success(destination)
            } catch {
                result = .failure(error)
            }
        }
        if let coordinationError {
            if case let .success(url)? = result { try? FileManager.default.removeItem(at: url) }
            throw coordinationError
        }
        guard let result else { throw CocoaError(.fileWriteUnknown) }
        return try result.get()
    }

    private static func temporaryURL(extension pathExtension: String) -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-attachment-\(UUID().uuidString)")
            .appendingPathExtension(pathExtension)
    }
}

private final class ProviderExportState: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<URL, Error>?
    private var result: Result<URL, Error>?
    private var progress: Progress?
    private var callbackActive = false
    private var storedAbortError: Error?
    private var deadlineTask: Task<Void, Never>?

    var shouldStart: Bool {
        lock.lock()
        defer { lock.unlock() }
        return result == nil
    }

    var abortError: Error? {
        lock.lock()
        defer { lock.unlock() }
        return storedAbortError
    }

    func install(_ continuation: CheckedContinuation<URL, Error>) {
        lock.lock()
        if let result {
            lock.unlock()
            continuation.resume(with: result)
        } else {
            self.continuation = continuation
            lock.unlock()
        }
    }

    func register(_ progress: Progress) {
        lock.lock()
        let shouldCancel = storedAbortError != nil
        if result == nil { self.progress = progress }
        lock.unlock()
        if shouldCancel { progress.cancel() }
    }

    func startDeadline(_ deadline: Duration) {
        let task = Task { [weak self] in
            do {
                try await Task.sleep(for: deadline)
                self?.abort(URLError(.timedOut))
            } catch {}
        }
        lock.lock()
        if result == nil {
            deadlineTask = task
            lock.unlock()
        } else {
            lock.unlock()
            task.cancel()
        }
    }

    func beginCallback() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard result == nil, !callbackActive else { return false }
        callbackActive = true
        return true
    }

    func finish(_ candidate: Result<URL, Error>) {
        lock.lock()
        guard result == nil else {
            lock.unlock()
            return
        }
        callbackActive = false
        let wasAborted = storedAbortError != nil
        let final = storedAbortError.map(Result.failure) ?? candidate
        result = final
        let continuation = self.continuation
        self.continuation = nil
        progress = nil
        let deadlineTask = self.deadlineTask
        self.deadlineTask = nil
        lock.unlock()

        if wasAborted, case let .success(url) = candidate {
            try? FileManager.default.removeItem(at: url)
        }
        deadlineTask?.cancel()
        continuation?.resume(with: final)
    }

    func abort(_ error: Error) {
        lock.lock()
        guard result == nil else {
            lock.unlock()
            return
        }
        if storedAbortError == nil { storedAbortError = error }
        let progress = self.progress
        let deadlineTask = self.deadlineTask
        if callbackActive {
            lock.unlock()
            progress?.cancel()
            deadlineTask?.cancel()
            return
        }
        let final = Result<URL, Error>.failure(storedAbortError ?? error)
        result = final
        let continuation = self.continuation
        self.continuation = nil
        self.progress = nil
        self.deadlineTask = nil
        lock.unlock()

        progress?.cancel()
        deadlineTask?.cancel()
        continuation?.resume(with: final)
    }
}

enum AttachmentImageFile {
    static func makeJPEG(from image: UIImage) throws -> URL {
        guard let data = image.jpegData(compressionQuality: 0.9) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-attachment-\(UUID().uuidString)")
            .appendingPathExtension("jpg")
        do {
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }
}

struct AttachmentCameraPicker: UIViewControllerRepresentable {
    let onCapture: (AttachmentImportItem) -> Void
    let onCancel: () -> Void
    let onFailure: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier]
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: AttachmentCameraPicker

        init(parent: AttachmentCameraPicker) {
            self.parent = parent
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onCancel()
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage,
                  let url = try? AttachmentImageFile.makeJPEG(from: image) else {
                parent.onFailure()
                return
            }
            parent.onCapture(.temporary(url, mediaType: "image/jpeg", source: .camera))
        }
    }
}
