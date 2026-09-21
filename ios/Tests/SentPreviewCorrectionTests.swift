import Combine
import MobileData
import SwiftUI
import Testing
import UIKit
@testable import SentientApp

@MainActor
struct SentPreviewCorrectionTests {
    @Test func orderedHandoffMapsBoundedPreviewToDifferentServerIDsAndRejectsMismatch() throws {
        let pending = [
            attachment("local-one", name: "one.png", size: 11),
            attachment("local-two", name: "two.png", size: 22),
        ]
        let refs = [
            reference("server-one", name: "one.png", size: 11),
            reference("server-two", name: "two.png", size: 22),
        ]

        let handoff = try #require(validatedAttachmentPreviewHandoff(pending: pending, refs: refs))
        #expect(handoff.map(\.localId) == ["local-one", "local-two"])
        #expect(handoff.map(\.serverId) == ["server-one", "server-two"])
        #expect(validatedAttachmentPreviewHandoff(
            pending: pending,
            refs: [refs[1], refs[0]]
        ) == nil)
    }

    @Test func pendingIdentityKeepsLocalPreviewEligibleAfterDraftClears() {
        let pending = [attachment("local-photo", name: "photo.png", size: 12)]

        #expect(activeImageAttachmentIds(draft: [], pending: pending) == ["local-photo"])
        #expect(activeImageAttachmentIds(draft: [], pending: []) == [])
    }

    @Test func acknowledgingOnePendingOwnerLeavesOtherAttachmentsAndTransfers() {
        let ownerA = attachment("owner-a", name: "a.png", size: 1)
        let ownerB = attachment("owner-b", name: "b.png", size: 2)
        let cleaned = pendingAttachmentCleanup(
            ownedAttachmentIds: [ownerA.id],
            attachments: [ownerA, ownerB],
            transfers: [
                ownerA.id: AttachmentTransferState(phase: .failed),
                ownerB.id: AttachmentTransferState(phase: .uploading, progress: 0.5),
            ]
        )

        #expect(cleaned.attachments.map(\.id) == [ownerB.id])
        #expect(Set(cleaned.transfers.keys) == [ownerB.id])
        #expect(cleaned.transfers[ownerB.id]?.phase == .uploading)
    }

    @Test func cancelledUploadSettlesEveryActiveCardWithoutChangingSettledCards() {
        let cancelled = cancellingActiveUploads([
            "active-a": AttachmentTransferState(phase: .uploading, progress: 0.5),
            "active-b": AttachmentTransferState(phase: .uploading),
            "ready": AttachmentTransferState(phase: .ready, progress: 1),
            "failed": AttachmentTransferState(phase: .failed),
        ])

        #expect(cancelled["active-a"]?.phase == .cancelled)
        #expect(cancelled["active-b"]?.phase == .cancelled)
        #expect(cancelled["ready"] == AttachmentTransferState(phase: .ready, progress: 1))
        #expect(cancelled["failed"] == AttachmentTransferState(phase: .failed))
    }

    @Test func freshHistoryLoadsOnlyOnVisibleDemandAndExplicitRetryRecoversAfter503() async throws {
        let session = previewSession()
        defer { session.close() }
        let requests = PreviewRequests(result: previewPNG())
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            activateOnInit: false,
            observeChatOnInit: false,
            previewAttachment: { id in try await requests.load(id) }
        )
        let model = historyModel(attachmentIds: ["server-preview"])

        viewModel.applyChat(model)
        await Task.yield()
        #expect(await requests.ids.isEmpty)

        viewModel.setVisibleAttachmentPreviewIds(["server-preview"])
        await requests.waitForAttempt(1)
        await eventually { viewModel.attachmentPreviewFailures.contains("server-preview") }
        #expect(viewModel.attachmentPreviews["server-preview"] == nil)

        viewModel.retryAttachmentPreview("server-preview")
        await requests.waitForAttempt(2)
        await eventually { viewModel.attachmentPreviews["server-preview"] != nil }

        #expect(await requests.ids == ["server-preview", "server-preview"])
        #expect(!viewModel.attachmentPreviewFailures.contains("server-preview"))
    }

    @Test func unchangedPreviewFailurePruningDoesNotPublishAgain() async throws {
        let session = previewSession()
        defer { session.close() }
        let requests = PreviewRequests(result: previewPNG())
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            activateOnInit: false,
            observeChatOnInit: false,
            previewAttachment: { id in try await requests.load(id) }
        )
        viewModel.applyChat(historyModel(attachmentIds: ["failed-preview"]))
        viewModel.setVisibleAttachmentPreviewIds(["failed-preview"])
        await requests.waitForAttempt(1)
        await eventually { viewModel.attachmentPreviewFailures.contains("failed-preview") }

        var notifications = 0
        let observation = viewModel.objectWillChange.sink { _ in notifications += 1 }
        viewModel.applyChat(historyModel(attachmentIds: ["failed-preview"]))
        observation.cancel()

        #expect(notifications == 1, "state update only; unchanged failure set must not publish")
    }

    @Test func imageHeavyHistoryBoundsRequestsDecodedCacheAndReloadsEvictedRevisit() async throws {
        let session = previewSession()
        defer { session.close() }
        let requests = ControlledPreviewRequests(result: largePreviewPNG())
        let ids = (0..<12).map { "history-\($0)" }
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            activateOnInit: false,
            observeChatOnInit: false,
            previewAttachment: { id in try await requests.load(id) }
        )

        viewModel.applyChat(historyModel(attachmentIds: ids, liveContent: "token one"))
        viewModel.applyChat(historyModel(attachmentIds: ids, liveContent: "token one two"))
        await Task.yield()
        #expect(await requests.requestCount == 0)

        viewModel.setVisibleAttachmentPreviewIds(Set(ids.prefix(6)))
        await requests.waitForRequestCount(ChatViewModel.attachmentPreviewRequestLimit)
        #expect(await requests.peak == ChatViewModel.attachmentPreviewRequestLimit)

        viewModel.setVisibleAttachmentPreviewIds(Set(ids.suffix(6)))
        await Task.yield()
        #expect(await requests.requestCount == ChatViewModel.attachmentPreviewRequestLimit)
        #expect(viewModel.attachmentPreviewRequestCount == ChatViewModel.attachmentPreviewRequestLimit)

        await requests.resolvePending()
        await requests.waitForRequestCount(6)
        #expect(await requests.peak <= ChatViewModel.attachmentPreviewRequestLimit)
        await requests.resolvePending()
        await requests.waitForRequestCount(9)
        await requests.resolvePending()
        await eventually { viewModel.attachmentPreviewRequestCount == 0 }

        viewModel.setVisibleAttachmentPreviewIds(Set(ids))
        await requests.waitForRequestCount(12)
        await requests.resolvePending()
        await requests.waitForRequestCount(15)
        await requests.resolvePending()
        await eventually { viewModel.attachmentPreviewRequestCount == 0 }

        #expect(Set(viewModel.attachmentPreviews.keys) == Set(ids))
        #expect(viewModel.attachmentPreviewOffscreenCount == 0)
        #expect(viewModel.attachmentPreviews.values.allSatisfy {
            max($0.size.width * $0.scale, $0.size.height * $0.scale) <= 640
        })
        #expect(await requests.peak <= ChatViewModel.attachmentPreviewRequestLimit)

        let countsWhileVisible = await requests.counts(for: ids)
        viewModel.applyChat(historyModel(attachmentIds: ids, liveContent: "new token update"))
        viewModel.setVisibleAttachmentPreviewIds(Set(ids))
        await Task.yield()
        #expect(await requests.counts(for: ids) == countsWhileVisible)
        #expect(Set(viewModel.attachmentPreviews.keys) == Set(ids))

        let weakImages = Dictionary(uniqueKeysWithValues: viewModel.attachmentPreviews.map {
            ($0.key, WeakImageReference($0.value))
        })
        viewModel.setVisibleAttachmentPreviewIds([])
        #expect(viewModel.attachmentPreviewOffscreenCount <= ChatViewModel.attachmentPreviewOffscreenCountLimit)
        #expect(viewModel.attachmentPreviewOffscreenCost <= ChatViewModel.attachmentPreviewOffscreenCostLimit)
        let evicted = try #require(ids.first { viewModel.attachmentPreviews[$0] == nil })
        await eventually { weakImages[evicted]?.image == nil }
        let beforeRevisit = await requests.count(for: evicted)
        viewModel.setVisibleAttachmentPreviewIds([evicted])
        await requests.waitForRequestCount(16)
        await requests.resolvePending()
        await eventually { viewModel.attachmentPreviews[evicted] != nil }
        #expect(await requests.count(for: evicted) == beforeRevisit + 1)

        weak var clearedImage = viewModel.attachmentPreviews[evicted]
        viewModel.clearAttachmentPreviews()
        await eventually { clearedImage == nil }
    }

    @Test func rowSnapshotsOwnOnlyTheirPreviewAndCellClearReleasesIt() throws {
        let ownerId = "owner"
        var owner: UIImage? = UIImage(cgImage: try #require(UIImage(data: previewPNG())?.cgImage))
        var unrelated: UIImage? = UIImage(cgImage: try #require(UIImage(data: previewPNG())?.cgImage))
        weak var releasedUnrelated = unrelated
        weak var releasedOwner = owner
        var previews = [ownerId: owner!, "unrelated": unrelated!]
        let message = historyModel(attachmentIds: [ownerId]).committed[0]
        var snapshot: [String: UIImage]? = rowAttachmentPreviews(
            ownedBy: .message(message, index: 0, continuation: false),
            from: previews
        )
        #expect(Set(snapshot!.keys) == Set([ownerId]))

        unrelated = nil
        previews = snapshot!
        #expect(releasedUnrelated == nil)

        let cell = MessageHostingCell(frame: .zero)
        cell.set(
            rootView: AnyView(Image(uiImage: snapshot![ownerId]!)),
            avatarPlaybackEnabled: false,
            configurationKey: "owner",
            measurementKey: "owner"
        )
        owner = nil
        snapshot = nil
        previews = [:]
        #expect(releasedOwner != nil)
        cell.clearContent()
        #expect(releasedOwner == nil)
    }

    @Test func acknowledgedSendReleasesPinnedPreviewOwnership() async throws {
        let session = previewSession()
        defer { session.close() }
        let drafts = try #require(session.component.drafts)
        let draft = try #require(try await drafts.saveText(
            draftId: nil, sessionId: "history-session", text: "pending"
        ))
        let pending = try await drafts.beginSend(
            draftId: draft.id, mintKey: "ack-mint", surfaceId: "ack-surface"
        )
        let viewModel = previewViewModel(session)
        let image = await loadAndPin(
            viewModel, id: "ack-preview", pendingId: pending.pendingId
        )

        viewModel.applyChat(historyModel(
            attachmentIds: ["ack-preview"], pendingId: pending.pendingId,
            reconciledPendingIds: [pending.pendingId]
        ))
        await eventually { viewModel.pinnedAttachmentPreviewCount == 0 }
        viewModel.applyChat(historyModel(attachmentIds: []))

        await eventually { image.image == nil }
    }

    @Test func repeatedReceiptAcknowledgmentRunsOncePerRouteLifetime() async throws {
        let session = previewSession()
        defer { session.close() }
        let acknowledgements = ReceiptAcknowledgements(outcomes: [.acknowledged])
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            activateOnInit: false,
            observeChatOnInit: false,
            acknowledgeReceipt: { pendingId, sessionId in
                try await acknowledgements.acknowledge(pendingId: pendingId, sessionId: sessionId)
            }
        )
        let model = historyModel(
            attachmentIds: ["receipt-attachment"],
            pendingId: "receipt",
            reconciledPendingIds: ["receipt"]
        )

        viewModel.applyChat(model)
        await acknowledgements.waitForCount(1)
        viewModel.applyChat(model)

        #expect(await acknowledgements.count == 1)
    }

    @Test func missingReceiptIsHandledOnceWithoutRepeatingDatabaseWork() async throws {
        let session = previewSession()
        defer { session.close() }
        let acknowledgements = ReceiptAcknowledgements(outcomes: [.missing])
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            activateOnInit: false,
            observeChatOnInit: false,
            acknowledgeReceipt: { pendingId, sessionId in
                try await acknowledgements.acknowledge(pendingId: pendingId, sessionId: sessionId)
            }
        )
        let model = historyModel(
            attachmentIds: ["missing-attachment"],
            pendingId: "missing",
            reconciledPendingIds: ["missing"]
        )

        viewModel.applyChat(model)
        await acknowledgements.waitForCount(1)
        viewModel.applyChat(model)

        #expect(await acknowledgements.count == 1)
    }

    @Test func mismatchedReceiptIsNotMarkedHandled() async throws {
        let session = previewSession()
        defer { session.close() }
        let drafts = try #require(session.component.drafts)
        let draft = try #require(try await drafts.saveText(
            draftId: nil, sessionId: "other-session", text: "pending"
        ))
        let pending = try await drafts.beginSend(
            draftId: draft.id, mintKey: "mismatch-mint", surfaceId: "mismatch-surface"
        )
        let acknowledgements = ReceiptAcknowledgements(outcomes: [.missing, .missing, .missing])
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            activateOnInit: false,
            observeChatOnInit: false,
            acknowledgeReceipt: { pendingId, sessionId in
                try await acknowledgements.acknowledge(pendingId: pendingId, sessionId: sessionId)
            }
        )
        let model = historyModel(
            attachmentIds: ["mismatch-attachment"],
            pendingId: pending.pendingId,
            reconciledPendingIds: [pending.pendingId]
        )

        viewModel.applyChat(model)
        await acknowledgements.waitForCount(3)
        await eventually { viewModel.receiptAcknowledgmentFailures.contains(pending.pendingId) }
        viewModel.applyChat(model)

        #expect(await acknowledgements.count == 3)
        let restored = try await drafts.restore()
        #expect(restored.pendingSends.contains { $0.pendingId == pending.pendingId })
    }

    @Test func acknowledgingReceiptOnlyClearsItsPendingAttachmentState() async throws {
        let session = previewSession()
        defer { session.close() }
        let drafts = try #require(session.component.drafts)
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("receipt-owners-\(UUID().uuidString).png")
        try previewPNG().write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }

        let draftA = try #require(try await drafts.saveText(
            draftId: nil, sessionId: "history-session", text: "owner A"
        ))
        let importedA = try await drafts.importAttachment(
            draftId: draftA.id,
            sessionId: draftA.sessionId,
            source: NativeDraftAttachmentImport(
                sourceLocation: source.absoluteString,
                displayName: "a.png",
                mediaType: "image/png",
                previewSourceLocation: nil
            )
        )
        let pendingA = try await drafts.beginSend(
            draftId: importedA.id, mintKey: "owner-a-mint", surfaceId: "owner-a-surface"
        )
        let draftB = try #require(try await drafts.saveText(
            draftId: nil, sessionId: "other-session", text: "owner B"
        ))
        let importedB = try await drafts.importAttachment(
            draftId: draftB.id,
            sessionId: draftB.sessionId,
            source: NativeDraftAttachmentImport(
                sourceLocation: source.absoluteString,
                displayName: "b.png",
                mediaType: "image/png",
                previewSourceLocation: nil
            )
        )
        let pendingB = try await drafts.beginSend(
            draftId: importedB.id, mintKey: "owner-b-mint", surfaceId: "owner-b-surface"
        )
        let acknowledgements = ReceiptAcknowledgements(outcomes: [.acknowledged])
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            draftId: importedA.id,
            activateOnInit: false,
            observeChatOnInit: false,
            acknowledgeReceipt: { pendingId, sessionId in
                try await acknowledgements.acknowledge(pendingId: pendingId, sessionId: sessionId)
            }
        )
        let attachmentA = try #require(pendingA.attachments.first)
        let attachmentB = try #require(pendingB.attachments.first)

        await eventually { viewModel.attachmentTransfers[attachmentA.id] != nil }
        await eventually { viewModel.attachmentTransfers[attachmentA.id]?.phase == .failed }
        viewModel.retryAttachmentUpload(attachmentB.id)
        await eventually { viewModel.pendingAttachments.contains { $0.id == attachmentB.id } }
        await eventually { viewModel.attachmentTransfers[attachmentB.id] != nil }

        viewModel.applyChat(historyModel(
            attachmentIds: ["owner-a-receipt"],
            pendingId: pendingA.pendingId,
            reconciledPendingIds: [pendingA.pendingId]
        ))
        await acknowledgements.waitForCount(1)
        await eventually { viewModel.pendingAttachments.map { $0.id } == [attachmentB.id] }

        #expect(viewModel.attachmentTransfers[attachmentB.id] != nil)
        #expect(viewModel.attachmentTransfers[attachmentA.id] == nil)
    }

    @Test func failedReceiptAcknowledgmentIsRetryableAndSuccessfulRetryCleansOptimisticState() async throws {
        let session = previewSession()
        defer { session.close() }
        let acknowledgements = ReceiptAcknowledgements(outcomes: [.failure, .acknowledged])
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            activateOnInit: false,
            observeChatOnInit: false,
            acknowledgeReceipt: { pendingId, sessionId in
                try await acknowledgements.acknowledge(pendingId: pendingId, sessionId: sessionId)
            }
        )
        let model = historyModel(
            attachmentIds: ["retry-attachment"],
            pendingId: "retry",
            reconciledPendingIds: ["retry"]
        )

        viewModel.applyChat(model)
        await acknowledgements.waitForCount(2)

        #expect(await acknowledgements.count == 2)
        #expect(viewModel.pendingAttachments.isEmpty)
        #expect(viewModel.attachmentTransfers.isEmpty)
    }

    @Test func exhaustedReceiptAcknowledgmentWaitsForExplicitRetry() async throws {
        let session = previewSession()
        defer { session.close() }
        let acknowledgements = ReceiptAcknowledgements(
            outcomes: [.failure, .failure, .failure, .acknowledged]
        )
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            activateOnInit: false,
            observeChatOnInit: false,
            acknowledgeReceipt: { pendingId, sessionId in
                try await acknowledgements.acknowledge(pendingId: pendingId, sessionId: sessionId)
            }
        )
        let model = historyModel(
            attachmentIds: ["exhausted-attachment"],
            pendingId: "exhausted",
            reconciledPendingIds: ["exhausted"]
        )

        viewModel.applyChat(model)
        await acknowledgements.waitForCount(3)
        await eventually { viewModel.receiptAcknowledgmentFailures.contains("exhausted") }

        // Current model remains unchanged; ordinary chat ticks must not retry exhaustion.
        viewModel.applyChat(model)
        viewModel.applyChat(model)
        await Task.yield()
        #expect(await acknowledgements.count == 3)

        viewModel.retryReceiptAcknowledgments()
        await acknowledgements.waitForCount(4)
        await eventually { !viewModel.receiptAcknowledgmentFailures.contains("exhausted") }
        #expect(await acknowledgements.count == 4)
    }

    @Test func suspendedReceiptCompletionCannotResurrectDeletedRoute() async throws {
        let session = previewSession()
        defer { session.close() }
        let drafts = try #require(session.component.drafts)
        let draft = try #require(try await drafts.saveText(
            draftId: nil, sessionId: "history-session", text: "pending"
        ))
        let pending = try await drafts.beginSend(
            draftId: draft.id, mintKey: "fenced-mint", surfaceId: "fenced-surface"
        )
        let acknowledgements = SuspendedReceiptAcknowledgement(sessionId: "history-session", draftId: draft.id)
        var routeChanges = 0
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            draftId: draft.id,
            activateOnInit: false,
            observeChatOnInit: false,
            onDraftRouteChanged: { _, _, _ in routeChanges += 1 },
            acknowledgeReceipt: { pendingId, sessionId in
                try await acknowledgements.acknowledge(pendingId: pendingId, sessionId: sessionId)
            }
        )
        let model = historyModel(
            attachmentIds: ["fenced-attachment"],
            pendingId: pending.pendingId,
            reconciledPendingIds: [pending.pendingId]
        )

        viewModel.applyChat(model)
        await acknowledgements.waitForCall()
        viewModel.applySessionChange(SessionsChangeEvent.Deleted(sessionId: "history-session"))
        await acknowledgements.release()
        await acknowledgements.waitForReturn()

        #expect(routeChanges == 0)
        #expect(viewModel.receiptAcknowledgmentFailures.isEmpty)
    }

    @Test func receiptCompletionFencesOutboundRouteGenerationChange() async throws {
        let session = previewSession()
        defer { session.close() }
        let initialCache = createOutboundCache()
        session.component.bindChatRoute(
            cache: initialCache,
            sessionId: "history-session",
            draftId: nil,
            activate: true
        )
        let acknowledgements = SuspendedReceiptAcknowledgement(sessionId: "history-session", draftId: nil)
        var routeChanges = 0
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            activateOnInit: false,
            observeChatOnInit: false,
            onDraftRouteChanged: { _, _, _ in routeChanges += 1 },
            acknowledgeReceipt: { pendingId, sessionId in
                try await acknowledgements.acknowledge(pendingId: pendingId, sessionId: sessionId)
            }
        )
        let model = historyModel(
            attachmentIds: ["generation-attachment"],
            pendingId: "generation-pending",
            reconciledPendingIds: ["generation-pending"]
        )

        viewModel.applyChat(model)
        await acknowledgements.waitForCall()
        session.component.bindChatRoute(
            cache: createOutboundCache(),
            sessionId: "changed-session",
            draftId: nil,
            activate: true
        )
        await acknowledgements.release()
        await acknowledgements.waitForReturn()

        #expect(routeChanges == 0)
        #expect(viewModel.receiptAcknowledgmentFailures.isEmpty)
    }

    @Test func cancellingOneAttachmentSettlesSiblingUploadsForSameSend() async throws {
        let session = previewSession()
        defer { session.close() }
        let (pending, first, second, sourceA, sourceB) = try await pendingWithTwoAttachments(session)
        defer {
            try? FileManager.default.removeItem(at: sourceA)
            try? FileManager.default.removeItem(at: sourceB)
        }
        let upload = SuspendedPendingUpload()
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            draftId: pending.draftId,
            activateOnInit: false,
            observeChatOnInit: false,
            uploadPendingAttachments: { _, _, _ in try await upload.run() }
        )

        await upload.waitForCall()
        #expect(viewModel.attachmentTransfers[first.id]?.phase == .uploading)
        #expect(viewModel.attachmentTransfers[second.id]?.phase == .uploading)

        viewModel.cancelAttachmentUpload(first.id)
        await upload.release()
        await upload.waitForReturn()
        await eventually {
            viewModel.attachmentTransfers[first.id]?.phase == .cancelled &&
                viewModel.attachmentTransfers[second.id]?.phase == .cancelled
        }

        #expect(viewModel.pendingAttachments.map(\.id) == [first.id, second.id])
    }

    @Test func deletedRouteClearsPendingUploadPresentationBeforeStaleTaskReturns() async throws {
        let session = previewSession()
        defer { session.close() }
        let (pending, first, second, sourceA, sourceB) = try await pendingWithTwoAttachments(session)
        defer {
            try? FileManager.default.removeItem(at: sourceA)
            try? FileManager.default.removeItem(at: sourceB)
        }
        let upload = SuspendedPendingUpload()
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            draftId: pending.draftId,
            activateOnInit: false,
            observeChatOnInit: false,
            uploadPendingAttachments: { _, _, _ in try await upload.run() }
        )

        await upload.waitForCall()
        #expect(viewModel.attachmentTransfers[first.id]?.phase == .uploading)
        #expect(viewModel.attachmentTransfers[second.id]?.phase == .uploading)

        viewModel.applySessionChange(SessionsChangeEvent.Deleted(sessionId: "history-session"))
        #expect(viewModel.pendingAttachments.isEmpty)
        #expect(viewModel.attachmentTransfers.isEmpty)

        await upload.release()
        await upload.waitForReturn()
        await Task.yield()
        #expect(viewModel.pendingAttachments.isEmpty)
        #expect(viewModel.attachmentTransfers.isEmpty)
    }

    @Test func cancelledSendReleasesPinnedPreviewOwnership() async throws {
        let session = previewSession()
        defer { session.close() }
        let drafts = try #require(session.component.drafts)
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            activateOnInit: false,
            observeChatOnInit: false,
            previewAttachment: { _ in self.previewPNG() },
            cancelPendingSend: { pending in
                guard let restored = try await drafts.notCommitted(pendingId: pending.pendingId) else {
                    throw CocoaError(.fileNoSuchFile)
                }
                return restored
            }
        )
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("cancel-preview-\(UUID().uuidString).png")
        try previewPNG().write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let draft = try #require(try await drafts.saveText(
            draftId: nil, sessionId: "history-session", text: "pending"
        ))
        let imported = try await drafts.importAttachment(
            draftId: draft.id,
            sessionId: "history-session",
            source: NativeDraftAttachmentImport(
                sourceLocation: source.absoluteString,
                displayName: source.lastPathComponent,
                mediaType: "image/png",
                previewSourceLocation: nil
            )
        )
        let attachment = try #require(imported.attachments.first)
        let pending = try await drafts.beginSend(
            draftId: imported.id, mintKey: "cancel-mint", surfaceId: "cancel-surface"
        )
        let image = await loadAndPin(
            viewModel, id: "cancel-preview", pendingId: pending.pendingId
        )

        viewModel.editPendingAttachment(attachment.id)
        await eventually { viewModel.pinnedAttachmentPreviewCount == 0 }
        viewModel.applyChat(historyModel(attachmentIds: []))

        await eventually { image.image == nil }
    }

    @Test func deletedSessionClearsPinnedPreviewOwnership() async {
        let session = previewSession()
        defer { session.close() }
        let viewModel = previewViewModel(session)
        let image = await loadAndPin(
            viewModel, id: "delete-preview", pendingId: "delete-pending"
        )

        viewModel.applySessionChange(SessionsChangeEvent.Deleted(sessionId: "history-session"))

        #expect(viewModel.pinnedAttachmentPreviewCount == 0)
        #expect(viewModel.attachmentPreviews.isEmpty)
        await eventually { image.image == nil }
    }

    private func previewViewModel(_ session: IosUserSession) -> ChatViewModel {
        ChatViewModel(
            component: session.component,
            sessionId: "history-session",
            activateOnInit: false,
            observeChatOnInit: false,
            previewAttachment: { _ in self.previewPNG() }
        )
    }

    private func loadAndPin(
        _ viewModel: ChatViewModel,
        id: String,
        pendingId: String
    ) async -> WeakImageReference {
        viewModel.applyChat(historyModel(attachmentIds: [id]))
        viewModel.setVisibleAttachmentPreviewIds([id])
        await eventually { viewModel.attachmentPreviews[id] != nil }
        let image = WeakImageReference(viewModel.attachmentPreviews[id]!)
        viewModel.pinAttachmentPreviews([id], for: pendingId)
        #expect(viewModel.pinnedAttachmentPreviewCount == 1)
        viewModel.setVisibleAttachmentPreviewIds([])
        return image
    }

    private func historyModel(
        attachmentIds: [String],
        liveContent: String? = nil,
        pendingId: String? = nil,
        reconciledPendingIds: Set<String> = []
    ) -> ChatModel {
        ChatModel(
            committed: attachmentIds.enumerated().map { index, id in
                ChatMessage(
                    ts: Int64(index + 1), role: "user", content: "",
                    streaming: false, cutoffKind: nil, turnId: nil,
                    replyId: nil, pendingId: pendingId, sessionId: "history-session",
                    entryId: "entry-\(index)",
                    attachments: [reference(id, name: "photo-\(index).png", size: Int64(largePreviewPNG().count))]
                )
            },
            live: liveContent.map {
                ChatMessage(
                    ts: 100, role: "assistant", content: $0,
                    streaming: true, cutoffKind: nil, turnId: "live-turn",
                    replyId: "live-reply", pendingId: nil, sessionId: "history-session",
                    entryId: "live-entry", attachments: []
                )
            },
            tasks: [],
            pending: [],
            historyLoading: false,
            reconciledPendingIds: reconciledPendingIds
        )
    }

    private func attachment(_ id: String, name: String, size: Int64) -> NativeDraftAttachment {
        NativeDraftAttachment(
            id: id,
            displayName: name,
            mediaType: "image/png",
            sizeBytes: size,
            localPath: "/protected/\(id)"
        )
    }

    private func reference(_ id: String, name: String, size: Int64) -> AttachmentRef {
        AttachmentRef(
            attachmentId: id,
            displayName: name,
            contentType: "image/png",
            mediaKind: "image",
            size: size
        )
    }

    private func previewPNG() -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 8, height: 6)).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 6))
        }.pngData()!
    }

    private func largePreviewPNG() -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 1_200, height: 900)).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1_200, height: 900))
        }.pngData()!
    }

    private func pendingWithTwoAttachments(
        _ session: IosUserSession
    ) async throws -> (NativePendingSend, NativeDraftAttachment, NativeDraftAttachment, URL, URL) {
        let drafts = try #require(session.component.drafts)
        let sourceA = FileManager.default.temporaryDirectory
            .appendingPathComponent("pending-a-\(UUID().uuidString).txt")
        let sourceB = FileManager.default.temporaryDirectory
            .appendingPathComponent("pending-b-\(UUID().uuidString).txt")
        try Data("one".utf8).write(to: sourceA)
        try Data("two".utf8).write(to: sourceB)
        let draft = try #require(try await drafts.saveText(
            draftId: nil, sessionId: "history-session", text: "pending"
        ))
        let importedA = try await drafts.importAttachment(
            draftId: draft.id,
            sessionId: draft.sessionId,
            source: NativeDraftAttachmentImport(
                sourceLocation: sourceA.absoluteString,
                displayName: sourceA.lastPathComponent,
                mediaType: "text/plain",
                previewSourceLocation: nil
            )
        )
        let importedB = try await drafts.importAttachment(
            draftId: importedA.id,
            sessionId: importedA.sessionId,
            source: NativeDraftAttachmentImport(
                sourceLocation: sourceB.absoluteString,
                displayName: sourceB.lastPathComponent,
                mediaType: "text/plain",
                previewSourceLocation: nil
            )
        )
        let pending = try await drafts.beginSend(
            draftId: importedB.id,
            mintKey: "pending-upload-mint",
            surfaceId: "pending-upload-surface"
        )
        let attachments = try #require(pending.attachments.count == 2 ? pending.attachments : nil)
        return (pending, attachments[0], attachments[1], sourceA, sourceB)
    }

    private func previewSession() -> IosUserSession {
        createUserSession(
            gatewayWsUrl: "ws://127.0.0.1:9/api/v1/ws",
            allowSelfSignedDevHost: false,
            authenticatedUserId: "sent-preview-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
    }

    private func eventually(_ condition: @escaping @MainActor () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(3)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        #expect(condition())
    }
}

