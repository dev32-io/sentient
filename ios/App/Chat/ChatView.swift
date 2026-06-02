// ---------------------------------------------------------------------------
// ChatView — the real chat surface (D-I3): a title bar, the scrolling
// MessageList, and the docked Composer. Replaces the D-I2 placeholder. Mirrors
// the Android ChatScreen (android/.../chat/ChatScreen.kt) and the webui chat
// shell, dropping the breadcrumb top bar for a title-only nav bar.
//
// Reads the ONE SDK surface from the app-level @EnvironmentObject SdkStore (no
// per-screen store — collect-loop retention) and dispatches user actions
// through the store's command passthroughs. Bindings:
//  - MessageList ← store.state.messages (user + assistant; the in-flight
//    assistant bubble carries streaming=true → pulse dots / block cursor).
//  - Composer send gated on status == .ready (canSend) + non-empty draft.
//  - Composer interrupt shown only when cognition != .idle || isSpeaking.
//  - TTS toggle reflects state.prefs.ttsEnabled; mic toggle reflects voiceMode.
//
// The Composer is docked via .safeAreaInset(edge:.bottom) so it stays above the
// home indicator and rides up over the keyboard (SwiftUI keyboard avoidance).
// Dark status-bar content comes from the Dusk dark color scheme.
//
// accessibilityIdentifier `chat-screen` is retained for the host routing assert.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

struct ChatView: View {
    @EnvironmentObject private var store: SdkStore

    private static let title = "Sentient"

    private var canInterrupt: Bool {
        store.state.cognition != .idle || store.state.isSpeaking
    }

    var body: some View {
        VStack(spacing: 0) {
            titleBar
            MessageList(messages: store.state.messages)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .safeAreaInset(edge: .bottom) {
            Composer(
                canSend: store.state.status == .ready,
                ttsEnabled: store.state.prefs.ttsEnabled,
                micActive: store.state.voiceMode == .active,
                canInterrupt: canInterrupt,
                onSend: { store.sendText($0) },
                onMicToggle: toggleMic,
                onTtsToggle: { store.setTtsEnabled(!store.state.prefs.ttsEnabled) },
                onInterrupt: { store.interrupt() }
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .duskTheme()
    }

    // ── Title bar ───────────────────────────────────────────────────────────
    //
    // The `chat-screen` identifier sits on the title text (a leaf), NOT the
    // screen root: a container-level accessibilityIdentifier in SwiftUI
    // propagates down to descendant leaves and overrides the inner control
    // identifiers (chat-input/chat-send/...), which breaks the e2e contract.
    // Keeping it on a leaf lets the controls keep their own identifiers.

    private var titleBar: some View {
        HStack {
            Text(Self.title)
                .font(.system(size: TypeScale.lg, weight: .semibold))
                .foregroundStyle(DuskColors.ink)
                .accessibilityIdentifier("chat-screen")
            Spacer()
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    /// Mic toggle is present for D-I3; the full capture pipeline is Phase-3 (E3).
    /// It flips the voice-mode latch via the store passthroughs.
    private func toggleMic() {
        if store.state.voiceMode == .active {
            store.stopMic()
        } else {
            store.startMic()
        }
    }
}
