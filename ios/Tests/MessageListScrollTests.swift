import Combine
import Darwin
import NetworkImage
import SwiftUI
import Testing
import UIKit
import WebKit
import MobileData
@testable import SentientApp

@MainActor
@Suite(.serialized)
struct MessageListScrollTests {
    @Test func hostedContentStaysTopAlignedBeforeAndAfterCellHeightCatchesUp() async throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 733)
        let controller = UIViewController()
        window.rootViewController = controller
        let cell = MessageHostingCell(frame: CGRect(x: 0, y: 150, width: 393, height: 80))
        controller.view.addSubview(cell)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        var reports: [CGRect] = []
        for height: CGFloat in [80, 200, 120, 260] {
            let before = reports.count
            cell.set(rootView: AnyView(
                Color.clear.frame(width: 393, height: height)
                    .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) {
                        reports.append($0)
                    }
            ), avatarPlaybackEnabled: false, configurationKey: "\(height)", measurementKey: "\(height)")
            try await waitUntil(timeout: 3) {
                cell.setNeedsLayout()
                cell.layoutIfNeeded()
                return reports.count > before && abs((reports.last?.height ?? 0) - height) < 1
            }
            // Content changes before the recycler applies its newly reported height.
            // The old cell bounds must not vertically center the new content.
            let top = cell.convert(CGPoint.zero, to: nil).y
            #expect(reports.dropFirst(before).allSatisfy { abs($0.minY - top) < 1 })
            cell.frame.size.height = height
            cell.setNeedsLayout()
            cell.layoutIfNeeded()
            try await DisplayFrameWaiter.next()
            #expect(abs((reports.last?.minY ?? 0) - top) < 1)
        }
    }

    @Test func allMessagePhasesMountOneNativeDocumentAndPendingStaysLiteral() async throws {
        let messages = [
            Self.message(
                id: "selectable-user", role: "user",
                content: "# User heading\n\nSelect this **user** paragraph."
            ),
            Self.message(
                id: "selectable-assistant", role: "assistant",
                content: "## Assistant heading\n\nSelect this `assistant` paragraph."
            ),
        ]
        let pendingID = "selectable-pending"
        let harness = try Harness(
            messages: messages,
            pending: [PendingMessage(id: pendingID, text: "Pending copy", status: .queued, sentAtMs: nil)]
        )
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await waitUntil(timeout: 10) {
            collection.numberOfItems(inSection: 0) >= 4 && !collection.visibleCells.isEmpty
        }

        // Verify each chronology row, without assuming all three fit one viewport.
        var previouslySelectedState: MessageDocumentState?
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        for index in 1...3 {
            let path = IndexPath(item: index, section: 0)
            collection.scrollToItem(at: path, at: .centeredVertically, animated: false)
            try await waitUntil(timeout: 5) {
                guard let cell = collection.cellForItem(at: path) else { return false }
                return descendants(cell).compactMap { $0 as? MessageDocumentView }.count == 1
            }
            let cell = try #require(collection.cellForItem(at: path))
            let document = try #require(descendants(cell).compactMap { $0 as? MessageDocumentView }.first)
            #expect(descendants(collection).compactMap { $0 as? WKWebView }.isEmpty)
            document.selectAll(nil)
            if let previouslySelectedState, previouslySelectedState !== document.state {
                #expect(previouslySelectedState.selection == nil, "Selection ownership transfers even when previous row was recycled")
            }
            previouslySelectedState = document.state
            document.copy(nil)
            #expect(UIPasteboard.general.string == document.document.plain)
            #expect(document.state.layout === document.state.measure(width: document.bounds.width, traits: document.traitCollection))
        }
        let pendingCell = try #require(collection.visibleCells.first {
            $0.accessibilityIdentifier == "chat-user-row-\(pendingID)"
        })
        let pending = try #require(descendants(pendingCell).compactMap { $0 as? MessageDocumentView }.first)
        #expect(pending.document.literal)
        #expect(pending.document.plain == "Pending copy")
    }

    @Test func finalizationKeepsNativeLayoutAndEverySampledFramePaintable() async throws {
        let content = "## Same source\n\nA **rich** café 👩🏽‍💻 paragraph.\n\n| A | B |\n| --- | --- |\n| partial | 東京 |"
        let harness = try Harness(messages: [Self.message(id: "phase", role: "assistant", content: content, streaming: true)])
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: 1, requireRenderedMarkdown: true)
        let view = try #require(collection.visibleCells.flatMap { descendants($0) }.compactMap { $0 as? MessageDocumentView }.first)
        let layout = try #require(view.state.layout)
        let identity = ObjectIdentifier(view.state)
        let initialHeight = view.measuredHeight
        harness.model.messages = [Self.message(id: "phase", role: "assistant", content: content)]
        for frameIndex in 0..<12 {
            try await DisplayFrameWaiter.next()
            let current = try #require(collection.visibleCells.flatMap { descendants($0) }.compactMap { $0 as? MessageDocumentView }.first)
            #expect(ObjectIdentifier(current.state) == identity)
            #expect(current.state.layout === layout)
            #expect(current.measuredHeight == initialHeight)
            #expect(current.alpha == 1 && !current.isHidden && current.bounds.height > 0)
            #expect(current.document.plain == view.document.plain)
            // Frame-based raster witness, not a source-level no-alpha assertion.
            let frame = UIGraphicsImageRenderer(bounds: current.bounds).image { _ in
                current.drawHierarchy(in: current.bounds, afterScreenUpdates: true)
            }
            Attachment.record(frame, named: "live-final-\(frameIndex).png", as: .png)
            if frameIndex == 6, let window = current.window {
                let fullFrame = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                Attachment.record(fullFrame, named: "live-final-full-frame.png", as: .png)
            }
            let image = try #require(frame.cgImage)
            let firstRange = try #require(current.document.blocks.first?.range)
            let ink = current.selectionRects(for: MessageTextRange(firstRange)).reduce(CGRect.null) { $0.union($1.rect) }
            let crop = ink.applying(CGAffineTransform(scaleX: frame.scale, y: frame.scale))
            let textImage = try #require(image.cropping(to: crop))
            var pixels = [UInt8](repeating: 0, count: textImage.width * textImage.height * 4)
            let painted = pixels.withUnsafeMutableBytes { bytes -> Bool in
                guard let context = CGContext(data: bytes.baseAddress, width: textImage.width, height: textImage.height,
                                              bitsPerComponent: 8, bytesPerRow: textImage.width * 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
                context.draw(textImage, in: CGRect(x: 0, y: 0, width: textImage.width, height: textImage.height))
                return stride(from: 3, to: bytes.count, by: 4).contains { bytes[$0] > 0 }
            }
            #expect(painted, "No blank heading frame during live-to-final handoff")
        }
        let history = try Harness(messages: [Self.message(id: "phase", role: "assistant", content: content)])
        defer { history.close() }
        let historyCollection = try await mountedCollection(in: history.host.view)
        try await settle(historyCollection, hostView: history.host.view, minimumItems: 1, requireRenderedMarkdown: true)
        let restored = try #require(historyCollection.visibleCells.flatMap { descendants($0) }.compactMap { $0 as? MessageDocumentView }.first)
        #expect(restored.measuredHeight == initialHeight)
        #expect(restored.document.plain == view.document.plain)
    }

    @Test func scrollingUnchangedLongMarkdownDoesNotReconfigureVisibleCells() async throws {
        let content = (1...100).map {
            "\($0). **Greeting variant** with a [reference](https://example.com) and `inline code`."
        }.joined(separator: "\n")
        let harness = try Harness(messages: [Self.message(id: "long-list", role: "assistant", content: content)])
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: 1, timeout: 10)
        let cells = collection.visibleCells.compactMap { $0 as? MessageHostingCell }
        #expect(!cells.isEmpty)
        let counts = cells.map(\.configurationCount)
        let offset = collection.contentOffset
        for index in 0..<20 {
            collection.setContentOffset(CGPoint(x: 0, y: offset.y - CGFloat(index % 2)), animated: false)
            collection.delegate?.scrollViewDidScroll?(collection)
        }
        #expect(cells.map(\.configurationCount) == counts)

        // Content updates still invalidate the displayed row, even with an idle avatar.
        harness.model.messages = [Self.message(
            id: "long-list", role: "assistant", content: content + "\n\nA newly completed paragraph."
        )]
        try await settle(collection, hostView: harness.host.view, minimumItems: 1, timeout: 10)
        #expect(zip(cells, counts).contains { $0.0.configurationCount > $0.1 })
    }

    @Test(arguments: DynamicTypeSetting.allCases)
    fileprivate func visibleGrowingListUsesRenderedHeightWithoutRemeasuringHistory(setting: DynamicTypeSetting) async throws {
        func messages(_ count: Int, streaming: Bool = true) -> [ChatMessage] {
            [
                Self.message(id: "list-user", role: "user", content: "List items"),
                Self.message(id: "list-reply", role: "assistant", content: (1...count).map {
                    "\($0). **Item** with enough text to wrap onto another line at phone width."
                }.joined(separator: "\n"), streaming: streaming),
            ]
        }
        let harness = try Harness(messages: messages(1), dynamicType: setting, initialExistingHistory: false)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view, minimumItems: 3,
            requireRenderedMarkdown: true
        )
        let native = try #require(collection as? MessageUICollectionView)
        let measured = native.measuredRowCount
        let neighbor = try #require(collection.cellForItem(at: IndexPath(item: 1, section: 0)) as? MessageHostingCell)
        let neighborConfigurations = neighbor.configurationCount
        let layout = try #require(collection.collectionViewLayout as? ExactMessageLayout)
        var height = layout.rowHeights[2]
        for count in [5, 20, 50, 100] {
            harness.model.messages = messages(count)
            try await waitUntil(timeout: 5) { layout.rowHeights[2] > height + 1 }
            try await settle(collection, hostView: harness.host.view, minimumItems: 3, timeout: 10)
            height = layout.rowHeights[2]
            #expect(native.measuredRowCount == measured)
            #expect(neighbor.configurationCount == neighborConfigurations)
        }
        // Commit changes renderer phase but must retain the same visible sizing path.
        harness.model.messages = messages(100, streaming: false)
        try await settle(
            collection, hostView: harness.host.view, minimumItems: 3, timeout: 10,
            requireRenderedMarkdown: true
        )
        #expect(native.measuredRowCount == measured)
        let finalHeight = layout.rowHeights[2]
        let samples = try await traverse(collection, hostView: harness.host.view)
        let settledHeight = try #require(samples.last)
        #expect(samples.allSatisfy { abs($0 - settledHeight) < 1 })
        #expect(native.measuredRowCount == measured)

        // Cold exact measurement remains an independent reference for rendered size.
        let reference = try Harness(messages: messages(100, streaming: false), dynamicType: setting)
        defer { reference.close() }
        let referenceCollection = try await mountedCollection(in: reference.host.view)
        try await settle(
            referenceCollection, hostView: reference.host.view, minimumItems: 3, timeout: 10,
            requireRenderedMarkdown: true
        )
        let referenceLayout = try #require(referenceCollection.collectionViewLayout as? ExactMessageLayout)
        #expect(abs(finalHeight - referenceLayout.rowHeights[2]) < 1)
    }

    @Test func equalHeightRevisionIsCachedBeforeRecycleAndUnseenGrowthStillMeasuresExactly() async throws {
        var messages = Self.readerHistory + [Self.message(
            id: "cached-live", role: "assistant", content: "One.", streaming: true
        )]
        let harness = try Harness(messages: messages, initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view, minimumItems: messages.count, timeout: 10,
            requireRenderedMarkdown: true
        )
        let native = try #require(collection as? MessageUICollectionView)
        let measured = native.measuredRowCount
        let lastIndex = collection.numberOfItems(inSection: 0) - 1
        let lastCell = try #require(collection.cellForItem(at: IndexPath(item: lastIndex, section: 0)) as? MessageHostingCell)
        let configurations = lastCell.configurationCount
        let extent = collection.contentSize.height
        messages[messages.count - 1] = Self.message(id: "cached-live", role: "assistant", content: "Two.", streaming: true)
        harness.model.messages = messages
        try await waitUntil(timeout: 5) { lastCell.configurationCount > configurations }
        try await settle(
            collection, hostView: harness.host.view, minimumItems: messages.count,
            requireRenderedMarkdown: true
        )
        #expect(abs(collection.contentSize.height - extent) < 1)
        #expect(native.measuredRowCount == measured)

        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.setContentOffset(CGPoint(x: 0, y: minimumOffset(of: collection)), animated: false)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        #expect(!collection.indexPathsForVisibleItems.contains(IndexPath(item: lastIndex, section: 0)))
        // Force a receive with the same text after the revised cell is recycled.
        harness.model.bottomOcclusion = 1
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        #expect(native.measuredRowCount == measured)

        let previous = messages[messages.count - 1]
        messages[messages.count - 1] = ChatMessage(
            ts: previous.ts, role: previous.role, content: previous.content,
            streaming: true, cutoffKind: nil, turnId: "resolved-turn",
            replyId: previous.replyId, pendingId: nil, entryId: previous.entryId
        )
        harness.model.messages = messages
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        #expect(native.measuredRowCount == measured)

        messages[messages.count - 1] = Self.message(
            id: "cached-live", role: "assistant",
            content: (1...30).map { "\($0). More list content." }.joined(separator: "\n"), streaming: true
        )
        harness.model.messages = messages
        try await waitUntil(timeout: 5) { native.measuredRowCount > measured }
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        #expect(native.measuredRowCount == measured + 1)
        #expect(collection.contentSize.height > extent + 100)
        let samples = try await traverse(collection, hostView: harness.host.view)
        let settledSamples = try await traverse(collection, hostView: harness.host.view)
        let finalSamples = try await traverse(collection, hostView: harness.host.view)
        let settledHeight = try #require(finalSamples.last)
        #expect(samples.allSatisfy { $0.isFinite && $0 > 0 })
        #expect(settledSamples.allSatisfy { abs($0 - settledHeight) < 1 })
        #expect(finalSamples.allSatisfy { abs($0 - settledHeight) < 1 })
    }

    @Test func coldAndWarmHistoryKeepMeasuredExtentThroughFirstAndLaterTraversal() async throws {
        for setting in DynamicTypeSetting.allCases {
            let harness = try Harness(messages: Self.gfmHistory, dynamicType: setting)
            defer { harness.close() }
            let measurementRevision = harness.model.measurementRevision
            let collection = try await mountedCollection(in: harness.host.view)
            try await settle(
                collection, hostView: harness.host.view,
                minimumItems: Self.gfmHistory.count, timeout: 10,
                measurement: (harness.model, measurementRevision)
            )

            let coldExtent = collection.contentSize.height
            #expect(coldExtent > collection.bounds.height)
            let coldSamples = try await traverse(collection, hostView: harness.host.view, captureName: "cold-\(setting.uiKit.rawValue)")
            let settledColdExtent = try #require(coldSamples.last)
            #expect(settledColdExtent.isFinite && settledColdExtent > 0)

            harness.model.messages = harness.model.messages
            try await settle(collection, hostView: harness.host.view, minimumItems: Self.gfmHistory.count)
            let warmSamples = try await traverse(collection, hostView: harness.host.view, captureName: "warm-\(setting.uiKit.rawValue)")
            let settledWarmExtent = try #require(warmSamples.last)
            #expect(warmSamples.allSatisfy { $0.isFinite && $0 > 0 })
            #expect(warmSamples.allSatisfy { abs($0 - settledWarmExtent) < 1 })
            #expect(abs(settledWarmExtent - settledColdExtent) < 1)
        }
    }

    @Test(arguments: SendOrigin.allCases)
    func newSendAlignsMountedRowToUsableViewportTop(origin: SendOrigin) async throws {
        let history = origin == .empty ? [] : Self.readerHistory
        let harness = try Harness(messages: history)
        defer { harness.close() }
        let pending = PendingMessage(id: origin.pendingID, text: Self.readerDetail, status: .queued, sentAtMs: nil)
        let collection: UICollectionView
        if origin == .empty {
            let measurementRevision = harness.model.measurementRevision
            harness.model.pending = [pending]
            collection = try await mountedCollection(in: harness.host.view)
            try await settle(
                collection, hostView: harness.host.view,
                minimumItems: 1, rowID: "chat-user-row-\(origin.pendingID)", timeout: 10,
                measurement: (harness.model, measurementRevision)
            )
        } else {
            collection = try await mountedCollection(in: harness.host.view)
            try await settle(
                collection, hostView: harness.host.view,
                minimumItems: history.count, timeout: 10
            )
            position(collection, at: origin)
            try await settle(collection, hostView: harness.host.view, minimumItems: history.count)
            harness.model.pending = [pending]
            try await settle(
                collection, hostView: harness.host.view,
                minimumItems: history.count + 1, rowID: "chat-user-row-\(origin.pendingID)"
            )
        }

        let frame = try mountedCellFrame(id: "chat-user-row-\(origin.pendingID)", in: collection)
        #expect(abs(frame.minY - expectedSendMinY(in: collection, priorContent: origin != .empty)) <= 1)
    }

    @Test(arguments: DynamicTypeSetting.allCases)
    fileprivate func measuredFloatingHeaderGatesTallSendAndKeepsPaintBelowControls(dynamicType: DynamicTypeSetting) async throws {
        let scheduler = HeldMessagePositionScheduler()
        let harness = try Harness(
            messages: [],
            pending: [PendingMessage(id: "header-first", text: Array(repeating: Self.readerDetail, count: 20).joined(separator: "\n"), status: .queued, sentAtMs: nil)],
            dynamicType: dynamicType, floatingHeader: true, headerMeasurementReady: false,
            initialExistingHistory: false, positionScheduler: scheduler.schedule
        )
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: 1, timeout: 10)
        scheduler.runAll()
        #expect(collection.alpha == 0, "Unmeasured header is not a zero-clearance landing")
        #expect(!harness.model.historyLoading)
        harness.model.headerMeasurementReady = true
        try await waitUntil(timeout: 3) {
            harness.host.view.layoutIfNeeded()
            scheduler.runAll()
            return collection.alpha == 1
        }
        try await settle(collection, hostView: harness.host.view, minimumItems: 1, rowID: "chat-user-row-header-first")
        scheduler.runAll()
        let header = try #require(harness.model.headerFrame)
        let drawable = collection.convert(collection.bounds, to: harness.window)
        #expect(abs(drawable.minY - header.minY) <= 1)
        #expect(drawable.height > header.height * 2)
        let cell = try #require(collection.visibleCells.first { $0.accessibilityIdentifier == "chat-user-row-header-first" })
        #expect(cell.convert(cell.bounds, to: harness.window).minY >= header.maxY - 1)
        let document = try #require(descendants(cell).compactMap { $0 as? MessageDocumentView }.first)
        #expect(document.convert(document.bounds, to: harness.window).minY >= header.maxY - 1)
        #expect(abs(try #require(document.selectionViewportInWindow?()).minY - header.maxY) <= 1)

        // Native user scrolling can paint inside the control band; it is not clipped/reserved.
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.contentOffset.y += header.height + 80
        try await settle(collection, hostView: harness.host.view, minimumItems: 1)
        scheduler.runAll()
        #expect(cell.convert(cell.bounds, to: harness.window).minY < header.maxY)
        let accessible = document.accessibleFrame(for: document.bounds)
        let screenHeaderBottom = UIAccessibility.convertToScreenCoordinates(header, in: harness.window).maxY
        #expect(!accessible.isEmpty && accessible.minY >= screenHeaderBottom - 1)
        let readingOffset = collection.contentOffset.y
        harness.model.headerExtraClearance = 24
        try await waitUntil(timeout: 3) {
            harness.host.view.layoutIfNeeded()
            scheduler.runAll()
            return (harness.model.headerFrame?.height ?? 0) > header.height + 20
        }
        try await settle(collection, hostView: harness.host.view, minimumItems: 1)
        scheduler.runAll()
        #expect(abs(collection.contentOffset.y - readingOffset) <= 1)
    }

    @Test func floatingHeaderTopOnlyChangesKeepContextKeyboardAndReaderOwnership() async throws {
        let harness = try Harness(messages: Self.readerHistory, floatingHeader: true, initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1, "History still opens at bottom")
        let drawableSize = collection.bounds.size
        harness.model.pending = [PendingMessage(id: "header-context", text: "Context send", status: .queued, sentAtMs: nil)]
        try await settle(collection, hostView: harness.host.view, minimumItems: 26, rowID: "chat-user-row-header-context")
        let native = try #require(collection as? MessageUICollectionView)
        let measured = native.measuredRowCount
        harness.model.headerExtraClearance = 30
        try await settle(collection, hostView: harness.host.view, minimumItems: 26, rowID: "chat-user-row-header-context")
        #expect(collection.bounds.size == drawableSize)
        #expect(native.measuredRowCount == measured, "Top-only geometry must not remeasure history")
        #expect(abs(try mountedCellFrame(id: "chat-user-row-header-context", in: collection).minY
            - expectedSendMinY(in: collection, priorContent: true)) <= 1)
        let sendY = try mountedCellFrame(id: "chat-user-row-header-context", in: collection).minY
        let screen = collection.convert(collection.bounds, to: nil)
        postKeyboardFrame(CGRect(x: screen.minX, y: screen.maxY - 220, width: screen.width, height: 220))
        try await settle(collection, hostView: harness.host.view, minimumItems: 26, rowID: "chat-user-row-header-context")
        #expect(abs(try mountedCellFrame(id: "chat-user-row-header-context", in: collection).minY - sendY) <= 1)
        postKeyboardFrame(CGRect(x: screen.minX, y: screen.maxY, width: screen.width, height: 220))

        // Same-speaker quick echo is a continuation whose paint starts above its cell.
        harness.model.messages.append(Self.message(id: "preceding-user", role: "user", content: "Earlier user"))
        harness.model.messages.append(Self.message(id: "header-echo", role: "user", content: "Context send", pendingID: "header-context"))
        harness.model.pending = []
        try await settle(collection, hostView: harness.host.view, minimumItems: 27, rowID: "chat-user-row-header-context")
        let echo = try mountedCellFrame(id: "chat-user-row-header-context", in: collection)
        let paintedTop = echo.minY + BubbleLayout.continuationPullup(width: collection.bounds.width)
        #expect(abs(paintedTop - expectedSendMinY(in: collection, priorContent: true)) <= 1)

        position(collection, at: .middle)
        try await settle(collection, hostView: harness.host.view, minimumItems: 27)
        let offset = collection.contentOffset.y
        harness.model.headerExtraClearance = 0
        harness.model.messages.append(Self.message(id: "header-stream", role: "assistant", content: Self.readerDetail, streaming: true))
        try await settle(collection, hostView: harness.host.view, minimumItems: 28)
        #expect(abs(collection.contentOffset.y - offset) <= 1, "Header + stream cannot reacquire send ownership")
        let readingCell = try #require(collection.visibleCells.min {
            abs($0.frame.midY - collection.bounds.midY) < abs($1.frame.midY - collection.bounds.midY)
        })
        let readingY = readingCell.convert(readingCell.bounds, to: harness.window).minY
        harness.host.additionalSafeAreaInsets.top = 18
        try await settle(collection, hostView: harness.host.view, minimumItems: 28)
        let header = try #require(harness.model.headerFrame)
        let drawable = collection.convert(collection.bounds, to: harness.window)
        #expect(abs(collection.adjustedContentInset.top - max(0, header.maxY - drawable.minY)) <= 1)
        #expect(abs(readingCell.convert(readingCell.bounds, to: harness.window).minY - readingY) <= 1)
    }

    @Test func floatingHeaderNewTranscriptWithoutSendIdentityStartsBelowControls() async throws {
        let harness = try Harness(
            messages: [Self.message(id: "new-transcript", role: "user", content: "Restored content")],
            floatingHeader: true, initialExistingHistory: false
        )
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: 2, timeout: 10)
        let header = try #require(harness.model.headerFrame)
        let cell = try #require(collection.visibleCells.first { $0.accessibilityIdentifier == "chat-user-row-new-transcript" })
        #expect(abs(collection.contentOffset.y - minimumOffset(of: collection)) <= 1)
        #expect(cell.convert(cell.bounds, to: harness.window).minY >= header.maxY - 1)
    }

    @Test func floatingHeaderShortHistoryRotationAndReservedNoticeUseActualOverlap() async throws {
        let harness = try Harness(messages: [Self.message(id: "short-header-history", role: "assistant", content: "Short history")], floatingHeader: true, initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: 2, timeout: 10)
        #expect(abs(collection.contentOffset.y - minimumOffset(of: collection)) <= 1)
        for size in [CGSize(width: 733, height: 393), CGSize(width: 320, height: 640)] {
            harness.window.frame.size = size
            harness.host.view.frame = harness.window.bounds
            try await settle(collection, hostView: harness.host.view, minimumItems: 2)
            let header = try #require(harness.model.headerFrame)
            let cell = try #require(collection.cellForItem(at: IndexPath(item: 1, section: 0)))
            #expect(cell.convert(cell.bounds, to: harness.window).minY >= header.maxY - 1)
        }
        harness.model.reservedNotice = true
        try await settle(collection, hostView: harness.host.view, minimumItems: 2)
        let header = try #require(harness.model.headerFrame)
        let drawable = collection.convert(collection.bounds, to: harness.window)
        #expect(drawable.minY > header.maxY, "Notice stays reserved below controls")
        #expect(harness.model.topOcclusion == 0, "Reserved header must not be charged twice")
        #expect(collection.contentInset.top == 0)
    }

    @Test func floatingComposerOcclusionKeepsFullViewportAndAddsScrollableClearance() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)
        harness.model.pending = [PendingMessage(
            id: "occlusion-send", text: "send", status: .queued, sentAtMs: nil
        )]
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-occlusion-send"
        )
        let bounds = collection.bounds.size
        let sendMinY = try mountedCellFrame(
            id: "chat-user-row-occlusion-send", in: collection
        ).minY

        harness.model.bottomOcclusion = 180
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-occlusion-send"
        )

        #expect(collection.bounds.size == bounds)
        #expect(abs(collection.contentInset.bottom - 180) < 0.5)
        #expect(abs(try mountedCellFrame(
            id: "chat-user-row-occlusion-send", in: collection
        ).minY - sendMinY) <= 1)
        collection.setContentOffset(CGPoint(x: 0, y: maximumOffset(of: collection)), animated: false)
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) < 0.5)
    }

    @Test func softwareKeyboardAddsClearanceWithoutRetargetingOwnedSend() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)
        harness.model.bottomOcclusion = 80
        harness.model.pending = [PendingMessage(
            id: "keyboard-send", text: "send", status: .queued, sentAtMs: nil
        )]
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-keyboard-send"
        )
        let native = try #require(collection as? MessageUICollectionView)
        let sendY = try mountedCellFrame(id: "chat-user-row-keyboard-send", in: collection).minY
        let offset = collection.contentOffset.y
        let screenFrame = collection.convert(collection.bounds, to: nil)
        let keyboardHeight: CGFloat = 260

        postKeyboardFrame(CGRect(
            x: screenFrame.minX, y: screenFrame.maxY - keyboardHeight,
            width: screenFrame.width, height: keyboardHeight
        ))
        harness.host.view.layoutIfNeeded()

        #expect(abs(native.keyboardOverlap - keyboardHeight) < 1)
        #expect(abs(collection.adjustedContentInset.bottom - (80 + keyboardHeight)) < 1)
        #expect(abs(collection.contentOffset.y - offset) < 1)
        #expect(abs(try mountedCellFrame(
            id: "chat-user-row-keyboard-send", in: collection
        ).minY - sendY) < 1)

        harness.model.messages[0] = Self.message(
            id: "keyboard-growth", role: "user",
            content: Array(repeating: Self.readerDetail, count: 8).joined(separator: "\n\n")
        )
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-keyboard-send"
        )
        try await waitUntil(timeout: 1) {
            guard let y = try? self.mountedCellFrame(
                id: "chat-user-row-keyboard-send", in: collection
            ).minY else { return false }
            return abs(y - sendY) < 1
        }

        collection.setContentOffset(CGPoint(x: 0, y: maximumOffset(of: collection)), animated: false)
        let last = try mountedCellFrame(id: "chat-user-row-keyboard-send", in: collection)
        #expect(last.maxY <= usableViewportFrame(of: collection).maxY + 1)

        collection.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
        postKeyboardFrame(CGRect(
            x: screenFrame.minX, y: screenFrame.maxY,
            width: screenFrame.width, height: keyboardHeight
        ))
        #expect(native.keyboardOverlap == 0)
        #expect(abs(collection.contentOffset.y - offset) < 1)
    }

    @Test func mountedFloatingControlsKeepDrawableTranscriptAndReadableLandings() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        harness.model.floatingHeader = true
        harness.model.floatingComposer = true
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)
        let overlays = try #require(harness.model.overlays)
        let dock = try #require(harness.model.composerFrame)
        let viewport = collection.convert(collection.bounds, to: nil)
        #expect(viewport.maxY >= dock.maxY - 1, "Composer overlays full drawable collection, not a shortened list")
        #expect(abs(collection.adjustedContentInset.top - overlays.topClearance) <= 1)
        #expect(collection.adjustedContentInset.bottom >= overlays.bottomClearance)
        let oldBounds = collection.bounds.size
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.setContentOffset(CGPoint(x: 0, y: collection.contentOffset.y - 70), animated: false)
        harness.host.view.layoutIfNeeded()
        try await DisplayFrameWaiter.next()
        let band = overlays.bottomBand.offsetBy(dx: viewport.minX, dy: viewport.minY)
        #expect(collection.visibleCells.contains { $0.convert($0.bounds, to: nil).intersects(band) },
                "Real rows, not synthetic tail, must remain drawable beneath the floating dock fade")
        #expect(collection.bounds.size == oldBounds)
        #expect(collection.visibleCells.allSatisfy { $0.alpha == 1 }, "Transcript fades must not fade native row content or actions themselves")
        let document = try #require(collection.visibleCells.flatMap { descendants($0) }.compactMap { $0 as? MessageDocumentView }.first)
        let readable = try #require(document.selectionViewportInWindow?())
        #expect(readable.maxY <= dock.minY - TranscriptOverlayGeometry.spill + 1)
    }

    // Painted test marks belong to a real scrolling row, not the stationary
    // overlay or synthetic tail. Two offsets invert the stripe at every sample;
    // pixel differences therefore measure transmission through the composed UI.
    @Test(arguments: ["normal", "expanded", "large-type", "keyboard"])
    func composedComposerFadeKeepsMovingUnderlayVisible(configuration: String) async throws {
        let harness = try Harness(messages: [Self.message(id: "fade-marked-row", role: "user",
            content: Array(repeating: Self.readerDetail, count: 60).joined(separator: "\n"))],
            dynamicType: configuration == "large-type" ? .accessibility : .normal,
            floatingHeader: true)
        harness.window.frame.size = CGSize(width: 393, height: 852)
        harness.model.floatingComposer = true
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: 2, timeout: 10)
        if configuration == "expanded" {
            let collapsed = try #require(harness.model.composerFrame)
            harness.model.composerDraft = Array(repeating: "Synthetic expanded composer", count: 6).joined(separator: "\n")
            try await waitUntil(timeout: 3) {
                (harness.model.composerFrame?.height ?? 0) > collapsed.height + 20
            }
        }
        if configuration == "keyboard" {
            let editor = try #require(descendants(harness.host.view).compactMap { $0 as? UITextView }.first)
            let native = try #require(collection as? MessageUICollectionView)
            let before = try #require(harness.model.composerFrame)
            // Layout reaches its destination before the keyboard presentation
            // animation does. Pixel witnesses must wait for actual completion.
            var keyboardShown = false
            let observer = NotificationCenter.default.addObserver(forName: UIResponder.keyboardDidShowNotification,
                object: nil, queue: .main) { _ in
                    MainActor.assumeIsolated { keyboardShown = true }
                }
            defer { NotificationCenter.default.removeObserver(observer) }
            #expect(editor.becomeFirstResponder())
            try await waitUntil(timeout: 3) {
                keyboardShown && native.keyboardOverlap > 0
                    && (harness.model.composerFrame?.minY ?? before.minY) < before.minY
            }
        }
        try await settle(collection, hostView: harness.host.view, minimumItems: 2)
        let dock = try #require(harness.model.composerFrame)
        let overlays = try #require(harness.model.overlays)
        let viewport = collection.convert(collection.bounds, to: harness.window)
        let layout = try #require(collection.collectionViewLayout as? ExactMessageLayout)
        let rowIndex = try #require(layout.rowFrames.indices.max(by: {
            layout.rowFrames[$0].height < layout.rowFrames[$1].height
        }))
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.setContentOffset(CGPoint(x: 0, y: layout.rowFrames[rowIndex].minY + 100), animated: false)
        harness.host.view.layoutIfNeeded()
        try await DisplayFrameWaiter.next()
        let cell = try #require(collection.cellForItem(at: IndexPath(item: rowIndex, section: 0)))
        let marks = ComposerFadeRowMarks(frame: CGRect(x: 0, y: 36,
            width: cell.bounds.width, height: viewport.height + 160))
        marks.isUserInteractionEnabled = false
        cell.addSubview(marks)
        defer { marks.removeFromSuperview() }
        #expect(marks.frame.maxY < cell.bounds.height, "Marks stay inside actual row, not blank tail")
        let markedFrame = marks.convert(marks.bounds, to: harness.window)
        #expect(markedFrame.minY < dock.minY - 24 && markedFrame.maxY > dock.maxY)
        #expect(viewport.maxY >= dock.maxY - 1)
        let startOffset = collection.contentOffset.y
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.preferredRange = .standard
        func capture() -> UIImage {
            UIGraphicsImageRenderer(bounds: harness.window.bounds, format: format).image { _ in
                harness.window.drawHierarchy(in: harness.window.bounds, afterScreenUpdates: true)
            }
        }
        var painted: [UIImage] = []
        var references: [UIImage] = []
        for step in 0...1 {
            collection.setContentOffset(CGPoint(x: 0, y: startOffset + CGFloat(step * 16)), animated: false)
            harness.host.view.layoutIfNeeded()
            try await DisplayFrameWaiter.next()
            #expect(abs(collection.contentOffset.y - startOffset - CGFloat(step * 16)) < 1)
            #expect(harness.model.composerFrame == dock, "Only underlay moves")
            #expect(abs(marks.convert(marks.bounds, to: harness.window).minY - markedFrame.minY + CGFloat(step * 16)) < 1)
            painted.append(capture())
            Attachment.record(painted[step], named: "composer-fade-\(configuration)-offset-\(step).png", as: .png)
            harness.model.paintsTranscriptFades = false
            harness.host.view.layoutIfNeeded()
            try await DisplayFrameWaiter.next()
            references.append(capture())
            Attachment.record(references[step], named: "composer-fade-\(configuration)-reference-\(step).png", as: .png)
            harness.model.paintsTranscriptFades = true
            harness.host.view.layoutIfNeeded()
            try await DisplayFrameWaiter.next()
        }
        func difference(_ first: UIImage, _ second: UIImage, x: CGFloat, y: CGFloat) throws -> Int {
            let a = try #require(first.cgImage), b = try #require(second.cgImage)
            let ad = try #require(a.dataProvider?.data), bd = try #require(b.dataProvider?.data)
            let ap = try #require(CFDataGetBytePtr(ad)), bp = try #require(CFDataGetBytePtr(bd))
            let ax = Int(x), ay = Int(y)
            try #require(ax >= 0 && ax < a.width && ay >= 0 && ay < a.height)
            try #require(a.width == b.width && a.height == b.height)
            let ai = ay * a.bytesPerRow + ax * a.bitsPerPixel / 8
            let bi = ay * b.bytesPerRow + ax * b.bitsPerPixel / 8
            return (0..<min(4, a.bitsPerPixel / 8)).reduce(0) { $0 + abs(Int(ap[ai + $1]) - Int(bp[bi + $1])) }
        }
        func transmission(x: CGFloat, y: CGFloat) throws -> Double {
            let reference = try difference(references[0], references[1], x: x, y: y)
            #expect(reference > 20, "Visible marked underlay required even with composer shadows")
            return Double(try difference(painted[0], painted[1], x: x, y: y)) / Double(max(1, reference))
        }
        let x = viewport.minX + 2 // Exposed gutter, not opaque editor face.
        let upper = try transmission(x: x, y: dock.minY - 22)
        let middle = try transmission(x: x, y: dock.minY - 12)
        let lower = try transmission(x: x, y: dock.minY - 2)
        #expect(upper > middle + 0.12 && middle > lower + 0.12,
                "Contrast must progressively fall across exposed fixed ramp")
        let gutter = try transmission(x: x, y: dock.minY + 14)
        #expect(gutter > 0.15 && gutter < 0.6, "Gutter stays faded, never opaque")
        let corner = try transmission(x: viewport.minX + 10, y: dock.minY + 9)
        #expect(corner > 0.1 && corner < 0.65, "Rounded face corner retains moving underlay")
        #expect(try difference(painted[0], painted[1], x: viewport.midX, y: dock.maxY - 24) < 4,
                "Opaque composer face must reject moving row marks")
        let centralY = viewport.minY + overlays.topClearance + 12
        #expect(centralY < dock.minY - 24)
        for step in 0...1 {
            #expect(try difference(painted[step], references[step], x: viewport.midX, y: centralY) < 4,
                    "Readable central content remains unchanged")
        }
        Attachment.record("viewport=\(viewport), dock=\(dock), markedRow=\(markedFrame), inset=\(collection.adjustedContentInset), safeArea=\(harness.window.safeAreaInsets), offsets=\(startOffset),\(startOffset + 16), transmission=\(upper),\(middle),\(lower),\(gutter),\(corner)",
                          named: "composer-fade-\(configuration)-geometry.txt")
    }

    @Test(arguments: [false, true])
    func wideTableAfterSendPreservesContextAndRemainsReachable(afterKeyboardDismissal: Bool) async throws {
        let prompt = "Synthetic table 970a. Reply ONLY a markdown table with 12 columns named Column01 through Column12 and 3 rows. Every cell must contain the unbroken string SyntheticLongCell970a. No prose."
        let history = [
            Self.message(id: "table-prior-user", role: "user", content: "Synthetic C 970a. Reply only OK."),
            Self.message(id: "table-prior-reply", role: "assistant", content: "OK."),
        ]
        let harness = try Harness(messages: history, floatingHeader: true, initialExistingHistory: true)
        harness.window.frame.size = CGSize(width: 393, height: 852)
        harness.model.floatingComposer = true
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: 3)
        if afterKeyboardDismissal {
            let editor = try #require(descendants(harness.host.view).compactMap { $0 as? UITextView }.first)
            let native = try #require(collection as? MessageUICollectionView)
            let dockBefore = try #require(harness.model.composerFrame)
            #expect(editor.becomeFirstResponder())
            try await waitUntil(timeout: 3) {
                native.keyboardOverlap > 0 && (harness.model.composerFrame?.minY ?? dockBefore.minY) < dockBefore.minY
            }
            #expect(editor.resignFirstResponder())
            try await waitUntil(timeout: 3) {
                native.keyboardOverlap == 0 && abs((harness.model.composerFrame?.minY ?? 0) - dockBefore.minY) <= 1
            }
            try await settle(collection, hostView: harness.host.view, minimumItems: 3)
        }
        harness.model.pending = [PendingMessage(id: "table-send", text: prompt, status: .queued, sentAtMs: nil)]
        try await settle(collection, hostView: harness.host.view, minimumItems: 4, rowID: "chat-user-row-table-send")
        let sendY = try mountedCellFrame(id: "chat-user-row-table-send", in: collection).minY
        #expect(abs(sendY - expectedSendMinY(in: collection, priorContent: true)) <= 1)
        harness.model.messages.append(Self.message(id: "table-echo", role: "user", content: prompt, pendingID: "table-send"))
        harness.model.pending = []
        try await settle(collection, hostView: harness.host.view, minimumItems: 4)
        let header = "| " + (1...12).map { String(format: "Column%02d", $0) }.joined(separator: " | ") + " |\n"
        let separator = "| " + Array(repeating: "---", count: 12).joined(separator: " | ") + " |\n"
        let row = "| " + Array(repeating: "SyntheticLongCell970a", count: 12).joined(separator: " | ") + " |\n"
        for count in 1...3 {
            harness.model.messages = history + [
                Self.message(id: "table-echo", role: "user", content: prompt, pendingID: "table-send"),
                Self.message(id: "table-reply", role: "assistant", content: header + separator + String(repeating: row, count: count), streaming: true),
            ]
            try await settle(collection, hostView: harness.host.view, minimumItems: 5, requireRenderedMarkdown: true)
            #expect(abs(try mountedCellFrame(id: "chat-user-row-table-send", in: collection).minY - sendY) <= 1)
        }
        harness.model.messages[3] = Self.message(id: "table-reply", role: "assistant", content: header + separator + String(repeating: row, count: 3))
        try await settle(collection, hostView: harness.host.view, minimumItems: 5, requireRenderedMarkdown: true)
        let document = try #require(collection.visibleCells.flatMap { descendants($0) }.compactMap { $0 as? MessageDocumentView }.first { !$0.subviews.compactMap { $0 as? UIScrollView }.isEmpty })
        let table = try #require(document.subviews.compactMap { $0 as? UIScrollView }.first)
        let dock = try #require(harness.model.composerFrame)
        let tableFrame = table.convert(table.bounds, to: nil)
        Attachment.record(UIGraphicsImageRenderer(bounds: harness.window.bounds).image { _ in
            harness.window.drawHierarchy(in: harness.window.bounds, afterScreenUpdates: true)
        }, named: "table-context-rest.png", as: .png)
        Attachment.record("sendY=\(sendY), expected=\(expectedSendMinY(in: collection, priorContent: true)), table=\(tableFrame), dock=\(dock), viewport=\(collection.convert(collection.bounds, to: nil)), inset=\(collection.adjustedContentInset), offset=\(collection.contentOffset)", named: "table-context-geometry.txt")
        // This response exceeds space BELOW the intentional 20% send placement.
        // Reproduce the E2E witness without assuming this is bottom-follow intent.
        #expect(tableFrame.maxY > dock.minY)
        let contextOffset = collection.contentOffset.y
        for fraction: CGFloat in [0.5, 1, 0] {
            table.setContentOffset(CGPoint(x: (table.contentSize.width - table.bounds.width) * fraction, y: 0), animated: false)
            try await settle(collection, hostView: harness.host.view, minimumItems: 5)
            #expect(abs(collection.contentOffset.y - contextOffset) <= 1)
        }
        // Distinguish retained send ownership from an accidental .reading switch:
        // owned context repositions with measured header geometry; reading would
        // preserve its old screen anchor instead. Native table offsets are not pans.
        harness.model.headerExtraClearance = 20
        try await waitUntil(timeout: 3) { (harness.model.headerFrame?.height ?? 0) >= 80 }
        try await settle(collection, hostView: harness.host.view, minimumItems: 5)
        #expect(abs(try mountedCellFrame(id: "chat-user-row-table-send", in: collection).minY
            - expectedSendMinY(in: collection, priorContent: true)) <= 1)
        harness.model.headerExtraClearance = 0
        try await waitUntil(timeout: 3) { (harness.model.headerFrame?.height ?? 100) < 80 }
        try await settle(collection, hostView: harness.host.view, minimumItems: 5)

        // Readable-bottom intent is explicitly requested by vertical navigation.
        // It must reach every last-row glyph above dock + spill, without shrinking
        // drawable bounds or deleting the send's reserve preemptively.
        let drawable = collection.bounds.size
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.setContentOffset(CGPoint(x: 0, y: minimumOffset(of: collection) + maximumTravel(of: collection)), animated: false)
        collection.delegate?.scrollViewDidEndDragging?(collection, willDecelerate: false)
        try await settle(collection, hostView: harness.host.view, minimumItems: 5)
        #expect(table.convert(table.bounds, to: nil).maxY <= dock.minY - TranscriptOverlayGeometry.spill + 1)
        #expect(collection.bounds.size == drawable)
        Attachment.record(UIGraphicsImageRenderer(bounds: harness.window.bounds).image { _ in
            harness.window.drawHierarchy(in: harness.window.bounds, afterScreenUpdates: true)
        }, named: "table-readable-bottom.png", as: .png)
        let readingOffset = collection.contentOffset.y
        harness.model.messages[3] = Self.message(id: "table-reply", role: "assistant", content: header + separator + String(repeating: row, count: 4), streaming: true)
        try await settle(collection, hostView: harness.host.view, minimumItems: 5, requireRenderedMarkdown: true)
        #expect(abs(collection.contentOffset.y - readingOffset) <= 1, "Later growth must not override explicit reading")
    }

    // Uses system Reduce Motion; run on disposable simulator with each OS setting.
    @Test func pendingCommitKeepsActualMountedRowAnchor() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count, timeout: 10
        )

        let id = "reconcile"
        harness.model.pending = [PendingMessage(id: id, text: "Reconciled send", status: .queued, sentAtMs: nil)]
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-\(id)"
        )
        let before = try mountedCellFrame(id: "chat-user-row-\(id)", in: collection).minY
        let pendingCell = try #require(collection.visibleCells.first { $0.accessibilityIdentifier == "chat-user-row-\(id)" })
        let document = try #require(descendants(pendingCell).compactMap { $0 as? MessageDocumentView }.first)
        let native = try #require(collection as? MessageUICollectionView)
        let entrances = native.entranceAnimationCount
        harness.model.messages.append(Self.message(
            id: "echo", role: "user", content: "Reconciled send", pendingID: id
        ))
        harness.model.pending = []
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-\(id)"
        )

        #expect(abs(try mountedCellFrame(id: "chat-user-row-\(id)", in: collection).minY - before) <= 1)
        let committedCell = try #require(collection.visibleCells.first { $0.accessibilityIdentifier == "chat-user-row-\(id)" })
        #expect(committedCell === pendingCell)
        #expect(descendants(committedCell).compactMap { $0 as? MessageDocumentView }.first === document)
        #expect(native.entranceAnimationCount == entrances)
    }

    @Test func firstReceiptInsertsDateWithoutRemountingSelectedOutgoingDocument() async throws {
        let id = "first-receipt-selection"
        let harness = try Harness(messages: [], pending: [PendingMessage(id: id, text: "Select this send", status: .queued, sentAtMs: nil)])
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: 1, rowID: "chat-user-row-\(id)")
        let pendingCell = try #require(collection.visibleCells.first { $0.accessibilityIdentifier == "chat-user-row-\(id)" })
        let document = try #require(descendants(pendingCell).compactMap { $0 as? MessageDocumentView }.first)
        document.selectAll(nil) // Selection revokes owned-send positioning.
        let selection = document.state.selection
        let before = pendingCell.convert(pendingCell.bounds, to: nil).minY
        harness.model.messages = [Self.message(id: "echo-date", role: "user", content: "Select this send", pendingID: id)]
        harness.model.pending = []
        try await settle(collection, hostView: harness.host.view, minimumItems: 2, rowID: "chat-user-row-\(id)")
        let committedCell = try #require(collection.visibleCells.first { $0.accessibilityIdentifier == "chat-user-row-\(id)" })
        #expect(committedCell === pendingCell)
        #expect(descendants(committedCell).compactMap { $0 as? MessageDocumentView }.first === document)
        #expect(document.state.selection == selection)
        #expect(abs(committedCell.convert(committedCell.bounds, to: nil).minY - before) <= 1)
        document.copy(nil)
        #expect(UIPasteboard.general.string == "Select this send")
    }

    @Test func newRowsAnimateOnceWhileEchoAndStreamingRevisionsKeepIdentity() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)
        let native = try #require(collection as? MessageUICollectionView)
        let baseline = native.entranceAnimationCount

        let pendingID = "entrance"
        harness.model.pending = [PendingMessage(id: pendingID, text: "new send", status: .queued, sentAtMs: nil)]
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-\(pendingID)"
        )
        #expect(native.entranceAnimationCount == baseline + 1)
        let pendingCell = try #require(collection.visibleCells.first {
            $0.accessibilityIdentifier == "chat-user-row-\(pendingID)"
        })
        let pendingPath = try #require(collection.indexPath(for: pendingCell))
        let exactLayout = try #require(collection.collectionViewLayout as? ExactMessageLayout)
        #expect(abs(exactLayout.rowFrames[pendingPath.item].height - pendingCell.bounds.height) < 0.5)

        harness.model.messages.append(Self.message(
            id: "echo", role: "user", content: "new send", pendingID: pendingID
        ))
        harness.model.pending = []
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-\(pendingID)"
        )
        #expect(native.entranceAnimationCount == baseline + 1)

        let presentationID = "presentation:turn:stream-turn"
        harness.model.messages.append(ChatMessage(
            ts: Self.today, role: "assistant", content: "",
            streaming: true, cutoffKind: nil, turnId: "stream-turn",
            replyId: nil, pendingId: nil, entryId: presentationID
        ))
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 2)
        let afterInsert = native.entranceAnimationCount
        #expect(afterInsert == baseline + 2)
        harness.model.messages[harness.model.messages.count - 1] = ChatMessage(
            ts: Self.today, role: "assistant", content: "streaming tokens",
            streaming: true, cutoffKind: nil, turnId: "stream-turn",
            replyId: "stream-reply", pendingId: nil, entryId: presentationID
        )
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 2)
        #expect(native.entranceAnimationCount == afterInsert)
        harness.model.messages[harness.model.messages.count - 1] = ChatMessage(
            ts: Self.today, role: "assistant", content: "streaming tokens",
            streaming: false, cutoffKind: nil, turnId: "stream-turn",
            replyId: "stream-reply", pendingId: nil, entryId: presentationID
        )
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 2)
        #expect(native.entranceAnimationCount == afterInsert)
    }

    @Test func keyboardNotificationSuppliesNativeSendAnimationTiming() throws {
        let collection = MessageUICollectionView(
            frame: .zero,
            collectionViewLayout: UICollectionViewFlowLayout()
        )
        NotificationCenter.default.post(
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil,
            userInfo: [
                UIResponder.keyboardAnimationDurationUserInfoKey: 0.42,
                UIResponder.keyboardAnimationCurveUserInfoKey: 7,
            ]
        )

        #expect(collection.keyboardAnimationTiming.duration == 0.42)
        #expect(collection.keyboardAnimationTiming.options.rawValue == UInt(7 << 16))
    }

    @Test func heightOnlyViewportChangeRefreshesOwnedPlacementAndClamp() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)
        harness.model.pending = [PendingMessage(
            id: "height-only-send", text: "send", status: .queued, sentAtMs: nil
        )]
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-height-only-send"
        )

        harness.window.frame.size.height -= 120
        harness.host.view.frame = harness.window.bounds
        harness.host.view.layoutIfNeeded()
        try await waitUntil(timeout: 1) {
            guard let y = try? self.mountedCellFrame(
                id: "chat-user-row-height-only-send", in: collection
            ).minY else { return false }
            return abs(y - self.expectedSendMinY(in: collection, priorContent: true)) <= 1
        }

        #expect(abs(try mountedCellFrame(
            id: "chat-user-row-height-only-send", in: collection
        ).minY - expectedSendMinY(in: collection, priorContent: true)) <= 1)
        let maximum = maximumOffset(of: collection)
        collection.setContentOffset(CGPoint(x: 0, y: maximum), animated: false)
        #expect(abs(collection.contentOffset.y - maximum) < 1)
    }

    @Test func heightChangeDoesNotCancelActiveSendAnimation() async throws {
        let scheduler = HeldMessagePositionScheduler()
        let harness = try Harness(messages: Self.readerHistory, positionScheduler: scheduler.schedule)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)
        scheduler.runAll()
        let native = try #require(collection as? MessageUICollectionView)
        let completions = native.positioningAnimationCompletionCount

        harness.model.pending = [PendingMessage(
            id: "height-send", text: "send", status: .queued, sentAtMs: nil
        )]
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 1)
        scheduler.runLast()
        harness.window.frame.size.height -= 120
        harness.host.view.frame = harness.window.bounds
        harness.host.view.layoutIfNeeded()

        try await waitUntil(timeout: 1) {
            native.positioningAnimationCompletionCount == completions + 1
        }
        #expect(abs(try mountedCellFrame(
            id: "chat-user-row-height-send", in: collection
        ).minY - expectedSendMinY(in: collection, priorContent: true)) <= 1)
    }

    @Test func streamingPublicationDuringSendAnimationCompletesAndTracksCurrentGeometry() async throws {
        let scheduler = HeldMessagePositionScheduler()
        let harness = try Harness(messages: Self.readerHistory, positionScheduler: scheduler.schedule)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)
        scheduler.runAll()
        let native = try #require(collection as? MessageUICollectionView)
        let completions = native.positioningAnimationCompletionCount

        harness.model.pending = [PendingMessage(
            id: "animated-send", text: "send", status: .queued, sentAtMs: nil
        )]
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1
        )
        scheduler.runLast()

        harness.model.messages.append(ChatMessage(
            ts: Self.today, role: "assistant", content: "stream",
            streaming: true, cutoffKind: nil, turnId: "animated-turn",
            replyId: "animated-reply", pendingId: nil, entryId: ""
        ))
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 2)
        scheduler.runAll()
        try await waitUntil(timeout: 1) {
            native.positioningAnimationCompletionCount == completions + 1
        }

        harness.model.messages[0] = Self.message(
            id: "geometry-before-send", role: "user",
            content: Array(repeating: Self.readerDetail, count: 8).joined(separator: "\n\n")
        )
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 2)
        scheduler.runAll()
        let sendMinY = try mountedCellFrame(id: "chat-user-row-animated-send", in: collection).minY
        #expect(abs(sendMinY - expectedSendMinY(in: collection, priorContent: true)) <= 1)
    }

    @Test func simulatedDelegateDragPreventsFollowDuringShortAndLongResponseGrowth() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count, timeout: 10
        )
        let delegate = try #require(collection.delegate)

        // Unit integration invokes native delegate lifecycle; actual pan gesture remains E2E coverage.
        delegate.scrollViewWillBeginDragging?(collection)
        collection.contentOffset.y = minimumOffset(of: collection) + maximumTravel(of: collection) / 3
        delegate.scrollViewDidScroll?(collection)
        delegate.scrollViewDidEndDragging?(collection, willDecelerate: false)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count)
        let viewportMidY = usableViewportFrame(of: collection).midY
        let anchor = try #require(collection.visibleCells.min {
            abs($0.convert($0.bounds, to: collection.superview).midY - viewportMidY)
                < abs($1.convert($1.bounds, to: collection.superview).midY - viewportMidY)
        })
        let anchorPath = try #require(collection.indexPath(for: anchor))
        let before = try mountedCellFrame(at: anchorPath, in: collection).minY
        harness.model.messages.append(Self.message(id: "response", role: "assistant", content: "Short response."))
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1
        )
        #expect(abs(try mountedCellFrame(at: anchorPath, in: collection).minY - before) <= 1)
        harness.model.messages[harness.model.messages.count - 1] = Self.message(
            id: "response", role: "assistant",
            content: Array(repeating: Self.readerDetail, count: 40).joined(separator: "\n\n")
        )
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1
        )
        #expect(abs(try mountedCellFrame(at: anchorPath, in: collection).minY - before) <= 1)
    }

    @Test func anchoredRowSurvivesViewportWidthAndHeightChanges() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count, timeout: 10
        )
        let id = "resize"
        harness.model.pending = [PendingMessage(id: id, text: Self.readerDetail, status: .queued, sentAtMs: nil)]
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-\(id)"
        )
        harness.window.frame.size = CGSize(width: 320, height: 560)
        harness.host.view.frame = harness.window.bounds
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-\(id)"
        )
        let narrow = try mountedCellFrame(id: "chat-user-row-\(id)", in: collection)
        #expect(abs(narrow.minY - expectedSendMinY(in: collection, priorContent: true)) <= 1)
        harness.window.frame.size = CGSize(width: 520, height: 430)
        harness.host.view.frame = harness.window.bounds
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-\(id)"
        )
        try await waitUntil(timeout: 1) {
            guard let y = try? self.mountedCellFrame(
                id: "chat-user-row-\(id)", in: collection
            ).minY else { return false }
            return abs(y - self.expectedSendMinY(in: collection, priorContent: true)) <= 1
        }
        let wide = try mountedCellFrame(id: "chat-user-row-\(id)", in: collection)
        #expect(abs(wide.minY - expectedSendMinY(in: collection, priorContent: true)) <= 1)
        #expect(abs(wide.height - narrow.height) > 1)
    }

    @Test(arguments: [false, true])
    func explicitExistingIntentBottomsColdHistoryWithoutLoadingEdge(
        historicalPendingIDs: Bool
    ) async throws {
        let harness = try Harness(messages: [], initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        var history = Self.readerHistory
        if historicalPendingIDs {
            history[0] = Self.message(
                id: "historical-correlated", role: "user",
                content: "Historical correlated user row", pendingID: "historical-pending-id"
            )
        }
        harness.model.messages = history
        try await settle(collection, hostView: harness.host.view, minimumItems: history.count, timeout: 10)
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1)
    }

    @Test(arguments: [false, true])
    func explicitNewChatFirstSendKeepsLeadingDateReadableIncludingQuickEcho(quickEcho: Bool) async throws {
        let harness = try Harness(messages: [], floatingHeader: true, initialExistingHistory: false)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        let id = "explicit-new-send"
        let text = Array(repeating: Self.readerDetail, count: 20).joined(separator: "\n")
        let echo = Self.message(id: "quick-echo", role: "user", content: text, pendingID: id)
        if !quickEcho {
            harness.model.pending = [PendingMessage(id: id, text: text, status: .queued, sentAtMs: nil)]
            try await settle(collection, hostView: harness.host.view, minimumItems: 1,
                             rowID: "chat-user-row-\(id)", timeout: 10)
            #expect(abs(try mountedCellFrame(id: "chat-user-row-\(id)", in: collection).minY
                - usableViewportFrame(of: collection).minY) <= 1, "Pending has no leading date yet")
        }
        harness.model.messages = [echo]
        harness.model.pending = []
        try await settle(collection, hostView: harness.host.view, minimumItems: 2,
                         rowID: "chat-user-row-\(id)", timeout: 10)
        let header = try #require(harness.model.headerFrame)
        let date = try #require(collection.cellForItem(at: IndexPath(item: 0, section: 0)))
        let dateFrame = date.convert(date.bounds, to: harness.window)
        let message = try mountedCellFrame(id: "chat-user-row-\(id)", in: collection)
        let dateInViewport = try mountedCellFrame(at: IndexPath(item: 0, section: 0), in: collection)
        #expect(dateFrame.minY >= header.maxY - 1, "Initial date, not only bubble, must clear controls")
        #expect(abs(dateInViewport.minY - usableViewportFrame(of: collection).minY) <= 1)
        #expect(message.minY >= dateInViewport.maxY)
        #expect(message.height > usableViewportFrame(of: collection).height, "Tall send still lands at its readable start")

        if !quickEcho {
            harness.model.reservedNotice = true
            try await settle(collection, hostView: harness.host.view, minimumItems: 2,
                             rowID: "chat-user-row-\(id)")
            #expect(harness.model.topOcclusion == 0)
            #expect(abs(try mountedCellFrame(at: IndexPath(item: 0, section: 0), in: collection).minY
                - usableViewportFrame(of: collection).minY) <= 1,
                "Reserved notices remove overlap, not the send's readable date")
            harness.model.reservedNotice = false
            try await settle(collection, hostView: harness.host.view, minimumItems: 2,
                             rowID: "chat-user-row-\(id)")
        }

        // Only owned landing reserves the lead-in; manual reading may draw under controls.
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.contentOffset.y += date.bounds.height / 2
        try await settle(collection, hostView: harness.host.view, minimumItems: 2)
        #expect(date.convert(date.bounds, to: harness.window).minY < header.maxY)
    }

    @Test func floatingHeaderNextDaySendPreservesDateWhenContextIsSmallerThanLeadIn() async throws {
        let harness = try Harness(messages: Self.readerHistory, floatingHeader: true, initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: 25, timeout: 10)
        harness.window.frame.size.height = 320
        harness.host.view.frame = harness.window.bounds
        try await settle(collection, hostView: harness.host.view, minimumItems: 25)
        let context = usableViewportFrame(of: collection).height * 0.20
        harness.model.messages.append(Self.message(
            id: "next-day", role: "user", content: "Next day send", pendingID: "next-day",
            timestamp: Self.today + 86_400_000
        ))
        try await settle(collection, hostView: harness.host.view, minimumItems: 27,
                         rowID: "chat-user-row-next-day", timeout: 10)
        let date = try mountedCellFrame(at: IndexPath(item: 25, section: 0), in: collection)
        let message = try mountedCellFrame(id: "chat-user-row-next-day", in: collection)
        #expect(message.minY - date.minY > context, "Fixture exercises measured lead-in exceeding contextual placement")
        #expect(abs(date.minY - usableViewportFrame(of: collection).minY) <= 1)
        let screen = collection.convert(collection.bounds, to: nil)
        postKeyboardFrame(CGRect(x: screen.minX, y: screen.maxY - 60, width: screen.width, height: 60))
        try await settle(collection, hostView: harness.host.view, minimumItems: 27,
                         rowID: "chat-user-row-next-day")
        #expect(abs(try mountedCellFrame(id: "chat-user-row-next-day", in: collection).minY - message.minY) <= 1)
        postKeyboardFrame(CGRect(x: screen.minX, y: screen.maxY, width: screen.width, height: 60))
    }

    @Test func newerPublicationInheritsInitialBottomIntentUntilDeferredApply() async throws {
        let scheduler = HeldMessagePositionScheduler()
        let harness = try Harness(
            messages: [],
            initialExistingHistory: true,
            positionScheduler: scheduler.schedule
        )
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        scheduler.discardAll()

        harness.model.messages = Self.readerHistory
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count, timeout: 10
        )
        let firstCount = scheduler.count
        #expect(firstCount > 0)

        harness.model.messages[harness.model.messages.count - 1] = Self.message(
            id: "second-publication", role: "assistant",
            content: Array(repeating: Self.readerDetail, count: 8).joined(separator: "\n\n")
        )
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count, timeout: 10
        )
        #expect(scheduler.count > firstCount)

        scheduler.runFirst()
        collection.layoutIfNeeded()
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) > 1)
        scheduler.runLast()
        collection.layoutIfNeeded()
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1)
    }

    @Test func explicitReadingIntentSurvivesNonDragPublication() async throws {
        let scheduler = HeldMessagePositionScheduler()
        let harness = try Harness(
            messages: Self.readerHistory,
            initialExistingHistory: true,
            positionScheduler: scheduler.schedule
        )
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count, timeout: 10
        )
        try await waitUntil(timeout: 5) { scheduler.count > 0 }
        scheduler.runAll()
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count)
        scheduler.discardAll()

        let native = try #require(collection as? MessageUICollectionView)
        // Focus navigation uses UIKit's rect reveal without beginning a drag.
        // VoiceOver page scrolling itself requires a live accessibility context.
        native.scrollRectToVisible(
            CGRect(x: 0, y: minimumOffset(of: collection), width: collection.bounds.width, height: 100),
            animated: false
        )
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count)
        let beforeOffset = collection.contentOffset.y
        #expect(abs(beforeOffset - maximumOffset(of: collection)) > 1)
        let anchorPath = try #require(collection.indexPathsForVisibleItems.sorted().first)
        let beforeAnchor = try mountedCellFrame(at: anchorPath, in: collection).minY

        harness.model.messages[harness.model.messages.count - 1] = Self.message(
            id: "history-\(Self.readerHistory.count - 1)", role: "assistant",
            content: Array(repeating: Self.readerDetail, count: 20).joined(separator: "\n\n")
        )
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count)
        try await waitUntil(timeout: 5) { scheduler.count > 0 }
        scheduler.runAll()
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count)

        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) > 1)
        #expect(abs(try mountedCellFrame(at: anchorPath, in: collection).minY - beforeAnchor) <= 1)
    }

    @Test func lateRenderedHistoryCorrectionRetainsBottomIntent() async throws {
        let loader = DelayedImageLoader()
        let imageURL = URL(string: "https://fixture.invalid/late-bottom.png")!
        var messages = Self.readerHistory
        messages[messages.count - 1] = Self.message(
            id: "late-bottom", role: "assistant",
            content: "History before image\n\n![fixture](\(imageURL.absoluteString))\n\nHistory after image"
        )
        let scheduler = HeldMessagePositionScheduler()
        let harness = try Harness(
            messages: messages,
            initialExistingHistory: true,
            imageLoader: loader,
            positionScheduler: scheduler.schedule
        )
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        try await waitUntil(timeout: 5) { scheduler.count > 0 }
        scheduler.runAll()
        try await waitUntil(timeout: 5) {
            abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1
        }
        try await waitUntilAsync(timeout: 5) { await loader.requestCount(for: imageURL) >= 1 }
        let provisionalExtent = collection.contentSize.height

        await loader.resolve(url: imageURL, image: testImage(width: 240, height: 180))
        try await waitUntilAsync(timeout: 5) { await loader.requestCount(for: imageURL) > 0 }
        try await DisplayFrameWaiter.next()
        try await waitUntil(timeout: 5) { scheduler.count > 0 }
        scheduler.runAll()
        try await waitUntil(timeout: 5) {
            abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1
        }

        #expect(abs(collection.contentSize.height - provisionalExtent) <= 1)
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1)
    }

    @Test(arguments: [false, true])
    func emptyBounceDoesNotCancelColdExistingIntent(whileLoading: Bool) async throws {
        let harness = try Harness(messages: [], initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        if whileLoading {
            harness.model.historyLoading = true
            try await DisplayFrameWaiter.next()
        }
        let delegate = try #require(collection.delegate)
        delegate.scrollViewWillBeginDragging?(collection)
        harness.model.messages = Self.readerHistory
        harness.model.historyLoading = false
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count, timeout: 10
        )
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1)
    }

    @Test func dragCancelsHeldInitialBottomAndPreventsRearm() async throws {
        let scheduler = HeldMessagePositionScheduler()
        let harness = try Harness(
            messages: [],
            initialExistingHistory: true,
            positionScheduler: scheduler.schedule
        )
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        scheduler.discardAll()
        harness.model.messages = Self.readerHistory
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count, timeout: 10
        )
        #expect(scheduler.count > 0)
        let offset = collection.contentOffset.y
        let delegate = try #require(collection.delegate)
        delegate.scrollViewWillBeginDragging?(collection)
        scheduler.runAll()
        #expect(abs(collection.contentOffset.y - offset) < 0.5)

        harness.model.messages[harness.model.messages.count - 1] = Self.message(
            id: "post-drag-revision", role: "assistant", content: "same history intent, newer revision"
        )
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count
        )
        scheduler.runAll()
        #expect(abs(collection.contentOffset.y - offset) < 0.5)
    }

    @Test func dragCancelsHeldSendPositionButLaterSendCanAcquireOwnership() async throws {
        let scheduler = HeldMessagePositionScheduler()
        let harness = try Harness(
            messages: Self.readerHistory,
            positionScheduler: scheduler.schedule
        )
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count, timeout: 10
        )
        scheduler.runAll()
        collection.setContentOffset(CGPoint(x: 0, y: minimumOffset(of: collection)), animated: false)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count)

        harness.model.pending = [PendingMessage(
            id: "held-send-1", text: Self.readerDetail, status: .queued, sentAtMs: nil
        )]
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1
        )
        #expect(scheduler.count > 0)
        let offset = collection.contentOffset.y
        let delegate = try #require(collection.delegate)
        delegate.scrollViewWillBeginDragging?(collection)
        scheduler.runAll()
        #expect(abs(collection.contentOffset.y - offset) < 0.5)

        harness.model.pending = harness.model.pending
        try await DisplayFrameWaiter.next()
        #expect(scheduler.count == 0)

        harness.model.pending.append(PendingMessage(
            id: "held-send-2", text: Self.readerDetail, status: .queued, sentAtMs: nil
        ))
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 2
        )
        #expect(scheduler.count > 0)
        scheduler.runAll()
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 2,
            rowID: "chat-user-row-held-send-2"
        )
        #expect(abs(
            try mountedCellFrame(id: "chat-user-row-held-send-2", in: collection).minY
                - expectedSendMinY(in: collection, priorContent: true)
        ) <= 1)
    }

    @Test func initialExistingHistoryTargetsBottomSeparatelyFromLiveSendAnchoring() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        defer { harness.close() }
        let measurementRevision = harness.model.measurementRevision
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count, timeout: 10,
            measurement: (harness.model, measurementRevision)
        )

        #expect(collection.contentSize.height > collection.bounds.height)
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1)
    }

    @Test func committedEchoAfterInitialHistoryPositionAcquiresSendAnchor() async throws {
        let harness = try Harness(messages: Self.readerHistory, initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count, timeout: 10
        )
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1)

        let pendingID = "quick-history-echo"
        harness.model.messages.append(Self.message(
            id: "quick-history-echo-message", role: "user",
            content: Self.readerDetail, pendingID: pendingID
        ))
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1,
            rowID: "chat-user-row-\(pendingID)"
        )

        #expect(abs(
            try mountedCellFrame(id: "chat-user-row-\(pendingID)", in: collection).minY
                - expectedSendMinY(in: collection, priorContent: true)
        ) <= 1)
    }

    @Test func resumedHistoryKeepsPreparedRichRowsFlushAfterScrollingBack() async throws {
        let longReply = Array(repeating: """
            ## Synthetic section

            This long committed reply keeps final history row taller than viewport while
            exercising headings, wrapping, and repeated rich-text blocks.
            """, count: 20).joined(separator: "\n\n")
        let messages = (0..<8).map { index in
            let role = index.isMultiple(of: 2) ? "user" : "assistant"
            let content = index == 7
                ? longReply
                : """
                ## Prepared row \(index)

                Synthetic alternating history content with **rich** text and wrapping.
                """
            return Self.message(id: "prepared-\(index)", role: role, content: content)
        }
        let harness = try Harness(messages: messages, initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: messages.count, timeout: 15,
            requireRenderedMarkdown: true
        )
        collection.setContentOffset(CGPoint(x: 0, y: maximumOffset(of: collection)), animated: false)
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: messages.count, timeout: 15,
            requireRenderedMarkdown: true
        )
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1)

        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.setContentOffset(CGPoint(x: 0, y: minimumOffset(of: collection)), animated: false)
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: messages.count, timeout: 15,
            requireRenderedMarkdown: true
        )

        let paintedRows = collection.indexPathsForVisibleItems.sorted().compactMap { indexPath -> (
            cell: MessageHostingCell, paintedBottom: CGFloat, allocatedBottom: CGFloat
        )? in
            guard let cell = collection.cellForItem(at: indexPath) as? MessageHostingCell,
                  let markdown = descendants(cell).compactMap({ $0 as? MessageDocumentView }).first,
                  markdown.measuredHeight > 0 else { return nil }
            let frame = cell.convert(cell.bounds, to: collection)
            return (
                cell,
                markdown.convert(markdown.bounds, to: collection).maxY + Space.md,
                frame.maxY
            )
        }
        #expect(paintedRows.count >= 2)
        for row in paintedRows {
            #expect(abs(row.paintedBottom - row.allocatedBottom) <= 1)
        }
        for (previous, next) in zip(paintedRows, paintedRows.dropFirst()) {
            let gap = next.cell.convert(next.cell.bounds, to: collection).minY - previous.paintedBottom
            #expect(abs(gap - BubbleLayout.rowGap(width: collection.bounds.width)) <= 1)
        }
    }

    @Test func largeHistoryMountsBoundedNativeCellCount() async throws {
        let baselineBytes = try physicalFootprint()
        let started = CACurrentMediaTime()
        let messages = (0..<1_000).map { index in
            Self.message(id: "large-\(index)", role: index.isMultiple(of: 2) ? "user" : "assistant")
        }
        let harness = try Harness(messages: messages)
        defer { harness.close() }
        let measurementRevision = harness.model.measurementRevision
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: messages.count, timeout: 10,
            measurement: (harness.model, measurementRevision)
        )

        let mountedCells = descendants(collection).compactMap { $0 as? UICollectionViewCell }
        #expect(collection.numberOfItems(inSection: 0) >= messages.count)
        #expect(mountedCells.count < 100)
        let initialBytes = try physicalFootprint()
        let mountSeconds = CACurrentMediaTime() - started
        var frameIntervals: [Double] = []
        var footprints: [UInt64] = []
        for pass in 0..<2 {
            collection.delegate?.scrollViewWillBeginDragging?(collection)
            for step in 0..<20 {
                let start = CACurrentMediaTime()
                let fraction = CGFloat(step) / 19
                collection.setContentOffset(CGPoint(x: 0, y: minimumOffset(of: collection) + maximumTravel(of: collection) * fraction), animated: false)
                try await DisplayFrameWaiter.next()
                frameIntervals.append(CACurrentMediaTime() - start)
                #expect(descendants(collection).compactMap { $0 as? UICollectionViewCell }.count < 100)
            }
            try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
            footprints.append(try physicalFootprint())
            Attachment.record("pass=\(pass),footprintBytes=\(footprints.last!)", named: "history-memory-\(pass).txt")
        }
        // A second identical traversal must not retain another transcript's UI.
        // Leave room for system raster/cache warmup; cells remain the strict bound.
        #expect(footprints[1] <= footprints[0] + 32 * 1024 * 1024)
        frameIntervals.sort()
        Attachment.record("rows=1000,baselineBytes=\(baselineBytes),mountedBytes=\(initialBytes),mountSeconds=\(mountSeconds),medianFrameSeconds=\(frameIntervals[frameIntervals.count / 2]),maxFrameSeconds=\(frameIntervals.last!)", named: "history-performance.txt")
    }

    private func physicalFootprint() throws -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout.size(ofValue: info) / MemoryLayout<integer_t>.size)
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        #expect(status == KERN_SUCCESS)
        return info.phys_footprint
    }

    @Test func reservedMarkdownImageExtentSurvivesArrivalAndRecycle() async throws {
        let loader = DelayedImageLoader()
        let imageURL = URL(string: "https://fixture.invalid/resolved.png")!
        var messages = Self.readerHistory
        messages[10] = Self.message(
            id: "image", role: "assistant",
            content: "Before image\n\n![fixture](\(imageURL.absoluteString))\n\nAfter image"
        )
        let harness = try Harness(messages: Self.readerHistory, imageLoader: loader)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count, timeout: 10)
        // Establish rendered history before isolating the delayed image change;
        // reserved native geometry is the baseline before image arrival.
        _ = try await traverse(collection, hostView: harness.host.view)
        harness.model.messages = messages
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        collection.setContentOffset(CGPoint(x: 0, y: maximumOffset(of: collection) / 2), animated: false)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        let anchor = try #require(collection.indexPathsForVisibleItems.sorted().first)
        let beforeFrame = try mountedCellFrame(at: anchor, in: collection).minY
        let provisionalExtent = collection.contentSize.height

        await loader.resolve(url: imageURL, image: testImage(width: 240, height: 180))
        try await waitUntilAsync(timeout: 5) { await loader.requestCount(for: imageURL) > 0 }
        try await DisplayFrameWaiter.next()
        try await settle(
            collection, hostView: harness.host.view, minimumItems: messages.count,
            requireRenderedMarkdown: true
        )
        let resolvedExtent = collection.contentSize.height
        #expect(abs(resolvedExtent - provisionalExtent) <= 1)
        #expect(abs(try mountedCellFrame(at: anchor, in: collection).minY - beforeFrame) <= 1)

        let samples = try await traverse(collection, hostView: harness.host.view)
        #expect(samples.allSatisfy { abs($0 - resolvedExtent) < 1 })
    }

    @Test func offscreenImageCompletionCannotChangeReservedExtentOrHistoryBottom() async throws {
        let loader = DelayedImageLoader()
        let imageURL = URL(string: "https://fixture.invalid/offscreen.png")!
        var messages = Self.readerHistory
        let targetIndex = 3
        messages[targetIndex] = Self.message(
            id: "offscreen-rendered", role: "assistant",
            content: "Before image\n\n![fixture](\(imageURL.absoluteString))\n\nAfter image"
        )
        let harness = try Harness(
            messages: messages, initialExistingHistory: true, imageLoader: loader
        )
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count, timeout: 10)

        // Reader history contributes one day-divider row before message rows.
        let targetPath = IndexPath(item: targetIndex + 1, section: 0)
        let layout = try #require(collection.collectionViewLayout as? ExactMessageLayout)
        let targetOffset = layout.rowFrames[targetPath.item].midY - collection.bounds.height / 2
        collection.setContentOffset(CGPoint(x: 0, y: targetOffset), animated: false)
        try await waitUntil(timeout: 5) {
            collection.indexPathsForVisibleItems.contains(targetPath)
        }
        try await waitUntilAsync(timeout: 5) { await loader.requestCount(for: imageURL) >= 1 }
        let targetCell = try #require(
            collection.cellForItem(at: targetPath) as? MessageHostingCell
        )
        let targetConfigurationToken = targetCell.configurationToken
        let targetMeasurementKey = try #require(targetCell.measurementKey)
        let provisionalExtent = collection.contentSize.height
        let provisionalRowHeight = layout.rowHeights[targetPath.item]

        collection.setContentOffset(CGPoint(x: 0, y: maximumOffset(of: collection)), animated: false)
        try await waitUntil(timeout: 5) {
            !collection.indexPathsForVisibleItems.contains(targetPath)
        }
        #expect(targetCell.configurationToken == 0 || targetCell.configurationToken == targetConfigurationToken)
        #expect(targetCell.measurementKey == nil || targetCell.measurementKey == targetMeasurementKey)
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1)

        await loader.resolve(url: imageURL, image: testImage(width: 240, height: 180))
        try await DisplayFrameWaiter.next()
        #expect(!collection.indexPathsForVisibleItems.contains(targetPath))
        #expect(abs(collection.contentSize.height - provisionalExtent) <= 1)
        #expect(abs(layout.rowHeights[targetPath.item] - provisionalRowHeight) <= 1)
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1)
    }

    @Test func staleMarkdownImageCompletionCannotResizeReplacementRevision() async throws {
        let loader = DelayedImageLoader()
        let imageURL = URL(string: "https://fixture.invalid/stale.png")!
        let old = Self.message(id: "replace", role: "assistant", content: "![old](\(imageURL.absoluteString))")
        let harness = try Harness(messages: [old], imageLoader: loader)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: 1, timeout: 10)

        harness.model.messages = [Self.message(id: "replace", role: "assistant", content: "Replacement text")]
        try await settle(
            collection, hostView: harness.host.view, minimumItems: 1,
            requireRenderedMarkdown: true
        )
        try await waitUntilAsync(timeout: 3) { await loader.cancellationCount(for: imageURL) == 1 }
        let replacementExtent = collection.contentSize.height
        await loader.resolve(url: imageURL, image: testImage(width: 240, height: 240))
        try await DisplayFrameWaiter.next()
        try await settle(collection, hostView: harness.host.view, minimumItems: 1)
        #expect(abs(collection.contentSize.height - replacementExtent) < 1)
    }

    @Test func markdownImageCacheBoundsDecodedImagesAndKeepsEvictedDimensions() async throws {
        let loader = DelayedImageLoader()
        let cache = MarkdownImageCache(loader: loader, decodedCountLimit: 1, decodedCostLimit: .max)
        let firstURL = URL(string: "https://fixture.invalid/first.png")!
        let secondURL = URL(string: "https://fixture.invalid/second.png")!
        await loader.resolve(url: firstURL, image: testImage(width: 120, height: 80))
        #expect(await cache.imageData(for: firstURL) != nil)
        await loader.resolve(url: secondURL, image: testImage(width: 90, height: 60))
        #expect(await cache.imageData(for: secondURL) != nil)

        #expect([firstURL, secondURL].compactMap(cache.image(for:)).count <= 1)
        #expect(cache.knownMetadata(for: firstURL) == .size(CGSize(width: 120, height: 80)))
        #expect(cache.knownMetadata(for: secondURL) == .size(CGSize(width: 90, height: 60)))
        let evicted = try #require([firstURL, secondURL].first { cache.image(for: $0) == nil })
        let metadata = cache.knownMetadata(for: evicted)
        #expect(await cache.imageData(for: evicted) != nil)
        #expect(cache.knownMetadata(for: evicted) == metadata)
        #expect([firstURL, secondURL].compactMap(cache.image(for:)).count <= 1)
    }

    @Test func markdownImageCacheCancelsOnlyAfterLastSharedConsumerReleases() async throws {
        // Exercise scheduler interleavings: both consumers must enter before
        // cancellation, rather than merely allocating two Task handles.
        for _ in 0..<10 {
            let loader = DelayedImageLoader()
            let cache = MarkdownImageCache(loader: loader)
            let url = URL(string: "https://fixture.invalid/shared.png")!
            var started = 0
            let first = Task { @MainActor in started += 1; return await cache.imageData(for: url) }
            let second = Task { @MainActor in started += 1; return await cache.imageData(for: url) }
            defer { first.cancel(); second.cancel() }
            try await waitUntilAsync(timeout: 3) {
                guard started == 2 else { return false }
                return await loader.requestCount(for: url) > 0
            }
            let requests = await loader.requestCount(for: url)
            #expect(requests == 1)
            first.cancel()
            try await DisplayFrameWaiter.next()
            #expect(await loader.cancellationCount(for: url) == 0)
            second.cancel()
            try await waitUntilAsync(timeout: 3) { await loader.cancellationCount(for: url) > 0 }
            #expect(await loader.cancellationCount(for: url) == 1)
            #expect(await first.value == nil)
            #expect(await second.value == nil)
        }
    }

    @Test func sendDuringHistoryReloadOverridesPendingBottomIntent() async throws {
        let harness = try Harness(messages: Self.readerHistory, initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)

        let id = "send-during-reload"
        harness.model.historyLoading = true
        try await DisplayFrameWaiter.next()
        harness.model.messages = Self.gfmHistory
        harness.model.pending = [PendingMessage(
            id: id, text: Self.readerDetail, status: .queued, sentAtMs: nil
        )]
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.gfmHistory.count + 1, timeout: 10
        )
        harness.model.historyLoading = false
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.gfmHistory.count + 1,
            rowID: "chat-user-row-\(id)", timeout: 10
        )
        #expect(abs(
            try mountedCellFrame(id: "chat-user-row-\(id)", in: collection).minY
                - expectedSendMinY(in: collection, priorContent: true)
        ) <= 1)
    }

    @Test func mountedHistoryReloadWaitsForFallingEdgeBeforePositioningReplacement() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)
        let native = try #require(collection as? MessageUICollectionView)
        let completions = native.positioningAnimationCompletionCount
        harness.model.pending = [PendingMessage(id: "owned", text: "send", status: .queued, sentAtMs: nil)]
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 1)
        // Keep send ownership, but finish its animation before establishing the
        // fixture's pre-reload offset. Geometry settling alone is not that signal.
        try await waitUntil(timeout: 3) { native.positioningAnimationCompletionCount > completions }
        collection.setContentOffset(CGPoint(x: 0, y: minimumOffset(of: collection)), animated: false)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 1)

        #expect(abs(collection.contentOffset.y - minimumOffset(of: collection)) <= 1)
        harness.model.historyLoading = true
        try await DisplayFrameWaiter.next()
        harness.model.messages[harness.model.messages.count - 1] = Self.message(
            id: "changed-old", role: "assistant", content: "changed old rows"
        )
        harness.model.pending = []
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count)
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) > 1)

        harness.model.messages = Self.gfmHistory
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.gfmHistory.count, timeout: 10)
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) > 1)

        harness.model.historyLoading = false
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.gfmHistory.count, timeout: 10)
        #expect(abs(collection.contentOffset.y - maximumOffset(of: collection)) <= 1)
        #expect(!harness.model.measurementLoading)
        #expect(collection.visibleCells.allSatisfy { $0.accessibilityIdentifier != "chat-user-row-owned" })
    }

    @Test func warmHistoryAppendDoesNotReenterFullMeasurementLoading() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)
        let transitionCount = harness.model.measurementTransitions.count
        let measuredCount = try #require(collection as? MessageUICollectionView).measuredRowCount

        harness.model.messages.append(Self.message(id: "warm-append", role: "assistant", content: "new row"))
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 1)
        #expect(!harness.model.measurementTransitions.dropFirst(transitionCount).contains(true))
        #expect(try #require(collection as? MessageUICollectionView).measuredRowCount == measuredCount + 1)
    }

    @Test func nativeVisibilityDemandChangesOnlyOnScrollAndRevisit() async throws {
        var messages = (0..<120).map { index in
            Self.message(id: "visibility-\(index)", role: index.isMultiple(of: 2) ? "user" : "assistant")
        }
        messages[0] = Self.attachmentMessage(id: "top-row", attachmentId: "top-preview")
        messages[119] = Self.attachmentMessage(id: "bottom-row", attachmentId: "bottom-preview")
        let harness = try Harness(messages: messages, initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count, timeout: 15)
        try await waitUntil(timeout: 3) {
            harness.model.visibleAttachmentSets.last?.contains("bottom-preview") == true
        }
        #expect(harness.model.visibleAttachmentSets.last?.contains("top-preview") == false)

        let count = harness.model.visibleAttachmentSets.count
        messages[118] = Self.message(
            id: "visibility-118", role: "assistant", content: "Repeated token publication", streaming: true
        )
        harness.model.messages = messages
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        #expect(harness.model.visibleAttachmentSets.count == count)

        collection.setContentOffset(CGPoint(x: 0, y: minimumOffset(of: collection)), animated: false)
        collection.delegate?.scrollViewDidScroll?(collection)
        try await waitUntil(timeout: 3) {
            harness.model.visibleAttachmentSets.last?.contains("top-preview") == true
        }
        #expect(harness.model.visibleAttachmentSets.last?.contains("bottom-preview") == false)

        collection.setContentOffset(CGPoint(x: 0, y: maximumOffset(of: collection)), animated: false)
        collection.delegate?.scrollViewDidScroll?(collection)
        try await waitUntil(timeout: 3) {
            harness.model.visibleAttachmentSets.last?.contains("bottom-preview") == true
        }
    }

    @Test func offscreenAttachmentPreviewMeasuresOnlyOwnerAndKeepsHistoryWarmDuringStreaming() async throws {
        var messages = (0..<150).map { index in
            Self.message(
                id: "attachment-history-\(index)",
                role: index.isMultiple(of: 2) ? "user" : "assistant"
            )
        }
        messages[0] = Self.attachmentMessage(id: "offscreen-attachment")
        messages.append(Self.message(id: "attachment-live", role: "assistant", content: "One.", streaming: true))
        let harness = try Harness(messages: messages, initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count, timeout: 15)
        let native = try #require(collection as? MessageUICollectionView)
        let measured = native.measuredRowCount
        let visibleCells = collection.visibleCells.compactMap { $0 as? MessageHostingCell }
        let configurations = visibleCells.map(\.configurationCount)

        harness.model.attachmentPreviews[Self.attachment.attachmentId] = UIImage(data: Self.attachmentPreview)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count, timeout: 10)
        #expect(native.measuredRowCount == measured + 1)
        #expect(visibleCells.map(\.configurationCount) == configurations)

        messages[messages.count - 1] = Self.message(
            id: "attachment-live", role: "assistant", content: "One. Two.", streaming: true
        )
        harness.model.messages = messages
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        #expect(native.measuredRowCount == measured + 1)
        #expect(zip(visibleCells, configurations).filter { $0.0.configurationCount > $0.1 }.count == 1)
    }

    @Test func mountedOffscreenMeasurerReleasesPreviewAfterScopeClear() async throws {
        var messages = (0..<120).map { index in
            Self.message(
                id: "measurer-release-\(index)",
                role: index.isMultiple(of: 2) ? "user" : "assistant"
            )
        }
        messages[0] = Self.attachmentMessage(id: "measurer-release-owner")
        let harness = try Harness(messages: messages, initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count, timeout: 15)
        let native = try #require(collection as? MessageUICollectionView)
        let measured = native.measuredRowCount
        var image: UIImage? = UIImage(data: Self.attachmentPreview)
        weak var releasedImage = image

        harness.model.attachmentPreviews[Self.attachment.attachmentId] = image
        try await waitUntil(timeout: 5) { native.measuredRowCount > measured }
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        image = nil
        #expect(releasedImage != nil)

        harness.model.attachmentPreviews = [:]
        harness.model.messages = []
        try await waitUntil(timeout: 5) {
            collection.numberOfItems(inSection: 0) == 0 && releasedImage == nil
        }
    }

    @Test func visibleAttachmentAvailabilityReconfiguresOnlyOwnerWithoutHistoryMeasurement() async throws {
        let messages = Self.readerHistory + [Self.attachmentMessage(id: "visible-attachment")]
        let harness = try Harness(messages: messages, initialExistingHistory: true)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(
            collection, hostView: harness.host.view, minimumItems: messages.count,
            rowID: "chat-user-row-visible-attachment", timeout: 10
        )
        let native = try #require(collection as? MessageUICollectionView)
        let measured = native.measuredRowCount
        let owner = try #require(collection.visibleCells.first {
            $0.accessibilityIdentifier == "chat-user-row-visible-attachment"
        } as? MessageHostingCell)
        let neighbors = collection.visibleCells.compactMap { $0 as? MessageHostingCell }.filter { $0 !== owner }
        let neighborConfigurations = neighbors.map(\.configurationCount)
        var ownerConfigurations = owner.configurationCount

        harness.model.attachmentPreviews[Self.attachment.attachmentId] = UIImage(data: Self.attachmentPreview)
        try await waitUntil(timeout: 5) { owner.configurationCount > ownerConfigurations }
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        #expect(owner.configurationCount == ownerConfigurations + 1)
        #expect(native.measuredRowCount == measured)
        #expect(neighbors.map(\.configurationCount) == neighborConfigurations)
        ownerConfigurations = owner.configurationCount

        harness.model.attachmentPreviewFailures.insert(Self.attachment.attachmentId)
        try await waitUntil(timeout: 5) { owner.configurationCount > ownerConfigurations }
        #expect(owner.configurationCount == ownerConfigurations + 1)
        #expect(neighbors.map(\.configurationCount) == neighborConfigurations)
        ownerConfigurations = owner.configurationCount

        harness.model.attachmentPreviewFailures.remove(Self.attachment.attachmentId)
        try await waitUntil(timeout: 5) { owner.configurationCount > ownerConfigurations }
        #expect(owner.configurationCount == ownerConfigurations + 1)
        ownerConfigurations = owner.configurationCount

        harness.model.attachmentDownloadFailures.insert(Self.attachment.attachmentId)
        try await waitUntil(timeout: 5) { owner.configurationCount > ownerConfigurations }
        #expect(owner.configurationCount == ownerConfigurations + 1)
        #expect(neighbors.map(\.configurationCount) == neighborConfigurations)
        ownerConfigurations = owner.configurationCount

        harness.model.attachmentDownloadFailures.remove(Self.attachment.attachmentId)
        try await waitUntil(timeout: 5) { owner.configurationCount > ownerConfigurations }
        #expect(owner.configurationCount == ownerConfigurations + 1)
        ownerConfigurations = owner.configurationCount

        // File availability changes Download into Share and must have its own configuration key.
        harness.model.attachmentFiles[Self.attachment.attachmentId] = URL(fileURLWithPath: "/tmp/attachment-fixture.png")
        try await waitUntil(timeout: 5) { owner.configurationCount > ownerConfigurations }
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        #expect(owner.configurationCount == ownerConfigurations + 1)
        #expect(native.measuredRowCount == measured)
        #expect(neighbors.map(\.configurationCount) == neighborConfigurations)
    }

    @Test func batchedSendsAnchorNewestNativeRowWithoutEchoRescroll() async throws {
        let harness = try Harness(messages: Self.readerHistory)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count, timeout: 10)
        harness.model.pending = [
            PendingMessage(id: "batch-1", text: "first", status: .queued, sentAtMs: nil),
            PendingMessage(id: "batch-2", text: "second", status: .queued, sentAtMs: nil),
        ]
        try await settle(
            collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 2,
            rowID: "chat-user-row-batch-2"
        )
        let before = try mountedCellFrame(id: "chat-user-row-batch-2", in: collection).minY
        #expect(abs(before - expectedSendMinY(in: collection, priorContent: true)) <= 1)

        harness.model.messages.append(contentsOf: [
            Self.message(id: "echo-1", role: "user", content: "first", pendingID: "batch-1"),
            Self.message(id: "echo-2", role: "user", content: "second", pendingID: "batch-2"),
        ])
        harness.model.pending = []
        try await settle(
            collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 2,
            rowID: "chat-user-row-batch-2"
        )
        let after = try mountedCellFrame(id: "chat-user-row-batch-2", in: collection).minY
        #expect(abs(after - before) <= 1, "before=\(before), after=\(after), offset=\(collection.contentOffset.y)")
    }

    @Test func shortSendKeepsTailDuringDragThenRetiresOnlySafeReserve() async throws {
        let harness = try Harness(messages: [])
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        harness.model.pending = [PendingMessage(id: "short-tail", text: "short", status: .queued, sentAtMs: nil)]
        try await settle(collection, hostView: harness.host.view, minimumItems: 1, rowID: "chat-user-row-short-tail")
        let delegate = try #require(collection.delegate)
        let layout = try #require(collection.collectionViewLayout as? ExactMessageLayout)
        let beforeOffset = collection.contentOffset.y
        let beforeExtent = collection.contentSize.height
        let beforeTail = layout.tailHeight
        #expect(beforeTail > 0)

        delegate.scrollViewWillBeginDragging?(collection)
        #expect(abs(collection.contentOffset.y - beforeOffset) < 0.5)
        #expect(abs(collection.contentSize.height - beforeExtent) < 0.5)
        #expect(abs(layout.tailHeight - beforeTail) < 0.5)

        delegate.scrollViewDidEndDragging?(collection, willDecelerate: true)
        #expect(abs(collection.contentOffset.y - beforeOffset) < 0.5)
        #expect(abs(layout.tailHeight - beforeTail) < 0.5)
        delegate.scrollViewDidEndDecelerating?(collection)
        #expect(abs(collection.contentOffset.y - beforeOffset) < 0.5)

        delegate.scrollViewWillBeginDragging?(collection)
        collection.contentOffset.y = minimumOffset(of: collection)
        delegate.scrollViewDidEndDragging?(collection, willDecelerate: false)
        let safeReserve = max(
            0,
            collection.contentOffset.y + collection.bounds.height
                - collection.adjustedContentInset.bottom
                - layout.contentHeightWithoutTail
        )
        #expect(abs(layout.tailHeight - safeReserve) < 0.5)
        #expect(abs(collection.contentOffset.y - minimumOffset(of: collection)) < 0.5)

        harness.model.messages = (0..<12).map {
            Self.message(id: "tail-growth-\($0)", role: $0.isMultiple(of: 2) ? "user" : "assistant")
        }
        harness.model.pending = []
        try await settle(collection, hostView: harness.host.view, minimumItems: 12)
        #expect(layout.tailHeight == 0)
    }

    private func waitUntilAsync(
        timeout: TimeInterval,
        condition: () async -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try await DisplayFrameWaiter.next()
        }
        throw MessageListScrollTestError.geometryDidNotSettle
    }

    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await DisplayFrameWaiter.next()
        }
        throw MessageListScrollTestError.geometryDidNotSettle
    }

    private func mountedCollection(in hostView: UIView) async throws -> UICollectionView {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            hostView.setNeedsLayout()
            hostView.layoutIfNeeded()
            if let collection = descendants(hostView).compactMap({ $0 as? UICollectionView }).first,
               collection.accessibilityIdentifier == "chat-message-list" {
                return collection
            }
            try await DisplayFrameWaiter.next()
        }
        Issue.record("MessageList did not mount chat-message-list as UICollectionView")
        throw MessageListScrollTestError.collectionMissing
    }

    private func settle(
        _ collection: UICollectionView,
        hostView: UIView,
        minimumItems: Int,
        rowID: String? = nil,
        timeout: TimeInterval = 3,
        measurement: (model: MessageListScrollModel, afterRevision: Int)? = nil,
        requireRenderedMarkdown: Bool = false
    ) async throws {
        var previous: (size: CGSize, offset: CGPoint, cells: Int)?
        var stablePasses = 0
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            hostView.setNeedsLayout()
            hostView.layoutIfNeeded()
            collection.layoutIfNeeded()
            try await DisplayFrameWaiter.next()

            let itemCount = (0..<collection.numberOfSections).reduce(0) {
                $0 + collection.numberOfItems(inSection: $1)
            }
            let rowMounted = rowID == nil || collection.visibleCells.contains {
                $0.accessibilityIdentifier == rowID
            }
            let current = (collection.contentSize, collection.contentOffset, collection.visibleCells.count)
            let hasPublishedContent = minimumItems == 0 || (
                collection.contentSize.height > 0 && !collection.visibleCells.isEmpty
            )
            let measurementReady = measurement.map {
                !$0.model.measurementLoading && $0.model.measurementRevision > $0.afterRevision
            } ?? true
            // Three stable native-fallback frames are not a settled rich row.
            // Opt in only for rendered-history checks; controlled-image tests
            // intentionally inspect the fallback before releasing their loader.
            let renderedMarkdownReady = !requireRenderedMarkdown || collection.visibleCells.allSatisfy { cell in
                descendants(cell).compactMap { $0 as? MessageDocumentView }.allSatisfy {
                    $0.measuredHeight > 0 && $0.alpha == 1
                }
            }
            if itemCount >= minimumItems,
               collection.layer.animationKeys()?.isEmpty != false,
               renderedMarkdownReady,
               collection.bounds.height > 0,
               hasPublishedContent,
               rowMounted,
               measurementReady,
               let previous,
               abs(previous.size.height - current.0.height) < 0.5,
               abs(previous.offset.y - current.1.y) < 0.5,
               previous.cells == current.2 {
                stablePasses += 1
                if stablePasses == 3 { return }
            } else {
                stablePasses = 0
            }
            previous = current
        }
        let nativeState = collection.visibleCells.flatMap { descendants($0) }
            .compactMap { $0 as? MessageDocumentView }.map { "height=\($0.measuredHeight)" }
        Issue.record("MessageList geometry/row did not settle; visible native states: \(nativeState)")
        throw MessageListScrollTestError.geometryDidNotSettle
    }

    private func traverse(_ collection: UICollectionView, hostView: UIView, captureName: String = "history-recycle") async throws -> [CGFloat] {
        try await settle(
            collection, hostView: hostView, minimumItems: Self.gfmHistory.count, timeout: 10,
            requireRenderedMarkdown: true
        )
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        var extents = [collection.contentSize.height]
        for (sample, fraction) in [0.75, 0.5, 0.25, 0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0].enumerated() {
            collection.setContentOffset(CGPoint(
                x: 0,
                y: minimumOffset(of: collection) + maximumTravel(of: collection) * fraction
            ), animated: false)
            try await settle(
                collection, hostView: hostView, minimumItems: Self.gfmHistory.count, timeout: 10,
                requireRenderedMarkdown: true
            )
            extents.append(collection.contentSize.height)
            if sample == 0 || sample == 7 || sample == 11, let window = collection.window {
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                Attachment.record(image, named: "\(captureName)-\(sample).png", as: .png)
                // Long native text must retain its bubble face, not exceed the
                // GPU texture limit and silently paint only text over the pane.
                let viewport = collection.convert(collection.bounds, to: window)
                for document in collection.visibleCells.flatMap({ descendants($0) }).compactMap({ $0 as? MessageDocumentView }) where document.bounds.height > 2048 {
                    let body = document.convert(document.bounds, to: window)
                    let visible = body.intersection(viewport)
                    guard visible.height > 30 else { continue }
                    let cg = try #require(image.cgImage)
                    let data = try #require(cg.dataProvider?.data)
                    let bytes = try #require(CFDataGetBytePtr(data))
                    let stride = cg.bitsPerPixel / 8
                    func pixel(_ x: CGFloat) -> Int {
                        Int(visible.midY * image.scale) * cg.bytesPerRow + Int(x * image.scale) * stride
                    }
                    let face = pixel(body.maxX + 4), pane = pixel(viewport.minX + 2)
                    let difference = (0..<stride).reduce(0) { $0 + abs(Int(bytes[face + $1]) - Int(bytes[pane + $1])) }
                    #expect(difference > 6, "Long bubble face must paint at each traversed viewport")
                }
            }
        }
        return extents
    }

    private func postKeyboardFrame(_ frame: CGRect) {
        NotificationCenter.default.post(
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil,
            userInfo: [
                UIResponder.keyboardFrameEndUserInfoKey: frame,
                UIResponder.keyboardAnimationDurationUserInfoKey: 0.25,
                UIResponder.keyboardAnimationCurveUserInfoKey: 7,
            ]
        )
    }

    private func position(_ collection: UICollectionView, at origin: SendOrigin) {
        // Programmatic fixture movement explicitly enters reading intent; production
        // does not infer user intent from UIKit's offset adjustments.
        collection.delegate?.scrollViewWillBeginDragging?(collection)
        let fraction: CGFloat
        switch origin {
        case .empty, .top: fraction = 0
        case .middle: fraction = 0.5
        case .bottom: fraction = 1
        }
        collection.setContentOffset(CGPoint(
            x: 0, y: minimumOffset(of: collection) + maximumTravel(of: collection) * fraction
        ), animated: false)
    }

    private func mountedCellFrame(id: String, in collection: UICollectionView) throws -> CGRect {
        let cell = try #require(collection.visibleCells.first { $0.accessibilityIdentifier == id })
        let viewport = try #require(collection.superview)
        return cell.convert(cell.bounds, to: viewport)
    }

    private func mountedCellFrame(at indexPath: IndexPath, in collection: UICollectionView) throws -> CGRect {
        let cell = try #require(collection.cellForItem(at: indexPath))
        let viewport = try #require(collection.superview)
        return cell.convert(cell.bounds, to: viewport)
    }

    private func usableViewportFrame(of collection: UICollectionView) -> CGRect {
        let viewport = collection.superview!
        return collection.convert(collection.bounds.inset(by: collection.adjustedContentInset), to: viewport)
    }

    private func expectedSendMinY(in collection: UICollectionView, priorContent: Bool) -> CGFloat {
        let viewport = usableViewportFrame(of: collection)
        return viewport.minY + (priorContent ? viewport.height * 0.20 : 0)
    }

    private func descendants(_ view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap(descendants)
    }

    private func minimumOffset(of scrollView: UIScrollView) -> CGFloat {
        -scrollView.adjustedContentInset.top
    }

    private func maximumOffset(of scrollView: UIScrollView) -> CGFloat {
        max(
            minimumOffset(of: scrollView),
            scrollView.contentSize.height - scrollView.bounds.height + scrollView.adjustedContentInset.bottom
        )
    }

    private func maximumTravel(of scrollView: UIScrollView) -> CGFloat {
        maximumOffset(of: scrollView) - minimumOffset(of: scrollView)
    }

    private static let today: Int64 = {
        Int64((Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 + 12 * 60 * 60) * 1_000)
    }()
    private static let readerDetail = "A mounted history row with enough text to wrap and produce stable scroll geometry."
    private static let readerHistory: [ChatMessage] = (0..<24).map { index in
        message(
            id: "history-\(index)", role: index.isMultiple(of: 2) ? "user" : "assistant",
            content: "History row \(index). \(readerDetail)"
        )
    }

    private static func message(
        id: String,
        role: String,
        content: String = readerDetail,
        pendingID: String? = nil,
        streaming: Bool = false,
        timestamp: Int64? = nil
    ) -> ChatMessage {
        ChatMessage(
            ts: timestamp ?? today, role: role, content: content,
            streaming: streaming, cutoffKind: nil, turnId: id,
            replyId: role == "assistant" ? id : nil, pendingId: pendingID, entryId: id
        )
    }

    private static let attachment = AttachmentRef(
        attachmentId: "attachment-fixture",
        displayName: "fixture.png",
        contentType: "image/png",
        mediaKind: "image",
        size: 256
    )
    private static let attachmentPreview = UIImage(
        cgImage: testImage(width: 120, height: 80)
    ).pngData()!

    private static func attachmentMessage(
        id: String,
        attachmentId: String = attachment.attachmentId
    ) -> ChatMessage {
        ChatMessage(
            ts: today, role: "user", content: "Attached image",
            streaming: false, cutoffKind: nil, turnId: id,
            replyId: nil, pendingId: nil, sessionId: nil, entryId: id,
            attachments: [AttachmentRef(
                attachmentId: attachmentId,
                displayName: "fixture.png",
                contentType: "image/png",
                mediaKind: "image",
                size: 256
            )]
        )
    }

    private static let gfmHistory: [ChatMessage] = {
        let section = """
        ## Daily brief

        > Context stays visible while traversing a long answer.

        - [x] Reviewed local events
        - [ ] Follow up tomorrow

        | Topic | Status | Detail |
        | --- | --- | --- |
        | Weather | Clear | Mild afternoon |
        | Transit | Normal | No major delays |

        Use `swift test` for focused checks. [Reference](https://example.com/reference).

        ```swift
        let values = [1, 2, 3]
        print(values.reduce(0, +))
        ```
        """
        let detail = "A concise paragraph adds realistic wrapping, emphasis, and enough text to exercise offscreen Markdown measurement without changing message identity."
        let longAnswer = section + "\n\n" + Array(repeating: detail, count: 16).joined(separator: "\n\n")
        return [
            message(id: "fixture-user", role: "user", content: "Summarize today's interesting news and keep useful context."),
            message(id: "fixture-short", role: "assistant", content: "Here is a concise overview before the detailed brief below."),
            message(id: "fixture-long", role: "assistant", content: longAnswer),
        ]
    }()
}

