import SwiftUI

/// Compatibility facade for the old destructive settings button. The shared
/// action primitive owns its material, state, and accessibility semantics.
struct DangerButton: View {
    let title: String
    let accessibilityId: String
    let action: () -> Void

    var body: some View {
        DesignActionButton(
            title: title,
            role: .destructive,
            accessibilityId: accessibilityId,
            action: action
        )
    }
}

#Preview {
    DangerButton(title: "Log out", accessibilityId: "settings-logout", action: {})
        .padding(Space.lg)
        .background(DuskColors.bg)
        .preferredColorScheme(.dark)
}
