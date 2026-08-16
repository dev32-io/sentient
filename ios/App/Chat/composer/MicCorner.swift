// ---------------------------------------------------------------------------
// MicCorner — hold-to-talk / drag-to-lock mic control welded onto the
// composer card's top-right edge (half overhanging). Combined push-to-talk +
// toggle-to-talk, mirroring the webui control
// (gateway/webui/src/components/dock/mic-corner.tsx):
//
//   press → hold (mic on immediately) · drag LEFT along the travel (button
//   tracks the finger raw, clamped 0…travel) · release ≥40% travel → locked
//   (snap to far end, haptic) · release <40% → idle (spring back, mic off).
//   From locked: press again (base = travel), drag back right; release ≤50%
//   travel → idle (mic off, haptic); else snap back locked.
//
// The pure FSM lives in MicCornerGesture.swift; visual layers + constants in
// MicCornerVisuals.swift. The control owns only its gesture state — each FSM
// transition is translated to ONE SDK talk-mode intent (pure gesture→intent, zero
// mode semantics: the SDK's TalkModeController owns them all) and the composer's
// takeover follows onModeChange. `micActive` is the external-sync input: a true→false
// edge while held/locked and not dragging (disconnect, teardown, or an SDK
// start that failed downstream) resets the control to idle WITHOUT emitting an
// intent.
//
// beginPress is the permission gate (Composer+Mic.onMicPressGate): a press
// from idle only enters hold when it returns true; a press from locked never
// re-asks (the mic is already running).
//
// accessibilityIdentifier: chat-mic (switch-like; value reflects locked;
// VoiceOver activate toggles the hands-free lock — webui keyboard parity).
// ---------------------------------------------------------------------------
import SwiftUI
import UIKit
import MobileData

struct MicCorner: View {
    /// Mirrors voiceMode == .active — external sync input, never written here.
    let talkMode: TalkMode
    /// Permission gate for a press from idle: true → enter hold + start.
    let beginPress: () -> Bool
    /// Composer takeover (waveform, hidden buttons) follows the reported mode.
    /// idle→hold (press): enter push-to-talk.
    let onPress: () -> Void
    /// hold→idle (release below the lock threshold): end the manual turn.
    let onRelease: () -> Void
    /// hold→locked (release past the lock threshold / slide-to-lock): enter continuous.
    let onLock: () -> Void
    /// locked→idle (unlock release / tap-to-stop): leave continuous.
    let onStopContinuous: () -> Void

    private var mode: MicCornerMode {
        switch talkMode {
        case .idle: return .idle
        case .hold: return .hold
        case .continuous: return .locked
        }
    }
    /// Button offset toward the lock end, 0…travel. Raw while dragging;
    /// spring-animated on release/reset.
    @State private var drag: CGFloat = 0
    @State private var dragging = false
    /// Press denied by the permission gate — swallow the rest of this gesture.
    @State private var pressRejected = false
    /// Mode the active gesture started from (resolves the release).
    @State private var origin: MicCornerMode = .idle
    /// Drag offset the gesture started from (0 from idle, travel from locked).
    @State private var base: CGFloat = 0
    /// Increments per hold entry — re-keys the ripple so it replays.
    @State private var rippleTick = 0
    @State private var glyphScale: CGFloat = 1
    @State private var bodyScale: CGFloat = 1
    @State private var glyphDimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let log = AppLog("composer", "mic-corner")

    // ── Derived ───────────────────────────────────────────────────────────

    /// Live = ember styling (accent glyph / border / glow): dragging or locked.
    private var isLive: Bool { dragging || mode == .locked }
    private var isArmed: Bool { MicCornerGesture.isArmed(drag: drag, travel: MicCornerLayout.travel) }
    private var progress: CGFloat { min(1, max(0, drag / MicCornerLayout.travel)) }
    private var breatheActive: Bool { mode == .idle && !dragging && !reduceMotion }

    // ── Body ──────────────────────────────────────────────────────────────

