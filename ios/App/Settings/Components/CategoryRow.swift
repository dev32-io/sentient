// ---------------------------------------------------------------------------
// CategoryRow — one tappable row on the root Settings list: SF Symbol +
// title + trailing chevron. One row per category (Memory, Voice, Account,
// …); the destination page is pushed by the caller's `onTap`, not this view
// — CategoryRow knows nothing about navigation (swiftui state-hoisting rule:
// leaf views take state + closures, never a Route or a ViewModel).
//
// `accessibilityId` is per-instance (many rows share this one view type on
// the same screen), matching the HistoryRow / SettingsDiagnostics convention
// of a caller-supplied identifier rather than a hardcoded literal.
// ---------------------------------------------------------------------------
import SwiftUI

private let iconSlotWidth: CGFloat = 26

struct CategoryRow: View {
    let icon: SettingsIcon
    let title: String
    let accessibilityId: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: Space.md) {
                Image(systemName: icon.symbolName)
                    .font(.system(size: TypeScale.base, weight: .medium))
                    .foregroundStyle(DuskColors.ink2)
                    .frame(width: iconSlotWidth, alignment: .center)

                Text(title)
                    .font(Typo.ui(TypeScale.base, .medium))
                    .foregroundStyle(DuskColors.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.right")
                    .font(.system(size: TypeScale.xs, weight: .semibold))
                    .foregroundStyle(DuskColors.ink3)
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
            .padding(.vertical, Space.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityId)
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
