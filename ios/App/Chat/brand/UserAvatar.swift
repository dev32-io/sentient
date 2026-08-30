// UserAvatar — compatibility entry for the reviewed elevated user identity.
//
// Chat keeps its established UserAvatar call sites, while the implementation
// delegates to the canonical ElevatedUserAvatar so login, member, and chat
// surfaces share the same central-token material, initials, Dynamic Type, and
// accessibility behavior.
import SwiftUI

struct UserAvatar: View {
    let name: String
    var size: CGFloat = UserAvatarLayout.defaultSize
    var tint: DesignUserAvatarTint = .fallback
    var selected = false
    var disabled = false
    var fallback = false
    var initial: String? = nil

    var body: some View {
        ElevatedUserAvatar(
            name: name,
            size: size,
            tint: tint,
            selected: selected,
            disabled: disabled,
            fallback: fallback,
            initial: initial
        )
    }
}

/// Compatibility namespace retained for existing chat call sites. Layout is
/// sourced from the central accessibility metric rather than a chat-only
/// avatar primitive.
enum UserAvatarLayout {
    static let defaultSize: CGFloat = DesignMetrics.minimumTarget
    // Legacy names remain source-compatible; the canonical elevated primitive
    // owns their visual treatment now.
    static let glyphRatio: CGFloat = 0.5
    static let ringOpacity: Double = 0.2
}
