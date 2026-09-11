// ---------------------------------------------------------------------------
// HistoryAccountHeader — terra avatar initial + display name + household +
// settings gear. Maps to the design token `.m-hx-account`.
//
// The gear (settings-open) is relocated here from the topbar per the D-I5
// design polish spec: the settings entry lives at the top of the history
// panel, co-located with the account identity.
//
// Stateless leaf — takes name/household strings and an onSettings closure;
// never references a ViewModel (swiftui state-hoisting rule).
// ---------------------------------------------------------------------------
import SwiftUI

private let avatarSize = DesignMetrics.minimumTarget

struct HistoryAccountHeader: View {
    let name: String
    let household: String
    let onSettings: () -> Void

    var body: some View {
        HStack(spacing: Space.md) {
            avatar
            identity
            Spacer()
            gearButton
        }
        .padding(Space.md)
    }

    private var avatar: some View {
        ElevatedUserAvatar(
            name: name,
            size: avatarSize,
            tint: .terra
        )
    }

    private var identity: some View {
        // Only render the household line when present — an empty Text would push
        // the name above the avatar's vertical center. With it omitted, the lone
        // name line centers against the avatar via the HStack's default .center.
        VStack(alignment: .leading, spacing: 1) {
            Text(name)
                .font(Typo.ui(14, .semibold))
                .foregroundStyle(DuskColors.ink)
            if !household.isEmpty {
                Text(household)
                    .font(Typo.ui(12))
                    .foregroundStyle(DuskColors.ink3)
            }
        }
    }

    private var gearButton: some View {
        DesignIconButton(
            systemName: "gearshape",
            label: "Settings",
            accessibilityId: "settings-open",
            action: onSettings
        )
    }
}

#Preview {
    HistoryAccountHeader(
        name: "Kevin",
        household: "Ye Family",
        onSettings: {}
    )
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
