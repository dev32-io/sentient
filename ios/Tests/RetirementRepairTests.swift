import Combine
import Foundation
import MobileData
import XCTest
@testable import SentientApp

@MainActor
final class RetirementRepairTests: XCTestCase {
    private func assertSaved(_ vm: ChatViewModel, file: StaticString = #filePath, line: UInt = #line) async {
        let saved = await vm.saveDraftBeforeNavigation()
        XCTAssertTrue(saved, file: file, line: line)
    }

    func testFreshUnsentEditorRestoresAfterDestinationAckAndFailedOrSupersededPreparation() async throws {
        for supersede in [false, true] {
            try await withNativeSendFixture { fixture in
                let original = "d_11111111111111111111111111111111"
                let restored = "d_22222222222222222222222222222222"
                let lifetime = HostRouteLifetime()
                let held = XCTestExpectation(description: "destination acknowledged, preparation held")
                var release: CheckedContinuation<Void, Never>?
                var interrupt = false
                let vm = ChatViewModel(component: fixture.component, sessionId: nil,
                    saveDraftText: { id, session, text in
                        if interrupt {
                            interrupt = false
                            if supersede {
                                await withCheckedContinuation { release = $0; held.fulfill() }
                            } else { throw CocoaError(.fileWriteOutOfSpace) }
                        }
                        return try await fixture.drafts.saveText(draftId: id, sessionId: session, text: text)
                    })
                defer { vm.retireEditor(); lifetime.retire() }
                try await fixture.acknowledgeDraft(draftKey: original)
                let sibling = createOutboundCache()
                fixture.component.bindChatRoute(cache: sibling, sessionId: original, draftId: nil, activate: false)
                sibling.enqueue(id: "stale-sibling", text: "synthetic", attachmentIds: [])
                let oldGeneration = fixture.component.outboundRouteGeneration.value
                let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
                try Data("synthetic attachment".utf8).write(to: source)
                defer { try? FileManager.default.removeItem(at: source) }
                vm.updateDraft("retained unsent text")
                vm.importAttachments([.file(source)])
                try await sendEventually("fresh editor imported file") { vm.draftAttachments.count == 1 }
                await assertSaved(vm)
                let files = vm.draftAttachments.map(\.id)
                XCTAssertNil(fixture.drafts.snapshot.value.drafts.first?.sessionId)
                XCTAssertTrue(fixture.drafts.snapshot.value.pendingSends.isEmpty)
                lifetime.installEditor(saveAndRetire: { await vm.saveAndRetireEditor(isCurrent: $0) },
                    suspendRoute: { vm.suspendRouteForActivation() },
                    restoreRoute: { vm.restoreRouteAfterActivation() }, retire: { vm.retireEditor() })
                var mixed = false
                let projection = vm.$state.sink { state in
                    if state.model.committed.contains(where: { $0.pendingId == "destination-only" }) { mixed = true }
                }
                defer { projection.cancel() }
                vm.updateDraft("latest retained text")
                let intent = lifetime.begin()!
                lifetime.suspendEditorRoute(intent)
                let activation = Task { try await fixture.component.activateSession.invoke(sessionId: "other-session") }
                try await fixture.acknowledgeRoute(sessionId: "other-session")
                _ = try await activation.value
                try await fixture.receipt(pendingId: "destination-only", sessionId: "other-session")
                interrupt = true
                let preparation = Task { await lifetime.prepareReplacement(intent) }
                if supersede {
                    await fulfillment(of: [held], timeout: 3)
                    _ = lifetime.begin() // Settings keeps same editor and restores suspended route.
                    release?.resume()
                }
                let replaced = await preparation.value
                XCTAssertFalse(replaced)
                if !supersede { lifetime.restoreEditorRoute(intent) }
                try await sendEventually("restore emitted route command") {
                    let fresh = try await fixture.freshRequestCount()
                    let activations = try await fixture.activatedSessionIds()
                    return fresh.intValue == 2 || activations.contains(original)
                }
                let activations = try await fixture.activatedSessionIds()
                XCTAssertFalse(activations.contains(original), "draft identity must never become conversation.activate")
                let fresh = try await fixture.freshRequestCount()
                guard fresh.intValue == 2 else { XCTFail("restoration must request fresh draft handshake"); return }
                XCTAssertNotEqual(fixture.component.outboundRouteGeneration.value, oldGeneration)
                XCTAssertNil(fixture.component.outboundSessionId.value)
                XCTAssertEqual(vm.draftText, "latest retained text")
                XCTAssertEqual(vm.draftAttachments.map(\.id), files)
                XCTAssertFalse(mixed)
                XCTAssertTrue(lifetime.hasEditor)
                vm.send(vm.draftText)
                XCTAssertTrue(vm.preparingSend)
                await Task.yield()
                XCTAssertTrue(fixture.drafts.snapshot.value.pendingSends.isEmpty)
                let beforeAck = try await fixture.sentPendingIds()
                XCTAssertTrue(beforeAck.isEmpty)
                try await fixture.acknowledgeDraft(draftKey: restored)
                try await sendEventually("fresh handshake accepts file send") {
                    let uploaded = try await fixture.uploadedFileIds()
                    return !vm.preparingSend && fixture.drafts.snapshot.value.pendingSends.count == 1 && uploaded.count == 1
                }
                let pending = try XCTUnwrap(fixture.drafts.snapshot.value.pendingSends.first)
                XCTAssertNil(pending.sessionId)
                XCTAssertEqual(pending.mintKey, restored)
                XCTAssertEqual(pending.surfaceId, "fixture-device")
                XCTAssertEqual(pending.attachments.map(\.id), files)
                try await fixture.releaseUpload(index: 0, success: true)
                try await sendEventually("first send dispatches under fresh authority") {
                    try await fixture.sentPendingIds() == [pending.pendingId]
                }
                let firstSendStamps = try await fixture.sentSessionIds()
                XCTAssertTrue(firstSendStamps.isEmpty, "first send must mint, not borrow B's session stamp")
                fixture.component.flushOutbound(cache: sibling)
                try await fixture.mint(sessionId: "minted-session")
                fixture.component.flushOutbound(cache: sibling)
                try await fixture.receipt(pendingId: pending.pendingId, sessionId: "minted-session")
                try await sendEventually("fresh receipt commits original editor") {
                    fixture.drafts.snapshot.value.pendingSends.isEmpty &&
                        vm.state.model.committed.contains { $0.pendingId == pending.pendingId }
                }
                XCTAssertEqual(fixture.drafts.snapshot.value.drafts.first?.sessionId, "minted-session")
                let sent = try await fixture.sentPendingIds()
                XCTAssertEqual(sent, [pending.pendingId])
                XCTAssertFalse(mixed)
                XCTAssertTrue(lifetime.hasEditor)
            }
        }
    }

