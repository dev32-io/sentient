import SwiftUI

/// Compatibility facade for the row-stack card API. `DesignCard` owns the
/// shared surface, header, divider, and spacing implementation.
struct SettingsCard<Content: View>: View {
    var title: String?
    var sub: String?
    @ViewBuilder var content: () -> Content

    init(title: String? = nil, sub: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.sub = sub
        self.content = content
    }

    var body: some View {
        DesignCard(title: title, detail: sub, headerStyle: .elevated, bodyStyle: .rows) {
            content()
        }
    }
}

#Preview {
    ScrollView {
        VStack(spacing: Space.lg) {
            SettingsCard(title: "Memory", sub: "Hard-capped per Hermes spec.") {
                Text("Row content goes here")
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.ink2)
                    .padding(.vertical, Space.sm)
            }
            SettingsCard {
                Text("Header-less card")
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.ink2)
                    .padding(.vertical, Space.sm)
            }
        }
        .padding(Space.lg)
    }
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
