import SwiftUI

private struct PlateSurface: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    let elevated: Bool

    func body(content: Content) -> some View {
        let clipShape = RoundedRectangle(cornerRadius: Radii.md, style: .continuous)
        let canvasShape = DesignCanvasShape.continuousRoundedRectangle(cornerRadius: Radii.md)

        content
            .clipShape(clipShape)
            .background {
                DesignCanvasSurfaceKernel(
                    shape: canvasShape,
                    tier: elevated ? .float : .plate,
                    increasedContrast: contrast == .increased
                )
            }
    }
}

private struct WellSurface: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    let focused: Bool
    let error: Bool
    let cornerRadius: CGFloat
    let showsBorder: Bool
    let showsInsetHighlights: Bool

    func body(content: Content) -> some View {
        let clipShape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        let canvasShape = DesignCanvasShape.continuousRoundedRectangle(cornerRadius: cornerRadius)
        let state = DesignCanvasWellState(
            isFocused: focused,
            profile: error ? .validatedError : .standard
        )

        content
            .clipShape(clipShape)
            .background {
                DesignCanvasWellKernel(
                    shape: canvasShape,
                    state: state,
                    increasedContrast: contrast == .increased,
                    reduceMotion: reduceMotion,
                    showsBorder: showsBorder,
                    showsInsetHighlights: showsInsetHighlights
                )
            }
    }
}

extension View {
    func designPlate(elevated: Bool = false) -> some View {
        modifier(PlateSurface(elevated: elevated))
    }

    func designFloat() -> some View {
        modifier(PlateSurface(elevated: true))
    }

    func designWell(
        focused: Bool = false,
        error: Bool = false,
        cornerRadius: CGFloat = Radii.sm,
        showsBorder: Bool = true,
        showsInsetHighlights: Bool = true
    ) -> some View {
        modifier(
            WellSurface(
                focused: focused,
                error: error,
                cornerRadius: cornerRadius,
                showsBorder: showsBorder,
                showsInsetHighlights: showsInsetHighlights
            )
        )
    }
}