    func testNilNativeSessionRestoresSessionMintedBeforeNativeReceipt() async throws {
        try await withNativeSendFixture { fixture in
            let vm = ChatViewModel(component: fixture.component, sessionId: nil)
            defer { vm.retireEditor() }
            try await fixture.acknowledgeDraft(draftKey: "d_33333333333333333333333333333333")
            // Another sender on this same route mints before native editor receives a durable receipt.
            let sender = createOutboundCache()
            fixture.component.bindChatRoute(cache: sender,
                sessionId: "d_33333333333333333333333333333333", draftId: nil, activate: false)
            sender.enqueue(id: "mint-input", text: "synthetic", attachmentIds: [])
            fixture.component.flushOutbound(cache: sender)
            try await sendEventually("SDK starts mint while native route remains nil") {
                try await fixture.sentPendingIds() == ["mint-input"]
            }
            try await fixture.mint(sessionId: "minted-before-native")
            vm.updateDraft("unsent successor")
            await assertSaved(vm)
            XCTAssertNil(fixture.drafts.snapshot.value.drafts.first?.sessionId)
            XCTAssertTrue(fixture.drafts.snapshot.value.pendingSends.isEmpty)
            vm.suspendRouteForActivation()
            let activation = Task { try await fixture.component.activateSession.invoke(sessionId: "other-session") }
            try await fixture.acknowledgeRoute(sessionId: "other-session")
            _ = try await activation.value
            vm.restoreRouteAfterActivation()
            try await fixture.acknowledgeRoute(sessionId: "minted-before-native")
            let fresh = try await fixture.freshRequestCount()
            XCTAssertEqual(fresh.intValue, 1, "minted route must not be replaced by another fresh chat")
            XCTAssertEqual(fixture.component.currentSessionId.value, "minted-before-native")
            XCTAssertEqual(vm.draftText, "unsent successor")
            vm.send(vm.draftText)
            try await sendEventually("nil-native editor sends through restored minted route") {
                try await fixture.sentPendingIds().count == 2
            }
            let sessions = try await fixture.sentSessionIds()
            XCTAssertEqual(sessions.last, "minted-before-native")
        }
    }

