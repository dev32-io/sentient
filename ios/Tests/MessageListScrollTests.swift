import Combine
import NetworkImage
import SwiftUI
import Testing
import UIKit
import MobileData
@testable import SentientApp

@MainActor
@Suite(.serialized)
struct MessageListScrollTests {
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
            #expect(coldSamples.allSatisfy { abs($0 - coldExtent) < 1 })

            harness.model.messages = harness.model.messages
            try await settle(collection, hostView: harness.host.view, minimumItems: Self.gfmHistory.count)
            let warmSamples = try await traverse(collection, hostView: harness.host.view)
            #expect(warmSamples.allSatisfy { abs($0 - coldExtent) < 1 })
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
        #expect(abs(frame.minY - usableViewportFrame(of: collection).minY) <= 1)
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
        #expect(abs(narrow.minY - usableViewportFrame(of: collection).minY) <= 1)
        harness.window.frame.size = CGSize(width: 520, height: 430)
        harness.host.view.frame = harness.window.bounds
        try await settle(
            collection, hostView: harness.host.view,
            minimumItems: Self.readerHistory.count + 1, rowID: "chat-user-row-\(id)"
        )
        let wide = try mountedCellFrame(id: "chat-user-row-\(id)", in: collection)
        #expect(abs(wide.minY - usableViewportFrame(of: collection).minY) <= 1)
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
                - usableViewportFrame(of: collection).minY
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
        let harness = try Harness(messages: messages, imageLoader: loader)
        defer { harness.close() }
        let collection = try await mountedCollection(in: harness.host.view)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count, timeout: 10)
        collection.setContentOffset(CGPoint(x: 0, y: maximumOffset(of: collection) / 2), animated: false)
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
        let anchor = try #require(collection.indexPathsForVisibleItems.sorted().first)
        let beforeFrame = try mountedCellFrame(at: anchor, in: collection).minY
        let provisionalExtent = collection.contentSize.height

        await loader.resolve(url: imageURL, image: testImage(width: 240, height: 180))
        try await waitUntil(timeout: 5) { collection.contentSize.height > provisionalExtent + 50 }
        try await settle(collection, hostView: harness.host.view, minimumItems: messages.count)
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
        try await settle(collection, hostView: harness.host.view, minimumItems: 1)
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
                - usableViewportFrame(of: collection).minY
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
        #expect(abs(before - usableViewportFrame(of: collection).minY) <= 1)

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
        measurement: (model: MessageListScrollModel, afterRevision: Int)? = nil
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
            if itemCount >= minimumItems,
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
        Issue.record("MessageList native collection geometry or requested row did not settle")
        throw MessageListScrollTestError.geometryDidNotSettle
    }

    private func traverse(_ collection: UICollectionView, hostView: UIView) async throws -> [CGFloat] {
        var extents = [collection.contentSize.height]
        for fraction in [0.75, 0.5, 0.25, 0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0] {
            collection.setContentOffset(CGPoint(
                x: 0,
                y: minimumOffset(of: collection) + maximumTravel(of: collection) * fraction
            ), animated: false)
            try await settle(collection, hostView: hostView, minimumItems: Self.gfmHistory.count)
            extents.append(collection.contentSize.height)
        }
        return extents
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
        pendingID: String? = nil
    ) -> ChatMessage {
        ChatMessage(
            ts: today, role: role, content: content,
            streaming: false, cutoffKind: nil, turnId: id,
            replyId: role == "assistant" ? id : nil, pendingId: pendingID, entryId: id
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
    let initialExistingHistory: Bool?
    let imageLoader: any NetworkImageLoader
    let positionScheduler: MessagePositionScheduler
    private(set) var measurementLoading = false
    private(set) var measurementRevision = 0
    private(set) var measurementTransitions: [Bool] = []

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
}

private struct MessageListScrollFixture: View {
    @ObservedObject var model: MessageListScrollModel
    let dynamicType: DynamicTypeSize

    var body: some View {
        MessageList(
            messages: model.messages,
            pending: model.pending,
            historyLoading: model.historyLoading,
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

    func close() { window.isHidden = true }
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
