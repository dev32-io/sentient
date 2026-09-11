import SwiftUI

/// Compatibility facade for the old group-header name.
struct GroupHeader: View {
    let title: String

    var body: some View { DesignGroupHeader(title: title) }
}

#Preview {
    GroupHeader(title: "Assistant")
        .padding()
        .background(DuskColors.bg)
        .preferredColorScheme(.dark)
}
