import SwiftUI

/// Notices reserve space instead of covering controls. Large notice stacks scroll
/// within half the available unoccluded viewport, leaving page header/content reachable.
struct ShellNoticeRegion<Content: View>: View {
    let availableHeight: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        ViewThatFits(in: .vertical) {
            content().fixedSize(horizontal: false, vertical: true)
            ScrollView { content() }
                .scrollBounceBehavior(.basedOnSize)
                .scrollDismissesKeyboard(.interactively)
        }
        .frame(maxHeight: availableHeight / 2)
    }
}