    func testNotificationSavesLatestEditsAcrossActivationAndSaveForSameAndDifferentRoute() async throws {
        for destinationId in ["history-session", "other-session"] {
            try await withNativeSendFixture { fixture in
                let lifetime = HostRouteLifetime()
                let controller = NotificationResumeController()
                let saving = expectation(description: "B save held")
                let activated = expectation(description: "real activation acknowledged, return held")
                var releaseActivation: CheckedContinuation<Void, Never>?
                let routed = expectation(description: "route opened after durable C")
                var release: CheckedContinuation<Void, Never>?
                var hold = true
                let vm = ChatViewModel(component: fixture.component, sessionId: "history-session",
                    saveDraftText: { id, session, text in
                        if hold && text == "B" {
                            hold = false
                            await withCheckedContinuation { release = $0; saving.fulfill() }
                        }
                        return try await fixture.drafts.saveText(draftId: id, sessionId: session, text: text)
                    })
                defer { vm.retireEditor(); controller.cancel(); lifetime.retire() }
                try await fixture.acknowledgeRoute(sessionId: "history-session")
                vm.updateDraft("A")
                await assertSaved(vm)
                lifetime.installEditor(saveAndRetire: { current in
                    await vm.saveAndRetireEditor(isCurrent: current)
                }, suspendRoute: { vm.suspendRouteForActivation() },
                   restoreRoute: { vm.restoreRouteAfterActivation() }, retire: { vm.retireEditor() })
                let intent = lifetime.begin()!
                lifetime.suspendEditorRoute(intent)
                var clears = 0
                controller.resume(NotificationDestination(sessionId: destinationId)!, accountFence: "fixture",
                    activate: { id in
                        do {
                            let result = try await fixture.component.activateSession.invoke(sessionId: id)
                            await withCheckedContinuation { releaseActivation = $0; activated.fulfill() }
                            return result == .authorized ? .authorized : .retryableFailure
                        } catch { return .retryableFailure }
                    }, route: { _ in routed.fulfill() },
                    prepareRoute: { await lifetime.prepareReplacement(intent) },
                    clear: { _ in clears += 1; return true },
                    isCurrent: { lifetime.accepts(intent) })
                if destinationId != "history-session" { try await fixture.acknowledgeRoute(sessionId: destinationId) }
                await fulfillment(of: [activated], timeout: 3)
                // Edit during awaited activation return, then during persistence; no timer wait.
                vm.updateDraft("B")
                releaseActivation?.resume()
                await fulfillment(of: [saving], timeout: 3)
                vm.updateDraft("C")
                release?.resume()
                await fulfillment(of: [routed], timeout: 3)
                XCTAssertEqual(fixture.drafts.snapshot.value.drafts.first { $0.sessionId == "history-session" }?.text, "C")
                XCTAssertEqual(clears, 1)
                let successor = ChatViewModel(component: fixture.component, sessionId: destinationId, activateOnInit: false)
                defer { successor.retireEditor() }
                successor.updateDraft("successor")
                await assertSaved(successor)
                vm.updateDraft("stale")
                vm.flushDraft()
                XCTAssertEqual(fixture.drafts.snapshot.value.drafts.first { $0.sessionId == destinationId }?.text, "successor")
                if destinationId != "history-session" {
                    XCTAssertEqual(fixture.drafts.snapshot.value.drafts.first { $0.sessionId == "history-session" }?.text, "C")
                }
            }
        }
    }

