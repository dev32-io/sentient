import Combine
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

    @Test func committedUserAndAssistantRowsMountSelectableContentButMeasurementStaysNative() async throws {
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
        let baseline = SelectableMarkdownHostView.liveViewCount
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

        try await waitUntil(timeout: 5) {
            let webViews = descendants(collection).compactMap { $0 as? WKWebView }
            return webViews.count == 2 && webViews.allSatisfy {
                $0.alpha == 1 && $0.frame.height > 1
            }
        }
        let webViews = descendants(collection).compactMap { $0 as? WKWebView }
        #expect(webViews.count == 2)
        #expect(SelectableMarkdownHostView.liveViewCount == baseline + 2)
        #expect(webViews.allSatisfy { $0.configuration.defaultWebpagePreferences.allowsContentJavaScript == false })

        for webView in webViews {
            _ = webView.becomeFirstResponder()
            webView.selectAll(nil)
        }
        try await waitUntil(timeout: 2) {
            webViews.allSatisfy {
                $0.canPerformAction(#selector(UIResponderStandardEditActions.copy(_:)), withSender: nil)
            }
        }

        let pendingCell = try #require(collection.visibleCells.first {
            $0.accessibilityIdentifier == "chat-user-row-\(pendingID)"
        })
        let pendingTextView = try #require(descendants(pendingCell).compactMap { $0 as? UITextView }.first)
        #expect(pendingTextView.isSelectable)
        #expect(pendingTextView.text == "Pending copy")
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
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count, timeout: 10)
        let native = try #require(collection as? MessageUICollectionView)
        let measured = native.measuredRowCount
        let lastIndex = collection.numberOfItems(inSection: 0) - 1
        let lastCell = try #require(collection.cellForItem(at: IndexPath(item: lastIndex, section: 0)) as? MessageHostingCell)
        let configurations = lastCell.configurationCount
        let extent = collection.contentSize.height
        messages[messages.count - 1] = Self.message(id: "cached-live", role: "assistant", content: "Two.", streaming: true)
        harness.model.messages = messages
        try await waitUntil(timeout: 5) { lastCell.configurationCount > configurations }
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        #expect(abs(collection.contentSize.height - extent) < 1)
        #expect(native.measuredRowCount == measured)

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
            let coldSamples = try await traverse(collection, hostView: harness.host.view)
            let settledColdExtent = try #require(coldSamples.last)
            #expect(settledColdExtent.isFinite && settledColdExtent > 0)

            harness.model.messages = harness.model.messages
            try await settle(collection, hostView: harness.host.view, minimumItems: Self.gfmHistory.count)
            let warmSamples = try await traverse(collection, hostView: harness.host.view)
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
        harness.model.messages.append(Self.message(
            id: "echo", role: "user", content: "Reconciled send", pendingID: id
        ))
        harness.model.pending = []
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-\(id)"
        )

        #expect(abs(try mountedCellFrame(id: "chat-user-row-\(id)", in: collection).minY - before) <= 1)
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
    func explicitNewChatFirstSendTopAlignsIncludingQuickEcho(quickEcho: Bool) async throws {
        let harness = try Harness(messages: [], initialExistingHistory: false)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        let id = "explicit-new-send"
        if quickEcho {
            harness.model.messages = [Self.message(
                id: "quick-echo", role: "user", content: Self.readerDetail, pendingID: id
            )]
        } else {
            harness.model.pending = [PendingMessage(
                id: id, text: Self.readerDetail, status: .queued, sentAtMs: nil
            )]
        }
        try await settle(
            collection, hostView: harness.host.view, minimumItems: 1,
            rowID: "chat-user-row-\(id)", timeout: 10
        )
        #expect(abs(
            try mountedCellFrame(id: "chat-user-row-\(id)", in: collection).minY
                - usableViewportFrame(of: collection).minY
        ) <= 1)
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

    @Test func largeHistoryMountsBoundedNativeCellCount() async throws {
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
    }

    @Test func resolvedMarkdownImageChangesExtentOnceAndSurvivesRecycle() async throws {
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
        // native fallback estimates are not the baseline for a WebKit image row.
        _ = try await traverse(collection, hostView: harness.host.view)
        harness.model.messages = messages
        collection.setContentOffset(CGPoint(x: 0, y: maximumOffset(of: collection) / 2), animated: false)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        let anchor = try #require(collection.indexPathsForVisibleItems.sorted().first)
        let beforeFrame = try mountedCellFrame(at: anchor, in: collection).minY
        let provisionalExtent = collection.contentSize.height

        await loader.resolve(url: imageURL, image: testImage(width: 240, height: 180))
        try await waitUntil(timeout: 5) { collection.contentSize.height > provisionalExtent + 50 }
        try await settle(
            collection, hostView: harness.host.view, minimumItems: messages.count,
            requireRenderedMarkdown: true
        )
        let resolvedExtent = collection.contentSize.height
        #expect(abs(try mountedCellFrame(at: anchor, in: collection).minY - beforeFrame) <= 1)

        let samples = try await traverse(collection, hostView: harness.host.view)
        #expect(samples.allSatisfy { abs($0 - resolvedExtent) < 1 })
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
        let first = cache.entry(for: firstURL)
        cache.acquire(first, for: firstURL)
        try await waitUntilAsync(timeout: 3) { await loader.requestCount(for: firstURL) == 1 }
        await loader.resolve(url: firstURL, image: testImage(width: 120, height: 80))
        try await waitUntilAsync(timeout: 3) { cache.image(for: firstURL) != nil }
        cache.release(first)

        let second = cache.entry(for: secondURL)
        cache.acquire(second, for: secondURL)
        try await waitUntilAsync(timeout: 3) { await loader.requestCount(for: secondURL) == 1 }
        await loader.resolve(url: secondURL, image: testImage(width: 90, height: 60))
        try await waitUntilAsync(timeout: 3) { cache.image(for: secondURL) != nil }
        cache.release(second)

        #expect([firstURL, secondURL].compactMap(cache.image(for:)).count <= 1)
        #expect(cache.knownMetadata(for: firstURL) == .size(CGSize(width: 120, height: 80)))
        #expect(first.result == .known(CGSize(width: 120, height: 80)))

        cache.acquire(first, for: firstURL)
        try await waitUntilAsync(timeout: 3) { await loader.requestCount(for: firstURL) == 2 }
        #expect(first.result == .known(CGSize(width: 120, height: 80)))
        cache.release(first)
    }

    @Test func markdownImageCacheCancelsOnlyAfterLastSharedConsumerReleases() async throws {
        let loader = DelayedImageLoader()
        let cache = MarkdownImageCache(loader: loader)
        let url = URL(string: "https://fixture.invalid/shared.png")!
        let entry = cache.entry(for: url)
        cache.acquire(entry, for: url)
        cache.acquire(entry, for: url)
        try await waitUntilAsync(timeout: 3) { await loader.requestCount(for: url) == 1 }

        cache.release(entry)
        try await DisplayFrameWaiter.next()
        #expect(await loader.cancellationCount(for: url) == 0)
        cache.release(entry)
        try await waitUntilAsync(timeout: 3) { await loader.cancellationCount(for: url) == 1 }
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
        harness.model.pending = [PendingMessage(id: "owned", text: "send", status: .queued, sentAtMs: nil)]
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 1)
        collection.setContentOffset(CGPoint(x: 0, y: minimumOffset(of: collection)), animated: false)
        try await settle(collection, hostView: harness.host.view, minimumItems: Self.readerHistory.count + 1)

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
        #expect(abs(try mountedCellFrame(id: "chat-user-row-batch-2", in: collection).minY - before) <= 1)
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
                descendants(cell).compactMap { $0 as? SelectableMarkdownHostView }.allSatisfy {
                    $0.measuredHeight != nil && $0.webView.alpha == 1
                }
            }
            if itemCount >= minimumItems,
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
        let webState = collection.visibleCells.flatMap { descendants($0) }
            .compactMap { $0 as? SelectableMarkdownHostView }.map {
                "loads=\($0.loadCount),height=\($0.measuredHeight ?? -1),publications=\($0.heightUpdateCount),failure=\(String(describing: $0.loadFailure))"
            }
        Issue.record("MessageList geometry/row did not settle; live WebKit hosts=\(SelectableMarkdownHostView.liveViewCount), visible states: \(webState)")
        throw MessageListScrollTestError.geometryDidNotSettle
    }

    private func traverse(_ collection: UICollectionView, hostView: UIView) async throws -> [CGFloat] {
        try await settle(
            collection, hostView: hostView, minimumItems: Self.gfmHistory.count, timeout: 10,
            requireRenderedMarkdown: true
        )
        var extents = [collection.contentSize.height]
        for fraction in [0.75, 0.5, 0.25, 0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0] {
            collection.setContentOffset(CGPoint(
                x: 0,
                y: minimumOffset(of: collection) + maximumTravel(of: collection) * fraction
            ), animated: false)
            try await settle(
                collection, hostView: hostView, minimumItems: Self.gfmHistory.count, timeout: 10,
                requireRenderedMarkdown: true
            )
            extents.append(collection.contentSize.height)
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
        streaming: Bool = false
    ) -> ChatMessage {
        ChatMessage(
            ts: today, role: role, content: content,
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
        MessageList(
            messages: model.messages,
            pending: model.pending,
            attachmentPreviews: model.attachmentPreviews,
            attachmentPreviewFailures: model.attachmentPreviewFailures,
            attachmentFiles: model.attachmentFiles,
            attachmentDownloadFailures: model.attachmentDownloadFailures,
            onVisibleAttachmentPreviewIdsChange: model.visibleAttachmentIdsChanged,
            historyLoading: model.historyLoading,
            bottomOcclusion: model.bottomOcclusion,
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

private actor DelayedImageLoader: NetworkImageLoader {
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

    func requestCount(for url: URL) -> Int { requests[url, default: 0] }
    func cancellationCount(for url: URL) -> Int { cancellations[url, default: 0] }

    private func cancel(url: URL) {
        cancellations[url, default: 0] += 1
        continuations.removeValue(forKey: url)?.forEach { $0.resume(throwing: CancellationError()) }
    }
}

private func testImage(width: Int, height: Int) -> CGImage {
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

private enum MessageListScrollTestError: Error {
    case collectionMissing
    case geometryDidNotSettle
}
