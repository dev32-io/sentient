// ---------------------------------------------------------------------------
// Composer — the chat input dock, mirroring the Android Composer
// (android/.../chat/Composer.kt) and the webui Composer
// (gateway/webui/src/components/dock/composer.tsx).
//
// A paper-surface rounded card holding a text field over a button row: mic
// toggle, TTS toggle, a spacer, optional interrupt, and send. Send is disabled
// when the field is empty OR the SDK is not READY. Interrupt is shown only when
// cognition != .idle || isSpeaking (a cycle is in flight or audio is playing).
// Mic toggle flips startMic/stopMic — the full mic pipeline is Phase-3 (E3), so
// it just latches voiceMode for now. TTS toggle flips the server-of-record
// preference via setTtsEnabled.
//
// The composer owns only the draft text (local @State); everything else is read
// from SdkState and dispatched up through callbacks. The host docks it via
// .safeAreaInset(edge:.bottom); SwiftUI lifts it above the keyboard.
//
// accessibilityIdentifiers: chat-input, chat-send, chat-interrupt, chat-tts-toggle.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

struct Composer: View {
    /// True when the SDK is READY (text submission flows).
    let canSend: Bool
    /// Server-of-record TTS preference (mirrored, not owned).
    let ttsEnabled: Bool
    /// True while voiceMode == .active.
    let micActive: Bool
    /// True when a cycle is in flight or audio is playing.
    let canInterrupt: Bool
    let onSend: (String) -> Void
    let onMicToggle: () -> Void
    let onTtsToggle: () -> Void
    let onInterrupt: () -> Void

    @State private var draft = ""
    @FocusState private var inputFocused: Bool

    private var sendEnabled: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && canSend
    }

    var body: some View {
        VStack(spacing: Space.sm) {
            draftField
            buttonRow
        }
        .padding(Space.md)
        .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: ComposerLayout.radius))
        .overlay(
            RoundedRectangle(cornerRadius: ComposerLayout.radius)
                .stroke(DuskColors.line, lineWidth: 1)
        )
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
    }

    // ── Draft field ─────────────────────────────────────────────────────────

    private var draftField: some View {
        TextField("Message Sentient", text: $draft, axis: .vertical)
            .lineLimit(1...6)
            .font(.system(size: TypeScale.base))
            .foregroundStyle(DuskColors.ink)
            .tint(DuskColors.accent)
            .focused($inputFocused)
            .submitLabel(.send)
            .onSubmit(submit)
            .padding(.vertical, Space.xs)
            .accessibilityIdentifier("chat-input")
    }

    // ── Button row ──────────────────────────────────────────────────────────

    private var buttonRow: some View {
        HStack(spacing: Space.sm) {
            GlyphButton(systemName: micActive ? "mic.fill" : "mic", tint: DuskColors.ink2, action: onMicToggle)
                .accessibilityLabel("Microphone")
            GlyphButton(
                systemName: ttsEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill",
                tint: DuskColors.ink2,
                action: onTtsToggle
            )
            .accessibilityLabel("Toggle speech")
            .accessibilityIdentifier("chat-tts-toggle")
            Spacer()
            if canInterrupt {
                GlyphButton(systemName: "stop.fill", tint: DuskColors.stop, action: onInterrupt)
                    .accessibilityLabel("Stop")
                    .accessibilityIdentifier("chat-interrupt")
            }
            sendButton
        }
    }

    private var sendButton: some View {
        Button(action: submit) {
            Image(systemName: "arrow.up.circle.fill")
                .font(.system(size: ComposerLayout.buttonGlyph, weight: .semibold))
                .foregroundStyle(sendEnabled ? DuskColors.accent : DuskColors.ink4)
                .frame(width: ComposerLayout.buttonSize, height: ComposerLayout.buttonSize)
        }
        .buttonStyle(.plain)
        .disabled(!sendEnabled)
        .accessibilityLabel("Send")
        .accessibilityIdentifier("chat-send")
    }

    // ── Submit ──────────────────────────────────────────────────────────────

    private func submit() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, canSend else { return }
        onSend(trimmed)
        draft = ""
    }
}

/// One icon-only toggle in the composer button row.
private struct GlyphButton: View {
    let systemName: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: ComposerLayout.glyph))
                .foregroundStyle(tint)
                .frame(width: ComposerLayout.buttonSize, height: ComposerLayout.buttonSize)
        }
        .buttonStyle(.plain)
    }
}

private enum ComposerLayout {
    static let radius: CGFloat = 14
    static let buttonSize: CGFloat = 40
    static let glyph: CGFloat = 18
    static let buttonGlyph: CGFloat = 28
}

#Preview {
    VStack {
        Spacer()
        Composer(
            canSend: true,
            ttsEnabled: true,
            micActive: false,
            canInterrupt: true,
            onSend: { _ in },
            onMicToggle: {},
            onTtsToggle: {},
            onInterrupt: {}
        )
    }
    .background(DuskColors.bg)
}
