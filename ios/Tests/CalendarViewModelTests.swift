import Foundation
import MobileData
import SwiftUI
import Testing
import UIKit
@testable import SentientApp

@MainActor
struct CalendarViewModelTests {
    @Test func completeCalendarExperienceStateIteratesThroughSkie() async {
        var views: [CalendarView] = []
        for await state in calendarExperienceBridgeProbe() {
            views.append(state.view)
            #expect(state.projection != nil)
            #expect(state.visibleInterval != nil)
            #expect(state.selectedInterval != nil)
            #expect(!state.authorizedOccurrences.isEmpty)
            #expect(!state.facets.groups.isEmpty)
            #expect(state.cachedWindow != nil)
            #expect(state.persistedCachePreferences != nil)
            #expect(state.error?.kind == .connection)
            #expect(state.mutation.preview != nil)
            #expect(state.mutation.editor?.draft.eventId == "bridge-event")
            #expect(state.mutation.deleteConfirmation != nil)
            #expect(state.mutation.conflict?.draft.originalStart == "2026-08-17T09:00:00-07:00")
            #expect(state.mutation.outcome != nil)
            #expect(state.mutation.error?.kind == .conflict)
        }
        #expect(views == [.day, .week, .month, .year])
    }

    @Test func mapsCompleteSharedStateWithoutReconstructingProjection() async {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        let shared = makeState(view: .month, freshness: .cachedOffline, offline: .offline)

        await source.waitUntilStarted()
        source.emit(shared)
        await source.waitForEmissions(1)

        #expect(vm.state?.anchorDate == "2026-08-01")
        #expect(vm.state?.projection === shared.projection)
        #expect(vm.state?.facets === shared.facets)
        #expect(vm.state?.occurrences.first === shared.authorizedOccurrences.first)
        #expect(vm.state?.isOffline == true)
        #expect(vm.state?.freshness == .cachedOffline)
        #expect(vm.state?.month != nil)
        #expect(vm.state?.day == nil)
    }

    @Test func allSharedViewsAndSelectedDateRetentionAreRepresentable() {
        for view in CalendarView.allCases {
            let mapped = CalendarUiState(makeState(view: view))
            #expect(mapped.view == view)
            #expect(mapped.selectedDate == "2026-08-17")
            switch view {
            case .day: #expect(mapped.day != nil)
            case .week: #expect(mapped.week != nil)
            case .month: #expect(mapped.month != nil)
            case .year: #expect(mapped.year != nil)
            }
        }
    }

    @Test func calendarOpenActivatesBeforeCollectionAndMapsCacheThenRevalidation() async {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        let cached = makeState(freshness: .stale, loading: .idle)
        let refreshing = makeState(freshness: .refreshing, loading: .refreshing)
        let fresh = makeState(freshness: .fresh, loading: .idle)

        await source.waitUntilStarted()
        #expect(source.activationCount == 1)
        #expect(source.lifecycleEvents == ["activate", "collect"])

        source.emit(cached)
        await source.waitForEmissions(1)
        #expect(vm.state?.freshness == .stale)
        #expect(vm.state?.content == .content)

        source.emit(refreshing)
        await source.waitForEmissions(2)
        #expect(vm.state?.isRefreshing == true)
        #expect(vm.state?.content == .content)

        source.emit(fresh)
        await source.waitForEmissions(3)
        #expect(vm.state?.freshness == .fresh)
        #expect(vm.state?.isRefreshing == false)
        #expect(vm.state?.projection != nil)
    }

    @Test func routeRecreationCoalescesSessionActivationAndDisposalCancelsOnlyOwnedCollector() async {
        let source = RouteRecreationSourceSpy()
        let first = CalendarViewModel(source: source)
        first.resume()
        let second = CalendarViewModel(source: source)
        second.resume()

        await source.waitForCollectors(2)
        #expect(source.activationCalls == 2)
        #expect(source.activationWorkStarts == 1)
        #expect(source.sessionWorkActive)

        source.emit(makeState(view: .month))
        await source.waitForDeliveries(2)
        #expect(first.state?.view == .month)
        #expect(second.state?.view == .month)

        first.dispose()
        await source.waitForCancellations(1)
        #expect(source.activeCollectorCount == 1)
        #expect(source.sessionWorkActive)

        source.emit(makeState(view: .year))
        await source.waitForDeliveries(3)
        #expect(first.state == nil)
        #expect(second.state?.view == .year)
        #expect(source.activationWorkStarts == 1)

        second.dispose()
        await source.waitForCancellations(2)
        #expect(source.activeCollectorCount == 0)
        #expect(source.sessionWorkActive)
    }

    @Test func forwardsNavigationFilterAndRefreshIntentsExactly() async {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        let filters = makeFilters(text: "school")
        let locale = makeLocale()

        vm.today()
        vm.previous()
        vm.next()
        vm.selectDate("2026-09-03")
        vm.selectMonth(year: 2027, month: 2)
        vm.selectView(.week)
        vm.setFilters(filters)
        vm.setLocale(locale)
        vm.refresh()

        #expect(source.intents.count == 9)
        expectNavigate(source.intents[0], CalendarNavigationActionToday.self)
        expectNavigate(source.intents[1], CalendarNavigationActionPrevious.self)
        expectNavigate(source.intents[2], CalendarNavigationActionNext.self)
        if case .navigate(let value) = onEnum(of: source.intents[3]),
           case .selectDate(let action) = onEnum(of: value.action) {
            #expect(action.date == "2026-09-03")
        } else { Issue.record("select-date intent changed") }
        if case .navigate(let value) = onEnum(of: source.intents[4]),
           case .selectMonth(let action) = onEnum(of: value.action) {
            #expect(action.year == 2027)
            #expect(action.month == 2)
        } else { Issue.record("select-month intent changed") }
        if case .navigate(let value) = onEnum(of: source.intents[6]),
           case .setFilters(let action) = onEnum(of: value.action) {
            #expect(action.filters === filters)
        } else { Issue.record("filter identity changed") }
        if case .setLocale(let value) = onEnum(of: source.intents[7]) {
            #expect(value.locale === locale)
        } else { Issue.record("locale identity changed") }
        if case .refresh = onEnum(of: source.intents[8]) {} else {
            Issue.record("refresh intent changed")
        }
    }

    @Test func searchForwardsAFilterCopyWithoutChangingOtherFacets() async {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        await source.waitUntilStarted()
        source.emit(makeState())
        await source.waitForEmissions(1)

        vm.search("pickup")

        guard case .navigate(let value) = onEnum(of: source.intents[0]),
              case .setFilters(let action) = onEnum(of: value.action) else {
            Issue.record("search was not forwarded as SetFilters")
            return
        }
        #expect(action.filters.text == "pickup")
        #expect(action.filters.scope == .all)
        #expect(action.filters.groups == Set(["family"]))
        #expect(action.filters.tags == Set(["school"]))
        #expect(action.filters.importance == .important)
    }

