// ---------------------------------------------------------------------------
// ComposerButtons — the composer's icon-button primitives (toggle + action) and
// the shared layout constants. Extracted from Composer.swift to keep that file
// under the clean-code size limit; module-internal, used only by Composer.
// ---------------------------------------------------------------------------
import SwiftUI

/// A composer on/off toggle (mic, TTS) — a rounded-square icon button. Off:
/// slashed glyph in ink-3 on the sunk surface with a line border. On: the glyph
/// + border in accent over an accent-tinted fill. Mirrors the webui
/// icon-btn--mic-on/off + tts-on/off variants.
struct ComposerToggle: View {
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
struct ComposerAction: View {
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

enum ComposerLayout {
    static let radius: CGFloat = 24
    static let buttonSize: CGFloat = 38
    static let glyph: CGFloat = 18
    /// Accent-tint fill / border opacities for the "on" state (≈ webui
    /// color-mix(accent 14% / 35%)).
    static let onTint: CGFloat = 0.14
    static let onBorder: CGFloat = 0.4
    /// Inner stop-square dimensions for the restyled interrupt button (webui .m-stop).
    static let stopIconSize: CGFloat = 11
    static let stopGlyphRadius: CGFloat = 2
    /// Minimum downward drag distance (pt) before the keyboard is dismissed.
    static let dismissDragThreshold: CGFloat = 24
    /// Soft amber outer glow radius (pt) — mirrors the webui composer halo.
    static let glowRadius: CGFloat = 22
    /// Resting amber glow opacity.
    static let glowOpacity: Double = 0.28
    /// Amber glow opacity while the mic is active (listening state).
    static let glowListeningOpacity: Double = 0.45

    // ── Task-strip pill width ────────────────────────────────────────────
    //
    // Mirrors webui's `clamp(112px, 42cqw, 200px)` (components.css
    // `.tool-pill`) and Android's `taskPillMinWidth` (ComposerTaskStripLayout
    // .kt) exactly — keep all three in lockstep, or the same turn looks
    // inconsistent depending on which client renders it.

    /// Task pill min-width floor (pt) — the readable floor on a narrow screen.
    static let taskPillMinWidthFloor: CGFloat = 112
    /// Task pill min-width ceiling (pt) — also its hard max-width; a name
    /// longer than this truncates (existing `.lineLimit(1)` truncation).
    static let taskPillMaxWidth: CGFloat = 200
    /// Fraction of the strip's own width a pill's floor scales with — puts
    /// roughly 2.4 pills in view at any width in the unclamped middle band
    /// (stripWidth ~267–476pt); outside that band the floor/ceiling
    /// deliberately trade pill-count consistency for a readable width.
    static let taskPillWidthStripFraction: CGFloat = 0.42

    /// Derives a task pill's minimum width (pt) from the strip's OWN width,
    /// so the same rough number of pills is visible regardless of screen
    /// size or how many tasks exist.
    static func taskPillMinWidth(stripWidth: CGFloat) -> CGFloat {
        min(max(stripWidth * taskPillWidthStripFraction, taskPillMinWidthFloor), taskPillMaxWidth)
    }
}
