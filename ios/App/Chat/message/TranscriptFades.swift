import SwiftUI

/// Drawable bounds remain unchanged. Only readable insets and viewport-sized
/// paint use these measured floating footprints. Reserved notices sit outside.
struct TranscriptOverlayGeometry: Equatable {
    static let spill: CGFloat = 24
    let topClearance: CGFloat
    let bottomClearance: CGFloat
    let topBand: CGRect
    let bottomBand: CGRect
    private let bottomEdge: CGFloat

    // Fixed exposed ramp; never become a full-width opaque footer. The composer
    // itself supplies its opaque face, while corners/gutters retain underlay.
    func bottomOpacity(at y: CGFloat) -> Double {
        0.65 * Double(min(1, max(0, (y - bottomEdge + Self.spill) / Self.spill)))
    }

    var bottomStops: [Gradient.Stop] {
        var stops = [Gradient.Stop(color: DuskColors.bg.opacity(bottomOpacity(at: bottomBand.minY)), location: 0)]
        if bottomEdge > bottomBand.minY, bottomEdge < bottomBand.maxY {
            stops.append(.init(color: DuskColors.bg.opacity(0.65),
                               location: (bottomEdge - bottomBand.minY) / bottomBand.height))
        }
        stops.append(.init(color: DuskColors.bg.opacity(bottomOpacity(at: bottomBand.maxY)), location: 1))
        return stops
    }

    init(viewport: CGRect, header: CGRect, composer: CGRect?) {
        let top = header.intersects(viewport)
            ? min(viewport.height, max(0, header.maxY - viewport.minY) + Self.spill) : 0
        topClearance = top
        topBand = CGRect(x: 0, y: 0, width: viewport.width, height: top)
        if let composer, composer.intersects(viewport) {
            bottomEdge = composer.minY - viewport.minY
            let start = max(viewport.minY, composer.minY - Self.spill)
            let end = min(viewport.maxY, composer.maxY)
            bottomBand = CGRect(x: 0, y: start - viewport.minY,
                                width: viewport.width, height: max(0, end - start))
            // Dock is bottom-aligned in safe/keyboard-aware SwiftUI geometry.
            // Native collection adds automatic/keyboard clearance exactly once;
            // do not pass viewport.maxY - composer.minY (which includes keyboard).
            bottomClearance = min(viewport.height, composer.height + Self.spill)
        } else {
            bottomEdge = 0
            bottomBand = .zero
            bottomClearance = 0
        }
    }
}

struct TranscriptFades: View {
    let geometry: TranscriptOverlayGeometry

    var body: some View {
        ZStack(alignment: .topLeading) {
            LinearGradient(colors: [DuskColors.bg, .clear], startPoint: .top, endPoint: .bottom)
                .frame(width: geometry.topBand.width, height: geometry.topBand.height)
            LinearGradient(stops: geometry.bottomStops, startPoint: .top, endPoint: .bottom)
                .frame(width: geometry.bottomBand.width, height: geometry.bottomBand.height)
                .offset(y: geometry.bottomBand.minY)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
