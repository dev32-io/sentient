// ---------------------------------------------------------------------------
// Composer — the chat input dock, mirroring the Android Composer
// (android/.../chat/Composer.kt) and the webui Composer
// (gateway/webui/src/components/dock/composer.tsx).
//
// A paper-surface rounded card holding a text field over a button row: mic
// toggle, TTS toggle, a spacer, optional interrupt, and send. Send is disabled
// when the field is empty OR the SDK is not READY. Interrupt is shown only when
// cognition != .idle || isSpeaking (a cycle is in flight or audio is playing).
// TTS toggle flips the server-of-record preference via setTtsEnabled.
//
// Mic button (E5): tapping it gates on the AVAudio record permission. If already
// granted → toggle voice immediately; otherwise request it (iOS 17+
// AVAudioApplication.requestRecordPermission, AVAudioSession fallback) and toggle
// on grant; on denial show a one-shot inline notice and do NOT start (audio rule:
// graceful mic-denial fallback). When voiceMode .active the mic button wears the
// accent "mic-on" styling. An already-active mic stops without a permission check.
//
// The composer owns only the draft text + the mic-denied flag (local @State);
// everything else is read from SdkState and dispatched up through callbacks. The
// host docks it via .safeAreaInset(edge:.bottom); SwiftUI lifts it above the
// keyboard.
//
// accessibilityIdentifiers: chat-input, chat-send, chat-interrupt,
// chat-tts-toggle, chat-mic, mic-denied-notice.
// ---------------------------------------------------------------------------
import AVFoundation
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
    @State private var micDenied = false
    @FocusState private var inputFocused: Bool

    private let log = AppLog("composer")
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
        .overlay(
            // Listening glow: the whole composer card borders accent while the mic
            // is active (mirrors webui .composer--listening).
            RoundedRectangle(cornerRadius: ComposerLayout.radius)
                .stroke(micActive ? DuskColors.accent : DuskColors.line, lineWidth: 1)
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
            Spacer()
            if canInterrupt {
                ComposerAction(systemName: "stop.fill", tint: DuskColors.stop, action: onInterrupt)
                    .accessibilityLabel("Stop")
                    .accessibilityIdentifier("chat-interrupt")
            }
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

    private func submit() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, canSend else { return }
        onSend(trimmed)
        draft = ""
    }

    // ── Mic permission gate ───────────────────────────────────────────────────
    //
    // Active mic → stop without a permission check. Inactive → gate on the
    // AVAudio record permission: granted toggles immediately; undetermined
    // requests it and toggles on grant; denied shows the inline notice and does
    // NOT start. The request hop lands back on the main actor before mutating UI.

    private func onMicTap() {
        if micActive {
            onMicToggle()
            return
        }
        switch MicPermission.status() {
        case .granted:
            micDenied = false
            onMicToggle()
        case .denied:
            log.warn("micTap denied")
            micDenied = true
        case .undetermined:
            log.info("micTap requesting permission")
            MicPermission.request { granted in
                Task { @MainActor in
                    log.info("micPermissionResult granted=\(granted)")
                    if granted {
                        micDenied = false
                        onMicToggle()
                    } else {
                        micDenied = true
                    }
                }
            }
        }
    }
}

/// Record-permission gate over AVAudio. The app's deployment target is iOS 17,
/// so this routes through `AVAudioApplication` (the iOS 17+ replacement for the
/// deprecated `AVAudioSession` permission API). Three states mirror the Android
/// RECORD_AUDIO gate (granted / denied / undetermined).
private enum MicPermission {
    enum Status { case granted, denied, undetermined }

    static func status() -> Status {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default: return .undetermined
        }
    }

    static func request(_ completion: @escaping (Bool) -> Void) {
        AVAudioApplication.requestRecordPermission(completionHandler: completion)
    }
}

/// A composer on/off toggle (mic, TTS) — a rounded-square icon button. Off:
/// slashed glyph in ink-3 on the sunk surface with a line border. On: the glyph
/// + border in accent over an accent-tinted fill. Mirrors the webui
/// icon-btn--mic-on/off + tts-on/off variants.
private struct ComposerToggle: View {
    let systemName: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: ComposerLayout.glyph))
                .foregroundStyle(on ? DuskColors.accent : DuskColors.ink3)
                .frame(width: ComposerLayout.buttonSize, height: ComposerLayout.buttonSize)
                .background(
                    on ? DuskColors.accent.opacity(ComposerLayout.onTint) : DuskColors.bgSunk,
                    in: RoundedRectangle(cornerRadius: Radii.sm)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Radii.sm)
                        .stroke(on ? DuskColors.accent.opacity(ComposerLayout.onBorder) : DuskColors.line, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }
}

/// A composer action button (interrupt, send) — icon-only, no toggle box; the
/// tint carries its meaning (stop = stop color, send = accent / ink-4 disabled).
private struct ComposerAction: View {
    let systemName: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: ComposerLayout.glyph, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: ComposerLayout.buttonSize, height: ComposerLayout.buttonSize)
        }
        .buttonStyle(.plain)
    }
}

private enum ComposerLayout {
    static let radius: CGFloat = 14
    static let buttonSize: CGFloat = 38
    static let glyph: CGFloat = 18
    /// Accent-tint fill / border opacities for the "on" state (≈ webui
    /// color-mix(accent 14% / 35%)).
    static let onTint: CGFloat = 0.14
    static let onBorder: CGFloat = 0.4
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
