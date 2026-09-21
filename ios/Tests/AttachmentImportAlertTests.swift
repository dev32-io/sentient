import Foundation
import MobileData
import Testing
@testable import SentientApp

@MainActor
struct AttachmentImportAlertTests {
    @Test func classifiedFailureProducesReasonSpecificAlert() {
        let session = makeSession("attachment-alert-classified")
        defer { session.close() }
        let viewModel = makeViewModel(session)

        viewModel.reportAttachmentImportFailure(
            source: .photos,
            error: CocoaError(.fileReadCorruptFile)
        )

        #expect(viewModel.attachmentImportAlert?.reason == .unreadable)
        #expect(viewModel.attachmentImportAlert?.message.contains("couldn't be read") == true)

        viewModel.reportAttachmentImportFailure(
            source: .files,
            error: CocoaError(.fileReadTooLarge)
        )

        #expect(viewModel.attachmentImportAlert?.reason == .sourceTooLarge)
        #expect(viewModel.attachmentImportAlert?.message.contains("too large") == true)
    }

    @Test func cancellationIsSilentAndDoesNotReplaceCurrentAlert() {
        let session = makeSession("attachment-alert-cancel")
        defer { session.close() }
        let viewModel = makeViewModel(session)

        viewModel.reportAttachmentImportFailure(
            source: .files,
            error: CocoaError(.fileReadUnsupportedScheme)
        )
        let alert = viewModel.attachmentImportAlert

        viewModel.reportAttachmentImportFailure(source: .files, error: CancellationError())

        #expect(viewModel.attachmentImportAlert == alert)
    }

    @Test func explicitDismissalClearsAlert() {
        let session = makeSession("attachment-alert-dismiss")
        defer { session.close() }
        let viewModel = makeViewModel(session)

        viewModel.reportAttachmentImportFailure(source: .camera, error: AttachmentImportPickerIssue.cameraDenied)
        let generation = viewModel.attachmentImportAlert?.generation
        #expect(generation != nil)

        viewModel.dismissAttachmentImportAlert(generation: generation ?? 0)

        #expect(viewModel.attachmentImportAlert == nil)
        #expect(viewModel.draftSaveError == nil)
    }

    @Test func staleDismissalCannotClearNewerAlert() throws {
        let session = makeSession("attachment-alert-stale-dismiss")
        defer { session.close() }
        let viewModel = makeViewModel(session)

        viewModel.reportAttachmentImportFailure(
            source: .files,
            error: CocoaError(.fileReadUnsupportedScheme)
        )
        let first = try #require(viewModel.attachmentImportAlert)

        viewModel.reportAttachmentImportFailure(
            source: .photos,
            error: CocoaError(.fileReadTooLarge)
        )
        let second = try #require(viewModel.attachmentImportAlert)

        viewModel.dismissAttachmentImportAlert(generation: first.generation)

        #expect(viewModel.attachmentImportAlert == second)
        #expect(viewModel.draftSaveError == second.message)
        viewModel.dismissAttachmentImportAlert(generation: second.generation)
        #expect(viewModel.attachmentImportAlert == nil)
        #expect(viewModel.draftSaveError == nil)
    }

    @Test func newerAlertIsNextOnlyAfterVisibleAlertDismisses() throws {
        let first = AttachmentImportAlert(
            generation: 1,
            source: .files,
            reason: .unreadable
        )
        let second = AttachmentImportAlert(
            generation: 2,
            source: .photos,
            reason: .sourceTooLarge
        )

        #expect(nextAttachmentImportAlertAfterDismissal(
            dismissedGeneration: first.generation,
            current: second,
            pickerPresented: false
        ) == second)
        #expect(nextAttachmentImportAlertAfterDismissal(
            dismissedGeneration: first.generation,
            current: second,
            pickerPresented: true
        ) == nil)
    }

    @Test func repeatedFailuresKeepNewestGenerationAndReason() {
        let session = makeSession("attachment-alert-repeat")
        defer { session.close() }
        let viewModel = makeViewModel(session)

        viewModel.reportAttachmentImportFailure(
            source: .files,
            error: CocoaError(.fileReadUnsupportedScheme)
        )
        let firstGeneration = viewModel.attachmentImportAlert?.generation

        viewModel.reportAttachmentImportFailure(
            source: .photos,
            error: CocoaError(.fileReadTooLarge)
        )
        let latest = viewModel.attachmentImportAlert

        #expect(firstGeneration != nil)
        #expect((latest?.generation ?? 0) > (firstGeneration ?? 0))
        #expect(latest?.source == .photos)
        #expect(latest?.reason == .sourceTooLarge)
    }

    @Test func olderImportFailureCannotReplaceNewerPickerAlert() async throws {
        let session = makeSession("attachment-alert-race")
        defer { session.close() }
        let started = AlertGate()
        let release = AlertGate()
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("sentient-alert-race-\(UUID().uuidString).txt")
        try Data("fixture".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }

        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false,
            importDraftAttachment: { _, _, _ in
                await started.open()
                await release.wait()
                throw CocoaError(.fileReadCorruptFile)
            }
        )

        viewModel.importAttachments([.temporary(source)])
        await started.wait()
        viewModel.reportAttachmentImportFailure(
            source: .photos,
            error: CocoaError(.fileReadUnsupportedScheme)
        )
        let newerAlert = try #require(viewModel.attachmentImportAlert)

        let navigation = Task { await viewModel.saveDraftBeforeNavigation() }
        await release.open()
        _ = await navigation.value

        #expect(viewModel.attachmentImportAlert == newerAlert)
        #expect(viewModel.attachmentImportAlert?.reason == .unsupportedType)
    }

    @Test func draftSaveFailureStaysOutOfAttachmentAlert() async {
        let session = makeSession("attachment-alert-draft-save")
        defer { session.close() }
        let viewModel = ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false,
            saveDraftText: { _, _, _ in throw AlertTestError.failed }
        )

        _ = await viewModel.saveDraftBeforeNavigation()

        #expect(viewModel.attachmentImportAlert == nil)
        #expect(viewModel.draftSaveError == "Draft couldn't be saved. Keep this screen open and retry.")
    }

    private func makeSession(_ suffix: String) -> IosUserSession {
        createUserSession(
            gatewayWsUrl: "wss://localhost:18889/api/v1/ws",
            allowSelfSignedDevHost: true,
            authenticatedUserId: "\(suffix)-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
    }

    private func makeViewModel(_ session: IosUserSession) -> ChatViewModel {
        ChatViewModel(
            component: session.component,
            sessionId: "session-one",
            activateOnInit: false,
            observeChatOnInit: false
        )
    }
}

private enum AlertTestError: Error {
    case failed
}

private actor AlertGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        guard !isOpen else { return }
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}