private final class WeakImageReference {
    weak var image: UIImage?
    init(_ image: UIImage) { self.image = image }
}

private struct PreviewUnavailable503: Error {}

private actor PreviewRequests {
    private let result: Data
    private(set) var ids: [String] = []
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    init(result: Data) { self.result = result }

    func load(_ id: String) throws -> Data {
        ids.append(id)
        let attempt = ids.count
        let ready = waiters.filter { $0.0 <= attempt }
        waiters.removeAll { $0.0 <= attempt }
        ready.forEach { $0.1.resume() }
        if attempt == 1 { throw PreviewUnavailable503() }
        return result
    }

    func waitForAttempt(_ attempt: Int) async {
        guard ids.count < attempt else { return }
        await withCheckedContinuation { waiters.append((attempt, $0)) }
    }
}

private actor ReceiptAcknowledgements {
    enum Outcome {
        case acknowledged
        case missing
        case failure
    }

    private var outcomes: [Outcome]
    private(set) var count = 0
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    init(outcomes: [Outcome]) { self.outcomes = outcomes }

    func acknowledge(
        pendingId _: String,
        sessionId: String
    ) throws -> NativeSendReconciliationResult {
        count += 1
        let ready = waiters.filter { $0.0 <= count }
        waiters.removeAll { $0.0 <= count }
        ready.forEach { $0.1.resume() }
        let outcome = outcomes.isEmpty ? .acknowledged : outcomes.removeFirst()
        switch outcome {
        case .acknowledged:
            return NativeSendReconciliationResult(
                found: true, draftId: nil, sessionId: sessionId, restoredDraft: nil
            )
        case .missing:
            return NativeSendReconciliationResult(
                found: false, draftId: nil, sessionId: nil, restoredDraft: nil
            )
        case .failure:
            throw ReceiptAcknowledgementFailure()
        }
    }

    func waitForCount(_ target: Int) async {
        guard count < target else { return }
        await withCheckedContinuation { waiters.append((target, $0)) }
    }
}

