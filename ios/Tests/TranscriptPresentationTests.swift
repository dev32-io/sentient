import MobileData
import SwiftUI
import Testing
import UIKit
@testable import SentientApp

struct TranscriptPresentationTests {
    @Test func measuredFadesShareReadableBoundariesWithoutDoubleCountingKeyboard() {
        let viewport = CGRect(x: 30, y: 100, width: 390, height: 700)
        let header = CGRect(x: 30, y: 100, width: 390, height: 60)
        let dock = CGRect(x: 46, y: 700, width: 358, height: 100)
        let normal = TranscriptOverlayGeometry(viewport: viewport, header: header, composer: dock)
        #expect(normal.topClearance == 84)
        #expect(normal.topBand.maxY == normal.topClearance)
        #expect(normal.bottomClearance == 124)
        #expect(normal.bottomBand == CGRect(x: 0, y: 576, width: 390, height: 124))
        let keyboard = TranscriptOverlayGeometry(viewport: viewport, header: header, composer: dock.offsetBy(dx: 0, dy: -300))
        #expect(keyboard.bottomClearance == normal.bottomClearance, "Native collection owns keyboard overlap, not dock geometry")
        #expect(keyboard.bottomBand.maxY == normal.bottomBand.maxY - 300)
        #expect(keyboard.bottomBand.width == viewport.width, "Fade spans transcript, not narrow composer")
    }

    @Test func reservedNoticesAndMissingDockDoNotInventOcclusion() {
        let viewport = CGRect(x: 0, y: 300, width: 390, height: 500)
        let geometry = TranscriptOverlayGeometry(viewport: viewport,
            header: CGRect(x: 0, y: 100, width: 390, height: 60), composer: nil)
        #expect(geometry.topClearance == 0)
        #expect(geometry.bottomClearance == 0)
        #expect(geometry.topBand.height == 0)
        #expect(geometry.bottomBand == .zero)
        let small = CGRect(x: 0, y: 100, width: 320, height: 40)
        let crowded = TranscriptOverlayGeometry(viewport: small, header: small, composer: small)
        #expect(crowded.topClearance == small.height)
        #expect(crowded.bottomClearance == small.height)
        #expect(crowded.topBand == crowded.bottomBand)
    }

    @Test func exposedRampDoesNotDiluteWithDockGrowthOrKeyboardTranslation() {
        let viewport = CGRect(x: 0, y: 100, width: 390, height: 700)
        for height: CGFloat in [100, 133, 280] {
            for bottom: CGFloat in [800, 500] {
                let dock = CGRect(x: 0, y: bottom - height, width: 390, height: height)
                let geometry = TranscriptOverlayGeometry(viewport: viewport, header: .zero, composer: dock)
                let edge = dock.minY - viewport.minY
                #expect(geometry.bottomOpacity(at: edge - 24) == 0)
                #expect(abs(geometry.bottomOpacity(at: edge - 12) - 0.325) < 0.001)
                #expect(geometry.bottomOpacity(at: edge) == 0.65)
                #expect(geometry.bottomOpacity(at: geometry.bottomBand.maxY) == 0.65)
                #expect(geometry.bottomClearance == height + 24)
            }
        }
        let clipped = TranscriptOverlayGeometry(viewport: viewport, header: .zero,
            composer: CGRect(x: 0, y: 110, width: 390, height: 100))
        #expect(clipped.bottomBand.minY == 0)
        #expect(abs(clipped.bottomOpacity(at: 0) - 0.65 * 14 / 24) < 0.001,
                "Clipping preserves original ramp, rather than stretching its visible remnant")
    }

    @MainActor
    @Test func byteProgressRefreshesOnlyOwningPresentationNotMeasuredHeightOrIdentity() {
        let file = NativeDraftAttachment(id: "progress-file", displayName: "fixture.png", mediaType: "image/png", sizeBytes: 100, localPath: "")
        let pending = PendingMessage(id: "progress-send", text: "Fixture", status: .queued, sentAtMs: nil)
        func row(_ progress: Double, phase: AttachmentTransferState.Phase = .uploading) -> MessageLayoutRow {
            MessageLayoutRow(row: .pending(pending, index: 0), avatarMode: .idle,
                pendingAttachments: [file], pendingAttachmentTransfers: [file.id: .init(phase: phase, progress: progress)])
        }
        let first = row(0.1), later = row(0.8), bytesDone = row(1), response = row(1, phase: .ready)
        #expect(first.id == later.id)
        #expect(first.measurementRevision == later.measurementRevision)
        #expect(first.revision != later.revision)
        #expect(bytesDone.pendingAttachmentTransfers[file.id]?.phase == .uploading)
        #expect(bytesDone.revision != response.revision, "Byte completion is not upload response or message receipt")
    }
}

