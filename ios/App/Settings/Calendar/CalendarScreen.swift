import MobileData
import SwiftUI

/// Keeps an already-mounted Calendar destination reactive while the protected
/// Application Support database finishes opening in the authenticated session.
struct CalendarSessionRoute: View {
    @ObservedObject var userSession: UserSession
    let onBack: () -> Void

    @ViewBuilder
    var body: some View {
        if let experience = userSession.calendarExperience {
            CalendarScreen(experience: experience, onBack: onBack)
        } else if userSession.calendarAvailability.unavailableReason == .initializing {
            CalendarInitializingScreen(onBack: onBack)
        } else {
            CalendarScreen(experience: nil, onBack: onBack)
        }
    }
}

private struct CalendarInitializingScreen: View {
    let onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            DesignPageHeader(title: "Calendar", backAccessibilityId: "calendar-back", onBack: onBack)
            DesignProgress(title: "Opening calendar…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .accessibilityIdentifier("calendar-initializing")
        .background(DuskColors.bg)
        .duskTheme()
        .toolbar(.hidden, for: .navigationBar)
        .nativeInteractiveBackNavigation()
    }
}

/// Authenticated route shell. The session owns CalendarExperience; this route
/// owns only the cancellable SKIE collector and transient presentation focus.
struct CalendarScreen: View {
    let experience: CalendarExperience?
    let onBack: () -> Void

    var body: some View {
        Group {
            if let experience {
                CalendarExperienceScreen(experience: experience, onBack: onBack)
                    .id(ObjectIdentifier(experience))
            } else {
                CalendarUnavailableScreen(onBack: onBack)
            }
        }
        // CalendarScaffold supplies reference-faithful chrome while remaining a
        // normal NavigationStack destination.
        .toolbar(.hidden, for: .navigationBar)
    }
}

private struct CalendarExperienceScreen: View {
    private enum PendingNavigation: Equatable {
        case back
        case today
        case previous
        case next
        case date(String)
        case weekDate(CalendarViewportDate, String)
        case month(Int32, Int32)
        case view(CalendarView)
    }

    let onBack: () -> Void
    @State private var vm: CalendarViewModel
    @State private var opener: CalendarOverlayOrigin = .addControl
    @State private var pendingNavigation: PendingNavigation?
    @State private var todayRevision = 0
    @State private var overlayPresentation = CalendarOverlayPresentation()
    @AccessibilityFocusState private var openerFocus: CalendarOverlayOrigin?

    init(experience: CalendarExperience, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _vm = State(initialValue: CalendarViewModel(experience: experience))
    }

    var body: some View {
        ZStack {
            if let state = vm.state {
                CalendarOverlayContainer(
                    state: state,
                    origin: opener,
                    actions: overlayActions,
                    presentation: $overlayPresentation,
                    onClosed: completePendingNavigation
                ) {
                    CalendarScaffold(
                        state: state,
                        actions: surfaceActions,
                        openerFocus: $openerFocus,
                        viewportData: vm.viewportData,
                        browseCursor: vm.browsedMonth,
                        adjacentData: vm.adjacentData,
                        dateCursor: vm.browsedDate,
                        todayRevision: todayRevision
                    )
                }
                .onChange(of: pendingNavigation) { _, _ in
                    // If open/close was coalesced before presentation, there is
                    // no native sheet (and therefore no onDismiss) to await.
                    completePendingNavigation()
                }
            } else {
                CalendarRouteLoading(onBack: onBack)
            }
            // Keep the route-level checkpoint distinct from CalendarScaffold's
            // `calendar-surface`; applying an identifier to the outer Group
            // causes SwiftUI to overwrite the descendant surface identifier.
            Color.clear
                .frame(width: CalendarSurfaceLayout.accessibilitySentinelSize,
                       height: CalendarSurfaceLayout.accessibilitySentinelSize)
                .accessibilityElement()
                .accessibilityIdentifier("settings-calendar-screen")
                .allowsHitTesting(false)
        }
        // A native pop must never bypass the shared overlay/close ordering.
        // Presented UIKit sheets are additionally guarded by the navigation adapter.
        .nativeInteractiveBackNavigation(
            isEnabled: pendingNavigation == nil && !overlayPresentation.nativePresented &&
                vm.state.map { CalendarScreenMapping.navigationDisposition(for: $0) == .perform } != false
        )
        .task {
            forwardDeviceProjectionContext()
        }
        .onChange(of: vm.state?.presentationReady) { _, ready in
            if ready == true { forwardDeviceProjectionContext() }
        }
        .task {
            for await _ in NotificationCenter.default.notifications(named: NSLocale.currentLocaleDidChangeNotification) {
                guard !Task.isCancelled else { return }
                forwardDeviceProjectionContext()
            }
        }
        .task {
            for await _ in NotificationCenter.default.notifications(named: Notification.Name.NSSystemTimeZoneDidChange) {
                guard !Task.isCancelled else { return }
                forwardDeviceProjectionContext()
            }
        }
        .onAppear { vm.resume() }
        .onDisappear { vm.dispose() }
    }

