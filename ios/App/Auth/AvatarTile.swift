import SwiftUI
import MobileData

struct AvatarTile: View {
    let user: AuthUserLite
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: Space.sm) {
                ElevatedUserAvatar(name: user.displayName)
                Text(user.displayName)
                    .designText(.body)
                    .foregroundStyle(DuskColors.ink2)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .frame(minWidth: DesignMetrics.minimumTarget)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(user.displayName)
        .accessibilityHint("Enter PIN")
        .accessibilityIdentifier("login-avatar-\(user.userId)")
    }
}