@MainActor
private final class MessageListScrollModel: ObservableObject {
    @Published var messages: [ChatMessage]
    @Published var pending: [PendingMessage]
    @Published var historyLoading = false
    @Published var bottomOcclusion: CGFloat = 0
    @Published var floatingHeader = false
    @Published var floatingComposer = false
    @Published var composerDraft = ""
    @Published var paintsTranscriptFades = true
    @Published var composerFrame: CGRect?
    @Published var headerMeasurementReady = true
    @Published var headerExtraClearance: CGFloat = 0
    @Published var headerFrame: CGRect?
    @Published var transcriptFrame: CGRect?
    @Published var reservedNotice = false

    var overlays: TranscriptOverlayGeometry? {
        guard let transcriptFrame, let headerFrame, let composerFrame else { return nil }
        return TranscriptOverlayGeometry(viewport: transcriptFrame, header: headerFrame, composer: composerFrame)
    }
    var topOcclusion: CGFloat? {
        if floatingComposer { return overlays?.topClearance }
        guard floatingHeader else { return 0 }
        guard headerMeasurementReady, let headerFrame, let transcriptFrame else { return nil }
        return max(0, min(transcriptFrame.height, headerFrame.maxY - transcriptFrame.minY))
    }
    @Published var attachmentPreviews: [String: UIImage] = [:]
    @Published var attachmentPreviewFailures: Set<String> = []
    @Published var attachmentFiles: [String: URL] = [:]
    @Published var attachmentDownloadFailures: Set<String> = []
    let initialExistingHistory: Bool?
    let imageLoader: any NetworkImageLoader
    let positionScheduler: MessagePositionScheduler
    private(set) var measurementLoading = false
    private(set) var measurementRevision = 0
    private(set) var measurementTransitions: [Bool] = []
    private(set) var visibleAttachmentSets: [Set<String>] = []

