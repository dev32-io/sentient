import SwiftUI

struct UpdateBanner: View {
    let versionName: String
    let onUpdate: () -> Void
    let onDismiss: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Space.md))
            : AnyLayout(HStackLayout(alignment: .center, spacing: Space.md))
        layout {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Update available")
                    .designText(.body)
                    .foregroundStyle(DuskColors.ink)
                Text("Version \(versionName)")
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.ink3)
            }
            Spacer(minLength: Space.sm)
            DesignActionButton(
                title: "Update",
                accessibilityId: "update-banner-action",
                fillsWidth: false,
                action: onUpdate
            )
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss update")
            .accessibilityIdentifier("update-banner-dismiss")
        }
        .padding(Space.md)
        .designFloat()
        .padding(.horizontal, Space.lg)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("update-banner")
    }
}

#Preview("Large text") {
    UpdateBanner(versionName: "1.5.0", onUpdate: {}, onDismiss: {})
        .environment(\.dynamicTypeSize, .accessibility3)
        .padding(.vertical, Space.xl)
        .background(DuskColors.bg)
}
