// ---------------------------------------------------------------------------
// SentientMark — the Sentient avatar/logo mark, drawn with SwiftUI Canvas.
//
// Geometry mirrors the webui SVG mark (gateway/webui/src/components/common/
// sentient-mark.tsx) and the Android SentientMark.kt: a halo + nucleus + outer
// rim ring + three rotated orbital ellipses, in the viewBox 0 0 64 64 (nucleus
// r=6, ring r=30, orbits rx=23 ry=9 at rotations 18/-28/78°). The 64-unit space
// scales to `size`.
//
// E5 adds the animated voice states (listening / thinking / speaking), porting
// the webui mark animations via `MarkMode`. The mode is derived from the single
// SDK surface upstream (markMode(of:)). CRITICAL (event-driven-UX rule): each
// mode's animation runs ONLY in that mode. `.idle` renders a PLAIN static Canvas
// with NO TimelineView — there is no clock ticking at rest. Non-idle modes wrap
// the Canvas in `TimelineView(.animation)`, which exists (and ticks) only while
// that SDK-derived mode holds and tears down the instant it leaves. "constant by
// default is a bug."
// ---------------------------------------------------------------------------
import SwiftUI

/// Renders the Sentient mark. `size` sets the diameter; the 64-unit webui
/// geometry scales to fit. `mode` selects the animation (default `.idle` =
/// static, no TimelineView).
struct SentientMark: View {
    /// Diameter in points. Default matches the assistant-bubble avatar size.
    var size: CGFloat = SentientMarkLayout.defaultSize
    /// Animation mode. `.idle` ⇒ no TimelineView, no ticking — dead static.
    var mode: MarkMode = .idle

    var body: some View {
        Group {
            if mode == .idle {
                // No TimelineView at rest: the mark is drawn once and never
                // re-ticks — satisfies the event-driven-UX rule.
                markCanvas(anim: MarkAnim())
            } else {
                TimelineView(.animation) { timeline in
                    let t = timeline.date.timeIntervalSinceReferenceDate
                    markCanvas(anim: markAnim(mode: mode, time: t))
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func markCanvas(anim: MarkAnim) -> some View {
        Canvas { context, canvasSize in
            let scale = min(canvasSize.width, canvasSize.height) / SentientMarkLayout.view
            let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
            drawHalo(in: context, center: center, scale: scale, anim: anim)
            drawRing(in: context, center: center, scale: scale, anim: anim)
            drawOrbits(in: context, center: center, scale: scale, anim: anim)
            drawNucleus(in: context, center: center, scale: scale, anim: anim)
        }
    }

    /// Soft ember glow behind the nucleus (breathes in listening/running modes).
    private func drawHalo(in context: GraphicsContext, center: CGPoint, scale: CGFloat, anim: MarkAnim) {
        let r = SentientMarkLayout.haloR * scale * anim.haloScale
        let rect = CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)
        let gradient = Gradient(stops: [
            .init(color: SentientMarkColors.ember.opacity(anim.haloAlpha), location: 0),
            .init(color: SentientMarkColors.ember.opacity(0), location: 1),
        ])
        context.fill(
            Path(ellipseIn: rect),
            with: .radialGradient(gradient, center: center, startRadius: 0, endRadius: r)
        )
    }

    /// Faint outer rim ring (brightens in listening mode).
    private func drawRing(in context: GraphicsContext, center: CGPoint, scale: CGFloat, anim: MarkAnim) {
        let r = SentientMarkLayout.ringR * scale
        let rect = CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)
        context.stroke(
            Path(ellipseIn: rect),
            with: .color(SentientMarkColors.rim.opacity(anim.ringAlpha)),
            lineWidth: 1.2 * scale
        )
    }

    /// The three rotated orbital ellipses, plus electrons that spin in listening mode.
    private func drawOrbits(in context: GraphicsContext, center: CGPoint, scale: CGFloat, anim: MarkAnim) {
        let rx = SentientMarkLayout.orbitRx * scale
        let ry = SentientMarkLayout.orbitRy * scale
        let rect = CGRect(x: center.x - rx, y: center.y - ry, width: rx * 2, height: ry * 2)
        let ellipse = Path(ellipseIn: rect)
        for (i, rotation) in SentientMarkLayout.orbitRotations.enumerated() {
            var rotated = context
            rotated.translateBy(x: center.x, y: center.y)
            rotated.rotate(by: .degrees(rotation))
            rotated.translateBy(x: -center.x, y: -center.y)
            rotated.stroke(
                ellipse,
                with: .color(SentientMarkColors.rim.opacity(0.5)),
                lineWidth: 0.85 * scale
            )
            drawElectron(in: rotated, center: center, rx: rx, ry: ry, index: i, scale: scale, anim: anim)
        }
    }

    /// One electron dot riding its orbit; drawn only when the mark is animating
    /// (listening) — at rest the orbits are bare, matching the static idle mark.
    private func drawElectron(
        in context: GraphicsContext,
        center: CGPoint,
        rx: CGFloat,
        ry: CGFloat,
        index: Int,
        scale: CGFloat,
        anim: MarkAnim
    ) {
        let spin = anim.orbitSpin.indices.contains(index) ? anim.orbitSpin[index] : 0
        if spin == 0, anim.ringAlpha <= 0.4 { return }
        let theta = (SentientMarkLayout.electronPhase[index] + spin / 360) * 2 * .pi
        let pos = CGPoint(x: center.x + rx * cos(theta), y: center.y + ry * sin(theta))
        let er = SentientMarkLayout.electronR * scale
        let rect = CGRect(x: pos.x - er, y: pos.y - er, width: er * 2, height: er * 2)
        let gradient = Gradient(colors: [SentientMarkColors.rim, SentientMarkColors.hi])
        context.fill(
            Path(ellipseIn: rect),
            with: .radialGradient(gradient, center: pos, startRadius: 0, endRadius: er * 2)
        )
    }

    /// Glowing terra nucleus at the centre (pulses in listening/running modes).
    private func drawNucleus(in context: GraphicsContext, center: CGPoint, scale: CGFloat, anim: MarkAnim) {
        let r = SentientMarkLayout.nucleusR * scale * anim.nucleusScale
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
    static let electronR: CGFloat = 1.4
    static let orbitRotations: [Double] = [18, -28, 78]
    /// Electron phase offsets (0..1) along each orbit, from the webui ORBITS table.
    static let electronPhase: [Double] = [0.18, 0.62, 0.4]
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
    VStack(spacing: 16) {
        SentientMark(size: 64, mode: .idle)
        SentientMark(size: 64, mode: .listening)
        SentientMark(size: 64, mode: .thinking)
        SentientMark(size: 64, mode: .speaking)
    }
    .padding()
    .background(DuskColors.bg)
}