// Full-window host uses production ChatTranscriptColumn, inside the same bounded
// drawer + NavigationStack proposal. No root safe-area override or fixed fake inset.
@MainActor
@Suite(.serialized)
struct ChatEdgeViewportTests {
    @Test(arguments: ["normal", "expanded", "accessibility", "keyboard", "notice", "cube"])
    func physicalSystemAreasPaintMovingRowsWithoutMovingControls(configuration: String) async throws {
        let harness = try EdgeViewportHost(configuration: configuration)
        defer { harness.close() }
        let collection = try await harness.collection()
        try await harness.settle(collection)
        let model = harness.model
        let safe = harness.window.safeAreaInsets
        #expect(safe.top > 0 && safe.bottom > 0, "Real system safe areas required")
        let header = try #require(model.header)
        let dock = model.dock
        #expect(abs(header.minY - safe.top) <= 1)
        if let dock { #expect(abs(dock.maxY - harness.window.bounds.maxY + safe.bottom) <= 1) }
        if configuration == "expanded" {
            model.draft = Array(repeating: "Synthetic expanded composer", count: 6).joined(separator: "\n")
            try await harness.wait { (model.dock?.height ?? 0) > (dock?.height ?? 0) + 20 }
        }
        if configuration == "keyboard" {
            try await harness.keyboard(show: true, collection: collection)
        }
        try await harness.settle(collection)
        let viewport = collection.convert(collection.bounds, to: harness.window)
        let controls = (model.header, model.dock, model.notice)
        if configuration == "notice" {
            let notice = try #require(model.notice)
            #expect(notice.minY >= header.maxY)
            #expect(viewport.minY >= notice.maxY)
            let reservedHeight = (harness.window.bounds.height - safe.top - safe.bottom - header.height - (dock?.height ?? 0)) / 2
            #expect(abs(viewport.minY - header.maxY - reservedHeight) <= 1, "Existing reserved notice region must not move")
            #expect(model.overlays?.topClearance == 0)
        } else {
            #expect(abs(viewport.minY) <= 1, "Native clip must reach physical top, not safe-area top")
        }
        #expect(abs(viewport.maxY - harness.window.bounds.maxY) <= 1,
                "Native clip must reach physical home-indicator edge even with keyboard")
        #expect(collection.clipsToBounds)
        let readable = collection.convert(collection.bounds.inset(by: collection.adjustedContentInset), to: harness.window)
        if let dock = model.dock {
            #expect(abs(readable.maxY - (dock.minY - TranscriptOverlayGeometry.spill)) <= 1,
                    "System/keyboard bottom clearance counted exactly once")
        } else {
            #expect(abs(readable.maxY - (harness.window.bounds.maxY - safe.bottom)) <= 1)
        }
        if configuration != "notice" {
            #expect(abs(readable.minY - header.maxY - TranscriptOverlayGeometry.spill) <= 1)
        }