    @Test func forwardsMutationIdentityScopeConflictAndAcknowledgementExactly() {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        let occurrence = makeOccurrence()
        let draft = makeDraft()

        vm.openPreview(occurrence)
        vm.openEditor(occurrence: occurrence, draft: draft)
        vm.add(draft)
        vm.edit(occurrence, inputTimeZoneId: "America/Los_Angeles")
        vm.updateDraft(draft)
        vm.chooseMutationScope(.thisAndFollowing)
        vm.save(draft)
        vm.requestDelete()
        vm.confirmDelete(scope: .thisOccurrence)
        vm.rereadConflict()
        vm.reviewConflict(draft)
        vm.close()
        vm.acknowledgeOutcome()

        #expect(source.intents.count == 13)
        if case .openPreview(let value) = onEnum(of: source.intents[0]) {
            #expect(value.occurrence === occurrence)
            #expect(value.occurrence.originalStart == "2026-08-17T09:00:00-07:00")
        } else { Issue.record("preview identity changed") }
        if case .openEditor(let value) = onEnum(of: source.intents[1]) {
            #expect(value.occurrence === occurrence)
            #expect(value.draft === draft)
        } else { Issue.record("editor identity changed") }
        if case .createDraft(let value) = onEnum(of: source.intents[2]) {
            #expect(value.draft === draft)
        } else { Issue.record("create draft identity changed") }
        if case .editOccurrence(let value) = onEnum(of: source.intents[3]) {
            #expect(value.occurrence === occurrence)
            #expect(value.inputTimeZoneId == "America/Los_Angeles")
        } else { Issue.record("edit identity changed") }
        if case .updateDraft(let value) = onEnum(of: source.intents[4]) {
            #expect(value.draft === draft)
            #expect(value.draft.eventId == "event-42")
            #expect(value.draft.occurrenceId == "occurrence-42")
            #expect(value.draft.expectedRevision == 7)
        } else { Issue.record("draft identity changed") }
        if case .chooseMutationScope(let value) = onEnum(of: source.intents[5]) {
            #expect(value.scope == .thisAndFollowing)
        } else { Issue.record("mutation scope changed") }
        if case .submit(let value) = onEnum(of: source.intents[6]) {
            #expect(value.draft === draft)
        } else { Issue.record("submit draft identity changed") }
        if case .confirmDelete(let value) = onEnum(of: source.intents[8]) {
            #expect(value.scope == .thisOccurrence)
        } else { Issue.record("delete scope changed") }
        if case .reviewConflict(let value) = onEnum(of: source.intents[10]) {
            #expect(value.draft === draft)
        } else { Issue.record("conflict draft changed") }
        if case .cancel = onEnum(of: source.intents[11]) {} else { Issue.record("close changed") }
        if case .acknowledgeOutcome = onEnum(of: source.intents[12]) {} else { Issue.record("ack changed") }
    }

    @Test func disposalCancelsCollectionAndRejectsStaleEmissions() async {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        await source.waitUntilStarted()
        source.emit(makeState(view: .month))
        await source.waitForEmissions(1)
        #expect(vm.state?.view == .month)

        vm.dispose()
        await source.waitUntilCancelled()
        #expect(source.collectionCancelled)
        source.emit(makeState(view: .year))
        #expect(vm.state == nil)
    }

    @Test func viewportRequestsAreBoundedAndDoNotNavigate() async {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        await source.waitForCollections(1)
        source.semanticReceivers[0](makeState())
        let projection = vm.state?.projection
        let periods = [MobileData.CalendarViewportPeriod(view: .month, anchorDate: "2026-09-01")]

        #expect(vm.setViewportPeriods(periods) == .accepted)
        #expect(source.requests.count == 1)
        #expect(source.requests[0].first === periods.first)
        #expect(vm.state?.anchorDate == "2026-08-01")
        #expect(vm.state?.projection === projection)
        #expect(source.intents.isEmpty)
        #expect(vm.setViewportPeriods(Array(repeating: periods[0], count: vm.maximumViewportPeriods + 1)) == .tooManyPeriods)
        #expect(source.requests.count == 1)
        #expect(vm.setViewportPeriods([]) == .accepted)
        #expect(source.requests.last?.isEmpty == true)
    }

    @Test func viewportReadsCurrentAuthorityInsteadOfQueuedPreClearPayloads() async {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        await source.waitForCollections(1)
        let authorized = makeViewportState()
        source.authority.state = authorized
        source.viewportReceivers[0](authorized)
        #expect(vm.viewportState === authorized)

        // Shared auth/namespace/forbidden retirement clears synchronously, before
        // SKIE necessarily delivers that clear. Even an older callback is harmless.
        let cleared = CalendarViewportState(periods: [:])
        source.authority.state = cleared
        source.leaseValid = false
        #expect(!vm.isViewportLeaseActive)
        #expect(vm.viewportState == nil)
        source.viewportReceivers[0](authorized)
        #expect(vm.viewportState == nil)
    }

    @Test func viewportDisposalResumeAndLateCallbacksRespectRouteGeneration() async {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        await source.waitForCollections(1)
        source.authority.state = makeViewportState()
        let lateViewport = source.viewportReceivers[0]
        let lateSemantic = source.semanticReceivers[0]
        vm.resume()
        #expect(source.activations == 1)
        vm.dispose()
        vm.dispose()
        #expect(source.releases == 1)
        await source.waitForCancellations(2)
        #expect(vm.viewportState == nil)
        #expect(!vm.isViewportLeaseActive)
        #expect(!vm.viewportData.isActive)
        #expect(vm.setViewportPeriods([]) == .retired)
        lateViewport(makeViewportState())
        #expect(vm.viewportState == nil)

        vm.resume()
        vm.resume()
        await source.waitForCollections(2)
        #expect(source.activations == 2)
        source.semanticReceivers[1](makeState(view: .week))
        let current = makeViewportState()
        source.authority.state = current
        source.viewportReceivers[1](current)
        lateSemantic(makeState(view: .year))
        lateViewport(CalendarViewportState(periods: [:]))
        #expect(vm.state?.view == .week)
        #expect(vm.viewportState === current)
        #expect(vm.setViewportPeriods([]) == .accepted)
        vm.dispose()
        #expect(source.releases == 2)
    }

    @Test func predecessorDisposalDoesNotReleaseSuccessorViewport() async {
        let authority = ViewportSourceSpy.Authority()
        let oldSource = ViewportSourceSpy(authority: authority)
        let first = CalendarViewModel(source: oldSource)
        first.resume()
        await oldSource.waitForCollections(1)
        let newSource = ViewportSourceSpy(authority: authority)
        let second = CalendarViewModel(source: newSource)
        second.resume()
        defer { second.dispose() }
        await newSource.waitForCollections(1)
        let current = makeViewportState()
        authority.state = current
        newSource.viewportReceivers[0](current)
        first.dispose()
        oldSource.viewportReceivers[0](CalendarViewportState(periods: [:]))
        #expect(first.viewportState == nil)
        #expect(second.viewportState === current)
        #expect(newSource.releases == 0)
        #expect(second.setViewportPeriods([MobileData.CalendarViewportPeriod(view: .day, anchorDate: "2026-08-17")]) == .accepted)
        #expect(newSource.requests.count == 1)
    }

    @Test func viewportRejectionsAreRecoverableAndPreserveTheAcceptedRequest() {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        let month = CalendarViewportMonth(year: 2026, month: 9)
        vm.requestViewport(.init(months: [month]))
        #expect(vm.viewportRequestResult == .accepted)
        #expect(source.requests.last?.first?.view == .month)
        #expect(source.requests.last?.first?.anchorDate == "2026-09-01")

        for (period, outcome) in [
            (MobileData.CalendarViewportPeriod(view: .month, anchorDate: "not-a-date"), CalendarViewportRequestResult.invalidDate),
            (MobileData.CalendarViewportPeriod(view: .year, anchorDate: "2026-01-01"), .unsupportedView)
        ] {
            source.requestOutcome = outcome
            #expect(vm.setViewportPeriods([period]) == outcome)
            #expect(vm.viewportRequestResult == outcome)
            #expect(source.attemptedRequests.last?.first === period)
            #expect(source.requests.count == 1)
        }
        source.requestOutcome = .accepted
        vm.requestViewport(.init(months: []))
        #expect(vm.viewportRequestResult == .accepted)
        #expect(source.requests.last?.isEmpty == true)
        source.authority.owner = nil
        #expect(vm.setViewportPeriods([]) == .retired)
        #expect(vm.viewportRequestResult == .retired)
    }

