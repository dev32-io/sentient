import Foundation
import MobileData
import Testing
@testable import SentientApp

@MainActor
struct NativeQueuedSendIntegrationTests {
    @Test func actualSendABCWaitsForUploadAndEachReceiptPreservingNextEditor() async throws {
        try await withNativeSendFixture { fixture in
            let vm = ChatViewModel(component: fixture.component, sessionId: "history-session")
            defer { vm.retireEditor() }
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            try await importFiles(vm, count: 1)
            let a = try await send(vm, fixture: fixture, text: "A", count: 1)
            try await sendEventually("A held upload") { try await fixture.uploadedFileIds().count == 1 }
            let b = try await send(vm, fixture: fixture, text: "B", count: 2)
            let c = try await send(vm, fixture: fixture, text: "C", count: 3)
            vm.updateDraft("next editor")
            #expect(await vm.saveDraftBeforeNavigation())
            #expect(vm.draftAttachments.isEmpty)
            #expect(vm.pendingMessages.map(\.id) == [a, b, c])
            #expect(try await fixture.sentPendingIds().isEmpty)
            try await fixture.releaseUpload(index: 0, success: true)
            try await sendEventually("A dispatched, no receipt") { try await fixture.sentPendingIds() == [a] }
            #expect(fixture.drafts.snapshot.value.pendingSends.map(\.pendingId) == [a, b, c])
            #expect(vm.pendingMessages.map(\.id) == [a, b, c])
            // Wrong-session receipt cannot release strict head.
            try await fixture.receipt(pendingId: a, sessionId: "other-session")
            #expect(try await fixture.sentPendingIds() == [a])
            try await fixture.receipt(pendingId: a, sessionId: "history-session")
            try await sendEventually("B only after A receipt") { try await fixture.sentPendingIds() == [a, b] }
            #expect(fixture.drafts.snapshot.value.pendingSends.map(\.pendingId) == [b, c])
            try await fixture.receipt(pendingId: b, sessionId: "history-session")
            try await sendEventually("C only after B receipt") { try await fixture.sentPendingIds() == [a, b, c] }
            try await fixture.receipt(pendingId: c, sessionId: "history-session")
            try await sendEventually("all receipts durable") { fixture.drafts.snapshot.value.pendingSends.isEmpty }
            #expect(vm.draftText == "next editor")
            #expect(fixture.drafts.snapshot.value.drafts.first?.text == "next editor")
            #expect(vm.state.model.committed.map { "send-\($0.pendingId ?? "")" } == ["send-\(a)", "send-\(b)", "send-\(c)"])
        }
    }

    @Test func partialUploadFailureBlocksHeadAndRetryKeepsFileAndPendingIdentities() async throws {
        try await withNativeSendFixture { fixture in
            let vm = ChatViewModel(component: fixture.component, sessionId: "history-session")
            defer { vm.retireEditor() }
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            try await importFiles(vm, count: 2)
            let a = try await send(vm, fixture: fixture, text: "A", count: 1)
            let files = try #require(fixture.drafts.snapshot.value.pendingSends.first).attachments.map(\.id)
            try await sendEventually("first file request") { try await fixture.uploadedFileIds().count == 1 }
            let b = try await send(vm, fixture: fixture, text: "B", count: 2)
            let c = try await send(vm, fixture: fixture, text: "C", count: 3)
            vm.updateDraft("keep me")
            try await fixture.releaseUpload(index: 0, success: true)
            try await sendEventually("second file request") { try await fixture.uploadedFileIds().count == 2 }
            try await fixture.releaseUpload(index: 1, success: false)
            try await sendEventually("partial response facts") {
                vm.attachmentTransfers[files[0]]?.phase == .ready && vm.attachmentTransfers[files[1]]?.phase == .failed
            }
            #expect(try await fixture.sentPendingIds().isEmpty)
            #expect(vm.pendingMessages.map(\.id) == [a, b, c])
            #expect(vm.draftText == "keep me")
            vm.retry(a)
            try await sendEventually("whole-message retry first file") { try await fixture.uploadedFileIds().count == 3 }
            try await fixture.releaseUpload(index: 2, success: true)
            try await sendEventually("whole-message retry second file") { try await fixture.uploadedFileIds().count == 4 }
            try await fixture.releaseUpload(index: 3, success: true)
            try await sendEventually("retried A dispatched") { try await fixture.sentPendingIds() == [a] }
            #expect(try await fixture.uploadedFileIds() == files + files)
            try await fixture.receipt(pendingId: a, sessionId: "history-session")
            try await sendEventually("B released after retry receipt") { try await fixture.sentPendingIds() == [a, b] }
            try await fixture.receipt(pendingId: b, sessionId: "history-session")
            try await sendEventually("C released after receipt") { try await fixture.sentPendingIds() == [a, b, c] }
            #expect(vm.draftText == "keep me")
        }
    }

