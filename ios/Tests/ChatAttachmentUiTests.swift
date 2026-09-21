import MobileData
import SwiftUI
import Testing
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import SentientApp

private enum ComposerPasteWaitError: Error {
    case timedOut
}

@MainActor
private final class ComposerPasteChangeObserver: NSObject, UITextViewDelegate {
    private let view: ComposerTextView
    private let expectedText: String
    private weak var priorDelegate: UITextViewDelegate?
    private var continuation: CheckedContinuation<Void, Error>?
    private var timeoutTask: Task<Void, Never>?

    init(view: ComposerTextView, expectedText: String) {
        self.view = view
        self.expectedText = expectedText
        priorDelegate = view.delegate
    }

    func pasteAndWait() async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            timeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(for: .seconds(1))
                } catch {
                    return
                }
                self?.timeOut()
            }
            view.delegate = self
            view.paste(nil)
            finishIfReady()
        }
    }

    func textViewDidChange(_ textView: UITextView) {
        priorDelegate?.textViewDidChange?(textView)
        finishIfReady()
    }

    private func finishIfReady() {
        guard view.text == expectedText, let continuation else { return }
        self.continuation = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        view.delegate = priorDelegate
        continuation.resume(returning: ())
    }

    private func timeOut() {
        guard let continuation else { return }
        self.continuation = nil
        timeoutTask = nil
        view.delegate = priorDelegate
        continuation.resume(throwing: ComposerPasteWaitError.timedOut)
    }
}

@MainActor
struct ChatAttachmentUiTests {
    @Test func plainClipboardTextStaysNativeWhileNamedFilesEnterPasteImport() throws {
        let plain = NSItemProvider(object: NSString(string: "keep as text"))
        #expect(attachmentPasteProviders(from: [plain]).isEmpty)
        #expect(attachmentPasteContainsNativeText(in: [plain]))
        #expect(!attachmentPasteContentTypes.contains(.url))

        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-paste-\(UUID().uuidString).txt")
        try Data("attachment".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let file = try #require(NSItemProvider(contentsOf: source))
        file.suggestedName = "attachment.txt"
        #expect(attachmentPasteProviders(from: [file]).count == 1)
        #expect(!attachmentPasteContainsNativeText(in: [file]))
        #expect(attachmentPasteProviders(from: [plain, file]).count == 1)
        // Native text decision must see plain even though filtering removes it.
        #expect(attachmentPasteContainsNativeText(in: [plain, file]))
    }

    @Test func composerTextViewPastesMixedTextAndFilesThroughUIKit() async throws {
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-uikit-paste-\(UUID().uuidString).txt")
        try Data("file bytes".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }

        let pasteboard = UIPasteboard.general
        let previousItems = pasteboard.items
        let markerType = "io.sentient.tests.synthetic-paste-\(UUID().uuidString.lowercased())"
        let marker = Data(UUID().uuidString.utf8)
        defer {
            if pasteboard.itemProviders.contains(where: {
                $0.registeredTypeIdentifiers.contains(markerType)
            }) {
                pasteboard.items = previousItems
            }
        }

        func install(_ items: [[String: Any]]) {
            pasteboard.items = items
        }

        let scene = try #require(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let window = UIWindow(windowScene: scene)
        let host = UIViewController()
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        func mount(_ view: ComposerTextView) -> Bool {
            host.view.addSubview(view)
            view.frame = CGRect(x: 0, y: 0, width: 320, height: 80)
            return view.becomeFirstResponder()
        }

        let text = "native text"
        install([
            [UTType.plainText.identifier: text, markerType: marker],
            [UTType.fileURL.identifier: source as NSURL, markerType: marker],
        ])
        let mixedView = ComposerTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 80))
        configureComposerTextView(mixedView)
        mixedView.text = "prefix "
        mixedView.selectedRange = NSRange(location: mixedView.text.utf16.count, length: 0)
        var mixedProviders: [NSItemProvider] = []
        mixedView.onPasteProviders = { mixedProviders = $0 }
        #expect(mount(mixedView))
        #expect(mixedView.window != nil)
        #expect(mixedView.isFirstResponder)
        #expect(pasteboard.string == text)