    func testFailedReplacementRestoresOriginalSDKAuthorityAndProjectionForSameAndDifferentRoute() async throws {
        for destinationId in ["history-session", "other-session"] {
            try await withNativeSendFixture { fixture in
                let lifetime = HostRouteLifetime()
                let controller = NotificationResumeController()
                var fail = false
                let vm = ChatViewModel(component: fixture.component, sessionId: "history-session",
                    saveDraftText: { id, session, text in
                        if fail { throw CocoaError(.fileWriteOutOfSpace) }
                        return try await fixture.drafts.saveText(draftId: id, sessionId: session, text: text)
                    })
                defer { vm.retireEditor(); controller.cancel(); lifetime.retire() }
                try await fixture.acknowledgeRoute(sessionId: "history-session")
                try await fixture.receipt(pendingId: "original-snapshot", sessionId: "history-session")
                try await sendEventually("original timeline") {
                    vm.state.model.committed.contains { $0.pendingId == "original-snapshot" }
                }
                vm.updateDraft("A")
                await assertSaved(vm)
                lifetime.installEditor(
                    saveAndRetire: { await vm.saveAndRetireEditor(isCurrent: $0) },
                    suspendRoute: { vm.suspendRouteForActivation() },
                    restoreRoute: { vm.restoreRouteAfterActivation() },
                    retire: { vm.retireEditor() })
                vm.updateDraft("B")
                fail = true
                let originalGeneration = fixture.component.outboundRouteGeneration.value
                let intent = lifetime.begin()!
                lifetime.suspendEditorRoute(intent)
                let destination = NotificationDestination(sessionId: destinationId)!
                let failed = expectation(description: "replacement failed without clearing card")
                let observer = controller.$state.first { $0 == .retryableFailure(destination) }.sink { _ in failed.fulfill() }
                var mixedProjection = false
                let projection = vm.$state.sink { state in
                    if state.model.committed.contains(where: { $0.pendingId == "destination-only" }) { mixedProjection = true }
                }
                var nativeSession = "history-session"
                var clears = 0
                controller.resume(destination, accountFence: "fixture",
                    activate: { id in
                        do {
                            let result = try await fixture.component.activateSession.invoke(sessionId: id)
                            if id != "history-session" {
                                try await fixture.receipt(pendingId: "destination-only", sessionId: id)
                                await Task.yield()
                            }
                            // Retained editor must not borrow B's mint/generation while local save waits.
                            vm.send("must remain local")
                            return result == .authorized ? .authorized : .retryableFailure
                        } catch { return .retryableFailure }
                    }, route: { nativeSession = $0; XCTFail("failed save opened route") },
                    prepareRoute: { await lifetime.prepareReplacement(intent) },
                    clear: { _ in clears += 1; return true },
                    isCurrent: { lifetime.accepts(intent) },
                    activationAbandoned: { lifetime.restoreEditorRoute(intent) })
                if destinationId != "history-session" {
                    try await fixture.acknowledgeRoute(sessionId: destinationId)
                    try await fixture.acknowledgeRoute(sessionId: "history-session")
                }
                await fulfillment(of: [failed], timeout: 3)
                observer.cancel()
                XCTAssertNotNil(vm.draftSaveError)
                XCTAssertTrue(lifetime.hasEditor)
                XCTAssertEqual(nativeSession, "history-session")
                XCTAssertEqual(fixture.component.currentSessionId.value, nativeSession)
                XCTAssertEqual(fixture.component.outboundSessionId.value, nativeSession)
                XCTAssertNotEqual(fixture.component.outboundRouteGeneration.value, originalGeneration)
                XCTAssertTrue(fixture.drafts.snapshot.value.pendingSends.isEmpty)
                XCTAssertFalse(vm.routeActivationSuspended)
                fail = false
                vm.updateDraft("C")
                await assertSaved(vm)
                XCTAssertEqual(fixture.drafts.snapshot.value.drafts.first?.text, "C")
                vm.send("C")
                try await sendEventually("original editor accepts after rollback") {
                    !vm.preparingSend && fixture.drafts.snapshot.value.pendingSends.count == 1
                }
                let pending = try XCTUnwrap(fixture.drafts.snapshot.value.pendingSends.first)
                XCTAssertEqual(pending.sessionId, nativeSession)
                try await sendEventually("retained cache sends under reclaimed generation") {
                    try await fixture.sentPendingIds() == [pending.pendingId]
                }
                let sentSessions = try await fixture.sentSessionIds()
                XCTAssertEqual(sentSessions, [nativeSession])
                try await fixture.receipt(pendingId: pending.pendingId, sessionId: nativeSession)
                try await sendEventually("original projection and durable receipt resume") {
                    fixture.drafts.snapshot.value.pendingSends.isEmpty &&
                        vm.state.model.committed.contains { $0.pendingId == pending.pendingId }
                }
                XCTAssertFalse(mixedProjection)
                XCTAssertEqual(clears, 0)
                XCTAssertEqual(controller.state, .retryableFailure(destination))
                projection.cancel()
            }
        }
    }

