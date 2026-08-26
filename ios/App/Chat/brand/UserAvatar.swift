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
    var selected = false
    var disabled = false

    var body: some View {
        ElevatedUserAvatar(
            name: name,
            size: size,
            selected: selected,
            disabled: disabled
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
