import SwiftUI

struct CalendarSheet<Content: View, Footer: View>: View {
    let dismissOnScrim: Bool
    let onDismiss: () -> Void
    let hasPinnedFooter: Bool
    @ViewBuilder let content: () -> Content
    @ViewBuilder let footer: () -> Footer

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @GestureState private var dragOffset: CGFloat = 0

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
        GeometryReader { proxy in
            ZStack(alignment: .bottom) {
                DuskColors.bg.opacity(CalendarOverlaySemantics.scrimOpacity)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { if dismissOnScrim { onDismiss() } }
                    .accessibilityHidden(true)

                VStack(spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Space.lg) {
                            Capsule()
                                .fill(DuskColors.line)
                                .frame(width: CalendarOverlaySemantics.handleSize.width,
                                       height: CalendarOverlaySemantics.handleSize.height)
                                .frame(maxWidth: .infinity)
                                .accessibilityHidden(true)
                            content()
                        }
                        .padding(.horizontal, Space.lg)
                        .padding(.top, Space.md)
                        .padding(.bottom, hasPinnedFooter ? Space.md : max(Space.xl, proxy.safeAreaInsets.bottom + Space.md))
                    }
                    .scrollDismissesKeyboard(.interactively)
                    if hasPinnedFooter {
                        footer()
                            .padding(.horizontal, Space.lg)
                            .padding(.top, Space.sm)
                            .padding(.bottom, max(Space.md, proxy.safeAreaInsets.bottom + Space.sm))
                            .background(DuskColors.paper)
                            .overlay(alignment: .top) { Divider().foregroundStyle(DuskColors.lineSoft) }
                    }
                }
                .frame(maxWidth: .infinity,
                       maxHeight: proxy.size.height * CalendarOverlaySemantics.maximumHeightFraction)
                .background(DuskColors.paper)
                .clipShape(.rect(topLeadingRadius: CalendarOverlaySemantics.topRadius,
                                 topTrailingRadius: CalendarOverlaySemantics.topRadius))
                .overlay(alignment: .top) {
                    UnevenRoundedRectangle(topLeadingRadius: CalendarOverlaySemantics.topRadius,
                                           topTrailingRadius: CalendarOverlaySemantics.topRadius)
                        .stroke(DuskColors.lineSoft, lineWidth: CalendarOverlaySemantics.sheetBorderWidth)
                        .allowsHitTesting(false)
                }
                .shadow(color: DuskColors.bg.opacity(CalendarOverlaySemantics.sheetShadowOpacity),
                        radius: CalendarOverlaySemantics.sheetShadowRadius,
                        y: CalendarOverlaySemantics.sheetShadowY)
                .offset(y: dismissOnScrim ? max(CalendarOverlaySemantics.restingOffset, dragOffset) : CalendarOverlaySemantics.restingOffset)
                .gesture(dismissOnScrim ? dismissGesture : nil)
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isModal)
                .accessibilityAction(.escape) { if dismissOnScrim { onDismiss() } }
            }
        }
        // Ignore only the container's home-indicator inset. The keyboard safe
        // area remains active so a pinned editor footer rises above the IME.
        .ignoresSafeArea(.container, edges: .bottom)
        .animation(reduceMotion ? nil : .easeOut(duration: Motion.fast), value: dismissOnScrim)
    }

    private var dismissGesture: some Gesture {
        DragGesture(minimumDistance: CalendarOverlaySemantics.dismissMinimumDistance)
            .updating($dragOffset) { value, offset, _ in
                offset = max(CalendarOverlaySemantics.restingOffset, value.translation.height)
            }
            .onEnded { value in
                if value.translation.height > CalendarOverlaySemantics.dismissDragThreshold ||
                    value.predictedEndTranslation.height > CalendarOverlaySemantics.dismissPredictedThreshold {
                    onDismiss()
                }
            }
    }
}
