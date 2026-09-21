import AVFoundation
import ImageIO
import MobileData
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import SentientApp

@MainActor
struct AttachmentSourceTests {
    @Test func cameraAccessRequestsOnlyAfterAvailableUndeterminedChoice() async {
        let unavailable = CameraAccessStub(available: false, status: .notDetermined)
        #expect(await cameraAccessDecision(using: unavailable) == .unavailable)
        #expect(unavailable.requestCount == 0)

        let denied = CameraAccessStub(available: true, status: .denied)
        #expect(await cameraAccessDecision(using: denied) == .denied)
        #expect(denied.requestCount == 0)

        let restricted = CameraAccessStub(available: true, status: .restricted)
        #expect(await cameraAccessDecision(using: restricted) == .restricted)
        #expect(restricted.requestCount == 0)

        let requested = CameraAccessStub(available: true, status: .notDetermined, requestResult: true)
        #expect(await cameraAccessDecision(using: requested) == .present)
        #expect(requested.requestCount == 1)
    }

    @Test func securityScopeSurvivesAsyncCopyAndReleasesOnEveryExit() async throws {
        var events: [String] = []
        let started = AsyncGate()
        let release = AsyncGate()
        let task = Task {
            try await withAttachmentSecurityScope(
                URL(fileURLWithPath: "/scope/fixture"),
                start: { _ in
                    events.append("start")
                    return true
                },
                stop: { _ in events.append("stop") },
                operation: {
                    events.append("metadata")
                    await started.open()
                    await release.wait()
                    events.append("copy")
                    return true
                }
            )
        }

        await started.wait()
        #expect(events == ["start", "metadata"])
        await release.open()
        #expect(try await task.value)
        #expect(events == ["start", "metadata", "copy", "stop"])

        for cancellation in [false, true] {
            events = []
            do {
                _ = try await withAttachmentSecurityScope(
                    URL(fileURLWithPath: "/scope/fixture"),
                    start: { _ in
                        events.append("start")
                        return true
                    },
                    stop: { _ in events.append("stop") },
                    operation: {
                        events.append("metadata")
                        if cancellation { throw CancellationError() }
                        throw AttachmentScopeTestError.failed
                    }
                )
            } catch {}
            #expect(events == ["start", "metadata", "stop"])
        }

        var stoppedWithoutScope = false
        _ = try await withAttachmentSecurityScope(
            URL(fileURLWithPath: "/app-owned/fixture"),
            start: { _ in false },
            stop: { _ in stoppedWithoutScope = true },
            operation: { true }
        )
        #expect(!stoppedWithoutScope)
    }

    @Test func filePickerCancellationIsNotReportedAsImportFailure() {
        #expect(isUserCancelledAttachmentImport(CocoaError(.userCancelled)))
        #expect(isUserCancelledAttachmentImport(CancellationError()))
        #expect(isUserCancelledAttachmentImport(URLError(.cancelled)))
        #expect(!isUserCancelledAttachmentImport(CocoaError(.fileReadUnknown)))
    }

