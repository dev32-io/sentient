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

/// Dark-terra text used on top of the terra-50/accent background (avatar
/// initial and FAB plus icon). No `onAccent` token exists in DuskColors —
/// extracted here as a single shared constant rather than duplicating the
/// literal across files.
let terraOnAccentText = Color(red: 0.17, green: 0.10, blue: 0.06)

private let avatarSize: CGFloat = 38

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
        Text(String(name.prefix(1)))
            .font(Typo.ui(15, .bold))
            .foregroundStyle(terraOnAccentText)
            .frame(width: avatarSize, height: avatarSize)
            .background(DuskColors.accent, in: Circle())
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
        Button(action: onSettings) {
            Image(systemName: "gearshape")
                .font(.system(size: 19))
                .foregroundStyle(DuskColors.ink2)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings-open")
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
