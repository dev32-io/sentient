// ---------------------------------------------------------------------------
// MicCornerVisuals — the corner mic control's visual layers plus its layout
// and motion constants, extracted from MicCorner.swift for the clean-code
// line limit.
//
// Ember colorway mapped from the webui CSS ("MicCorner" section of
// gateway/webui/src/styles/components.css): idle = sunk squircle, soft line
// border, ink-3 glyph; live (dragging or locked) = accent glyph, accent-mixed
// border + soft accent glow; armed = accent-50 ring flare + lit detent dot;
// locked = accent→sunk gradient body. A gradient trail follows the drag.
// ---------------------------------------------------------------------------
import SwiftUI

enum MicCornerLayout {
    /// Control button edge — matches the composer's other buttons (38pt).
    static let buttonSize: CGFloat = ComposerLayout.buttonSize
    /// Full wrap width — the horizontal rail the button slides along.
    static let wrapWidth: CGFloat = 104
    /// Drag travel toward the lock end: wrap − button (≈66pt).
    static let travel: CGFloat = wrapWidth - buttonSize
    /// Squircle corner radius of the body (webui border-radius: 11px).
    static let cornerRadius: CGFloat = 11
    /// Half the button overhangs the composer card's top edge.
    static let overhang: CGFloat = buttonSize / 2
    /// Gap between the control and the card's trailing edge (webui right: 10px).
    static let trailingInset: CGFloat = 10
    /// Drag-trail bar height (webui 4px).
    static let trailHeight: CGFloat = 4
    /// Lock-detent dot diameter + its inset from the wrap's leading edge.
    static let detentSize: CGFloat = 5
    static let detentInset: CGFloat = 6
    /// Detent scale once the drag has armed the lock.
    static let detentArmedScale: CGFloat = 1.7
    /// Armed ring flare width (webui box-shadow spread 4px).
    static let armedRingWidth: CGFloat = 4
}

enum MicCornerMotion {
    /// Springy settle on release — overshoots like the webui cubic-bezier(.3,1.75,.45,1).
    static let settle: Animation = .spring(response: 0.4, dampingFraction: 0.55)
    /// Lock snap bounce (webui mic-snap / mic-settle keyframes).
    static let snap: Animation = .spring(response: 0.35, dampingFraction: 0.45)
    /// Glyph undershoot the snap springs back from (webui mic-snap 0.62→1.2→1).
    static let snapGlyphStartScale: CGFloat = 0.62
    /// Body undershoot on lock (webui mic-settle 0.88→1.06→1).
    static let snapBodyStartScale: CGFloat = 0.88
    /// Idle glyph breathe half-period (webui 3s full cycle) + dim floor.
    static let breatheHalfPeriod: Double = 1.5
    static let breatheDimOpacity: Double = 0.85
    /// Press ripple expansion (webui mic-ripple 0.5s, scale .9→1.7, fade .9→0).
    static let rippleDuration: Double = 0.5
    /// Color / state crossfades (webui .22s transitions).
    static let fade: Animation = .easeInOut(duration: 0.22)
}

/// The squircle body — fill, border, glow, and the armed ring flare.
struct MicCornerBody: View {
    let live: Bool
    let locked: Bool
    let armed: Bool
    let scale: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: MicCornerLayout.cornerRadius)
        shape
            .fill(DuskColors.bgSunk)
            .overlay(
                // Locked body: accent→sunk linear gradient (webui 150deg).
                shape
                    .fill(
                        LinearGradient(
                            colors: [DuskColors.micLockedHi, DuskColors.micLockedLo],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .opacity(locked ? 1 : 0)
            )
            .overlay(
                shape.strokeBorder(live ? DuskColors.micLiveBorder : DuskColors.lineSoft, lineWidth: 1)
            )
            .background(
                // Armed ring flare — the webui box-shadow `0 0 0 4px accent-50`.
                RoundedRectangle(cornerRadius: MicCornerLayout.cornerRadius + 2)
                    .fill(DuskColors.accent50)
                    .padding(-MicCornerLayout.armedRingWidth)
                    .opacity(armed ? 1 : 0)
            )
            .shadow(
                color: live ? DuskColors.accent.opacity(0.3) : Color.black.opacity(0.28),
                radius: live ? 10 : 6,
                y: 2
            )
            .scaleEffect(scale)
            .animation(MicCornerMotion.fade, value: live)
            .animation(MicCornerMotion.fade, value: locked)
            .animation(.easeOut(duration: 0.15), value: armed)
    }
}