    private func forwardDeviceProjectionContext() {
        // Do not let initial native defaults overwrite persisted view/date/filter
        // values before the shared cache projection has restored them.
        guard vm.state?.presentationReady == true else { return }
        vm.setLocale(CalendarDeviceProjectionContext.current())
    }

    private var surfaceActions: CalendarSurfaceActions {
        CalendarSurfaceActions(
            onBack: { requestNavigation(.back) },
            onAdd: {
                opener = .addControl
                vm.add()
            },
            onToday: { requestNavigation(.today) },
            onPrevious: { requestNavigation(.previous) },
            onNext: { requestNavigation(.next) },
            onSelectDate: { requestNavigation(.date($0)) },
            onSelectMonth: { requestNavigation(.month($0, $1)) },
            onSelectView: { requestNavigation(.view($0)) },
            onFiltersChanged: vm.setFilters,
            onSearch: vm.search,
            onEvent: { event in
                guard let occurrence = vm.currentOccurrence(for: event.actionIdentity) else { return }
                opener = .event(event.actionIdentity.stableKey)
                vm.openPreview(occurrence)
            },
            onRetry: vm.refresh,
            onRequestPeriods: vm.requestViewport,
            onBrowsePeriod: vm.browse,
            onRequestAdjacentPeriods: vm.requestAdjacentViewport,
            onBrowseDate: vm.browse,
            onSelectDateFromBrowse: { requestNavigation(.weekDate($0, $1)) }
        )
    }

    private var overlayActions: CalendarOverlayActions {
        CalendarOverlayActions(
            edit: { occurrence in
                let identity = CalendarEventActionIdentity(
                    eventId: occurrence.eventId, occurrenceId: occurrence.occurrenceId,
                    originalStart: occurrence.originalStart, scope: occurrence.scope
                )
                guard let current = vm.currentOccurrence(for: identity) else { return }
                vm.edit(current)
            },
            updateDraft: vm.updateDraft,
            chooseScope: vm.chooseMutationScope,
            save: { vm.save($0) },
            requestDelete: vm.requestDelete,
            confirmDelete: vm.confirmDelete,
            rereadConflict: vm.rereadConflict,
            reviewConflict: vm.reviewConflict,
            close: requestOverlayClose,
            acknowledgeOutcome: vm.acknowledgeOutcome,
            restoreFocus: { origin in openerFocus = origin }
        )
    }

    private func requestOverlayClose() {
        guard let state = vm.state,
              overlayPresentation.requestClose(sharedOpen: CalendarOverlaySemantics.isOpen(state)) else { return }
        vm.close()
    }

    private func completePendingNavigation() {
        guard let state = vm.state,
              !overlayPresentation.isCovered(sharedOpen: CalendarOverlaySemantics.isOpen(state)),
              let pendingNavigation else { return }
        _ = overlayPresentation.finishClose(sharedOpen: false)
        self.pendingNavigation = nil
        perform(pendingNavigation)
    }

    /// Both shared closure and native dismissal must finish before navigation.
    private func requestNavigation(_ navigation: PendingNavigation) {
        guard pendingNavigation == nil, let state = vm.state else { return }
        switch CalendarScreenMapping.navigationDisposition(for: state) {
        case .dismissOverlayFirst:
            pendingNavigation = navigation
            requestOverlayClose()
        case .perform:
            if overlayPresentation.nativePresented {
                pendingNavigation = navigation
            } else {
                perform(navigation)
            }
        }
    }