        #expect(abs((model.placeholderFrame?.midY ?? 0) - readable.midY) <= 1,
                "Empty/loading overlay center must use the same physical readable bounds")
        let layout = try #require(collection.collectionViewLayout as? ExactMessageLayout)
        let index = try #require(layout.rowFrames.indices.max { layout.rowFrames[$0].height < layout.rowFrames[$1].height })
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.setContentOffset(CGPoint(x: 0, y: layout.rowFrames[index].minY + 100), animated: false)
        try await harness.settle(collection)
        let cell = try #require(collection.cellForItem(at: IndexPath(item: index, section: 0)))
        let marks = EdgeViewportRowMarks(frame: CGRect(x: 0, y: 0, width: cell.bounds.width, height: viewport.height + 300))
        #expect(marks.frame.maxY < cell.bounds.height, "Marks stay inside real row, never synthetic tail")
        marks.isUserInteractionEnabled = false
        cell.addSubview(marks)
        defer { marks.removeFromSuperview() }
        let initialOffset = collection.contentOffset.y
        var images: [UIImage] = []
        for step in 0...1 {
            collection.setContentOffset(CGPoint(x: 0, y: initialOffset + CGFloat(16 * step)), animated: false)
            try await harness.settle(collection)
            let image = UIGraphicsImageRenderer(bounds: harness.window.bounds).image { _ in
                harness.window.drawHierarchy(in: harness.window.bounds, afterScreenUpdates: true)
            }
            images.append(image)
            Attachment.record(image, named: "chat-edge-\(configuration)-\(step).png", as: .png)
            #expect(model.header == controls.0 && model.dock == controls.1 && model.notice == controls.2)
        }
        func movingPixel(x: CGFloat, y: CGFloat) throws -> Int {
            func pixel(_ image: UIImage) throws -> [Int] {
                let cg = try #require(image.cgImage)
                let data = try #require(cg.dataProvider?.data)
                let bytes = try #require(CFDataGetBytePtr(data))
                let offset = Int(y * image.scale) * cg.bytesPerRow + Int(x * image.scale) * cg.bitsPerPixel / 8
                return (0..<3).map { Int(bytes[offset + $0]) }
            }
            return try zip(pixel(images[0]), pixel(images[1])).reduce(0) { $0 + abs($1.0 - $1.1) }
        }
        // Away from island/status glyphs; inside actual physical system strips.
        if configuration != "notice" {
            #expect(try movingPixel(x: 3, y: safe.top / 2) > 20,
                    "Moving row paint must cross status safe area through production fade")
        }
        if configuration != "keyboard" {
            #expect(try movingPixel(x: 3, y: harness.window.bounds.maxY - safe.bottom / 2) > 20,
                    "Moving row paint must cross home-indicator safe area")
        }
        Attachment.record("viewport=\(viewport),safe=\(safe),header=\(String(describing: controls.0)),dock=\(String(describing: controls.1)),notice=\(String(describing: controls.2)),readable=\(readable),placeholder=\(String(describing: model.placeholderFrame)),inset=\(collection.adjustedContentInset),offsets=\(initialOffset),\(initialOffset + 16)", named: "chat-edge-\(configuration)-geometry.txt")
        if configuration == "keyboard" {
            let offset = collection.contentOffset.y
            try await harness.keyboard(show: false, collection: collection)
            try await harness.settle(collection)
            #expect(abs(collection.contentOffset.y - offset) <= 1, "Dismissal cannot reacquire send ownership")
            #expect(model.header == header && model.dock == dock)
            #expect(abs(collection.convert(collection.bounds, to: harness.window).maxY - harness.window.bounds.maxY) <= 1)
            images = []
            for step in 0...1 {
                collection.setContentOffset(CGPoint(x: 0, y: offset + CGFloat(16 * step)), animated: false)
                try await harness.settle(collection)
                let image = UIGraphicsImageRenderer(bounds: harness.window.bounds).image { _ in
                    harness.window.drawHierarchy(in: harness.window.bounds, afterScreenUpdates: true)
                }
                images.append(image)
                Attachment.record(image, named: "chat-edge-keyboard-dismissed-\(step).png", as: .png)
            }
            #expect(try movingPixel(x: 3, y: harness.window.bounds.maxY - safe.bottom / 2) > 20,
                    "Dismissed keyboard must reveal moving rows in home-indicator strip")
        }
    }

    @Test func edgeViewportKeepsFirstLastAndContextualSendReadable() async throws {
        let harness = try EdgeViewportHost(configuration: "normal")
        defer { harness.close() }
        let collection = try await harness.collection()
        try await harness.settle(collection)
        let model = harness.model
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.setContentOffset(CGPoint(x: 0, y: -collection.adjustedContentInset.top), animated: false)
        try await harness.settle(collection)
        let first = try #require(collection.cellForItem(at: IndexPath(item: 1, section: 0)))
        #expect(first.convert(first.bounds, to: harness.window).minY >= (model.header?.maxY ?? 0) + 24)
        model.pending = [PendingMessage(id: "edge-send", text: "Synthetic send", status: .queued, sentAtMs: nil)]
        try await harness.wait { collection.visibleCells.contains { $0.accessibilityIdentifier == "chat-user-row-edge-send" } }
        try await harness.settle(collection)
        let sent = try #require(collection.visibleCells.first { $0.accessibilityIdentifier == "chat-user-row-edge-send" })
        let readable = collection.convert(collection.bounds.inset(by: collection.adjustedContentInset), to: harness.window)
        let sendY = sent.convert(sent.bounds, to: harness.window).minY
        #expect(abs(sendY - readable.minY - readable.height * 0.2) <= 1)
        model.draft = Array(repeating: "Expanded draft", count: 6).joined(separator: "\n")
        try await harness.settle(collection)
        #expect(abs(sent.convert(sent.bounds, to: harness.window).minY - sendY) <= 1)
        try await harness.keyboard(show: true, collection: collection)
        try await harness.settle(collection)
        #expect(abs(sent.convert(sent.bounds, to: harness.window).minY - sendY) <= 1)
        try await harness.keyboard(show: false, collection: collection)
        try await harness.settle(collection)
        #expect(abs(sent.convert(sent.bounds, to: harness.window).minY - sendY) <= 1)
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.setContentOffset(CGPoint(x: 0, y: collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom), animated: false)
        try await harness.settle(collection)
        #expect(sent.convert(sent.bounds, to: harness.window).maxY <= (model.dock?.minY ?? 0) - 24 + 1)
    }
}

