import Foundation
import MobileData
import Testing
@testable import SentientApp

struct AttachmentDNGImportTests {
    @Test func filesPickerAdvertisesDNGWithoutUsingTIFFMediaType() {
        #expect(attachmentFileImportTypes.contains { $0.identifier == AttachmentDNGImport.dngTypeIdentifier })
        #expect(AttachmentDNGImport.dngMediaType == "image/x-adobe-dng")
        #expect(!AttachmentDNGImport.isDNGTypeIdentifier("public.camera-raw-image"))
    }

    @Test func dngOnlyPhotoProviderExportsRawBytesWithoutJPEGFallback() async throws {
        let dng = temporaryURL(extension: "dng")
        let original = Data([0x49, 0x49, 0x2A, 0x00, 0x44, 0x4E, 0x47])
        try original.write(to: dng)
        defer { try? FileManager.default.removeItem(at: dng) }

        let provider = NSItemProvider()
        provider.registerFileRepresentation(
            forTypeIdentifier: AttachmentDNGImport.dngTypeIdentifier,
            fileOptions: [],
            visibility: .all
        ) { completion in
            completion(dng, false, nil)
            return Progress(totalUnitCount: 1)
        }

        let imported = try await AttachmentPhotoImport.prepare(provider)
        defer { imported.ownedTemporaryURLs.forEach { try? FileManager.default.removeItem(at: $0) } }

        #expect(imported.mediaType == AttachmentDNGImport.dngMediaType)
        #expect(imported.source == .photos)
        #expect(imported.displayName?.hasSuffix(".dng") == true)
        #expect(try Data(contentsOf: imported.url) == original)
    }

    @Test func nonDNGItemsRemainIdenticalAndBytesUntouched() async throws {
        let source = temporaryURL(extension: "jpg")
        let original = Data([0xff, 0xd8, 0xff, 0xd9])
        try original.write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let item = AttachmentImportItem.temporary(
            source,
            displayName: "photo.jpg",
            mediaType: "image/jpeg",
            source: .files
        )

        let prepared = try await AttachmentDNGImport.prepareIfNeeded(item)

        #expect(prepared.url == item.url)
        #expect(prepared.displayName == item.displayName)
        #expect(prepared.mediaType == item.mediaType)
        #expect(prepared.ownsTemporaryFile == item.ownsTemporaryFile)
        #expect(try Data(contentsOf: source) == original)
    }

    @Test func malformedDNGUsesTypedCorruptFailureAndPreservesInput() async throws {
        let source = temporaryURL(extension: "dng")
        let original = Data("not a DNG".utf8)
        try original.write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let item = AttachmentImportItem.temporary(
            source,
            displayName: "camera.DNG",
            mediaType: AttachmentDNGImport.dngMediaType,
            source: .photos
        )

        do {
            _ = try await AttachmentDNGImport.prepareIfNeeded(item)
            Issue.record("malformed DNG unexpectedly rendered")
        } catch {
            #expect((error as? CocoaError)?.code == .fileReadCorruptFile)
        }
        #expect(FileManager.default.fileExists(atPath: source.path))
        #expect(try Data(contentsOf: source) == original)
    }

    @Test func sourcePixelBudgetDistinguishesOversizedFromMalformedImages() throws {
        try AttachmentDNGImport.validateSourceDimensions(width: 8_000, height: 8_000)
        #expect(throws: CocoaError(.fileReadTooLarge)) {
            try AttachmentDNGImport.validateSourceDimensions(width: 8_001, height: 8_000)
        }
        #expect(throws: CocoaError(.fileReadCorruptFile)) {
            try AttachmentDNGImport.validateSourceDimensions(width: .nan, height: 8_000)
        }
    }

    @Test func oversizedDNGIsRejectedBeforeNativeDecode() async throws {
        let source = temporaryURL(extension: "dng")
        try Data().write(to: source)
        let handle = try FileHandle(forWritingTo: source)
        try handle.seek(toOffset: UInt64(AttachmentDNGImport.maximumInputBytes))
        try handle.write(contentsOf: Data([0]))
        try handle.close()
        defer { try? FileManager.default.removeItem(at: source) }
        let item = AttachmentImportItem.file(source)

        do {
            _ = try await AttachmentDNGImport.prepareIfNeeded(item)
            Issue.record("oversized DNG unexpectedly rendered")
        } catch {
            #expect((error as? CocoaError)?.code == .fileReadTooLarge)
        }
        #expect(FileManager.default.fileExists(atPath: source.path))
    }

    @Test func cancelledDNGPreparationLeavesInputAndNoOwnedOutput() async throws {
        let source = temporaryURL(extension: "dng")
        try Data("not a DNG".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let item = AttachmentImportItem.temporary(
            source,
            displayName: "cancelled.dng",
            mediaType: AttachmentDNGImport.dngMediaType,
            source: .photos
        )

        let task = Task {
            await Task.yield()
            return try await AttachmentDNGImport.prepareIfNeeded(item)
        }
        task.cancel()
        do {
            _ = try await task.value
            Issue.record("cancelled DNG unexpectedly rendered")
        } catch {
            #expect(isUserCancelledAttachmentImport(error))
        }
        #expect(FileManager.default.fileExists(atPath: source.path))
    }

    private func temporaryURL(extension pathExtension: String) -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-dng-test-\(UUID().uuidString)")
            .appendingPathExtension(pathExtension)
    }
}