    func testRejectedActivationRetainsWorkingEditorAndRestoresItsRoute() async throws {
        try await withNativeSendFixture { fixture in
            let lifetime = HostRouteLifetime()
            let controller = NotificationResumeController()
            let vm = ChatViewModel(component: fixture.component, sessionId: "history-session")
            defer { vm.retireEditor(); controller.cancel(); lifetime.retire() }
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            vm.updateDraft("keep on rejection")
            await assertSaved(vm)
            lifetime.installEditor(saveAndRetire: { await vm.saveAndRetireEditor(isCurrent: $0) },
                suspendRoute: { vm.suspendRouteForActivation() },
                restoreRoute: { vm.restoreRouteAfterActivation() }, retire: { vm.retireEditor() })
            let intent = lifetime.begin()!
            lifetime.suspendEditorRoute(intent)
            let destination = NotificationDestination(sessionId: "missing-session")!
            controller.resume(destination, accountFence: "fixture",
                activate: { id in
                    do {
                        let result = try await fixture.component.activateSession.invoke(sessionId: id)
                        return result == .authorized ? .authorized : .unavailable
                    } catch { return .retryableFailure }
                }, route: { _ in XCTFail("rejected destination opened") },
                prepareRoute: { XCTFail("rejection must not retire editor"); return await lifetime.prepareReplacement(intent) },
                clear: { _ in XCTFail("rejected card cleared"); return true },
                isCurrent: { lifetime.accepts(intent) },
                activationAbandoned: { lifetime.restoreEditorRoute(intent) })
            try await fixture.rejectRoute(sessionId: "missing-session")
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            try await sendEventually("unavailable route restored") { controller.state == .unavailable(destination) }
            XCTAssertTrue(lifetime.hasEditor)
            XCTAssertEqual(vm.draftText, "keep on rejection")
            vm.updateDraft("typing after rejection")
            vm.send("typing after rejection")
            try await sendEventually("rejected activation preserves original delivery") {
                try await fixture.sentSessionIds() == ["history-session"]
            }
            XCTAssertEqual(fixture.component.currentSessionId.value, "history-session")
            XCTAssertEqual(fixture.component.outboundSessionId.value, "history-session")
        }
    }