    @Test func browseIsLocalAndExplicitCommandsUseOneAtomicBrowseBasis() {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        let cursor = CalendarViewportMonth(year: 2032, month: 2)
        vm.browse(cursor)
        #expect(source.intents.isEmpty)
        #expect(source.requests.isEmpty)
        #expect(source.viewportNavigations.isEmpty)
        vm.dispose()
        vm.resume()
        #expect(vm.browsedMonth == cursor)

        source.navigationOutcome = .invalidDate
        vm.previous()
        #expect(vm.viewportNavigationResult == .invalidDate)
        #expect(vm.browsedMonth == cursor)
        #expect(source.intents.isEmpty)
        source.navigationOutcome = .accepted
        vm.previous()
        #expect(vm.browsedMonth == nil)
        vm.browse(cursor)
        vm.next()
        vm.browse(cursor)
        vm.selectView(.year)
        #expect(source.viewportNavigations.map { $0.0 } == Array(repeating: "2032-02-01", count: 4))
        #expect(source.viewportNavigations[1].1 is CalendarNavigationActionPrevious)
        #expect(source.viewportNavigations[2].1 is CalendarNavigationActionNext)
        #expect((source.viewportNavigations[3].1 as? CalendarNavigationActionSelectView)?.view == .year)
        #expect(source.intents.isEmpty) // No intermediate SelectDate/SelectMonth.

        vm.browse(cursor)
        vm.today()
        #expect(vm.browsedMonth == nil)
        vm.browse(cursor)
        vm.selectDate("2026-09-05")
        #expect(vm.browsedMonth == nil)
        vm.browse(cursor)
        vm.selectMonth(year: 2027, month: 4)
        #expect(vm.browsedMonth == nil)
        #expect(source.intents.count == 3)
        #expect(source.viewportNavigations.count == 4)
    }

