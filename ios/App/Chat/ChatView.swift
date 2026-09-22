// ---------------------------------------------------------------------------
// ChatView — the chat surface, driven by ChatUiState + ConnectionState.
//
// The thin per-conversation ChatViewModel + the HistoryViewModel are owned HERE
// as @StateObjects, built from factory closures the host (UserSessionHost) passes
// in. Because the host keys this view `.id(activeSessionId)`, a new active
// conversation rebuilds ChatView → fresh @StateObject VMs (route-recreates-VM).
// The SDK + socket live in UserSession ABOVE this view, so switching conversation
// / opening history never drops the connection.
//
// History select / new-chat are NAVIGATIONS bubbled to the host (onSelectSession /
// onNewChat) — they flip the host's activeSessionId, NOT a switchConversation call
// on this VM. Settings is a keeper sheet; logout bubbles to the host (onLogout).
//
// Presence (scenePhase) is owned by the host, NOT here — a conversation switch
// must never pause/resume the SDK.
//
// Row ordering in MessageList:
//   1. committed messages (with day-dividers via chatRows())
//   2. pending outbox entries (QUEUED / FAILED chips; FAILED = tappable Retry)
//   3. live streaming assistant bubble (appended when ChatModel.live != nil)
//
// Banners (highest priority first):
//   1. chat-side ErrorBanner from ChatUiState
//   2. connection banner from ConnectionState (lost / reconnecting)
//
// accessibilityIdentifier `chat-screen` lives on the title leaf in ChatTitleBar;
// it is NOT applied to the SideDrawer container (that would flatten the a11y tree).
//
// Keep-screen-on (S8): UIApplication.shared.isIdleTimerDisabled is APP-GLOBAL (not
// per-view like Android's window flag), so every clear path is wired here: condition
// false (vm.keepScreenOn), this view disappearing (nav-away, e.g. to Settings), and
// scene backgrounding (screen is off anyway — never leave the app-global timer
// disabled while backgrounded). See applyIdleTimer/forceIdleTimerOff below.
// ---------------------------------------------------------------------------
import SwiftUI
import UIKit
import MobileData

struct RouteChangeState: Equatable {
    private(set) var pending = false

    mutating func begin() -> Bool {
        guard !pending else { return false }
        pending = true
        return true
    }

    mutating func finish(saved: Bool) -> Bool {
        if !saved { pending = false }
        return saved
    }
}

func shouldNavigateAfterDiscard(succeeded: Bool, draftId: String, activeDraftId: String?) -> Bool {
    succeeded && draftId == activeDraftId
}

func nextAttachmentImportAlertAfterDismissal(
    dismissedGeneration: Int,
    current: AttachmentImportAlert?,
    pickerPresented: Bool
) -> AttachmentImportAlert? {
    guard !pickerPresented, current?.generation != dismissedGeneration else { return nil }
    return current
}

struct ChatView: View {
    /// The thin per-conversation VM — sole SDK-command surface for this screen.
    @StateObject private var vm: ChatViewModel
    /// History reads + rename/delete (selection/new-chat are host navigations).
    @StateObject private var historyModel: HistoryViewModel

    /// User's display name for bubble avatars and drawer header.
    let userName: String
    /// Selected route identity used to highlight the active History row.
    let activeSessionId: String?
    let activeDraftId: String?

    /// History select → host flips route identity (rebuilds the VM).
    let onSelectSession: (String) -> Void
    let onSelectDraft: (String, String?) -> Void
    /// New chat → host sets activeSessionId = nil (a fresh conversation).
    let onNewChat: () -> Void
    /// Open settings → host pushes the `.settings` route onto the outer NavigationStack
    /// (leveled nav: root category list → per-category pages). The shared UpdateModel
    /// is owned by the host and threaded into the pushed SettingsSheet, not here.
    let onOpenSettings: () -> Void
    /// Open the session-backed scheduled-message inbox.
    let onOpenInbox: () -> Void
    /// Logout → host shuts the UserSession down + clears the token.
    let onLogout: () -> Void

    // ── Drawer state ────────────────────────────────────────────────────────────