    init(
        messages: [ChatMessage],
        pending: [PendingMessage] = [],
        initialExistingHistory: Bool? = nil,
        imageLoader: any NetworkImageLoader = DefaultNetworkImageLoader.shared,
        positionScheduler: @escaping MessagePositionScheduler = {
            DispatchQueue.main.async(execute: $0)
        }
    ) {
        self.messages = messages
        self.pending = pending
        self.initialExistingHistory = initialExistingHistory
        self.imageLoader = imageLoader
        self.positionScheduler = positionScheduler
    }

    func measurementLoadingChanged(_ loading: Bool) {
        measurementTransitions.append(loading)
        if measurementLoading && !loading { measurementRevision += 1 }
        measurementLoading = loading
    }

    func visibleAttachmentIdsChanged(_ ids: Set<String>) {
        visibleAttachmentSets.append(ids)
    }
}

private struct MessageListScrollFixture: View {
    @ObservedObject var model: MessageListScrollModel
    let dynamicType: DynamicTypeSize

    var body: some View {
        GeometryReader { _ in
            ZStack(alignment: .bottom) {
                transcriptColumn
                    .ignoresSafeArea(.keyboard, edges: .bottom)
                if model.floatingComposer {
                    Composer(tasks: [], ttsEnabled: true, talkMode: .idle, micLevels: [0],
                        voiceDisabled: true, canInterrupt: false, draftText: model.composerDraft,
                        onDraftChange: { _ in }, onSend: { _ in }, onVoiceIntent: { _ in },
                        onTtsToggle: {}, onInterrupt: {}, onFocusGained: {})
                        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { model.composerFrame = $0 }
                }
            }
            .overlay(alignment: .top) {
                if model.floatingHeader {
                    ChatTitleBar(onOpenPanel: {}, onOpenInbox: {}, onNewChat: {})
                        .padding(.bottom, model.headerExtraClearance)
                        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { model.headerFrame = $0 }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .duskTheme()
        }
        .environment(\.dynamicTypeSize, dynamicType)
    }

    private var transcriptColumn: some View {
        VStack(spacing: 0) {
            if model.reservedNotice {
                Color.clear.frame(height: model.headerFrame?.height ?? 0)
                ShellNoticeRegion(availableHeight: 500) {
                    Button("Retry recovery", action: {}).padding()
                }
            }
            transcript
                .overlay(alignment: .topLeading) {
                    if model.floatingComposer, model.paintsTranscriptFades, let overlays = model.overlays {
                        TranscriptFades(geometry: overlays)
                    }
                }
                .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { model.transcriptFrame = $0 }
        }
    }

    private var transcript: some View {
        MessageList(
            messages: model.messages,
            pending: model.pending,
            attachmentPreviews: model.attachmentPreviews,
            attachmentPreviewFailures: model.attachmentPreviewFailures,
            attachmentFiles: model.attachmentFiles,
            attachmentDownloadFailures: model.attachmentDownloadFailures,
            onVisibleAttachmentPreviewIdsChange: model.visibleAttachmentIdsChanged,
            historyLoading: model.historyLoading,
            bottomOcclusion: model.floatingComposer ? (model.overlays?.bottomClearance ?? 0) : model.bottomOcclusion,
            topOcclusion: model.topOcclusion,
            initialExistingHistory: model.initialExistingHistory,
            imageLoader: model.imageLoader,
            positionScheduler: model.positionScheduler,
            onMeasurementLoadingChange: model.measurementLoadingChanged
        )
            .environment(\.dynamicTypeSize, dynamicType)
            .transaction { transaction in
                transaction.animation = nil
                transaction.disablesAnimations = true
            }
    }
}

@MainActor
private final class Harness {
    let model: MessageListScrollModel
    let host: UIHostingController<MessageListScrollFixture>
    let window: UIWindow

    init(
        messages: [ChatMessage],
        pending: [PendingMessage] = [],
        dynamicType: DynamicTypeSetting = .normal,
        floatingHeader: Bool = false,
        headerMeasurementReady: Bool = true,
        initialExistingHistory: Bool? = nil,
        imageLoader: any NetworkImageLoader = DefaultNetworkImageLoader.shared,
        positionScheduler: @escaping MessagePositionScheduler = {
            DispatchQueue.main.async(execute: $0)
        }
    ) throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        model = MessageListScrollModel(
            messages: messages,
            pending: pending,
            initialExistingHistory: initialExistingHistory,
            imageLoader: imageLoader,
            positionScheduler: positionScheduler
        )
        model.floatingHeader = floatingHeader
        model.headerMeasurementReady = headerMeasurementReady
        host = UIHostingController(rootView: MessageListScrollFixture(model: model, dynamicType: dynamicType.swiftUI))
        host.traitOverrides.preferredContentSizeCategory = dynamicType.uiKit
        window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 733)
        window.rootViewController = host
        window.makeKeyAndVisible()
    }

