import SwiftUI

/// Calendar sheet body composition. Presentation chrome, scrim, drag tracking,
/// scroll handoff, and dismissal animation are owned by SwiftUI's native sheet.
struct CalendarSheet<Content: View, Footer: View>: View {
    let dismissOnScrim: Bool
    let onDismiss: () -> Void
    let hasPinnedFooter: Bool
    @ViewBuilder let content: () -> Content
    @ViewBuilder let footer: () -> Footer

    init(dismissOnScrim: Bool, onDismiss: @escaping () -> Void,
         @ViewBuilder content: @escaping () -> Content) where Footer == EmptyView {
        self.dismissOnScrim = dismissOnScrim
        self.onDismiss = onDismiss
        self.hasPinnedFooter = false
        self.content = content
        self.footer = { EmptyView() }
    }

    init(dismissOnScrim: Bool, onDismiss: @escaping () -> Void,
         @ViewBuilder content: @escaping () -> Content,
         @ViewBuilder footer: @escaping () -> Footer) {
        self.dismissOnScrim = dismissOnScrim
        self.onDismiss = onDismiss
        self.hasPinnedFooter = true
        self.content = content
        self.footer = footer
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    content()
                }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.lg)
                .padding(.bottom, hasPinnedFooter ? Space.md : Space.xl)
            }
            .scrollDismissesKeyboard(.interactively)

            if hasPinnedFooter {
                footer()
                    .padding(.horizontal, Space.lg)
                    .padding(.top, Space.sm)
                    .padding(.bottom, Space.md)
                    .background(DuskColors.paper)
                    .overlay(alignment: .top) { Divider().foregroundStyle(DuskColors.lineSoft) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DuskColors.paper)
        .accessibilityElement(children: .contain)
        .accessibilityAction(.escape) {
            if dismissOnScrim { onDismiss() }
        }
    }
}