    @State private var drawerOpen = false
    @State private var panelNowMs: Int64 = 0
    @State private var messageMeasurementLoading = false
    @State private var composerHeight: CGFloat = 0
    @State private var routeChange = RouteChangeState()

    // ── Keep-screen-on (S8) ─────────────────────────────────────────────────────

    /// Ambient scene state, read ONLY to gate/force-clear the idle timer. Distinct from
    /// UserSessionHost's scenePhase ownership (SDK pause/resume) — this is a narrower,
    /// view-local concern over a UI-only device flag, not session lifecycle.
    @Environment(\.scenePhase) private var scenePhase
    /// Carries the last reason a true→false condition was seen (see ChatViewModel's
    /// keepScreenOn doc) so the OFF log line still names what just ended.
    @State private var lastKeepScreenOnReason = "speaking"
    private let keepScreenOnLog = AppLog("chat", "keep-screen-on")

    // ── Sheet + alert state ───────────────────────────────────────────────────────

    @State private var panelRenaming: PanelTarget?
    @State private var panelDeleting: PanelDestructiveTarget?
    @State private var panelRenameText = ""
    /// Composer reports picker state; false arrives only at native dismissal completion.
    @State private var attachmentPickerPresented = false
    /// Keep alert data stable while SwiftUI dismisses it; generation IDs let native alert
    /// presentation serialize a newer alert after the visible one finishes.
    @State private var presentedAttachmentImportAlert: AttachmentImportAlert?
    @State private var previewedAttachment: AttachmentPreviewSelection?

    // ── Init ──────────────────────────────────────────────────────────────────────

    init(
        makeVM: @escaping () -> ChatViewModel,
        makeHistoryVM: @escaping () -> HistoryViewModel,
        userName: String,
        activeSessionId: String?,
        activeDraftId: String?,
        onSelectSession: @escaping (String) -> Void,
        onSelectDraft: @escaping (String, String?) -> Void,
        onNewChat: @escaping () -> Void,
        onOpenSettings: @escaping () -> Void,
        onOpenInbox: @escaping () -> Void,
        onLogout: @escaping () -> Void
    ) {
        _vm = StateObject(wrappedValue: makeVM())
        _historyModel = StateObject(wrappedValue: makeHistoryVM())
        self.userName = userName
        self.activeSessionId = activeSessionId
        self.activeDraftId = activeDraftId
        self.onSelectSession = onSelectSession
        self.onSelectDraft = onSelectDraft
        self.onNewChat = onNewChat
        self.onOpenSettings = onOpenSettings
        self.onOpenInbox = onOpenInbox
        self.onLogout = onLogout
    }

    // ── Derived ───────────────────────────────────────────────────────────────────

    private var connection: ConnectionState { vm.connection }

    private var canInterrupt: Bool {
        // Mirror webui (canInterrupt = cycleStatus != idle): show the Stop affordance
        // while THINKING (cognition != idle — covers the text path with no voice FSM)
        // OR SPEAKING (isSpeaking, which the SDK now holds until the speaker tail
        // physically drains, not merely until the frame queue empties).
        connection.cognition != .idle || connection.isSpeaking
    }

    private var voiceActive: Bool { connection.voiceMode == .active }

    private var chatLoadingState: LoadingAffordance {
        chatLoading(status: connection.status)
    }

    /// True while an existing-session switch is fetching history (snapshot pending).
    /// Drives the message-list spinner ONLY — the composer stays live regardless.
    private var historyLoading: Bool { vm.state.historyLoading }

    private var connectionBanner: ConnectionBannerState? {
        ConnectionBannerState.derive(status: connection.status, connectionLost: connection.connectionLost)
    }

    // Build the display message list: committed + live bubble. Tool rows are
    // NOT part of this — they render in the composer's task strip (`tasks`
    // below), which has no bubble to anchor to.
    private var displayMessages: [ChatMessage] {
        vm.state.model.messagesForUi()
    }

    /// Composer task strip's live rows — server-owned full state (a
    /// `tasklist.state` frame), rendered as-is with nothing derived here.
    private var tasks: [TaskListItem] { vm.state.model.tasks }

