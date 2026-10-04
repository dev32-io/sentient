import MobileData
import XCTest
@testable import SentientApp

/// Native projection/receipt/editor composition, not proof of authorized upload scheduling.
final class QueuedSendReceiptCompositionTests: XCTestCase {
    @MainActor
    func testHeldReceiptPreservesNextDraftAndRetirementFencesSuccessorEditor() async throws {
        for retireBeforeReceipt in [false, true] {
            let session = createUserSession(
                gatewayWsUrl: "wss://test.invalid/api/v1/ws", allowSelfSignedDevHost: false,
                authenticatedUserId: "queued-receipt-\(UUID().uuidString)",
                capabilities: [], devFaultsEnabled: false, onLoggedOut: {}
            )
            defer { session.close() }
            let drafts = try XCTUnwrap(session.component.drafts)
            let source = FileManager.default.temporaryDirectory.appendingPathComponent("queued-\(UUID().uuidString).txt")
            try Data("fixture".utf8).write(to: source)
            defer { try? FileManager.default.removeItem(at: source) }
            var draftID: String?
            var pending: [NativePendingSend] = []
            // Real atomic coordinator acceptance supplies durable native inputs.
            // VM send()/READY/ACK/upload are intentionally NOT simulated here.
            for text in ["A", "B", "C"] {
                let saved = try await drafts.saveText(draftId: draftID, sessionId: "receipt-session", text: text)
                var draft = try XCTUnwrap(saved)
                if text == "A" {
                    draft = try await drafts.importAttachment(
                        draftId: draft.id, sessionId: draft.sessionId,
                        source: NativeDraftAttachmentImport(sourceLocation: source.absoluteString,
                            displayName: "fixture.txt", mediaType: "text/plain", previewSourceLocation: nil)
                    )
                }
                draftID = draft.id
                pending.append(try await drafts.acceptSend(
                    draftId: draft.id, expectedRevision: draft.revision,
                    mintKey: "receipt-session", surfaceId: "native-fixture"
                ))
            }
            let entered = expectation(description: "receipt held before durable reconciliation")
            let returned = expectation(description: "durable reconciliation returned")
            let published = retireBeforeReceipt ? nil : expectation(description: "current editor receives route association")
            var release: CheckedContinuation<Void, Never>?
            var routePublications = 0
            var uploads = 0
            let vm = ChatViewModel(
                component: session.component, sessionId: "receipt-session", draftId: draftID,
                activateOnInit: false, observeChatOnInit: false,
                uploadPendingAttachments: { _, _, _ in uploads += 1; return [] },
                onDraftRouteChanged: { _, _, _ in routePublications += 1; published?.fulfill() },
                acknowledgeReceipt: { id, sessionID in
                    await withCheckedContinuation { release = $0; entered.fulfill() }
                    let result = try await drafts.acknowledge(pendingId: id, sessionId: sessionID)
                    returned.fulfill()
                    return result
                }
            )
            defer { vm.retireEditor() }
            vm.updateDraft("next draft")
            let saved = await vm.saveDraftBeforeNavigation()
            XCTAssertTrue(saved)
            XCTAssertEqual(vm.pendingMessages.map(\.id), pending.map(\.pendingId))
            XCTAssertEqual(vm.draftText, "next draft")
            XCTAssertTrue(vm.draftAttachments.isEmpty)
            let file = try XCTUnwrap(pending[0].attachments.first)
            XCTAssertEqual(vm.pendingAttachmentPresentations[pending[0].pendingId]?.transfers[file.id]?.phase, .queued)
            XCTAssertEqual(uploads, 0, "Disconnected/unacknowledged route must not start delivery")

            let receipt = ChatMessage(
                ts: 1, role: "user", content: "A", streaming: false, cutoffKind: nil,
                turnId: nil, replyId: nil, pendingId: pending[0].pendingId,
                sessionId: "receipt-session", entryId: "receipt-A", attachments: []
            )
            vm.applyChat(ChatModel(
                committed: [receipt], live: nil, tasks: [], pending: [], historyLoading: false,
                reconciledPendingIds: [pending[0].pendingId]
            ))
            await fulfillment(of: [entered], timeout: 2)
            XCTAssertEqual(drafts.snapshot.value.pendingSends.count, 3)
            vm.updateDraft("newer next draft")
            let nextSaved = await vm.saveDraftBeforeNavigation()
            XCTAssertTrue(nextSaved)
            if retireBeforeReceipt {
                vm.retireEditor()
                vm.retireEditor()
                _ = try await drafts.saveText(draftId: draftID, sessionId: "receipt-session", text: "successor draft")
                vm.updateDraft("stale writer")
                vm.flushDraft()
            }
            release?.resume()
            await fulfillment(of: [returned], timeout: 2)
            if let published { await fulfillment(of: [published], timeout: 2) }
            // Read through coordinator after real receipt transaction, not a fake result.
            let snapshot = try await drafts.restore()
            XCTAssertEqual(snapshot.pendingSends.map(\.pendingId), pending.dropFirst().map(\.pendingId))
            XCTAssertEqual(snapshot.drafts.first { $0.id == draftID }?.text,
                           retireBeforeReceipt ? "successor draft" : "newer next draft")
            XCTAssertEqual(vm.draftText, "newer next draft")
            XCTAssertEqual(routePublications, retireBeforeReceipt ? 0 : 1)
            XCTAssertEqual(uploads, 0)
            XCTAssertFalse(snapshot.pendingSends.contains { $0.attempted })
        }
    }
}