@MainActor
private final class EdgeViewportModel: ObservableObject {
    @Published var header: CGRect?
    @Published var dock: CGRect?
    @Published var viewport: CGRect?
    @Published var notice: CGRect?
    @Published var placeholderFrame: CGRect?
    @Published var draft = ""
    @Published var pending: [PendingMessage] = []
    var overlays: TranscriptOverlayGeometry? {
        guard let viewport, let header else { return nil }
        return TranscriptOverlayGeometry(viewport: viewport, header: header, composer: dock)
    }
}

private struct EdgeViewportFixture: View {
    @ObservedObject var model: EdgeViewportModel
    let configuration: String
    var body: some View {
        NavigationStack {
            SideDrawer(isOpen: .constant(false), onOpen: {}) {
                ChatTranscriptColumn(reservesNotices: configuration == "notice" && model.header != nil,
                                     titleBarHeight: model.header?.height ?? 0, composerHeight: model.dock?.height ?? 0) { containerInsets in
                    MessageList(messages: [ChatMessage(ts: 1_700_000_000_000, role: "user",
                        content: Array(repeating: "Synthetic viewport row", count: 240).joined(separator: "\n"),
                        streaming: false, cutoffKind: nil, turnId: "edge-row", replyId: nil, pendingId: nil, entryId: "edge-row")],
                        pending: model.pending, bottomOcclusion: model.overlays?.bottomClearance ?? 0,
                        topOcclusion: model.overlays?.topClearance, initialExistingHistory: true)
                        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { model.viewport = $0 }
                        .overlay(alignment: .topLeading) {
                            if let overlays = model.overlays { TranscriptFades(geometry: overlays) }
                        }
                        .overlay {
                            Color.clear.frame(width: 1, height: 1)
                                .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { model.placeholderFrame = $0 }
                                .padding(.top, model.overlays?.topClearance ?? 0)
                                .padding(.bottom, chatTranscriptPlaceholderBottomInset(viewport: model.viewport, composer: model.dock, safeAreaBottom: containerInsets.bottom))
                                .allowsHitTesting(false)
                        }
                } notices: {
                    Button("Retry synthetic recovery", action: {})
                        .padding()
                        .accessibilityIdentifier("edge-notice-retry")
                        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { model.notice = $0 }
                } titleBar: {
                    ChatTitleBar(onOpenPanel: {}, onOpenInbox: {}, onNewChat: {})
                        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { model.header = $0 }
                } composer: {
                    if configuration != "cube" {
                        Composer(tasks: [], ttsEnabled: true, talkMode: .idle, micLevels: [0],
                            voiceDisabled: true, canInterrupt: false, draftText: model.draft,
                            onDraftChange: { model.draft = $0 }, onSend: { _ in }, onVoiceIntent: { _ in },
                            onTtsToggle: {}, onInterrupt: {}, onFocusGained: {})
                            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { model.dock = $0 }
                    }
                }
            } drawer: { EmptyView() }
        }
        .environment(\.dynamicTypeSize, configuration == "accessibility" ? .accessibility3 : .large)
    }
}