    private var pending: [PendingMessage] { vm.state.model.pending }

    // ── Root body ─────────────────────────────────────────────────────────────────

    var body: some View {
        let messages = displayMessages
        let assistantActivity = vm.state.model.assistantActivity

        return SideDrawer(
            isOpen: $drawerOpen,
            onOpen: {
                panelNowMs = Int64(Date().timeIntervalSince1970 * 1000)
                Task { await historyModel.refresh() }
            }
        ) {
            mainColumn(messages: messages, assistantActivity: assistantActivity)
                .environment(\.sentientIdentityPlaybackEnabled, !drawerOpen)
        } drawer: {
            historySidePanel
                .background(DuskColors.bg.ignoresSafeArea())
        }
        .connectionState(
            banner: connectionBanner,
            onReconnect: { vm.reconnect() }
        )
        .panelRenamePrompt($panelRenaming, text: $panelRenameText) { id, title in
            Task { await historyModel.renameSession(id, title: title) }
        }
        .panelDeletePrompt($panelDeleting) { action in
            Task {
                switch action {
                case .deleteConversation(let sessionId):
                    if await historyModel.deleteSession(sessionId), sessionId == activeSessionId { onNewChat() }
                case .discardDraft(let draftId):
                    let succeeded = await historyModel.discardDraft(draftId)
                    if shouldNavigateAfterDiscard(succeeded: succeeded, draftId: draftId, activeDraftId: activeDraftId) {
                        onNewChat()
                    }
                }
            }
        }
        .permissionPrompt(
            Binding(
                get: { vm.pendingPermission },
                set: { if $0 == nil { vm.dismissPermissionPrompt() } }
            ),
            onRespond: { requestId, approved in vm.respondPermission(requestId, approved: approved) }
        )
        .alert(item: Binding<AttachmentImportAlert?>(
            get: { presentedAttachmentImportAlert },
            set: { setPresentedAttachmentImportAlert($0) }
        )) { alert in
            Alert(
                title: Text(alert.title),
                message: Text(alert.message),
                dismissButton: .default(Text("OK")) {
                    vm.dismissAttachmentImportAlert(generation: alert.generation)
                }
            )
        }
        .sheet(item: $previewedAttachment) { attachment in
            ChatAttachmentPreviewSheet(viewModel: vm, attachment: attachment)
        }
        .task {
            // Engagement signal: the chat surface appeared. Idempotent — READY → a
            // liveness probe; not-READY → reconnect. Scoped to this view's lifetime.
            vm.ensureConnected()
            await historyModel.refresh()
            await historyModel.retryDeletes(includePermanent: false)
        }
        // Clear path (a) + resync: condition-driven changes while this view is the
        // current screen. Skipped while backgrounded — the background handler below owns
        // that state exclusively so the two paths never fight over the same flag.
        .onChange(of: vm.keepScreenOn) { _, on in
            guard scenePhase != .background else { return }
            applyIdleTimer(on: on)
        }
        // Resync on reappear: covers both initial appear and returning from a sibling
        // destination (e.g. Settings, pushed on the SAME app-global UIApplication — see
        // the file header). onDisappear force-cleared the flag on the way out, so a
        // still-true condition needs re-applying on the way back in.
        .onAppear {
            applyIdleTimer(on: vm.keepScreenOn)
            syncAttachmentImportAlert()
        }
        .onChange(of: vm.attachmentImportAlert) { _, _ in
            syncAttachmentImportAlert()
        }
        .onChange(of: attachmentPickerPresented) { _, presented in
            if !presented { syncAttachmentImportAlert() }
        }
        // Clear path (b): this view leaving the screen (nav-away). isIdleTimerDisabled is
        // APP-GLOBAL — leaving it set here would keep an unrelated screen's display awake.
        .onDisappear {
            vm.flushDraft()
            forceIdleTimerOff(reason: "teardown")
        }
        // Clear path (c) + resync: scene backgrounding. The screen is off regardless, so
        // the timer MUST NOT stay disabled in the background; resync on the way back to
        // .active picks the condition back up if it's still true.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                forceIdleTimerOff(reason: "background")
            case .active:
                applyIdleTimer(on: vm.keepScreenOn)
                Task { await historyModel.retryDeletes(includePermanent: false) }
            default:
                break
            }
        }
    }

    // ── Keep-screen-on application (S8) ─────────────────────────────────────────────

    /// Applies the condition-driven state. Idempotent (no-op / no log if already at
    /// `on`). Reason is computed fresh from the VM's current inputs when turning ON
    /// (accurate — describing a live true condition); the OFF log reuses the last-seen
    /// ON reason (the OR'd condition reads false on both sides once it drops, so the
    /// "why" has to be remembered).
    private func applyIdleTimer(on: Bool) {
        guard UIApplication.shared.isIdleTimerDisabled != on else { return }
        UIApplication.shared.isIdleTimerDisabled = on
        let reason: String
        if on {
            reason = vm.talkMode == .continuous ? "continuous" : "speaking"
            lastKeepScreenOnReason = reason
        } else {
            reason = lastKeepScreenOnReason
        }
        keepScreenOnLog.info("flag on=\(on) reason=\(reason)")
    }

    /// Lifecycle-forced clear (teardown / background) — always wins over the condition,
    /// independent of `vm.keepScreenOn`. Idempotent.
    private func forceIdleTimerOff(reason: String) {
        guard UIApplication.shared.isIdleTimerDisabled else { return }
        UIApplication.shared.isIdleTimerDisabled = false
        keepScreenOnLog.info("flag on=false reason=\(reason)")
    }

    private func syncAttachmentImportAlert() {
        guard presentedAttachmentImportAlert == nil, !attachmentPickerPresented else { return }
        presentedAttachmentImportAlert = vm.attachmentImportAlert
    }

    private func setPresentedAttachmentImportAlert(_ alert: AttachmentImportAlert?) {
        guard let dismissed = presentedAttachmentImportAlert else {
            presentedAttachmentImportAlert = alert
            return
        }
        guard alert == nil else {
            presentedAttachmentImportAlert = alert
            return
        }
        vm.dismissAttachmentImportAlert(generation: dismissed.generation)
        // `alert(item:)` uses AttachmentImportAlert.id, so assigning B here makes
        // SwiftUI finish A's dismissal before presenting B instead of reusing A's host.
        presentedAttachmentImportAlert = nextAttachmentImportAlertAfterDismissal(
            dismissedGeneration: dismissed.generation,
            current: vm.attachmentImportAlert,
            pickerPresented: attachmentPickerPresented
        )
    }

    // ── Main content column ───────────────────────────────────────────────────────

    private func openAttachmentPreview(_ id: String) {
        previewedAttachment = attachmentPreviewSelection(
            id: id,
            committed: displayMessages.flatMap(\.attachments),
            pending: vm.pendingAttachmentPresentations.values.flatMap(\.attachments)
        )
    }

    private func mainColumn(
        messages: [ChatMessage],
        assistantActivity: AssistantActivityState
    ) -> some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                titleBar
                MessageList(
                    messages: messages,
                    assistantActivity: assistantActivity,
                    userName: userName,
                    pending: pending,
                    pendingAttachments: vm.pendingAttachments,
                    pendingAttachmentPreviews: vm.draftAttachmentPreviews,
                    pendingAttachmentTransfers: vm.attachmentTransfers,
                    pendingAttachmentPresentations: vm.pendingAttachmentPresentations,
                    onRetryAttachmentUpload: { vm.retryAttachmentUpload($0) },
                    attachmentPreviews: vm.attachmentPreviews,
                    attachmentPreviewFailures: vm.attachmentPreviewFailures,
                    onPreviewAttachment: { openAttachmentPreview($0) },
                    onVisibleAttachmentPreviewIdsChange: { vm.setVisibleAttachmentPreviewIds($0) },
                    onRetry: { vm.retry($0) },
                    historyLoading: historyLoading,
                    bottomOcclusion: composerHeight,
                    initialExistingHistory: activeSessionId != nil,
                    onMeasurementLoadingChange: { messageMeasurementLoading = $0 }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay {
                    if historyLoading || messageMeasurementLoading {
                        HistoryLoadingOverlay()
                    } else if messages.isEmpty && pending.isEmpty, chatLoadingState != .none {
                        ChatLoadingView(state: chatLoadingState)
                    }
                }
                if let banner = vm.state.banner {
                    ContentErrorBanner(
                        text: banner.text,
                        canRetry: banner.canRetry,
                        onRetry: banner.canRetry ? { vm.reconnect() } : nil
                    )
                }
                if let draftError = vm.draftSaveError {
                    ContentErrorBanner(text: draftError, canRetry: false, onRetry: nil)
                }
                if !vm.receiptAcknowledgmentFailures.isEmpty {
                    ContentErrorBanner(
                        text: "Message sent, but local draft cleanup failed.",
                        canRetry: true,
                        onRetry: { vm.retryReceiptAcknowledgments() }
                    )
                    .accessibilityIdentifier("receipt-cleanup-retry-banner")
                }
                if let notice = vm.state.reopenFailedNotice {
                    ReopenFailedNoticeBanner(
                        noticeText: notice,
                        onDismiss: { vm.dismissReopenFailedNotice() }
                    )
                }
            }
            .ignoresSafeArea(.keyboard, edges: .bottom)

            composerDock
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .duskTheme()
    }

    private var composerDock: some View {
        Composer(
            tasks: tasks,
            ttsEnabled: connection.prefs.ttsEnabled,
            talkMode: vm.talkMode,
            micLevels: vm.micLevels,
            voiceDisabled: connection.status != .ready,
            canInterrupt: canInterrupt,
            draftText: vm.draftText,
            attachments: (vm.draftAttachments + vm.pendingAttachments).map(ComposerAttachment.init),
            pendingAttachmentImportCount: vm.pendingAttachmentImportCount,
            attachmentTransfers: vm.attachmentTransfers,
            attachmentPreviews: vm.draftAttachmentPreviews,
            attachmentPreviewFailures: vm.draftAttachmentPreviewFailures,
            onDraftChange: { vm.updateDraft($0) },
            onPickAttachments: { vm.importAttachments($0) },
            onPrepareAttachments: { vm.prepareAttachments($0) },
            onAttachmentImportFailure: { source, error in
                vm.reportAttachmentImportFailure(source: source, error: error)
            },
            onAttachmentPickerPresentationChange: { presented in
                attachmentPickerPresented = presented
            },
            onRemoveAttachment: { vm.removeAttachment($0) },
            onCancelAttachment: { vm.cancelAttachmentUpload($0) },
            onRetryAttachment: { vm.retryAttachmentUpload($0) },
            onEditAttachment: { vm.editPendingAttachment($0) },
            onSend: { vm.send($0) },
            onVoiceIntent: { vm.voiceIntent($0) },
            onTtsToggle: { vm.toggleTts() },
            onInterrupt: { vm.interrupt() },
            onFocusGained: { vm.onComposerFocus() }
        )
        .background(alignment: .top) {
            LinearGradient(
                colors: [.clear, DuskColors.bg.opacity(0.94), DuskColors.bg],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: composerHeight + 48)
            .offset(y: -48)
            .allowsHitTesting(false)
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { composerHeight = $0 }
    }

    // ── History side panel ────────────────────────────────────────────────────────

    private var historySidePanel: some View {
        HistorySidePanel(
            model: historyModel,
            nowMs: panelNowMs,
            userName: userName,
            household: "",
            activeSessionId: activeSessionId,
            activeDraftId: activeDraftId,
            onSelect: { row in
                drawerOpen = false
                navigateAfterSaving {
                    if let draftId = row.draftId {
                        onSelectDraft(draftId, row.sessionId)
                    } else if let sessionId = row.sessionId {
                        onSelectSession(sessionId)
                    }
                }
            },
            onNewChat: {
                drawerOpen = false
                navigateAfterSaving(onNewChat)
            },
            onSettings: {
                drawerOpen = false
                onOpenSettings()
            },
            onAskRename: { row in
                guard let sessionId = row.sessionId else { return }
                panelRenameText = row.title
                panelRenaming = PanelTarget(id: sessionId, title: row.title)
            },
            onAskDelete: { row in
                guard let sessionId = row.sessionId else { return }
                panelDeleting = PanelDestructiveTarget(
                    action: .deleteConversation(sessionId: sessionId), title: row.title
                )
            },
            onAskDiscard: { row in
                guard let draftId = row.draftId else { return }
                panelDeleting = PanelDestructiveTarget(action: .discardDraft(draftId: draftId), title: row.title)
            }
        )
    }

    // ── Title bar ─────────────────────────────────────────────────────────────────

    private var titleBar: some View {
        ChatTitleBar(
            onOpenPanel: { drawerOpen = true },
            onOpenInbox: onOpenInbox,
            onNewChat: { navigateAfterSaving(onNewChat) }
        )
    }

    private func navigateAfterSaving(_ navigate: @escaping () -> Void) {
        guard routeChange.begin() else { return }
        Task {
            guard routeChange.finish(saved: await vm.saveDraftBeforeNavigation()) else { return }
            navigate()
        }
    }
}