        #expect(mixedView.canPerformAction(
            #selector(UIResponderStandardEditActions.paste(_:)),
            withSender: nil
        ))
        try await ComposerPasteChangeObserver(
            view: mixedView,
            expectedText: "prefix \(text)"
        ).pasteAndWait()
        #expect(mixedView.text == "prefix \(text)")
        #expect(mixedProviders.count == 1)
        #expect(attachmentPasteProviders(from: mixedProviders).count == 1)

        install([[UTType.fileURL.identifier: source as NSURL, markerType: marker]])
        let fileView = ComposerTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 80))
        configureComposerTextView(fileView)
        fileView.text = "unchanged"
        fileView.selectedRange = NSRange(location: fileView.text.utf16.count, length: 0)
        var fileProviderCount = 0
        fileView.onPasteProviders = { fileProviderCount = $0.count }
        mixedView.resignFirstResponder()
        #expect(mount(fileView))
        #expect(fileView.canPerformAction(
            #selector(UIResponderStandardEditActions.paste(_:)),
            withSender: nil
        ))
        fileView.paste(nil)
        #expect(fileView.text == "unchanged")
        #expect(fileProviderCount == 1)

        install([[UTType.plainText.identifier: text, markerType: marker]])
        let plainView = ComposerTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 80))
        configureComposerTextView(plainView)
        var plainProviderCount = 0
        plainView.onPasteProviders = { plainProviderCount = $0.count }
        fileView.resignFirstResponder()
        #expect(mount(plainView))
        #expect(plainView.window != nil)
        #expect(plainView.isFirstResponder)
        #expect(pasteboard.string == text)
        try await ComposerPasteChangeObserver(
            view: plainView,
            expectedText: text
        ).pasteAndWait()
        #expect(plainView.text == text)
        #expect(plainProviderCount == 0)

        install([[UTType.url.identifier: "https://example.invalid/file.txt", markerType: marker]])
        let urlView = ComposerTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 80))
        configureComposerTextView(urlView)
        urlView.text = "unchanged"
        urlView.selectedRange = NSRange(location: urlView.text.utf16.count, length: 0)
        var urlProviderCount = 0
        urlView.onPasteProviders = { urlProviderCount = $0.count }
        plainView.resignFirstResponder()
        #expect(mount(urlView))
        #expect(!urlView.canPerformAction(
            #selector(UIResponderStandardEditActions.paste(_:)),
            withSender: nil
        ))
        urlView.paste(nil)
        #expect(urlView.text == "unchanged")
        #expect(urlProviderCount == 0)
    }

    @Test func composerTextViewKeepsLongInputScrollableAndSelectable() {
        let view = ComposerTextView()
        configureComposerTextView(view)
        view.text = String(repeating: "long input ", count: 100)
        view.selectedRange = NSRange(location: 12, length: 5)

        #expect(view.isScrollEnabled)
        #expect(view.textContainer.maximumNumberOfLines == 0)
        #expect(view.textContainer.lineBreakMode == .byWordWrapping)
        #expect(view.isSelectable)
        #expect(view.adjustsFontForContentSizeCategory)
        #expect(view.selectedRange == NSRange(location: 12, length: 5))
    }

    @Test func pasteImportUsesOwnedTemporaryFile() async throws {
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-paste-\(UUID().uuidString).txt")
        try Data("clipboard file".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let provider = try #require(NSItemProvider(contentsOf: source))

        let imported = try await AttachmentPasteImport.prepare([provider])
        defer {
            for url in imported.flatMap(\.ownedTemporaryURLs) {
                try? FileManager.default.removeItem(at: url)
            }
        }

        #expect(imported.count == 1)
        #expect(imported[0].ownsTemporaryFile)
        #expect(imported[0].source == .files)
        #expect(imported[0].mediaType == "text/plain")
        #expect(try Data(contentsOf: imported[0].url) == Data("clipboard file".utf8))
    }

    @Test func fileURLPasteCopiesFileBytesNotURLBytes() async throws {
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-file-url-\(UUID().uuidString).txt")
        let original = Data("actual file contents".utf8)
        try original.write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }

        let provider = NSItemProvider()
        provider.suggestedName = "actual.txt"
        provider.registerFileRepresentation(
            forTypeIdentifier: UTType.fileURL.identifier,
            fileOptions: [],
            visibility: .all
        ) { completion in
            completion(source, false, nil)
            return Progress(totalUnitCount: 1)
        }

        let imported = try await AttachmentPasteImport.prepare(provider)
        defer { imported.ownedTemporaryURLs.forEach { try? FileManager.default.removeItem(at: $0) } }
        #expect(imported.displayName == "actual.txt")
        #expect(try Data(contentsOf: imported.url) == original)
        #expect(try Data(contentsOf: imported.url) != Data(source.absoluteString.utf8))
    }

    @Test func rejectedFileURLPasteRemovesCopiedTemporaryFile() async throws {
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-rejected-\(UUID().uuidString).bin")
        try Data("unsupported".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }

        let provider = NSItemProvider()
        provider.registerFileRepresentation(
            forTypeIdentifier: UTType.fileURL.identifier,
            fileOptions: [],
            visibility: .all
        ) { completion in
            completion(source, false, nil)
            return Progress(totalUnitCount: 1)
        }
        let manager = FileManager.default
        let temporary = manager.temporaryDirectory
        let before = Set((try? manager.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil)) ?? [])

        do {
            _ = try await AttachmentPasteImport.prepare(provider)
            Issue.record("unsupported file URL unexpectedly imported")
        } catch {
            let after = Set((try? manager.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil)) ?? [])
            let copied = after.subtracting(before).filter { $0.lastPathComponent.hasPrefix("sentient-attachment-") }
            #expect(copied.isEmpty)
        }
    }

    @Test func pendingRowsKeepAttachmentOwnershipAndTransferState() {
        let first = NativeDraftAttachment(
            id: "local-one", displayName: "one.png", mediaType: "image/png", sizeBytes: 10, localPath: "/private/one"
        )
        let second = NativeDraftAttachment(
            id: "local-two", displayName: "two.pdf", mediaType: "application/pdf", sizeBytes: 20, localPath: "/private/two"
        )
        let sends = [
            NativePendingSend(
                pendingId: "pending-one",
                mintKey: "mint-one",
                surfaceId: "surface",
                draftId: "draft-one",
                draftRevision: 1,
                sessionId: "session",
                text: "one",
                attachments: [first],
                createdAt: 1
            ),
            NativePendingSend(
                pendingId: "pending-two",
                mintKey: "mint-two",
                surfaceId: "surface",
                draftId: "draft-two",
                draftRevision: 1,
                sessionId: "session",
                text: "two",
                attachments: [second],
                createdAt: 2
            ),
        ]
        let projection = pendingAttachmentProjection(
            pending: sends,
            previews: ["local-one": UIImage(systemName: "photo")!],
            transfers: ["local-two": AttachmentTransferState(phase: .failed)]
        )

        #expect(projection["pending-one"]?.attachments.map { $0.id } == ["local-one"])
        #expect(Set(projection["pending-one"]?.previews.map { $0.key } ?? []) == Set(["local-one"]))
        #expect(projection["pending-one"]?.transfers.isEmpty == true)
        #expect(projection["pending-two"]?.attachments.map { $0.id } == ["local-two"])
        #expect(projection["pending-two"]?.previews.isEmpty == true)
        #expect(projection["pending-two"]?.transfers["local-two"]?.phase == .failed)
    }

    @Test func pendingPreviewSelectionOpensLocalFileForExport() throws {
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-pending-\(UUID().uuidString).txt")
        try Data("pending".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let attachment = NativeDraftAttachment(
            id: "local-text", displayName: "pending.txt", mediaType: "text/plain", sizeBytes: 7, localPath: source.path
        )

        let selection = try #require(attachmentPreviewSelection(
            id: attachment.id,
            committed: [],
            pending: [attachment]
        ))
        #expect(selection.isLocal)
        #expect(selection.localFile?.standardizedFileURL == source.standardizedFileURL)
        #expect(selection.contentType == "text/plain")
        #expect(selection.mediaKind == "text")

        let livePhoto = NativeDraftAttachment(
            id: "local-live-photo", displayName: "memory.livephoto.zip",
            mediaType: "application/vnd.sentient.live-photo+zip", sizeBytes: 20, localPath: ""
        )
        let liveSelection = AttachmentPreviewSelection(livePhoto)
        #expect(liveSelection.mediaKind == "image")

        let draftId = UUID().uuidString
        let attachmentId = UUID().uuidString
        let support = try #require(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
        let draftDirectory = support
            .appendingPathComponent("SentientDrafts/files", isDirectory: true)
            .appendingPathComponent(draftId, isDirectory: true)
        try FileManager.default.createDirectory(at: draftDirectory, withIntermediateDirectories: true)
        let durableFile = draftDirectory.appendingPathComponent(attachmentId)
        try Data("durable".utf8).write(to: durableFile)
        defer { try? FileManager.default.removeItem(at: draftDirectory) }

        let durableAttachment = NativeDraftAttachment(
            id: "durable-text", displayName: "durable.txt", mediaType: "text/plain", sizeBytes: 7,
            localPath: "files/\(draftId)/\(attachmentId)"
        )
        let durableSelection = try #require(attachmentPreviewSelection(
            id: durableAttachment.id,
            committed: [],
            pending: [durableAttachment]
        ))
        #expect(durableSelection.localFile?.standardizedFileURL == durableFile.standardizedFileURL)
    }

    @Test func filenamePreservingExportOwnsAndCleansTemporaryCopy() async throws {
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString)")
        let original = Data("export me".utf8)
        try original.write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }

        var export: AttachmentExportFile? = try #require(await AttachmentExportFile.prepare(
            source: source,
            displayName: "report.pdf"
        ))
        let exportedURL = try #require(export?.url)
        #expect(exportedURL.lastPathComponent == "report.pdf")
        #expect(try Data(contentsOf: exportedURL) == original)
        #expect(FileManager.default.fileExists(atPath: exportedURL.path))

        export = nil
        #expect(!FileManager.default.fileExists(atPath: exportedURL.path))
    }

    @Test func managedNamedDownloadSharesWithoutCopyingOrDeletingSource() async throws {
        let downloadDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SentientAttachments", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let source = downloadDirectory.appendingPathComponent("report.pdf")
        try FileManager.default.createDirectory(at: downloadDirectory, withIntermediateDirectories: true)
        try Data("downloaded".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: downloadDirectory) }

        var export: AttachmentExportFile? = try #require(await AttachmentExportFile.prepare(
            source: source,
            displayName: "report.pdf",
            reuseExistingFile: true
        ))
        #expect(export?.url.standardizedFileURL == source.standardizedFileURL)
        export = nil
        #expect(FileManager.default.fileExists(atPath: source.path))
    }

    @Test func cancelledExportCleansLateBackgroundCopy() async throws {
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString).bin")
        try Data(repeating: 0x5A, count: 256 * 1_024).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let manager = FileManager.default
        let before = Set((try? manager.contentsOfDirectory(
            at: manager.temporaryDirectory,
            includingPropertiesForKeys: nil
        )) ?? []).filter { $0.lastPathComponent.hasPrefix("sentient-export-") }

        let task = Task {
            await AttachmentExportFile.prepare(source: source, displayName: "cancelled.bin")
        }
        task.cancel()
        #expect(await task.value == nil)

        let after = Set((try? manager.contentsOfDirectory(
            at: manager.temporaryDirectory,
            includingPropertiesForKeys: nil
        )) ?? []).filter { $0.lastPathComponent.hasPrefix("sentient-export-") }
        #expect(after == before)
    }

    @Test func failedExportCanRetryAfterSourceAppears() async throws {
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString).txt")
        defer { try? FileManager.default.removeItem(at: source) }

        #expect(await AttachmentExportFile.prepare(source: source, displayName: "retry.txt") == nil)
        try Data("retry".utf8).write(to: source)
        let export = try #require(await AttachmentExportFile.prepare(
            source: source,
            displayName: "retry.txt"
        ))
        #expect(export.url.lastPathComponent == "retry.txt")
    }

    @Test func previewSelectionRetainsServerMetadataForSheetAndExport() {
        let ref = AttachmentRef(
            attachmentId: "att_0123456789abcdef0123456789abcdef",
            displayName: "report.pdf",
            contentType: "application/pdf",
            mediaKind: "pdf",
            size: 42
        )
        let selection = AttachmentPreviewSelection(ref)
        #expect(selection.id == ref.attachmentId)
        #expect(selection.displayName == "report.pdf")
        #expect(selection.contentType == "application/pdf")
        #expect(selection.mediaKind == "pdf")
        #expect(selection.size == 42)
        #expect(!selection.isLocal)
        #expect(selection.localFile == nil)
    }
}