@MainActor
private final class EdgeViewportHost {
    let model = EdgeViewportModel()
    let window: UIWindow
    let host: UIHostingController<EdgeViewportFixture>
    init(configuration: String) throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        host = UIHostingController(rootView: EdgeViewportFixture(model: model, configuration: configuration))
        window.rootViewController = host
        window.makeKeyAndVisible()
    }
    func close() {
        window.endEditing(true)
        window.isHidden = true
        window.rootViewController = nil
    }
    func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
    func wait(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            host.view.layoutIfNeeded()
            if condition() { return }
            try await DisplayFrameWaiter.next()
        }
        throw EdgeViewportTimeout()
    }
    func collection() async throws -> MessageUICollectionView {
        try await wait { descendants(host.view).contains { $0 is MessageUICollectionView } }
        return try #require(descendants(host.view).compactMap { $0 as? MessageUICollectionView }.first)
    }
    func settle(_ collection: UICollectionView) async throws {
        var previous = CGRect.null
        var stable = 0
        try await wait {
            collection.layoutIfNeeded()
            let current = CGRect(origin: collection.contentOffset, size: collection.contentSize)
            if collection.alpha == 1 && !collection.visibleCells.isEmpty && model.overlays != nil && current == previous
                && collection.layer.animationKeys()?.isEmpty != false { stable += 1 } else { stable = 0 }
            previous = current
            return stable >= 6
        }
    }
    func keyboard(show: Bool, collection: MessageUICollectionView) async throws {
        let editor = try #require(descendants(host.view).compactMap { $0 as? UITextView }.first)
        var completed = false
        let observer = NotificationCenter.default.addObserver(forName: show ? UIResponder.keyboardDidShowNotification : UIResponder.keyboardDidHideNotification,
            object: nil, queue: .main) { _ in MainActor.assumeIsolated { completed = true } }
        defer { NotificationCenter.default.removeObserver(observer) }
        #expect(show ? editor.becomeFirstResponder() : editor.resignFirstResponder())
        try await wait { completed && (show ? collection.keyboardOverlap > 0 : collection.keyboardOverlap == 0) }
    }
}

private struct EdgeViewportTimeout: Error {}
private final class EdgeViewportRowMarks: UIView {
    override func draw(_ rect: CGRect) {
        for stripe in 0..<Int(ceil(bounds.height / 16)) {
            (stripe.isMultiple(of: 2) ? UIColor.white : UIColor.black).setFill()
            UIRectFill(CGRect(x: 0, y: CGFloat(stripe * 16), width: bounds.width, height: 16))
        }
    }
}
