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

struct ChatView: View {
    /// The thin per-conversation VM — sole SDK-command surface for this screen.
    @StateObject private var vm: ChatViewModel
    /// History reads + rename/delete (selection/new-chat are host navigations).
    @StateObject private var historyModel: HistoryViewModel

    /// User's display name for bubble avatars and drawer header.
    let userName: String

    /// History select → host flips activeSessionId (rebuilds the VM).
    let onSelectSession: (String) -> Void
    /// New chat → host sets activeSessionId = nil (a fresh conversation).
    let onNewChat: () -> Void
    /// Open settings → host pushes the `.settings` route onto the outer NavigationStack
    /// (leveled nav: root category list → per-category pages). The shared UpdateModel
    /// is owned by the host and threaded into the pushed SettingsSheet, not here.
    let onOpenSettings: () -> Void
    /// Logout → host shuts the UserSession down + clears the token.
    let onLogout: () -> Void

    // ── Drawer state ────────────────────────────────────────────────────────────

    @State private var drawerOpen = false
    @State private var panelNowMs: Int64 = 0

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
    @State private var panelDeleting: PanelTarget?
    @State private var panelRenameText = ""

    // ── Init ──────────────────────────────────────────────────────────────────────

    init(
        makeVM: @escaping () -> ChatViewModel,
        makeHistoryVM: @escaping () -> HistoryViewModel,
        userName: String,
        onSelectSession: @escaping (String) -> Void,
        onNewChat: @escaping () -> Void,
        onOpenSettings: @escaping () -> Void,
        onLogout: @escaping () -> Void
    ) {
        _vm = StateObject(wrappedValue: makeVM())
        _historyModel = StateObject(wrappedValue: makeHistoryVM())
        self.userName = userName
        self.onSelectSession = onSelectSession
        self.onNewChat = onNewChat
        self.onOpenSettings = onOpenSettings
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

    private var currentMarkMode: MarkMode { markModeOfConnection(connection) }

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

    // Build the display message list: committed + live bubble (with tasks injected).
    private var displayMessages: [ChatMessage] {
        vm.state.model.messagesForUi()
    }

    private var pending: [PendingMessage] { vm.state.model.pending }

    // ── Root body ─────────────────────────────────────────────────────────────────

    var body: some View {
        SideDrawer(
            isOpen: $drawerOpen,
            onOpen: {
                panelNowMs = Int64(Date().timeIntervalSince1970 * 1000)
                Task { await historyModel.refresh() }
            }
        ) {
            mainColumn
        } drawer: {
            historySidePanel
                .background(DuskColors.bg.ignoresSafeArea())
        }
        .connectionState(
            banner: connectionBanner,
            onReconnect: { vm.reconnect() },
            authExpired: connection.authExpired,
            onAuthExpired: { onLogout() }
        )
        .panelRenamePrompt($panelRenaming, text: $panelRenameText) { id, title in
            Task { await historyModel.renameSession(id, title: title) }
        }
        .panelDeletePrompt($panelDeleting) { id in
            Task { await historyModel.deleteSession(id) }
        }
        .task {
            // Engagement signal: the chat surface appeared. Idempotent — READY → a
            // liveness probe; not-READY → reconnect. Scoped to this view's lifetime.
            vm.ensureConnected()
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
        }
        // Clear path (b): this view leaving the screen (nav-away). isIdleTimerDisabled is
        // APP-GLOBAL — leaving it set here would keep an unrelated screen's display awake.
        .onDisappear {
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

    // ── Main content column ───────────────────────────────────────────────────────

    private var mainColumn: some View {
        VStack(spacing: 0) {
            titleBar
            MessageList(
                messages: displayMessages,
                activeMarkMode: currentMarkMode,
                userName: userName,
                pending: pending,
                onRetry: { vm.retry($0) },
                historyLoading: historyLoading
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay {
                // History-loading takes precedence: an existing-session switch is
                // fetching its snapshot, so the list is cleared and a centered
                // spinner stands in. A brand-new chat keeps historyLoading false →
                // no spinner. The composer is NEVER gated on this (see below).
                if historyLoading {
                    HistoryLoadingOverlay()
                } else if displayMessages.isEmpty && pending.isEmpty, chatLoadingState != .none {
                    ChatLoadingView(state: chatLoadingState)
                }
            }
            // Chat-side error banner (model failure).
            if let banner = vm.state.banner {
                ContentErrorBanner(
                    text: banner.text,
                    canRetry: banner.canRetry,
                    onRetry: banner.canRetry ? { vm.reconnect() } : nil
                )
            }
            // One-shot ReopenFailed notice (spec §14). Auto-dismissed by the VM after ~4 s
            // or earlier on tap. Independent of the repo-failure banner above.
            if let notice = vm.state.reopenFailedNotice {
                ReopenFailedNoticeBanner(
                    noticeText: notice,
                    onDismiss: { vm.dismissReopenFailedNotice() }
                )
            }
        }
        .safeAreaInset(edge: .bottom) {
            Composer(
                canSend: true,
                ttsEnabled: connection.prefs.ttsEnabled,
                micActive: voiceActive,
                canInterrupt: canInterrupt,
                onSend: { vm.send($0) },
                onMicPress: { vm.pressMic() },
                onMicRelease: { vm.releaseMic() },
                onMicLock: { vm.lockMic() },
                onMicStopContinuous: { vm.stopContinuous() },
                onTtsToggle: { vm.toggleTts() },
                onInterrupt: { vm.interrupt() },
                onFocusGained: { vm.onComposerFocus() }
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .duskTheme()
    }

    // ── History side panel ────────────────────────────────────────────────────────

    private var historySidePanel: some View {
        HistorySidePanel(
            model: historyModel,
            nowMs: panelNowMs,
            userName: userName,
            household: "",
            onSelect: { sessionId in
                drawerOpen = false
                onSelectSession(sessionId)
            },
            onNewChat: {
                drawerOpen = false
                onNewChat()
            },
            onSettings: {
                drawerOpen = false
                onOpenSettings()
            },
            onAskRename: { row in
                panelRenameText = row.title
                panelRenaming = PanelTarget(id: row.sessionId, title: row.title)
            },
            onAskDelete: { row in
                panelDeleting = PanelTarget(id: row.sessionId, title: row.title)
            }
        )
    }

    // ── Title bar ─────────────────────────────────────────────────────────────────

    private var titleBar: some View {
        ChatTitleBar(
            markMode: currentMarkMode,
            onOpenPanel: { drawerOpen = true },
            onNewChat: { onNewChat() }
        )
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
            ZStack {
                Rectangle().fill(DuskColors.bgElev)
                Rectangle().fill(DuskColors.warn.opacity(0.12))
            }
        }
        .accessibilityIdentifier("banner-chat")
    }
}
