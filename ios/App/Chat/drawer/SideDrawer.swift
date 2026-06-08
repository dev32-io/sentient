// ---------------------------------------------------------------------------
// SideDrawer — pure-SwiftUI left-edge interactive drawer.
//
// Renders content + a dimming scrim + the drawer panel in a single ZStack. The
// drawer's horizontal offset is SwiftUI @State, so it can NEVER be clobbered by a
// UIKit layout pass (the old UIViewController reset its leading constraint on
// every viewDidLayoutSubviews → open-drag jumped + close-drag never worked).
//
// Gestures come from DrawerPanGesture (an iOS-18 UIGestureRecognizerRepresentable):
//  - content() carries the .edgeOpen pan (OPEN), armed only when the touch begins
//    within the left-edge zone, so it never swallows taps on the chat column.
//  - the drawer + dim carry the .closeDrag pan (CLOSE). Both delegates gate on
//    horizontal dominance so the panel's inner ScrollView keeps scrolling.
//
// `isOpen` is the SwiftUI source of truth, kept in sync both ways:
//  - programmatic open/close (title-bar button) flows in via .onChange(of:).
//  - a drag/tap settle writes back to `isOpen` and (on open) fires `onOpen`.
//
// Same public API as the previous UIViewControllerRepresentable so ChatView is
// unchanged. HistorySidePanel content is untouched.
// ---------------------------------------------------------------------------
import SwiftUI

/// Layout / motion constants for the drawer. No magic numbers in the body.
private enum DrawerMetrics {
    /// Drawer width: 86 % of screen, capped so it never spans a wide device.
    static let widthFraction: CGFloat = 0.86
    static let maxWidth: CGFloat = 320
    /// Scrim opacity at fully-open.
    static let dimMaxAlpha: Double = 0.5
    /// Past this open-fraction (0…1) at gesture end, a no-velocity drag snaps open.
    static let snapThreshold: CGFloat = 0.5
    /// Horizontal velocity (pt/s) that forces a directional snap regardless of position.
    static let velocitySnap: CGFloat = 350

    static func width(for screenWidth: CGFloat) -> CGFloat {
        min(maxWidth, screenWidth * widthFraction)
    }
}

struct SideDrawer<Content: View, Drawer: View>: View {
    @Binding var isOpen: Bool
    let onOpen: () -> Void
    @ViewBuilder let content: () -> Content
    @ViewBuilder let drawer: () -> Drawer

    init(
        isOpen: Binding<Bool>,
        onOpen: @escaping () -> Void,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder drawer: @escaping () -> Drawer
    ) {
        self._isOpen = isOpen
        self.onOpen = onOpen
        self.content = content
        self.drawer = drawer
    }

    /// 0 = closed, 1 = open. The settled position; `dragX` is the live finger delta.
    @State private var openFraction: CGFloat = 0
    /// Live horizontal translation during a drag (pt). 0 when no drag is active.
    @State private var dragX: CGFloat = 0

    private let log = AppLog("chat", "drawer")

    var body: some View {
        GeometryReader { geo in
            // Full bounds INCLUDING the safe area — the drawer panel + scrim must
            // cover the status bar / home indicator. `content()` keeps its normal
            // safe-area insets (it owns the title bar + composer), so we read the
            // full screen width for the drawer geometry from `geo.size` + insets.
            let screenWidth = geo.size.width + geo.safeAreaInsets.leading + geo.safeAreaInsets.trailing
            let drawerWidth = DrawerMetrics.width(for: screenWidth)
            let fraction = currentFraction(drawerWidth: drawerWidth)
            let drawerX = -drawerWidth + fraction * drawerWidth

            ZStack(alignment: .topLeading) {
                // Chat column — respects safe area (title bar sits BELOW the
                // status bar). The edge-open pan only arms when a drag begins in
                // the left-edge zone, so it never swallows taps on the column.
                content()
                    .frame(width: geo.size.width, height: geo.size.height)
                    .gesture(edgeOpenDrag(drawerWidth: drawerWidth))

                dimScrim(fraction: fraction, drawerWidth: drawerWidth)

                drawer()
                    .frame(width: drawerWidth)
                    .frame(maxHeight: .infinity)
                    .offset(x: drawerX)
                    .gesture(closeDrag(drawerWidth: drawerWidth))
                    .ignoresSafeArea()
            }
        }
        // Keep SwiftUI's source of truth (`isOpen`) and the visual fraction in
        // sync for PROGRAMMATIC open/close (e.g. the title-bar button).
        .onChange(of: isOpen) { _, nowOpen in
            let target: CGFloat = nowOpen ? 1 : 0
            guard openFraction != target else { return }
            log.info("programmatic isOpen=\(nowOpen)")
            dragX = 0
            animateSettle(open: nowOpen)
        }
    }

