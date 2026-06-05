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

    @State private var historyPresented = false
    @State private var settingsPresented = false

    private static let title = "Sentient"

    private var canInterrupt: Bool {
        store.state.cognition != .idle || store.state.isSpeaking
    }

    /// Single source of the avatar animation mode for this frame — bound at the
    /// title-bar mark AND the live streaming assistant bubble (mirrors Android).
    private var currentMarkMode: MarkMode { markMode(of: store.state) }

    private var voiceActive: Bool { store.state.voiceMode == .active }

    private var transcriptVisible: Bool {
        voiceActive && !store.state.transcript.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            titleBar
            // TODO(userName): surface real display name from auth profile
            MessageList(messages: store.state.messages, activeMarkMode: currentMarkMode, userName: "You")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if transcriptVisible {
                TranscriptPreview(text: store.state.transcript)
            }
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
        .sheet(isPresented: $historyPresented) {
            // The sheet owns its HistoryModel built over the single app SdkStore
            // (read here, where @EnvironmentObject is resolved). One store → one
            // SDK; no second transport. nowMs is captured once per present so the
            // date labels read a stable clock for the sheet's lifetime.
            HistorySheet(
                store: store,
                nowMs: Int64(Date().timeIntervalSince1970 * 1000),
                onDismiss: { historyPresented = false }
            )
        }
        .sheet(isPresented: $settingsPresented) {
            // Thin settings sheet (D-I5). logout() = disconnect + clear the
            // Keychain token through the single app SdkStore — RootView reacts
            // to status != .ready and swaps to login (no explicit nav here).
            SettingsSheet(
                onLogout: {
                    store.logout()
                    settingsPresented = false
                },
                onDismiss: { settingsPresented = false }
            )
        }
    }

    // ── Title bar ───────────────────────────────────────────────────────────
    //
    // The `chat-screen` identifier sits on the title text (a leaf), NOT the
    // screen root: a container-level accessibilityIdentifier in SwiftUI
    // propagates down to descendant leaves and overrides the inner control
    // identifiers (chat-input/chat-send/...), which breaks the e2e contract.
    // Keeping it on a leaf lets the controls keep their own identifiers.

    private var titleBar: some View {
        HStack(spacing: Space.sm) {
            Button { historyPresented = true } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: TypeScale.lg))
                    .foregroundStyle(DuskColors.ink2)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("History")
            .accessibilityIdentifier("history-open")
            SentientMark(size: ChatLayout.markSize, mode: currentMarkMode)
            Text(Self.title)
                .font(.system(size: TypeScale.lg, weight: .semibold))
                .foregroundStyle(DuskColors.ink)
                .accessibilityIdentifier("chat-screen")
            Spacer()
            Button { settingsPresented = true } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: TypeScale.lg))
                    .foregroundStyle(DuskColors.ink2)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("settings-open")
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    /// Mic toggle flips the voice pipeline on/off via the store passthroughs
    /// (startMic/stopMic). The Composer gates the start path on the record
    /// permission; here we only mirror the voiceMode latch.
    private func toggleMic() {
        if store.state.voiceMode == .active {
            store.stopMic()
        } else {
            store.startMic()
        }
    }
}

/// Live STT preview while voiceMode is .active — mirrors the webui
/// .chat-view__transcript and the Android TranscriptPreview: an accent left-rule
/// + italic, muted text. Hidden when empty (the host gates on `transcriptVisible`).
private struct TranscriptPreview: View {
    let text: String

    var body: some View {
        HStack(alignment: .center, spacing: Space.sm) {
            RoundedRectangle(cornerRadius: 1)
                .fill(DuskColors.accent)
                .frame(width: ChatLayout.transcriptRule, height: TypeScale.base)
            Text(text)
                .font(.system(size: TypeScale.base).italic())
                .foregroundStyle(DuskColors.ink3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .accessibilityIdentifier("voice-transcript")
    }
}

private enum ChatLayout {
    static let markSize: CGFloat = 26
    static let transcriptRule: CGFloat = 2
}
