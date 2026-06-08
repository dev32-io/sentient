// ---------------------------------------------------------------------------
// Composer — the chat input dock, mirroring the Android Composer
// (android/.../chat/Composer.kt) and the webui Composer
// (gateway/webui/src/components/dock/composer.tsx).
//
// A paper-surface rounded card holding a text field over a button row: mic
// toggle, TTS toggle, a spacer, optional interrupt, and send. Send is enabled
// whenever the draft is non-empty; a send issued before READY is queued by
// the outbox and flushed on the READY edge (web-sdk parity, always-typeable).
// Interrupt is shown only when
// cognition != .idle || isSpeaking (a cycle is in flight or audio is playing).
// TTS toggle flips the server-of-record preference via setTtsEnabled.
//
// Mic button (E5): permission gate lives in Composer+Mic.swift (onMicTap +
// MicPermission). When voiceMode .active the mic button wears the accent
// "mic-on" styling.
//
// In-flight send: when sendInFlight == true the send button is replaced by a
// small ProgressView (a11y id chat-send-spinner), signalling the pending queue.
//
// The composer owns only the draft text + the mic-denied flag (local @State);
// everything else is read from SdkState and dispatched up through callbacks.
// The host docks it via .safeAreaInset(edge:.bottom); SwiftUI lifts it above
// the keyboard.
//
// Mic/preview extracted to Composer+Mic.swift (line-limit compliance).
//
// accessibilityIdentifiers: composer-input (TextField, matches Android tag),
// chat-send, chat-send-spinner, chat-interrupt, chat-tts-toggle, chat-mic, mic-denied-notice.
// ---------------------------------------------------------------------------
import AVFoundation
import SwiftUI
import MobileData

struct Composer: View {
    /// Tints the send glyph as ready. Passed `true` now (the outbox queues any
    /// send issued before READY), so it no longer gates submission.
    let canSend: Bool
    /// Server-of-record TTS preference (mirrored, not owned).
    let ttsEnabled: Bool
    /// True while voiceMode == .active.
    let micActive: Bool
    /// True when a cycle is in flight or audio is playing.
    let canInterrupt: Bool
    /// True while a user message is pending in the send queue (hasPendingSends).
    let sendInFlight: Bool
    let onSend: (String) -> Void
    let onMicToggle: () -> Void
    let onTtsToggle: () -> Void
    let onInterrupt: () -> Void

    @State var draft = ""
    @State var micDenied = false
    @FocusState private var inputFocused: Bool

    let log = AppLog("composer")
    private static let micDeniedNotice = "Microphone access is needed for voice. Enable it in Settings."

