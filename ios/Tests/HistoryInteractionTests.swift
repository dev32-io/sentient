import Foundation
import MobileData
import XCTest
@testable import SentientApp

final class HistoryInteractionTests: XCTestCase {
    private func row(_ id: String, _ title: String) -> SessionRow {
        SessionRow(
            sessionId: id,
            rootId: nil,
            title: title,
            startedAt: 0,
            lastActiveAt: 0,
            messageCount: 0,
            isActive: false
        )
    }

    private func draft(_ id: String, sessionId: String?) -> NativeDraft {
        NativeDraft(
            id: id,
            sessionId: sessionId,
            text: "offline edit",
            attachments: [],
            revision: 1,
            createdAt: 10,
            updatedAt: 20
        )
    }

    func testSearchIsTrimmedCaseInsensitiveAndCanProduceNoMatch() {
        let rows = [row("one", "Morning Briefing"), row("two", "Kyoto plans")]
        XCTAssertEqual(historySessions(rows, matching: "  briefing ").map(\.sessionId), ["one"])
        XCTAssertEqual(historySessions(rows, matching: "KYOTO").map(\.sessionId), ["two"])
        XCTAssertTrue(historySessions(rows, matching: "missing").isEmpty)
        XCTAssertEqual(historySessions(rows, matching: "  ").count, 2)
    }

    func testHistorySelectionRequiresMatchingNonNilSessionOrDraftIdentity() {
        let session = HistoryEntry(
            kind: .session(id: "session-a", draftId: nil),
            title: "Conversation",
            lastActiveAt: 0,
            hasDraft: false
        )
        let draft = HistoryEntry(
            kind: .draft(id: "draft-a"),
            title: "Offline edit",
            lastActiveAt: 0,
            hasDraft: true
        )

        XCTAssertTrue(historyEntryIsSelected(session, activeSessionId: "session-a", activeDraftId: nil))
        XCTAssertTrue(historyEntryIsSelected(draft, activeSessionId: nil, activeDraftId: "draft-a"))
        XCTAssertFalse(historyEntryIsSelected(session, activeSessionId: nil, activeDraftId: nil))
        XCTAssertFalse(historyEntryIsSelected(draft, activeSessionId: nil, activeDraftId: nil))
    }

    func testAssociatedDraftKeepsConversationIdentityAndExplicitActionsOffline() {
        let associated = draft("draft-a", sessionId: "session-a")
        let offline = historyEntries(sessions: [], drafts: [associated], deleting: [], matching: "").first!
        let online = historyEntries(
            sessions: [row("session-a", "Conversation")], drafts: [associated], deleting: [], matching: ""
        ).first!

        XCTAssertEqual(offline.id, "session-a")
        XCTAssertEqual(online.id, offline.id)
        XCTAssertEqual(offline.sessionId, "session-a")
        XCTAssertEqual(offline.draftId, "draft-a")
        XCTAssertEqual(
            offline.destructiveActions,
            [.deleteConversation(sessionId: "session-a"), .discardDraft(draftId: "draft-a")]
        )
        XCTAssertEqual(online.destructiveActions, offline.destructiveActions)

        let deleting = NativeDeleteIntent(sessionId: "session-a", createdAt: 1, updatedAt: 1, failureCode: nil)
        XCTAssertTrue(historyEntries(sessions: [], drafts: [associated], deleting: [deleting], matching: "").isEmpty)
    }

    func testDiscardNavigationRequiresSuccessfulExplicitDraftTarget() {
        XCTAssertFalse(shouldNavigateAfterDiscard(succeeded: false, draftId: "draft-a", activeDraftId: "draft-a"))
        XCTAssertFalse(shouldNavigateAfterDiscard(succeeded: true, draftId: "draft-a", activeDraftId: "draft-b"))
        XCTAssertTrue(shouldNavigateAfterDiscard(succeeded: true, draftId: "draft-a", activeDraftId: "draft-a"))
        XCTAssertNotEqual(
            HistoryDestructiveAction.deleteConversation(sessionId: "session-a"),
            .discardDraft(draftId: "draft-a")
        )
    }

