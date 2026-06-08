// ---------------------------------------------------------------------------
// ChatView — the chat surface, driven by ChatUiState + ConnectionState.
//
// Mirrors the Android ChatContent + ChatRoot pattern: the ViewModel is the
// only place that holds SDK or repo references. Consumes the KMP-layer data
// model (committed history + optimistic pending outbox + live streaming bubble
// + task pills) and the separate ConnectionState, rendering them on screen.
//
// Session lifecycle: one MobileSession per chat entry. The session is built by
// the parent (RootView.ChatRoot), passed in as a @StateObject ChatViewModel so
// it is created once per chat entry and torn down on exit. ChatViewModel.deinit
// is the SINGLE session-close path (session.close() called there); do NOT add
// a second .onDisappear close path.
//
// scenePhase presence: .active → vm.onForeground(); .background → vm.onBackground().
// Cold-start-skip is inside ChatViewModel (tracks hasBackgrounded).
//
// Row ordering in MessageList:
//   1. committed messages (with day-dividers via chatRows())
//   2. pending outbox entries (QUEUED→SENT→FAILED status chips; FAILED = tappable Retry)
//   3. live streaming assistant bubble (appended when ChatModel.live != nil)
//
// Banners (highest priority first):
//   1. chat-side ErrorBanner from ChatUiState (ChatRepository failure)
//   2. connection banner from ConnectionState (lost / reconnecting)
//
// accessibilityIdentifier `chat-screen` lives on the title leaf in ChatTitleBar
// (host routing assert). It is NOT applied to the SideDrawer container: now that
// SideDrawer is a pure-SwiftUI View (not a UIViewControllerRepresentable), a
// container-level id flattens every child accessibility element into one merged
// `chat-screen` node, hiding history-open / composer-input from the a11y tree.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct ChatView: View {
    /// The ViewModel is the sole SDK reference. @ObservedObject — the VM is
    /// owned by ChatRoot (@StateObject there); ChatView is a consumer.
    @ObservedObject var vm: ChatViewModel

    /// User's display name for bubble avatars and drawer header.
    let userName: String
    /// Called on logout — clears the token via AppConfig so RootView re-routes to login.
    let onLogout: () -> Void

    // ── scenePhase ─────────────────────────────────────────────────────────────

    @Environment(\.scenePhase) private var scenePhase

    // ── Drawer state ────────────────────────────────────────────────────────────

    @StateObject private var historyModel: HistoryViewModel
    @State private var drawerOpen = false
    @State private var panelNowMs: Int64 = 0

    // ── Sheet + alert state ───────────────────────────────────────────────────────

    @State private var settingsPresented = false
    @State private var panelRenaming: PanelTarget?
    @State private var panelDeleting: PanelTarget?
    @State private var panelRenameText = ""

    private let sceneLog = AppLog("chat", "scene")

    // ── Init ──────────────────────────────────────────────────────────────────────

    init(vm: ChatViewModel, userName: String, onLogout: @escaping () -> Void) {
        self.vm = vm
        self.userName = userName
        self.onLogout = onLogout
        _historyModel = StateObject(wrappedValue: HistoryViewModel(session: vm.session))
    }

    // ── Derived ───────────────────────────────────────────────────────────────────

    private var connection: ConnectionState { vm.connection }

    private var canInterrupt: Bool {
        connection.isSpeaking
            || connection.audioState == .processing
            || connection.audioState == .assistantSpeaking
            || connection.audioState == .interrupting
    }

    private var currentMarkMode: MarkMode { markModeOfConnection(connection) }

    private var voiceActive: Bool { connection.voiceMode == .active }

    private var chatLoadingState: LoadingAffordance {
        chatLoading(status: connection.status)
    }

    private var connectionBanner: ConnectionBannerState? {
        ConnectionBannerState.derive(status: connection.status, connectionLost: connection.connectionLost)
    }

    // Build the display message list: committed + live bubble (with tasks injected).
    // Uses ChatModel.messagesForUi() which mirrors the KMP-side derivation.
    // Pending rows are passed separately via MessageList `pending` param.
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
            onReconnect: { vm.session.sdk.forceReconnect() },
            authExpired: connection.authExpired,
            onAuthExpired: { onLogout() }
        )
        .sheet(isPresented: $settingsPresented) {
            SettingsSheet(
                onLogout: {
                    onLogout()
                    settingsPresented = false
                },
                onDismiss: { settingsPresented = false }
            )
        }
        .panelRenamePrompt($panelRenaming, text: $panelRenameText) { id, title in
            Task { await historyModel.renameSession(id, title: title) }
        }
        .panelDeletePrompt($panelDeleting) { id in
            Task { await historyModel.deleteSession(id) }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                sceneLog.info("background")
                vm.onBackground()
            case .active:
                if vm.hasBackgrounded {
                    sceneLog.info("foreground")
                } else {
                    sceneLog.info("cold-start-skip")
                }
                vm.onForeground()
            default: break
            }
        }
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
                onRetry: { vm.retry($0) }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay {
                if displayMessages.isEmpty && pending.isEmpty, chatLoadingState != .none {
                    ChatLoadingView(state: chatLoadingState)
                }
            }
            // Chat-side error banner (repository / model failure).
            if let banner = vm.state.banner {
                ContentErrorBanner(
                    text: banner.text,
                    canRetry: banner.canRetry,
                    onRetry: banner.canRetry ? { vm.session.sdk.forceReconnect() } : nil
                )
            }
        }
        .safeAreaInset(edge: .bottom) {
            Composer(
                canSend: true,
                ttsEnabled: connection.prefs.ttsEnabled,
                micActive: voiceActive,
                canInterrupt: canInterrupt,
                sendInFlight: !pending.isEmpty,
                onSend: { vm.send($0) },
                onMicToggle: toggleMic,
                onTtsToggle: {
                    Task { try? await vm.session.sdk.setTtsEnabled(enabled: !connection.prefs.ttsEnabled) }
                },
                onInterrupt: { vm.session.sdk.interrupt() }
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
                Task {
                    await historyModel.switchSession(sessionId)
                    drawerOpen = false
                }
            },
            onNewChat: {
                Task {
                    await historyModel.newChat()
                    drawerOpen = false
                }
            },
            onSettings: {
                settingsPresented = true
                drawerOpen = false
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
            onNewChat: { Task { await historyModel.newChat() } }
        )
    }

    // ── Actions ───────────────────────────────────────────────────────────────────

    private func toggleMic() {
        if connection.voiceMode == .active {
            vm.session.sdk.stopMic()
        } else {
            vm.session.sdk.startMic()
        }
    }
}

// ---------------------------------------------------------------------------
// ContentErrorBanner — inline chat-side error pill shown when ChatUiState.banner
// is non-nil (ChatRepository failure). Mirrors Android ContentErrorBanner.
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
