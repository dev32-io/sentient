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
}