private struct ReceiptAcknowledgementFailure: Error {}

private actor SuspendedReceiptAcknowledgement {
    private let sessionId: String
    private let draftId: String?
    private var callWaiter: CheckedContinuation<Void, Never>?
    private var releaseWaiter: CheckedContinuation<Void, Never>?
    private var returnWaiter: CheckedContinuation<Void, Never>?
    private var called = false
    private var returned = false

    init(sessionId: String, draftId: String?) {
        self.sessionId = sessionId
        self.draftId = draftId
    }

    func acknowledge(
        pendingId _: String,
        sessionId _: String
    ) async throws -> NativeSendReconciliationResult {
        called = true
        callWaiter?.resume()
        callWaiter = nil
        await withCheckedContinuation { releaseWaiter = $0 }
        returned = true
        returnWaiter?.resume()
        returnWaiter = nil
        return NativeSendReconciliationResult(
            found: true, draftId: draftId, sessionId: sessionId, restoredDraft: nil
        )
    }

    func waitForCall() async {
        guard !called else { return }
        await withCheckedContinuation { callWaiter = $0 }
    }

    func release() {
        releaseWaiter?.resume()
        releaseWaiter = nil
    }

    func waitForReturn() async {
        guard !returned else { return }
        await withCheckedContinuation { returnWaiter = $0 }
    }
}

