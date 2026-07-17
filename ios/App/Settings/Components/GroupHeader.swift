// ---------------------------------------------------------------------------
// GroupHeader — small section label above a group of settings rows (e.g.
// "Soul", "User", "Admin", "Support" on the root Settings list).
//
// Matches the existing inline section-label style already used in
// SettingsView.swift (versionLabel / updatesLabel / diagnosticsLabel: xs
// semibold ink3, system font) rather than the webui's letter-spaced
// uppercase CSS treatment — this keeps the native list visually consistent
// with the thin v1 Settings surface it is extending.
//
// Stateless leaf: label text in, nothing else.
// ---------------------------------------------------------------------------
import SwiftUI

struct GroupHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: TypeScale.xs, weight: .semibold))
            .foregroundStyle(DuskColors.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#Preview {
    GroupHeader(title: "Soul")
        .padding()
        .background(DuskColors.bg)
        .preferredColorScheme(.dark)
}