// ---------------------------------------------------------------------------
// HistoryLoadingOverlay — centred spinner shown over the (cleared) message list
// while an existing-session switch fetches its conversation snapshot. Matches the
// HistorySidePanel loading style (accent-tinted ProgressView). The composer is
// never gated on this — it stays typeable throughout the switch.
//
// accessibilityIdentifier: history-loading (shared with the side-panel spinner,
// scoped here to the message-list overlay).
// ---------------------------------------------------------------------------

private struct ChatAttachmentPreviewSheet: View {
    @ObservedObject var viewModel: ChatViewModel
    let attachment: AttachmentPreviewSelection

    var body: some View {
        MessageAttachmentPreviewSheet(
            attachment: attachment,
            preview: attachment.isLocal
                ? viewModel.draftAttachmentPreviews[attachment.id]
                : viewModel.attachmentPreviews[attachment.id],
            previewFailed: attachment.isLocal
                ? viewModel.draftAttachmentPreviewFailures.contains(attachment.id)
                : viewModel.attachmentPreviewFailures.contains(attachment.id),
            file: attachment.isLocal
                ? attachment.localFile
                : viewModel.downloadedAttachmentFiles[attachment.id],
            downloadFailed: !attachment.isLocal && viewModel.attachmentDownloadFailures.contains(attachment.id),
            downloadAvailable: !attachment.isLocal,
            onRetryPreview: {
                if attachment.isLocal {
                    viewModel.retryDraftAttachmentPreview(attachment.id)
                } else {
                    viewModel.retryAttachmentPreview(attachment.id)
                }
            },
            onDownload: { viewModel.downloadAttachment(attachment.id) }
        )
    }
}

private struct HistoryLoadingOverlay: View {
    var body: some View {
        ProgressView()
            .tint(DuskColors.accent)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("history-loading")
    }
}

// ---------------------------------------------------------------------------
// ContentErrorBanner — inline chat-side error pill shown when ChatUiState.banner
// is non-nil. Mirrors Android ContentErrorBanner.
// ---------------------------------------------------------------------------

private struct ContentErrorBanner: View {
    let text: String
    let canRetry: Bool
    let onRetry: (() -> Void)?

    var body: some View {
        HStack(spacing: Space.md) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: TypeScale.sm))
                .foregroundStyle(DuskColors.warn)
            Text(text)
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            if canRetry, let onRetry {
                Button(action: onRetry) {
                    Text("Retry")
                        .font(Typo.ui(TypeScale.sm, .semibold))
                        .foregroundStyle(DuskColors.bg)
                        .padding(.horizontal, Space.sm)
                        .padding(.vertical, Space.xs)
                        .background(DuskColors.ink, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("banner-chat-retry")
            }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .background {
            DuskColors.warnSoft
        }
        .accessibilityIdentifier("banner-chat")
    }
}
