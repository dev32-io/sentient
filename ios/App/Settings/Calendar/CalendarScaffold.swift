import MobileData
import SwiftUI
import UIKit

struct CalendarSurfaceActions {
    let onBack: () -> Void
    let onAdd: () -> Void
    let onToday: () -> Void
    let onPrevious: () -> Void
    let onNext: () -> Void
    let onSelectDate: (String) -> Void
    let onSelectMonth: (Int32, Int32) -> Void
    let onSelectView: (CalendarView) -> Void
    let onFiltersChanged: (CalendarFilters) -> Void
    let onSearch: (String) -> Void
    let onEvent: (CalendarProjectedEvent) -> Void
    let onRetry: () -> Void
}

struct CalendarScaffold: View {
    let state: CalendarUiState
    let actions: CalendarSurfaceActions
    let openerFocus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            CalendarTopBar(
                canAdd: state.mutationAvailability.canCreate,
                openerFocus: openerFocus,
                onBack: actions.onBack,
                onAdd: actions.onAdd
            )
            ScrollView {
                LazyVStack(spacing: 0) {
                    CalendarHeading(
                        state: state,
                        onToday: actions.onToday,
                        onPrevious: actions.onPrevious,
                        onNext: actions.onNext
                    )
                    .padding(.bottom, Space.lg)

                    CalendarFiltersView(
                        filters: state.filters,
                        facets: state.facets,
                        onChange: actions.onFiltersChanged,
                        onSearch: actions.onSearch
                    )

                    CalendarStatusView(state: state, onRetry: actions.onRetry)
                        .padding(.top, Space.sm)

                    if state.projection != nil {
                        if CalendarSurfaceMapping.showsCompactCanvas(state.view) {
                            CalendarCanvasView(
                                state: state,
                                onSelectDate: actions.onSelectDate,
                                onSelectMonth: actions.onSelectMonth
                            )
                            .padding(.top, Space.lg)
                            .id("\(state.view)-\(state.anchorDate)")
                            .transition(reduceMotion ? .identity : .opacity.combined(with: .scale(scale: 0.99)))
                        }

                        if state.view != .year {
                            CalendarAgendaView(
                                sections: CalendarSurfaceMapping.agenda(for: state),
                                locale: state.locale,
                                emptyMessage: state.content == .empty ? "No events match these filters." : "No events planned.",
                                openerFocus: openerFocus,
                                onEvent: actions.onEvent
                            )
                            .padding(.top, Space.sm)
                        }
                    }
                }
                .padding(.horizontal, CalendarSurfaceLayout.contentInset)
                .padding(.top, Space.lg)
                .padding(.bottom, CalendarSurfaceLayout.floatingBarClearance)
            }
            .scrollDismissesKeyboard(.interactively)
            .accessibilityLabel("Calendar content")
            .accessibilityIdentifier("calendar-scroll-region")
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            FloatingViewBar(selected: state.view, onSelect: actions.onSelectView)
                .padding(.horizontal, 12)
                .padding(.top, Space.xs)
                .padding(.bottom, Space.sm)
        }
        .background(DuskColors.bg)
        .animation(reduceMotion ? nil : .easeInOut(duration: Motion.normal), value: state.view)
        .onChange(of: CalendarSurfaceText.stateAnnouncement(state), initial: true) { _, announcement in
            guard let announcement else { return }
            UIAccessibility.post(notification: .announcement, argument: announcement)
        }
        .onChange(of: state.freshness) { previous, current in
            guard let announcement = CalendarSurfaceText.freshnessRecoveryAnnouncement(from: previous, to: current) else { return }
            UIAccessibility.post(notification: .announcement, argument: announcement)
        }
        .onChange(of: CalendarSurfaceText.navigationAnnouncement(state)) { _, announcement in
            UIAccessibility.post(notification: .announcement, argument: announcement)
        }
        .onChange(of: CalendarSurfaceText.filterAnnouncementKey(state)) {
            UIAccessibility.post(notification: .announcement, argument: "Calendar filters updated")
        }
        .accessibilityIdentifier("calendar-surface")
        .duskTheme()
    }
}

struct CalendarTopBar: View {
    let canAdd: Bool
    let openerFocus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding?
    let onBack: () -> Void
    let onAdd: () -> Void

