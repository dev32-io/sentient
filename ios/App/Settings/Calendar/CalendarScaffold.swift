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
                .padding(.horizontal, CalendarSurfaceLayout.floatingHorizontalInset)
                .padding(.top, Space.xs)
                .padding(.bottom, Space.sm)
        }
        .background(DuskColors.bg)
        .overlay(alignment: .topLeading) {
            if state.recovery.isReady {
                Color.clear
                    .frame(width: CalendarSurfaceLayout.accessibilitySentinelSize,
                           height: CalendarSurfaceLayout.accessibilitySentinelSize)
                    .accessibilityIdentifier("calendar-recovery-ready")
            }
        }
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
        .accessibilityValue(state.recovery.isReady ? "Calendar recovery ready" : "Calendar recovery pending")
        .duskTheme()
    }
}