@MainActor
final class ComposerLayoutRegressionTests: XCTestCase {
    func testHostedComposerStaysBoundedAcrossDraftGrowth() async throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let size = CGSize(width: 390, height: 844)
        let drafts = [
            "",
            "Short draft",
            String(repeating: "Long draft text wraps and remains inside its bounded editor. ", count: 20),
        ]
        var heights: [CGFloat] = []

        for draft in drafts {
            do {
                let host = UIHostingController(
                    rootView: ComposerLayoutRegressionFixture(draft: draft)
                        .environment(\.horizontalSizeClass, .compact)
                        .environment(\.dynamicTypeSize, .large)
                        .transaction { transaction in
                            transaction.animation = nil
                            transaction.disablesAnimations = true
                        }
                )
                let window = UIWindow(windowScene: scene)
                defer {
                    window.rootViewController = nil
                    window.isHidden = true
                }
                window.frame = CGRect(origin: .zero, size: size)
                window.rootViewController = host
                window.makeKeyAndVisible()
                host.view.frame = window.bounds
                host.view.setNeedsLayout()
                host.view.layoutIfNeeded()
                await Task.yield()
                host.view.layoutIfNeeded()

                let probes = composerDescendants(host.view).compactMap { $0 as? ComposerLayoutProbeView }
                let composer = try XCTUnwrap(probes.first { $0.probeID == "composer-layout" })
                let topBar = try XCTUnwrap(probes.first { $0.probeID == "chat-topbar" })
                let content = try XCTUnwrap(probes.first { $0.probeID == "chat-content" })
                let textView = try XCTUnwrap(
                    composerDescendants(host.view).compactMap { $0 as? ComposerTextView }.first
                )
                let editor = try XCTUnwrap(
                    composerDescendants(host.view).first {
                        $0.accessibilityIdentifier == "composer-editor-viewport"
                    }
                )
                let composerFrame = composer.convert(composer.bounds, to: window)
                let topBarFrame = topBar.convert(topBar.bounds, to: window)
                let contentFrame = content.convert(content.bounds, to: window)
                let editorFrame = editor.convert(editor.bounds, to: window)
                let textFrame = textView.convert(textView.bounds, to: window)

                XCTAssertGreaterThanOrEqual(textFrame.minY, editorFrame.minY - 1)
                XCTAssertLessThanOrEqual(textFrame.maxY, editorFrame.maxY + 1)
                XCTAssertLessThanOrEqual(editorFrame.maxY, composerFrame.maxY + 1)
                XCTAssertLessThan(composerFrame.height, size.height * 0.5)
                XCTAssertGreaterThan(composerFrame.minY, topBarFrame.maxY)
                XCTAssertLessThanOrEqual(composerFrame.maxY, size.height + 1)
                XCTAssertGreaterThan(contentFrame.height, 0)
                XCTAssertGreaterThan(min(composerFrame.minY, contentFrame.maxY), contentFrame.minY)
                heights.append(composerFrame.height)
            }
        }

