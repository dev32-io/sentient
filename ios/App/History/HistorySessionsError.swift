// ---------------------------------------------------------------------------
// HistorySessionsError — the two sessions-load feedback affordances for the
// History panel, mirroring the webui sessions drawer (drawer.tsx):
//
//   - Empty-list failure  → SessionsErrorEmpty: a centered "Couldn't load —
//     Retry" message + Retry button, shown WHERE the list would be when the
//     fetch failed and no rows are loaded.
//   - Stale rows           → SessionsStaleBanner: "Showing saved results" and
//     refresh detail + Retry/checking, shown ABOVE the still-rendered rows.
//
// Both are stateless leaves: the host (HistorySidePanel) decides which to show
// from HistoryViewModel.error/loading + whether rows exist, and passes `onRetry`.
// State hoisting per the swiftui rule; no ViewModel reference.
//
// accessibilityIdentifiers: sessions-error-retry (empty), sessions-stale-banner
// (stale banner), sessions-stale-retry (stale action).
// ---------------------------------------------------------------------------
import SwiftUI

/// Centered empty-state shown in place of the list when the load failed and no
/// rows are present. Mirrors drawer.tsx's `EMPTY_LOAD_FAIL` + inline Retry.
struct SessionsErrorEmpty: View {
    let onRetry: () -> Void

    private static let message = "Couldn't load past chats."
    private static let retryCta = "Retry"

    var body: some View {
        VStack(spacing: Space.md) {
            Text(Self.message)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
                .multilineTextAlignment(.center)
            DesignActionButton(
                title: Self.retryCta,
                role: .secondary,
                accessibilityId: "sessions-error-retry",
                fillsWidth: false,
                action: onRetry
            )
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.xxl)
        .padding(.horizontal, Space.lg)
        .accessibilityElement(children: .contain)
    }
}

/// Banner shown above saved rows while a refresh is in flight or after that
/// refresh fails. The host derives `checking` from HistoryViewModel.loading;
/// this leaf owns no retry or cached-data state.
struct SessionsStaleBanner: View {
    let onRetry: () -> Void
    var checking = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let title = "Showing saved results"
    private static let detail = "Couldn’t refresh just now."
    private static let retryCta = "Retry"
    private static let checkingCta = "Checking…"

    var body: some View {
        HStack(alignment: .center, spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 0) {
                Text(Self.title)
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .semibold))
                    .foregroundStyle(DuskColors.ink)
                Text(Self.detail)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            DesignActionButton(
                title: checking ? Self.checkingCta : Self.retryCta,
                role: .quiet,
                state: checking ? .disabled : .normal,
                accessibilityId: "sessions-stale-retry",
                fillsWidth: false,
                action: onRetry
            )
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .frame(minHeight: StaleStyle.minimumHeight)
        .background {
            SessionsStaleMaterialCanvas(
                face: staleBackground,
                topBorder: staleTopBorder
            )
        }
        .designPlate()
        .animation(
            DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion),
            value: checking
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sessions-stale-banner")
    }

    private var staleBackground: Color {
        checking
            ? DuskColors.bgElev.overlaying(DuskColors.accent50, opacity: StaleStyle.checkingBackgroundMix)
            : DuskColors.bgElev.overlaying(DuskColors.amber, opacity: StaleStyle.restBackgroundMix)
    }

    private var staleTopBorder: Color {
        checking
            ? DuskColors.lineSoft.overlaying(DuskColors.accent, opacity: StaleStyle.checkingBorderMix)
            : DuskColors.lineSoft.overlaying(DuskColors.amber, opacity: StaleStyle.restBorderMix)
    }
}

/// The stale state has a reviewed, History-specific tint layered inside the
/// shared plate. One Canvas owns that face and directional top rule so the
/// product state does not rebuild the plate from stacked SwiftUI decorations.
private struct SessionsStaleMaterialCanvas: View {
    let face: Color
    let topBorder: Color

    var body: some View {
        Canvas { context, size in
            let rect = CGRect(origin: .zero, size: size)
            let shape = RoundedRectangle(cornerRadius: Radii.md, style: .continuous)
            context.fill(shape.path(in: rect), with: .color(face))
            context.fill(
                Path(CGRect(
                    x: 0,
                    y: DesignMetrics.hairline,
                    width: size.width,
                    height: DesignMetrics.hairline
                )),
                with: .color(topBorder)
            )
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private enum StaleStyle {
    // The source's 58pt banner grows to the action + vertical padding and
    // includes its top border plus the enclosing plate border.
    static let minimumHeight: CGFloat = 63
    static let restBackgroundMix = 0.08
    static let restBorderMix = 0.40
    static let checkingBackgroundMix = 0.24
    static let checkingBorderMix = 0.45
}

#Preview("Sessions error — empty") {
    ZStack {
        DuskColors.bg.ignoresSafeArea()
        SessionsErrorEmpty(onRetry: {})
    }
    .preferredColorScheme(.dark)
}

#Preview("Sessions error — stale banner") {
    ZStack(alignment: .top) {
        DuskColors.bg.ignoresSafeArea()
        SessionsStaleBanner(onRetry: {})
            .padding(.horizontal, Space.lg)
            .padding(.top, Space.lg)
    }
    .preferredColorScheme(.dark)
}

#Preview("Sessions error — stale banner checking") {
    ZStack(alignment: .top) {
        DuskColors.bg.ignoresSafeArea()
        SessionsStaleBanner(onRetry: {}, checking: true)
            .padding(.horizontal, Space.lg)
            .padding(.top, Space.lg)
    }
    .preferredColorScheme(.dark)
}