private actor SuspendedPendingUpload {
    private var callWaiter: CheckedContinuation<Void, Never>?
    private var releaseWaiter: CheckedContinuation<Void, Never>?
    private var returnWaiter: CheckedContinuation<Void, Never>?
    private var called = false
    private var returned = false

    func run() async throws -> [AttachmentRef] {
        called = true
        callWaiter?.resume()
        callWaiter = nil
        await withCheckedContinuation { releaseWaiter = $0 }
        defer {
            returned = true
            returnWaiter?.resume()
            returnWaiter = nil
        }
        try Task.checkCancellation()
        return []
    }

    func waitForCall() async {
        guard !called else { return }
        await withCheckedContinuation { callWaiter = $0 }
    }

    func release() {
        releaseWaiter?.resume()
        releaseWaiter = nil
    }

    func waitForReturn() async {
        guard returned else {
            await withCheckedContinuation { returnWaiter = $0 }
            return
        }
    }
}

private actor ControlledPreviewRequests {
    private let result: Data
    private var ids: [String] = []
    private var active = 0
    private(set) var peak = 0
    private var pending: [CheckedContinuation<Data, Never>] = []
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    init(result: Data) { self.result = result }

    var requestCount: Int { ids.count }

    func count(for id: String) -> Int { ids.count(where: { $0 == id }) }
    func counts(for requestedIds: [String]) -> [String: Int] {
        Dictionary(uniqueKeysWithValues: requestedIds.map { id in
            (id, ids.count(where: { $0 == id }))
        })
    }

    func load(_ id: String) async throws -> Data {
        ids.append(id)
        active += 1
        peak = max(peak, active)
        let ready = waiters.filter { $0.0 <= ids.count }
        waiters.removeAll { $0.0 <= ids.count }
        ready.forEach { $0.1.resume() }
        let data = await withCheckedContinuation { pending.append($0) }
        active -= 1
        return data
    }

    func resolvePending() {
        let continuations = pending
        pending.removeAll()
        continuations.forEach { $0.resume(returning: result) }
    }

    func waitForRequestCount(_ count: Int) async {
        guard ids.count < count else { return }
        await withCheckedContinuation { waiters.append((count, $0)) }
    }
}