    @Test(arguments: [false, true])
    func offRouteHeldUploadCannotSendAndSameSessionSuccessorKeepsItsEditor(retireBeforeCompletion: Bool) async throws {
        try await withNativeSendFixture { fixture in
            let old = ChatViewModel(component: fixture.component, sessionId: "history-session")
            defer { old.retireEditor() }
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            try await importFiles(old, count: 1)
            let a = try await send(old, fixture: fixture, text: "A", count: 1)
            try await sendEventually("old upload") { try await fixture.uploadedFileIds().count == 1 }
            let b = try await send(old, fixture: fixture, text: "B", count: 2)
            let c = try await send(old, fixture: fixture, text: "C", count: 3)
            if retireBeforeCompletion { old.retireEditor(); old.retireEditor() }
            let away = ChatViewModel(component: fixture.component, sessionId: "other-session")
            defer { away.retireEditor() }
            try await fixture.acknowledgeRoute(sessionId: "other-session")
            try await fixture.releaseUpload(index: 0, success: true)
            if !retireBeforeCompletion {
                let file = try #require(fixture.drafts.snapshot.value.pendingSends.first?.attachments.first)
                try await sendEventually("off-route upload response") { old.attachmentTransfers[file.id]?.phase == .ready }
            }
            #expect(try await fixture.sentPendingIds().isEmpty)
            #expect(fixture.drafts.snapshot.value.pendingSends.dropFirst().allSatisfy { !$0.attempted })
            old.retireEditor()
            away.retireEditor()
            let successor = ChatViewModel(component: fixture.component, sessionId: "history-session")
            defer { successor.retireEditor() }
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            successor.updateDraft("successor editor")
            #expect(await successor.saveDraftBeforeNavigation())
            old.updateDraft("stale writer")
            old.flushDraft()
            #expect(successor.pendingMessages.map(\.id) == [a, b, c])
            #expect(try await fixture.sentPendingIds().isEmpty)
            successor.retry(a) // attempted head remains blocked until explicit retry
            try await sendEventually("successor retry") { try await fixture.uploadedFileIds().count == 2 }
            try await fixture.releaseUpload(index: 1, success: true)
            try await sendEventually("successor A dispatched") { try await fixture.sentPendingIds() == [a] }
            try await fixture.receipt(pendingId: a, sessionId: "history-session")
            try await sendEventually("successor B after receipt") { try await fixture.sentPendingIds() == [a, b] }
            #expect(successor.draftText == "successor editor")
            #expect(fixture.drafts.snapshot.value.drafts.first { $0.sessionId == "history-session" }?.text == "successor editor")
        }
    }

    @Test(arguments: [false, true])
    func heldDurableReceiptBlocksNextHeadAndCannotOverwriteSuccessor(retire: Bool) async throws {
        try await withNativeSendFixture { fixture in
            var receiptEntered = false
            var releaseReceipt = false
            var receiptReturned = false
            let acknowledge: (String, String) async throws -> NativeSendReconciliationResult = { pendingId, sessionId in
                receiptEntered = true
                try await sendEventually("held durable acknowledgment release") { releaseReceipt }
                // Model an issued durable operation whose completion does not cooperate with
                // retiring the awaiting VM. Real coordinator still owns reconciliation.
                let operation = Task { @MainActor in
                    try await fixture.drafts.acknowledge(pendingId: pendingId, sessionId: sessionId)
                }
                let result = try await operation.value
                receiptReturned = true
                return result
            }
            let old = ChatViewModel(component: fixture.component, sessionId: "history-session",
                acknowledgeReceipt: acknowledge)
            defer { old.retireEditor() }
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            try await importFiles(old, count: 1)
            let a = try await send(old, fixture: fixture, text: "A", count: 1)
            try await sendEventually("held receipt upload") { try await fixture.uploadedFileIds().count == 1 }
            let b = try await send(old, fixture: fixture, text: "B", count: 2)
            let c = try await send(old, fixture: fixture, text: "C", count: 3)
            try await fixture.releaseUpload(index: 0, success: true)
            try await sendEventually("receipt A dispatched") { try await fixture.sentPendingIds() == [a] }
            try await fixture.receipt(pendingId: a, sessionId: "history-session")
            try await sendEventually("durable acknowledgment entered") { receiptEntered }
            #expect(fixture.drafts.snapshot.value.pendingSends.map(\.pendingId) == [a, b, c])
            #expect(try await fixture.sentPendingIds() == [a])
            var editor = old
            if retire {
                old.retireEditor()
                editor = ChatViewModel(component: fixture.component, sessionId: "history-session",
                    acknowledgeReceipt: acknowledge)
                // Same selected session reuses SDK's genuine acknowledged route; no new switch.
                #expect(fixture.component.acknowledgedRoute.value?.sessionId == "history-session")
            }
            defer { editor.retireEditor() }
            editor.updateDraft("receipt-era editor")
            #expect(await editor.saveDraftBeforeNavigation())
            releaseReceipt = true
            try await sendEventually("durable acknowledgment returned") { receiptReturned }
            try await sendEventually("B after durable acknowledgment") { try await fixture.sentPendingIds() == [a, b] }
            #expect(fixture.drafts.snapshot.value.pendingSends.map(\.pendingId) == [b, c])
            #expect(editor.draftText == "receipt-era editor")
            #expect(fixture.drafts.snapshot.value.drafts.first?.text == "receipt-era editor")
        }
    }

    private func importFiles(_ vm: ChatViewModel, count: Int) async throws {
        let files = try (0..<count).map { index in
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).txt")
            try Data("fixture-\(index)".utf8).write(to: url)
            return AttachmentImportItem.temporary(url, displayName: "fixture-\(index).txt", mediaType: "text/plain")
        }
        vm.importAttachments(files)
        try await sendEventually("native import") { vm.draftAttachments.count == count && vm.pendingAttachmentImportCount == 0 }
    }

    private func send(_ vm: ChatViewModel, fixture: NativeSendBridgeFixture, text: String, count: Int) async throws -> String {
        vm.updateDraft(text)
        vm.send(text)
        try await sendEventually("atomic native acceptance \(text)") {
            !vm.preparingSend && fixture.drafts.snapshot.value.pendingSends.count == count && vm.draftText.isEmpty
        }
        return try #require(fixture.drafts.snapshot.value.pendingSends.last).pendingId
    }
}
