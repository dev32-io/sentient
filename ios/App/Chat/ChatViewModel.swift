// ---------------------------------------------------------------------------
// ChatViewModel — thin per-conversation state holder over the shared usecase
// layer (ChatComponent). Swift mirror of Android's ChatViewModel.
//
// Takes the User/Connection-scoped ChatComponent + the route's sessionId (null =
// new chat). On init it switches the active conversation to sessionId, then folds
// observeChat(cache.pending) → @Published ChatUiState. The optimistic outbox
// (OutboundCache) is per-conversation: it lives and dies with this VM, so
// switching conversation = a fresh route-keyed VM = clean state.
//
// Lifecycle (open / close / pause / resume) is owned by UserSession, NOT here — a
// VM teardown on conversation switch must NEVER disconnect the SDK. deinit only
// cancels this VM's collection tasks.
//
// Shared drain observes real connection, route authority, and pending entries in
// this VM's scope. Reconcile-by-pendingId removes committed optimistic copies.
//
// SKIE bridges Kotlin Flows as AsyncSequence (for await) and usecases'
// `operator fun invoke` as `.invoke(...)`. @MainActor: all @Published mutation on
// the main actor; the for-await resumes on the calling actor.
// ---------------------------------------------------------------------------
import Foundation
import os
import ImageIO
import MobileData
import UIKit
import UniformTypeIdentifiers

struct AttachmentTransferState: Equatable {
    enum Phase { case queued, ready, uploading, failed, cancelled }
    let phase: Phase
    var progress: Double = 0
}

struct PendingAttachmentPresentation {
    let attachments: [NativeDraftAttachment]
    let previews: [String: UIImage]
    let transfers: [String: AttachmentTransferState]
}

func pendingAttachmentProjection(
    pending: [NativePendingSend],
    previews: [String: UIImage],
    transfers: [String: AttachmentTransferState]
) -> [String: PendingAttachmentPresentation] {
    Dictionary(uniqueKeysWithValues: pending.map { send in
        let ids = Set(send.attachments.map(\.id))
        return (
            send.pendingId,
            PendingAttachmentPresentation(
                attachments: send.attachments,
                previews: previews.filter { ids.contains($0.key) },
                transfers: Dictionary(uniqueKeysWithValues: send.attachments.map { ($0.id, transfers[$0.id] ?? AttachmentTransferState(phase: .queued)) })
            )
        )
    })
}

func pendingAttachmentCleanup(
    ownedAttachmentIds: Set<String>,
    attachments: [NativeDraftAttachment],
    transfers: [String: AttachmentTransferState]
) -> (attachments: [NativeDraftAttachment], transfers: [String: AttachmentTransferState]) {
    (
        attachments.filter { !ownedAttachmentIds.contains($0.id) },
        transfers.filter { !ownedAttachmentIds.contains($0.key) }
    )
}

func applyingUploadProgress(
    to current: AttachmentTransferState?,
    sent: Int64,
    total: Int64
) -> AttachmentTransferState? {
    guard current?.phase == .uploading else { return current }
    return AttachmentTransferState(
        phase: .uploading,
        progress: total > 0 ? Double(sent) / Double(total) : 0
    )
}

func failingActiveUploads(
    _ transfers: [String: AttachmentTransferState]
) -> [String: AttachmentTransferState] {
    transfers.mapValues { state in
        state.phase == .uploading ? AttachmentTransferState(phase: .failed) : state
    }
}

func cancellingActiveUploads(
    _ transfers: [String: AttachmentTransferState]
) -> [String: AttachmentTransferState] {
    transfers.mapValues { state in
        state.phase == .uploading ? AttachmentTransferState(phase: .cancelled) : state
    }
}

func activeImageAttachmentIds(
    draft: [NativeDraftAttachment],
    pending: [NativeDraftAttachment]
) -> Set<String> {
    Set((draft + pending).lazy.filter {
        $0.mediaType.hasPrefix("image/") || $0.mediaType == "application/vnd.sentient.live-photo+zip"
    }.map(\.id))
}

func decodedAttachmentThumbnail(_ data: Data, maxPixelSize: Int = 640) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
              kCGImageSourceCreateThumbnailFromImageAlways: true,
              kCGImageSourceCreateThumbnailWithTransform: true,
              kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
              kCGImageSourceShouldCacheImmediately: true,
          ] as CFDictionary) else { return nil }
    return UIImage(cgImage: image)
}

func decodedImageCost(_ image: UIImage) -> Int {
    guard let image = image.cgImage else { return 0 }
    return image.bytesPerRow * image.height
}

private struct DraftMutationTarget: Equatable {
    let draftId: String?
    let sessionId: String?
    let epoch: Int
}

func validatedAttachmentPreviewHandoff(
    pending: [NativeDraftAttachment],
    refs: [AttachmentRef]
) -> [(localId: String, serverId: String)]? {
    guard pending.count == refs.count else { return nil }
    let pairs = zip(pending, refs)
    guard Set(refs.map(\.attachmentId)).count == refs.count,
          pairs.allSatisfy({ local, remote in
              !remote.attachmentId.isEmpty &&
              local.displayName == remote.displayName &&
              local.mediaType == remote.contentType &&
              local.sizeBytes == remote.size
          }) else { return nil }
    return zip(pending, refs).map { ($0.id, $1.attachmentId) }
}

func attachmentImportRecoveryDraft(
    drafts: [NativeDraft],
    committedDraftId: String?,
    routeDraftId: String?,
    routeSessionId: String?,
    baselineDraftIds: Set<String>?
) -> NativeDraft? {
    if let committedDraftId {
        return drafts.first { $0.id == committedDraftId }
    }
    if let routeDraftId {
        return drafts.first { $0.id == routeDraftId }
    }
    if let routeSessionId {
        return drafts.first { $0.sessionId == routeSessionId }
    }
    guard let baselineDraftIds else { return nil }
    let newDrafts = drafts.filter { !baselineDraftIds.contains($0.id) }
    return newDrafts.count == 1 ? newDrafts[0] : nil
}

private enum AttachmentImportDiagnosticStage: String {
    case admission, preparation, metadata, copy, commit, failure
}

private enum AttachmentImportDiagnosticCode: String {
    case accepted, empty, sendInProgress = "send_in_progress"
    case storageUnavailable = "storage_unavailable", limit
    case start, complete
    case unsupportedType = "unsupported_type", cancelled
    case preparation, metadata, copy, commit, picker, unknown
    case unreadable
    case sourceMissing = "source_missing", sourceTooLarge = "source_too_large"
    case localCopy = "local_copy", conflict, timeout
    case denied, restricted, unavailable, captureFailed = "capture_failed"
}

@MainActor
final class ChatViewModel: ObservableObject {
    /// Single chat UI state snapshot (committed + pending + live + banner).
    @Published private(set) var state = ChatUiState()
    @Published private(set) var draftText = ""
    @Published private(set) var draftAttachments: [NativeDraftAttachment] = [] {
        didSet { syncDraftAttachmentPreviews() }
    }
    @Published private(set) var pendingAttachments: [NativeDraftAttachment] = [] {
        didSet { syncDraftAttachmentPreviews() }
    }
    @Published private(set) var draftAttachmentPreviews: [String: UIImage] = [:]
    @Published private(set) var draftAttachmentPreviewFailures: Set<String> = []
    @Published private(set) var pendingAttachmentImportCount = 0
    @Published private(set) var attachmentTransfers: [String: AttachmentTransferState] = [:]
    @Published private(set) var attachmentPreviews: [String: UIImage] = [:]
    @Published private(set) var attachmentPreviewFailures: Set<String> = []
    @Published private(set) var receiptAcknowledgmentFailures: Set<String> = []
    @Published private(set) var downloadedAttachmentFiles: [String: URL] = [:]
    @Published private(set) var attachmentDownloadFailures: Set<String> = []
    @Published private(set) var draftSaveError: String?
    @Published private(set) var attachmentImportAlert: AttachmentImportAlert?

    /// Transport + voice axis. Drives the connection banner + composer state.
    @Published private(set) var connection: ConnectionState = makeDisconnectedConnection()

    /// Talk mode (Idle | Hold | Continuous), owned by the SDK's TalkModeController. Exposed
    /// for the keep-screen-on derivation below (and its reason logging in ChatView).
    @Published private(set) var talkMode: TalkMode = .idle
    @Published var captureFailure: SdkEvent.CaptureStartFailed?
    var captureFailureId: String? { captureFailure?.captureId }
    @Published private(set) var micLevels: [Float] = Array(repeating: 0, count: 32)

    /// Temporary keep-screen-on condition (S8): `Continuous talk mode OR the assistant is
    /// audibly speaking`. Reuses the EXACT `connection.isSpeaking` signal that drives the
    /// existing speaking visuals (BubbleSpeakingWave) — not a new signal. TTS frames
    /// buffered during a Hold are NOT "speaking" until they actually play after release,
    /// which is the desired semantics here too. Hold itself does not force screen-on: the
    /// user's finger on the screen already keeps it awake.
    ///
    /// Pure derivation — no side effects, no logging — so it stays the testable seam.
    /// ChatView applies `UIApplication.shared.isIdleTimerDisabled` and owns every clear
    /// path (condition-false, view disappearing, scene backgrounding), logging the reason
    /// for each transition there.
    @Published private(set) var keepScreenOn = false

    /// Outstanding L3 permission-confirm prompt (design spec §7.1), or nil. Single
    /// active prompt per session — SessionRuntime blocks the turn on it, so the SDK's
    /// open-prompt list is at most one deep in practice; this holds its head.
    @Published private(set) var pendingPermission: PermissionPrompt?

    private let component: ChatComponent
    private let previewAttachment: (String) async throws -> Data
    private let saveDraftText: ((String?, String?, String) async throws -> NativeDraft?)?
    private let importDraftAttachment: ((String?, String?, NativeDraftAttachmentImport) async throws -> NativeDraft)?
    private let prepareDraftAttachment: (AttachmentImportItem) async throws -> AttachmentImportItem
    private let uploadPendingAttachments: ((NativePendingSend, KotlinLong?, (String, KotlinLong, KotlinLong) -> Void) async throws -> [AttachmentRef])?
    private let cancelPendingSend: (NativePendingSend) async throws -> NativeDraft
    private let acknowledgeReceipt: (String, String) async throws -> NativeSendReconciliationResult
    private let onDraftRouteChanged: (String, String, String?) -> Void
    private var routeSessionId: String?
    private var routeDraftId: String?
    private var draftEdited = false
    /// Per-conversation optimistic outbox. Dies with this VM (conversation switch).
    /// Built via the createOutboundCache() factory: SKIE doesn't synthesise a zero-arg
    /// init() for OutboundCache's all-default Kotlin constructor, so the factory hands
    /// Swift the same system-clock + default-timeout cache Android gets from OutboundCache().
    private let cache = createOutboundCache()
    @Published private(set) var routeActivationSuspended = false
    private var awaitingRouteProjection = false
    private var retainedRouteSessionId: String?

    /// Keep original timeline/editor visible while SDK authorizes another route.
    /// Editing and local persistence continue; no command may borrow destination authority.
    func suspendRouteForActivation() {
        guard !editorRetired, !routeActivationSuspended else { return }
        if !awaitingRouteProjection {
            retainedRouteSessionId = routeSessionId ?? component.existingSessionId
        }
        routeActivationSuspended = true
        awaitingRouteProjection = true
        chatTask?.cancel()
        coldReplaceTask?.cancel()
        permissionTask?.cancel()
        acceptanceTask?.cancel()
        pendingSendTask?.cancel()
    }