        XCTAssertEqual(heights.count, 3)
        XCTAssertGreaterThan(heights[2], heights[1] + 20)
    }

    func testHostedComposerKeepsNativeFocusThroughSwiftUIUpdates() async throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let model = ComposerFocusTestModel()
        let host = UIHostingController(
            rootView: ComposerFocusRegressionFixture(model: model, draft: model.draft)
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.rootViewController = nil
            window.isHidden = true
        }
        host.view.frame = window.bounds

        func settle() async {
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            await Task.yield()
            host.view.layoutIfNeeded()
        }

        await settle()
        let textView = try XCTUnwrap(
            composerDescendants(host.view).compactMap { $0 as? ComposerTextView }.first
        )
        textView.inputView = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        XCTAssertTrue(textView.becomeFirstResponder())
        await settle()
        XCTAssertTrue(textView.isFirstResponder)

        textView.insertText("typed")
        await settle()
        XCTAssertEqual(model.draft, "seedtyped")
        XCTAssertTrue(textView.isFirstResponder)

        let typedSelection = NSRange(location: 2, length: 0)
        textView.selectedRange = typedSelection
        model.draft = "external replacement"
        host.rootView = ComposerFocusRegressionFixture(model: model, draft: model.draft)
        await settle()
        XCTAssertEqual(textView.text, model.draft)
        XCTAssertEqual(textView.selectedRange, typedSelection)
        XCTAssertTrue(textView.isFirstResponder)
        let paragraphStyle = try XCTUnwrap(
            textView.textStorage.attribute(
                .paragraphStyle,
                at: 0,
                effectiveRange: nil
            ) as? NSParagraphStyle
        )
        XCTAssertEqual(paragraphStyle.lineSpacing, 2, accuracy: 0.01)

        let externalLong = (1...18).map { "controlled line \($0) remains bounded" }.joined(separator: "\n")
        model.draft = externalLong
        host.rootView = ComposerFocusRegressionFixture(model: model, draft: model.draft)
        await settle()
        let editor = try XCTUnwrap(
            composerDescendants(host.view).first {
                $0.accessibilityIdentifier == "composer-editor-viewport"
            }
        )
        let actions = try XCTUnwrap(
            composerDescendants(host.view).first {
                $0.accessibilityIdentifier == "composer-actions-viewport"
            }
        )
        let textFrame = textView.convert(textView.bounds, to: window)
        let editorFrame = editor.convert(editor.bounds, to: window)
        let actionsFrame = actions.convert(actions.bounds, to: window)
        XCTAssertEqual(textView.text, externalLong)
        XCTAssertGreaterThan(editorFrame.height, ComposerGeometry.compactEditorMinimumHeight + 20)
        XCTAssertLessThanOrEqual(textFrame.maxY, editorFrame.maxY + 1)
        XCTAssertLessThanOrEqual(editorFrame.maxY, actionsFrame.minY + 1)
        XCTAssertTrue(textView.isFirstResponder)

        model.draft = "external short"
        host.rootView = ComposerFocusRegressionFixture(model: model, draft: model.draft)
        await settle()
        XCTAssertEqual(textView.text, model.draft)
        XCTAssertTrue(textView.isFirstResponder)

        let newlineRange = NSRange(location: textView.text.utf16.count, length: 0)
        let accepted = textView.delegate?.textView?(
            textView,
            shouldChangeTextIn: newlineRange,
            replacementText: "\n"
        )
        XCTAssertEqual(accepted, false)
        await settle()
        XCTAssertFalse(textView.isFirstResponder)
        XCTAssertEqual(model.sent, [model.draft])

        XCTAssertTrue(textView.becomeFirstResponder())
        await settle()
        textView.setMarkedText("composing", selectedRange: NSRange(location: 9, length: 0))
        XCTAssertNotNil(textView.markedTextRange)
        let composingText = textView.text
        model.draft = "server update during IME"
        host.rootView = ComposerFocusRegressionFixture(model: model, draft: model.draft)
        await settle()
        XCTAssertEqual(textView.text, composingText)
        XCTAssertNotNil(textView.markedTextRange)
        XCTAssertTrue(textView.isFirstResponder)
    }

    func testHostedComposerRespondsToUIKitAccessibilityContentSizeTrait() async throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let text = (1...18).map { "accessibility line \($0) remains bounded" }.joined(separator: "\n")
        let host = UIHostingController(
            rootView: ComposerLayoutRegressionFixture(draft: text)
                .transaction { transaction in
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                }
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.rootViewController = nil
            window.isHidden = true
        }
        host.view.frame = window.bounds

        func settle() async {
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            await Task.yield()
            host.view.layoutIfNeeded()
        }

        await settle()
        let editor = try XCTUnwrap(
            composerDescendants(host.view).first {
                $0.accessibilityIdentifier == "composer-editor-viewport"
            }
        )
        let actions = try XCTUnwrap(
            composerDescendants(host.view).first {
                $0.accessibilityIdentifier == "composer-actions-viewport"
            }
        )
        let textView = try XCTUnwrap(
            composerDescendants(host.view).compactMap { $0 as? ComposerTextView }.first
        )
        let normalHeight = editor.bounds.height
        let normalPointSize = try XCTUnwrap(textView.font?.pointSize)

        host.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        await settle()

        let accessibilityEditorFrame = editor.convert(editor.bounds, to: window)
        let accessibilityActionsFrame = actions.convert(actions.bounds, to: window)
        XCTAssertGreaterThan(textView.font?.pointSize ?? 0, normalPointSize)
        XCTAssertGreaterThan(editor.bounds.height, normalHeight + 1)
        XCTAssertLessThanOrEqual(accessibilityEditorFrame.maxY, accessibilityActionsFrame.minY + 1)
    }

    func testHostedComposerKeepsMultilineRichPasteBoundedBeforeActionsAfterKeyboardResize() async throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let exact = "Household plan 8\n\n Confirm pickup\n Pack weather layers\n Keep school calendar unchanged\nTimeOwnerStatus 08:30AdaReady"
        let model = ComposerFocusTestModel()
        let host = UIHostingController(
            rootView: ComposerFocusRegressionFixture(model: model, draft: "")
                .transaction { transaction in
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                }
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            UIPasteboard.general.items = []
            window.rootViewController = nil
            window.isHidden = true
        }
        host.view.frame = window.bounds

        func settle() async {
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            await Task.yield()
            host.view.layoutIfNeeded()
            await Task.yield()
            host.view.layoutIfNeeded()
        }

        await settle()
        let textView = try XCTUnwrap(
            composerDescendants(host.view).compactMap { $0 as? ComposerTextView }.first
        )
        textView.inputView = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        XCTAssertTrue(textView.becomeFirstResponder())
        UIPasteboard.general.items = [[
            UTType.plainText.identifier: exact,
            UTType.html.identifier: "<p>\(exact)</p>",
        ]]
        try await ComposerPasteChangeObserver(
            view: textView,
            expectedText: exact
        ).pasteAndWait()
        await settle()

        XCTAssertEqual(model.draft, exact)
        XCTAssertEqual(textView.text, exact)
        XCTAssertTrue(textView.isScrollEnabled)
        XCTAssertTrue(textView.clipsToBounds)
        XCTAssertGreaterThanOrEqual(textView.contentSize.height, textView.bounds.height - 1)

        let editor = try XCTUnwrap(
            composerDescendants(host.view).first { $0.accessibilityIdentifier == "composer-editor-viewport" }
        )
        let actions = try XCTUnwrap(
            composerDescendants(host.view).first { $0.accessibilityIdentifier == "composer-actions-viewport" }
        )
        let editorFrame = editor.convert(editor.bounds, to: window)
        let actionsFrame = actions.convert(actions.bounds, to: window)
        let textFrame = textView.convert(textView.bounds, to: window)
        XCTAssertLessThanOrEqual(textFrame.maxY, editorFrame.maxY + 1)
        XCTAssertLessThanOrEqual(editorFrame.maxY, actionsFrame.minY + 1)

        // Resize hosting viewport as keyboard presentation does, then re-check
        // action placement without sending or touching any backend state.
        host.additionalSafeAreaInsets.bottom = 320
        await settle()
        let resizedEditorFrame = editor.convert(editor.bounds, to: window)
        let resizedActionsFrame = actions.convert(actions.bounds, to: window)
        let resizedTextFrame = textView.convert(textView.bounds, to: window)
        XCTAssertLessThanOrEqual(resizedTextFrame.maxY, resizedEditorFrame.maxY + 1)
        XCTAssertLessThanOrEqual(resizedEditorFrame.maxY, resizedActionsFrame.minY + 1)
        XCTAssertLessThanOrEqual(resizedActionsFrame.maxY, window.bounds.maxY + 1)
    }

    func testLiveInternalComposerBoundsNativeEditorThroughPasteGrowthAndCaretScroll() async throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let host = UIHostingController(
            rootView: ComposerInternalStateRegressionFixture()
                .transaction { transaction in
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                }
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            UIPasteboard.general.items = []
            window.rootViewController = nil
            window.isHidden = true
        }
        host.view.frame = window.bounds

        func settle() async {
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            await Task.yield()
            host.view.layoutIfNeeded()
            await Task.yield()
            host.view.layoutIfNeeded()
        }

        func frames() throws -> (editor: CGRect, actions: CGRect, textView: ComposerTextView) {
            let editor = try XCTUnwrap(
                composerDescendants(host.view).first {
                    $0.accessibilityIdentifier == "composer-editor-viewport"
                }
            )
            let actions = try XCTUnwrap(
                composerDescendants(host.view).first {
                    $0.accessibilityIdentifier == "composer-actions-viewport"
                }
            )
            let textView = try XCTUnwrap(
                composerDescendants(host.view).compactMap { $0 as? ComposerTextView }.first
            )
            return (
                editor.convert(editor.bounds, to: window),
                actions.convert(actions.bounds, to: window),
                textView
            )
        }

        func assertBounded(_ frames: (editor: CGRect, actions: CGRect, textView: ComposerTextView)) {
            let textFrame = frames.textView.convert(frames.textView.bounds, to: window)
            XCTAssertGreaterThanOrEqual(
                textFrame.minX,
                frames.editor.minX - 1,
                "native/editor x: \(textFrame) vs \(frames.editor)"
            )
            XCTAssertGreaterThanOrEqual(
                textFrame.minY,
                frames.editor.minY - 1,
                "native/editor top: \(textFrame) vs \(frames.editor)"
            )
            XCTAssertLessThanOrEqual(
                textFrame.maxX,
                frames.editor.maxX + 1,
                "native/editor right: \(textFrame) vs \(frames.editor)"
            )
            XCTAssertLessThanOrEqual(
                textFrame.maxY,
                frames.editor.maxY + 1,
                "native/editor bottom: \(textFrame) vs \(frames.editor)"
            )
            XCTAssertLessThanOrEqual(
                frames.editor.maxY,
                frames.actions.minY + 1,
                "editor/actions: \(frames.editor) vs \(frames.actions)"
            )
        }

        await settle()
        let initial = try frames()
        assertBounded(initial)
        XCTAssertEqual(initial.editor.height, ComposerGeometry.compactEditorMinimumHeight, accuracy: 1)
        initial.textView.inputView = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        XCTAssertTrue(initial.textView.becomeFirstResponder())

        let selectedRichText = "Confirm pickup\nPack weather layers\nKeep school calendar unchanged\nTime\tOwner\tStatus\n08:30\tAda\t"
        UIPasteboard.general.items = [[
            UTType.plainText.identifier: selectedRichText,
            UTType.html.identifier: "<p>\(selectedRichText)</p>",
        ]]
        try await ComposerPasteChangeObserver(
            view: initial.textView,
            expectedText: selectedRichText
        ).pasteAndWait()
        await settle()
        let pasted = try frames()
        assertBounded(pasted)
        XCTAssertGreaterThan(pasted.editor.height, initial.editor.height + 20)

        let sixLines = (1...6).map { "line \($0)" }.joined(separator: "\n")
        pasted.textView.selectedRange = NSRange(
            location: 0,
            length: (pasted.textView.text as NSString).length
        )
        UIPasteboard.general.items = [[
            UTType.plainText.identifier: sixLines,
            UTType.html.identifier: "<p>\(sixLines)</p>",
        ]]
        try await ComposerPasteChangeObserver(view: pasted.textView, expectedText: sixLines).pasteAndWait()
        await settle()
        let six = try frames()
        assertBounded(six)
        XCTAssertGreaterThan(six.editor.height, initial.editor.height + 20)

        let longText = (1...18).map { "long line \($0) stays reachable" }.joined(separator: "\n")
        six.textView.selectedRange = NSRange(
            location: 0,
            length: (six.textView.text as NSString).length
        )
        UIPasteboard.general.items = [[
            UTType.plainText.identifier: longText,
            UTType.html.identifier: "<p>\(longText)</p>",
        ]]
        try await ComposerPasteChangeObserver(view: six.textView, expectedText: longText).pasteAndWait()
        await settle()
        let long = try frames()
        assertBounded(long)
        XCTAssertLessThanOrEqual(long.editor.height, six.editor.height + 1)
        XCTAssertGreaterThan(long.textView.contentSize.height, long.textView.bounds.height + 1)
        long.textView.layoutIfNeeded()
        let immediateCaretPosition = try XCTUnwrap(
            long.textView.position(
                from: long.textView.beginningOfDocument,
                offset: long.textView.selectedRange.location
            )
        )
        let immediateCaret = long.textView.caretRect(for: immediateCaretPosition)
        XCTAssertTrue(
            long.textView.bounds.insetBy(dx: 0, dy: -1).intersects(immediateCaret),
            "caret must be visible immediately after overflow paste"
        )

        long.textView.selectedRange = NSRange(
            location: (longText as NSString).length,
            length: 0
        )
        long.textView.scrollRangeToVisible(long.textView.selectedRange)
        long.textView.layoutIfNeeded()
        let end = try XCTUnwrap(
            long.textView.position(
                from: long.textView.beginningOfDocument,
                offset: long.textView.selectedRange.location
            )
        )
        var caret = long.textView.caretRect(for: end)
        long.textView.scrollRectToVisible(caret, animated: false)
        long.textView.setContentOffset(
            CGPoint(
                x: long.textView.contentOffset.x,
                y: max(
                    -long.textView.adjustedContentInset.top,
                    long.textView.contentSize.height - long.textView.bounds.height +
                        long.textView.adjustedContentInset.bottom
                )
            ),
            animated: false
        )
        long.textView.layoutIfNeeded()
        caret = long.textView.caretRect(for: end)
        XCTAssertTrue(long.textView.bounds.insetBy(dx: 0, dy: -1).intersects(caret))

        long.textView.insertText(" tail")
        await settle()
        XCTAssertTrue(long.textView.text.hasSuffix(" tail"))
        long.textView.selectedRange = NSRange(
            location: (longText as NSString).length,
            length: 5
        )
        long.textView.deleteBackward()
        await settle()
        XCTAssertEqual(long.textView.text, longText)
        assertBounded(try frames())

        host.additionalSafeAreaInsets.bottom = 320
        await settle()
        let resized = try frames()
        assertBounded(resized)
        XCTAssertLessThanOrEqual(resized.actions.maxY, window.bounds.maxY + 1)
    }
}

