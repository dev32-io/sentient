// ---------------------------------------------------------------------------
// ChatView — the real chat surface (D-I3): a title bar, the scrolling
// MessageList, and the docked Composer. Replaces the D-I2 placeholder. Mirrors
// the Android ChatScreen (android/.../chat/ChatScreen.kt) and the webui chat
// shell, dropping the breadcrumb top bar for a title-only nav bar.
//
// Reads the single SDK surface from the app-level SdkStore (explicit param —
// allows @StateObject historyModel to be created at init time, same pattern
// as HistorySheet). Dispatches user actions through the store's command
// passthroughs. Bindings:
//  - MessageList ← store.state.messages
//  - Composer send gated on status == .ready + non-empty draft
//  - Composer interrupt shown only when cognition != .idle || isSpeaking
//  - TTS/mic toggles reflect state.prefs.ttsEnabled / voiceMode
//
// History surface: left side panel (D-I4.2), draggable-snapping overlay.
// Hamburger opens it; "+" starts a new chat; settings moved to panel header.
//
// accessibilityIdentifier `chat-screen` is retained for the host routing assert.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

struct ChatView: View {
    /// Explicit store param — HistoryModel is created here at init time.
    /// RootView passes the single app SdkStore (mirrors HistorySheet pattern).
    let store: SdkStore

    /// Stably held history state. @StateObject ensures one lifetime per ChatView.
    @StateObject private var historyModel: HistoryModel

    init(store: SdkStore) {
        self.store = store
        _historyModel = StateObject(wrappedValue: HistoryModel(store: store))
    }

    // ── Panel geometry ────────────────────────────────────────────────────────

    /// 86 % of screen width. UIScreen.main is deprecated in iOS 16 + but
    /// acceptable here; a GeometryReader alternative requires restructuring.
    private let panelWidth: CGFloat = UIScreen.main.bounds.width * 0.86

    /// Panel offset: -panelWidth = closed, 0 = open. Initialized CLOSED at the
    /// declaration (not in .onAppear) so the panel never renders open on frame zero.
    @State private var panelX: CGFloat = -UIScreen.main.bounds.width * 0.86

    /// panelX captured at the start of each drag (reset to nil on end).
    @GestureState private var dragOriginX: CGFloat? = nil

    /// Clock captured once per openPanel() so relative dates don't drift.
    @State private var panelNowMs: Int64 = 0

    // ── Sheet + alert state ───────────────────────────────────────────────────

    @State private var settingsPresented = false
    @State private var panelRenaming: PanelTarget?
    @State private var panelDeleting: PanelTarget?
    @State private var panelRenameText = ""

    // ── Derived ───────────────────────────────────────────────────────────────

    private static let title = "Sentient"

    private var canInterrupt: Bool {
        store.state.cognition != .idle || store.state.isSpeaking
    }

    /// Loading affordance derived from the pure chatLoading() policy function.
    private var chatLoadingState: LoadingAffordance {
        chatLoading(
            status: store.state.status,
            cognition: store.state.cognition,
            hasMessages: !store.state.messages.isEmpty
        )
    }

    private var currentMarkMode: MarkMode { markMode(of: store.state) }

    private var voiceActive: Bool { store.state.voiceMode == .active }

    private var transcriptVisible: Bool {
        voiceActive && !store.state.transcript.isEmpty
    }

    private var panelVisible: Bool { panelX > -panelWidth }

    /// Connection affordance derived from the single SDK state surface via the
    /// pure `ConnectionBannerState.derive` (STATUS, not connectionLost,
    /// discriminates reconnecting vs lost). See ConnectionBanner.swift.
    private var connectionBanner: ConnectionBannerState? {
        ConnectionBannerState.derive(
            status: store.state.status,
            connectionLost: store.state.connectionLost
        )
    }

    /// Last user turn to resend on cycle-error Retry (pure derivation; nil ⇒
    /// Retry omitted). See CycleErrorBanner.swift.
    private var lastUserText: String? {
        CycleErrorRecovery.lastUserText(in: store.state.messages)
    }

    // ── Root body ─────────────────────────────────────────────────────────────