    func testSupersededHeldReplacementSaveDoesNotRetireSettingsEditor() async throws {
        try await withNativeSendFixture { fixture in
            let lifetime = HostRouteLifetime()
            let started = expectation(description: "save suspended")
            var release: CheckedContinuation<Void, Never>?
            var hold = false
            let vm = ChatViewModel(component: fixture.component, sessionId: "history-session",
                saveDraftText: { id, session, text in
                    if hold {
                        hold = false
                        await withCheckedContinuation { release = $0; started.fulfill() }
                    }
                    return try await fixture.drafts.saveText(draftId: id, sessionId: session, text: text)
                })
            defer { vm.retireEditor(); lifetime.retire() }
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            vm.updateDraft("B")
            lifetime.installEditor(saveAndRetire: { await vm.saveAndRetireEditor(isCurrent: $0) },
                suspendRoute: { vm.suspendRouteForActivation() },
                restoreRoute: { vm.restoreRouteAfterActivation() }, retire: { vm.retireEditor() })
            hold = true
            let intent = lifetime.begin()!
            lifetime.suspendEditorRoute(intent)
            let activating = Task { try await fixture.component.activateSession.invoke(sessionId: "other-session") }
            try await fixture.acknowledgeRoute(sessionId: "other-session")
            _ = try await activating.value
            let work = Task { await lifetime.prepareReplacement(intent) }
            await fulfillment(of: [started], timeout: 3)
            _ = lifetime.begin() // Settings supersedes notification; same editor survives.
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            vm.updateDraft("C")
            release?.resume()
            let replaced = await work.value
            XCTAssertFalse(replaced)
            XCTAssertTrue(lifetime.hasEditor)
            vm.flushDraft() // Incidental disappearance remains a save, not retirement.
            await assertSaved(vm)
            XCTAssertEqual(fixture.drafts.snapshot.value.drafts.first?.text, "C")
            XCTAssertEqual(fixture.component.currentSessionId.value, "history-session")
            XCTAssertEqual(fixture.component.outboundSessionId.value, "history-session")
            vm.send("C")
            try await sendEventually("keeper editor sends after superseded preparation") {
                try await fixture.sentSessionIds() == ["history-session"]
            }
        }
    }