    func restoreRouteAfterActivation() {
        guard !editorRetired, routeActivationSuspended else { return }
        component.restoreChatRoute(cache: cache, sessionId: retainedRouteSessionId, draftId: routeDraftId)
        routeActivationSuspended = false
        resumeRouteProjectionIfReady()
    }

    private func resumeRouteProjectionIfReady() {
        guard awaitingRouteProjection, !routeActivationSuspended,
              component.canDrainPending(cache: cache) else { return }
        awaitingRouteProjection = false
        startChatCollecting()
        startColdReplaceCollecting()
        startPermissionCollecting()
    }

    private var chatTask: Task<Void, Never>?
    private var outboundTask: Task<Void, Never>?
    private var connectionTask: Task<Void, Never>?
    private var talkModeTask: Task<Void, Never>?
    private var captureFailureTask: Task<Void, Never>?
    private var micLevelsTask: Task<Void, Never>?
    private var coldReplaceTask: Task<Void, Never>?
    private var sweepTask: Task<Void, Never>?
    private var reopenFailedTask: Task<Void, Never>?
    private var permissionTask: Task<Void, Never>?
    /// Local defensive countdown to a shown prompt's expiresAtMs. Re-armed per prompt;
    /// cancelled on any of: a new prompt replacing it, the server resolving it, or the
    /// user answering it locally.
    private var permissionTimeoutTask: Task<Void, Never>?
    private var receiptAcknowledgmentTasks: [String: Task<Void, Never>] = [:]
    private var handledReceiptIds: Set<String> = []
    private var receiptRouteFence = 0
    private var draftRestoreTask: Task<Void, Never>?
    private var draftSaveTask: Task<Void, Never>?
    private var discardedDraftsTask: Task<Void, Never>?
    private var discardedDraftIds: Set<String> = []
    private var hasUnresolvedDraftMutation = false
    private var draftMutationEpoch = 0
    private let draftMutationBarrier = DraftMutationBarrier()
    private var nextAttachmentImportGeneration = 0
    private var lastAttachmentImportFailureGeneration: Int?
    private var acknowledgedAttachmentImportFailureGeneration: Int?
    private var pendingSendTask: Task<Void, Never>?
    private var acceptanceTask: Task<Void, Never>?
    private var pendingSnapshotTask: Task<Void, Never>?
    private let editorId = UUID().uuidString
    private var editorRetired = false
    private var draftRestoreSettled = false
    private var editorRevision = 0
    private var activePendingId: String?
    private var editingPending = false
    private var retryPendingIds: Set<String> = []
    @Published private var durablePending: [NativePendingSend] = []
    @Published private var blockedPendingIds: Set<String> = []
    @Published private(set) var preparingSend = false

    private var selectedPending: [NativePendingSend] {
        durablePending.filter {
            (routeDraftId != nil && $0.draftId == routeDraftId) ||
            (routeSessionId != nil && $0.sessionId == routeSessionId)
        }
    }

    var pendingMessages: [PendingMessage] {
        let confirmed = Set(state.model.committed.compactMap(\.pendingId))
        let transport = Dictionary(uniqueKeysWithValues: cache.pending.value.map { ($0.id, $0) })
        return selectedPending.filter { !confirmed.contains($0.pendingId) }.map { send in
            if let cached = transport[send.pendingId] { return cached }
            let needsRetry = blockedPendingIds.contains(send.pendingId) ||
                (send.attempted && activePendingId != send.pendingId)
            return PendingMessage(
                id: send.pendingId, text: send.text,
                status: needsRetry ? .failed : .queued,
                sentAtMs: nil, attachmentIds: [],
                deliveryState: needsRetry ? .unknown : .queued, rejectionReason: nil
            )
        }
    }

    private func startPendingSnapshotCollecting() {
        guard let drafts = component.drafts else { return }
        pendingSnapshotTask = Task { [weak self] in
            for await snapshot in drafts.snapshot {
                guard let self, !Task.isCancelled, !self.editorRetired else { return }
                self.durablePending = snapshot.pendingSends
                self.drainPending()
            }
        }
    }

    private func drainPending() {
        guard !editorRetired, !routeActivationSuspended, !editingPending, draftRestoreSettled,
              receiptAcknowledgmentTasks.isEmpty, pendingSendTask == nil,
              let head = selectedPending.first,
              !blockedPendingIds.contains(head.pendingId),
              !cache.pending.value.contains(where: { $0.id == head.pendingId }),
              component.canDrainPending(cache: cache),
              !head.attempted || retryPendingIds.contains(head.pendingId) else { return }
        startPendingUpload(head)
    }

    /// True route retirement, not temporary SwiftUI disappearance.
    func retireEditor() {
        guard !editorRetired else { return }
        editorRetired = true
        component.drafts?.retireEditor(editorId: editorId)
        invalidateDraftMutations()
        draftMutationBarrier.cancelAll()
        receiptRouteFence &+= 1
        acceptanceTask?.cancel()
        pendingSnapshotTask?.cancel()
        pendingSendGeneration = nil
        pendingSendTask?.cancel()
        draftSaveTask?.cancel()
        draftRestoreTask?.cancel()
        chatTask?.cancel()
        connectionTask?.cancel()
        outboundTask?.cancel()
        coldReplaceTask?.cancel()
        sweepTask?.cancel()
        sessionChangesTask?.cancel()
        discardedDraftsTask?.cancel()
        receiptAcknowledgmentTasks.values.forEach { $0.cancel() }
        talkModeTask?.cancel()
        captureFailureTask?.cancel()
        micLevelsTask?.cancel()
        reopenFailedTask?.cancel()
        permissionTask?.cancel()
        permissionTimeoutTask?.cancel()
        draftAttachmentPreviewTasks.values.forEach { $0.cancel() }
        attachmentPreviewTasks.values.forEach { $0.cancel() }
        attachmentDownloadTasks.values.forEach { $0.cancel() }
    }
    private var pendingSendGeneration: UUID?
    private var draftAttachmentPreviewTasks: [String: Task<Void, Never>] = [:]
    private var attachmentPreviewTasks: [String: Task<Void, Never>] = [:]
    private var visibleAttachmentPreviewIds: Set<String> = []
    private var attemptedVisibleAttachmentPreviewIds: Set<String> = []
    private var pinnedAttachmentPreviewIds: Set<String> = []
    private var pinnedAttachmentPreviewIdsByPendingId: [String: Set<String>] = [:]
    private var attachmentPreviewCosts: [String: Int] = [:]
    private var attachmentPreviewRecency: [String] = []
    private var attachmentDownloadTasks: [String: Task<Void, Never>] = [:]
    private nonisolated(unsafe) var transientDownloadPaths: Set<String> = []
    private var sessionChangesTask: Task<Void, Never>?
    private let log = AppLog("chat", "viewmodel")

    /// Periodic outbox-sweep interval (unacked-timeout detection) in nanoseconds.
    private static let sweepIntervalNs: UInt64 = 1_000_000_000
    /// Auto-dismiss interval for the ReopenFailed notice (spec §14) in nanoseconds.
    private static let reopenFailedAutoDismissNs: UInt64 = 4_000_000_000
    /// Nanoseconds per millisecond, for converting the wire's expiresAtMs into a
    /// Task.sleep(nanoseconds:) duration.
    private static let nsPerMs: UInt64 = 1_000_000
    nonisolated private static let markdownType = UTType(importedAs: "net.daringfireball.markdown")
    nonisolated private static let imageMediaTypesByExtension = [
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "heic": "image/heic", "heif": "image/heif", "avif": "image/avif",
        "webp": "image/webp", "gif": "image/gif", "tif": "image/tiff",
        "tiff": "image/tiff", "bmp": "image/bmp", "jp2": "image/jp2",
        "j2k": "image/jp2", "j2c": "image/jp2", "jpc": "image/jp2",
        "jpf": "image/jp2", "jpx": "image/jp2", "jpm": "image/jp2",
        "jxl": "image/jxl",
    ]
    nonisolated private static let canonicalImageExtensions = [
        "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic",
        "image/heif": "heif", "image/avif": "avif", "image/webp": "webp",
        "image/gif": "gif", "image/tiff": "tiff", "image/bmp": "bmp",
        "image/jp2": "jp2", "image/jxl": "jxl",
    ]
    private static let draftPreviewMaxPixelSize: Int32 = 640
    static let attachmentPreviewRequestLimit = 3
    // Viewport and pending-send previews are active ownership; only offscreen LRU entries use this budget.
    static let attachmentPreviewOffscreenCountLimit = 8
    static let attachmentPreviewOffscreenCostLimit = 16 * 1_024 * 1_024
    private static let pendingAttachmentPreviewPinLimit = 8
    private static let receiptAcknowledgmentMaxAttempts = 3
    private static let receiptAcknowledgmentRetryDelaysNs: [UInt64] = [50_000_000, 100_000_000]

    var attachmentPreviewRequestCount: Int { attachmentPreviewTasks.count }
    var attachmentPreviewOffscreenCount: Int { offscreenAttachmentPreviewIds.count }
    var attachmentPreviewOffscreenCost: Int {
        offscreenAttachmentPreviewIds.reduce(0) { $0 + (attachmentPreviewCosts[$1] ?? 0) }
    }
    var pinnedAttachmentPreviewCount: Int { pinnedAttachmentPreviewIds.count }

    var pendingAttachmentPresentations: [String: PendingAttachmentPresentation] {
        pendingAttachmentProjection(
            pending: selectedPending,
            previews: draftAttachmentPreviews,
            transfers: attachmentTransfers
        )
    }

    func pendingAttachment(for id: String) -> NativeDraftAttachment? {
        pendingAttachmentPresentations.values
            .flatMap(\.attachments)
            .first { $0.id == id }
    }

    nonisolated static func imageMediaType(forExtension pathExtension: String) -> String? {
        imageMediaTypesByExtension[pathExtension.lowercased()]
    }

    nonisolated static func canonicalImageExtension(for mediaType: String) -> String? {
        canonicalImageExtensions[mediaType]
    }

    nonisolated static func attachmentMediaType(for type: UTType) -> String? {
        if let ext = type.preferredFilenameExtension,
           let mediaType = imageMediaType(forExtension: ext) { return mediaType }
        if type.conforms(to: .pdf) { return "application/pdf" }
        if type.conforms(to: markdownType) { return "text/markdown" }
        if type.conforms(to: .commaSeparatedText) { return "text/csv" }
        if type.conforms(to: .plainText) || type.conforms(to: .sourceCode) || type.conforms(to: .json) {
            return "text/plain"
        }
        return nil
    }

    nonisolated static func attachmentMediaType(forExtension pathExtension: String) -> String? {
        guard let type = UTType(filenameExtension: pathExtension.lowercased()) else { return nil }
        return attachmentMediaType(for: type)
    }