    @Test func todayWithUnchangedSharedDatesReturnsTheMountedScaffoldFromBrowse() async throws {
        let source = ViewportSourceSpy()
        let today = "2026-09-07"
        let shared = makeState(anchorDate: today, selectedDate: today, todayDate: today)
        source.currentExperienceState = shared
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        await source.waitForCollections(1)
        var requests: [CalendarViewportRequest] = []
        let host = UIHostingController(rootView: TodayScaffoldFixture(vm: vm, onRequest: { requests.append($0) }))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        // Flush the hosted render and its existing bounded native request
        // task, matching mounted CalendarSurfaceTests (no timer or polling).
        func render() async {
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            await Task.yield()
            host.view.layoutIfNeeded()
        }
        await render()
        let controller = try #require(calendarController(in: host))
        let collection = try #require(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
        let layout = try #require(collection.collectionViewLayout as? CalendarNativeViewportLayout)
        let october = CalendarViewportMonth(year: 2026, month: 10)
        let september = CalendarViewportMonth(year: 2026, month: 9)

        controller.scrollViewWillBeginDragging(collection)
        collection.contentOffset.y = layout.frame(october.index, progress: 1).minY + 20
        controller.scrollViewDidScroll(collection)
        controller.scrollViewDidEndDragging(collection, willDecelerate: false)
        await render()
        #expect(vm.browsedMonth == october)
        #expect(vm.state?.anchorDate == today)
        let browsedOffset = collection.contentOffset.y
        source.semanticReceivers[0](shared) // An ordinary observation must not navigate.
        await render()
        #expect(collection.contentOffset.y == browsedOffset)

        // Same shared instance/date/selection, just like a conflated Today
        // reducer result. The explicit command must still reach native layout.
        vm.today()
        host.rootView.todayRevision += 1 // Route's accepted Today command, not an observation revision.
        await render()
        collection.layoutIfNeeded()
        #expect(vm.browsedDate == nil)
        #expect(vm.state?.projection === shared.projection)
        #expect(requests.last?.months.contains(september) == true)
        #expect(layout.leadingVisibleMonth(in: collection.bounds) == september)
        let path = IndexPath(item: september.index, section: 0)
        let cell = try #require(collection.cellForItem(at: path) as? CalendarReusableMonthCell)
        let control = try #require(cell.contentView.subviews.first as? UIControl)
        let date = try #require((control.accessibilityElements as? [UIAccessibilityElement])?.first {
            $0.accessibilityIdentifier == "calendar-date-\(today)"
        })
        let dateFrame = control.convert(date.accessibilityFrameInContainerSpace, to: collection)
        #expect(collection.bounds.contains(dateFrame))
        #expect(date.accessibilityTraits.contains(.selected))
        #expect(date.accessibilityLabel?.contains("Today") == true)
        expectNavigate(try #require(source.intents.last), CalendarNavigationActionToday.self)

        // The Scaffold's previous local October fallback must not reappear
        // when the cleared route cursor is used by the next Month↔Year trip.
        source.currentExperienceState = makeState(view: .year, anchorDate: today, selectedDate: today, todayDate: today)
        source.semanticReceivers[0](try #require(source.currentExperienceState))
        await render()
        #expect(layout.progress == 0)
        source.currentExperienceState = shared
        source.semanticReceivers[0](shared)
        await render()
        #expect(layout.progress == 1)
        #expect(layout.leadingVisibleMonth(in: collection.bounds) == september)
        #expect(vm.browsedDate == nil)
        #expect(source.intents.count == 1)
    }

    private func calendarController(in owner: UIViewController) -> CalendarViewportController? {
        if let controller = owner as? CalendarViewportController { return controller }
        return owner.children.compactMap { calendarController(in: $0) }.first
    }

    @Test func nativeMonthAndYearDataReplaceWholeSharedMapsAndFailClosed() async {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        await source.waitForCollections(1)
        source.semanticReceivers[0](makeState(view: .year))
        let august = CalendarViewportMonth(year: 2026, month: 8)
        let september = CalendarViewportMonth(year: 2026, month: 9)
        let first = makeState().projection!
        let second = makeState(anchorDate: "2026-09-01").projection!
        source.authority.state = CalendarViewportState(periods: [
            MobileData.CalendarViewportPeriod(view: .month, anchorDate: august.date): makeViewportEntry(first),
            MobileData.CalendarViewportPeriod(view: .month, anchorDate: september.date): makeViewportEntry(second)
        ])
        source.viewportReceivers[0](source.authority.state)
        let data = vm.viewportData
        #expect(data.months.count == 2)
        #expect(data.months[august]?.cells.count == 42)
        #expect(data.months[august]?.cells.first === first.month?.cells.first)
        #expect(data.months[september]?.cells.first === second.month?.cells.first)
        #expect(data.months[september]?.availability == .ready)
        #expect(vm.viewportData.revision == data.revision)

        source.authority.state = CalendarViewportState(periods: [
            MobileData.CalendarViewportPeriod(view: .month, anchorDate: september.date): makeViewportEntry(nil)
        ])
        // Reading current authority must replace before the queued callback too.
        let replacement = vm.viewportData
        #expect(replacement.revision > data.revision)
        #expect(replacement.months[august] == nil)
        #expect(replacement.months[september]?.cells.isEmpty == true)
        #expect(replacement.months[september]?.availability == .unavailable)

        source.authority.state = makeViewportState()
        source.currentExperienceState = makeState(loading: .loading, hasProjection: false)
        #expect(vm.viewportData.isActive)
        #expect(vm.viewportData.months[august]?.availability == .ready)
        #expect(vm.viewportData.generation == data.generation)
        source.leaseValid = false // Retirement, not foreground absence, removes authority.
        source.currentExperienceState = makeState()
        #expect(vm.viewportData.months.isEmpty)
        #expect(!vm.viewportData.isActive)
        source.viewportReceivers[0](makeViewportState())
        #expect(vm.viewportData.months.isEmpty)
        vm.dispose()
        #expect(vm.viewportData.months.isEmpty)
        #expect(vm.viewportData.generation != data.generation)
    }

    @Test func mismatchedLocaleAndFiltersNeverReuseOldCells() async {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        await source.waitForCollections(1)
        let month = CalendarViewportMonth(year: 2026, month: 8)
        let original = makeState()
        source.semanticReceivers[0](original)
        source.authority.state = makeViewportState()
        let originalData = vm.viewportData
        let contexts = [
            makeState(filters: makeFilters(text: "private-filter-value")),
            makeState(locale: CalendarLocale(languageTag: "en-GB", timeZoneId: "UTC", weekStart: .sunday, hourCycle: .hour24)),
            makeState(locale: CalendarLocale(languageTag: "en-US", timeZoneId: "UTC", weekStart: .monday, hourCycle: .hour12)),
            makeState(locale: CalendarLocale(languageTag: "en-US", timeZoneId: "America/Los_Angeles", weekStart: .sunday, hourCycle: .hour12))
        ]
        var revision = originalData.revision
        for current in contexts {
            source.currentExperienceState = current
            source.authority.state = makeViewportState(projection: current.projection)
            // Both foreground and viewport read current source context before delivery.
            #expect(vm.state?.projection === current.projection)
            #expect(vm.viewportData.months[month]?.availability == .ready)
            source.semanticReceivers[0](current)
            source.authority.state = makeViewportState() // Old-context projection.
            let unknown = vm.viewportData
            #expect(unknown.months[month]?.cells.isEmpty == true)
            #expect(unknown.months[month]?.availability == .loading)
            #expect(unknown.revision > revision)
            #expect(unknown.generation != originalData.generation)
            #expect(!unknown.generation.contains("private-filter-value"))
            source.authority.state = makeViewportState(projection: current.projection)
            let ready = vm.viewportData
            #expect(ready.months[month]?.availability == .ready)
            #expect(ready.months[month]?.cells.first === current.projection?.month?.cells.first)
            #expect(ready.generation == unknown.generation)
            #expect(ready.revision > unknown.revision)
            revision = ready.revision
        }
    }

    @Test func selectionAndTodayRepaintWithoutDiscardingCurrentViewportMarks() async {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        await source.waitForCollections(1)
        source.currentExperienceState = makeState(view: .year)
        let published = makeViewportState()
        source.authority.state = published
        let month = CalendarViewportMonth(year: 2026, month: 8)
        let original = vm.viewportData
        #expect(original.months[month]?.availability == .ready)

        for current in [makeState(selectedDate: "2026-08-18"), makeState(todayDate: "2026-08-19")] {
            // Foreground paint advances before the independent viewport reprojects.
            source.currentExperienceState = current
            source.semanticReceivers[0](current)
            let data = vm.viewportData
            #expect(vm.state?.selectedDate == current.selectedDate)
            #expect(vm.state?.todayDate == current.todayDate)
            #expect(data.isActive)
            #expect(data.generation == original.generation)
            #expect(data.months[month]?.availability == .ready)
            #expect(data.months[month]?.cells.first === original.months[month]?.cells.first)
            #expect(vm.viewportState === published)
        }
    }

    @Test func gridRequestLifetimeUsesLeaseActivityNotForegroundOrMapPresence() async {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        await source.waitForCollections(1)
        for view in [CalendarView.month, .year] {
            let loading = makeState(view: view, loading: .loading, hasProjection: false)
            source.currentExperienceState = loading
            source.authority.state = CalendarViewportState(periods: [:])
            let empty = vm.viewportData
            #expect(empty.isActive)
            #expect(empty.months.isEmpty)
            #expect(CalendarScaffold.ownsViewportRequests(state: CalendarUiState(loading), viewportData: empty))

            source.authority.state = makeViewportState()
            let marked = vm.viewportData
            #expect(marked.isActive)
            #expect(marked.months.values.first?.availability == .ready)
            #expect(marked.generation == empty.generation)
            #expect(CalendarScaffold.ownsViewportRequests(state: CalendarUiState(loading), viewportData: marked))

            source.leaseValid = false // Still-nonempty source map is not authority.
            let foreground = makeState(view: view)
            source.currentExperienceState = foreground
            let inactive = vm.viewportData
            #expect(!vm.isViewportLeaseActive)
            #expect(vm.viewportState == nil)
            #expect(!inactive.isActive)
            #expect(inactive.months.isEmpty)
            #expect(inactive.generation != marked.generation)
            #expect(!CalendarScaffold.ownsViewportRequests(state: CalendarUiState(foreground), viewportData: inactive))
            source.leaseValid = true
        }
        for view in [CalendarView.day, .week] {
            let foreground = makeState(view: view)
            source.currentExperienceState = foreground
            #expect(!CalendarScaffold.ownsViewportRequests(state: CalendarUiState(foreground), viewportData: vm.viewportData))
        }
        // Compatibility is only for callers without the production data bridge.
        #expect(CalendarScaffold.ownsViewportRequests(state: CalendarUiState(makeState()), viewportData: nil))
        #expect(!CalendarScaffold.ownsViewportRequests(state: CalendarUiState(makeState(hasProjection: false)), viewportData: nil))
        vm.dispose()
        #expect(!vm.isViewportLeaseActive)
        #expect(!vm.viewportData.isActive)
    }

    @Test func synchronousForegroundClearRejectsDeliveredContentAndActionsBeforeCallback() async {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        await source.waitForCollections(1)
        let old = makeState(view: .day, anchorDate: "2026-08-17")
        let identity = old.projection!.visibleEvents[0].actionIdentity
        source.currentExperienceState = old
        source.semanticReceivers[0](old)
        #expect(vm.state?.projection === old.projection)
        #expect(vm.state.map { CalendarScreenMapping.navigationDisposition(for: $0) } == .dismissOverlayFirst)
        source.resolvedViewportOccurrence = old.authorizedOccurrences[0]
        #expect(vm.currentOccurrence(for: identity) === old.authorizedOccurrences[0])

        // Shared invalidation is already synchronous; its collector callback is not delivered.
        source.currentExperienceState = makeState(view: .day, anchorDate: "2026-08-17", isCleared: true)
        source.leaseValid = false
        #expect(vm.state?.projection == nil)
        #expect(vm.state?.occurrences.isEmpty == true)
        #expect(vm.state?.facets.groups.isEmpty == true)
        #expect(vm.state?.agenda.isEmpty == true)
        #expect(vm.state?.preview == nil)
        #expect(vm.state?.editor == nil)
        #expect(vm.state?.mutationAvailability.canCreate == false)
        #expect(vm.state.map { CalendarScreenMapping.navigationDisposition(for: $0) } == .perform)
        #expect(vm.currentOccurrence(for: identity) == nil)
        #expect(vm.viewportData.months.isEmpty)
        source.semanticReceivers[0](old) // A queued predecessor cannot restore anything.
        #expect(vm.state?.projection == nil)
        #expect(vm.currentOccurrence(for: identity) == nil)
    }

    @Test func synchronousCurrentRevisionWinsBeforeDeliveryAndDisposedForegroundIsInert() async throws {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        await source.waitForCollections(1)
        let old = makeState(view: .week, anchorDate: "2026-08-17")
        let identity = old.projection!.visibleEvents[0].actionIdentity
        source.currentExperienceState = old
        source.semanticReceivers[0](old)
        let latest = makeOccurrence(revision: 8)
        let current = makeState(
            view: .week, anchorDate: "2026-08-17", freshness: .cachedOffline, offline: .offline,
            occurrence: latest
        )
        source.currentExperienceState = current // No new collector callback.
        #expect(vm.state?.projection === current.projection)
        #expect(vm.state?.occurrences.first === latest)
        #expect(vm.state?.preview === latest)
        #expect(vm.state?.freshness == .cachedOffline)
        #expect(vm.state?.isOffline == true) // Current cache-first/offline data remains valid.
        source.resolvedViewportOccurrence = latest
        let resolved = try #require(vm.currentOccurrence(for: identity))
        #expect(resolved === latest)
        #expect(resolved.revision == 8)
        vm.openPreview(resolved)
        if case .openPreview(let intent) = onEnum(of: source.intents[0]) {
            #expect(intent.occurrence === latest)
        } else { Issue.record("expected latest exact preview occurrence") }

        vm.dispose()
        #expect(vm.state == nil) // Even while the source still has a valid snapshot.
        #expect(vm.currentOccurrence(for: identity) == nil)
        source.semanticReceivers[0](old)
        #expect(vm.state == nil)
        #expect(vm.currentOccurrence(for: identity) == nil)
        #expect(vm.viewportData.months.isEmpty)
    }

    @Test func adjacentRequestsUseBoundedVerticalCivilWindowsAndNeverNavigate() throws {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        let date = try #require(CalendarViewportDate(date: "2028-02-29"))
        source.currentExperienceState = makeState(view: .day)
        let day = CalendarAdjacentPageID(view: .day, anchor: date)
        let dayPeriods = CalendarAdjacentPeriodWindow.initial(around: day)
        vm.requestAdjacentViewport(.init(view: .day, periods: dayPeriods.map(\.anchor)))
        vm.browse(date)
        #expect(vm.browsedDate == date)
        #expect(vm.browsedMonth == CalendarViewportMonth(year: 2028, month: 2))
        #expect(source.requests.last?.count == dayPeriods.count)
        // A direct VM window request preserves the chronological window order.
        // The native controller separately prioritizes its positioned current
        // period; CalendarAdjacentViewportTests asserts that owner contract.
        #expect(source.requests.last?.first?.anchorDate == dayPeriods.first?.anchor.date)
        #expect(source.requests.last?.map(\.anchorDate) == dayPeriods.map(\.anchor.date))
        #expect((source.requests.last?.count ?? 49) <= CalendarAdjacentPeriodWindow.maximumPeriods + 1)
        #expect(vm.viewportRequestResult == .accepted)
        #expect(vm.adjacentData.semanticAnchor?.date == "2026-08-01")
        #expect(source.intents.isEmpty)
        #expect(source.viewportNavigations.isEmpty)
        let invalidAdjacentDate = try #require(CalendarViewportDate(date: "9999-12-01"))
        vm.requestAdjacentViewport(.init(view: .day, periods: [invalidAdjacentDate]))
        #expect(vm.viewportRequestResult == .invalidDate)
        #expect(source.requests.count == 1)
        source.requestOutcome = .invalidDate
        vm.requestAdjacentViewport(.init(view: .day, periods: dayPeriods.map(\.anchor)))
        #expect(vm.viewportRequestResult == .invalidDate)
        #expect(source.requests.count == 1)
        source.requestOutcome = .accepted
        vm.requestViewport(.init(months: []))
        #expect(source.requests.count == 1)

        source.currentExperienceState = makeState(view: .week)
        let week = CalendarAdjacentPageID(view: .week, anchor: date)
        let weekPeriods = CalendarAdjacentPeriodWindow.initial(around: week)
        vm.requestAdjacentViewport(.init(view: .week, periods: weekPeriods.map(\.anchor)))
        vm.requestAdjacentViewport(.init(view: .day, periods: []))
        vm.requestViewport(.init(months: []))
        #expect(source.requests.count == 2)
        #expect(source.requests.last?.map(\.anchorDate) == weekPeriods.map(\.anchor.date))
        #expect(source.requests.last?.allSatisfy { $0.view == .week } == true)
        #expect((source.requests.last?.count ?? 49) <= CalendarAdjacentPeriodWindow.maximumPeriods + 1)
        #expect(vm.viewportRequestResult == .accepted)

        source.navigationOutcome = .outsideVisibleWeek
        vm.selectDate(from: date, date: "2028-04-01")
        #expect(vm.browsedDate == date)
        #expect(vm.viewportNavigationResult == .outsideVisibleWeek)
        source.navigationOutcome = .accepted
        vm.selectDate(from: date, date: "2028-03-01")
        #expect(vm.browsedDate == nil)
        #expect(source.viewportNavigations.last?.0 == date.date)
        #expect((source.viewportNavigations.last?.1 as? CalendarNavigationActionSelectDate)?.date == "2028-03-01")
        vm.browse(date)
        vm.next()
        #expect(source.viewportNavigations.last?.0 == "2028-02-29")
        #expect(source.viewportNavigations.last?.1 is CalendarNavigationActionNext)
        vm.browse(date)
        vm.selectView(.month)
        #expect(source.viewportNavigations.last?.0 == "2028-02-29")
        #expect((source.viewportNavigations.last?.1 as? CalendarNavigationActionSelectView)?.view == .month)
        #expect(vm.browsedDate == nil)
        #expect(source.intents.isEmpty)
    }

    @Test func adjacentResolverUsesOnlyCurrentLeaseExactIdentityAndNeverResurrectsForeground() throws {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        let foreground = makeState(view: .day, anchorDate: "2026-08-17")
        source.currentExperienceState = foreground
        let identity = try #require(foreground.projection?.visibleEvents.first?.actionIdentity)
        let latest = makeOccurrence(revision: 12)
        source.resolvedViewportOccurrence = latest
        #expect(vm.currentOccurrence(for: identity) === latest)
        #expect(source.resolvedIdentities.last?.originalStart == identity.originalStart)
        #expect(source.resolvedIdentities.last?.scope == identity.scope)
        source.resolvedViewportOccurrence = nil
        #expect(vm.currentOccurrence(for: identity) == nil) // Foreground still has revision 7.
        source.resolvedViewportOccurrence = latest
        source.leaseValid = false
        #expect(vm.currentOccurrence(for: identity) == nil)
        source.leaseValid = true
        let missingStart = CalendarEventActionIdentity(
            eventId: identity.eventId, occurrenceId: identity.occurrenceId, originalStart: nil, scope: identity.scope
        )
        #expect(vm.currentOccurrence(for: missingStart) == nil)
        source.authority.owner = UUID() // Successor lease.
        #expect(vm.currentOccurrence(for: identity) == nil)
        // Foreground-only compatibility also requires a currently visible row,
        // not merely a matching raw record somewhere in its authorized window.
        source.currentExperienceState = makeState(view: .month, anchorDate: "2027-08-01")
        #expect(vm.state?.occurrences.isEmpty == false)
        #expect(vm.currentOccurrence(for: identity) == nil)
        vm.dispose()
        #expect(vm.currentOccurrence(for: identity) == nil)
    }

    @Test func adjacentProjectionMappingIsDirectLatestOnlyAndKeepsRefreshingData() throws {
        let source = ViewportSourceSpy()
        let vm = CalendarViewModel(source: source)
        vm.resume()
        defer { vm.dispose() }
        for view in [CalendarView.day, .week] {
            let foreground = makeState(view: view, anchorDate: "2026-08-17")
            source.currentExperienceState = foreground
            let id = CalendarAdjacentPageID(view: view, anchor: try #require(CalendarViewportDate(date: "2026-08-24")))
            let projected = makeState(view: view, anchorDate: id.anchor.date).projection!
            let period = MobileData.CalendarViewportPeriod(view: view, anchorDate: id.anchor.date)
            let entry = CalendarViewportEntry(
                window: makeViewportEntry(nil).window, projection: projected,
                loading: CalendarLoadingState(phase: .refreshing), freshness: .refreshing, offline: .online, error: nil
            )
            source.authority.state = CalendarViewportState(periods: [period: entry])
            let ready = vm.adjacentData
            #expect(ready.pages[id]?.projection === projected)
            #expect(ready.pages[id]?.loading.isRefreshing == true)
            #expect(CalendarSurfaceMapping.agenda(for: projected).map(\.date) ==
                (projected.day?.agenda ?? projected.week!.agenda).map(\.date))
            for changed in [
                makeState(view: view, selectedDate: "2026-08-18"),
                makeState(view: view, todayDate: "2026-08-19"),
                makeState(view: view, filters: makeFilters(text: "different")),
                makeState(view: view, locale: CalendarLocale(languageTag: "en-GB", timeZoneId: "UTC", weekStart: .sunday, hourCycle: .hour24))
            ] {
                source.currentExperienceState = changed
                let pending = vm.adjacentData
                #expect(pending.pages[id]?.projection == nil)
                #expect(pending.pages[id]?.loading.isInitial == true)
                let structuralChange = changed.filters != foreground.filters || changed.locale != foreground.locale
                if structuralChange {
                    #expect(pending.generation != ready.generation)
                } else {
                    #expect(pending.generation == ready.generation)
                }
            }
            source.currentExperienceState = foreground
            source.authority.state = CalendarViewportState(periods: [period: makeViewportEntry(nil)])
            #expect(vm.adjacentData.pages[id]?.projection == nil)
            #expect(vm.adjacentData.pages[id]?.loading.isInitial == false)
            source.authority.state = CalendarViewportState(periods: [:])
            #expect(vm.adjacentData.pages.isEmpty)
            source.authority.state = CalendarViewportState(periods: [period: entry])
            source.leaseValid = false
            #expect(!vm.adjacentData.isActive)
            #expect(vm.adjacentData.pages.isEmpty)
            source.leaseValid = true
        }
    }

    @Test func unmountedCandidatesCannotCollectOrSupersedeTheActiveViewportOwner() async throws {
        let authority = ViewportSourceSpy.Authority()
        let source = ViewportSourceSpy(authority: authority)
        let shared = makeState(view: .day, anchorDate: "2026-08-17")
        source.currentExperienceState = shared
        let owner = CalendarViewModel(source: source)
        defer { owner.dispose() }
        #expect(source.activations == 0)
        #expect(owner.state == nil)
        #expect(!owner.isViewportLeaseActive)
        #expect(!owner.adjacentData.isActive)

        // Mount activation is synchronous; collectors follow, not the reverse.
        owner.resume()
        #expect(source.activations == 1)
        #expect(owner.isViewportLeaseActive)
        #expect(owner.state?.projection === shared.projection)
        await source.waitForCollections(1)
        let period = MobileData.CalendarViewportPeriod(view: .day, anchorDate: shared.anchorDate)
        #expect(owner.setViewportPeriods([period]) == .accepted)
        let published = CalendarViewportState(periods: [period: makeViewportEntry(shared.projection)])
        authority.state = published
        let token = try #require(authority.owner)
        let ready = owner.adjacentData
        let page = CalendarAdjacentPageID(view: .day, anchor: try #require(CalendarViewportDate(date: shared.anchorDate)))
        #expect(ready.pages[page]?.projection === shared.projection)

        let candidateSource = ViewportSourceSpy(authority: authority)
        candidateSource.currentExperienceState = shared
        let candidate = CalendarViewModel(source: candidateSource)
        defer { candidate.dispose() }
        await Task.yield()
        #expect(candidateSource.activations == 0)
        #expect(candidateSource.semanticReceivers.isEmpty)
        #expect(candidateSource.viewportReceivers.isEmpty)
        #expect(candidateSource.intents.isEmpty)
        #expect(candidate.state == nil)
        #expect(!candidate.isViewportLeaseActive)
        #expect(candidate.setViewportPeriods([period]) == .retired)
        #expect(candidateSource.attemptedRequests.isEmpty)
        candidate.dispose() // An unmounted/discarded candidate owns nothing to release.
        #expect(candidateSource.releases == 0)
        #expect(authority.owner == token)
        #expect(owner.viewportState === published)
        #expect(owner.isViewportLeaseActive)
        #expect(owner.adjacentData.generation == ready.generation)
        #expect(owner.adjacentData.revision == ready.revision)
        #expect(owner.adjacentData.pages[page]?.projection === shared.projection)

        // Only an explicit mounted lifecycle may supersede the predecessor.
        candidate.resume()
        #expect(candidateSource.activations == 1)
        #expect(candidate.isViewportLeaseActive)
        #expect(!owner.isViewportLeaseActive)
        #expect(owner.viewportState == nil)
        #expect(owner.adjacentData.pages.isEmpty)
        owner.resume() // An active-but-revoked predecessor must NOT reacquire.
        #expect(source.activations == 1)
        #expect(!owner.isViewportLeaseActive)
        #expect(candidate.isViewportLeaseActive)
        #expect(owner.setViewportPeriods([period]) == .retired)
        await candidateSource.waitForCollections(1)
    }

    @Test func mountedStateRecreationDiscardsCandidateWithoutRetiringItsRetainedOwner() async throws {
        let authority = ViewportSourceSpy.Authority()
        let source = ViewportSourceSpy(authority: authority)
        let shared = makeState(view: .day, anchorDate: "2026-08-17")
        source.currentExperienceState = shared
        var rendered: [CalendarViewModel] = []
        let initialView = CalendarLifecycleStateFixture(
            source: source, revision: 0, onRender: { rendered.append($0) }
        )
        #expect(source.activations == 0) // Constructing a View value is not appearing.
        let host = UIHostingController(rootView: initialView)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            rendered.forEach { $0.dispose() }
            window.isHidden = true
        }
        func render() async {
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            await Task.yield()
            host.view.layoutIfNeeded()
        }
        await render()
        let retained = try #require(rendered.first)
        await source.waitForCollections(1)
        #expect(source.activations == 1)
        #expect(retained.isViewportLeaseActive)
        let period = MobileData.CalendarViewportPeriod(view: .day, anchorDate: shared.anchorDate)
        let published = CalendarViewportState(periods: [period: makeViewportEntry(shared.projection)])
        authority.state = published
        let ready = retained.adjacentData
        let token = try #require(authority.owner)

        // Same SwiftUI identity, newly evaluated eager State(initialValue:).
        // The new source shares lease authority, just like the same experience.
        let candidateSource = ViewportSourceSpy(authority: authority)
        candidateSource.currentExperienceState = shared
        host.rootView = CalendarLifecycleStateFixture(
            source: candidateSource, revision: 1, onRender: { rendered.append($0) }
        )
        await render()
        #expect(rendered.count == 2)
        #expect(rendered.last === retained)
        #expect(candidateSource.activations == 0)
        #expect(candidateSource.semanticReceivers.isEmpty)
        #expect(candidateSource.viewportReceivers.isEmpty)
        #expect(candidateSource.releases == 0)
        #expect(source.activations == 1)
        #expect(source.semanticReceivers.count == 1)
        #expect(source.viewportReceivers.count == 1)
        #expect(authority.owner == token)
        #expect(retained.isViewportLeaseActive)
        #expect(retained.viewportState === published)
        #expect(retained.adjacentData.generation == ready.generation)
        #expect(retained.adjacentData.revision == ready.revision)
        #expect(retained.adjacentData.pages.count == 1)
    }

    @Test func nativeDateConversionDoesNotTouchSharedRawIdentity() {
        let occurrence = makeOccurrence()
        #expect(occurrence.originalStart == "2026-08-17T09:00:00-07:00")
        #expect(occurrence.start == "2026-08-17T10:00:00-07:00")
        let date = Date(timeIntervalSince1970: 0)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        #expect(CalendarNativeDateConversion.allDayValue(date, calendar: utc) == "1970-01-01")
    }

    private func expectNavigate<T>(_ intent: any CalendarExperienceIntent, _: T.Type) {
        guard case .navigate(let value) = onEnum(of: intent) else {
            Issue.record("expected navigate intent")
            return
        }
        #expect(value.action is T)
    }

}