    var body: some View {
        ZStack {
            MicCornerTrail(progress: progress)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, MicCornerLayout.buttonSize / 2)
                .allowsHitTesting(false)
            MicCornerDetent(visible: isLive && mode != .locked, armed: isArmed)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, MicCornerLayout.detentInset)
                .allowsHitTesting(false)
            button
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .frame(width: MicCornerLayout.wrapWidth, height: MicCornerLayout.buttonSize)
        .onChange(of: talkMode) { _, now in
            // Shared Idle is authoritative after teardown/failure; only reset the
            // presentation offset and never emit another stop intent.
            if now == .idle, !dragging {
                withAnimation(MicCornerMotion.settle) { drag = 0 }
            }
        }
        .task(id: breatheActive) {
            // Idle rest hint — glyph breathes opacity .85↔1 (webui
            // mic-corner-breathe); suppressed under Reduce Motion.
            if breatheActive {
                withAnimation(
                    .easeInOut(duration: MicCornerMotion.breatheHalfPeriod).repeatForever(autoreverses: true)
                ) { glyphDimmed = true }
            } else {
                withAnimation(.easeOut(duration: 0.15)) { glyphDimmed = false }
            }
        }
    }

    // ── Button ────────────────────────────────────────────────────────────

    private var button: some View {
        ZStack {
            MicCornerBody(live: isLive, locked: mode == .locked, armed: isArmed, scale: bodyScale)
            if rippleTick > 0, !reduceMotion {
                MicCornerRipple().id(rippleTick)
            }
            Image(systemName: "mic")
                .font(.system(size: ComposerLayout.glyph))
                .foregroundStyle(isLive ? DuskColors.accent : DuskColors.ink3)
                .opacity(glyphDimmed ? MicCornerMotion.breatheDimOpacity : 1)
                .scaleEffect(glyphScale)
        }
        .frame(width: MicCornerLayout.buttonSize, height: MicCornerLayout.buttonSize)
        .contentShape(RoundedRectangle(cornerRadius: MicCornerLayout.cornerRadius))
        .offset(x: -drag)
        .highPriorityGesture(dragGesture)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            mode == .locked
                ? "Hands-free listening on — drag back to stop"
                : "Hold to talk; slide to lock hands-free"
        )
        .accessibilityValue(mode == .locked ? "locked" : "off")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("chat-mic")
        .accessibilityAction { toggleLockForAccessibility() }
    }

    // ── Gesture ───────────────────────────────────────────────────────────

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in handleDragChanged(value) }
            .onEnded { _ in handleDragEnded() }
    }

    private func handleDragChanged(_ value: DragGesture.Value) {
        if !dragging, !pressRejected {
            beginGesture()
        }
        guard dragging else { return }
        // Leftward finger = startX > currentX → positive drag (webui clampDrag
        // math). Raw tracking — no animation while the finger is down.
        drag = MicCornerGesture.clampDrag(
            base: base,
            startX: value.startLocation.x,
            currentX: value.location.x,
            travel: MicCornerLayout.travel
        )
    }

    private func beginGesture() {
        if mode == .locked {
            origin = .locked
            base = MicCornerLayout.travel
        } else {
            guard beginPress() else {
                // No record permission (denied notice shown or request just
                // fired) — do NOT enter hold; ignore the rest of this gesture.
                pressRejected = true
                log.info("press-rejected reason=permission")
                return
            }
            origin = .idle
            base = 0
            fireRipple()
            setMode(.hold, trigger: "press")
        }
        drag = base
        dragging = true
    }

    private func handleDragEnded() {
        pressRejected = false
        guard dragging else { return }
        dragging = false
        let travel = MicCornerLayout.travel
        let outcome = MicCornerGesture.resolveRelease(origin: origin, drag: drag, travel: travel)
        log.info(
            "release origin=\(origin.rawValue) drag=\(Int(drag)) travel=\(Int(travel)) outcome=\(outcome.mode.rawValue)"
        )
        withAnimation(MicCornerMotion.settle) { drag = outcome.drag }
        if outcome.mode == .locked, origin == .idle { impact(.medium) }
        if outcome.mode == .idle, origin == .locked { impact(.light) }
        setMode(outcome.mode, trigger: "release")
    }

    // ── Mode transitions ──────────────────────────────────────────────────

    private func setMode(_ next: MicCornerMode, trigger: String) {
        guard next != mode else { return }
        let prev = mode
        log.info("mode-change from=\(prev.rawValue) to=\(next.rawValue) trigger=\(trigger)")
        if next == .locked { snapBounce() }
        emitIntent(from: prev, to: next)
    }

    /// Pure gesture→intent translation — the one place the corner speaks to the SDK.
    /// Zero mode semantics: it only names which talk-mode intent each FSM transition maps
    /// to; the TalkModeController owns interrupt-on-press, turnMode, and buffer-and-defer.
    /// idle→locked (VoiceOver direct-lock) composes press+lock (Idle→Hold→Continuous).
    private func emitIntent(from: MicCornerMode, to: MicCornerMode) {
        switch (from, to) {
        case (.idle, .hold): onPress()
        case (.hold, .idle): onRelease()
        case (.hold, .locked): onLock()
        case (.locked, .idle): onStopContinuous()
        case (.idle, .locked): onPress(); onLock()
        default: break
        }
    }

    /// VoiceOver can't drag — activate toggles the hands-free lock directly
    /// (parity with the webui keyboard path).
    private func toggleLockForAccessibility() {
        if mode == .locked {
            withAnimation(MicCornerMotion.settle) { drag = 0 }
            impact(.light)
            setMode(.idle, trigger: "accessibility")
        } else if beginPress() {
            withAnimation(MicCornerMotion.settle) { drag = MicCornerLayout.travel }
            impact(.medium)
            setMode(.locked, trigger: "accessibility")
        }
    }

    // ── Motion + haptics ──────────────────────────────────────────────────

    private func fireRipple() {
        guard !reduceMotion else { return }
        rippleTick += 1
    }

    /// Lock snap — glyph + body spring back from an undershoot so they
    /// overshoot past 1 and settle (webui mic-snap / mic-settle keyframes).
    private func snapBounce() {
        guard !reduceMotion else { return }
        glyphScale = MicCornerMotion.snapGlyphStartScale
        bodyScale = MicCornerMotion.snapBodyStartScale
        withAnimation(MicCornerMotion.snap) {
            glyphScale = 1
            bodyScale = 1
        }
    }

    private func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }
}

#Preview("Corner mic — idle (interactive)") {
    MicCorner(
        talkMode: .idle,
        beginPress: { true },
        onPress: {},
        onRelease: {},
        onLock: {},
        onStopContinuous: {}
    )
    .padding(Space.xxl)
    .background(DuskColors.paper)
    .padding(Space.xxl)
    .background(DuskColors.bg)
}