    init(
        component: ChatComponent,
        sessionId: String?,
        draftId: String? = nil,
        activateOnInit: Bool = true,
        observeChatOnInit: Bool = true,
        previewAttachment: ((String) async throws -> Data)? = nil,
        saveDraftText: ((String?, String?, String) async throws -> NativeDraft?)? = nil,
        importDraftAttachment: ((String?, String?, NativeDraftAttachmentImport) async throws -> NativeDraft)? = nil,
        prepareDraftAttachment: @escaping (AttachmentImportItem) async throws -> AttachmentImportItem = AttachmentDNGImport.prepareIfNeeded,
        uploadPendingAttachments: ((NativePendingSend, KotlinLong?, (String, KotlinLong, KotlinLong) -> Void) async throws -> [AttachmentRef])? = nil,
        cancelPendingSend: ((NativePendingSend) async throws -> NativeDraft)? = nil,
        onDraftRouteChanged: @escaping (String, String, String?) -> Void = { _, _, _ in },
        acknowledgeReceipt: ((String, String) async throws -> NativeSendReconciliationResult)? = nil
    ) {
        self.component = component
        self.previewAttachment = previewAttachment ?? { id in
            try await component.previewAttachment(attachmentId: id).toData()
        }
        self.saveDraftText = saveDraftText
        self.importDraftAttachment = importDraftAttachment
        self.prepareDraftAttachment = prepareDraftAttachment
        self.uploadPendingAttachments = uploadPendingAttachments
        self.cancelPendingSend = cancelPendingSend ?? { try await component.cancelPendingSendIntoEmptyEditor(pending: $0) }
        self.acknowledgeReceipt = acknowledgeReceipt ?? { pendingId, sessionId in
            guard let drafts = component.drafts else { throw CocoaError(.fileReadNoSuchFile) }
            return try await drafts.acknowledge(pendingId: pendingId, sessionId: sessionId)
        }
        self.onDraftRouteChanged = onDraftRouteChanged
        self.routeSessionId = sessionId
        self.routeDraftId = draftId
        log.info("init sessionId=\(sessionId ?? "<new>")")

        // Bind this VM-owned cache to one route generation. Notification/deep-link
        // routes reuse the generation claimed by their acknowledged activation.
        component.bindChatRoute(
            cache: cache,
            sessionId: sessionId,
            draftId: draftId,
            activate: activateOnInit
        )

        if observeChatOnInit { startChatCollecting() }
        startConnectionCollecting()
        let outbound = component.observeOutbound(cache: cache)
        outboundTask = Task { [weak self] in
            for await _ in outbound {
                guard let self else { return }
                // This stream includes route-generation changes, including remote delete.
                // Delivery-time filtering alone cannot revoke an already visible notice.
                if let failure = self.captureFailure,
                   !self.component.isCaptureStartFailureCurrent(event: failure) {
                    self.captureFailure = nil
                }
                guard !Task.isCancelled, !self.editorRetired else { return }
                guard !self.routeActivationSuspended else { continue }
                self.resumeRouteProjectionIfReady()
                self.component.flushOutbound(cache: self.cache)
                self.drainPending()
            }
        }
        startTalkModeCollecting()
        startCaptureFailureCollecting()
        startMicLevelsCollecting()
        startColdReplaceCollecting()
        startPeriodicSweep()
        startReopenFailedCollecting()
        startPermissionCollecting()
        startSessionChangesCollecting()
        startDiscardedDraftCollecting()
        startPendingSnapshotCollecting()
        restoreDraft()
    }

    // ── Public actions ────────────────────────────────────────────────────────

