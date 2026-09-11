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
    var onRequestPeriods: (CalendarViewportRequest) -> Void = { _ in }
    var onBrowsePeriod: (CalendarViewportMonth) -> Void = { _ in }
    var onRequestAdjacentPeriods: (CalendarAdjacentViewportRequest) -> Void = { _ in }
    var onBrowseDate: (CalendarViewportDate) -> Void = { _ in }
    var onSelectDateFromBrowse: (CalendarViewportDate, String) -> Void = { _, _ in }
}

struct CalendarScaffold: View {
    let state: CalendarUiState
    let actions: CalendarSurfaceActions
    let openerFocus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding
    var viewportData: CalendarViewportData? = nil
    var browseCursor: CalendarViewportMonth? = nil
    var adjacentData: CalendarAdjacentViewportData? = nil
    var dateCursor: CalendarViewportDate? = nil
    var todayRevision: Int = 0
    @State private var browsedMonth: CalendarViewportMonth?
    @State private var browseAnchor: String?
    @State private var browseTodayRevision = 0
    @State private var filtersPresented = false
    @State private var controlsHeight: CGFloat = 0
    @AccessibilityFocusState private var filterFocus: Bool

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                CalendarTopBar(
                    canAdd: state.mutationAvailability.canCreate,
                    openerFocus: openerFocus,
                    onBack: actions.onBack,
                    onAdd: actions.onAdd,
                    showsAdd: true
                )
                calendarContent
                    .environment(\.calendarBottomOcclusion, controlsHeight + geometry.safeAreaInsets.bottom)
                    .environment(\.calendarTodayRevision, todayRevision)
            }
            .overlay(alignment: .bottom) {
                FloatingViewBar(selected: state.view, onSelect: actions.onSelectView,
                                onFilters: { filtersPresented = true }, filterFocus: $filterFocus,
                                activeFilterCount: CalendarFilterMapping.activeCount(in: state.filters))
                    .padding(.horizontal, CalendarSurfaceLayout.floatingHorizontalInset)
                    .padding(.bottom, Space.sm)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { controlsHeight = $0 }
            }
        }
        .sheet(isPresented: $filtersPresented, onDismiss: { filterFocus = true }) {
            NavigationStack {
                ScrollView {
                    filters.padding(Space.md)
                }
                .scrollDismissesKeyboard(.interactively)
                .background(DuskColors.bg)
                .navigationTitle("Calendar filters")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        DesignTextButton(title: "Done", accessibilityId: "calendar-close-filters") {
                            filtersPresented = false
                        }
                    }
                }
                .toolbarBackground(DuskColors.bgElev, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .duskTheme()
        }
        .onChange(of: CalendarOverlaySemantics.isOpen(state)) { _, isOpen in
            if isOpen { filtersPresented = false }
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
        .onChange(of: statusAnnouncement, initial: true) { _, announcement in
            guard let announcement else { return }
            UIAccessibility.post(notification: .announcement, argument: announcement)
        }
        .onChange(of: state.freshness) { previous, current in
            guard !usesMonthViewportStatus, adjacentData == nil,
                  let announcement = CalendarSurfaceText.freshnessRecoveryAnnouncement(from: previous, to: current) else { return }
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

    /// Grid geometry owns requests while its lease is active, even if the
    /// independent foreground window is loading. Nil data is a legacy fixture.
    static func ownsViewportRequests(state: CalendarUiState, viewportData: CalendarViewportData?) -> Bool {
        guard state.view == .month || state.view == .year else { return false }
        return viewportData?.isActive ?? (state.projection != nil)
    }

    static func showsForegroundStatus(state: CalendarUiState, viewportData: CalendarViewportData?,
                                      hasAdjacentData: Bool = false) -> Bool {
        if hasAuthorityError(state) { return true }
        let nativeMonth = state.view == .month || state.view == .year
        if nativeMonth && viewportData?.isActive == true { return false }
        guard nativeMonth || !hasAdjacentData else { return false }
        return state.isOffline || state.freshness == .stale ||
            state.content == .unavailableOffline || state.content == .error
    }

    private static func hasAuthorityError(_ state: CalendarUiState) -> Bool {
        state.error?.kind == .authorization || state.error?.kind == .forbidden
    }

    private var usesMonthViewportStatus: Bool {
        (state.view == .month || state.view == .year) && viewportData?.isActive == true && !Self.hasAuthorityError(state)
    }

    private var statusAnnouncement: String? {
        if Self.hasAuthorityError(state) { return state.error?.userMessage }
        if usesMonthViewportStatus || adjacentData != nil {
            return state.isOffline ? "Calendar is offline" : nil
        }
        return CalendarSurfaceText.stateAnnouncement(state)
    }

    private var effectiveBrowseCursor: CalendarViewportMonth? {
        // A local browse is valid only for the semantic state that produced
        // it. Invalidate in this render, not a later onChange callback. The
        // route-owned cursor remains first choice when one is supplied. A
        // Today command also retires this fallback when the shared date stays
        // equal, so clearing the route cursor cannot resurrect an older browse.
        return browseCursor ?? (browseAnchor == state.anchorDate && browseTodayRevision == todayRevision
                                ? browsedMonth : nil)
    }

    private var filters: some View {
        CalendarFiltersView(
            filters: state.filters,
            facets: state.facets,
            onChange: actions.onFiltersChanged,
            onSearch: actions.onSearch
        )
    }

    private var calendarContent: some View { calendarWorkspace }

    private var calendarWorkspace: some View {
        VStack(spacing: 0) {
            CalendarHeading(
                state: state,
                onToday: actions.onToday,
                onPrevious: actions.onPrevious,
                onNext: actions.onNext,
                browsedMonth: effectiveBrowseCursor,
                browsedDate: dateCursor,
                adjacentProjection: adjacentProjection
            )
            .padding(.horizontal, CalendarSurfaceLayout.contentInset)
            .padding(.vertical, Space.sm)
            .background(DuskColors.bgElev)
            .overlay(alignment: .bottom) {
                Rectangle().fill(DuskColors.lineSoft).frame(height: DesignMetrics.hairline)
            }

            modeContent
                // Extend only the scrolling surface. The overlay above stays
                // in the safe area and reserves no opaque bottom rail.
                .ignoresSafeArea(.container, edges: .bottom)
                .overlay(alignment: .top) {
                    // Overlay the active region, never reserve a blank rail or
                    // guess the Dynamic Type height of the heading above it.
                    if usesMonthViewportStatus || (adjacentData != nil && !Self.hasAuthorityError(state)) {
                        // Per-period availability belongs to the viewport lease,
                        // not the independent foreground window. Offline is a
                        // route condition; do not claim all periods are cached.
                        if state.isOffline {
                            Label("Calendar is offline", systemImage: "wifi.slash")
                                .font(Typo.ui(TypeScale.sm))
                                .foregroundStyle(DuskColors.ink2)
                                .padding(Space.sm)
                                .background(DuskColors.bgElev)
                                .accessibilityIdentifier("calendar-freshness-offline")
                        }
                    } else if Self.showsForegroundStatus(state: state, viewportData: viewportData,
                                                         hasAdjacentData: adjacentData != nil) {
                        CalendarStatusView(state: state, onRetry: actions.onRetry)
                    }
                }
        }
        .accessibilityLabel("Calendar content")
        .accessibilityIdentifier("calendar-scroll-region")
    }

    @ViewBuilder private var modeContent: some View {
        if state.view == .month || state.view == .year {
            CalendarMorphStage(
                state: state,
                onSelectDate: actions.onSelectDate,
                onSelectMonth: actions.onSelectMonth,
                viewportData: viewportData,
                onRequestPeriods: actions.onRequestPeriods,
                onBrowse: { month in
                    browseAnchor = state.anchorDate
                    browseTodayRevision = todayRevision
                    browsedMonth = month
                    actions.onBrowsePeriod(month)
                },
                browsedMonth: effectiveBrowseCursor
            )
            .background(DuskColors.bgSunk)
        } else if let adjacentData,
                  let anchor = dateCursor ?? CalendarViewportDate(date: state.anchorDate) {
            CalendarAdjacentViewport(
                current: .init(view: state.view, anchor: anchor), data: adjacentData,
                locale: state.locale, openerFocus: openerFocus,
                onRequest: actions.onRequestAdjacentPeriods,
                onBrowse: actions.onBrowseDate, onEvent: actions.onEvent,
                onSelectDate: actions.onSelectDateFromBrowse, onRetry: actions.onRetry
            )
        } else {
            CalendarLegacyScrollContent {
                VStack(spacing: Space.sm) {
                    CalendarCanvasView(state: state, onSelectDate: actions.onSelectDate)
                        .frame(height: state.projection == nil ? 0 : nil)
                        .accessibilityHidden(state.projection == nil)
                    if state.projection != nil && !state.loading.isInitial { agenda }
                }
                .padding(.top, state.projection != nil && CalendarSurfaceMapping.showsCompactCanvas(state.view) ? Space.md : 0)
                .padding(.bottom, Space.lg)
                .padding(.horizontal, CalendarSurfaceLayout.contentInset)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private var adjacentProjection: CalendarExperienceProjection? {
        guard let anchor = dateCursor ?? CalendarViewportDate(date: state.anchorDate) else { return nil }
        return adjacentData?.pages[.init(view: state.view, anchor: anchor)]?.projection
    }

    private var agenda: some View {
        CalendarAgendaView(
            sections: CalendarSurfaceMapping.agenda(for: state),
            locale: state.locale,
            emptyMessage: state.content == .empty ? "No events match these filters." : "No events planned.",
            openerFocus: openerFocus,
            onEvent: actions.onEvent
        )
    }
}

/// Scroll geometry is independent from the floating controls' layout. Only
/// their measured occlusion reaches the native owners (never a fixed phone or
/// font-size allowance); no per-frame viewport state is published to SwiftUI.
private struct CalendarBottomOcclusionKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

private struct CalendarTodayRevisionKey: EnvironmentKey {
    static let defaultValue = 0
}

extension EnvironmentValues {
    /// An explicit Today occurrence travels with the current shared target.
    /// It is not a queued date command and cannot replay an older mode/date.
    var calendarTodayRevision: Int {
        get { self[CalendarTodayRevisionKey.self] }
        set { self[CalendarTodayRevisionKey.self] = newValue }
    }

    var calendarBottomOcclusion: CGFloat {
        get { self[CalendarBottomOcclusionKey.self] }
        set { self[CalendarBottomOcclusionKey.self] = newValue }
    }
}

private struct CalendarLegacyScrollContent<Content: View>: View {
    @Environment(\.calendarBottomOcclusion) private var bottomOcclusion
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView { content() }
            .contentMargins(.bottom, bottomOcclusion, for: .scrollContent)
    }
}