private func composerDescendants(_ view: UIView) -> [UIView] {
    [view] + view.subviews.flatMap { composerDescendants($0) }
}

private struct ComposerLayoutRegressionFixture: View {
    let draft: String

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                ComposerLayoutProbe(id: "chat-topbar")
                    .overlay(alignment: .leading) {
                        Text("Sentient chat")
                            .padding(.leading, 16)
                    }
                    .frame(height: 56)
                ZStack(alignment: .topLeading) {
                    Text("Existing chat content")
                        .padding(20)
                    ComposerLayoutProbe(id: "chat-content")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }

            Composer(
                tasks: [],
                ttsEnabled: true,
                talkMode: .idle,
                micLevels: [],
                voiceDisabled: false,
                canInterrupt: false,
                initialDraft: draft,
                onSend: { _ in },
                onVoiceIntent: { _ in },
                onTtsToggle: {},
                onInterrupt: {},
                onFocusGained: {}
            )
            .background(ComposerLayoutProbe(id: "composer-layout"))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ComposerLayoutProbe: UIViewRepresentable {
    let id: String

    func makeUIView(context: Context) -> ComposerLayoutProbeView {
        let view = ComposerLayoutProbeView()
        view.probeID = id
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        return view
    }

    func updateUIView(_ uiView: ComposerLayoutProbeView, context: Context) {}

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: ComposerLayoutProbeView,
        context: Context
    ) -> CGSize? {
        CGSize(width: proposal.width ?? 0, height: proposal.height ?? 0)
    }
}

