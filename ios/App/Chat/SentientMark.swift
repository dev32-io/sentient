// ---------------------------------------------------------------------------
// SentientMark — the Sentient avatar/logo mark, drawn with SwiftUI Canvas.
//
// This is the D-I3 (text-phase) form, mirroring the Android SentientMark
// (android/.../chat/SentientMark.kt) and the webui SVG mark's idle geometry
// (gateway/webui/src/components/common/sentient-mark.tsx): a static halo +
// nucleus + outer rim ring + three rotated orbital ellipses. The webui's
// listening/thinking/speaking electron-orbit animations are Phase-3 (E5); here
// the mark is static — the surrounding chat (pulse dots, streaming text) is
// what conveys cognition, exactly as the webui idle mark does.
//
// Geometry is transcribed from the webui viewBox 0 0 64 64 (same constants the
// Android Canvas uses): nucleus r=6 at centre, rim ring r=30, three orbits
// rx=23 ry=9 at rotations 18/-28/78°. The 64-unit space scales to `size`.
// ---------------------------------------------------------------------------
import SwiftUI

/// Renders the Sentient mark. `size` sets the diameter; the 64-unit webui
/// geometry scales to fit. Static (idle) for D-I3 — no animation.
struct SentientMark: View {
    /// Diameter in points. Default matches the assistant-bubble avatar size.
    var size: CGFloat = SentientMarkLayout.defaultSize

    var body: some View {
        Canvas { context, canvasSize in
            let scale = min(canvasSize.width, canvasSize.height) / SentientMarkLayout.view
            let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
            drawHalo(in: context, center: center, scale: scale)
            drawRing(in: context, center: center, scale: scale)
            drawOrbits(in: context, center: center, scale: scale)
            drawNucleus(in: context, center: center, scale: scale)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// Soft ember glow behind the nucleus.
    private func drawHalo(in context: GraphicsContext, center: CGPoint, scale: CGFloat) {
        let r = SentientMarkLayout.haloR * scale
        let rect = CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)
        let gradient = Gradient(stops: [
            .init(color: SentientMarkColors.ember.opacity(0.45), location: 0),
            .init(color: SentientMarkColors.ember.opacity(0), location: 1),
        ])
        context.fill(
            Path(ellipseIn: rect),
            with: .radialGradient(gradient, center: center, startRadius: 0, endRadius: r)
        )
    }

    /// Faint outer rim ring.
    private func drawRing(in context: GraphicsContext, center: CGPoint, scale: CGFloat) {
        let r = SentientMarkLayout.ringR * scale
        let rect = CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)
        context.stroke(
            Path(ellipseIn: rect),
            with: .color(SentientMarkColors.rim.opacity(0.4)),
            lineWidth: 1.2 * scale
        )
    }

    /// The three rotated orbital ellipses.
    private func drawOrbits(in context: GraphicsContext, center: CGPoint, scale: CGFloat) {
        let rx = SentientMarkLayout.orbitRx * scale
        let ry = SentientMarkLayout.orbitRy * scale
        let rect = CGRect(x: center.x - rx, y: center.y - ry, width: rx * 2, height: ry * 2)
        let ellipse = Path(ellipseIn: rect)
        for rotation in SentientMarkLayout.orbitRotations {
            var rotated = context
            rotated.translateBy(x: center.x, y: center.y)
            rotated.rotate(by: .degrees(rotation))
            rotated.translateBy(x: -center.x, y: -center.y)
            rotated.stroke(
                ellipse,
                with: .color(SentientMarkColors.rim.opacity(0.5)),
                lineWidth: 0.85 * scale
            )
        }
    }

    /// Glowing terra nucleus at the centre.
    private func drawNucleus(in context: GraphicsContext, center: CGPoint, scale: CGFloat) {
        let r = SentientMarkLayout.nucleusR * scale
        let rect = CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)
        let lightCenter = CGPoint(x: center.x - r * 0.2, y: center.y - r * 0.25)
        let gradient = Gradient(colors: [
            SentientMarkColors.hi,
            SentientMarkColors.ember,
            SentientMarkColors.terra,
        ])
        context.fill(
            Path(ellipseIn: rect),
            with: .radialGradient(gradient, center: lightCenter, startRadius: 0, endRadius: r * 1.3)
        )
    }
}

/// Geometry constants in the webui 64-unit viewBox space (mirrors Android).
private enum SentientMarkLayout {
    static let defaultSize: CGFloat = 28
    static let view: CGFloat = 64
    static let nucleusR: CGFloat = 6
    static let haloR: CGFloat = 14
    static let ringR: CGFloat = 30
    static let orbitRx: CGFloat = 23
    static let orbitRy: CGFloat = 9
    static let orbitRotations: [Double] = [18, -28, 78]
}

/// Mark palette: terra accent from the SDK token; ember/hi/rim are the webui
/// mark gradient stops (not in the Dusk token set, so kept local — mirrors the
/// Android MARK_* constants).
private enum SentientMarkColors {
    static let terra = DuskColors.accent
    static let ember = Color(.sRGB, red: 1.0, green: 0.722, blue: 0.478, opacity: 1) // 0xFFFFB87A
    static let hi = Color(.sRGB, red: 1.0, green: 0.882, blue: 0.741, opacity: 1)    // 0xFFFFE1BD
    static let rim = Color(.sRGB, red: 1.0, green: 0.953, blue: 0.859, opacity: 1)   // 0xFFFFF3DB
}

#Preview {
    SentientMark(size: 64)
        .padding()
        .background(DuskColors.bg)
}