    private var sendEnabled: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && canSend
    }

    var body: some View {
        VStack(spacing: Space.sm) {
            if micDenied { micDeniedRow }
            draftField
            buttonRow
        }
        .padding(Space.md)
        .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: ComposerLayout.radius))
        .shadow(
            // Soft amber halo — mirrors the webui composer glow; intensifies while
            // the mic is active (listening state). Color from DuskColors.amber token.
            color: DuskColors.amber.opacity(
                micActive ? ComposerLayout.glowListeningOpacity : ComposerLayout.glowOpacity
            ),
            radius: ComposerLayout.glowRadius
        )
        .overlay(
            // Listening glow: the whole composer card borders accent while the mic
            // is active (mirrors webui .composer--listening).
            RoundedRectangle(cornerRadius: ComposerLayout.radius)
                .stroke(micActive ? DuskColors.accent : DuskColors.line, lineWidth: 1)
        )
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
        .simultaneousGesture(
            // Swipe-down to dismiss keyboard; simultaneousGesture preserves TextField
            // touch handling (text selection / caret placement).
            DragGesture(minimumDistance: ComposerLayout.dismissDragThreshold)
                .onEnded { value in
                    if value.translation.height > ComposerLayout.dismissDragThreshold {
                        inputFocused = false
                        log.info("keyboard.dismiss reason=swipe-down")
                    }
                }
        )
    }

    // ── Derived state ───────────────────────────────────────────────────────

    private var showWave: Bool { micActive && draft.isEmpty }

    // ── Draft field ─────────────────────────────────────────────────────────

    private var draftField: some View {
        ZStack(alignment: .leading) {
            TextField(
                showWave ? "" : (canInterrupt ? "Type to interrupt…" : "Message Sentient"),
                text: $draft,
                axis: .vertical
            )
            .lineLimit(1...6)
            .font(Typo.ui(TypeScale.base))
            .foregroundStyle(DuskColors.ink)
            .tint(DuskColors.accent)
            .focused($inputFocused)
            .padding(.vertical, Space.xs)
            // "composer-input" matches the Android Compose testTag for cross-platform
            // Maestro flows. "chat-input" is kept as an accessibility label alias.
            .accessibilityIdentifier("composer-input")
            if showWave { ListeningWaveform() }
        }
    }

    // ── Mic-denied notice ─────────────────────────────────────────────────────

    private var micDeniedRow: some View {
        Text(Self.micDeniedNotice)
            .font(.system(size: TypeScale.sm))
            .foregroundStyle(DuskColors.stop)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("mic-denied-notice")
    }

    // ── Button row ──────────────────────────────────────────────────────────

    private var buttonRow: some View {
        HStack(spacing: Space.sm) {
            // mic + TTS are toggles: rounded-square, slashed glyph + sunk bg when
            // off, accent glyph + accent-tint bg + accent border when on (webui
            // icon-btn--mic-on/off, tts-on/off).
            ComposerToggle(systemName: micActive ? "mic" : "mic.slash", on: micActive, action: onMicTap)
                .accessibilityLabel("Microphone")
                .accessibilityIdentifier("chat-mic")
            ComposerToggle(
                systemName: ttsEnabled ? "speaker.wave.2" : "speaker.slash",
                on: ttsEnabled,
                action: onTtsToggle
            )
            .accessibilityLabel("Toggle speech")
            .accessibilityIdentifier("chat-tts-toggle")
            ComposerToggle(systemName: "paperclip", on: false, action: {})
                .accessibilityLabel("Attach")
                .accessibilityIdentifier("chat-attach")
            Spacer()
            if canInterrupt {
                Button(action: onInterrupt) {
                    RoundedRectangle(cornerRadius: ComposerLayout.stopGlyphRadius).fill(DuskColors.stop)
                        .frame(width: ComposerLayout.stopIconSize, height: ComposerLayout.stopIconSize)
                        .frame(width: ComposerLayout.buttonSize, height: ComposerLayout.buttonSize)
                        .background(DuskColors.stop.opacity(0.16), in: RoundedRectangle(cornerRadius: Radii.sm))
                        .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.stop.opacity(0.35), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop")
                .accessibilityIdentifier("chat-interrupt")
            }
            sendButton
        }
    }

    // ── Send button / in-flight spinner ──────────────────────────────────────

    @ViewBuilder
    private var sendButton: some View {
        if sendInFlight {
            ProgressView()
                .controlSize(.small)
                .tint(DuskColors.accent)
                .frame(width: ComposerLayout.buttonSize, height: ComposerLayout.buttonSize)
                .accessibilityIdentifier("chat-send-spinner")
        } else {
            ComposerAction(
                systemName: "paperplane.fill",
                tint: sendEnabled ? DuskColors.accent : DuskColors.ink4,
                action: submit
            )
            .disabled(!sendEnabled)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("chat-send")
        }
    }

    // ── Submit ──────────────────────────────────────────────────────────────

    func submit() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, canSend else { return }
        onSend(trimmed)
        draft = ""
        // Resign focus on send so the multiline TextField reliably redraws empty.
        // Clearing `draft` while the field stays first-responder can leave stale text
        // until a focus change (SwiftUI `axis: .vertical` / IME redraw race) — the bug
        // where the sent message lingered in the composer until the user tapped away.
        inputFocused = false
    }
}