@MainActor
private final class CalendarExperienceSourceSpy: CalendarExperienceStateSource {
    private let stream: AsyncStream<CalendarExperienceState>
    private let continuation: AsyncStream<CalendarExperienceState>.Continuation
    private(set) var intents: [any CalendarExperienceIntent] = []
    private(set) var activationCount = 0
    private(set) var lifecycleEvents: [String] = []
    private(set) var collectionCancelled = false
    private var collectionStarted = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var receivedCount = 0
    private var receiptWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var cancelWaiters: [CheckedContinuation<Void, Never>] = []

    init() {
        var captured: AsyncStream<CalendarExperienceState>.Continuation!
        stream = AsyncStream { captured = $0 }
        continuation = captured
    }

    func activate() {
        activationCount += 1
        lifecycleEvents.append("activate")
    }

    func collect(_ receive: @MainActor @escaping (CalendarExperienceState) -> Void) async {
        lifecycleEvents.append("collect")
        collectionStarted = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withTaskCancellationHandler {
            for await state in stream {
                receive(state)
                receivedCount += 1
                let ready = receiptWaiters.filter { $0.0 <= receivedCount }
                receiptWaiters.removeAll { $0.0 <= receivedCount }
                ready.forEach { $0.1.resume() }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.collectionCancelled = true
                self.cancelWaiters.forEach { $0.resume() }
                self.cancelWaiters.removeAll()
            }
        }
    }

