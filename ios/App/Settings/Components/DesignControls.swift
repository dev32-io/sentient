import SwiftUI
import UIKit

/// Shared semantic state for controls. The visual primitive owns how a state is
/// drawn; the state also supplies the VoiceOver value so disabled, loading,
/// error, selected, and on states cannot drift between controls.
enum DesignControlState: Equatable {
    case normal
    case loading
    case error(String)
    case selected
    case on
    case disabled

    var isInteractive: Bool {
        switch self {
        case .normal, .selected, .on: true
        case .loading, .error, .disabled: false
        }
    }

    var accessibilityValue: String {
        switch self {
        case .normal: "Ready"
        case .loading: "In progress"
        case .error(let message): "Error: \(message)"
        case .selected: "Selected"
        case .on: "On"
        case .disabled: "Disabled"
        }
    }

    var isSelected: Bool {
        switch self {
        case .selected, .on: true
        case .normal, .loading, .error, .disabled: false
        }
    }
}

enum DesignButtonRole { case action, secondary, destructive, quiet }

enum DesignNoticeKind: Equatable { case loading, empty, info, error, success, warning }

/// Draws the slate face as two full-bounds fields. Core Graphics applies the
/// ellipse transform to the radial coordinate field while the face bounds stay
/// fixed, avoiding the rectangular cutoff caused by transforming a SwiftUI
/// gradient view.
private struct SlateFaceRenderer: UIViewRepresentable {
    let linearTop: Color
    let linearBottom: Color
    let radialCenter: Color
    let radialRing: Color
    let muted: Bool

    func makeUIView(context: Context) -> SlateFaceView {
        SlateFaceView()
    }

    func updateUIView(_ view: SlateFaceView, context: Context) {
        view.recipe = SlateFaceView.Recipe(
            linearTop: linearTop,
            linearBottom: linearBottom,
            radialCenter: radialCenter,
            radialRing: muted ? radialCenter : radialRing,
            centerStop: muted ? 0 : DesignMaterialAdapter.slateCenterStop,
            fadeStop: muted ? DesignMaterialAdapter.slateMutedFadeStop : DesignMaterialAdapter.slateFadeStop,
            radiusScale: DesignMaterialAdapter.slateRadialScale,
            center: CGPoint(
                x: DesignMaterialAdapter.slateRadialCenterX,
                y: DesignMaterialAdapter.slateRadialCenterY
            )
        )
        view.setNeedsDisplay()
    }
}

private final class SlateFaceView: UIView {
    struct Recipe {
        let linearTop: Color
        let linearBottom: Color
        let radialCenter: Color
        let radialRing: Color
        let centerStop: CGFloat
        let fadeStop: CGFloat
        let radiusScale: CGSize
        let center: CGPoint
    }

    var recipe = Recipe(
        linearTop: .clear,
        linearBottom: .clear,
        radialCenter: .clear,
        radialRing: .clear,
        centerStop: 0,
        fadeStop: 1,
        radiusScale: CGSize(width: 1, height: 1),
        center: CGPoint(x: 0.5, y: 0.5)
    )

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        accessibilityElementsHidden = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ rect: CGRect) {
        let faceBounds = bounds
        guard let context = UIGraphicsGetCurrentContext(), faceBounds.width > 0, faceBounds.height > 0,
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
        else { return }

        context.saveGState()
        context.clip(to: faceBounds)

        let linearColors = [UIColor(recipe.linearTop).cgColor, UIColor(recipe.linearBottom).cgColor]
        if let linearGradient = CGGradient(
            colorsSpace: colorSpace,
            colors: linearColors as CFArray,
            locations: [0, 1]
        ) {
            context.drawLinearGradient(
                linearGradient,
                start: CGPoint(x: faceBounds.midX, y: faceBounds.minY),
                end: CGPoint(x: faceBounds.midX, y: faceBounds.maxY),
                options: []
            )
        }

        let radialColors = [
            UIColor(recipe.radialCenter).cgColor,
            UIColor(recipe.radialRing).cgColor,
            UIColor(recipe.radialRing).withAlphaComponent(0).cgColor,
        ]
        guard let radialGradient = CGGradient(
            colorsSpace: colorSpace,
            colors: radialColors as CFArray,
            locations: [0, recipe.centerStop, recipe.fadeStop]
        ) else {
            context.restoreGState()
            return
        }

        let center = CGPoint(
            x: faceBounds.width * recipe.center.x,
            y: faceBounds.height * recipe.center.y
        )
        // CSS's 82%/105% values are radii of the face field. Transforming the
        // context changes only the radial coordinates; the clip remains the
        // complete face rectangle, so transparency fades into the foundation.
        let radius = CGSize(
            width: faceBounds.width * recipe.radiusScale.width,
            height: faceBounds.height * recipe.radiusScale.height
        )
        guard radius.width > 0, radius.height > 0 else {
            context.restoreGState()
            return
        }

        context.saveGState()
        context.translateBy(x: center.x, y: center.y)
        context.scaleBy(x: radius.width, y: radius.height)
        context.drawRadialGradient(
            radialGradient,
            startCenter: .zero,
            startRadius: 0,
            endCenter: .zero,
            endRadius: 1,
            options: []
        )
        context.restoreGState()
        context.restoreGState()
    }
}