    private func perform(_ navigation: PendingNavigation) {
        switch navigation {
        case .back: onBack()
        case .today:
            vm.today()
            // Explicit presentation command, issued only after native/shared
            // overlay closure. Shared Today may leave every date unchanged.
            todayRevision += 1
        case .previous: vm.previous()
        case .next: vm.next()
        case .date(let date): vm.selectDate(date)
        case .weekDate(let cursor, let date): vm.selectDate(from: cursor, date: date)
        case .month(let year, let month): vm.selectMonth(year: year, month: month)
        case .view(let view): vm.selectView(view)
        }
    }
}

/// Device settings are projection context only. They are never copied into an
/// event draft's persisted IANA time-zone field.
enum CalendarDeviceProjectionContext {
    static func current(
        locale: Locale = .current,
        calendar: Calendar = .current,
        timeZone: TimeZone = .current
    ) -> CalendarLocale {
        let languageTag = locale.identifier
            .split(separator: "@", maxSplits: 1)
            .first
            .map(String.init)?
            .replacingOccurrences(of: "_", with: "-") ?? "en-US"
        let weekStart: Weekday? = switch calendar.firstWeekday {
        case 1: .sunday
        case 2: .monday
        case 3: .tuesday
        case 4: .wednesday
        case 5: .thursday
        case 6: .friday
        case 7: .saturday
        default: nil
        }
        let hourPattern = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: locale) ?? ""
        let hourCycle: CalendarHourCycle = hourPattern.contains("a") ? .hour12 : .hour24
        return CalendarLocale(
            languageTag: languageTag,
            timeZoneId: timeZone.identifier,
            weekStart: weekStart,
            hourCycle: hourCycle
        )
    }
}

/// Content-free route mapping keeps projected rows tied to the exact authorized
/// occurrence object required by shared preview/edit mutation intents.
enum CalendarScreenMapping {
    enum NavigationDisposition: Equatable { case perform, dismissOverlayFirst }

    static func navigationDisposition(for state: CalendarUiState) -> NavigationDisposition {
        CalendarOverlaySemantics.isOpen(state) ? .dismissOverlayFirst : .perform
    }

    static func occurrence(for event: CalendarProjectedEvent, in state: CalendarUiState) -> EffectiveOccurrence? {
        occurrence(for: event.actionIdentity, in: state)
    }

    static func occurrence(for identity: CalendarEventActionIdentity, in state: CalendarUiState) -> EffectiveOccurrence? {
        guard state.visibleEvents.contains(where: {
            $0.actionIdentity.eventId == identity.eventId &&
                $0.actionIdentity.occurrenceId == identity.occurrenceId &&
                $0.actionIdentity.originalStart == identity.originalStart &&
                $0.actionIdentity.scope == identity.scope
        }) else { return nil }
        return state.occurrences.first {
            $0.eventId == identity.eventId &&
                $0.occurrenceId == identity.occurrenceId &&
                $0.originalStart == identity.originalStart &&
                $0.scope == identity.scope
        }
    }
}

private struct CalendarRouteLoading: View {
    let onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            CalendarTopBar(
                canAdd: false,
                openerFocus: nil,
                onBack: onBack,
                onAdd: {}
            )
            SoulLoadingRow()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(DuskColors.bg)
        .accessibilityIdentifier("calendar-loading")
        .duskTheme()
    }
}

private struct CalendarUnavailableScreen: View {
    let onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            CalendarTopBar(
                canAdd: false,
                openerFocus: nil,
                onBack: onBack,
                onAdd: {}
            )
            SoulInlineError(message: "Calendar is unavailable.")
                .padding(Space.lg)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .accessibilityIdentifier("calendar-unavailable")
        }
        .background(DuskColors.bg)
        .accessibilityIdentifier("settings-calendar-screen")
        .duskTheme()
        .nativeInteractiveBackNavigation()
    }
}

#Preview {
    Text("Calendar requires a session CalendarExperience")
}