private final class ComposerLayoutProbeView: UIView {
    var probeID = ""
}

@MainActor
private final class ComposerFocusTestModel {
    var draft = "seed"
    var sent: [String] = []
}

private struct ComposerFocusRegressionFixture: View {
    let model: ComposerFocusTestModel
    let draft: String

    var body: some View {
        Composer(
            tasks: [],
            ttsEnabled: true,
            talkMode: .idle,
            micLevels: [],
            voiceDisabled: false,
            canInterrupt: false,
            draftText: draft,
            onDraftChange: { model.draft = $0 },
            onSend: { model.sent.append($0) },
            onVoiceIntent: { _ in },
            onTtsToggle: {},
            onInterrupt: {},
            onFocusGained: {}
        )
        .environment(\.horizontalSizeClass, .compact)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ComposerInternalStateRegressionFixture: View {
    private let tasks = [
        TaskListItem(
            id: "travel",
            toolName: "Check travel",
            kind: "background",
            status: "running",
            argsPreview: "Friday evening · four people",
            startedAtMs: 1_000,
            endedAtMs: nil
        ),
        TaskListItem(
            id: "calendar",
            toolName: "Update calendar",
            kind: "foreground",
            status: "done",
            argsPreview: "Shared family calendar",
            startedAtMs: 1_200,
            endedAtMs: 1_600
        ),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Composer(
                tasks: tasks,
                ttsEnabled: true,
                talkMode: .idle,
                micLevels: [],
                voiceDisabled: false,
                canInterrupt: false,
                initialDraft: "",
                initiallyExpandedTaskId: tasks.first?.id,
                onSend: { _ in },
                onVoiceIntent: { _ in },
                onTtsToggle: {},
                onInterrupt: {},
                onFocusGained: {}
            )
        }
        .environment(\.horizontalSizeClass, .compact)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
