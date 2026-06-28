// ---------------------------------------------------------------------------
// UpdateBanner — the non-blocking optional-update affordance. Swift mirror of
// Android's UpdateBanner (update/UpdateBanner.kt).
//
// Shown as a top in-screen overlay (NOT a route) when the update status is
// Available && !mandatory. Stateless leaf: it takes the version label + plain
// callbacks; the host (UpdateGate) owns WHEN to show it (status + dismissed) per
// the swiftui state-hoisting rule.
//
// accessibilityIdentifiers: update-banner (container), update-banner-action
// ([Update]), update-banner-dismiss (✕) — mirror the Android testTags for the
// shared Maestro flows.
// ---------------------------------------------------------------------------
import SwiftUI

private let availablePrefix = "Update available — v"
private let updateLabel = "Update"
private let dismissGlyph = "✕"

/// Optional-update banner. `versionName` is the available release's display
/// version; `onUpdate` hands off to the installer; `onDismiss` hides it (the host
/// tracks dismissal so it stays hidden until the next status change).
struct UpdateBanner: View {
    let versionName: String
    let onUpdate: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: Space.sm) {
            Text("\(availablePrefix)\(versionName)")
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink)
                .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: onUpdate) {
                Text(updateLabel)
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.bg)
                    .padding(.horizontal, Space.sm)
                    .padding(.vertical, Space.xs)
                    .background(DuskColors.accent, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("update-banner-action")

            Button(action: onDismiss) {
                Text(dismissGlyph)
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.ink3)
                    .padding(.horizontal, Space.xs)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("update-banner-dismiss")
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .background(DuskColors.bgElev, in: Capsule())
        .overlay(Capsule().stroke(DuskColors.line, lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 18, y: 6)
        .padding(.horizontal, Space.lg)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("update-banner")
    }
}

#Preview {
    ZStack(alignment: .top) {
        DuskColors.bg.ignoresSafeArea()
        UpdateBanner(versionName: "0.2.0", onUpdate: {}, onDismiss: {})
            .padding(.top, Space.lg)
    }
}