    @Test func failureClassifierUsesOnlyAllowlistedReasons() {
        #expect(
            attachmentImportFailureReason(for: CocoaError(.fileReadUnsupportedScheme)) == .unsupportedType
        )
        #expect(
            attachmentImportFailureReason(for: CocoaError(.fileReadTooLarge)) == .sourceTooLarge
        )
        #expect(
            attachmentImportFailureReason(for: URLError(.timedOut)) == .timeout
        )
        #expect(
            attachmentImportFailureReason(for: NSError(
                domain: NSItemProvider.errorDomain,
                code: NSItemProvider.ErrorCode.itemUnavailableError.rawValue,
                userInfo: [NSLocalizedDescriptionKey: "picker-private-name"]
            )) == .sourceMissing
        )
        #expect(
            attachmentImportFailureReason(for: NSError(
                domain: "untrusted.domain",
                code: 42,
                userInfo: [NSLocalizedDescriptionKey: "user content"]
            )) == .unknown
        )
        #expect(
            attachmentImportFailureReason(for: AttachmentImportPickerIssue.cameraDenied) == .denied
        )
    }

    @Test func nativeDraftStorageFailureMapsToAllowlistedReason() {
        #expect(
            attachmentImportFailureReason(forKotlinException: IosNativeDraftStorageException()) ==
                .storageUnavailable
        )
    }

    @Test func unidentifiedAttachmentRecoveryRequiresKnownBaseline() {
        let unrelated = NativeDraft(
            id: "unrelated-draft",
            sessionId: nil,
            text: "unrelated",
            attachments: [],
            revision: 1,
            createdAt: 1,
            updatedAt: 1
        )

        #expect(
            attachmentImportRecoveryDraft(
                drafts: [unrelated],
                committedDraftId: nil,
                routeDraftId: nil,
                routeSessionId: nil,
                baselineDraftIds: nil
            ) == nil
        )
        #expect(
            attachmentImportRecoveryDraft(
                drafts: [unrelated],
                committedDraftId: unrelated.id,
                routeDraftId: nil,
                routeSessionId: nil,
                baselineDraftIds: nil
            )?.id == unrelated.id
        )
        #expect(
            attachmentImportRecoveryDraft(
                drafts: [unrelated],
                committedDraftId: nil,
                routeDraftId: nil,
                routeSessionId: nil,
                baselineDraftIds: []
            )?.id == unrelated.id
        )
    }

    @Test func supportedExtensionFallbackMapsOrdinaryAttachmentTypes() {
        #expect(ChatViewModel.attachmentMediaType(forExtension: "jpg") == "image/jpeg")
        #expect(ChatViewModel.attachmentMediaType(forExtension: "heic") == "image/heic")
        #expect(ChatViewModel.attachmentMediaType(forExtension: "pdf") == "application/pdf")
        #expect(ChatViewModel.attachmentMediaType(forExtension: "txt") == "text/plain")
        #expect(ChatViewModel.attachmentMediaType(forExtension: "md") == "text/markdown")
        #expect(ChatViewModel.attachmentMediaType(forExtension: "csv") == "text/csv")
    }

    @Test func pickerFailureIsVisibleToChatConsumer() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "attachment-picker-failure-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false
        )

        viewModel.reportAttachmentImportFailure(source: .files)
        #expect(viewModel.attachmentImportAlert?.source == .files)
        #expect(viewModel.attachmentImportAlert?.reason == .unknown)
        viewModel.reportAttachmentImportFailure(source: .photos)
        #expect(viewModel.attachmentImportAlert?.source == .photos)
        #expect(viewModel.attachmentImportAlert?.reason == .unknown)
    }

    @Test func deniedImportAdmissionIsVisibleAndCleansOwnedFile() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "attachment-admission-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let saveStarted = AsyncGate()
        let releaseSave = AsyncGate()
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false,
            saveDraftText: { _, _, _ in
                await saveStarted.open()
                await releaseSave.wait()
                return nil
            }
        )

        viewModel.send("pending")
        await saveStarted.wait()
        let owned = try temporaryFile()
        viewModel.importAttachments([.temporary(owned)])

        #expect(viewModel.draftSaveError == "Wait for current upload to finish before adding files.")
        #expect(!FileManager.default.fileExists(atPath: owned.path))
        await releaseSave.open()
        _ = await viewModel.saveDraftBeforeNavigation()
    }

    @Test func photoImportRetainsOriginalGIFBytesAndType() async throws {
        let source = temporaryURL(extension: "gif")
        let original = Data("GIF89a-original-animation".utf8)
        try original.write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let provider = try #require(NSItemProvider(contentsOf: source))

        let imported = try await AttachmentPhotoImport.prepare(provider)
        defer { imported.ownedTemporaryURLs.forEach { try? FileManager.default.removeItem(at: $0) } }

        #expect(imported.mediaType == "image/gif")
        #expect(imported.source == .photos)
        #expect(try Data(contentsOf: imported.url) == original)
    }

    @Test func gifRepresentationWinsOverAdvertisedJPEGFallback() async throws {
        let gif = temporaryURL(extension: "gif")
        let jpeg = temporaryURL(extension: "jpg")
        let original = Data("GIF89a-multi-representation".utf8)
        try original.write(to: gif)
        try Data([0xff, 0xd8, 0xff, 0xd9]).write(to: jpeg)
        defer {
            try? FileManager.default.removeItem(at: gif)
            try? FileManager.default.removeItem(at: jpeg)
        }
        let provider = NSItemProvider()
        register(jpeg, type: .jpeg, on: provider)
        register(gif, type: .gif, on: provider)

        let imported = try await AttachmentPhotoImport.prepare(provider)
        defer { imported.ownedTemporaryURLs.forEach { try? FileManager.default.removeItem(at: $0) } }

        #expect(imported.mediaType == "image/gif")
        #expect(try Data(contentsOf: imported.url) == original)
    }

    @Test func phoneDNGIsExportedForNormalizationInsteadOfUsingJPEGFallback() async throws {
        let rawType = try #require(UTType(filenameExtension: "dng"))
        let raw = temporaryURL(extension: "dng")
        let jpeg = temporaryURL(extension: "jpg")
        try Data([1, 2, 3]).write(to: raw)
        try Data([0xff, 0xd8, 0xff, 0xd9]).write(to: jpeg)
        defer {
            try? FileManager.default.removeItem(at: raw)
            try? FileManager.default.removeItem(at: jpeg)
        }
        let provider = NSItemProvider()
        register(jpeg, type: .jpeg, on: provider)
        register(raw, type: rawType, on: provider)

        let imported = try await AttachmentPhotoImport.prepare(provider)
        defer { imported.ownedTemporaryURLs.forEach { try? FileManager.default.removeItem(at: $0) } }
        #expect(imported.mediaType == "image/x-adobe-dng")
        #expect(imported.source == .photos)
        #expect(try Data(contentsOf: imported.url) == Data([1, 2, 3]))
        #expect(FileManager.default.fileExists(atPath: raw.path))
    }

    @Test func cancelledProviderExportSettlesBarrierAndIgnoresLateCompletion() async throws {
        let probe = ProviderLoadProbe()
        let barrier = DraftMutationBarrier()
        barrier.enqueue {
            _ = try? await AttachmentPhotoImport.copyFileRepresentation(
                typeIdentifier: UTType.jpeg.identifier,
                deadline: .seconds(30),
                load: probe.load
            )
        }
        await probe.waitUntilRegistered()

        barrier.cancelAll()
        #expect(try await barrier.perform { true })
        #expect(probe.progress.isCancelled)

        let late = temporaryURL(extension: "jpg")
        try Data([1, 2, 3]).write(to: late)
        defer { try? FileManager.default.removeItem(at: late) }
        probe.complete(with: late)
        await Task.yield()
    }

    @Test func stalledProviderExportTimesOutAndCancelsProgress() async {
        let probe = ProviderLoadProbe()
        do {
            _ = try await AttachmentPhotoImport.copyFileRepresentation(
                typeIdentifier: UTType.jpeg.identifier,
                deadline: .milliseconds(20),
                load: probe.load
            )
            Issue.record("stalled provider export unexpectedly succeeded")
        } catch {
            #expect((error as? URLError)?.code == .timedOut)
        }
        #expect(probe.progress.isCancelled)
    }

    @Test func cancellationBeforeProviderRegistrationDoesNotStartExport() async {
        let probe = ProviderLoadProbe()
        let task = Task {
            try await AttachmentPhotoImport.copyFileRepresentation(
                typeIdentifier: UTType.jpeg.identifier,
                load: probe.load
            )
        }
        task.cancel()

        do {
            _ = try await task.value
            Issue.record("cancelled provider export unexpectedly succeeded")
        } catch {
            #expect(error is CancellationError)
        }
        #expect(probe.registrationCount == 0)
    }

    @Test func cancelledNoncooperativeImportResultIsNotPublished() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "attachment-cancelled-result-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let owned = try temporaryTextFile()
        let attachment = NativeDraftAttachment(
            id: "cancelled-attachment",
            displayName: owned.lastPathComponent,
            mediaType: "text/plain",
            sizeBytes: 3,
            localPath: "/owned/cancelled-attachment"
        )
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false,
            saveDraftText: { _, _, _ in nil },
            importDraftAttachment: { _, _, _ in
                withUnsafeCurrentTask { $0?.cancel() }
                return NativeDraft(
                    id: "cancelled-draft",
                    sessionId: "session-one",
                    text: "",
                    attachments: [attachment],
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1
                )
            }
        )

        viewModel.importAttachments([.temporary(owned)])
        _ = await viewModel.saveDraftBeforeNavigation()

        #expect(viewModel.draftAttachments.isEmpty)
        #expect(viewModel.pendingAttachmentImportCount == 0)
        #expect(!FileManager.default.fileExists(atPath: owned.path))
    }

    @Test func postCommitImportFailureReconcilesAuthoritativeDraftForConsumer() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "attachment-post-commit-failure-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let source = try temporaryTextFile()
        defer { try? FileManager.default.removeItem(at: source) }
        let drafts = try #require(session.component.drafts)
        let importStarted = AsyncGate()
        let releaseImport = AsyncGate()
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false,
            importDraftAttachment: { draftId, sessionId, request in
                await importStarted.open()
                await releaseImport.wait()
                _ = try await drafts.importAttachment(
                    draftId: draftId,
                    sessionId: sessionId,
                    source: request
                )
                throw AttachmentImportTestError.postCommit
            }
        )

        viewModel.importAttachments([.file(source)])
        await importStarted.wait()
        await releaseImport.open()
        _ = await viewModel.saveDraftBeforeNavigation()

        let durable = try #require(
            drafts.snapshot.value.drafts.first(where: { $0.sessionId == "session-one" })
        )
        #expect(durable.attachments.count == 1)
        #expect(viewModel.draftAttachments.map(\.id) == durable.attachments.map(\.id))
        #expect(viewModel.pendingAttachmentImportCount == 0)
    }

    @Test func cancellationAfterDurableImportReconcilesAuthoritativeDraftForConsumer() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "attachment-post-commit-cancel-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let source = try temporaryTextFile()
        defer { try? FileManager.default.removeItem(at: source) }
        let drafts = try #require(session.component.drafts)
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false,
            importDraftAttachment: { draftId, sessionId, request in
                let saved = try await drafts.importAttachment(
                    draftId: draftId,
                    sessionId: sessionId,
                    source: request
                )
                withUnsafeCurrentTask { $0?.cancel() }
                return saved
            }
        )

        viewModel.importAttachments([.file(source)])
        _ = await viewModel.saveDraftBeforeNavigation()

        #expect(viewModel.draftAttachments.count == 1)
        #expect(viewModel.pendingAttachmentImportCount == 0)
        #expect(drafts.snapshot.value.drafts.first?.attachments.count == 1)
    }

    @Test func discardWhileImportIsInFlightFencesCompletionAndAllowsNewDraft() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "draft-discard-import-fence-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let source = try temporaryTextFile()
        defer { try? FileManager.default.removeItem(at: source) }
        let drafts = try #require(session.component.drafts)
        let existing = try #require(
            try await drafts.saveText(
                draftId: nil,
                sessionId: "session-one",
                text: "old edit"
            )
        )
        let importStarted = AsyncGate()
        let releaseImport = AsyncGate()
        let discarded = Task {
            for await id in drafts.discardedDrafts { return id }
            fatalError("discard stream ended")
        }
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            draftId: existing.id,
            activateOnInit: false,
            observeChatOnInit: false,
            importDraftAttachment: { draftId, sessionId, request in
                await importStarted.open()
                await releaseImport.wait()
                return try await drafts.importAttachment(
                    draftId: draftId,
                    sessionId: sessionId,
                    source: request
                )
            }
        )

        viewModel.importAttachments([.file(source)])
        await importStarted.wait()
        let didDiscard = (try await drafts.discard(draftId: existing.id)).boolValue
        #expect(didDiscard)
        await releaseImport.open()
        _ = await discarded.value
        for _ in 0..<100 where viewModel.pendingAttachmentImportCount != 0 {
            await Task.yield()
        }

        let afterDiscard = try await drafts.restore()
        #expect(!afterDiscard.drafts.contains { $0.id == existing.id })
        viewModel.updateDraft("new edit")
        #expect(await viewModel.saveDraftBeforeNavigation())
        let replacement = try #require((try await drafts.restore()).drafts.first)
        #expect(replacement.id != existing.id)
        #expect(replacement.text == "new edit")
    }

    @Test func queuedSaveCapturedBeforeRestoreIsDroppedAfterDiscard() async throws {
        let session = createUserSession(
            gatewayWsUrl: "ws://127.0.0.1:9/api/v1/ws",
            allowSelfSignedDevHost: false,
            authenticatedUserId: "draft-discard-save-fence-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let drafts = try #require(session.component.drafts)
        let existing = try #require(try await drafts.saveText(
            draftId: nil, sessionId: "session-one", text: "old edit"
        ))
        let importStarted = AsyncGate()
        let releaseImport = AsyncGate()
        var saves: [(draftId: String?, text: String)] = []
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false,
            saveDraftText: { draftId, sessionId, text in
                saves.append((draftId, text))
                return try await drafts.saveText(draftId: draftId, sessionId: sessionId, text: text)
            }
        )

        viewModel.prepareAttachments(AttachmentImportRequest(count: 1, source: .files) {
            await importStarted.open()
            await releaseImport.wait()
            throw CancellationError()
        })
        await importStarted.wait()
        viewModel.updateDraft("stale edit")
        viewModel.flushDraft()
        for _ in 0..<20 { await Task.yield() }

        #expect((try await drafts.discard(draftId: existing.id)).boolValue)
        viewModel.applyDiscardedDraft(existing.id)
        await releaseImport.open()
        while viewModel.pendingAttachmentImportCount != 0 { await Task.yield() }

        #expect((try await drafts.restore()).drafts.isEmpty)
        viewModel.updateDraft("new edit")
        #expect(await viewModel.saveDraftBeforeNavigation())
        #expect(saves.count == 1)
        #expect(saves.first?.draftId == nil)
        #expect(saves.first?.text == "new edit")
        let replacement = try #require((try await drafts.restore()).drafts.first)
        #expect(replacement.id != existing.id)
        #expect(replacement.text == "new edit")
    }

    @Test func pickerFailureFencesSuccessfulImportAndQueuedSave() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "attachment-picker-fence-success-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let source = try temporaryTextFile()
        defer { try? FileManager.default.removeItem(at: source) }
        let importStarted = AsyncGate()
        let releaseImport = AsyncGate()
        let saveStarted = AsyncGate()
        let attachment = NativeDraftAttachment(
            id: "picker-fence-attachment",
            displayName: source.lastPathComponent,
            mediaType: "text/plain",
            sizeBytes: 3,
            localPath: "/owned/picker-fence-attachment"
        )
        weak var observedViewModel: ChatViewModel?
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false,
            saveDraftText: { draftId, _, text in
                #expect(observedViewModel?.attachmentImportAlert?.reason == .unreadable)
                #expect(draftId == "picker-fence-draft")
                #expect(text == "keep this text")
                await saveStarted.open()
                return NativeDraft(
                    id: draftId ?? "picker-fence-draft",
                    sessionId: "session-one",
                    text: text,
                    attachments: [attachment],
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1
                )
            },
            importDraftAttachment: { _, _, _ in
                await importStarted.open()
                await releaseImport.wait()
                return NativeDraft(
                    id: "picker-fence-draft",
                    sessionId: "session-one",
                    text: "",
                    attachments: [attachment],
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1
                )
            }
        )
        observedViewModel = viewModel

        viewModel.importAttachments([.temporary(source)])
        await importStarted.wait()
        viewModel.updateDraft("keep this text")
        viewModel.flushDraft()
        viewModel.reportAttachmentImportFailure(source: .files, error: CocoaError(.fileReadUnknown))
        await releaseImport.open()
        await saveStarted.wait()

        #expect(viewModel.draftAttachments.map(\.id) == [attachment.id])
        #expect(viewModel.attachmentImportAlert?.reason == .unreadable)
        #expect(await viewModel.saveDraftBeforeNavigation())
        #expect(viewModel.draftSaveError == nil)
    }

    @Test func olderImportFailureCannotReplaceNewerPickerFailure() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "attachment-picker-fence-failure-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let source = try temporaryTextFile()
        defer { try? FileManager.default.removeItem(at: source) }
        let importStarted = AsyncGate()
        let releaseImport = AsyncGate()
        let saveStarted = AsyncGate()
        weak var observedViewModel: ChatViewModel?
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false,
            saveDraftText: { draftId, _, text in
                #expect(observedViewModel?.attachmentImportAlert?.reason == .unreadable)
                await saveStarted.open()
                return NativeDraft(
                    id: draftId ?? "picker-fence-failure-draft",
                    sessionId: "session-one",
                    text: text,
                    attachments: [],
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1
                )
            },
            importDraftAttachment: { _, _, _ in
                await importStarted.open()
                await releaseImport.wait()
                throw CocoaError(.fileReadTooLarge)
            }
        )
        observedViewModel = viewModel

        viewModel.importAttachments([.temporary(source)])
        await importStarted.wait()
        viewModel.updateDraft("keep this text")
        viewModel.flushDraft()
        viewModel.reportAttachmentImportFailure(source: .files, error: CocoaError(.fileReadUnknown))
        await releaseImport.open()
        await saveStarted.wait()

        #expect(viewModel.attachmentImportAlert?.reason == .unreadable)
    }

    @Test func invalidFilesDNGShowsUnreadableAlertWithoutCopyingOrDeletingOriginal() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "attachment-dng-consumer-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let source = temporaryURL(extension: "dng")
        try Data("invalid DNG".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false
        )
        viewModel.importAttachments([.file(source)])
        #expect(await viewModel.saveDraftBeforeNavigation() == false)
        #expect(viewModel.attachmentImportAlert?.reason == .unreadable)
        #expect(viewModel.pendingAttachmentImportCount == 0)
        #expect(viewModel.draftAttachments.isEmpty)
        #expect(FileManager.default.fileExists(atPath: source.path))
    }

    @Test func filePDFAndPhotoImportReachComposerConsumerState() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "attachment-file-consumer-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let pdf = temporaryURL(extension: "pdf")
        let photo = temporaryURL(extension: "jpg")
        defer {
            try? FileManager.default.removeItem(at: pdf)
            try? FileManager.default.removeItem(at: photo)
        }
        try Data("%PDF-1.7\nfixture".utf8).write(to: pdf)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { _ in
            UIColor.systemBlue.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }
        try #require(image.jpegData(compressionQuality: 0.9)).write(to: photo)

        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false
        )
        viewModel.importAttachments([.file(pdf), .file(photo)])
        #expect(await viewModel.saveDraftBeforeNavigation())

        #expect(viewModel.pendingAttachmentImportCount == 0)
        #expect(viewModel.draftAttachments.map(\.mediaType) == ["application/pdf", "image/jpeg"])
        #expect(viewModel.draftSaveError == nil)
        let cards = viewModel.draftAttachments.map(ComposerAttachment.init)
        #expect(cards.map(\.isImage) == [false, true])
    }

    @Test func boundedCopyStopsAtCancellationBoundaryAndRemovesPartialFile() throws {
        let source = temporaryURL(extension: "bin")
        let destination = temporaryURL(extension: "copy")
        try Data(repeating: 7, count: 192 * 1_024).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        var checks = 0

        do {
            _ = try AttachmentPhotoImport.boundedCopyItem(
                at: source,
                to: destination,
                maximumBytes: 512 * 1_024
            ) {
                checks += 1
                return checks > 2
            }
            Issue.record("cancelled stream copy unexpectedly succeeded")
        } catch {
            #expect(error is CancellationError)
        }
        #expect(!FileManager.default.fileExists(atPath: destination.path))
    }

    @Test func boundedCopyPreflightsOversizedFilesAndRejectsPackageSymlinks() throws {
        let source = temporaryURL(extension: "bin")
        let destination = temporaryURL(extension: "copy")
        try Data(repeating: 1, count: 5).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        #expect(throws: CocoaError.self) {
            _ = try AttachmentPhotoImport.boundedCopyItem(at: source, to: destination, maximumBytes: 4)
        }
        #expect(!FileManager.default.fileExists(atPath: destination.path))

        let package = temporaryURL(extension: "live")
        let packageCopy = temporaryURL(extension: "copy")
        try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: package.appendingPathComponent("still.jpg"))
        try Data([4, 5, 6]).write(to: package.appendingPathComponent("motion.mov"))
        defer { try? FileManager.default.removeItem(at: package) }
        #expect(throws: CocoaError.self) {
            _ = try AttachmentPhotoImport.boundedCopyItem(at: package, to: packageCopy, maximumBytes: 5)
        }
        #expect(!FileManager.default.fileExists(atPath: packageCopy.path))

        try FileManager.default.removeItem(at: package.appendingPathComponent("motion.mov"))
        try FileManager.default.createSymbolicLink(
            at: package.appendingPathComponent("escape.mov"),
            withDestinationURL: source
        )
        #expect(throws: CocoaError.self) {
            _ = try AttachmentPhotoImport.boundedCopyItem(at: package, to: packageCopy, maximumBytes: 100)
        }
        #expect(!FileManager.default.fileExists(atPath: packageCopy.path))
    }

    @Test func livePhotoManifestUsesCanonicalPairNames() throws {
        let data = try AttachmentPhotoImport.livePhotoManifest(
            stillName: "still.heic",
            mediaType: "image/heic"
        )
        let manifest = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let still = try #require(manifest["still"] as? [String: String])
        let motion = try #require(manifest["motion"] as? [String: String])

        #expect(manifest["version"] as? Int == 1)
        #expect(still == ["name": "live-photo/still.heic", "mediaType": "image/heic"])
        #expect(motion == ["name": "live-photo/motion.mov", "mediaType": "video/quicktime"])
    }

    @Test func imageTypesMapWithoutMislabelingDNGAsDecodedImage() {
        let expected = [
            "jpg": "image/jpeg", "png": "image/png", "heic": "image/heic",
            "heif": "image/heif", "avif": "image/avif", "webp": "image/webp",
            "gif": "image/gif", "tiff": "image/tiff", "bmp": "image/bmp",
            "jp2": "image/jp2", "jxl": "image/jxl",
        ]
        for (extensionName, mediaType) in expected {
            #expect(ChatViewModel.imageMediaType(forExtension: extensionName) == mediaType)
        }
        #expect(ChatViewModel.imageMediaType(forExtension: "dng") == nil)
        #expect(AttachmentPhotoImport.maximumSourceBytes == 512 * 1_024 * 1_024)
    }

    @Test func flushAndNavigationWaitForViewModelImportAndPreserveLatestDraftIdentity() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "attachment-navigation-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let started = AsyncGate()
        let release = AsyncGate()
        let owned = try temporaryTextFile()
        let drafts = try #require(session.component.drafts)
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            importDraftAttachment: { draftId, sessionId, source in
                await started.open()
                await release.wait()
                return try await drafts.importAttachment(draftId: draftId, sessionId: sessionId, source: source)
            }
        )

        viewModel.importAttachments([.temporary(owned)])
        await started.wait()
        viewModel.updateDraft("latest text")
        viewModel.flushDraft() // Generic Settings/Inbox disappearance path.
        let navigation = Task { await viewModel.saveDraftBeforeNavigation() }

        #expect(drafts.snapshot.value.drafts.isEmpty)
        await release.open()
        let saved = await navigation.value
        #expect(saved)

        let draft = try #require(drafts.snapshot.value.drafts.first)
        #expect(drafts.snapshot.value.drafts.count == 1)
        #expect(draft.sessionId == "session-one")
        #expect(draft.text == "latest text")
        #expect(draft.attachments.map(\.displayName) == [owned.lastPathComponent])
        #expect(viewModel.draftAttachments.map(\.id) == draft.attachments.map(\.id))
        #expect(!FileManager.default.fileExists(atPath: owned.path))
    }

    @Test func photoPreparationReservesBeforeURLAndFencesNavigationAndSend() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "photo-preparation-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let preparationStarted = AsyncGate()
        let releasePreparation = AsyncGate()
        let firstSave = AsyncGate()
        let secondSave = AsyncGate()
        var producedURL: URL?
        var saves: [(draftId: String?, text: String)] = []
        let attachment = NativeDraftAttachment(
            id: "photo-one",
            displayName: "photo.jpg",
            mediaType: "image/jpeg",
            sizeBytes: 3,
            localPath: "/owned/photo-one"
        )
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            saveDraftText: { draftId, _, text in
                saves.append((draftId, text))
                if saves.count == 1 { await firstSave.open() }
                if saves.count == 2 { await secondSave.open() }
                return NativeDraft(
                    id: draftId ?? "draft-photo",
                    sessionId: "session-one",
                    text: text,
                    attachments: [attachment],
                    revision: Int64(saves.count + 1),
                    createdAt: 1,
                    updatedAt: Int64(saves.count + 1)
                )
            },
            importDraftAttachment: { _, _, source in
                #expect(source.displayName.hasSuffix(".jpg"))
                #expect(source.mediaType == "image/jpeg")
                return NativeDraft(
                    id: "draft-photo",
                    sessionId: "session-one",
                    text: "",
                    attachments: [attachment],
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1
                )
            }
        )

        viewModel.prepareAttachments(AttachmentImportRequest(count: 1) {
            await preparationStarted.open()
            await releasePreparation.wait()
            let url = self.temporaryURL(extension: "jpg")
            try Data([1, 2, 3]).write(to: url)
            producedURL = url
            return [.temporary(url)]
        })
        await preparationStarted.wait()

        #expect(viewModel.pendingAttachmentImportCount == 1)
        #expect(producedURL == nil)
        viewModel.updateDraft("latest text")
        let navigation = Task { await viewModel.saveDraftBeforeNavigation() }
        viewModel.send("latest text")
        #expect(saves.isEmpty)

        await releasePreparation.open()
        await firstSave.wait()
        await secondSave.wait()
        let navigationSaved = await navigation.value

        #expect(navigationSaved)
        #expect(saves.count == 2)
        #expect(saves.allSatisfy { $0.draftId == "draft-photo" && $0.text == "latest text" })
        #expect(viewModel.draftAttachments.map(\.id) == ["photo-one"])
        #expect(viewModel.pendingAttachmentImportCount == 0)
        let cleanedURL = try #require(producedURL)
        #expect(!FileManager.default.fileExists(atPath: cleanedURL.path))
    }

    @Test func failedPreparationBlocksQueuedNavigationAndSendUntilExplicitRecovery() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "photo-failure-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let preparationStarted = AsyncGate()
        let releasePreparation = AsyncGate()
        let firstSave = AsyncGate()
        let secondSave = AsyncGate()
        var partialURL: URL?
        var successfulURL: URL?
        var saveCount = 0
        let validAttachment = NativeDraftAttachment(
            id: "photo-two",
            displayName: "photo-two.jpg",
            mediaType: "image/jpeg",
            sizeBytes: 3,
            localPath: "/owned/photo-two"
        )
        weak var observedViewModel: ChatViewModel?
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            saveDraftText: { draftId, _, text in
                saveCount += 1
                #expect(observedViewModel?.attachmentImportAlert?.reason == .unreadable)
                if saveCount == 1 { await firstSave.open() }
                if saveCount == 2 { await secondSave.open() }
                return NativeDraft(
                    id: draftId ?? "draft-failure",
                    sessionId: "session-one",
                    text: text,
                    attachments: [validAttachment],
                    revision: Int64(saveCount),
                    createdAt: 1,
                    updatedAt: Int64(saveCount)
                )
            },
            importDraftAttachment: { _, _, _ in
                NativeDraft(
                    id: "draft-failure",
                    sessionId: "session-one",
                    text: "",
                    attachments: [validAttachment],
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1
                )
            }
        )
        observedViewModel = viewModel

        viewModel.prepareAttachments(AttachmentImportRequest(count: 1) {
            await preparationStarted.open()
            await releasePreparation.wait()
            let url = self.temporaryURL(extension: "jpg")
            try Data([1, 2, 3]).write(to: url)
            partialURL = url
            defer { try? FileManager.default.removeItem(at: url) }
            throw CocoaError(.fileReadCorruptFile)
        })
        await preparationStarted.wait()
        viewModel.prepareAttachments(AttachmentImportRequest(count: 1) {
            let url = self.temporaryURL(extension: "jpg")
            try Data([4, 5, 6]).write(to: url)
            successfulURL = url
            return [.temporary(url)]
        })
        viewModel.updateDraft("keep this text")
        let navigation = Task { await viewModel.saveDraftBeforeNavigation() }
        viewModel.send("keep this text")

        #expect(viewModel.pendingAttachmentImportCount == 2)
        await releasePreparation.open()
        await firstSave.wait()
        await secondSave.wait()
        let navigationApproved = await navigation.value

        #expect(!navigationApproved)
        #expect(viewModel.draftText == "keep this text")
        #expect(viewModel.draftAttachments.map(\.id) == ["photo-two"])
        #expect(viewModel.pendingAttachmentImportCount == 0)
        #expect(viewModel.attachmentImportAlert?.reason == .unreadable)
        let cleanedURL = try #require(partialURL)
        let cleanedSuccessfulURL = try #require(successfulURL)
        #expect(!FileManager.default.fileExists(atPath: cleanedURL.path))
        #expect(!FileManager.default.fileExists(atPath: cleanedSuccessfulURL.path))

        let recoveryApproved = await viewModel.saveDraftBeforeNavigation()
        #expect(recoveryApproved)
        #expect(viewModel.draftSaveError == nil)
    }

    @Test func sendWaitsForViewModelImportBeforeFreezingLatestText() async throws {
        let session = createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "attachment-send-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let importStarted = AsyncGate()
        let releaseImport = AsyncGate()
        let saveStarted = AsyncGate()
        let owned = try temporaryTextFile()
        let attachment = NativeDraftAttachment(
            id: "attachment-one",
            displayName: owned.lastPathComponent,
            mediaType: "text/plain",
            sizeBytes: 3,
            localPath: "/owned/attachment-one"
        )
        var savedDraftId: String?
        var savedText: String?
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            saveDraftText: { draftId, _, text in
                savedDraftId = draftId
                savedText = text
                await saveStarted.open()
                return NativeDraft(
                    id: draftId ?? "draft-one",
                    sessionId: "session-one",
                    text: text,
                    attachments: [attachment],
                    revision: 2,
                    createdAt: 1,
                    updatedAt: 2
                )
            },
            importDraftAttachment: { _, _, _ in
                await importStarted.open()
                await releaseImport.wait()
                return NativeDraft(
                    id: "draft-one",
                    sessionId: "session-one",
                    text: "",
                    attachments: [attachment],
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1
                )
            }
        )

        viewModel.importAttachments([.temporary(owned)])
        await importStarted.wait()
        viewModel.updateDraft("latest text")
        viewModel.send("latest text")

        #expect(savedText == nil)
        await releaseImport.open()
        await saveStarted.wait()

        #expect(savedDraftId == "draft-one")
        #expect(savedText == "latest text")
        #expect(viewModel.draftAttachments.map(\.id) == ["attachment-one"])
        #expect(!FileManager.default.fileExists(atPath: owned.path))
    }

    @Test func protectedNativeDraftPreviewHonorsRequestedPixelBound() async throws {
        let session = nativePreviewSession()
        defer { session.close() }
        let source = temporaryURL(extension: "jpg")
        defer { try? FileManager.default.removeItem(at: source) }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let image = UIGraphicsImageRenderer(
            size: CGSize(width: 2000, height: 1000),
            format: format
        ).image { context in
            UIColor.systemRed.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 2000, height: 1000))
        }
        try #require(image.jpegData(compressionQuality: 0.9)).write(to: source)
        let attachment = try await importNativePreview(source, into: session)

        let bytes = try #require(try await session.component.previewDraftAttachment(
            attachmentId: attachment.id,
            maxPixelSize: 640
        ))
        let preview = Data((0..<Int(bytes.size)).map { UInt8(bitPattern: bytes.get(index: Int32($0))) })
        let imageSource = try #require(CGImageSourceCreateWithData(preview as CFData, nil))
        let properties = try #require(
            CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any]
        )
        let width = try #require(properties[kCGImagePropertyPixelWidth] as? Int)
        let height = try #require(properties[kCGImagePropertyPixelHeight] as? Int)

        print("NATIVE_PREVIEW_RESULT requested=640 output=\(width)x\(height)")
        #expect(max(width, height) <= 640)
    }

    @Test func livePhotoUsesOwnedSelectedStillPreviewWithoutDecodingBundle() async throws {
        let session = nativePreviewSession()
        defer { session.close() }
        let bundle = temporaryURL(extension: "livephoto.zip")
        let still = temporaryURL(extension: "jpg")
        defer {
            try? FileManager.default.removeItem(at: bundle)
            try? FileManager.default.removeItem(at: still)
        }
        try Data([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]).write(to: bundle)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 600)).image { _ in
            UIColor.systemGreen.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: 1200, height: 600))
        }
        try #require(image.jpegData(compressionQuality: 0.9)).write(to: still)
        let drafts = try #require(session.component.drafts)
        let draft = try await drafts.importAttachment(
            draftId: nil,
            sessionId: nil,
            source: NativeDraftAttachmentImport(
                sourceLocation: bundle.absoluteString,
                displayName: "fixture.livephoto.zip",
                mediaType: "application/vnd.sentient.live-photo+zip",
                previewSourceLocation: still.absoluteString
            )
        )
        let attachment = try #require(draft.attachments.first)

        let bytes = try #require(try await session.component.previewDraftAttachment(
            attachmentId: attachment.id,
            maxPixelSize: 640
        ))
        let preview = Data((0..<Int(bytes.size)).map { UInt8(bitPattern: bytes.get(index: Int32($0))) })
        let source = try #require(CGImageSourceCreateWithData(preview as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect((properties[kCGImagePropertyPixelWidth] as? Int ?? 0) <= 640)
    }

    @Test func missingProtectedPreviewIsCaughtAsTypedLocalFileError() async throws {
        let session = nativePreviewSession()
        defer { session.close() }
        let source = temporaryURL(extension: "jpg")
        defer { try? FileManager.default.removeItem(at: source) }
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { _ in
            UIColor.systemBlue.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        try #require(image.jpegData(compressionQuality: 0.9)).write(to: source)
        let attachment = try await importNativePreview(source, into: session)
        let stored = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SentientDrafts")
            .appendingPathComponent(attachment.localPath)
        try FileManager.default.removeItem(at: stored)

        do {
            _ = try await session.component.previewDraftAttachment(
                attachmentId: attachment.id,
                maxPixelSize: 640
            )
            Issue.record("missing protected preview unexpectedly succeeded")
        } catch {
            let failure = try #require((error as NSError).kotlinException as? AttachmentRequestException)
            print("NATIVE_PREVIEW_ERROR status=\(failure.status) code=\(failure.code)")
            #expect(failure.status == 0)
            #expect(failure.code == "local_file_error")
        }
    }

    @Test func attachmentCountRejectsLimitPlusOneIncludingPendingImports() {
        #expect(AttachmentImportPolicy.accepts(selectionCount: 1, existing: 7, pending: 0))
        #expect(!AttachmentImportPolicy.accepts(selectionCount: 2, existing: 7, pending: 0))
        #expect(AttachmentImportPolicy.remaining(existing: 6, pending: 1) == 1)
        #expect(!AttachmentImportPolicy.accepts(selectionCount: 1, existing: 7, pending: 1))
    }

    @Test func safeTextAndSourceFormatsMapToGatewaySupportedMediaTypes() throws {
        let swift = try #require(UTType(filenameExtension: "swift"))
        let python = try #require(UTType(filenameExtension: "py"))
        let json = try #require(UTType(filenameExtension: "json"))
        let markdown = try #require(UTType(filenameExtension: "md"))
        let csv = try #require(UTType(filenameExtension: "csv"))

        #expect(ChatViewModel.attachmentMediaType(for: swift) == "text/plain")
        #expect(ChatViewModel.attachmentMediaType(for: python) == "text/plain")
        #expect(ChatViewModel.attachmentMediaType(for: json) == "text/plain")
        #expect(ChatViewModel.attachmentMediaType(for: markdown) == "text/markdown")
        #expect(ChatViewModel.attachmentMediaType(for: csv) == "text/csv")
    }

    @Test func ownedTemporaryFilesAndPreviewSourcesAreRemovedAfterSuccess() async throws {
        let owned = try temporaryFile()
        let preview = try temporaryFile()
        let borrowed = try temporaryFile()
        defer { try? FileManager.default.removeItem(at: borrowed) }

        try await withAttachmentImportCleanup([
            .temporary(owned, previewSourceURL: preview),
            .file(borrowed),
        ]) {}

        #expect(!FileManager.default.fileExists(atPath: owned.path))
        #expect(!FileManager.default.fileExists(atPath: preview.path))
        #expect(FileManager.default.fileExists(atPath: borrowed.path))
    }

    @Test func ownedTemporaryFilesAreRemovedAfterFailure() async throws {
        let owned = try temporaryFile()

        do {
            try await withAttachmentImportCleanup([.temporary(owned)]) {
                throw CocoaError(.fileReadCorruptFile)
            }
        } catch {}

        #expect(!FileManager.default.fileExists(atPath: owned.path))
    }

    @Test func ownedTemporaryFilesAreRemovedAfterCancellation() async throws {
        let owned = try temporaryFile()
        let task = Task {
            do {
                try await withAttachmentImportCleanup([.temporary(owned)]) {
                    try await Task.sleep(for: .seconds(60))
                }
            } catch {}
        }
        await Task.yield()
        task.cancel()
        await task.value

        #expect(!FileManager.default.fileExists(atPath: owned.path))
    }

    private func nativePreviewSession() -> IosUserSession {
        createUserSession(
            gatewayWsUrl: "ws://127.0.0.1:9/api/v1/ws",
            allowSelfSignedDevHost: false,
            authenticatedUserId: "native-preview-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
    }

    private func importNativePreview(
        _ source: URL,
        into session: IosUserSession
    ) async throws -> NativeDraftAttachment {
        let drafts = try #require(session.component.drafts)
        let draft = try await drafts.importAttachment(
            draftId: nil,
            sessionId: nil,
            source: NativeDraftAttachmentImport(
                sourceLocation: source.absoluteString,
                displayName: source.lastPathComponent,
                mediaType: "image/jpeg",
                previewSourceLocation: nil
            )
        )
        return try #require(draft.attachments.last)
    }

    private func register(_ url: URL, type: UTType, on provider: NSItemProvider) {
        provider.registerFileRepresentation(
            forTypeIdentifier: type.identifier,
            fileOptions: [],
            visibility: .all
        ) { completion in
            completion(url, false, nil)
            return Progress(totalUnitCount: 1)
        }
    }

    private func temporaryTextFile() throws -> URL {
        let url = temporaryURL(extension: "swift")
        try Data("let value = 1".utf8).write(to: url)
        return url
    }

    private func temporaryFile() throws -> URL {
        let url = temporaryURL(extension: "tmp")
        try Data([1, 2, 3]).write(to: url)
        return url
    }

    private func temporaryURL(extension pathExtension: String) -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(pathExtension)
    }
}