private struct SlateFace: View {
    let role: DesignButtonRole
    let muted: Bool
    let hovered: Bool
    var baseOverride: Color? = nil

    private var base: Color {
        if muted {
            return DuskColors.bgElev.overlaying(
                DuskColors.ink4,
                opacity: DesignMaterialAdapter.slateDisabledBaseInkMix
            )
        }
        if let baseOverride { return baseOverride }
        switch role {
        case .action: return DuskColors.accent
        case .secondary:
            return DuskColors.paper.overlaying(
                DuskColors.ink2,
                opacity: DesignMaterialAdapter.slateSecondaryInkMix
            )
        case .destructive:
            return DuskColors.paper.overlaying(
                DuskColors.stop,
                opacity: DesignMaterialAdapter.slateDestructiveOverlay
            )
        case .quiet: return DuskColors.bgElev
        }
    }

    private var glow: Color { role == .destructive ? DuskColors.stop : DuskColors.accent }

    private var radialCenterColor: Color {
        base.overlaying(
            DuskColors.bgSunk,
            opacity: muted
                ? DesignMaterialAdapter.slateMutedCenterSunk
                : hovered ? DesignMaterialAdapter.slateHoverCenterSunk : DesignMaterialAdapter.slateCenterSunk
        )
    }

    private var radialRingColor: Color {
        base.overlaying(
            DuskColors.bgSunk,
            opacity: hovered ? DesignMaterialAdapter.slateHoverRingSunk : DesignMaterialAdapter.slateRingSunk
        )
    }

    private var linearTop: Color {
        if muted { return base.overlaying(DuskColors.ink4, opacity: DesignMaterialAdapter.slateMutedBaseLight) }
        return base.overlaying(
            DuskColors.ink,
            opacity: hovered ? DesignMaterialAdapter.slateHoverBaseLight : DesignMaterialAdapter.slateBaseLight
        )
    }

    private var linearBottom: Color {
        muted ? base : hovered ? base.overlaying(glow, opacity: DesignMaterialAdapter.slateHoverGlow) : base
    }

    var body: some View {
        SlateFaceRenderer(
            linearTop: linearTop,
            linearBottom: linearBottom,
            radialCenter: radialCenterColor,
            radialRing: radialRingColor,
            muted: muted
        )
    }
}


private struct DesignFieldError: View {
    let message: String
    let accessibilityId: String?

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.stop)
            .accessibilityLabel("Error: \(message)")
            .accessibilityIdentifier(accessibilityId ?? "")
    }
}

// Keep the renderer and error view file-private while allowing their focused
// controls to reuse the exact same view values from separate source files.
func designSlateFace(
    role: DesignButtonRole,
    muted: Bool,
    hovered: Bool,
    baseOverride: Color? = nil
) -> some View {
    SlateFace(role: role, muted: muted, hovered: hovered, baseOverride: baseOverride)
}

func designFieldError(message: String, accessibilityId: String?) -> some View {
    DesignFieldError(message: message, accessibilityId: accessibilityId)
}