    // ── Offset mapping ────────────────────────────────────────────────────────

    /// Clamped 0…1 position including the live drag delta.
    private func currentFraction(drawerWidth: CGFloat) -> CGFloat {
        guard drawerWidth > 0 else { return openFraction }
        return min(1, max(0, openFraction + dragX / drawerWidth))
    }

    // ── Dim scrim ─────────────────────────────────────────────────────────────

    private func dimScrim(fraction: CGFloat, drawerWidth: CGFloat) -> some View {
        Color.black
            .opacity(Double(fraction) * DrawerMetrics.dimMaxAlpha)
            .ignoresSafeArea()
            .allowsHitTesting(fraction > 0)
            .onTapGesture { close() }
            .gesture(closeDrag(drawerWidth: drawerWidth))
            .accessibilityHidden(true)
    }

    // ── Gestures ──────────────────────────────────────────────────────────────

    private func edgeOpenDrag(drawerWidth: CGFloat) -> DrawerPanGesture {
        DrawerPanGesture(
            kind: .edgeOpen,
            onChange: { dragX = max(0, $0) },
            onEnd: { snap(translationX: $0, velocityX: $1, drawerWidth: drawerWidth) }
        )
    }

    private func closeDrag(drawerWidth: CGFloat) -> DrawerPanGesture {
        DrawerPanGesture(
            kind: .closeDrag,
            onChange: { dragX = $0 },
            onEnd: { snap(translationX: $0, velocityX: $1, drawerWidth: drawerWidth) }
        )
    }

    // ── Snap / settle ─────────────────────────────────────────────────────────

    /// Snap open or closed from final position + fling velocity, then reconcile
    /// the binding. Velocity wins past the fling threshold; otherwise position.
    private func snap(translationX: CGFloat, velocityX: CGFloat, drawerWidth: CGFloat) {
        let fraction = currentFraction(drawerWidth: drawerWidth)
        let shouldOpen: Bool
        if abs(velocityX) > DrawerMetrics.velocitySnap {
            shouldOpen = velocityX > 0
        } else {
            shouldOpen = fraction > DrawerMetrics.snapThreshold
        }
        log.info("snap dx=\(Int(translationX)) vx=\(Int(velocityX)) frac=\(String(format: "%.2f", fraction)) → open=\(shouldOpen)")
        dragX = 0
        animateSettle(open: shouldOpen)
        reconcileBinding(open: shouldOpen)
    }

    /// Drive the binding to a close via tap on the scrim.
    private func close() {
        log.info("scrim tap close")
        dragX = 0
        animateSettle(open: false)
        reconcileBinding(open: false)
    }

    /// Animate to the settled position. The fetch (via `onOpen`) is deferred to
    /// the animation's COMPLETION so the history list never lays out while the
    /// panel is still sliding — that mid-slide layout was the left-to-right paint
    /// churn on a fast first open. Closing has nothing to fetch.
    private func animateSettle(open: Bool) {
        withAnimation(.snappy) {
            openFraction = open ? 1 : 0
        } completion: {
            if open { onOpen() }
        }
    }

    /// Reconcile `isOpen` with the settled visual state (state only — the fetch is
    /// owned by `animateSettle`'s completion). Set BEFORE the binding so the
    /// programmatic `onChange` path sees `openFraction` already at target and
    /// no-ops instead of re-animating.
    private func reconcileBinding(open: Bool) {
        if open {
            if !isOpen { isOpen = true }
        } else {
            if isOpen { isOpen = false }
        }
    }
}
