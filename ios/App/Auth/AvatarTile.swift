// ---------------------------------------------------------------------------
// AvatarTile — one avatar in the login grid: a UserAvatar (terra/amber initial
// circle, webui parity) plus the displayName below. Stateless leaf: takes the
// user + an onTap closure; references no model (state-hoisting rule).
//
// accessibilityIdentifier `login-avatar-<userId>` mirrors the Android testTag
// so Maestro/XCUITest target it directly.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

struct AvatarTile: View {
    let user: AuthUserLite
    let onTap: () -> Void

    private static let avatarSize: CGFloat = 56
    private static let labelWidth: CGFloat = 72

    var body: some View {
        VStack(spacing: Space.sm) {
            Button(action: onTap) {
                UserAvatar(name: user.displayName, size: Self.avatarSize)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("login-avatar-\(user.userId)")

            Text(user.displayName)
                .font(.system(size: TypeScale.base))
                .foregroundStyle(DuskColors.ink3)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(width: Self.labelWidth)
    }
}
