import MobileData
import SwiftUI

/// Authenticated route shell. The session owns CalendarExperience; this route
/// owns only the cancellable SKIE collector and transient presentation focus.
struct CalendarScreen: View {
    let experience: CalendarExperience?
    let onBack: () -> Void

    var body: some View {
        Group {
            if let experience {
                CalendarExperienceScreen(experience: experience, onBack: onBack)
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
        case month(Int32, Int32)
        case view(CalendarView)
    }

    let onBack: () -> Void
    @State private var vm: CalendarViewModel
    @State private var opener: CalendarOverlayOrigin = .addControl
    @State private var pendingNavigation: PendingNavigation?
    @AccessibilityFocusState private var openerFocus: CalendarOverlayOrigin?

    init(experience: CalendarExperience, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _vm = State(initialValue: CalendarViewModel(experience: experience))
    }

    var body: some View {
        Group {
            if let state = vm.state {
                CalendarOverlayContainer(
                    state: state,
                    origin: opener,
                    actions: overlayActions
                ) {
                    CalendarScaffold(
                        state: state,
                        actions: surfaceActions(state),
                        openerFocus: $openerFocus
                    )
                }
                .onChange(of: CalendarOverlaySemantics.isOpen(state)) { wasOpen, isOpen in
                    guard wasOpen, !isOpen, let pendingNavigation else { return }
                    self.pendingNavigation = nil
                    perform(pendingNavigation)
                }
            } else {
                CalendarRouteLoading(onBack: onBack)
            }
        }
        .accessibilityIdentifier("settings-calendar-screen")
        .onDisappear { vm.dispose() }
    }

    private func surfaceActions(_ state: CalendarUiState) -> CalendarSurfaceActions {
        CalendarSurfaceActions(
            onBack: { requestNavigation(.back, state: state) },
            onAdd: {
                opener = .addControl
                vm.add()
            },
            onToday: { requestNavigation(.today, state: state) },
            onPrevious: { requestNavigation(.previous, state: state) },
            onNext: { requestNavigation(.next, state: state) },
            onSelectDate: { requestNavigation(.date($0), state: state) },
            onSelectMonth: { requestNavigation(.month($0, $1), state: state) },
            onSelectView: { requestNavigation(.view($0), state: state) },
            onFiltersChanged: vm.setFilters,
            onSearch: vm.search,
            onEvent: { event in
                guard let occurrence = CalendarScreenMapping.occurrence(for: event, in: state) else { return }
                opener = .event(event.actionIdentity.stableKey)
                vm.openPreview(occurrence)
            },
            onRetry: vm.refresh
        )
    }

    private var overlayActions: CalendarOverlayActions {
        CalendarOverlayActions(
            edit: { vm.edit($0, inputTimeZoneId: vm.state?.locale.timeZoneId) },
            updateDraft: vm.updateDraft,
            chooseScope: vm.chooseMutationScope,
            save: { vm.save($0) },
            requestDelete: vm.requestDelete,
            confirmDelete: vm.confirmDelete,
            rereadConflict: vm.rereadConflict,
            reviewConflict: vm.reviewConflict,
            close: vm.close,
            acknowledgeOutcome: vm.acknowledgeOutcome,
            restoreFocus: { origin in
                Task { @MainActor in
                    await Task.yield()
                    openerFocus = origin
                }
            }
        )
    }

    /// Shared mutation state always closes before a calendar/navigation intent is
    /// forwarded. This keeps covered controls inert and preserves exact ordering.
    private func requestNavigation(_ navigation: PendingNavigation, state: CalendarUiState) {
        switch CalendarScreenMapping.navigationDisposition(for: state) {
        case .dismissOverlayFirst:
            pendingNavigation = navigation
            vm.close()
        case .perform:
            perform(navigation)
        }
    }

    private func perform(_ navigation: PendingNavigation) {
        switch navigation {
        case .back: onBack()
        case .today: vm.today()
        case .previous: vm.previous()
        case .next: vm.next()
        case .date(let date): vm.selectDate(date)
        case .month(let year, let month): vm.selectMonth(year: year, month: month)
        case .view(let view): vm.selectView(view)
        }
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
        state.occurrences.first {
            $0.eventId == event.eventId &&
                $0.occurrenceId == event.occurrenceId &&
                $0.originalStart == event.originalStart &&
                $0.scope == event.scope
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
    }
}

#Preview {
    Text("Calendar requires a session CalendarExperience")
}