    func testAttachmentDismissUsesCancellationOnlyDuringActiveUpload() {
        XCTAssertEqual(
            composerAttachmentDismissAction(for: AttachmentTransferState(phase: .uploading)),
            .cancel
        )
        XCTAssertEqual(composerAttachmentDismissAction(for: AttachmentTransferState(phase: .ready)), .remove)
        XCTAssertEqual(composerAttachmentDismissAction(for: AttachmentTransferState(phase: .failed)), .remove)
        XCTAssertEqual(composerAttachmentDismissAction(for: AttachmentTransferState(phase: .cancelled)), .remove)
        XCTAssertEqual(composerAttachmentDismissAction(for: nil), .remove)
    }

    func testUploadFailureChangesOnlyActiveTransfersAndLateProgressCannotReviveThem() {
        let transfers = failingActiveUploads([
            "active": AttachmentTransferState(phase: .uploading, progress: 0.5),
            "ready": AttachmentTransferState(phase: .ready, progress: 1),
        ])
        let failed = AttachmentTransferState(phase: .failed)

        XCTAssertEqual(transfers["active"], failed)
        XCTAssertEqual(transfers["ready"], AttachmentTransferState(phase: .ready, progress: 1))
        XCTAssertEqual(applyingUploadProgress(to: transfers["active"], sent: 78, total: 78), failed)
        XCTAssertEqual(
            applyingUploadProgress(to: AttachmentTransferState(phase: .uploading), sent: 39, total: 78),
            AttachmentTransferState(phase: .uploading, progress: 0.5)
        )
    }

    func testDrawerPositionAndFlingSettling() {
        XCTAssertTrue(DrawerSettlingDecision.shouldOpen(fraction: 0.6, velocityX: 0))
        XCTAssertFalse(DrawerSettlingDecision.shouldOpen(fraction: 0.4, velocityX: 0))
        XCTAssertTrue(DrawerSettlingDecision.shouldOpen(fraction: 0.1, velocityX: 500))
        XCTAssertFalse(DrawerSettlingDecision.shouldOpen(fraction: 0.9, velocityX: -500))
    }

    func testSearchUsesFoundationTargetAndSemanticBodyType() {
        XCTAssertGreaterThanOrEqual(HistorySurfaceLayout.searchMinimumHeight, 44)
        XCTAssertEqual(HistorySurfaceLayout.searchTextRole.baseSize, DesignV2.Typography.body)
        XCTAssertGreaterThanOrEqual(HistorySurfaceLayout.searchTextRole.baseSize, 15)
    }

    @MainActor
    func testDurableDraftSaveFailureKeepsRouteAndRearmsNavigation() async {
        let session = createUserSession(
            gatewayWsUrl: "wss://test.invalid/api/v1/ws",
            allowSelfSignedDevHost: false,
            authenticatedUserId: "draft-save-failure-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        var saveAttempts = 0
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "existing-session",
            activateOnInit: false,
            saveDraftText: { _, _, _ in
                saveAttempts += 1
                throw CocoaError(.fileWriteOutOfSpace)
            }
        )
        var state = RouteChangeState()
        var navigations = 0

        XCTAssertTrue(state.begin())
        if state.finish(saved: await viewModel.saveDraftBeforeNavigation()) { navigations += 1 }

        XCTAssertEqual(saveAttempts, 1)
        XCTAssertEqual(viewModel.draftSaveError, "Draft couldn't be saved. Keep this screen open and retry.")
        XCTAssertEqual(navigations, 0)
        XCTAssertFalse(state.pending)
        XCTAssertTrue(state.begin(), "failed save must allow retry")
    }

