// ---------------------------------------------------------------------------
// ForceUpdateView — the full-screen blocking gate for a MANDATORY update. Swift
// mirror of Android's ForceUpdateScreen (update/ForceUpdateScreen.kt).
//
// Rendered by UpdateGate as an OPAQUE full-screen overlay AHEAD of the authed
// content when the status is Available && mandatory. There is no dismiss and no
// back affordance: the opaque background fills the screen and swallows touches to
// the content beneath, so the user cannot escape the gate. The single action
// installs the update; once a new build launches, the next process starts
// UpToDate and the gate is gone.
//
// Stateless leaf: takes the version label + onInstall. accessibilityIdentifiers:
// force-update (container), force-update-action ([Update now]).
// ---------------------------------------------------------------------------
import SwiftUI

private let titleText = "Update required"
private let bodyText =
    "A newer version is required to keep using Sentient. Please update to continue."
private let versionPrefix = "Version "
private let actionLabel = "Update now"

/// Blocking mandatory-update gate. `versionName` labels the required release;
/// `onInstall` hands off to the installer. No back / no dismiss by design.
struct ForceUpdateView: View {
    let versionName: String
    let onInstall: () -> Void

    var body: some View {
        ZStack {
            // Opaque fill: covers the authed content and swallows touches beneath.
            DuskColors.bg.ignoresSafeArea()

            VStack(spacing: Space.md) {
                Text(titleText)
                    .font(Typo.ui(TypeScale.xl, .semibold))
                    .foregroundStyle(DuskColors.ink)
                    .multilineTextAlignment(.center)

                Text(bodyText)
                    .font(Typo.ui(TypeScale.base, .regular))
                    .foregroundStyle(DuskColors.ink2)
                    .multilineTextAlignment(.center)

                if !versionName.isEmpty {
                    Text("\(versionPrefix)\(versionName)")
                        .font(Typo.ui(TypeScale.sm, .regular))
                        .foregroundStyle(DuskColors.ink3)
                        .multilineTextAlignment(.center)
                }

                Button(action: onInstall) {
                    Text(actionLabel)
                        .font(Typo.ui(TypeScale.base, .semibold))
                        .foregroundStyle(DuskColors.bg)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Space.sm)
                        .background(DuskColors.accent, in: RoundedRectangle(cornerRadius: Radii.md))
                }
                .buttonStyle(.plain)
                .padding(.top, Space.xl)
                .accessibilityIdentifier("force-update-action")
            }
            .padding(.horizontal, Space.xl)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("force-update")
    }
}

#Preview {
    ForceUpdateView(versionName: "0.2.0", onInstall: {})
}