private enum AttachmentScopeTestError: Error {
    case failed
}

private enum AttachmentImportTestError: Error {
    case postCommit
}

private final class ProviderLoadProbe: @unchecked Sendable {
    let progress = Progress(totalUnitCount: 1)
    private let lock = NSLock()
    private var completion: ((URL?, Error?) -> Void)?
    private var count = 0

    var registrationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func load(_ completion: @escaping (URL?, Error?) -> Void) -> Progress {
        lock.lock()
        count += 1
        self.completion = completion
        lock.unlock()
        return progress
    }

    func waitUntilRegistered() async {
        while registrationCount == 0 {
            await Task.yield()
        }
    }

    func complete(with url: URL) {
        lock.lock()
        let completion = self.completion
        self.completion = nil
        lock.unlock()
        completion?(url, nil)
    }
}

private actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }
}

@MainActor
private final class CameraAccessStub: CameraAccessProviding {
    let isAvailable: Bool
    let authorizationStatus: AVAuthorizationStatus
    let requestResult: Bool
    private(set) var requestCount = 0

    init(available: Bool, status: AVAuthorizationStatus, requestResult: Bool = false) {
        isAvailable = available
        authorizationStatus = status
        self.requestResult = requestResult
    }

    func requestAccess() async -> Bool {
        requestCount += 1
        return requestResult
    }
}
