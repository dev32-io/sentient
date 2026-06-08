// UserAvatar — user's initial centered on the terra/amber accent circle.
// Shared by the chat meta-row avatar (MessageBubble) and the login user grid
// (AvatarTile), matching the webui avatar treatment.
import SwiftUI

/// User's initial centered on the terra/amber accent circle (webui parity).
/// Shared by the chat meta-row avatar and the login user grid.
struct UserAvatar: View {
    let name: String
    var size: CGFloat = BubbleLayout.avatarSize

    private var initial: String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first else { return "?" }
        return String(first).uppercased()
    }

    var body: some View {
        ZStack {
            Circle().fill(DuskColors.accent)
            Text(initial)
                .font(Typo.ui(size * UserAvatarLayout.glyphRatio, .semibold))
                .foregroundStyle(DuskColors.ink)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Layout tunables for UserAvatar; exposed as a namespace so future
/// per-context overrides (e.g. large login tile) can be added here.
enum UserAvatarLayout {
    /// Initial glyph size as a fraction of the avatar circle diameter.
    static let glyphRatio: CGFloat = 0.5
}