    func dispatch(_ intent: any CalendarExperienceIntent) { intents.append(intent) }
    func emit(_ state: CalendarExperienceState) { continuation.yield(state) }
    func waitUntilStarted() async {
        if collectionStarted { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }
    func waitForEmissions(_ count: Int) async {
        if receivedCount >= count { return }
        await withCheckedContinuation { receiptWaiters.append((count, $0)) }
    }
    func waitUntilCancelled() async {
        if collectionCancelled { return }
        await withCheckedContinuation { cancelWaiters.append($0) }
    }
}

/// Models multiple route collectors over one session-owned experience. The
/// activation work intentionally outlives every collector, matching KMP ownership.
@MainActor
private final class RouteRecreationSourceSpy: CalendarExperienceStateSource {
    private var collectors: [UUID: AsyncStream<CalendarExperienceState>.Continuation] = [:]
    private var collectorWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var cancellationWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var deliveryWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private(set) var activationCalls = 0
    private(set) var activationWorkStarts = 0
    private(set) var sessionWorkActive = false
    private(set) var cancellationCount = 0
    private(set) var deliveryCount = 0

    var activeCollectorCount: Int { collectors.count }

    func activate() {
        activationCalls += 1
        guard !sessionWorkActive else { return }
        sessionWorkActive = true
        activationWorkStarts += 1
    }