/// The drag trail — an accent→clear gradient bar anchored under the button's
/// resting spot, growing leftward with drag progress (webui __trail).
struct MicCornerTrail: View {
    /// 0…1 drag progress along the travel.
    let progress: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: MicCornerLayout.trailHeight / 2)
            .fill(
                LinearGradient(colors: [.clear, DuskColors.accent], startPoint: .leading, endPoint: .trailing)
            )
            .frame(width: max(0, progress * MicCornerLayout.travel), height: MicCornerLayout.trailHeight)
            .opacity(progress * 0.9)
    }
}

/// The lock detent — a dot at the far (lock) end that lights accent and
/// scales up once the drag is armed; hidden while locked (webui __detent).
struct MicCornerDetent: View {
    let visible: Bool
    let armed: Bool

    var body: some View {
        Circle()
            .fill(armed ? DuskColors.accent : DuskColors.ink.opacity(0.22))
            .frame(width: MicCornerLayout.detentSize, height: MicCornerLayout.detentSize)
            .scaleEffect(armed ? MicCornerLayout.detentArmedScale : 1)
            .opacity(visible ? 1 : 0)
            .animation(.spring(response: 0.25, dampingFraction: 0.6), value: armed)
            .animation(.easeOut(duration: 0.2), value: visible)
    }
}

/// One press ripple — a ring that expands + fades on hold entry. Re-created
/// per press (via `.id`) so `onAppear` replays the animation.
struct MicCornerRipple: View {
    @State private var expanded = false

    var body: some View {
        RoundedRectangle(cornerRadius: MicCornerLayout.cornerRadius + 3)
            .strokeBorder(DuskColors.accent.opacity(0.7), lineWidth: 2)
            .padding(-2)
            .scaleEffect(expanded ? 1.7 : 0.9)
            .opacity(expanded ? 0 : 0.9)
            .allowsHitTesting(false)
            .onAppear {
                withAnimation(.easeOut(duration: MicCornerMotion.rippleDuration)) { expanded = true }
            }
    }
}

// ── Previews ──────────────────────────────────────────────────────────────

#Preview("Body states — idle / live / armed / locked") {
    HStack(spacing: Space.xl) {
        MicCornerBody(live: false, locked: false, armed: false, scale: 1)
            .frame(width: MicCornerLayout.buttonSize, height: MicCornerLayout.buttonSize)
        MicCornerBody(live: true, locked: false, armed: false, scale: 1)
            .frame(width: MicCornerLayout.buttonSize, height: MicCornerLayout.buttonSize)
        MicCornerBody(live: true, locked: false, armed: true, scale: 1)
            .frame(width: MicCornerLayout.buttonSize, height: MicCornerLayout.buttonSize)
        MicCornerBody(live: true, locked: true, armed: true, scale: 1)
            .frame(width: MicCornerLayout.buttonSize, height: MicCornerLayout.buttonSize)
    }
    .padding(Space.xxl)
    .background(DuskColors.bg)
}

#Preview("Trail + detent — half progress") {
    ZStack {
        MicCornerTrail(progress: 0.5)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.trailing, MicCornerLayout.buttonSize / 2)
        MicCornerDetent(visible: true, armed: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, MicCornerLayout.detentInset)
    }
    .frame(width: MicCornerLayout.wrapWidth, height: MicCornerLayout.buttonSize)
    .padding(Space.xxl)
    .background(DuskColors.bg)
}