    func updateDraft(_ text: String) {
        guard !editorRetired, text != draftText else { return }
        editorRevision &+= 1
        let target = draftMutationTarget()
        draftEdited = true
        draftText = text
        draftSaveTask?.cancel()
        draftSaveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard let self, !Task.isCancelled else { return }
            self.draftMutationBarrier.enqueue { [weak self] in
                guard let self, !Task.isCancelled else { return }
                _ = await self.saveDraft(text, target: target)
            }
        }
    }

    func importAttachments(_ items: [AttachmentImportItem]) {
        enqueueAttachmentImport(
            count: items.count,
            source: .combined(items),
            prepare: { items },
            onReject: { Self.removeOwnedTemporaryFiles(items) }
        )
    }

    func prepareAttachments(_ request: AttachmentImportRequest) {
        enqueueAttachmentImport(
            count: request.count,
            source: request.source,
            prepare: request.prepare
        )
    }

    func reportAttachmentImportFailure(
        source: AttachmentImportSource,
        error: Error? = nil
    ) {
        let reason = attachmentImportFailureReason(for: error)
        guard reason != .cancelled else { return }
        let generation = recordAttachmentImportFailure()
        presentAttachmentImportAlert(source: source, reason: reason, generation: generation)
        logAttachmentImport(
            stage: .failure,
            source: source,
            count: 0,
            code: Self.attachmentImportDiagnosticCode(for: reason),
            warning: true
        )
    }

    func dismissAttachmentImportAlert(generation: Int) {
        guard let alert = attachmentImportAlert, alert.generation == generation else { return }
        if draftSaveError == alert.message { draftSaveError = nil }
        attachmentImportAlert = nil
    }

    private func presentAttachmentImportAlert(
        source: AttachmentImportSource,
        reason: AttachmentImportFailureReason,
        generation: Int
    ) {
        let alert = AttachmentImportAlert(
            generation: generation,
            source: source,
            reason: reason
        )
        attachmentImportAlert = alert
        draftSaveError = alert.message
    }

    @discardableResult
    private func recordAttachmentImportFailure() -> Int {
        nextAttachmentImportGeneration += 1
        lastAttachmentImportFailureGeneration = nextAttachmentImportGeneration
        return nextAttachmentImportGeneration
    }

    private func recordAttachmentImportFailure(generation: Int) -> Bool {
        guard generation > (lastAttachmentImportFailureGeneration ?? Int.min) else { return false }
        lastAttachmentImportFailureGeneration = generation
        return true
    }

    private func enqueueAttachmentImport(
        count: Int,
        source: AttachmentImportSource,
        prepare: @escaping () async throws -> [AttachmentImportItem],
        onReject: @escaping () -> Void = {}
    ) {
        let target = draftMutationTarget()
        let remaining = AttachmentImportPolicy.remaining(
            existing: draftAttachments.count,
            pending: pendingAttachmentImportCount
        )
        logAttachmentImport(stage: .admission, source: source, count: count, code: .start)
        guard count > 0 else {
            onReject()
            logAttachmentImport(stage: .admission, source: source, count: count, code: .empty)
            return
        }
        guard !editorRetired, !preparingSend, !editingPending else {
            onReject()
            let generation = recordAttachmentImportFailure()
            presentAttachmentImportAlert(
                source: source,
                reason: .sendInProgress,
                generation: generation
            )
            logAttachmentImport(
                stage: .admission,
                source: source,
                count: count,
                code: .sendInProgress,
                warning: true
            )
            return
        }
        guard let drafts = component.drafts else {
            onReject()
            let generation = recordAttachmentImportFailure()
            presentAttachmentImportAlert(
                source: source,
                reason: .storageUnavailable,
                generation: generation
            )
            logAttachmentImport(
                stage: .admission,
                source: source,
                count: count,
                code: .storageUnavailable,
                warning: true
            )
            return
        }
        guard AttachmentImportPolicy.accepts(
            selectionCount: count,
            existing: draftAttachments.count,
            pending: pendingAttachmentImportCount
        ) else {
            onReject()
            let generation = recordAttachmentImportFailure()
            presentAttachmentImportAlert(
                source: source,
                reason: .limit,
                generation: generation
            )
            draftSaveError = remaining == 0
                ? "Remove an attachment before adding another."
                : "You can add only \(remaining) more attachment\(remaining == 1 ? "" : "s")."
            logAttachmentImport(
                stage: .admission,
                source: source,
                count: count,
                code: .limit,
                warning: true
            )
            return
        }
        logAttachmentImport(stage: .admission, source: source, count: count, code: .accepted)

        nextAttachmentImportGeneration += 1
        let generation = nextAttachmentImportGeneration
        let failureKnownWhenQueued = lastAttachmentImportFailureGeneration
        draftEdited = true
        pendingAttachmentImportCount += count
        draftMutationBarrier.enqueue { [weak self] in
            var outstandingReservations = count
            var capturedDraftId = target.draftId
            var capturedSessionId = target.sessionId
            var stage: AttachmentImportDiagnosticStage = .preparation
            var diagnosticSource = source
            var diagnosticType: String?
            var committedDraft: NativeDraft?
            var baselineDraftIds: Set<String>? = nil
            var routeIsActive: (@MainActor () -> Bool)?
            defer { self?.pendingAttachmentImportCount -= outstandingReservations }
            guard let self, self.isCurrentDraftMutationTarget(target) else { onReject(); return }
            do {
                self.logAttachmentImport(
                    stage: .preparation,
                    source: source,
                    count: count,
                    code: .start
                )
                let items = try await prepare()
                self.logAttachmentImport(
                    stage: .preparation,
                    source: source,
                    count: items.count,
                    code: .complete
                )
                try await withAttachmentImportCleanup(items) {
                    try Task.checkCancellation()
                    guard items.count == count else { throw CocoaError(.coderInvalidValue) }
                    for item in items {
                        try Task.checkCancellation()
                        guard self.isCurrentDraftMutationTarget(target) else { throw CancellationError() }
                        let expectedDraftId = capturedDraftId ?? self.routeDraftId
                        let expectedSessionId = capturedSessionId ?? self.routeSessionId
                        let expectedRouteGeneration = self.component.outboundRouteGeneration.value
                        routeIsActive = { [weak self] in
                            guard let self else { return false }
                            return self.isCurrentDraftMutationTarget(target) &&
                                self.routeDraftId == expectedDraftId &&
                                self.routeSessionId == expectedSessionId &&
                                self.component.outboundRouteGeneration.value == expectedRouteGeneration
                        }
                        if let baseline = try? await drafts.restore() {
                            baselineDraftIds = Set(baseline.drafts.map(\.id))
                        } else {
                            baselineDraftIds = nil
                        }
                        committedDraft = nil
                        diagnosticSource = item.source == .unknown ? source : item.source
                        diagnosticType = nil
                        stage = .metadata
                        let saved = try await withAttachmentSecurityScope(item.url) {
                            let preparedItem = try await self.prepareDraftAttachment(item)
                            defer {
                                for url in preparedItem.ownedTemporaryURLs.subtracting(item.ownedTemporaryURLs) {
                                    try? FileManager.default.removeItem(at: url)
                                }
                            }
                            self.logAttachmentImport(
                                stage: .metadata,
                                source: diagnosticSource,
                                count: count,
                                code: .start
                            )
                            try Task.checkCancellation()
                            guard self.isCurrentDraftMutationTarget(target) else { throw CancellationError() }
                            let values = try preparedItem.url.resourceValues(forKeys: [.contentTypeKey, .nameKey])
                            let mediaType = preparedItem.mediaType
                                ?? values.contentType.flatMap(Self.attachmentMediaType(for:))
                                ?? Self.attachmentMediaType(forExtension: preparedItem.url.pathExtension)
                            guard let mediaType else {
                                self.logAttachmentImport(
                                    stage: .metadata,
                                    source: diagnosticSource,
                                    count: count,
                                    code: .unsupportedType
                                )
                                throw CocoaError(.fileReadUnsupportedScheme)
                            }
                            diagnosticType = mediaType
                            self.logAttachmentImport(
                                stage: .metadata,
                                source: diagnosticSource,
                                count: count,
                                mediaType: mediaType,
                                code: .complete
                            )
                            let source = NativeDraftAttachmentImport(
                                sourceLocation: preparedItem.url.absoluteString,
                                displayName: preparedItem.displayName ?? values.name ?? preparedItem.url.lastPathComponent,
                                mediaType: mediaType,
                                previewSourceLocation: preparedItem.previewSourceURL?.absoluteString
                            )
                            stage = .copy
                            self.logAttachmentImport(
                                stage: .copy,
                                source: diagnosticSource,
                                count: count,
                                mediaType: mediaType,
                                code: .start
                            )
                            let saved = if let importDraftAttachment = self.importDraftAttachment {
                                try await importDraftAttachment(expectedDraftId, expectedSessionId, source)
                            } else {
                                try await drafts.importEditorAttachment(
                                    editorId: self.editorId,
                                    draftId: expectedDraftId,
                                    sessionId: expectedSessionId,
                                    source: source
                                )
                            }
                            self.logAttachmentImport(
                                stage: .copy,
                                source: diagnosticSource,
                                count: count,
                                mediaType: mediaType,
                                code: .complete
                            )
                            return saved
                        }
                        guard self.isCurrentDraftMutationTarget(target) else { throw CancellationError() }
                        committedDraft = saved
                        capturedDraftId = saved.id
                        capturedSessionId = saved.sessionId
                        try Task.checkCancellation()
                        guard self.isCurrentDraftMutationTarget(target),
                              routeIsActive?() == true else { throw CancellationError() }
                        stage = .commit
                        self.routeDraftId = saved.id
                        self.draftAttachments = saved.attachments
                        self.pendingAttachmentImportCount -= 1
                        outstandingReservations -= 1
                        self.logAttachmentImport(
                            stage: .commit,
                            source: diagnosticSource,
                            count: count,
                            mediaType: diagnosticType,
                            code: .complete
                        )
                    }
                    if self.lastAttachmentImportFailureGeneration == failureKnownWhenQueued {
                        self.acknowledgedAttachmentImportFailureGeneration = failureKnownWhenQueued
                        self.draftSaveError = nil
                    }
                }
            } catch {
                if let routeIsActive {
                    await self.reconcileAttachmentImport(
                        committedDraftId: committedDraft?.id,
                        baselineDraftIds: baselineDraftIds,
                        routeIsActive: routeIsActive
                    )
                }
                guard !isUserCancelledAttachmentImport(error) else { return }
                let reason = attachmentImportFailureReason(for: error)
                self.logAttachmentImport(
                    stage: .failure,
                    source: diagnosticSource,
                    count: count,
                    mediaType: diagnosticType,
                    code: Self.attachmentImportDiagnosticCode(for: reason),
                    failureStage: stage,
                    warning: true
                )
                if self.recordAttachmentImportFailure(generation: generation) {
                    self.presentAttachmentImportAlert(
                        source: diagnosticSource,
                        reason: reason,
                        generation: generation
                    )
                }
            }
        }
    }

    private func logAttachmentImport(
        stage: AttachmentImportDiagnosticStage,
        source: AttachmentImportSource,
        count: Int,
        mediaType: String? = nil,
        code: AttachmentImportDiagnosticCode,
        failureStage: AttachmentImportDiagnosticStage? = nil,
        warning: Bool = false
    ) {
        let boundedCount = min(max(count, 0), AttachmentImportPolicy.maximumPerMessage + 1)
        let boundedType: String
        if let mediaType,
           mediaType.count <= 64,
           mediaType.unicodeScalars.allSatisfy(
               CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "/.+-_")).contains
           ) {
            boundedType = mediaType
        } else {
            boundedType = "unknown"
        }
        let failureStageField = failureStage.map { " failureStage=\($0.rawValue)" } ?? ""
        let message =
            "attachment.import stage=\(stage.rawValue) source=\(source.rawValue) count=\(boundedCount) type=\(boundedType) code=\(code.rawValue)\(failureStageField)"
        if warning {
            log.warn(message)
        } else {
            log.debug(message)
        }
    }

    private nonisolated static func attachmentImportDiagnosticCode(
        for reason: AttachmentImportFailureReason
    ) -> AttachmentImportDiagnosticCode {
        AttachmentImportDiagnosticCode(rawValue: reason.rawValue) ?? .unknown
    }

    private func reconcileAttachmentImport(
        committedDraftId: String?,
        baselineDraftIds: Set<String>?,
        routeIsActive: @escaping @MainActor () -> Bool
    ) async {
        guard routeIsActive(), let drafts = component.drafts else { return }
        guard let snapshot = try? await drafts.restore(), routeIsActive() else { return }
        guard let draft = attachmentImportRecoveryDraft(
            drafts: snapshot.drafts,
            committedDraftId: committedDraftId,
            routeDraftId: routeDraftId,
            routeSessionId: routeSessionId,
            baselineDraftIds: baselineDraftIds
        ) else { return }
        routeDraftId = draft.id
        draftAttachments = draft.attachments
    }

    func removeAttachment(_ id: String) {
        if let pending = frozenPending(containing: id) {
            reconcileFrozenAttempt(pending, removing: id)
            return
        }
        let target = draftMutationTarget()
        guard !editorRetired, !preparingSend,
              let drafts = component.drafts,
              let draftId = target.draftId else { return }
        draftSaveTask?.cancel()
        draftMutationBarrier.enqueue { [weak self] in
            guard let self, !Task.isCancelled else { return }
            do {
                guard self.isCurrentDraftMutationTarget(target) else { return }
                let saved = try await drafts.removeAttachment(draftId: draftId, attachmentId: id)
                guard self.isCurrentDraftMutationTarget(target) else { return }
                self.draftAttachments = saved.attachments
            } catch {
                self.draftSaveError = "Attachment couldn't be removed."
            }
        }
    }

    func editPendingAttachment(_ id: String, pendingId: String) {
        guard let pending = selectedPending.first(where: {
            $0.pendingId == pendingId && $0.attachments.contains { $0.id == id }
        }) else { return }
        reconcileFrozenAttempt(pending, removing: nil)
    }

    func cancelAttachmentUpload(_ id: String, pendingId: String) {
        guard attachmentTransfers[id]?.phase == .uploading,
              selectedPending.contains(where: { $0.pendingId == pendingId && $0.attachments.contains { $0.id == id } }) else { return }
        cancelPendingUpload(pendingId)
    }

    func editPendingAttachment(_ id: String) {
        guard let pending = frozenPending(containing: id) else { return }
        reconcileFrozenAttempt(pending, removing: nil)
    }

    func retryAttachmentPreview(_ id: String) {
        guard visibleAttachmentPreviewIds.contains(id),
              attachmentPreviewFailures.remove(id) != nil,
              attachmentPreviews[id] == nil,
              attachmentPreviewTasks[id] == nil else { return }
        attemptedVisibleAttachmentPreviewIds.remove(id)
        pumpAttachmentPreviewRequests()
    }

    func retryDraftAttachmentPreview(_ id: String) {
        guard activeImageAttachmentIds(draft: draftAttachments, pending: allPendingAttachments).contains(id) else { return }
        draftAttachmentPreviewFailures.remove(id)
        draftAttachmentPreviews[id] = nil
        syncDraftAttachmentPreviews()
    }

    func setVisibleAttachmentPreviewIds(_ ids: Set<String>) {
        guard ids != visibleAttachmentPreviewIds else { return }
        let newlyVisible = ids.subtracting(visibleAttachmentPreviewIds)
        visibleAttachmentPreviewIds = ids
        attemptedVisibleAttachmentPreviewIds.subtract(newlyVisible)
        for id in newlyVisible where attachmentPreviews[id] != nil {
            attachmentPreviewRecency.removeAll { $0 == id }
            attachmentPreviewRecency.append(id)
        }
        for (id, task) in attachmentPreviewTasks where !ids.contains(id) {
            task.cancel()
        }
        trimAttachmentPreviewCache()
        pumpAttachmentPreviewRequests()
    }

    func downloadAttachment(_ id: String) {
        guard downloadedAttachmentFiles[id] == nil, attachmentDownloadTasks[id] == nil else { return }
        let component = component
        let displayName = state.model.committed
            .flatMap(\.attachments)
            .first(where: { $0.attachmentId == id })?.displayName ?? "attachment"
        attachmentDownloadTasks[id] = Task { [weak self] in
            do {
                let path = try await component.downloadAttachment(attachmentId: id, displayName: displayName)
                guard !Task.isCancelled else {
                    component.removeDownloadedAttachment(path: path)
                    return
                }
                guard let self else {
                    component.removeDownloadedAttachment(path: path)
                    return
                }
                self.downloadedAttachmentFiles[id] = URL(fileURLWithPath: path)
                self.transientDownloadPaths.insert(path)
                self.attachmentDownloadFailures.remove(id)
                self.attachmentDownloadTasks[id] = nil
            } catch is CancellationError {
            } catch {
                self?.attachmentDownloadFailures.insert(id)
                self?.attachmentDownloadTasks[id] = nil
            }
        }
    }

    func cancelAttachmentUpload(_ id: String) {
        guard let pending = frozenPending(containing: id) else { return }
        cancelPendingUpload(pending.pendingId)
    }

    private func cancelPendingUpload(_ pendingId: String) {
        guard !editorRetired, !routeActivationSuspended,
              activePendingId == pendingId, pendingSendTask != nil else { return }
        blockedPendingIds.insert(pendingId)
        pendingSendTask?.cancel()
    }

    func retryAttachmentUpload(_ id: String) {
        guard let pending = component.drafts?.snapshot.value.pendingSends.first(where: { send in
            send.attachments.contains(where: { $0.id == id })
        }) else { return }
        guard selectedPending.first?.pendingId == pending.pendingId else { return }
        blockedPendingIds.remove(pending.pendingId)
        retryPendingIds.insert(pending.pendingId)
        cache.remove(id: pending.pendingId)
        startPendingUpload(pending)
        component.ensureConnected()
    }

    func flushDraft() {
        guard !editorRetired, !preparingSend else { return }
        draftSaveTask?.cancel()
        let text = draftText
        let target = draftMutationTarget()
        draftMutationBarrier.enqueue { [weak self] in
            guard let self, !Task.isCancelled else { return }
            _ = await self.saveDraft(text, target: target)
        }
    }

    /// Persist latest edits and retire in the same actor turn. Supersession retains the editor.
    func saveAndRetireEditor(isCurrent: @escaping @MainActor () -> Bool) async -> Bool {
        while !editorRetired && !Task.isCancelled && isCurrent() {
            let revision = editorRevision
            guard await saveDraftBeforeNavigation() else { return false }
            guard !editorRetired, !Task.isCancelled, isCurrent() else { return false }
            if editorRevision == revision {
                retireEditor()
                return true
            }
        }
        return false
    }

    func saveDraftBeforeNavigation() async -> Bool {
        draftSaveTask?.cancel()
        let knownFailure = lastAttachmentImportFailureGeneration
        let target = draftMutationTarget()
        return (try? await draftMutationBarrier.perform { [weak self] in
            guard let self else { return false }
            let importFailedWhileQueued = self.lastAttachmentImportFailureGeneration != knownFailure
            let saved = await self.saveDraft(
                self.draftText,
                target: target,
                clearErrorOnSuccess: !importFailedWhileQueued
            )
            if saved && !importFailedWhileQueued {
                self.acknowledgedAttachmentImportFailureGeneration = self.lastAttachmentImportFailureGeneration
            }
            return saved && !importFailedWhileQueued
        }) ?? false
    }

    /// Capture route authority, then wait outside durable draft mutation work. The short barrier
    /// section only persists the captured payload and creates one idempotent pending send.
    func send(_ text: String) {
        guard !editorRetired, !routeActivationSuspended, !editingPending, !preparingSend,
              !text.isEmpty || !draftAttachments.isEmpty || pendingAttachmentImportCount > 0 else { return }
        draftSaveTask?.cancel()
        let knownImportFailure = lastAttachmentImportFailureGeneration
        let initialTarget = draftMutationTarget()
        let revision = editorRevision
        let expectedGeneration = component.outboundRouteGeneration.value
        preparingSend = true
        acceptanceTask = Task { [weak self] in
            guard let self else { return }
            defer { self.preparingSend = false; self.acceptanceTask = nil }
            do {
                let mintKey = try await self.component.awaitDraftSendAnchor(expectedGeneration: expectedGeneration)
                try Task.checkCancellation()
                let frozen: NativePendingSend? = try await self.draftMutationBarrier.perform { [weak self] in
                    guard let self, !self.editorRetired,
                          let target = self.sendTarget(initial: initialTarget),
                          self.lastAttachmentImportFailureGeneration == knownImportFailure else { return nil }
                    return try await self.freezePendingSend(text, target: target, mintKey: mintKey,
                        expectedGeneration: expectedGeneration, editorRevision: revision)
                }
                guard !self.editorRetired else { return }
                guard frozen != nil else {
                    _ = try? await self.draftMutationBarrier.perform { [weak self] in
                        guard let self, self.isCurrentDraftMutationTarget(initialTarget) else { return false }
                        return await self.saveDraft(self.editorRevision == revision ? text : self.draftText,
                            target: self.draftMutationTarget(), clearErrorOnSuccess: false)
                    }
                    return
                }
                self.durablePending = self.component.drafts?.snapshot.value.pendingSends ?? []
                self.drainPending()
            } catch is CancellationError {
            } catch {
                guard self.isCurrentDraftMutationTarget(initialTarget) else { return }
                _ = try? await self.draftMutationBarrier.perform { [weak self] in
                    guard let self, self.isCurrentDraftMutationTarget(initialTarget) else { return false }
                    return await self.saveDraft(self.draftText, target: self.draftMutationTarget())
                }
                self.draftSaveError = "Message couldn't be accepted yet. Draft retained; retry when connected."
            }
        }
    }

    /// Re-queue a FAILED message and verify connectivity. Shared drain keeps its id.
    func retry(_ pendingId: String) {
        log.info("retry pendingId=\(pendingId)")
        if let pending = selectedPending.first, pending.pendingId == pendingId {
            blockedPendingIds.remove(pendingId)
            retryPendingIds.insert(pendingId)
            if cache.pending.value.contains(where: { $0.id == pendingId }) {
                cache.retry(id: pendingId)
            } else {
                startPendingUpload(pending)
            }
        }
        // Verify the socket rather than trusting a possibly-stale READY: a dead socket
        // after a silent path change still reports READY, so a bare re-send would fail
        // again. ensureConnected() probes (READY→ping→reconnect-if-dead) or reconnects.
        component.ensureConnected()
    }

    /// Composer capture intents are semantic UI commands. Capture IDs, terminals,
    /// stale isolation, and wire frames remain entirely inside KMP.
    func voiceIntent(_ intent: VoiceCaptureIntent) {
        guard !editorRetired, !routeActivationSuspended, !awaitingRouteProjection else { return }
        log.info("voice.intent type=\(String(describing: intent))")
        if intent == .holdStart || intent == .enterAuto { captureFailure = nil }
        switch intent {
        case .holdStart: component.holdStart()
        case .sendHeld: component.sendHeld()
        case .cancelHeld: component.cancelHeld()
        case .enterAuto: component.enterAuto()
        case .exitAuto: component.exitAuto()
        case .lifecycleCancel: component.lifecycleCancel()
        }
    }

    /// Toggle TTS through the component passthrough (gateway echoes via prefs).
    func toggleTts() {
        Task { [weak self] in
            guard let self else { return }
            let next = !self.connection.prefs.ttsEnabled
            try? await self.component.setTtsEnabled(enabled: next)
        }
    }

    /// UI Stop — idempotent hard interrupt of the active cycle + audio.
    func interrupt() {
        guard !editorRetired, !routeActivationSuspended, !awaitingRouteProjection else { return }
        component.interrupt()
    }

    /// Manual reconnect — re-arm the reconnect controller and drive recovery.
    func reconnect() {
        component.forceReconnect()
    }

    /// Engagement signal from the chat screen: fires on screen appear and on composer
    /// focus. Idempotent — READY → liveness probe; not-READY → reconnect (re-anchors
    /// the conversation via conversation.activate on the next READY edge).
    func ensureConnected() {
        log.debug("ensureConnected")
        component.ensureConnected()
    }

    /// Composer gained keyboard focus — user is about to type; ensure the connection is
    /// live so the first send is not blocked by a stale reconnect race.
    func onComposerFocus() {
        log.debug("onComposerFocus")
        component.ensureConnected()
    }

    /// Tap-to-dismiss the ReopenFailed one-shot notice. Idempotent.
    func dismissReopenFailedNotice() {
        log.debug("reopen-failed.notice.dismissed")
        state.reopenFailedNotice = nil
    }

    /// Local optimistic dismiss — fires immediately on the user's own Allow/Deny tap,
    /// ahead of the `permission.resolved` round trip. Idempotent. Never an approval:
    /// the decision itself travels via `respondPermission`, called from the same tap.
    func dismissPermissionPrompt() {
        guard let current = pendingPermission else { return }
        permissionTimeoutTask?.cancel()
        pendingPermission = PermissionPromptFSM.reduce(
            current: current,
            event: .userResponded(requestId: current.requestId)
        )
    }

    /// Answer an outstanding permission prompt. Sends `permission.response` over the
    /// wire; the dialog itself is dismissed by `dismissPermissionPrompt()`, called
    /// alongside this from the same button tap (see ChatPermissionAlert.permissionPrompt).
    func respondPermission(_ requestId: String, approved: Bool) {
        guard !editorRetired, !routeActivationSuspended, !awaitingRouteProjection else { return }
        log.info("permission.response requestId=\(requestId) approved=\(approved)")
        component.respondToPermission(requestId: requestId, approved: approved)
    }

    // ── Chat stream collection ────────────────────────────────────────────────

    private func startChatCollecting() {
        // observeChat.invoke(pending:) takes a SkieSwiftFlow; cache.pending is a
        // SkieSwiftStateFlow (a hot variant), so wrap it in SkieSwiftFlow(_:) — SKIE
        // exposes that convenience upcast. The result is a SkieSwiftFlow<ChatModel>
        // (AsyncSequence) iterated directly.
        let pendingFlow = SkieSwiftFlow(cache.pending)
        chatTask = Task { [weak self] in
            guard let self else { return }
            for await model in self.component.observeChat.invoke(pending: pendingFlow) {
                guard !Task.isCancelled else { return }
                self.applyChat(model)
            }
        }
    }

    func applyChat(_ model: ChatModel) {
        guard !editorRetired, !routeActivationSuspended, !awaitingRouteProjection else { return }
        // Reconcile: drop optimistic entries whose committed echo arrived. Driven by the
        // LIVE echo (model.reconciledPendingIds) from the in-memory timeline — NOT
        // model.committed.pendingId (the committed twin may carry it null).
        for id in model.reconciledPendingIds {
            guard !handledReceiptIds.contains(id),
                  receiptAcknowledgmentFailures.contains(id) == false,
                  receiptAcknowledgmentTasks[id] == nil,
                  component.drafts != nil,
                  let receipt = model.committed.first(where: {
                      $0.role == "user" && $0.pendingId == id && $0.sessionId != nil
                  }),
                  let sessionId = receipt.sessionId else { continue }

            let expectedSessionId = routeSessionId
            let expectedDraftId = routeDraftId
            let expectedRouteGeneration = component.outboundRouteGeneration.value
            let expectedRouteFence = receiptRouteFence
            let receiptAttachmentIds = Set(
                component.drafts?.snapshot.value.pendingSends
                    .first(where: { $0.pendingId == id })?.attachments.map(\.id) ?? []
            )
            let routeIsCurrent = { [weak self] in
                guard let self else { return false }
                return self.receiptRouteFence == expectedRouteFence &&
                    self.routeSessionId == expectedSessionId &&
                    (expectedDraftId == nil || self.routeDraftId == expectedDraftId) &&
                    self.component.outboundRouteGeneration.value == expectedRouteGeneration
            }
            let acknowledge = acknowledgeReceipt
            receiptAcknowledgmentTasks[id] = Task { [weak self] in
                defer {
                    self?.receiptAcknowledgmentTasks[id] = nil
                    self?.drainPending()
                }
                for attempt in 0..<Self.receiptAcknowledgmentMaxAttempts {
                    guard !Task.isCancelled, routeIsCurrent() else { return }
                    do {
                        let result = try await acknowledge(id, sessionId)
                        guard !Task.isCancelled, routeIsCurrent(), let self else { return }

                        if result.found {
                            guard result.sessionId == nil || result.sessionId == sessionId,
                                  result.draftId == nil || self.routeDraftId == nil || self.routeDraftId == result.draftId else {
                                self.receiptAcknowledgmentFailures.insert(id)
                                return
                            }
                            self.handledReceiptIds.insert(id)
                            if self.receiptAcknowledgmentFailures.contains(id) {
                                self.receiptAcknowledgmentFailures.remove(id)
                            }
                            self.cache.remove(id: id)
                            self.clearPendingPresentation(ownedAttachmentIds: receiptAttachmentIds)
                            self.releasePinnedAttachmentPreviews(for: id)
                            guard let draftId = result.draftId else { return }
                            self.routeSessionId = sessionId
                            self.onDraftRouteChanged(draftId, draftId, sessionId)
                            self.durablePending = self.component.drafts?.snapshot.value.pendingSends ?? []
                            self.drainPending()
                            return
                        }

                        // `found == false` also covers a session mismatch. Only mark
                        // receipt complete once durable store no longer has pending id.
                        if !self.hasPendingReceipt(id) {
                            self.handledReceiptIds.insert(id)
                            return
                        }
                    } catch is CancellationError {
                        return
                    } catch {
                        // Retry boundedly below; route fence is checked before each call.
                    }

                    guard attempt + 1 < Self.receiptAcknowledgmentMaxAttempts else {
                        guard !Task.isCancelled, routeIsCurrent(), let self else { return }
                        self.receiptAcknowledgmentFailures.insert(id)
                        return
                    }
                    do {
                        try await Task.sleep(nanoseconds: Self.receiptAcknowledgmentRetryDelaysNs[attempt])
                    } catch {
                        return
                    }
                }
            }
        }
        state = ChatUiState(model: model, isLoading: false, historyLoading: model.historyLoading, banner: nil)
        let liveIds = Set(model.committed.flatMap(\.attachments).map(\.attachmentId))
        pruneAttachmentPreviews(keeping: liveIds.union(pinnedAttachmentPreviewIds))
        pumpAttachmentPreviewRequests()
        log.debug("chat committed=\(model.committed.count) pending=\(model.pending.count) live=\(model.live != nil) historyLoading=\(model.historyLoading)")
    }

    /// Explicit retry only. Normal chat ticks leave exhausted receipts fenced off.
    func retryReceiptAcknowledgments() {
        guard !receiptAcknowledgmentFailures.isEmpty else { return }
        receiptAcknowledgmentFailures.removeAll()
        applyChat(state.model)
    }

    private func hasPendingReceipt(_ id: String) -> Bool {
        component.drafts?.snapshot.value.pendingSends.contains { $0.pendingId == id } == true
    }

    private func clearPendingPresentation(ownedAttachmentIds: Set<String>) {
        guard !ownedAttachmentIds.isEmpty else { return }
        let remaining = pendingAttachmentCleanup(
            ownedAttachmentIds: ownedAttachmentIds,
            attachments: pendingAttachments,
            transfers: attachmentTransfers
        )
        if remaining.attachments.count != pendingAttachments.count {
            pendingAttachments = remaining.attachments
        }
        if remaining.transfers.count != attachmentTransfers.count {
            attachmentTransfers = remaining.transfers
        }
    }

    private func restoreDraft() {
        guard let drafts = component.drafts else {
            draftSaveError = "Draft storage is unavailable. Text won't survive relaunch."
            return
        }
        let restoreEpoch = draftMutationEpoch
        draftRestoreTask = Task { [weak self] in
            guard let self else { return }
            defer {
                self.draftRestoreSettled = true
                self.drainPending()
            }
            do {
                let snapshot = try await drafts.restore()
                guard !self.editorRetired, self.draftMutationEpoch == restoreEpoch else { return }
                let draft = self.routeDraftId.flatMap { id in snapshot.drafts.first { $0.id == id } }
                    ?? self.routeSessionId.flatMap { id in snapshot.drafts.first { $0.sessionId == id } }
                if let draft, !self.discardedDraftIds.contains(draft.id) {
                    self.routeDraftId = draft.id
                    if !self.draftEdited {
                        self.draftText = draft.text
                        self.draftAttachments = draft.attachments
                    }

                }
                self.durablePending = snapshot.pendingSends
                self.drainPending()
            } catch is CancellationError {
            } catch {
                guard !self.editorRetired, self.draftMutationEpoch == restoreEpoch else { return }
                self.draftSaveError = "Saved draft couldn't be loaded."
                self.log.warn("draft.restore-failed code=local-storage")
            }
        }
    }

    private var allPendingAttachments: [NativeDraftAttachment] {
        let sends = component.drafts?.snapshot.value.pendingSends ?? []
        return sends.flatMap(\.attachments).isEmpty ? pendingAttachments : sends.flatMap(\.attachments)
    }

    private func syncDraftAttachmentPreviews() {
        let imageIds = activeImageAttachmentIds(
            draft: draftAttachments,
            pending: allPendingAttachments
        )
        for id in draftAttachmentPreviewTasks.keys.filter({ !imageIds.contains($0) }) {
            draftAttachmentPreviewTasks[id]?.cancel()
            draftAttachmentPreviewTasks[id] = nil
        }
        for id in draftAttachmentPreviews.keys.filter({ !imageIds.contains($0) }) {
            draftAttachmentPreviews[id] = nil
        }
        if !draftAttachmentPreviewFailures.isSubset(of: imageIds) {
            draftAttachmentPreviewFailures.formIntersection(imageIds)
        }
        for id in imageIds where
            draftAttachmentPreviews[id] == nil &&
            !draftAttachmentPreviewFailures.contains(id) &&
            draftAttachmentPreviewTasks[id] == nil {
            let component = component
            draftAttachmentPreviewTasks[id] = Task { [weak self] in
                do {
                    guard let bytes = try await component.previewDraftAttachment(
                        attachmentId: id,
                        maxPixelSize: Self.draftPreviewMaxPixelSize
                    ) else { throw CocoaError(.fileReadCorruptFile) }
                    let data = bytes.toData()
                    try Task.checkCancellation()
                    guard let image = await Task.detached(priority: .userInitiated, operation: {
                        decodedAttachmentThumbnail(data)
                    }).value else { throw CocoaError(.fileReadCorruptFile) }
                    try Task.checkCancellation()
                    guard let self else { return }
                    self.draftAttachmentPreviewTasks[id] = nil
                    guard activeImageAttachmentIds(
                        draft: self.draftAttachments,
                        pending: self.allPendingAttachments
                    ).contains(id) else { return }
                    self.draftAttachmentPreviews[id] = image
                } catch is CancellationError {
                } catch {
                    self?.draftAttachmentPreviewFailures.insert(id)
                    self?.draftAttachmentPreviewTasks[id] = nil
                }
            }
        }
    }

    private func pumpAttachmentPreviewRequests() {
        let eligible = state.model.committed
            .flatMap(\.attachments)
            .filter { $0.mediaKind == "image" || $0.mediaKind == "pdf" }
            .map(\.attachmentId)
        for id in eligible where attachmentPreviewTasks.count < Self.attachmentPreviewRequestLimit {
            guard visibleAttachmentPreviewIds.contains(id),
                  attachmentPreviews[id] == nil,
                  !attachmentPreviewFailures.contains(id),
                  !attemptedVisibleAttachmentPreviewIds.contains(id),
                  attachmentPreviewTasks[id] == nil else { continue }
            attemptedVisibleAttachmentPreviewIds.insert(id)
            loadAttachmentPreview(id)
        }
    }

    private func loadAttachmentPreview(_ id: String) {
        let previewAttachment = previewAttachment
        attachmentPreviewTasks[id] = Task { [weak self] in
            do {
                let data = try await previewAttachment(id)
                try Task.checkCancellation()
                guard let image = await Task.detached(priority: .userInitiated, operation: {
                    decodedAttachmentThumbnail(data)
                }).value else { throw CocoaError(.fileReadCorruptFile) }
                try Task.checkCancellation()
                self?.finishAttachmentPreview(id, image: image, failed: false)
            } catch {
                self?.finishAttachmentPreview(
                    id,
                    image: nil,
                    failed: !Task.isCancelled && !(error is CancellationError)
                )
            }
        }
    }

    private func finishAttachmentPreview(_ id: String, image: UIImage?, failed: Bool) {
        attachmentPreviewTasks[id] = nil
        if let image, visibleAttachmentPreviewIds.contains(id) {
            insertAttachmentPreview(image, for: id)
            if attachmentPreviewFailures.contains(id) {
                attachmentPreviewFailures.remove(id)
            }
        } else if failed, visibleAttachmentPreviewIds.contains(id) {
            attachmentPreviewFailures.insert(id)
        }
        pumpAttachmentPreviewRequests()
    }

    private func insertAttachmentPreview(_ image: UIImage, for id: String) {
        attachmentPreviews[id] = image
        attachmentPreviewCosts[id] = decodedImageCost(image)
        attachmentPreviewRecency.removeAll { $0 == id }
        attachmentPreviewRecency.append(id)
        trimAttachmentPreviewCache()
    }

    private var offscreenAttachmentPreviewIds: Set<String> {
        Set(attachmentPreviews.keys)
            .subtracting(visibleAttachmentPreviewIds)
            .subtracting(pinnedAttachmentPreviewIds)
    }

    private func trimAttachmentPreviewCache() {
        while attachmentPreviewOffscreenCount > Self.attachmentPreviewOffscreenCountLimit ||
                attachmentPreviewOffscreenCost > Self.attachmentPreviewOffscreenCostLimit {
            guard let id = attachmentPreviewRecency.first(where: {
                offscreenAttachmentPreviewIds.contains($0)
            }) else { return }
            attachmentPreviews[id] = nil
            attachmentPreviewCosts[id] = nil
            attachmentPreviewRecency.removeAll { $0 == id }
        }
    }

    private func pruneAttachmentPreviews(keeping ids: Set<String>) {
        for id in attachmentPreviews.keys.filter({ !ids.contains($0) }) {
            attachmentPreviews[id] = nil
            attachmentPreviewCosts[id] = nil
            attachmentPreviewRecency.removeAll { $0 == id }
        }
        if !attachmentPreviewFailures.isSubset(of: ids) {
            attachmentPreviewFailures.formIntersection(ids)
        }
        attemptedVisibleAttachmentPreviewIds.formIntersection(ids)
        for (id, task) in attachmentPreviewTasks where !ids.contains(id) {
            task.cancel()
        }
    }

    func pinAttachmentPreviews(_ ids: Set<String>, for pendingId: String) {
        let bounded = Set(ids.prefix(Self.pendingAttachmentPreviewPinLimit))
        pinnedAttachmentPreviewIds.formUnion(bounded)
        pinnedAttachmentPreviewIdsByPendingId[pendingId] = bounded
    }

    func releasePinnedAttachmentPreviews(for pendingId: String) {
        guard let ids = pinnedAttachmentPreviewIdsByPendingId.removeValue(forKey: pendingId) else { return }
        pinnedAttachmentPreviewIds.subtract(ids)
        trimAttachmentPreviewCache()
    }

    func clearAttachmentPreviews() {
        attachmentPreviewTasks.values.forEach { $0.cancel() }
        visibleAttachmentPreviewIds = []
        attemptedVisibleAttachmentPreviewIds = []
        pinnedAttachmentPreviewIds = []
        pinnedAttachmentPreviewIdsByPendingId = [:]
        attachmentPreviews = [:]
        attachmentPreviewCosts = [:]
        attachmentPreviewRecency = []
        attachmentPreviewFailures = []
    }

    private func startPendingUpload(_ pending: NativePendingSend) {
        guard !editorRetired, !routeActivationSuspended, !editingPending, draftRestoreSettled, receiptAcknowledgmentTasks.isEmpty,
              pendingSendTask == nil, component.canDrainPending(cache: cache),
              selectedPending.first?.pendingId == pending.pendingId else { return }
        retryPendingIds.remove(pending.pendingId)
        activePendingId = pending.pendingId
        let sendGeneration = UUID()
        pendingSendGeneration = sendGeneration
        pendingSendTask = Task { [weak self] in
            guard let self else { return }
            defer { self.finishPendingSend(sendGeneration) }
            do {
                try await self.uploadAndEnqueue(pending, sendGeneration: sendGeneration)
            } catch is CancellationError {
                guard !self.editorRetired else { return }
                self.blockedPendingIds.insert(pending.pendingId)
            } catch {
                guard self.pendingSendGeneration == sendGeneration else { return }
                self.blockedPendingIds.insert(pending.pendingId)
                self.attachmentTransfers = failingActiveUploads(self.attachmentTransfers)
                self.draftSaveError = "One or more files couldn't be uploaded. Retry this message upload."
            }
        }
    }

    private func uploadAndEnqueue(_ pending: NativePendingSend, sendGeneration: UUID) async throws {
        let generation = component.outboundRouteGeneration.value
        let sessionId = routeSessionId
        let draftId = routeDraftId
        pendingAttachments = selectedPending.flatMap(\.attachments)
        for file in pending.attachments { attachmentTransfers[file.id] = AttachmentTransferState(phase: .queued) }
        let fileStates = OSAllocatedUnfairLock(initialState: [String: Bool]())
        do {
            try await component.drafts?.markAttempted(pendingId: pending.pendingId)
            try Task.checkCancellation()
            let upload = uploadPendingAttachments ?? { [self] pending, expectedGeneration, onProgress in
                try await self.component.uploadPendingAttachmentsWithState(
                    pending: pending,
                    expectedRouteGeneration: expectedGeneration,
                    onProgress: onProgress,
                    onFileState: { [weak self] id, uploaded in
                        fileStates.withLock { $0[id] = uploaded.boolValue }
                        Task { @MainActor in
                            guard let self, !self.editorRetired, self.pendingSendGeneration == sendGeneration else { return }
                            self.attachmentTransfers[id] = AttachmentTransferState(
                                phase: uploaded.boolValue ? .ready : .uploading,
                                progress: uploaded.boolValue ? 1 : 0)
                        }
                    }
                )
            }
            let refs: [AttachmentRef] = pending.attachments.isEmpty ? [] : try await upload(
                pending,
                generation
            ) { [weak self] id, sent, total in
                Task { @MainActor in
                    guard let self, self.pendingSendGeneration == sendGeneration,
                          let next = applyingUploadProgress(
                        to: self.attachmentTransfers[id],
                        sent: sent.int64Value,
                        total: total.int64Value
                    ) else { return }
                    self.attachmentTransfers[id] = next
                }
            }
            try Task.checkCancellation()
            guard pendingSendGeneration == sendGeneration,
                  component.outboundRouteGeneration.value == generation,
                  routeSessionId == sessionId,
                  routeDraftId == draftId,
                  component.drafts?.snapshot.value.pendingSends.contains(where: { $0.pendingId == pending.pendingId }) == true else {
                throw CancellationError()
            }
            guard let handoff = validatedAttachmentPreviewHandoff(
                pending: pending.attachments,
                refs: refs
            ) else { throw CocoaError(.coderInvalidValue) }
            let pinnedIds = Set(handoff.map(\.serverId))
            pinAttachmentPreviews(pinnedIds, for: pending.pendingId)
            for pair in handoff {
                if let image = draftAttachmentPreviews[pair.localId] {
                    insertAttachmentPreview(image, for: pair.serverId)
                }
            }
            for file in pending.attachments {
                attachmentTransfers[file.id] = AttachmentTransferState(phase: .ready, progress: 1)
            }
            cache.enqueue(id: pending.pendingId, text: pending.text, attachmentIds: refs.map { $0.attachmentId })
        } catch {
            if pendingSendGeneration == sendGeneration {
                // Callback tasks may still be waiting for MainActor. Final response facts win.
                for (id, uploaded) in fileStates.withLock({ $0 }) {
                    attachmentTransfers[id] = AttachmentTransferState(
                        phase: uploaded ? .ready : (error is CancellationError ? .cancelled : .failed),
                        progress: uploaded ? 1 : 0)
                }
                if error is CancellationError {
                    // Sequential upload leaves siblings queued. Cancelling this attempt settles
                    // those files too, without touching another pending message's waiting files.
                    for file in pending.attachments where attachmentTransfers[file.id]?.phase == .queued {
                        attachmentTransfers[file.id] = AttachmentTransferState(phase: .cancelled)
                    }
                }
                attachmentTransfers = error is CancellationError
                    ? cancellingActiveUploads(attachmentTransfers)
                    : failingActiveUploads(attachmentTransfers)
            }
            throw error
        }
    }

    private func finishPendingSend(_ sendGeneration: UUID) {
        guard pendingSendGeneration == sendGeneration else { return }
        pendingSendGeneration = nil
        pendingSendTask = nil
        activePendingId = nil
    }

    private func freezePendingSend(
        _ text: String,
        target: DraftMutationTarget,
        mintKey: String,
        expectedGeneration: KotlinLong?,
        editorRevision acceptedEditorRevision: Int
    ) async throws -> NativePendingSend? {
        guard component.drafts != nil else {
            draftSaveError = "Draft storage is unavailable. Message was not sent."
            return nil
        }
        guard isCurrentDraftMutationTarget(target),
              component.outboundRouteGeneration.value == expectedGeneration else {
            throw CancellationError()
        }
        guard let draft = try await persistDraftText(text, target: target) else {
            draftSaveError = "Message is saved locally but couldn't be sent yet."
            return nil
        }
        guard isCurrentDraftMutationTarget(target) else { return nil }
        guard !discardedDraftIds.contains(draft.id) else {
            draftSaveError = "Message is saved locally but couldn't be sent yet."
            return nil
        }
        routeDraftId = draft.id
        let pending = try await component.acceptDraftSend(
            draftId: draft.id,
            expectedRevision: draft.revision,
            mintKey: mintKey,
            expectedGeneration: expectedGeneration
        )
        guard isCurrentDraftMutationTarget(target), component.outboundRouteGeneration.value == expectedGeneration else { return pending }
        invalidateDraftMutations()
        draftEdited = true
        draftSaveTask?.cancel()
        if editorRevision == acceptedEditorRevision { draftText = "" }
        draftAttachments = []
        pendingAttachments = (component.drafts?.snapshot.value.pendingSends ?? []).flatMap(\.attachments)
        draftSaveError = nil
        if !draftText.isEmpty {
            _ = await saveDraft(draftText, target: draftMutationTarget())
        }
        acknowledgedAttachmentImportFailureGeneration = lastAttachmentImportFailureGeneration
        log.info("send len=\(text.count) pendingId=\(pending.pendingId) attachmentCount=\(pending.attachments.count)")
        return pending
    }

    private func saveDraft(
        _ text: String,
        target: DraftMutationTarget,
        clearErrorOnSuccess: Bool? = nil,
        reportFailure: Bool = true
    ) async -> Bool {
        guard component.drafts != nil,
              isCurrentDraftMutationTarget(target) else { return false }
        do {
            // Nil target means create-or-follow current route. Resolve it after queued imports
            // commit, while non-nil targets stay frozen for discard fencing.
            let effectiveTarget: DraftMutationTarget
            if target.draftId == nil {
                let current = draftMutationTarget()
                guard current.epoch == target.epoch,
                      isCurrentDraftMutationTarget(current) else { return false }
                effectiveTarget = current
            } else {
                effectiveTarget = target
            }
            let saved = try await persistDraftText(text, target: effectiveTarget)
            guard isCurrentDraftMutationTarget(effectiveTarget) else { return false }
            if let draftId = effectiveTarget.draftId, discardedDraftIds.contains(draftId) {
                return false
            }
            if let saved {
                routeDraftId = saved.id
            } else if effectiveTarget.draftId == routeDraftId {
                // A discarded or otherwise missing target stays fenced. Never auto-remint it.
                routeDraftId = nil
            }
            let nonBlank = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            guard saved != nil || effectiveTarget.draftId == nil || !nonBlank else {
                if reportFailure { draftSaveError = "Draft couldn't be saved. Keep this screen open and retry." }
                return false
            }
            let shouldClearError = clearErrorOnSuccess ?? (
                lastAttachmentImportFailureGeneration == acknowledgedAttachmentImportFailureGeneration
            )
            if shouldClearError { draftSaveError = nil }
            return true
        } catch is CancellationError {
            return false
        } catch {
            if reportFailure {
                draftSaveError = "Draft couldn't be saved. Keep this screen open and retry."
                log.warn("draft.save-failed code=local-storage")
            }
            return false
        }
    }

    private func draftMutationTarget() -> DraftMutationTarget {
        let draftId = routeDraftId.flatMap { id in
            discardedDraftIds.contains(id) ? nil : id
        } ?? routeSessionId.flatMap { sessionId in
            component.drafts?.snapshot.value.drafts.first {
                $0.sessionId == sessionId && !discardedDraftIds.contains($0.id)
            }?.id
        }
        if draftId == nil, routeSessionId != nil {
            hasUnresolvedDraftMutation = true
        }
        return DraftMutationTarget(draftId: draftId, sessionId: routeSessionId, epoch: draftMutationEpoch)
    }

    private func invalidateDraftMutations() {
        draftMutationEpoch &+= 1
        hasUnresolvedDraftMutation = false
    }

    private func isCurrentDraftMutationTarget(_ target: DraftMutationTarget) -> Bool {
        guard !editorRetired, target.epoch == draftMutationEpoch else { return false }
        if let draftId = target.draftId {
            return !discardedDraftIds.contains(draftId)
        }
        // Route identity and epoch are mutation authority. Published snapshots may lag or be
        // supplied by a separate adapter seam after an authoritative import returns a new ID.
        guard let routeDraftId else { return true }
        return !discardedDraftIds.contains(routeDraftId)
    }

    private func sendTarget(initial: DraftMutationTarget) -> DraftMutationTarget? {
        guard initial.epoch == draftMutationEpoch else { return nil }
        return initial.draftId == nil ? draftMutationTarget() : initial
    }

    private func persistDraftText(
        _ text: String,
        target: DraftMutationTarget
    ) async throws -> NativeDraft? {
        if let saveDraftText {
            return try await saveDraftText(target.draftId, target.sessionId, text)
        }
        return try await component.drafts?.saveEditorText(
            editorId: editorId,
            draftId: target.draftId,
            sessionId: target.sessionId,
            text: text
        )
    }

    private static func removeOwnedTemporaryFiles(_ items: [AttachmentImportItem]) {
        for url in Set(items.flatMap(\.ownedTemporaryURLs)) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func frozenPending(containing attachmentId: String) -> NativePendingSend? {
        component.drafts?.snapshot.value.pendingSends.first { pending in
            pending.attachments.contains { $0.id == attachmentId }
        }
    }

    private func reconcileFrozenAttempt(_ pending: NativePendingSend, removing attachmentId: String?) {
        guard selectedPending.first?.pendingId == pending.pendingId else {
            draftSaveError = "Finish earlier queued message before editing this one."
            return
        }
        guard !editorRetired, !routeActivationSuspended, !editingPending, draftText.isEmpty, draftAttachments.isEmpty, pendingAttachmentImportCount == 0, !preparingSend else {
            draftSaveError = "Save or send current draft before editing a queued message."
            return
        }
        let revision = editorRevision
        editingPending = true
        invalidateDraftMutations()
        let target = draftMutationTarget()
        let uploadTask = pendingSendTask
        activePendingId = nil
        blockedPendingIds.insert(pending.pendingId)
        pendingSendGeneration = nil
        pendingSendTask?.cancel()
        pendingSendTask = nil
        draftSaveTask?.cancel()
        draftMutationBarrier.enqueue { [weak self] in
            guard let self, !Task.isCancelled, let drafts = self.component.drafts else { return }
            defer {
                self.editingPending = false
                self.durablePending = drafts.snapshot.value.pendingSends
                self.drainPending()
            }
            await uploadTask?.value
            guard self.isCurrentDraftMutationTarget(target) else { return }
            do {
                var draft = try await self.cancelPendingSend(pending)
                guard self.isCurrentDraftMutationTarget(target), draft.sessionId == pending.sessionId else { return }
                if self.editorRevision != revision {
                    _ = try await drafts.preserveRestoredDraft(editorId: self.editorId, draftId: draft.id,
                        expectedRevision: draft.revision, nextText: self.draftText)
                    self.cache.remove(id: pending.pendingId)
                    self.draftSaveError = "Current draft kept. Edited message is available in saved drafts."
                    return
                }
                self.cache.remove(id: pending.pendingId)
                self.clearPendingPresentation(ownedAttachmentIds: Set(pending.attachments.map(\.id)))
                self.releasePinnedAttachmentPreviews(for: pending.pendingId)
                if let attachmentId {
                    draft = try await drafts.removeAttachment(draftId: draft.id, attachmentId: attachmentId)
                }
                guard self.isCurrentDraftMutationTarget(target) else { return }
                if self.editorRevision != revision {
                    _ = try await drafts.preserveRestoredDraft(editorId: self.editorId, draftId: draft.id,
                        expectedRevision: draft.revision, nextText: self.draftText)
                    return
                }
                self.routeDraftId = draft.id
                self.routeSessionId = draft.sessionId
                self.onDraftRouteChanged(pending.draftId, draft.id, draft.sessionId)
                self.draftText = draft.text
                self.draftAttachments = draft.attachments
                self.draftSaveError = nil
            } catch is CancellationError {
            } catch {
                if let failure = (error as NSError).kotlinException as? AttachmentRequestException {
                    let code = failure.code == "local_file_error" ? "local_file_error" : "attachment_request"
                    self.log.warn("pending.cancel-failed code=\(code) status=\(failure.status)")
                } else {
                    self.log.warn("pending.cancel-failed code=unexpected")
                }
                self.draftSaveError = "Couldn't confirm this send was cancelled. Frozen content was left unchanged."
            }
        }
    }

    private func startDiscardedDraftCollecting() {
        guard let flow = component.drafts?.discardedDrafts else { return }
        discardedDraftsTask = Task { [weak self] in
            guard let self else { return }
            for await draftId in flow {
                self.applyDiscardedDraft(draftId)
            }
        }
    }

    func applyDiscardedDraft(_ draftId: String) {
        guard !editorRetired else { return }
        guard discardedDraftIds.insert(draftId).inserted else { return }
        guard routeDraftId == draftId ||
                (routeDraftId == nil && routeSessionId != nil && hasUnresolvedDraftMutation) else { return }
        invalidateDraftMutations()
        pendingSendGeneration = nil
        pendingSendTask?.cancel()
        pendingSendTask = nil
        // Keep visible text for an in-flight send/error retry, but detach it from
        // discarded durable identity. New edits and a later Send use a new draft.
        routeDraftId = nil
        draftEdited = true
        draftAttachments = []
    }

    private func startSessionChangesCollecting() {
        sessionChangesTask = Task { [weak self] in
            guard let self else { return }
            for await event in self.component.sessionChanges {
                self.applySessionChange(event)
            }
        }
    }

    func applySessionChange(_ event: SessionsChangeEvent) {
        guard !editorRetired else { return }
        guard case .deleted(let deleted) = onEnum(of: event),
              deleted.sessionId == routeSessionId else { return }
        receiptRouteFence += 1
        receiptAcknowledgmentTasks.values.forEach { $0.cancel() }
        receiptAcknowledgmentTasks.removeAll()
        handledReceiptIds.removeAll()
        receiptAcknowledgmentFailures.removeAll()
        invalidateDraftMutations()
        pendingSendGeneration = nil
        pendingSendTask?.cancel()
        pendingSendTask = nil
        component.rebindAfterRemoteDelete(cache: cache)
        clearAttachmentPreviews()
        pendingAttachments = []
        attachmentTransfers = [:]
        routeDraftId = nil
        routeSessionId = nil
    }

    // ── Connection stream collection ─────────────────────────────────────────

    private func startConnectionCollecting() {
        // UI projection only; shared outbound observation uses real SDK authority.
        connectionTask = Task { [weak self] in
            guard let self else { return }
            for await conn in self.component.connection.state {
                self.applyConnection(conn)
            }
        }
    }

    private func applyConnection(_ conn: ConnectionState) {
        guard !editorRetired else { return }
        connection = conn
        log.debug("connection status=\(conn.status.name)")
        // Sweep unacked timeouts on every connection event (idempotent; guarded so we
        // only touch the cache when something is in flight). The cache owns the
        // clock + timeout — we only DRIVE the sweep.
        if !cache.pending.value.isEmpty {
            cache.sweepTimeouts()
        }
        recomputeKeepScreenOn()
    }

    // ── Talk-mode stream collection (S8 keep-screen-on) ───────────────────────

    private func startMicLevelsCollecting() {
        micLevelsTask = Task { [weak self] in
            guard let self else { return }
            for await envelope in self.component.micLevels {
                self.micLevels = envelope.values.map(\.floatValue)
            }
        }
    }

    private func startCaptureFailureCollecting() {
        captureFailureTask = Task { [weak self] in
            guard let self else { return }
            for await failure in self.component.captureStartFailures {
                guard !Task.isCancelled else { return }
                self.applyCaptureFailure(failure)
            }
        }
    }

    func applyCaptureFailure(_ failure: SdkEvent.CaptureStartFailed) {
        guard !editorRetired else { return }
        guard component.isCaptureStartFailureCurrent(event: failure) else { return }
        captureFailure = failure
    }

    private func startTalkModeCollecting() {
        talkModeTask = Task { [weak self] in
            guard let self else { return }
            for await mode in self.component.talkMode {
                self.talkMode = mode
                self.recomputeKeepScreenOn()
            }
        }
    }

    /// Pure re-derivation of `keepScreenOn` from the two latest inputs (`talkMode`,
    /// `connection.isSpeaking`). No side effects here — ChatView applies the platform
    /// flag off the published change and owns the transition log.
    private func recomputeKeepScreenOn() {
        keepScreenOn = talkMode == .continuous || connection.isSpeaking
    }

    // ── Periodic unacked-timeout sweep ────────────────────────────────────────

    /// Drive cache.sweepTimeouts() on a ~1s tick so unacked-timeout FAILED transitions
    /// fire even with no connection events. Runs only while pending entries exist;
    /// cancelled in deinit. The cache holds the clock + timeout — we just tick it.
    private func startPeriodicSweep() {
        sweepTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.sweepIntervalNs)
                guard let self else { return }
                if !self.cache.pending.value.isEmpty {
                    self.cache.sweepTimeouts()
                }
            }
        }
    }

    // ── Cold-reconcile (existing-conversation history reload) ─────────────────

    /// An existing-conversation switch reloads authoritative history from REST. That
    /// cold snapshot carries NO pendingId, so reconcile-by-pendingId can't drop a
    /// still-pending optimistic bubble → a duplicate. On the cold-replace signal,
    /// drop every still-present optimistic entry (now in the authoritative history,
    /// or already swept to FAILED by the unacked-timeout).
    private func startColdReplaceCollecting() {
        coldReplaceTask = Task { [weak self] in
            guard let self else { return }
            for await _ in self.component.observeChat.coldHistoryReplaceSignal() {
                guard !Task.isCancelled, !self.routeActivationSuspended, !self.awaitingRouteProjection else { return }
                self.component.observeChat.onColdHistoryReplace(cache: self.cache)
            }
        }
    }

    // ── ReopenFailed one-shot notice (spec §14) ───────────────────────────────

    /// Collect the one-shot ReopenFailed signal from the component. Each emission
    /// folds a transient notice into published state, then auto-dismisses after 4 s
    /// unless the user already tapped the dismiss button. The VM owns the collection
    /// lifetime so the event is folded into durable state immediately — never dropped
    /// by a lifecycle pause.
    private func startReopenFailedCollecting() {
        reopenFailedTask = Task { [weak self] in
            guard let self else { return }
            for await _ in self.component.reopenFailed {
                self.log.info("reopen-failed.notice.show")
                self.state.reopenFailedNotice = reopenFailedNoticeCopy
                try? await Task.sleep(nanoseconds: Self.reopenFailedAutoDismissNs)
                // Auto-dismiss only if not already cleared by a tap.
                if self.state.reopenFailedNotice != nil {
                    self.log.debug("reopen-failed.notice.auto-dismiss")
                    self.state.reopenFailedNotice = nil
                }
            }
        }
    }

    // ── Permission-prompt stream collection (design spec §7.1) ────────────────

    /// Dedicated collector for the SDK's open-prompt StateFlow — a SEPARATE Task from
    /// every other collector in this file, cancelled in deinit like the rest. The SDK
    /// publishes the whole open list; at most one prompt is live per session (the
    /// SessionRuntime blocks its turn on it), so this VM renders the head.
    private func startPermissionCollecting() {
        permissionTask = Task { [weak self] in
            guard let self else { return }
            for await prompts in self.component.permissions {
                guard !Task.isCancelled else { return }
                self.applyPermissionPrompts(prompts)
            }
        }
    }

    private func applyPermissionPrompts(_ prompts: [PermissionPrompt]) {
        guard !editorRetired, !routeActivationSuspended, !awaitingRouteProjection else { return }
        let current = pendingPermission
        let next = prompts.first
        // Same head as we already show ⇒ this emission was about something further
        // down the list. Returning early keeps the countdown armed and the log
        // un-duplicated.
        guard next?.requestId != current?.requestId else { return }
        permissionTimeoutTask?.cancel()
        if let next {
            pendingPermission = PermissionPromptFSM.reduce(current: current, event: .requested(next))
            // Prompt content and arguments never enter diagnostics.
            log.info("permission.request.shown requestId=\(next.requestId) type=tool")
            armLocalTimeoutFallback(for: next)
        } else if let current {
            // The SDK dropped it — permission.resolved arrived (allowed / denied /
            // timeout all clear identically; the outcome itself is server-side
            // bookkeeping, not something this VM branches on).
            log.info("permission.resolved requestId=\(current.requestId)")
            pendingPermission = PermissionPromptFSM.reduce(
                current: current,
                event: .resolved(requestId: current.requestId)
            )
        }
    }

    /// Defensive UI-only fallback: if neither the user's own tap nor the server's
    /// permission.resolved frame clears this prompt by its expiresAtMs, clear it
    /// locally so the dialog can never hang forever on a lost/delayed frame. Never an
    /// approval — nothing is sent to the server from this path, and the gateway has
    /// already fail-closed denied the call by the time this fires.
    private func armLocalTimeoutFallback(for prompt: PermissionPrompt) {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let remainingMs = max(0, prompt.expiresAtMs - nowMs)
        permissionTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(remainingMs) * Self.nsPerMs)
            guard let self, !Task.isCancelled else { return }
            let wasShowing = self.pendingPermission?.requestId == prompt.requestId
            self.pendingPermission = PermissionPromptFSM.reduce(
                current: self.pendingPermission,
                event: .localTimeoutFired(requestId: prompt.requestId)
            )
            if wasShowing {
                self.log.warn("permission.prompt.cleared requestId=\(prompt.requestId) reason=local-timeout-fallback")
            }
        }
    }

    /// Single teardown path for THIS VM: cancel collection tasks ONLY. The SDK /
    /// socket are owned by UserSession and MUST survive a conversation switch.
    deinit {
        acceptanceTask?.cancel()
        pendingSnapshotTask?.cancel()
        chatTask?.cancel()
        connectionTask?.cancel()
        outboundTask?.cancel()
        talkModeTask?.cancel()
        captureFailureTask?.cancel()
        micLevelsTask?.cancel()
        coldReplaceTask?.cancel()
        sweepTask?.cancel()
        reopenFailedTask?.cancel()
        permissionTask?.cancel()
        permissionTimeoutTask?.cancel()
        receiptAcknowledgmentTasks.values.forEach { $0.cancel() }
        draftRestoreTask?.cancel()
        draftSaveTask?.cancel()
        discardedDraftsTask?.cancel()
        Task { @MainActor [draftMutationBarrier] in draftMutationBarrier.cancelAll() }
        pendingSendTask?.cancel()
        draftAttachmentPreviewTasks.values.forEach { $0.cancel() }
        attachmentPreviewTasks.values.forEach { $0.cancel() }
        attachmentDownloadTasks.values.forEach { $0.cancel() }
        transientDownloadPaths.forEach { component.removeDownloadedAttachment(path: $0) }
        sessionChangesTask?.cancel()
    }
}