    func collect(_ receive: @MainActor @escaping (CalendarExperienceState) -> Void) async {
        let id = UUID()
        var captured: AsyncStream<CalendarExperienceState>.Continuation!
        let stream = AsyncStream<CalendarExperienceState> { captured = $0 }
        collectors[id] = captured
        resumeCollectorWaiters()

        await withTaskCancellationHandler {
            for await state in stream {
                receive(state)
                deliveryCount += 1
                resumeDeliveryWaiters()
            }
        } onCancel: {
            captured.finish()
        }

        collectors.removeValue(forKey: id)
        cancellationCount += 1
        resumeCancellationWaiters()
    }

    func dispatch(_ intent: any CalendarExperienceIntent) {}

    func emit(_ state: CalendarExperienceState) {
        collectors.values.forEach { $0.yield(state) }
    }

    func waitForCollectors(_ count: Int) async {
        if collectors.count >= count { return }
        await withCheckedContinuation { collectorWaiters.append((count, $0)) }
    }

    func waitForCancellations(_ count: Int) async {
        if cancellationCount >= count { return }
        await withCheckedContinuation { cancellationWaiters.append((count, $0)) }
    }

    func waitForDeliveries(_ count: Int) async {
        if deliveryCount >= count { return }
        await withCheckedContinuation { deliveryWaiters.append((count, $0)) }
    }

    private func resumeCollectorWaiters() {
        let ready = collectorWaiters.filter { $0.0 <= collectors.count }
        collectorWaiters.removeAll { $0.0 <= collectors.count }
        ready.forEach { $0.1.resume() }
    }

    private func resumeCancellationWaiters() {
        let ready = cancellationWaiters.filter { $0.0 <= cancellationCount }
        cancellationWaiters.removeAll { $0.0 <= cancellationCount }
        ready.forEach { $0.1.resume() }
    }

    private func resumeDeliveryWaiters() {
        let ready = deliveryWaiters.filter { $0.0 <= deliveryCount }
        deliveryWaiters.removeAll { $0.0 <= deliveryCount }
        ready.forEach { $0.1.resume() }
    }
}

private func makeLocale() -> CalendarLocale {
    CalendarLocale(languageTag: "en-US", timeZoneId: "America/Los_Angeles", weekStart: .monday, hourCycle: .hour12)
}

private func makeFilters(text: String = "") -> CalendarFilters {
    CalendarFilters(scope: .all, groups: Set(["family"]), tags: Set(["school"]), importance: .important, text: text)
}

private func makeOccurrence(revision: Int32 = 7) -> EffectiveOccurrence {
    EffectiveOccurrence(
        eventId: "event-42", occurrenceId: "occurrence-42",
        originalStart: "2026-08-17T09:00:00-07:00", recurring: true, revision: revision,
        scope: .household, title: "School pickup", description: "Bring forms",
        start: "2026-08-17T10:00:00-07:00", end: "2026-08-17T10:30:00-07:00",
        visibility: .everyone, importance: .important, group: "family", tags: ["school"], recurrence: nil
    )
}

private func makeDraft() -> CalendarMutationDraft {
    CalendarMutationDraft(
        title: "School pickup", description: "Bring forms", allDay: false,
        start: "2026-08-17T10:00:00-07:00", end: "2026-08-17T10:30:00-07:00",
        scope: .household, visibility: .everyone, importance: .important, group: "family", tags: ["school"],
        recurrence: nil, eventId: "event-42", occurrenceId: "occurrence-42",
        originalStart: "2026-08-17T09:00:00-07:00", expectedRevision: 7,
        inputTimeZoneId: "America/Los_Angeles", recurring: true
    )
}

private func makeState(
    view: CalendarView = .month,
    anchorDate: String = "2026-08-01",
    freshness: CalendarCacheFreshness = .fresh,
    loading: CalendarLoadingPhase = .idle,
    offline: CalendarOfflineState = .online,
    locale: CalendarLocale = makeLocale(),
    filters: CalendarFilters = makeFilters(),
    selectedDate: String = "2026-08-17",
    todayDate: String = "2026-08-17",
    hasProjection: Bool = true,
    isCleared: Bool = false,
    occurrence: EffectiveOccurrence = makeOccurrence()
) -> CalendarExperienceState {
    let projectionOccurrence = CalendarProjectionOccurrence(
        eventId: occurrence.eventId, occurrenceId: occurrence.occurrenceId,
        originalStart: occurrence.originalStart, recurring: occurrence.recurring,
        recurrence: occurrence.recurrence, revision: occurrence.revision,
        scope: occurrence.scope, title: occurrence.title, description: occurrence.description_,
        start: occurrence.start, end: occurrence.end, visibility: occurrence.visibility,
        importance: occurrence.importance, group: occurrence.group, tags: occurrence.tags,
        persistedTimeZoneId: "America/Los_Angeles"
    )
    let projection = CalendarProjection().project(request: CalendarProjectionRequest(
        occurrences: [projectionOccurrence], anchorDate: anchorDate, view: view,
        selectedDate: selectedDate, todayDate: todayDate, locale: locale, filters: filters
    ))
    return CalendarExperienceState(
        anchorDate: anchorDate, view: view, selectedDate: selectedDate, filters: filters,
        locale: locale, todayDate: todayDate,
        visibleInterval: projection.interval,
        selectedInterval: CalendarDateInterval(startDate: "2026-08-17", endExclusive: "2026-08-18"),
        authorizedOccurrences: isCleared ? [] : [occurrence], projection: hasProjection && !isCleared ? projection : nil,
        facets: CalendarFacetOptions(
            scopes: isCleared ? [] : [.all, .household], groups: isCleared ? [] : ["family"],
            tags: isCleared ? [] : ["school"], importances: isCleared ? [] : [.important]
        ),
        freshness: freshness, loading: CalendarLoadingState(phase: loading), offline: offline, error: nil,
        hasCompleteCache: !isCleared, cachedWindow: nil, persistedCachePreferences: nil,
        presentationReady: !isCleared,
        recovery: CalendarRecoveryState(phase: .idle, generation: 0, failureKind: nil),
        mutationAvailability: CalendarMutationAvailability(
            canCreate: !isCleared, canEdit: !isCleared, canDelete: !isCleared, reason: isCleared ? .unavailable : nil
        ),
        mutation: CalendarMutationState(
            phase: isCleared ? .idle : .previewing, preview: isCleared ? nil : occurrence, editor: nil, deleteConfirmation: nil,
            pendingRequest: nil, error: nil, conflict: nil, outcome: nil,
            successorEventId: nil, affectedWindows: []
        )
    )
}

/// A route source with shared lease-style ownership and deliberately retained
/// callbacks, so generation rejection is exercised even outside cancelled Tasks.
@MainActor
private final class ViewportSourceSpy: CalendarExperienceStateSource {
    final class Authority {
        var owner: UUID?
        var state = CalendarViewportState(periods: [:])
    }

