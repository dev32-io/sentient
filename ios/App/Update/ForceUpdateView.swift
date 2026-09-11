import SwiftUI

struct ForceUpdateView: View {
    let versionName: String
    let onInstall: () -> Void

    var body: some View {
        ZStack {
            DuskColors.bg.ignoresSafeArea()
            ScrollView {
                VStack(spacing: Space.xl) {
                    Spacer(minLength: Space.xxl)
                    DesignPane {
                        VStack(alignment: .leading, spacing: Space.md) {
                            Label("Update required", systemImage: "arrow.down.circle.fill")
                                .designText(.title)
                                .foregroundStyle(DuskColors.ink)
                            Text("A newer version is required to keep using Sentient. Please update to continue.")
                                .designText(.body)
                                .foregroundStyle(DuskColors.ink2)
                            if !versionName.isEmpty {
                                Text("Version \(versionName)")
                                    .designText(.supporting)
                                    .foregroundStyle(DuskColors.ink3)
                            }
                            DesignActionButton(
                                title: "Update now",
                                accessibilityId: "force-update-action",
                                action: onInstall
                            )
                        }
                    }
                    Spacer(minLength: Space.xl)
                }
                .padding(.horizontal, Space.xl)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("force-update")
    }
}

#Preview("Large text") {
    ForceUpdateView(versionName: "1.5.0", onInstall: {})
        .environment(\.dynamicTypeSize, .accessibility3)
}