    @MainActor
    func testOfflineSendAnchorFailureExportsTypedNonCancellationError() async {
        let session = createUserSession(
            gatewayWsUrl: "wss://test.invalid/api/v1/ws",
            allowSelfSignedDevHost: false,
            authenticatedUserId: "draft-anchor-typed-error-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }

        do {
            _ = try await session.component.awaitDraftSendAnchor(expectedGeneration: nil)
            XCTFail("offline route unexpectedly produced an anchor")
        } catch is CancellationError {
            XCTFail("anchor failure must not be exported as cancellation")
        } catch {
            XCTAssertFalse(error is CancellationError)
            XCTAssertTrue(
                (error as NSError).kotlinException is NativeSendAnchorUnavailableException,
                "SKIE must preserve typed non-cancellation anchor failure"
            )
        }
    }

    @MainActor
    func testOfflineSendSurfacesErrorAndDurableSaveContinues() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://test.invalid/api/v1/ws",
            allowSelfSignedDevHost: false,
            authenticatedUserId: "draft-anchor-send-error-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        var saves = 0
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "offline-session",
            activateOnInit: false,
            observeChatOnInit: false,
            saveDraftText: { draftId, sessionId, text in
                saves += 1
                return NativeDraft(
                    id: draftId ?? "offline-draft",
                    sessionId: sessionId,
                    text: text,
                    attachments: [],
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1
                )
            }
        )

        viewModel.send("offline message")
        for _ in 0..<100 where viewModel.draftSaveError == nil {
            await Task.yield()
        }

        XCTAssertEqual(saves, 1)
        XCTAssertEqual(viewModel.draftSaveError, "Message is saved locally but couldn't be sent yet.")
        XCTAssertTrue(viewModel.draftText.isEmpty)
        viewModel.updateDraft("after failed send")
        let savedAfterFailure = await viewModel.saveDraftBeforeNavigation()
        XCTAssertTrue(savedAfterFailure)
    }

    func testDraftReceiptUpdatesOnlyMatchingHostRouteWithoutRecreatingComposer() {
        var route = ChatRouteSelection()
        route.selectDraft("pending-draft", sessionId: nil)
        let activeIdentity = route.viewIdentity

        route.reconcileDraft(from: "stale-draft", to: "stale-draft", sessionId: "wrong-session")
        XCTAssertEqual(route.draftId, "pending-draft")
        XCTAssertNil(route.sessionId)

        route.reconcileDraft(from: "pending-draft", to: "pending-draft", sessionId: "accepted-session")
        XCTAssertEqual(route.draftId, "pending-draft")
        XCTAssertEqual(route.sessionId, "accepted-session")
        XCTAssertEqual(route.viewIdentity, activeIdentity, "receipt association must preserve VM composer state")

        route.selectDraft("other-draft", sessionId: nil)
        route.reconcileDraft(from: "pending-draft", to: "pending-draft", sessionId: "accepted-session")
        XCTAssertEqual(route.draftId, "other-draft", "late receipt must not retarget another route")
        XCTAssertNil(route.sessionId)
    }

    func testThawedDraftIdentityChangeRecreatesRouteAndKeepsConversationTarget() {
        var route = ChatRouteSelection()
        route.selectDraft("pending-draft", sessionId: "existing-session")
        let activeIdentity = route.viewIdentity

        route.reconcileDraft(from: "pending-draft", to: "restored-draft", sessionId: "existing-session")
        XCTAssertEqual(route.draftId, "restored-draft")
        XCTAssertEqual(route.sessionId, "existing-session")
        XCTAssertNotEqual(route.viewIdentity, activeIdentity)
    }

    func testPopulatedRefreshStaysContentOnlyUntilFailure() {
        XCTAssertEqual(
            historyListPresentation(rowCount: 2, loading: true, hasLoaded: true, hasError: false),
            .content
        )
        XCTAssertEqual(
            historyListPresentation(rowCount: 2, loading: false, hasLoaded: true, hasError: true),
            .staleContent
        )
        XCTAssertEqual(
            historyListPresentation(rowCount: 0, loading: true, hasLoaded: false, hasError: false),
            .loading
        )
    }
}
