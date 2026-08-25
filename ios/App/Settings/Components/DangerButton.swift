// ---------------------------------------------------------------------------
// DangerButton — full-width, red-tinted, outlined button. Extracted verbatim
// from SettingsView.swift's `logoutButton` (same font/padding/stroke), so
// SettingsView's visual output is unchanged once a later phase swaps its
// inline button for this component. Kept on `.font(.system(size:weight:))`
// rather than the newer `Typo.ui` token — matching the ORIGINAL exactly is
// the point of an extraction, not a restyle.
//
// Used for the root Settings "Log out" row today; also fits Members'
// destructive delete-user action per the plan.
//
// Stateless leaf: `title` + `action` in, no local state.
// ---------------------------------------------------------------------------
import SwiftUI

struct DangerButton: View {
    let title: String
    let accessibilityId: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: TypeScale.base, weight: .semibold))
                .foregroundStyle(DuskColors.stop)
                .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget)
                .padding(.horizontal, Space.md)
                .overlay(
                    RoundedRectangle(cornerRadius: Radii.md)
                        .stroke(DuskColors.stop, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityId)
    }
}

#Preview {
    DangerButton(title: "Log out", accessibilityId: "settings-logout", action: {})
        .padding(Space.lg)
        .background(DuskColors.bg)
        .preferredColorScheme(.dark)
}