    var body: some View {
        HStack(spacing: Space.sm) {
            Button("Back", systemImage: "chevron.left", action: onBack)
                .labelStyle(.iconOnly)
                .font(.system(size: 17, weight: .semibold))
                .frame(minWidth: CalendarSurfaceLayout.minimumTarget, minHeight: CalendarSurfaceLayout.minimumTarget)
                .accessibilityIdentifier("calendar-back")
            Text("Calendar")
                .font(CalendarFont.ui(TypeScale.lg, .semibold))
                .foregroundStyle(DuskColors.ink)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button("Add", action: onAdd)
                .font(CalendarFont.ui(TypeScale.sm, .semibold))
                .foregroundStyle(DuskColors.bg)
                .padding(.horizontal, Space.md)
                .frame(minWidth: CalendarSurfaceLayout.minimumTarget, minHeight: CalendarSurfaceLayout.minimumTarget)
                .background(DuskColors.accent, in: RoundedRectangle(cornerRadius: Radii.md))
                .disabled(!canAdd)
                .opacity(canAdd ? 1 : 0.45)
                .accessibilityHint(canAdd ? "Creates a calendar event" : "Adding events is unavailable")
                .calendarAccessibilityFocus(openerFocus, equals: .addControl)
                .accessibilityIdentifier("calendar-add")
        }
        .padding(.horizontal, Space.sm)
        .frame(height: CalendarSurfaceLayout.topBarHeight)
        .background(DuskColors.bgElev)
        .overlay(alignment: .bottom) { Divider().overlay(DuskColors.lineSoft) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar-top-bar-58")
    }
}

struct CalendarHeading: View {
    let state: CalendarUiState
    let onToday: () -> Void
    let onPrevious: () -> Void
    let onNext: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: Space.md) {
            VStack(alignment: .leading, spacing: 5) {
                Text(CalendarSurfaceText.heading(for: state))
                    .font(CalendarFont.display(34, .medium))
                    .foregroundStyle(DuskColors.ink)
                    .minimumScaleFactor(0.72)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                Text(CalendarSurfaceText.subtitle(for: state))
                    .font(CalendarFont.mono(10))
                    .foregroundStyle(DuskColors.ink3)
            }
            Spacer(minLength: 0)
            HStack(spacing: Space.sm) {
                CalendarNavigationButton(label: "Today", action: onToday)
                CalendarNavigationButton(label: "Previous period", systemImage: "chevron.left", action: onPrevious)
                CalendarNavigationButton(label: "Next period", systemImage: "chevron.right", action: onNext)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct CalendarNavigationButton: View {
    let label: String
    var systemImage: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if let systemImage { Image(systemName: systemImage) } else { Text(label) }
            }
            .font(systemImage == nil ? CalendarFont.ui(TypeScale.xs, .medium) : .system(size: 12, weight: .semibold))
            .foregroundStyle(DuskColors.ink2)
            .frame(minWidth: CalendarSurfaceLayout.minimumTarget, minHeight: CalendarSurfaceLayout.minimumTarget)
            .background(DuskColors.bgSunk, in: RoundedRectangle(cornerRadius: Radii.md))
            .overlay(RoundedRectangle(cornerRadius: Radii.md).stroke(DuskColors.lineSoft))
        }
        .buttonStyle(CalendarPressButtonStyle())
        .accessibilityLabel(label)
    }
}

struct CalendarStatusView: View {
    let state: CalendarUiState
    let onRetry: () -> Void

    var body: some View {
        Group {
            switch state.content {
            case .loading:
                HStack(spacing: Space.sm) {
                    ProgressView()
                    Text("Loading calendar…")
                }
                .statusStyle()
            case .unavailableOffline:
                retryStatus("This date range is not available offline.", icon: "wifi.slash")
            case .error:
                retryStatus(state.error?.userMessage ?? "Calendar is unavailable.", icon: "exclamationmark.triangle")
            case .empty, .content:
                if state.isOffline {
                    Label("Showing saved calendar data", systemImage: "wifi.slash").statusStyle()
                } else if state.isRefreshing {
                    Label("Refreshing calendar…", systemImage: "arrow.clockwise").statusStyle()
                } else if state.freshness == .stale {
                    Label("Calendar may be out of date", systemImage: "clock").statusStyle()
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(CalendarSurfaceText.stateAnnouncement(state) ?? "Calendar ready")
        .accessibilityIdentifier(CalendarSurfaceMapping.freshnessIdentifier(for: state))
    }

    private func retryStatus(_ message: String, icon: String) -> some View {
        HStack(spacing: Space.sm) {
            Label(message, systemImage: icon)
            Spacer(minLength: 0)
            Button("Retry", action: onRetry)
                .frame(minHeight: CalendarSurfaceLayout.minimumTarget)
                .accessibilityIdentifier("calendar-retry")
        }
        .statusStyle()
    }
}

private extension View {
    func statusStyle() -> some View {
        self
            .font(CalendarFont.ui(TypeScale.xs))
            .foregroundStyle(DuskColors.ink3)
            .padding(.horizontal, Space.md)
            .frame(maxWidth: .infinity, minHeight: CalendarSurfaceLayout.minimumTarget, alignment: .leading)
            .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.md))
    }
}

struct FloatingViewBar: View {
    let selected: CalendarView
    let onSelect: (CalendarView) -> Void

    var body: some View {
        HStack(spacing: 3) {
            ForEach(CalendarView.allCases, id: \.self) { view in
                Button(view.displayName) { onSelect(view) }
                    .font(CalendarFont.mono(TypeScale.xs))
                    .foregroundStyle(selected == view ? DuskColors.ink : DuskColors.ink3)
                    .frame(maxWidth: .infinity, minHeight: CalendarSurfaceLayout.viewControlHeight)
                    .background(selected == view ? DuskColors.bgSunk : .clear, in: Capsule())
                    .overlay(Capsule().stroke(selected == view ? DuskColors.line : .clear))
                    .buttonStyle(CalendarPressButtonStyle())
                    .accessibilityValue(selected == view ? "Selected" : "Not selected")
                    .accessibilityAddTraits(selected == view ? .isSelected : [])
                    .accessibilityIdentifier("calendar-view-\(view.displayName.lowercased())")
            }
        }
        .padding(5)
        .background(.ultraThinMaterial, in: Capsule())
        .background(DuskColors.paper.opacity(0.94), in: Capsule())
        .overlay(Capsule().stroke(DuskColors.line))
        .shadow(color: DuskColors.bg.opacity(0.82), radius: 28, y: 20)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Calendar view")
        .accessibilityIdentifier("calendar-floating-view-bar-46")
    }
}

private extension View {
    @ViewBuilder
    func calendarAccessibilityFocus(
        _ focus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding?,
        equals origin: CalendarOverlayOrigin
    ) -> some View {
        if let focus {
            accessibilityFocused(focus, equals: origin)
        } else {
            self
        }
    }
}

extension CalendarView {
    var displayName: String {
        switch self {
        case .day: "Day"
        case .week: "Week"
        case .month: "Month"
        case .year: "Year"
        }
    }
}
