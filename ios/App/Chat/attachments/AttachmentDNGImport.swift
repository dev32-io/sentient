import CoreImage
import Foundation
import UniformTypeIdentifiers

enum AttachmentDNGImport {
    static let dngMediaType = "image/x-adobe-dng"
    static let dngTypeIdentifier = "com.adobe.raw-image"
    static let maximumInputBytes: Int64 = AttachmentPhotoImport.maximumSourceBytes
    static let maximumSourcePixels: Double = 64_000_000
    static let maximumOutputEdge: CGFloat = 4_096
    static let maximumEncodedJPEGBytes: Int64 = 32 * 1_024 * 1_024

    static func prepareIfNeeded(_ item: AttachmentImportItem) async throws -> AttachmentImportItem {
        guard isDNG(item) else { return item }
        try Task.checkCancellation()

        // Native RAW decode is synchronous; cancellation waits for this task to settle before cleanup.
        let renderTask = Task.detached(priority: .userInitiated) {
            try render(item.url)
        }
        var outputURL: URL?
        do {
            outputURL = try await withTaskCancellationHandler {
                try await renderTask.value
            } onCancel: {
                renderTask.cancel()
            }
            try Task.checkCancellation()
            guard let outputURL else { throw CocoaError(.fileWriteUnknown) }
            return .temporary(
                outputURL,
                displayName: jpegDisplayName(for: item),
                mediaType: "image/jpeg",
                source: item.source
            )
        } catch {
            if let outputURL {
                try? FileManager.default.removeItem(at: outputURL)
            }
            throw error
        }
    }

    static func isDNGTypeIdentifier(_ identifier: String) -> Bool {
        let normalized = identifier.lowercased()
        guard normalized == dngTypeIdentifier else {
            return UTType(identifier)?.preferredFilenameExtension?.lowercased() == "dng"
        }
        return true
    }

    private static func isDNG(_ item: AttachmentImportItem) -> Bool {
        if item.mediaType?.caseInsensitiveCompare(dngMediaType) == .orderedSame {
            return true
        }
        if item.url.pathExtension.caseInsensitiveCompare("dng") == .orderedSame {
            return true
        }
        do {
            let values = try item.url.resourceValues(forKeys: [.contentTypeKey])
            return values.contentType.map { isDNGTypeIdentifier($0.identifier) } == true
        } catch {
            return false
        }
    }

    private static func render(_ sourceURL: URL) throws -> URL {
        try Task.checkCancellation()
        try validateSource(sourceURL)
        try Task.checkCancellation()

        guard let rawFilter = CIRAWFilter(imageURL: sourceURL) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let nativeSize = rawFilter.nativeSize
        let sourceWidth = Double(nativeSize.width)
        let sourceHeight = Double(nativeSize.height)
        try validateSourceDimensions(width: sourceWidth, height: sourceHeight)

        let scale = min(1, Double(maximumOutputEdge) / max(sourceWidth, sourceHeight))
        guard scale.isFinite, scale > 0 else {
            throw CocoaError(.fileReadCorruptFile)
        }
        rawFilter.scaleFactor = Float(scale)
        guard let outputImage = rawFilter.outputImage else {
            throw CocoaError(.fileReadCorruptFile)
        }
        try Task.checkCancellation()

        let extent = outputImage.extent
        let outputWidth = extent.width
        let outputHeight = extent.height
        guard outputWidth.isFinite, outputHeight.isFinite,
              outputWidth > 0, outputHeight > 0,
              ceil(max(outputWidth, outputHeight)) <= maximumOutputEdge else {
            throw CocoaError(.fileReadCorruptFile)
        }

        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-attachment-\(UUID().uuidString)")
            .appendingPathExtension("jpg")
        var keepOutput = false
        defer {
            if !keepOutput { try? FileManager.default.removeItem(at: outputURL) }
        }

        let context = CIContext()
        do {
            try context.writeJPEGRepresentation(
                of: outputImage,
                to: outputURL,
                colorSpace: CGColorSpaceCreateDeviceRGB(),
                options: [:]
            )
        } catch {
            throw CocoaError(.fileWriteUnknown)
        }
        try Task.checkCancellation()

        let values = try outputURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let fileSize = values.fileSize,
              Int64(fileSize) <= maximumEncodedJPEGBytes else {
            throw CocoaError(.fileReadTooLarge)
        }
        try Task.checkCancellation()
        keepOutput = true
        return outputURL
    }

    private static func validateSource(_ url: URL) throws {
        let values = try url.resourceValues(forKeys: [
            .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
        ])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        guard let fileSize = values.fileSize else {
            throw CocoaError(.fileReadUnknown)
        }
        guard Int64(fileSize) <= maximumInputBytes else {
            throw CocoaError(.fileReadTooLarge)
        }
    }

    static func validateSourceDimensions(width: Double, height: Double) throws {
        guard width.isFinite, height.isFinite, width > 0, height > 0,
              width.rounded() == width, height.rounded() == height else {
            throw CocoaError(.fileReadCorruptFile)
        }
        guard (width * height).isFinite, width * height <= maximumSourcePixels else {
            throw CocoaError(.fileReadTooLarge)
        }
    }

    private static func jpegDisplayName(for item: AttachmentImportItem) -> String {
        let suggested = item.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceName = suggested.flatMap { $0.isEmpty ? nil : $0 } ?? item.url.lastPathComponent
        let base = (sourceName as NSString).deletingPathExtension
        return "\(base.isEmpty ? "Image" : base).jpg"
    }
}
