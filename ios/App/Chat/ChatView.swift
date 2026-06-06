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
// History surface: native UIKit interactive left-edge drawer (SideDrawer →
// SideDrawerController) hosting HistorySidePanel. Edge-swipe opens, drag/tap-scrim
// closes, finger tracks both directions with velocity snap. The hamburger sets
// `drawerOpen = true`; the controller clears it on dismiss; onOpen refreshes the
// session list on EVERY open. "+" starts a new chat; settings moved to panel header.
//
// accessibilityIdentifier `chat-screen` is retained for the host routing assert.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

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

    // ── Drawer state ────────────────────────────────────────────────────────

    /// SwiftUI's command surface over the native UIKit drawer (SideDrawer). The
    /// hamburger sets it true; the controller clears it to false on any
    /// interactive dismiss. The interactive open/close drag itself lives in UIKit.
    @State private var drawerOpen = false

    /// Clock captured once per drawer-open so relative dates don't drift.
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
        chatLoading(status: store.state.status)
    }

    private var currentMarkMode: MarkMode { markMode(of: store.state) }

    private var voiceActive: Bool { store.state.voiceMode == .active }

    private var transcriptVisible: Bool {
        voiceActive && !store.state.transcript.isEmpty
    }

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
        SideDrawer(
            isOpen: $drawerOpen,
            // Fires on EVERY fully-open (edge-swipe AND programmatic) — fixes the
            // old gap where a drag-open never refreshed the session list.
            onOpen: {
                panelNowMs = Int64(Date().timeIntervalSince1970 * 1000)
                Task { await historyModel.refresh() }
            }
        ) {
            mainColumn
        } drawer: {
            // The drawer host view spans full height (ignores safe area); extend
            // the dusk background behind the status bar / home indicator so no
            // gap shows the dimmed content through. Panel content keeps its insets.
            historySidePanel
                .background(DuskColors.bg.ignoresSafeArea())
        }
        .ignoresSafeArea()
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
            MessageList(messages: store.state.messages, activeMarkMode: currentMarkMode, userName: store.displayName)
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
            userName: store.displayName,
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

    // ── Title bar ─────────────────────────────────────────────────────────────

    private var titleBar: some View {
        ChatTitleBar(
            markMode: currentMarkMode,
            // Hamburger commands the native drawer open; the controller fires
            // onOpen (refresh + clock) when it settles fully open.
            onOpenPanel: { drawerOpen = true },
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
