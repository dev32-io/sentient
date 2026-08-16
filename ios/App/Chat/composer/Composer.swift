// ---------------------------------------------------------------------------
// Composer — the chat input dock, mirroring the Android Composer
// (android/.../chat/Composer.kt) and the webui Composer
// (gateway/webui/src/components/dock/composer.tsx).
//
// A paper-surface rounded card holding a text field over a button row: TTS
// toggle, attach, a spacer, optional interrupt, and send — plus the MicCorner
// hold-to-talk / drag-to-lock control welded onto the card's top-right edge
// (half overhanging, webui parity). Send is enabled whenever the draft is
// non-empty; a send issued before READY is queued by the outbox and flushed
// on the READY edge (web-sdk parity, always-typeable). Interrupt is shown
// only when cognition != .idle || isSpeaking. TTS toggle flips the
// server-of-record preference via setTtsEnabled.
//
// MicCorner: press → hold (mic on), drag left ≥40% travel → locked
// hands-free, drag back from locked ≤50% → off. While hold/locked the
// composer "takes over": the text field hides (draft PRESERVED), PttBigWave
// overlays the FULL card (background layer — zero layout impact, so the
// composer height is identical idle vs live), and TTS/attach/send hide —
// interrupt stays on top while a cycle is in flight. The permission gate
// lives in Composer+Mic.swift
// (onMicPressGate + MicPermission): a press without record permission
// requests it and does NOT enter hold; a grant does NOT auto-start. The
// listening glow stays keyed on micActive.
//
// Send is optimistic — it returns immediately and the outbox renders the
// pending bubble, so the composer NEVER spins on the socket (no in-flight
// spinner). The send button is always the paper-plane action, enabled on a
// non-empty draft.
//
// The composer owns only the draft text, the mic-denied flag, and the corner
// mic's reported mode (local @State); everything else is read from SdkState
// and dispatched up through callbacks. The host docks it via
// .safeAreaInset(edge:.bottom); SwiftUI lifts it above the keyboard.
//
// Mic gate/previews live in Composer+Mic.swift (line-limit compliance).
//
// accessibilityIdentifiers: composer-input (TextField, matches Android tag),
// chat-send, chat-interrupt, chat-tts-toggle, chat-attach, chat-mic
// (MicCorner), mic-denied-notice.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct Composer: View {
    /// Composer task strip's live rows (`ChatModel.tasks`) — rendered as the
    /// first child of the card, above the mic-denied notice and draft field.
    /// Server-owned full state; the composer renders it, deriving nothing.
    let tasks: [TaskListItem]
    /// Tints the send glyph as ready. Passed `true` now (the outbox queues any
    /// send issued before READY), so it no longer gates submission.
    let canSend: Bool
    /// Server-of-record TTS preference (mirrored, not owned).
    let ttsEnabled: Bool
    /// True while voiceMode == .active — drives the listening glow and the
    /// MicCorner external sync (a true→false teardown resets the control).
    let talkMode: TalkMode
    /// True when a cycle is in flight or audio is playing.
    let canInterrupt: Bool
    let onSend: (String) -> Void
    /// Corner mic pressed (idle→hold) — enter push-to-talk.
    let onMicPress: () -> Void
    /// Corner mic released below the lock threshold (hold→idle).
    let onMicRelease: () -> Void
    /// Corner mic slid to lock (hold→locked) — enter continuous.
    let onMicLock: () -> Void
    /// Locked control released to stop (locked→idle) — leave continuous.
    let onMicStopContinuous: () -> Void
    let onTtsToggle: () -> Void
    let onInterrupt: () -> Void
    /// Composer gained keyboard focus — the host ensures the connection is live so the
    /// first send isn't blocked by a stale reconnect race. Fired on the focus rising edge.
    let onFocusGained: () -> Void

    @State var draft = ""
    @State var micDenied = false
    /// Corner-mic mode as reported by MicCorner — drives the recording takeover.
    @FocusState private var inputFocused: Bool

    let log = AppLog("composer")
    private static let micDeniedNotice = "Microphone access is needed for voice. Enable it in Settings."

    private var sendEnabled: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && canSend
    }

    /// True while the corner mic holds the composer (hold or locked).
    private var isRecording: Bool { talkMode != .idle }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            card
            micCorner
        }
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
        .onChange(of: inputFocused) { _, focused in
            // Fire the engagement signal only on the focus rising edge (gained), not
            // on blur. The host routes it to ensureConnected.
            if focused {
                log.info("composer.focus-gained")
                onFocusGained()
            }
        }
    }

    // ── Card ─────────────────────────────────────────────────────────────────

    private var card: some View {
        VStack(spacing: Space.sm) {
            ComposerTaskStrip(items: tasks)
            if micDenied { micDeniedRow }
            draftField
            buttonRow
        }
        .padding(Space.md)
        .background {
            // Recording takeover wave — webui parity (absolute inset-0 overlay
            // across the whole card): spans the FULL card width with symmetric
            // horizontal padding matching the card padding, vertically centered
            // over the whole composer content. A background layer NEVER affects
            // layout (composer height is identical idle vs live) and draws
            // behind the content, so interrupt stays visible + tappable on top.
            // Background layers stack back-to-front: paper (below) → wave → content.
            if isRecording {
                PttBigWave()
                    .padding(.horizontal, Space.md)
                    .transition(.opacity.combined(with: .offset(y: 5)))
            }
        }
        .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: ComposerLayout.radius))
        .shadow(
            // Soft amber halo — mirrors the webui composer glow; intensifies while
            // the mic is active (listening state). Color from DuskColors.amber token.
            color: DuskColors.amber.opacity(
                talkMode != .idle ? ComposerLayout.glowListeningOpacity : ComposerLayout.glowOpacity
            ),
            radius: ComposerLayout.glowRadius
        )
        .overlay(
            // Listening glow: the whole composer card borders accent while the mic
            // is active (mirrors webui .composer--listening).
            RoundedRectangle(cornerRadius: ComposerLayout.radius)
                .stroke(talkMode != .idle ? DuskColors.accent : DuskColors.line, lineWidth: 1)
        )
    }

    // ── Corner mic ────────────────────────────────────────────────────────────
    //
    // Welded onto the card's top-right edge, half overhanging (offset, no
    // clipping — SwiftUI doesn't clip out-of-bounds children).

    private var micCorner: some View {
        MicCorner(
            talkMode: talkMode,
            beginPress: onMicPressGate,
            onPress: onMicPress,
            onRelease: onMicRelease,
            onLock: onMicLock,
            onStopContinuous: onMicStopContinuous
        )
        .padding(.trailing, MicCornerLayout.trailingInset)
        .offset(y: -MicCornerLayout.overhang)
    }

    // ── Draft field ─────────────────────────────────────────────────────────

    private var draftField: some View {
        TextField(
            canInterrupt ? "Type to interrupt…" : "Message Sentient",
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
        // Recording takeover: hide, don't remove — opacity keeps the field's
        // measured size (and the draft), so the composer height is IDENTICAL
        // idle vs live. The wave draws in the card's background overlay.
        .opacity(isRecording ? 0 : 1)
        .allowsHitTesting(!isRecording)
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
            // TTS/attach/send hide during the recording takeover (the corner
            // control + waveform own the composer); interrupt stays reachable
            // mid-cycle. minHeight keeps the card from jumping when they hide.
            if !isRecording {
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
            }
            Spacer()
            if canInterrupt { interruptButton }
            if !isRecording { sendButton }
        }
        .frame(minHeight: ComposerLayout.buttonSize)
    }

    private var interruptButton: some View {
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

    // ── Send button ───────────────────────────────────────────────────────────
    //
    // Always the paper-plane action, enabled on a non-empty draft. There is no
    // in-flight spinner: an optimistic send returns immediately (the outbox shows
    // the pending bubble), so the composer never spins on the socket.

    private var sendButton: some View {
        ComposerAction(
            systemName: "paperplane.fill",
            tint: sendEnabled ? DuskColors.accent : DuskColors.ink4,
            action: submit
        )
        .disabled(!sendEnabled)
        .accessibilityLabel("Send")
        .accessibilityIdentifier("chat-send")
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
