// ---------------------------------------------------------------------------
// HistorySessionsError — the two sessions-load-failure affordances for the
// History panel, mirroring the webui sessions drawer (drawer.tsx):
//
//   - Empty-list failure  → SessionsErrorEmpty: a centered "Couldn't load —
//     Retry" message + Retry button, shown WHERE the list would be when the
//     fetch failed and no rows are loaded.
//   - Stale failure       → SessionsStaleBanner: a thin "Sync failed — list may
//     be stale." banner + Retry, shown ABOVE the still-rendered (stale) rows.
//
// Both are stateless leaves: the host (HistorySidePanel) decides which to show
// from HistoryModel.error + whether rows exist, and passes `onRetry`. State
// hoisting per the swiftui rule; no ViewModel reference.
//
// accessibilityIdentifiers: sessions-error-retry (empty), sessions-stale-retry
// (stale banner).
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
            Button(action: onRetry) {
                Text(Self.retryCta)
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.bg)
                    .padding(.horizontal, Space.md)
                    .padding(.vertical, Space.xs)
                    .background(DuskColors.ink, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("sessions-error-retry")
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.xxl)
        .padding(.horizontal, Space.lg)
        .accessibilityElement(children: .contain)
    }
}

/// Thin banner shown above the (stale) rows when a re-fetch failed but rows are
/// already loaded. Mirrors drawer.tsx's `showStaleErrorBanner`.
struct SessionsStaleBanner: View {
    let onRetry: () -> Void

    private static let message = "Sync failed — list may be stale."
    private static let retryCta = "Retry"

    var body: some View {
        HStack(spacing: Space.sm) {
            Text(Self.message)
                .font(Typo.ui(TypeScale.xs, .medium))
                .foregroundStyle(DuskColors.ink2)
            Spacer(minLength: Space.sm)
            Button(action: onRetry) {
                Text(Self.retryCta)
                    .font(Typo.ui(TypeScale.xs, .semibold))
                    .foregroundStyle(DuskColors.ink)
                    .padding(.horizontal, Space.sm)
                    .padding(.vertical, Space.xs)
                    .overlay(Capsule().stroke(DuskColors.line, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("sessions-stale-retry")
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: Radii.md).fill(DuskColors.bgElev)
                RoundedRectangle(cornerRadius: Radii.md)
                    .fill(DuskColors.warn.opacity(StaleStyle.warnTint))
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: Radii.md).stroke(DuskColors.lineSoft, lineWidth: 1)
        )
        .padding(.horizontal, Space.md)
        .padding(.bottom, Space.xs)
        .accessibilityElement(children: .contain)
    }
}

private enum StaleStyle {
    static let warnTint: Double = 0.14
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
            .padding(.top, Space.lg)
    }
    .preferredColorScheme(.dark)
}
