import SwiftUI
import MobileData

struct AvatarTile: View {
    let user: AuthUserLite
    let onTap: () -> Void

    var body: some View {
        DesignDominantVisualCard(
            title: user.displayName,
            accessibilityLabel: "Continue as \(user.displayName)",
            accessibilityId: "login-avatar-\(user.userId)",
            quietHoverBorder: true,
            action: onTap
        ) {
            ElevatedUserAvatar(
                name: user.displayName,
                size: DesignMetrics.dominantAvatarSize,
                tint: DesignUserAvatarTint(serverValue: user.avatarTint)
            )
        }
    }
}