    func close() {
        window.isHidden = true
        window.rootViewController = nil
    }
}

private enum DynamicTypeSetting: CaseIterable {
    case normal
    case accessibility

    var swiftUI: DynamicTypeSize {
        switch self {
        case .normal: .large
        case .accessibility: .accessibility3
        }
    }

    var uiKit: UIContentSizeCategory {
        switch self {
        case .normal: .large
        case .accessibility: .accessibilityExtraLarge
        }
    }
}

enum SendOrigin: String, CaseIterable, CustomTestStringConvertible {
    case empty
    case top
    case middle
    case bottom

    var pendingID: String { "send-from-\(rawValue)" }
    var testDescription: String { rawValue }
}

@MainActor
private final class HeldMessagePositionScheduler {
    private var actions: [() -> Void] = []
    var count: Int { actions.count }

    func schedule(_ action: @escaping () -> Void) { actions.append(action) }
    func discardAll() { actions.removeAll() }
    func runFirst() { actions.removeFirst()() }
    func runAll() {
        let pending = actions
        actions.removeAll()
        pending.forEach { $0() }
    }
    func runLast() {
        let action = actions.removeLast()
        actions.removeAll()
        action()
    }
}

private enum MessageListScrollTestError: Error {
    case collectionMissing
    case geometryDidNotSettle
}

/// Synthetic full-width row marks intentionally cover gutters/corners where
/// ordinary bubble text rarely reaches. Lives inside a native scrolling cell.
private final class ComposerFadeRowMarks: UIView {
    override func draw(_ rect: CGRect) {
        for stripe in 0..<Int(ceil(bounds.height / 16)) {
            (stripe.isMultiple(of: 2) ? UIColor.white : UIColor.black).setFill()
            UIRectFill(CGRect(x: 0, y: CGFloat(stripe * 16), width: bounds.width, height: 16))
        }
    }
}