    var body: some View {
        ZStack(alignment: .leading) {
            mainColumn
                // 20 pt leading strip: edge-swipe to open. The narrow strip +
                // minimumDistance:8 lets vertical chat scroll pass through.
                .overlay(alignment: .leading) {
                    Color.clear
                        .frame(width: 20)
                        .contentShape(Rectangle())
                        .gesture(panelDrag)
                }

            if panelVisible {
                let progress = Double((panelX + panelWidth) / panelWidth)
                Color.black
                    .opacity(0.5 * progress)
                    .ignoresSafeArea()
                    .onTapGesture { closePanel() }

                historySidePanel
                    .frame(width: panelWidth)
                    .offset(x: panelX)
                    .gesture(panelDrag)
            }
        }
        // Floating connection-state pill + auth-expired→logout (extracted modifier).
        .connectionState(
            banner: connectionBanner,
            onReconnect: { store.forceReconnect() },
            authExpired: store.state.authExpired,
            onAuthExpired: { store.logout() }
        )
        .sheet(isPresented: $settingsPresented) {
            SettingsSheet(
                onLogout: {
                    store.logout()
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
    }

    // ── Main content column ───────────────────────────────────────────────────

    private var mainColumn: some View {
        VStack(spacing: 0) {
            titleBar
            // TODO(userName): surface real display name from auth profile
            MessageList(messages: store.state.messages, activeMarkMode: currentMarkMode, userName: "You")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay {
                    if store.state.messages.isEmpty, chatLoadingState != .none {
                        ChatLoadingView(state: chatLoadingState)
                    }
                }
            if transcriptVisible {
                TranscriptPreview(text: store.state.transcript)
            }
        }
        .safeAreaInset(edge: .bottom) {
            Composer(
                canSend: true,
                ttsEnabled: store.state.prefs.ttsEnabled,
                micActive: store.state.voiceMode == .active,
                canInterrupt: canInterrupt,
                sendInFlight: store.hasPendingSends,
                onSend: { store.sendText($0) },
                onMicToggle: toggleMic,
                onTtsToggle: { store.setTtsEnabled(!store.state.prefs.ttsEnabled) },
                onInterrupt: { store.interrupt() }
            )
            .cycleErrorRecovery(
                hasError: store.state.lastCycleError,
                lastUserText: lastUserText,
                onRetry: { if let text = lastUserText { store.sendText(text) } },
                onNewChat: { Task { await historyModel.newChat() } }
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .duskTheme()
    }

    // ── History side panel ────────────────────────────────────────────────────

    private var historySidePanel: some View {
        HistorySidePanel(
            model: historyModel,
            nowMs: panelNowMs,
            // SdkStore does not expose a display-name surface (8.1 finding).
            userName: "You",
            household: "",
            onSelect: { sessionId in
                Task {
                    await historyModel.switchSession(sessionId)
                    closePanel()
                }
            },
            onNewChat: {
                Task {
                    await historyModel.newChat()
                    closePanel()
                }
            },
            onSettings: {
                settingsPresented = true
                closePanel()
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

    // ── Drag gesture + snap ───────────────────────────────────────────────────

    private var panelDrag: some Gesture {
        DragGesture(minimumDistance: 8)
            .updating($dragOriginX) { _, state, _ in
                if state == nil { state = panelX }
            }
            .onChanged { value in
                let base = dragOriginX ?? panelX
                panelX = max(-panelWidth, min(0, base + value.translation.width))
            }
            .onEnded { value in
                let extra = value.predictedEndTranslation.width - value.translation.width
                let shouldOpen = (panelX + extra) > -panelWidth / 2
                withAnimation(.interactiveSpring(response: 0.3, dampingFraction: 0.86)) {
                    panelX = shouldOpen ? 0 : -panelWidth
                }
            }
    }

    private func openPanel() {
        panelNowMs = Int64(Date().timeIntervalSince1970 * 1000)
        Task { await historyModel.refresh() }
        withAnimation(.interactiveSpring(response: 0.3, dampingFraction: 0.86)) {
            panelX = 0
        }
    }

    private func closePanel() {
        withAnimation(.interactiveSpring(response: 0.3, dampingFraction: 0.86)) {
            panelX = -panelWidth
        }
    }

    private var titleBar: some View {
        ChatTitleBar(
            markMode: currentMarkMode,
            onOpenPanel: openPanel,
            onNewChat: { Task { await historyModel.newChat() } }
        )
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    private func toggleMic() {
        if store.state.voiceMode == .active {
            store.stopMic()
        } else {
            store.startMic()
        }
    }
}
