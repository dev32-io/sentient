import SwiftUI

/// Compatibility facade for the pre-v2 category row API. Visual ownership is
/// in `DesignCategoryRow`.
struct CategoryRow: View {
    let icon: SettingsIcon
    let title: String
    let accessibilityId: String
    let onTap: () -> Void

    var body: some View {
        DesignCategoryRow(icon: icon, title: title, accessibilityId: accessibilityId, onTap: onTap)
    }
}

#Preview {
    VStack(spacing: 0) {
        CategoryRow(icon: .memory, title: "Memory", accessibilityId: "settings-cat-memory", onTap: {})
        CategoryRow(icon: .voice, title: "Voice", accessibilityId: "settings-cat-voice", onTap: {})
        CategoryRow(icon: .secrets, title: "Secrets", accessibilityId: "settings-cat-secrets", onTap: {})
    }
    .padding(.horizontal, Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