    let authority: Authority
    private var lease: UUID?
    var activations = 0
    var releases = 0
    var requests: [[MobileData.CalendarViewportPeriod]] = []
    var attemptedRequests: [[MobileData.CalendarViewportPeriod]] = []
    var requestOutcome: CalendarViewportRequestResult = .accepted
    var navigationOutcome: CalendarViewportRequestResult = .accepted
    var viewportNavigations: [(String, any CalendarNavigationAction)] = []
    var currentExperienceState: CalendarExperienceState?
    var intents: [any CalendarExperienceIntent] = []
    var semanticReceivers: [@MainActor (CalendarExperienceState) -> Void] = []
    var viewportReceivers: [@MainActor (CalendarViewportState) -> Void] = []
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var cancellations = 0
    private var cancellationWaiters: [(Int, CheckedContinuation<Void, Never>)] = []

    init(authority: Authority = Authority()) { self.authority = authority }
    var maximumViewportPeriods: Int { 48 }
    var leaseValid = true
    var isViewportLeaseActive: Bool { leaseValid && lease != nil && authority.owner == lease }
    var currentViewportState: CalendarViewportState? { lease == nil ? nil : authority.state }

    var resolvedViewportOccurrence: EffectiveOccurrence?
    var resolvedIdentities: [CalendarOccurrenceIdentity] = []
    func currentViewportOccurrence(for identity: CalendarOccurrenceIdentity) -> EffectiveOccurrence? {
        resolvedIdentities.append(identity)
        return isViewportLeaseActive ? resolvedViewportOccurrence : nil
    }

    func activate() {
        activations += 1
        lease = UUID()
        authority.owner = lease
        authority.state = CalendarViewportState(periods: [:])
    }

    func releaseViewport() {
        releases += 1
        if authority.owner == lease {
            authority.owner = nil
            authority.state = CalendarViewportState(periods: [:])
        }
        lease = nil
    }

    func collect(_ receive: @MainActor @escaping (CalendarExperienceState) -> Void) async {
        semanticReceivers.append(receive)
        resumeWaiters()
        let (stream, continuation) = AsyncStream<Void>.makeStream()
        for await _ in stream {}
        continuation.finish()
        collectionEnded()
    }

    func collectViewport(_ receive: @MainActor @escaping (CalendarViewportState) -> Void) async {
        viewportReceivers.append(receive)
        resumeWaiters()
        let (stream, continuation) = AsyncStream<Void>.makeStream()
        for await _ in stream {}
        continuation.finish()
        collectionEnded()
    }

    func setViewportPeriods(_ periods: [MobileData.CalendarViewportPeriod]) -> CalendarViewportRequestResult {
        attemptedRequests.append(periods)
        guard isViewportLeaseActive else { return .retired }
        guard periods.count <= maximumViewportPeriods else { return .tooManyPeriods }
        guard requestOutcome == .accepted else { return requestOutcome }
        requests.append(periods)
        return .accepted
    }

    func navigateFromViewport(anchorDate: String, action: any CalendarNavigationAction) -> CalendarViewportRequestResult {
        viewportNavigations.append((anchorDate, action))
        return navigationOutcome
    }
    func dispatch(_ intent: any CalendarExperienceIntent) { intents.append(intent) }

    func waitForCollections(_ count: Int) async {
        if min(semanticReceivers.count, viewportReceivers.count) >= count { return }
        await withCheckedContinuation { waiters.append((count, $0)) }
    }

    func waitForCancellations(_ count: Int) async {
        if cancellations >= count { return }
        await withCheckedContinuation { cancellationWaiters.append((count, $0)) }
    }

    private func collectionEnded() {
        cancellations += 1
        let ready = cancellationWaiters.filter { $0.0 <= cancellations }
        cancellationWaiters.removeAll { $0.0 <= cancellations }
        ready.forEach { $0.1.resume() }
    }

    private func resumeWaiters() {
        let count = min(semanticReceivers.count, viewportReceivers.count)
        let ready = waiters.filter { $0.0 <= count }
        waiters.removeAll { $0.0 <= count }
        ready.forEach { $0.1.resume() }
    }
}

private func makeViewportState(projection: CalendarExperienceProjection? = makeState().projection) -> CalendarViewportState {
    let period = MobileData.CalendarViewportPeriod(view: .month, anchorDate: "2026-08-01")
    return CalendarViewportState(periods: [period: makeViewportEntry(projection)])
}

private func makeViewportEntry(_ projection: CalendarExperienceProjection?) -> CalendarViewportEntry {
    CalendarViewportEntry(
        window: CalendarCacheWindow(windowStart: "2026-07-27", windowEnd: "2026-09-07", timezoneInput: "America/Los_Angeles"),
        projection: projection, loading: CalendarLoadingState(phase: .idle),
        freshness: .fresh, offline: .online, error: nil
    )
}

/// Mount the route's eager State construction pattern through real SwiftUI
/// storage. Only test-local callbacks expose the retained model; production
/// CalendarExperienceScreen and its auth identity/lifecycle are unchanged.
private struct CalendarLifecycleStateFixture: View {
    @State private var vm: CalendarViewModel
    let revision: Int
    let onRender: (CalendarViewModel) -> Void

    init(source: any CalendarExperienceStateSource, revision: Int, onRender: @escaping (CalendarViewModel) -> Void) {
        _vm = State(initialValue: CalendarViewModel(source: source))
        self.revision = revision
        self.onRender = onRender
    }

    var body: some View {
        Color.clear
            .onAppear { vm.resume() }
            .onDisappear { vm.dispose() }
            .onChange(of: revision, initial: true) { _, _ in onRender(vm) }
    }
}

/// Real Scaffold/VM/native command boundary, with the existing source spy
/// deliberately withholding a changed shared state on Today.
private struct TodayScaffoldFixture: View {
    let vm: CalendarViewModel
    let onRequest: (CalendarViewportRequest) -> Void
    var todayRevision = 0
    @AccessibilityFocusState private var focus: CalendarOverlayOrigin?

    var body: some View {
        if let state = vm.state {
            CalendarScaffold(
                state: state,
                actions: CalendarSurfaceActions(
                    onBack: {}, onAdd: {}, onToday: vm.today, onPrevious: vm.previous, onNext: vm.next,
                    onSelectDate: vm.selectDate, onSelectMonth: { vm.selectMonth(year: $0, month: $1) },
                    onSelectView: vm.selectView, onFiltersChanged: vm.setFilters, onSearch: vm.search,
                    onEvent: { _ in }, onRetry: {},
                    onRequestPeriods: { vm.requestViewport($0); onRequest($0) }, onBrowsePeriod: vm.browse
                ),
                openerFocus: $focus, viewportData: vm.viewportData, browseCursor: vm.browsedMonth,
                adjacentData: vm.adjacentData, dateCursor: vm.browsedDate, todayRevision: todayRevision
            )
            // Match the mounted visual-capture fixture: disable implicit
            // morph animation without writing the read-only system setting.
            // render() flushes layout/publication, not elapsed animation time.
            .transaction { transaction in
                transaction.animation = nil
                transaction.disablesAnimations = true
            }
        }
    }
}