    func testHeldPreparationCannotContaminateDurableSuccessorOrFrozenSendAndCleansOnlyOwnedFiles() async throws {
        try await withNativeSendFixture { fixture in
            let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
            let converted = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
            try Data("borrowed".utf8).write(to: source)
            defer { try? FileManager.default.removeItem(at: source); try? FileManager.default.removeItem(at: converted) }
            let prior = try await acceptFixtureFile(fixture, text: "accepted before retirement")
            try await fixture.drafts.markAttempted(pendingId: prior.pendingId)
            let acceptedRelativePath = try XCTUnwrap(prior.attachments.first?.localPath)
            let acceptedPath = URL(fileURLWithPath: IosNativeDraftDatabaseDriverFactory().databasePath())
                .deletingLastPathComponent().appendingPathComponent(acceptedRelativePath).path
            XCTAssertTrue(FileManager.default.fileExists(atPath: acceptedPath))
            let prepared = expectation(description: "preparation suspended")
            let settled = expectation(description: "cancelled import settled")
            var release: CheckedContinuation<Void, Never>?
            let old = ChatViewModel(component: fixture.component, sessionId: "history-session",
                prepareDraftAttachment: { _ in
                    await withCheckedContinuation { release = $0; prepared.fulfill() }
                    try Data("converted".utf8).write(to: converted)
                    return .temporary(converted, mediaType: "text/plain")
                })
            defer { old.retireEditor() }
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            old.updateDraft("A")
            await assertSaved(old)
            old.importAttachments([.file(source)])
            await fulfillment(of: [prepared], timeout: 3)
            let observer = old.$pendingAttachmentImportCount.first { $0 == 0 }.sink { _ in settled.fulfill() }
            old.retireEditor()
            let successor = ChatViewModel(component: fixture.component, sessionId: "history-session")
            defer { successor.retireEditor() }
            successor.updateDraft("B")
            await assertSaved(successor)
            release?.resume()
            await fulfillment(of: [settled], timeout: 3)
            observer.cancel()
            XCTAssertFalse(FileManager.default.fileExists(atPath: converted.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
            XCTAssertTrue(fixture.drafts.snapshot.value.drafts.first?.attachments.isEmpty == true)
            let accepted = expectation(description: "successor send accepted")
            let sendObserver = successor.$preparingSend.dropFirst().first { !$0 }.sink { _ in accepted.fulfill() }
            successor.send("B")
            await fulfillment(of: [accepted], timeout: 3)
            sendObserver.cancel()
            let pending = try XCTUnwrap(fixture.drafts.snapshot.value.pendingSends.last)
            XCTAssertEqual(pending.text, "B")
            XCTAssertTrue(pending.attachments.isEmpty)
            XCTAssertEqual(fixture.drafts.snapshot.value.pendingSends.first?.pendingId, prior.pendingId)
            XCTAssertTrue(FileManager.default.fileExists(atPath: acceptedPath))
        }
    }

    func testMutexDelayedOldImportCannotBorrowSuccessorRevision() async throws {
        try await withNativeSendFixture { fixture in
            let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
            try Data("borrowed".utf8).write(to: source)
            defer { try? FileManager.default.removeItem(at: source) }
            let old = ChatViewModel(component: fixture.component, sessionId: "history-session")
            defer { old.retireEditor() }
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            old.updateDraft("A")
            await assertSaved(old)
            let draft = try XCTUnwrap(fixture.drafts.snapshot.value.drafts.first)
            old.retireEditor()
            let rejected = try await fixture.retireMutexDelayedImport(draftId: draft.id,
                source: NativeDraftAttachmentImport(sourceLocation: source.absoluteString,
                    displayName: "late.txt", mediaType: "text/plain", previewSourceLocation: nil))
            XCTAssertTrue(rejected.boolValue)
            XCTAssertEqual(fixture.drafts.snapshot.value.drafts.first?.text, "B")
            XCTAssertTrue(fixture.drafts.snapshot.value.drafts.first?.attachments.isEmpty == true)
            let successor = ChatViewModel(component: fixture.component, sessionId: "history-session")
            defer { successor.retireEditor() }
            successor.updateDraft("B")
            await assertSaved(successor)
            let accepted = expectation(description: "successor accepted")
            let observer = successor.$preparingSend.dropFirst().first { !$0 }.sink { _ in accepted.fulfill() }
            successor.send("B")
            await fulfillment(of: [accepted], timeout: 3)
            observer.cancel()
            let pending = try XCTUnwrap(fixture.drafts.snapshot.value.pendingSends.first)
            XCTAssertEqual(pending.text, "B")
            XCTAssertTrue(pending.attachments.isEmpty)
            XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
        }
    }

    func testAcceptedAKeepsSuccessorOnlySaveFailureVisibleAndBEditable() async throws {
        try await withNativeSendFixture { fixture in
            let saving = expectation(description: "A persistence held")
            let accepted = expectation(description: "acceptance completed")
            var release: CheckedContinuation<Void, Never>?
            var hold = false
            let vm = ChatViewModel(component: fixture.component, sessionId: "history-session",
                saveDraftText: { id, session, text in
                    if text == "B" { throw CocoaError(.fileWriteOutOfSpace) }
                    if hold && text == "A" {
                        hold = false
                        await withCheckedContinuation { release = $0; saving.fulfill() }
                    }
                    return try await fixture.drafts.saveText(draftId: id, sessionId: session, text: text)
                })
            defer { vm.retireEditor() }
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            vm.updateDraft("A")
            await assertSaved(vm)
            hold = true
            let observer = vm.$preparingSend.dropFirst().first { !$0 }.sink { _ in accepted.fulfill() }
            vm.send("A")
            await fulfillment(of: [saving], timeout: 3)
            vm.updateDraft("B")
            release?.resume()
            await fulfillment(of: [accepted], timeout: 3)
            observer.cancel()
            XCTAssertEqual(fixture.drafts.snapshot.value.pendingSends.map(\.text), ["A"])
            XCTAssertEqual(vm.draftText, "B")
            XCTAssertEqual(vm.draftSaveError, "Draft couldn't be saved. Keep this screen open and retry.")
            vm.updateDraft("C")
            await assertSaved(vm)
            XCTAssertEqual(fixture.drafts.snapshot.value.drafts.first?.text, "C")
            XCTAssertEqual(fixture.drafts.snapshot.value.pendingSends.map(\.text), ["A"])
        }
    }
}
