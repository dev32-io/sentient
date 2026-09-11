import MobileData
import SwiftUI
import Testing
import UIKit
@testable import SentientApp

@MainActor
struct CalendarAdjacentViewportTests {
    private let locale = CalendarLocale(languageTag: "en-US", timeZoneId: "UTC", weekStart: .monday, hourCycle: .hour12)

    @Test func civilWindowTraversesBothDirectionsInChronologicalOrder() throws {
        let center = CalendarAdjacentPageID(
            view: .day, anchor: try #require(CalendarViewportDate(date: "2028-02-29"))
        )
        let initial = CalendarAdjacentPeriodWindow.initial(around: center)
        #expect(initial.map(\.anchor.date) == [
            "2028-02-25", "2028-02-26", "2028-02-27", "2028-02-28", "2028-02-29",
            "2028-03-01", "2028-03-02", "2028-03-03", "2028-03-04"
        ])
        #expect(initial.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
        #expect(center.previous?.next == center)
        #expect(center.next?.previous == center)

        let week = CalendarAdjacentPageID(
            view: .week, anchor: try #require(CalendarViewportDate(date: "2027-12-31"))
        )
        #expect(week.previous?.anchor.date == "2027-12-24")
        #expect(week.next?.anchor.date == "2028-01-07")
        #expect(week.adding(periods: -4)?.anchor.date == "2027-12-03")

        let first = CalendarAdjacentPageID(
            view: .day, anchor: try #require(CalendarViewportDate(date: "0001-01-01"))
        )
        #expect(first.isAdjacentViewportEligible)
        #expect(first.previous == nil)
        let firstWindowEligible = first.window.allSatisfy { period in
            period.isAdjacentViewportEligible
        }
        #expect(firstWindowEligible)
        let firstWeek = CalendarAdjacentPageID(view: .week, anchor: first.anchor)
        #expect(firstWeek.previous == nil)
        #expect(firstWeek.next?.anchor.date == "0001-01-08")

        let last = CalendarAdjacentPageID(
            view: .day, anchor: try #require(CalendarViewportDate(date: "9999-11-30"))
        )
        #expect(last.isAdjacentViewportEligible)
        #expect(last.next == nil)
        let lastWindowEligible = last.window.allSatisfy { period in
            period.isAdjacentViewportEligible
        }
        #expect(lastWindowEligible)
        let lastWeek = CalendarAdjacentPageID(view: .week, anchor: last.anchor)
        #expect(lastWeek.previous?.anchor.date == "9999-11-23")
        #expect(lastWeek.next == nil)

        let invalid = CalendarAdjacentPageID(
            view: .day, anchor: try #require(CalendarViewportDate(date: "9999-12-01"))
        )
        #expect(!invalid.isAdjacentViewportEligible)
        #expect(invalid.clampedToAdjacentViewportDomain?.anchor.date == "9999-11-30")
        let invalidWindowEligible = invalid.window.allSatisfy { period in
            period.isAdjacentViewportEligible
        }
        #expect(invalidWindowEligible)
    }

    @Test func pendingCivilWeeksMatchSharedDatesAtWeekStartsAndDomainEdges() throws {
        let starts: [Weekday] = [.sunday, .monday, .tuesday, .wednesday, .thursday, .friday, .saturday]
        for start in starts {
            let locale = CalendarLocale(languageTag: "en-US", timeZoneId: "UTC", weekStart: start, hourCycle: .hour12)
            for anchor in ["0001-01-01", "2028-02-29", "9999-11-30"] {
                let id = CalendarAdjacentPageID(view: .week, anchor: try #require(CalendarViewportDate(date: anchor)))
                let civil = CalendarCivilDay.days(for: id, locale: locale)
                let projected = CalendarProjection().project(request: CalendarProjectionRequest(
                    occurrences: [], anchorDate: anchor, view: .week, selectedDate: anchor, todayDate: anchor,
                    locale: locale, filters: CalendarFilters(scope: .all, groups: [], tags: [], importance: nil, text: "")
                ))
                let week = try #require(projected.week)
                #expect(civil.map(\.date) == week.days.map(\.date))
                let pending = CalendarAdjacentRow.rows(for: id, data: nil, locale: locale)
                #expect(pending.count == 8)
                #expect(!pending.contains { $0.id.kind == .empty || $0.id.kind == .status })
                #expect(civil.filter { $0.date.hasPrefix("0000-") }.allSatisfy { $0.label == $0.date })
            }
        }
    }

    @Test func invalidExplicitEdgeCursorsClampWithoutPoisoningRequests() async throws {
        let focusHarness = FocusHarness()
        let focus = focusHarness.binding
        let invalidDate = try #require(CalendarViewportDate(date: "9999-12-31"))

        for view in [CalendarView.day, .week] {
            let controller = CalendarAdjacentViewController()
            controller.loadViewIfNeeded()
            controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 500)
            var requests: [CalendarAdjacentViewportRequest] = []
            var browsed: [CalendarViewportDate] = []
            let data = CalendarAdjacentViewportData(
                isActive: true, generation: "edge-\(view)", revision: 1, pages: [:]
            )
            controller.update(
                CalendarAdjacentViewport(
                    current: .init(view: view, anchor: invalidDate), data: data,
                    locale: locale, openerFocus: focus,
                    onRequest: { requests.append($0) }, onBrowse: { browsed.append($0) }, onEvent: { _ in },
                    onSelectDate: { _, _ in }, onRetry: {}
                ),
                rightToLeft: false
            )
            controller.viewDidLayoutSubviews()
            await finishNativeDiff(controller)

            let clamped = try #require(controller.current)
            let echoOffset = try #require((controller.view as? UICollectionView)?.contentOffset.y)
            #expect(clamped.anchor.date == "9999-11-30")
            #expect(browsed.map(\.date) == ["9999-11-30"])
            let identitiesEligible = controller.identities.allSatisfy { period in
                period.isAdjacentViewportEligible
            }
            #expect(identitiesEligible)
            #expect(requests.count == 1)
            let requestsEligible = requests.allSatisfy { request in
                let periodsEligible = request.periods.allSatisfy { period in
                    period.isAdjacentViewportEligible
                }
                let hasNoDecember9999 = !request.periods.contains { period in
                    period.date.hasPrefix("9999-12")
                }
                return periodsEligible && hasNoDecember9999
            }
            #expect(requestsEligible)
            let collection = try #require(controller.view as? UICollectionView)
            let terminalRow = try #require(controller.rowIdentities.first { $0.period == clamped })
            let terminalOffset = try #require(rowOffset(terminalRow, in: collection))
            #expect(abs(terminalOffset) < 1.0)
            let echo = CalendarAdjacentViewport(
                current: clamped, data: data, locale: locale, openerFocus: focus,
                onRequest: { requests.append($0) }, onBrowse: { browsed.append($0) }, onEvent: { _ in },
                onSelectDate: { _, _ in }, onRetry: {}
            )
            controller.update(echo, rightToLeft: false)
            await finishNativeDiff(controller)
            #expect(abs(collection.contentOffset.y - echoOffset) < 1.0)
            #expect(browsed.map(\.date) == ["9999-11-30"])

            let explicit = try #require(clamped.previous)
            let explicitInput = CalendarAdjacentViewport(
                current: explicit,
                data: .init(isActive: true, generation: "edge-\(view)", revision: 1, pages: [:], semanticAnchor: explicit.anchor),
                locale: locale, openerFocus: focus,
                onRequest: { requests.append($0) }, onBrowse: { browsed.append($0) }, onEvent: { _ in },
                onSelectDate: { _, _ in }, onRetry: {}
            )
            controller.update(explicitInput, rightToLeft: false)
            await finishNativeDiff(controller)
            #expect(controller.current == explicit)
            #expect(browsed.map(\.date) == ["9999-11-30"])
            let latestRequest = try #require(requests.last)
            let latestRequestFirstPeriod = latestRequest.periods.first
            let latestRequestEligible = latestRequest.periods.allSatisfy { period in
                period.isAdjacentViewportEligible
            }
            #expect(latestRequestFirstPeriod == explicit.anchor)
            #expect(latestRequestEligible)

        }
    }

    @Test func pendingSnapshotsKeepLatestCursorAcrossSizingAndReentrantRequests() async throws {
        let focusHarness = FocusHarness()
        let focus = focusHarness.binding
        let date = try #require(CalendarViewportDate(date: "2028-02-29"))

        for view in [CalendarView.day, .week] {
            let center = CalendarAdjacentPageID(view: view, anchor: date)
            let intermediate = try #require(center.next)
            let latest = try #require(center.adding(periods: 2))
            let controller = CalendarAdjacentViewController()
            controller.loadViewIfNeeded()
            controller.view.frame = .zero
            var requests: [CalendarAdjacentViewportRequest] = []
            var browsed: [CalendarViewportDate] = []
            var opened = 0
            let page = CalendarAdjacentPageData(
                projection: project(latest.anchor.date, view: view, event: true),
                loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil
            )
            func makeInput(
                _ current: CalendarAdjacentPageID, revision: Int, loaded: Bool = false
            ) -> CalendarAdjacentViewport {
                CalendarAdjacentViewport(
                    current: current,
                    data: .init(
                        isActive: true, generation: "pending-\(view)", revision: revision,
                        pages: loaded ? [latest: page] : [:], semanticAnchor: current.anchor
                    ),
                    locale: locale, openerFocus: focus,
                    onRequest: {
                        requests.append($0)
                        if requests.count == 1 {
                            // A synchronous consumer response must not apply
                            // recursively inside UIKit's unfinished apply.
                            controller.update(makeInput(latest, revision: 4, loaded: true), rightToLeft: false)
                            controller.viewDidLayoutSubviews()
                            // Desired rows shrink and grow again while the
                            // submitted native snapshot still owns its cells.
                            controller.update(makeInput(latest, revision: 5), rightToLeft: false)
                            controller.update(makeInput(latest, revision: 6, loaded: true), rightToLeft: false)
                            controller.viewDidLayoutSubviews()
                        }
                    },
                    onBrowse: { browsed.append($0) }, onEvent: { _ in opened += 1 },
                    onSelectDate: { _, _ in }, onRetry: {}
                )
            }
            controller.update(makeInput(center, revision: 1), rightToLeft: false)
            controller.update(makeInput(intermediate, revision: 2), rightToLeft: false)
            await finishNativeDiff(controller)
            #expect(requests.isEmpty)
            #expect(browsed.isEmpty)

            controller.update(makeInput(latest, revision: 3), rightToLeft: false)
            controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 560)
            controller.viewDidLayoutSubviews()
            await finishNativeDiff(controller)

            let collection = try #require(controller.view as? UICollectionView)
            let source = try #require(
                collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>
            )
            #expect(source.snapshot().itemIdentifiers == controller.rowIdentities)
            for path in collection.indexPathsForVisibleItems {
                let nativeID = try #require(source.itemIdentifier(for: path))
                let cell = try #require(collection.cellForItem(at: path) as? CalendarAdjacentCell)
                let hosted = try #require(cell.configuredPage)
                #expect(cell.rowID == nativeID)
                #expect(hosted.row.id == nativeID)
            }
            let eventPage = try #require(collection.visibleCells.compactMap { ($0 as? CalendarAdjacentCell)?.configuredPage }.first { page in
                if case .event = page.row.content { return true }
                return false
            })
            let event = try #require(page.projection?.visibleEvents.first)
            eventPage.onEvent(event)
            #expect(opened == 1) // The hosted action must carry the latest revision, not revision 4.
            #expect(controller.current == latest)
            #expect(requests.count == 1)
            #expect(requests.first?.periods.first == latest.anchor)
            #expect(browsed.isEmpty)
            #expect(controller.rowIdentities.contains { row in
                guard row.period == latest else { return false }
                if case .event = row.kind { return true }
                return false
            })
            let leadingRow = try #require(controller.rowIdentities.first { $0.period == latest })
            let offset = try #require(rowOffset(leadingRow, in: collection))
            #expect(abs(offset) < 1.0)
            assertContiguous(controller.identities)
            controller.clear()
            await finishNativeDiff(controller)
        }
    }

    @Test func dayToWeekPresentsOnlyAlignedHostedRowsAndStillShowsKnownEmptyWeeks() async throws {
        let focusHarness = FocusHarness()
        let date = try #require(CalendarViewportDate(date: "2028-02-29"))
        let day = CalendarAdjacentPageID(view: .day, anchor: date)
        let week = CalendarAdjacentPageID(view: .week, anchor: date)
        let emptyWeek = try #require(week.previous)
        let controller = CalendarAdjacentViewController()
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { controller.clear(); window.isHidden = true }
        var browsed: [CalendarViewportDate] = []
        func page(_ id: CalendarAdjacentPageID, populated: Bool) -> CalendarAdjacentPageData {
            .init(projection: project(id.anchor.date, view: id.view, event: populated),
                  loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil)
        }
        func update(_ current: CalendarAdjacentPageID, revision: Int,
                    pages: [CalendarAdjacentPageID: CalendarAdjacentPageData]) {
            controller.update(CalendarAdjacentViewport(
                current: current,
                data: .init(isActive: true, generation: "entry-\(current.view)", revision: revision,
                            pages: pages, semanticAnchor: current.anchor),
                locale: locale, openerFocus: focusHarness.binding,
                onRequest: { _ in }, onBrowse: { browsed.append($0) },
                onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
            ), rightToLeft: false, bottomOcclusion: 96)
        }
        update(day, revision: 1, pages: [day: page(day, populated: true)])
        controller.view.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
        #expect(collection.alpha == 1)

        update(week, revision: 1, pages: [:])
        #expect(collection.visibleCells.allSatisfy {
            ($0 as? CalendarAdjacentCell)?.configuredPage?.row.period.view != .day
        })
        await finishNativeDiff(controller)
        let pendingRow = try #require(controller.rowIdentities.first { $0.period == week })
        #expect(pendingRow.kind == .weekOverview)
        let civilIDs = controller.rowIdentities.filter { $0.period == week }
        #expect(civilIDs.count == 8) // Overview + seven dates, never unknown-as-empty/status.
        #expect(!civilIDs.contains { $0.kind == .empty || $0.kind == .status })
        let overviewPath = try #require(source.indexPath(for: pendingRow))
        let overviewCell = try #require(collection.cellForItem(at: overviewPath) as? CalendarAdjacentCell)
        let overviewContent = overviewCell.contentView
        let overviewPage = try #require(overviewCell.configuredPage)
        guard case .weekOverview(let dates, let pendingProjection, _, _) = overviewPage.row.content else {
            Issue.record("Pending Week must own a civil overview")
            return
        }
        #expect(dates.map(\.date) == ["2028-02-28", "2028-02-29", "2028-03-01", "2028-03-02", "2028-03-03", "2028-03-04", "2028-03-05"])
        #expect(pendingProjection == nil)
        #expect(abs(try #require(rowOffset(pendingRow, in: collection))) < 1)
        #expect(collection.alpha == 1 && !collection.accessibilityElementsHidden)

        var pages = Dictionary(uniqueKeysWithValues: controller.identities.map {
            ($0, page($0, populated: $0 == week))
        })
        // Previous is loaded authority, but is not rendered until backward
        // navigation/prepend: incoming destinations now begin at item zero.
        pages[emptyWeek] = page(emptyWeek, populated: false)
        update(week, revision: 2, pages: pages)
        // Consume native layout BEFORE the main-queue completion adapter can
        // restore the anchor. This is the formerly untested presentation gap,
        // not a desired-row flag or an assertion only after the diff drains.
        collection.layoutIfNeeded()
        #expect(source.snapshot().itemIdentifiers.first?.period == week)
        let inFlightConfigurations = collection.visibleCells.compactMap { ($0 as? CalendarAdjacentCell)?.nativeConfiguration }
        #expect(!inFlightConfigurations.isEmpty)
        #expect(collection.alpha == 1 && !collection.accessibilityElementsHidden)
        #expect(overviewCell.contentView === overviewContent)
        #expect(overviewCell.contentView.alpha == 1 && !overviewCell.contentView.accessibilityElementsHidden)
        for cell in collection.visibleCells.compactMap({ $0 as? CalendarAdjacentCell }) {
            guard cell.nativeConfiguration != nil else { continue }
            switch cell.rowID?.kind {
            case .event, .empty:
                #expect(cell.contentView.alpha == 0 && cell.contentView.accessibilityElementsHidden)
            default:
                #expect(cell.contentView.alpha == 1 && !cell.contentView.accessibilityElementsHidden)
            }
        }

        await finishNativeDiff(controller)
        let leading = try #require(controller.rowIdentities.first { $0.period == week })
        #expect(abs(try #require(rowOffset(leading, in: collection))) < 1)
        #expect(collection.alpha == 1 && !collection.accessibilityElementsHidden)
        let visible = collection.visibleCells.compactMap { ($0 as? CalendarAdjacentCell)?.configuredPage?.row }
        #expect(visible.contains { row in
            if case .event = row.content { return row.period == week }
            return false
        })
        #expect(!visible.contains { $0.period == emptyWeek && $0.id.kind == .empty })
        #expect(browsed.isEmpty)

        update(emptyWeek, revision: 3, pages: pages)
        collection.layoutIfNeeded()
        let explicitFirst = try #require(source.snapshot().itemIdentifiers.first)
        #expect(explicitFirst.period == emptyWeek && explicitFirst.kind == .weekOverview)
        #expect(collection.alpha == 1 && !collection.accessibilityElementsHidden)
        #expect(abs(try #require(rowOffset(explicitFirst, in: collection))) < 1)
        await finishNativeDiff(controller)
        let emptyID = CalendarAdjacentRowID(period: emptyWeek, kind: .empty)
        let emptyPath = try #require(source.indexPath(for: emptyID))
        let emptyCell = try #require(collection.cellForItem(at: emptyPath) as? CalendarAdjacentCell)
        #expect(emptyCell.configuredPage?.row.id == emptyID)
        #expect(collection.bounds.intersects(emptyCell.frame))
        #expect(collection.alpha == 1 && !collection.accessibilityElementsHidden)
        #expect(!emptyCell.contentView.accessibilityElementsHidden)
    }

    @Test func warmModeDestinationsExposeOriginCivilBeforeSnapshotCompletion() async throws {
        let focus = FocusHarness()
        let anchor = try #require(CalendarViewportDate(date: "2028-02-29"))
        for populated in [false, true] {
            let controller = CalendarAdjacentViewController()
            let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { controller.clear(); window.isHidden = true }
            let collection = try #require(controller.view as? UICollectionView)
            let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
            var selected: [String] = []
            var requests: [CalendarAdjacentViewportRequest] = []
            for (revision, mode) in [CalendarView.day, .week, .day, .week].enumerated() {
                let target = CalendarAdjacentPageID(view: mode, anchor: anchor)
                let periods = CalendarAdjacentPeriodWindow.starting(at: target)
                let pages = Dictionary(uniqueKeysWithValues: periods.map { period in
                    (period, CalendarAdjacentPageData(
                        projection: project(period.anchor.date, view: mode, event: populated),
                        loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil
                    ))
                })
                controller.update(.init(
                    current: target,
                    data: .init(isActive: true, generation: "origin-\(mode)", revision: revision,
                                pages: pages, semanticAnchor: anchor, selectedDate: anchor.date, todayDate: anchor.date),
                    locale: locale, openerFocus: focus.binding, onRequest: { requests.append($0) }, onBrowse: { _ in },
                    onEvent: { _ in }, onSelectDate: { _, date in selected.append(date) }, onRetry: {}
                ), rightToLeft: false)
                // This is the first incoming native layout, BEFORE UIKit's
                // deferred completion. The old implementation hid this plane.
                collection.layoutIfNeeded()
                #expect(controller.view === collection)
                let first = try #require(source.snapshot().itemIdentifiers.first)
                #expect(first == controller.rowIdentities.first && first.period == target)
                let firstPath = try #require(source.indexPath(for: first))
                let civil = try #require(collection.cellForItem(at: firstPath) as? CalendarAdjacentCell)
                let page = try #require(civil.configuredPage)
                #expect(civil.frame.minY == 0 && collection.contentOffset == .zero)
                #expect(collection.alpha == 1 && !collection.accessibilityElementsHidden)
                #expect(civil.contentView.alpha == 1 && !civil.contentView.accessibilityElementsHidden)
                #expect(!collection.isScrollEnabled) // Only the snapshot/event gate still awaits completion.
                #expect(page.row.period == target)
                if mode == .week {
                    guard case .weekOverview(let dates, _, let selection, let today) = page.row.content else {
                        Issue.record("Incoming Week must already own its civil strip")
                        return
                    }
                    #expect(dates.count == 7 && selection == anchor.date && today == anchor.date)
                    page.onSelectDate(anchor.date)
                    #expect(selected.last == anchor.date)
                }
                for cell in collection.visibleCells.compactMap({ $0 as? CalendarAdjacentCell }) {
                    guard let hosted = cell.configuredPage else { continue }
                    #expect(hosted.row.period.view == mode) // No outgoing-mode hosts.
                    switch hosted.row.content {
                    case .event, .empty:
                        #expect(cell.contentView.alpha == 0 && cell.contentView.accessibilityElementsHidden)
                    default: break
                    }
                }
                await finishNativeDiff(controller)
                #expect(collection.isScrollEnabled && collection.alpha == 1)
                #expect(abs(try #require(rowOffset(first, in: collection))) < 1)
                #expect(requests.last?.periods.first == anchor)
                let currentResult = try #require(collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }.first { cell in
                    guard cell.rowID?.period == target else { return false }
                    if populated, case .event = cell.rowID?.kind { return true }
                    return !populated && cell.rowID?.kind == .empty
                })
                #expect(currentResult.contentView.alpha == 1 && !currentResult.contentView.accessibilityElementsHidden)

                // Real edge browsing prepends earlier periods and leaves a
                // nonzero offset before the next warm Day/Week switch. The
                // next destination must not seek through that old prefix.
                collection.setContentOffset(CGPoint(x: 0, y: Space.sm), animated: false)
                controller.scrollViewDidScroll(collection)
                await finishNativeDiff(controller)
                #expect(collection.contentOffset.y > 0)
                #expect(try #require(controller.identities.first).anchor < anchor)
                #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
                assertContiguous(controller.identities)
            }
        }
    }

    @Test func currentArrivalRefreshAndErrorKeepCivilOwnersAndRevisionFences() async throws {
        let focus = FocusHarness()
        let center = CalendarAdjacentPageID(view: .week, anchor: try #require(CalendarViewportDate(date: "2028-02-29")))
        let controller = CalendarAdjacentViewController()
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { controller.clear(); window.isHidden = true }
        var selections: [String] = []
        var events = 0
        var retries = 0
        func update(revision: Int, page: CalendarAdjacentPageData?, generation: String = "progressive") {
            controller.update(.init(
                current: center,
                data: .init(isActive: true, generation: generation, revision: revision,
                            pages: page.map { [center: $0] } ?? [:], semanticAnchor: center.anchor),
                locale: locale, openerFocus: focus.binding, onRequest: { _ in }, onBrowse: { _ in },
                onEvent: { _ in events += 1 }, onSelectDate: { _, date in selections.append(date) },
                onRetry: { retries += 1 }
            ), rightToLeft: false)
        }
        update(revision: 1, page: .init(projection: nil, loading: .init(phase: .loading),
                                      freshness: .stale, offline: .online, error: nil))
        controller.view.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
        let overviewID = CalendarAdjacentRowID(period: center, kind: .weekOverview)
        let path = try #require(source.indexPath(for: overviewID))
        let overview = try #require(collection.cellForItem(at: path) as? CalendarAdjacentCell)
        let civilContent = overview.contentView
        let civilPage = try #require(overview.configuredPage)
        let pendingAction = civilPage.onSelectDate
        let civilIDs = controller.rowIdentities.filter { $0.period == center }
        #expect(civilIDs.count == 8)
        #expect(!civilIDs.contains { $0.kind == .status || $0.kind == .empty })
        let projection = project(center.anchor.date, view: .week, event: true)
        let ready = CalendarAdjacentPageData(projection: projection, loading: .init(phase: .idle),
                                             freshness: .fresh, offline: .online, error: nil)
        update(revision: 2, page: ready)
        await finishNativeDiff(controller)
        #expect(overview.contentView === civilContent)
        pendingAction(center.anchor.date) // Civil commands do not expire with an event revision.
        #expect(selections == [center.anchor.date])
        let eventCell = try #require(collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }.first {
            if case .event = $0.rowID?.kind { return true }
            return false
        })
        let oldEventPage = try #require(eventCell.configuredPage)
        let event = try #require(projection.visibleEvents.first)
        oldEventPage.onEvent(event)
        #expect(events == 1)

        let refreshing = CalendarAdjacentPageData(projection: projection, loading: .init(phase: .refreshing),
                                                  freshness: .refreshing, offline: .online, error: nil)
        update(revision: 3, page: refreshing)
        collection.layoutIfNeeded()
        #expect(collection.alpha == 1 && eventCell.contentView.alpha == 1)
        #expect(!eventCell.contentView.accessibilityElementsHidden)
        #expect(!controller.rowIdentities.contains { $0.kind == .status })
        oldEventPage.onEvent(event)
        #expect(events == 1) // An event callback still requires the exact submitted revision.
        await finishNativeDiff(controller)
        let currentPage = try #require(eventCell.configuredPage)
        currentPage.onEvent(event)
        #expect(events == 2)
        #expect(eventCell.contentView.layer.animation(forKey: "calendar-event-arrival") == nil)
        #expect(overview.contentView === civilContent)

        // Retain the old canonical input independently of the physical cell:
        // UIKit may reuse that cell for the new status during snapshot apply.
        let withdrawnPresentation = try #require(eventCell.configuredPresentation)
        let withdrawnID = currentPage.row.id
        let unavailable = CalendarAdjacentPageData(projection: nil, loading: .init(phase: .idle),
            freshness: .stale, offline: .online,
            error: CalendarExperienceError(kind: .authorization, userMessage: "Calendar unavailable", recoverable: true))
        update(revision: 4, page: unavailable)
        // Immediate retirement, before any yield to the completion adapter.
        #expect(withdrawnPresentation.page == nil)
        #expect(!controller.rowIdentities.contains(withdrawnID))
        for cell in collection.visibleCells.compactMap({ $0 as? CalendarAdjacentCell }) where cell.contentConfiguration != nil {
            let page = try #require(cell.configuredPage)
            #expect(page.row.id == cell.rowID)
            #expect(page.row.id != withdrawnID)
        }
        if eventCell.contentConfiguration != nil || collection.visibleCells.contains(where: { $0 === eventCell }) {
            // A visible/configured replacement must render current authorized
            // status content, not retain the withdrawn event's render/AX input.
            let replacement = try #require(eventCell.configuredPage)
            #expect(eventCell.configuredPresentation !== withdrawnPresentation)
            #expect(replacement.row.id == eventCell.rowID)
            #expect(replacement.row.id == CalendarAdjacentRowID(period: center, kind: .status))
            #expect(controller.rowIdentities.contains(replacement.row.id))
            if case .status = replacement.row.content {
                #expect(replacement.row.availability == CalendarAdjacentAvailability(unavailable))
            } else {
                Issue.record("Reused event cell must host the current authorization status")
            }
        } else {
            #expect(eventCell.contentView.alpha == 0)
            #expect(eventCell.contentView.accessibilityElementsHidden)
            #expect(!eventCell.contentView.isUserInteractionEnabled)
        }
        currentPage.onEvent(event)
        #expect(events == 2)
        await finishNativeDiff(controller)
        let rows = controller.rowIdentities.filter { $0.period == center }
        #expect(rows.filter { $0.kind != .status } == civilIDs)
        #expect(!rows.contains { $0.kind == .empty })
        #expect(collection.alpha == 1)
        let statusID = CalendarAdjacentRowID(period: center, kind: .status)
        let statusPath = try #require(source.indexPath(for: statusID))
        collection.scrollToItem(at: statusPath, at: .centeredVertically, animated: false)
        collection.layoutIfNeeded()
        await finishNativeDiff(controller)
        let committedStatusPath = try #require(source.indexPath(for: statusID))
        let status = try #require((collection.cellForItem(at: committedStatusPath) as? CalendarAdjacentCell)?.configuredPage)
        status.onRetry()
        #expect(retries == 1)

        // Same civil IDs in a new authority epoch must configure again even
        // though every old host was synchronously cleared.
        update(revision: 1, page: nil, generation: "successor")
        pendingAction(center.anchor.date)
        #expect(selections.count == 1)
        await finishNativeDiff(controller)
        let successorPath = try #require(source.indexPath(for: overviewID))
        let successor = try #require((collection.cellForItem(at: successorPath) as? CalendarAdjacentCell)?.configuredPage)
        successor.onSelectDate(center.anchor.date)
        #expect(selections.count == 2)
        #expect(controller.rowIdentities.filter { $0.period == center } == civilIDs)
        #expect(collection.alpha == 1)
    }

    @Test func pendingSuccessorRevokesOverviewAndEmptyIncludingOlderSubmittedRebinds() async throws {
        let focus = FocusHarness()
        let anchor = try #require(CalendarViewportDate(date: "2028-02-29"))
        let selected = try #require(anchor.adding(days: 1)).date
        let today = try #require(anchor.adding(days: 2)).date
        for mode in [CalendarView.week, .day] {
            let center = CalendarAdjacentPageID(view: mode, anchor: anchor)
            let controller = CalendarAdjacentViewController()
            let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { controller.clear(); window.isHidden = true }
            let projection = project(anchor.date, view: mode, event: mode == .week)
            var opened = 0
            var selections: [String] = []
            func update(_ revision: Int, rejected: Bool = false) {
                let page = CalendarAdjacentPageData(
                    projection: rejected ? nil : projection,
                    loading: .init(phase: revision == 1 ? .idle : rejected ? .loading : .refreshing),
                    freshness: .fresh, offline: .online, error: nil
                )
                controller.update(.init(
                    current: center,
                    data: .init(isActive: true, generation: "pending-authority", revision: revision,
                                pages: [center: page], semanticAnchor: anchor,
                                selectedDate: rejected ? selected : anchor.date,
                                todayDate: rejected ? today : anchor.date),
                    locale: locale, openerFocus: focus.binding, onRequest: { _ in }, onBrowse: { _ in },
                    onEvent: { _ in opened += 1 }, onSelectDate: { _, date in selections.append(date) }, onRetry: {}
                ), rightToLeft: false)
            }
            update(1)
            controller.view.layoutIfNeeded()
            controller.viewDidLayoutSubviews()
            await finishNativeDiff(controller)
            let collection = try #require(controller.view as? UICollectionView)
            let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
            let civilID = CalendarAdjacentRowID(period: center,
                kind: mode == .week ? .weekOverview : .dayHeading(anchor.date))
            let civilPath = try #require(source.indexPath(for: civilID))
            let civilCell = try #require(collection.cellForItem(at: civilPath) as? CalendarAdjacentCell)
            let civilContent = civilCell.contentView
            #expect(civilCell.nativeConfiguration != nil)
            let obsoleteID = try #require(controller.rowIdentities.first { row in
                guard row.period == center else { return false }
                if mode == .day { return row.kind == .empty }
                if case .event = row.kind { return true }
                return false
            })
            let obsoletePath = try #require(source.indexPath(for: obsoleteID))
            let obsoleteCell = try #require(collection.cellForItem(at: obsoletePath) as? CalendarAdjacentCell)
            let oldPage = try #require(obsoleteCell.configuredPage)

            // No drain between either update or the assertions below. Revision
            // 3 replaces desired authority while UIKit still owns revision 2.
            update(2)
            update(3, rejected: true)
            #expect(source.snapshot().itemIdentifiers.contains(obsoleteID))
            #expect(!controller.rowIdentities.contains(obsoleteID))
            #expect(civilCell.contentView === civilContent)
            #expect(collection.alpha == 1 && !collection.accessibilityElementsHidden)

            func assertCurrentCivil() throws {
                let page = try #require(civilCell.configuredPage)
                #expect(civilCell.contentView.alpha == 1 && civilCell.contentView.isUserInteractionEnabled)
                #expect(!civilCell.contentView.accessibilityElementsHidden)
                #expect(!page.row.availability.isKnown)
                #expect(page.row.availabilityLabel == "Event data not loaded")
                if mode == .week {
                    guard case .weekOverview(let days, let week, let selection, let currentToday) = page.row.content else {
                        Issue.record("Week must retain its civil overview during the pending successor")
                        return
                    }
                    // The actual hosted Week's indicator AND projected AX-label
                    // source is absent, rather than only hiding its event cards.
                    #expect(week == nil)
                    #expect(days.count == 7)
                    #expect(days.contains { $0.date == selected })
                    #expect(selection == selected && currentToday == today)
                    page.onSelectDate(selected)
                }
            }
            try assertCurrentCivil()
            #expect(obsoleteCell.nativeConfiguration == nil ||
                (obsoleteCell.contentView.alpha == 0 && obsoleteCell.contentView.accessibilityElementsHidden &&
                 !obsoleteCell.contentView.isUserInteractionEnabled))
            if let event = projection.visibleEvents.first { oldPage.onEvent(event) }
            #expect(opened == 0)

            // Exercise the native retained-cell lifecycle while the older table
            // is still submitted. Neither callback may resurrect its projection.
            collection.delegate?.collectionView?(collection, didEndDisplaying: civilCell, forItemAt: civilPath)
            collection.delegate?.collectionView?(collection, willDisplay: civilCell, forItemAt: civilPath)
            try assertCurrentCivil()
            collection.delegate?.collectionView?(collection, didEndDisplaying: obsoleteCell, forItemAt: obsoletePath)
            collection.delegate?.collectionView?(collection, willDisplay: obsoleteCell, forItemAt: obsoletePath)
            #expect(obsoleteCell.nativeConfiguration == nil) // Display callbacks cannot reinstall revoked content.
            #expect(obsoleteCell.configuredPage == nil)
            #expect(obsoleteCell.contentView.alpha == 0 && obsoleteCell.contentView.accessibilityElementsHidden)
            #expect(!obsoleteCell.contentView.isUserInteractionEnabled)
            if let event = projection.visibleEvents.first { oldPage.onEvent(event) }
            #expect(opened == 0)

            await finishNativeDiff(controller)
            #expect(source.snapshot().itemIdentifiers == controller.rowIdentities)
            #expect(!source.snapshot().itemIdentifiers.contains(obsoleteID))
            #expect(collection.alpha == 1 && !collection.accessibilityElementsHidden)
            #expect(abs(try #require(rowOffset(civilID, in: collection))) < 1)
            try assertCurrentCivil()
            #expect(selections == (mode == .week ? [selected, selected, selected] : []))
        }
    }

    @Test func retainedEmptyCardsStayExposedThroughAppendAndQueuedPublicationButRevokeImmediately() async throws {
        let focus = FocusHarness()
        for mode in [CalendarView.day, .week] {
            let center = CalendarAdjacentPageID(view: mode, anchor: try #require(CalendarViewportDate(date: "2028-02-29")))
            let initial = CalendarAdjacentPeriodWindow.starting(at: center)
            let last = try #require(initial.last)
            let incoming = CalendarAdjacentPeriodWindow.after(last, count: CalendarAdjacentPeriodWindow.expansionCount)
            let controller = CalendarAdjacentViewController()
            let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { controller.clear(); window.isHidden = true }
            var cursor = center
            var revision = 1
            var pages = Dictionary(uniqueKeysWithValues: (initial + incoming).map { period in
                (period, CalendarAdjacentPageData(projection: project(period.anchor.date, view: mode, event: false),
                    loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil))
            })
            func update() {
                controller.update(.init(current: cursor,
                    data: .init(isActive: true, generation: "empty-roll", revision: revision,
                                pages: pages, semanticAnchor: center.anchor),
                    locale: locale, openerFocus: focus.binding, onRequest: { _ in },
                    onBrowse: { cursor = .init(view: mode, anchor: $0) },
                    onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
                ), rightToLeft: false)
            }
            update()
            controller.view.layoutIfNeeded()
            controller.viewDidLayoutSubviews()
            await finishNativeDiff(controller)
            let collection = try #require(controller.view as? UICollectionView)
            let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
            let retainedID = CalendarAdjacentRowID(period: last, kind: .empty)
            let path = try #require(source.indexPath(for: retainedID))
            // A real bottom-edge scroll appends four periods without trimming
            // the nine-period table. No delegate suppression or private roll.
            collection.scrollToItem(at: path, at: .top, animated: false)
            controller.scrollViewDidScroll(collection)
            collection.layoutIfNeeded()
            #expect(controller.identities == initial + incoming)
            let retainedPath = try #require(source.indexPath(for: retainedID))
            let retained = try #require(collection.cellForItem(at: retainedPath) as? CalendarAdjacentCell)
            func assertExposed() {
                #expect(retained.configuredPage?.row.id == retainedID)
                #expect(collection.bounds.intersects(retained.frame))
                #expect(retained.contentView.alpha == 1 && retained.contentView.isUserInteractionEnabled)
                #expect(!retained.contentView.accessibilityElementsHidden)
                #expect((retained.contentView as? UIContentView)?.configuration is UIHostingConfiguration<CalendarAdjacentCellContent, EmptyView>)
            }
            assertExposed() // Before the deferred append completion.
            // Newly materialized empty rows have not earned alignment yet.
            let incomingCells = collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }.filter { cell in
                guard cell.rowID?.kind == .empty, let period = cell.rowID?.period else { return false }
                return incoming.contains(period)
            }
            #expect(!incomingCells.isEmpty)
            for cell in incomingCells {
                #expect(cell.nativeConfiguration != nil)
                #expect(cell.contentView.alpha == 0 && !cell.contentView.isUserInteractionEnabled)
                #expect(cell.contentView.accessibilityElementsHidden)
            }
            pages[center] = .init(projection: project(center.anchor.date, view: mode, event: true),
                loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil)
            revision += 1
            update() // Unrelated topology/height successor queues behind append.
            assertExposed()
            await finishNativeDiff(controller)
            let currentPath = try #require(source.indexPath(for: retainedID))
            let currentCell = try #require(collection.cellForItem(at: currentPath) as? CalendarAdjacentCell)
            #expect(currentCell.contentView.alpha == 1 && !currentCell.contentView.accessibilityElementsHidden)

            revision += 1
            update() // Leave a real unchanged flight pending before revocation.
            pages[last] = nil
            revision += 1
            update()
            #expect(source.snapshot().itemIdentifiers.contains(retainedID))
            #expect(!controller.rowIdentities.contains(retainedID))
            #expect(currentCell.nativeConfiguration == nil || (currentCell.contentView.alpha == 0 &&
                !currentCell.contentView.isUserInteractionEnabled && currentCell.contentView.accessibilityElementsHidden))
            collection.delegate?.collectionView?(collection, didEndDisplaying: currentCell, forItemAt: currentPath)
            collection.delegate?.collectionView?(collection, willDisplay: currentCell, forItemAt: currentPath)
            #expect(currentCell.nativeConfiguration == nil) // Older submitted empty cannot be reinstalled.
            #expect(currentCell.configuredPage == nil)
            #expect(currentCell.contentView.alpha == 0 && currentCell.contentView.accessibilityElementsHidden)
            #expect(!currentCell.contentView.isUserInteractionEnabled)
            await finishNativeDiff(controller)
            #expect(!source.snapshot().itemIdentifiers.contains(retainedID))
        }
    }

    @Test func nativeMovementSurvivesDeferredRevisionAndPrependWithQueuedHeightsButNotToday() async throws {
        let focus = FocusHarness()
        for mode in [CalendarView.day, .week] {
            let center = CalendarAdjacentPageID(view: mode, anchor: try #require(CalendarViewportDate(date: "2028-02-29")))
            let controller = CalendarAdjacentViewController()
            let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { controller.clear(); window.isHidden = true }
            var cursor = center
            var revision = 1
            var pages = [center: CalendarAdjacentPageData(
                projection: project(center.anchor.date, view: mode, event: true),
                loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil)]
            func update(today: Int = 0) {
                controller.update(.init(current: today == 0 ? cursor : center,
                    data: .init(isActive: true, generation: "moving-anchor", revision: revision,
                                pages: pages, semanticAnchor: center.anchor),
                    locale: locale, openerFocus: focus.binding, onRequest: { _ in },
                    onBrowse: { cursor = .init(view: mode, anchor: $0) },
                    onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
                ), rightToLeft: false, todayRevision: today)
            }
            update()
            controller.view.layoutIfNeeded()
            controller.viewDidLayoutSubviews()
            await finishNativeDiff(controller)
            let collection = try #require(controller.view as? UICollectionView)
            let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
            let anchor = try #require(controller.rowIdentities.first)
            let before = try #require(rowOffset(anchor, in: collection))
            revision += 1
            update() // Identical event data still submits a revision-fenced host.
            #expect(collection.isScrollEnabled)
            // Move the real native offset while completion is pending. Merely
            // faking isDragging would not catch a rewind of this displacement.
            let start = collection.contentOffset.y
            collection.setContentOffset(CGPoint(x: 0, y: start + 24), animated: false)
            controller.scrollViewDidScroll(collection) // Duplicate delivery must not double-count.
            #expect(collection.contentOffset.y == start + 24)
            await finishNativeDiff(controller)
            #expect(abs(try #require(rowOffset(anchor, in: collection)) - (before - 24)) < 1)

            collection.setContentOffset(.zero, animated: false)
            controller.scrollViewDidScroll(collection) // Prepend is now in flight.
            #expect(try #require(controller.identities.first).anchor < center.anchor)
            let afterApply = collection.contentOffset.y
            collection.setContentOffset(CGPoint(x: 0, y: afterApply + 18), animated: false)
            controller.scrollViewDidScroll(collection)
            for period in controller.identities where period.anchor < center.anchor {
                pages[period] = .init(projection: project(period.anchor.date, view: mode, event: true),
                    loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil)
            }
            revision += 1
            update() // New heights above the same anchor, queued behind prepend.
            #expect(source.snapshot().itemIdentifiers != controller.rowIdentities)
            let beforeSecondMove = collection.contentOffset.y
            collection.setContentOffset(CGPoint(x: 0, y: beforeSecondMove + 12), animated: false)
            controller.scrollViewDidScroll(collection)
            let uncompensated = collection.contentOffset.y
            await finishNativeDiff(controller)
            #expect(abs(try #require(rowOffset(anchor, in: collection)) + 30) < 1)
            #expect(collection.contentOffset.y > uncompensated) // Prepend compensation was not skipped.
            #expect(source.snapshot().itemIdentifiers == controller.rowIdentities)
            #expect(collection.isScrollEnabled)
            assertContiguous(controller.identities)
            #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)

            revision += 1
            update()
            collection.contentOffset.y += 15
            update(today: 1) // Absolute Today supersedes both the anchor and movement.
            await finishNativeDiff(controller)
            #expect(controller.current == center)
            #expect(abs(try #require(rowOffset(anchor, in: collection))) < 1)
            #expect(collection.contentOffset == .zero)
        }
    }

    @Test func nativeOwnerStaysVisibleBeforeDeferredPrependAndHeightPublication() async throws {
        let focus = FocusHarness()
        for mode in [CalendarView.day, .week] {
            let center = CalendarAdjacentPageID(view: mode, anchor: try #require(CalendarViewportDate(date: "2028-02-29")))
            let initial = CalendarAdjacentPeriodWindow.starting(at: center)
            let controller = CalendarAdjacentViewController()
            let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { controller.clear(); window.isHidden = true }
            var cursor = center
            var revision = 1
            var pages = Dictionary(uniqueKeysWithValues: initial.map { period in
                (period, CalendarAdjacentPageData(projection: project(period.anchor.date, view: mode, event: false),
                    loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil))
            })
            func update() {
                controller.update(.init(current: cursor,
                    data: .init(isActive: true, generation: "native-continuity", revision: revision,
                                pages: pages, semanticAnchor: center.anchor),
                    locale: locale, openerFocus: focus.binding, onRequest: { _ in },
                    onBrowse: { cursor = .init(view: mode, anchor: $0) },
                    onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
                ), rightToLeft: false)
            }
            update()
            controller.view.layoutIfNeeded()
            controller.viewDidLayoutSubviews()
            await finishNativeDiff(controller)
            let collection = try #require(controller.view as? UICollectionView)
            let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
            let owner = try #require(source.snapshot().itemIdentifiers.first)
            #expect(owner.period == center)
            let originalOffset = try #require(rowOffset(owner, in: collection))
            #expect(abs(originalOffset) < 1)

            func assertVisibleOwner(_ offset: CGFloat, sourceLocation: SourceLocation = #_sourceLocation) throws {
                // Observe the actual native window, not merely an offscreen
                // estimated attribute or the geometry after the async drain.
                let path = try #require(source.indexPath(for: owner), sourceLocation: sourceLocation)
                let cell = try #require(collection.cellForItem(at: path) as? CalendarAdjacentCell,
                                        sourceLocation: sourceLocation)
                #expect(cell.rowID == owner && cell.configuredPage?.row.id == owner, sourceLocation: sourceLocation)
                #expect(collection.bounds.intersects(cell.frame), sourceLocation: sourceLocation)
                #expect(abs(cell.frame.minY - collection.contentOffset.y - collection.adjustedContentInset.top - offset) < 1,
                        sourceLocation: sourceLocation)
                #expect(collection.alpha == 1 && collection.isScrollEnabled, sourceLocation: sourceLocation)
                #expect(cell.contentView.alpha == 1 && !cell.contentView.accessibilityElementsHidden,
                        sourceLocation: sourceLocation)
            }

            controller.scrollViewDidScroll(collection) // Origin edge submits four earlier unknown periods.
            let preceding = controller.identities.filter { $0.anchor < center.anchor }
            #expect(preceding.count == CalendarAdjacentPeriodWindow.expansionCount)
            #expect(source.snapshot().itemIdentifiers.first?.period != center)
            collection.layoutIfNeeded()
            try assertVisibleOwner(originalOffset) // No yield to deferred restoration.
            #expect(collection.contentOffset.y > 0) // Compensation already happened, not just retained alpha.

            let firstMove = collection.contentOffset.y + 20
            collection.setContentOffset(CGPoint(x: 0, y: firstMove), animated: false)
            controller.scrollViewDidScroll(collection)
            collection.layoutIfNeeded()
            try assertVisibleOwner(originalOffset - 20)
            collection.setContentOffset(CGPoint(x: 0, y: collection.contentOffset.y - 8), animated: false)
            controller.scrollViewDidScroll(collection)
            collection.layoutIfNeeded()
            try assertVisibleOwner(originalOffset - 12)

            for period in preceding {
                pages[period] = .init(projection: project(period.anchor.date, view: mode, event: true),
                    loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil)
            }
            revision += 1
            update() // Queued data changes height above the still-moving owner.
            #expect(source.snapshot().itemIdentifiers != controller.rowIdentities)
            collection.layoutIfNeeded()
            try assertVisibleOwner(originalOffset - 12)
            await finishNativeDiff(controller)
            try assertVisibleOwner(originalOffset - 12)

            // A separate publication removes those rows. Its native table must
            // shrink without exposing later periods at the old numeric offset.
            let beforeRemoval = collection.contentOffset.y
            for period in preceding { pages[period] = nil }
            revision += 1
            update()
            #expect(source.snapshot().itemIdentifiers == controller.rowIdentities)
            collection.layoutIfNeeded()
            try assertVisibleOwner(originalOffset - 12) // Again BEFORE completion.
            #expect(collection.contentOffset.y < beforeRemoval)
            collection.setContentOffset(CGPoint(x: 0, y: collection.contentOffset.y + 6), animated: false)
            controller.scrollViewDidScroll(collection)
            collection.layoutIfNeeded()
            try assertVisibleOwner(originalOffset - 18)
            await finishNativeDiff(controller)
            try assertVisibleOwner(originalOffset - 18)
            #expect(controller.current == center)
            assertContiguous(controller.identities)
            #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
        }
    }

    @Test func knownWindowMaterializationAndReentryDoNotRevealButCurrentAvailabilityDoesOnce() async throws {
        let focus = FocusHarness()
        for mode in [CalendarView.day, .week] {
            let center = CalendarAdjacentPageID(view: mode, anchor: try #require(CalendarViewportDate(date: "2028-02-29")))
            let initial = CalendarAdjacentPeriodWindow.starting(at: center)
            let previous = try #require(center.previous)
            let controller = CalendarAdjacentViewController()
            let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer { controller.clear(); window.isHidden = true }
            var cursor = center
            var revision = 1
            var todayRevision = 0
            func populated(_ period: CalendarAdjacentPageID) -> CalendarAdjacentPageData {
                .init(projection: project(period.anchor.date, view: mode, event: true),
                      loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil)
            }
            // Thirteen current authorized inputs, not a visited-card history.
            var pages = Dictionary(uniqueKeysWithValues:
                (CalendarAdjacentPeriodWindow.before(center, count: 4) + initial).map { ($0, populated($0)) })
            func update() {
                controller.update(.init(current: cursor,
                    data: .init(isActive: true, generation: "arrival-classification", revision: revision,
                                pages: pages, semanticAnchor: center.anchor),
                    locale: locale, openerFocus: focus.binding, onRequest: { _ in },
                    onBrowse: { cursor = .init(view: mode, anchor: $0) },
                    onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
                ), rightToLeft: false, todayRevision: todayRevision)
            }
            update()
            controller.view.layoutIfNeeded()
            controller.viewDidLayoutSubviews()
            await finishNativeDiff(controller)
            let collection = try #require(controller.view as? UICollectionView)
            let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
            func eventID(
                _ period: CalendarAdjacentPageID, sourceLocation: SourceLocation = #_sourceLocation
            ) throws -> CalendarAdjacentRowID {
                try #require(source.snapshot().itemIdentifiers.first {
                    guard $0.period == period else { return false }
                    if case .event = $0.kind { return true }
                    return false
                }, sourceLocation: sourceLocation)
            }
            func visibleEvent(
                _ period: CalendarAdjacentPageID, sourceLocation: SourceLocation = #_sourceLocation
            ) throws -> CalendarAdjacentCell {
                let id = try eventID(period, sourceLocation: sourceLocation)
                let path = try #require(source.indexPath(for: id), sourceLocation: sourceLocation)
                let cell = try #require(collection.cellForItem(at: path) as? CalendarAdjacentCell,
                                        sourceLocation: sourceLocation)
                #expect(cell.rowID == id && cell.configuredPage?.row.id == id, sourceLocation: sourceLocation)
                #expect(collection.bounds.intersects(cell.frame), sourceLocation: sourceLocation)
                return cell
            }
            func materializeEvent(
                _ period: CalendarAdjacentPageID, sourceLocation: SourceLocation = #_sourceLocation
            ) throws -> CalendarAdjacentCell {
                // These callers already have a submitted flight. Consume its
                // native layout before seeking, but never drain its completion:
                // the incoming/known presentation assertions belong before it.
                collection.layoutIfNeeded()
                let id = try eventID(period, sourceLocation: sourceLocation)
                let path = try #require(source.indexPath(for: id), sourceLocation: sourceLocation)
                collection.scrollToItem(at: path, at: .centeredVertically, animated: false)
                collection.layoutIfNeeded()
                return try visibleEvent(period, sourceLocation: sourceLocation)
            }
            func assertSettled(_ cell: CalendarAdjacentCell) {
                #expect(cell.contentView.alpha == 1 && cell.contentView.isUserInteractionEnabled)
                #expect(!cell.contentView.accessibilityElementsHidden)
                #expect(cell.contentView.layer.animation(forKey: "calendar-event-arrival") == nil)
            }
            controller.scrollViewDidScroll(collection) // Real origin edge prepends known inputs.
            #expect(controller.identities.contains(previous))
            let newlyMaterialized = try materializeEvent(previous)
            assertSettled(newlyMaterialized) // Before completion: new to table, not new data.
            await finishNativeDiff(controller)
            // Advance far enough to trim the original center, then reverse.
            for _ in 0..<2 {
                let bottom = max(0, collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
                collection.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
                controller.scrollViewDidScroll(collection)
                await finishNativeDiff(controller)
            }
            #expect(!source.snapshot().itemIdentifiers.contains { $0.period == center })
            collection.setContentOffset(.zero, animated: false)
            controller.scrollViewDidScroll(collection)
            #expect(controller.identities.contains(center))
            let reentered = try materializeEvent(center)
            assertSettled(reentered)
            await finishNativeDiff(controller)

            // Contrast actual availability in an already rendered unknown period.
            cursor = center
            pages = [:]
            revision += 1
            update()
            await finishNativeDiff(controller)
            // Explicit navigation may be unnecessary if center already owns the
            // browse cursor. Align its civil row through the real native API.
            let civil = try #require(source.snapshot().itemIdentifiers.first { $0.period == center })
            collection.scrollToItem(at: try #require(source.indexPath(for: civil)), at: .top, animated: false)
            await finishNativeDiff(controller)
            pages[center] = populated(center)
            revision += 1
            update()
            let arrival = try materializeEvent(center)
            #expect(arrival.contentView.alpha == 0 && arrival.contentView.accessibilityElementsHidden)
            await finishNativeDiff(controller)
            let arrived = try visibleEvent(center)
            #expect(arrived.contentView.alpha == 1 && !arrived.contentView.accessibilityElementsHidden)
            #expect((arrived.contentView.layer.animation(forKey: "calendar-event-arrival") != nil) ==
                    !UIAccessibility.isReduceMotionEnabled)
            revision += 1
            update()
            await finishNativeDiff(controller)
            assertSettled(try visibleEvent(center)) // Unchanged revision cannot replay.

            // Reentry and compensation need not leave center at the window's
            // leading edge. Select an unknown retained period whose entire
            // native civil geometry is outside the actual viewport, not .last.
            collection.layoutIfNeeded()
            let retainedRows = source.snapshot().itemIdentifiers
            let offscreen = try #require(controller.identities.first { period in
                guard pages[period]?.projection == nil else { return false }
                let rows = retainedRows.filter { $0.period == period }
                return !rows.isEmpty && rows.allSatisfy { id in
                    guard let path = source.indexPath(for: id),
                          let frame = collection.layoutAttributesForItem(at: path)?.frame else { return false }
                    return !collection.bounds.intersects(frame)
                }
            })
            #expect(offscreen != center)
            pages[offscreen] = populated(offscreen)
            revision += 1
            update()
            await finishNativeDiff(controller) // Offscreen arrival is consumed here.
            let offscreenID = try eventID(offscreen)
            #expect(!collection.visibleCells.contains { ($0 as? CalendarAdjacentCell)?.rowID == offscreenID })
            let offscreenPath = try #require(source.indexPath(for: offscreenID))
            collection.scrollToItem(at: offscreenPath, at: .centeredVertically, animated: false)
            // Unlike the pre-completion checks above, this starts from a stable
            // table. The edge scroll can itself roll/trim and change indices.
            // Drain that new flight, then require the same ID in a real visible
            // host, not a cell at the old integer path or an arbitrary host.
            await finishNativeDiff(controller)
            collection.layoutIfNeeded()
            assertSettled(try visibleEvent(offscreen))

            cursor = center
            pages = [:]
            revision += 1
            // Clearing the browse cursor to the unchanged semantic center is
            // deliberately not navigation. Use the existing explicit Today
            // revision to reestablish the origin, even if center was trimmed.
            todayRevision += 1
            update()
            await finishNativeDiff(controller)
            #expect(controller.current == center && source.snapshot().itemIdentifiers.first?.period == center)
            #expect(collection.contentOffset == .zero)
            pages[center] = populated(center)
            revision += 1
            update()
            let supersededID = try eventID(center)
            let superseded = try materializeEvent(center)
            pages = [:]
            revision += 1
            update() // Latest desired removal overtakes the submitted arrival.
            #expect(source.snapshot().itemIdentifiers.contains(supersededID))
            #expect(!controller.rowIdentities.contains(supersededID))
            #expect(superseded.nativeConfiguration == nil || (superseded.contentView.alpha == 0 &&
                superseded.contentView.accessibilityElementsHidden && !superseded.contentView.isUserInteractionEnabled))
            #expect(superseded.contentView.layer.animation(forKey: "calendar-event-arrival") == nil)
            await finishNativeDiff(controller)
            #expect(!source.snapshot().itemIdentifiers.contains(supersededID))
        }
    }

    @Test func populatedWeekNativeHostingKeepsGeometryAcrossRevisionReturnTraitsAndRolling() async throws {
        let focus = FocusHarness()
        let center = CalendarAdjacentPageID(view: .week, anchor: try #require(CalendarViewportDate(date: "2028-02-29")))
        let controller = CalendarAdjacentViewController()
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        window.rootViewController = root
        root.addChild(controller)
        root.view.addSubview(controller.view)
        controller.didMove(toParent: root)
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 700)
        controller.traitOverrides.preferredContentSizeCategory = .large
        window.makeKeyAndVisible()
        defer { controller.clear(); window.isHidden = true }
        let collection = try #require(controller.view as? UICollectionView)
        let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
        let longTitle = "A longer calendar event title that wraps across several lines beside its time and scope"
        // Extend the existing in-memory shared-projection consumer fixture. No
        // persistent/domain fixture, real calendar text, or app-side data cache.
        let periods = (-12...24).compactMap { center.adding(periods: $0) }
        func populated(_ period: CalendarAdjacentPageID, title: String = longTitle) -> CalendarAdjacentPageData {
            .init(projection: project(period.anchor.date, view: .week, event: true, longTitle: title),
                  loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil)
        }
        var pages = Dictionary(uniqueKeysWithValues: periods.map { ($0, populated($0)) })
        var cursor = center
        var revision = 1
        var opened = 0
        var requests: [CalendarAdjacentViewportRequest] = []
        func update() {
            controller.update(.init(current: cursor,
                data: .init(isActive: true, generation: "native-populated-week", revision: revision,
                            pages: pages, semanticAnchor: center.anchor),
                locale: locale, openerFocus: focus.binding, onRequest: { requests.append($0) },
                onBrowse: { cursor = .init(view: .week, anchor: $0) },
                onEvent: { _ in opened += 1 }, onSelectDate: { _, _ in }, onRetry: {}
            ), rightToLeft: false, bottomOcclusion: 96)
        }
        func eventIDs(_ period: CalendarAdjacentPageID) throws -> [CalendarAdjacentRowID] {
            let ids = source.snapshot().itemIdentifiers.filter {
                guard $0.period == period else { return false }
                if case .event = $0.kind { return true }
                return false
            }
            try #require(ids.count == 2)
            return ids
        }
        func visiblePair(_ ids: [CalendarAdjacentRowID]) throws -> [CalendarAdjacentCell] {
            try ids.map { id in
                let path = try #require(source.indexPath(for: id))
                let cell = try #require(collection.cellForItem(at: path) as? CalendarAdjacentCell)
                let page = try #require(cell.configuredPage)
                #expect(cell.rowID == id && page.row.id == id)
                #expect(collection.bounds.intersects(cell.frame))
                #expect(cell.contentView is UIContentView)
                #expect((cell.contentView as? UIContentView)?.configuration is UIHostingConfiguration<CalendarAdjacentCellContent, EmptyView>)
                #expect(cell.contentView.alpha == 1 && !cell.contentView.accessibilityElementsHidden)
                #expect(cell.contentView.isUserInteractionEnabled)
                #expect(abs(cell.frame.width - collection.bounds.width) < 1)
                #expect(abs(cell.contentView.bounds.width - cell.bounds.width) < 1)
                #expect(abs(cell.contentView.bounds.height - cell.bounds.height) < 1)
                #expect(cell.frame.height >= CalendarSurfaceLayout.agendaRowHeight)
                return cell
            }
        }
        func assertFullWidthRows(sourceLocation: SourceLocation = #_sourceLocation) {
            // Include the Week ScrollView and civil headings, not only event
            // cards: each previously supplied a different intrinsic width.
            let cells = collection.visibleCells.sorted { $0.frame.minY < $1.frame.minY }
            #expect(!cells.isEmpty, sourceLocation: sourceLocation)
            for cell in cells {
                #expect(abs(cell.frame.minX) < 1, sourceLocation: sourceLocation)
                #expect(abs(cell.frame.width - collection.bounds.width) < 1, sourceLocation: sourceLocation)
            }
            for (previous, next) in zip(cells, cells.dropFirst()) {
                #expect(abs(next.frame.minY - previous.frame.maxY - Space.sm) < 1, sourceLocation: sourceLocation)
            }
        }
        func frames(_ cells: [CalendarAdjacentCell]) -> [CGRect] {
            cells.map { $0.convert($0.bounds, to: collection) }
        }
        func assertGeometry(_ actual: [CGRect], matches expected: [CGRect],
                            sourceLocation: SourceLocation = #_sourceLocation) {
            #expect(actual.count == 2 && expected.count == 2, sourceLocation: sourceLocation)
            for (a, b) in zip(actual, expected) {
                #expect(abs(a.width - b.width) < 1, sourceLocation: sourceLocation)
                #expect(abs(a.height - b.height) < 1, sourceLocation: sourceLocation)
                #expect(abs(a.minX - b.minX) < 1, sourceLocation: sourceLocation)
            }
            // Relative origins expose a changed card height/gap even when an
            // independently restored anchor happens to have the right offset.
            #expect(abs((actual[1].minY - actual[0].minY) - (expected[1].minY - expected[0].minY)) < 1,
                    sourceLocation: sourceLocation)
            #expect(abs(actual[1].minY - actual[0].maxY - Space.sm) < 1, sourceLocation: sourceLocation)
        }
        func seekPair(_ period: CalendarAdjacentPageID) async throws -> [CalendarAdjacentCell] {
            let ids = try eventIDs(period)
            let firstID = try #require(ids.first)
            collection.scrollToItem(at: try #require(source.indexPath(for: firstID)), at: .top, animated: false)
            collection.layoutIfNeeded()
            await finishNativeDiff(controller) // A real edge scroll may roll the window.
            collection.layoutIfNeeded()
            return try visiblePair(ids)
        }
        update()
        collection.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        assertFullWidthRows()
        let ids = try eventIDs(center)
        let firstPair = try await seekPair(center)
        let baseline = frames(firstPair)
        #expect(baseline[1].height > baseline[0].height)
        let originalContentViews = firstPair.map(\.contentView)
        let stalePage = try #require(firstPair[0].configuredPage)
        guard case .event(let event) = stalePage.row.content else {
            Issue.record("Expected the actual native configured event")
            return
        }
        stalePage.onEvent(event)
        #expect(opened == 1)
        // Equal visual values are newly projected objects and a new revision,
        // not an echo of the identical viewport/projection instance.
        pages = Dictionary(uniqueKeysWithValues: periods.map { ($0, populated($0)) })
        revision += 1
        update()
        collection.layoutIfNeeded() // Assert before the deferred adapter too.
        let refreshed = try visiblePair(ids)
        for (cell, contentView) in zip(refreshed, originalContentViews) {
            #expect(cell.contentView === contentView)
        }
        assertGeometry(frames(refreshed), matches: baseline)
        stalePage.onEvent(event)
        #expect(opened == 1)
        try #require(refreshed[0].configuredPage).onEvent(event)
        #expect(opened == 2)
        await finishNativeDiff(controller)
        assertGeometry(frames(try visiblePair(ids)), matches: baseline)

        let presentations = refreshed.compactMap(\.configuredPresentation)
        // Traverse real native display/reuse in small steps, not by invoking a
        // cell's fitting method or destroying/recreating its host in the test.
        for _ in 0..<6 {
            collection.contentOffset.y += 280
            collection.layoutIfNeeded()
            await finishNativeDiff(controller)
        }
        #expect(!collection.visibleCells.contains { cell in
            guard let id = (cell as? CalendarAdjacentCell)?.rowID else { return false }
            return ids.contains(id)
        })
        for _ in 0..<6 {
            collection.contentOffset.y -= 280
            collection.layoutIfNeeded()
            await finishNativeDiff(controller)
        }
        let returned = try await seekPair(center)
        assertGeometry(frames(returned), matches: baseline)
        #expect(returned.allSatisfy { $0.contentView.layer.animation(forKey: "calendar-event-arrival") == nil })
        // Inputs retained by the native configurations are either still the
        // same authorized row or retired on actual reuse, never another row.
        for (presentation, id) in zip(presentations, ids) {
            let page = presentation.page
            #expect(page == nil || page?.row.id == id)
        }

        var previous = baseline
        for (width, category) in [(CGFloat(320), UIContentSizeCategory.large),
                                  (CGFloat(320), .accessibilityExtraLarge), (CGFloat(390), .large)] {
            revision += 1
            update() // Resize while a real submitted revision awaits completion.
            controller.traitOverrides.preferredContentSizeCategory = category
            controller.view.frame.size.width = width
            controller.view.setNeedsLayout()
            collection.layoutIfNeeded()
            // The first native pass must already use the new width; waiting
            // for the controller's post-layout/anchor work was too late.
            assertFullWidthRows()
            controller.viewDidLayoutSubviews()
            await finishNativeDiff(controller)
            let pair = try await seekPair(center)
            #expect(pair.allSatisfy { $0.traitCollection.preferredContentSizeCategory == category })
            let resized = frames(pair)
            if width == 390 {
                assertGeometry(resized, matches: baseline)
            } else {
                #expect(resized[1].height > previous[1].height) // Wrapping, then the real AX composition.
            }
            // Re-entry must also be geometry-neutral at the new width/traits.
            _ = try await seekPair(try #require(center.next))
            assertGeometry(frames(try await seekPair(center)), matches: resized)
            previous = resized
        }
        pages[center] = populated(center, title: longTitle + " " + longTitle)
        revision += 1
        update()
        await finishNativeDiff(controller)
        let changed = frames(try await seekPair(center))
        #expect(changed[1].height > baseline[1].height)
        #expect(abs(changed[0].height - baseline[0].height) < 1)
        pages[center] = populated(center)
        revision += 1
        update()
        await finishNativeDiff(controller)
        assertGeometry(frames(try await seekPair(center)), matches: baseline)

        // Move the captured transaction owner completely offscreen while its
        // revision is submitted. The deferred restore must preserve the NEW
        // visible rows, not just prove a historical offscreen anchor's offset.
        revision += 1
        update()
        let destination = try #require(center.adding(periods: 2))
        let destinationIDs = try eventIDs(destination)
        let destinationID = try #require(destinationIDs.first)
        collection.scrollToItem(at: try #require(source.indexPath(for: destinationID)),
                                at: .top, animated: false)
        collection.layoutIfNeeded()
        let moving = frames(try visiblePair(destinationIDs))
        let screenY = moving[0].minY - collection.contentOffset.y
        #expect(!collection.visibleCells.contains { ($0 as? CalendarAdjacentCell)?.rowID == ids[0] })
        await finishNativeDiff(controller)
        let settled = frames(try visiblePair(destinationIDs))
        assertGeometry(settled, matches: moving)
        #expect(abs(settled[0].minY - collection.contentOffset.y - screenY) < 1)

        // Cross the native bound until the original owner is actually trimmed,
        // then roll backward and compare the real re-entered card geometry.
        for _ in 0..<4 {
            collection.contentOffset.y = max(0, collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
            controller.scrollViewDidScroll(collection)
            collection.layoutIfNeeded()
            await finishNativeDiff(controller)
            assertContiguous(controller.identities)
            #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
        }
        #expect(!controller.identities.contains(center))
        #expect(presentations.allSatisfy { $0.page == nil }) // Ownership removal retires even an unreused cell.
        for _ in 0..<4 where !controller.identities.contains(center) {
            collection.setContentOffset(.zero, animated: false)
            controller.scrollViewDidScroll(collection)
            collection.layoutIfNeeded()
            await finishNativeDiff(controller)
            assertContiguous(controller.identities)
        }
        #expect(controller.identities.contains(center))
        let reentered = try await seekPair(center)
        assertGeometry(frames(reentered), matches: baseline)
        #expect(reentered.allSatisfy { $0.contentView.layer.animation(forKey: "calendar-event-arrival") == nil })
        #expect(requests.allSatisfy { $0.periods.count <= CalendarAdjacentPeriodWindow.maximumPeriods + 1 })
        stalePage.onEvent(event)
        #expect(opened == 2)
        let currentPage = try #require(reentered[0].configuredPage)
        currentPage.onEvent(event)
        #expect(opened == 3)
        let revoked = reentered.compactMap(\.configuredPresentation)
        revision += 1
        update() // Leave a submitted revision ahead of the authority withdrawal.
        pages[center] = nil
        revision += 1
        update()
        #expect(reentered.allSatisfy { $0.contentConfiguration == nil && $0.configuredPage == nil })
        #expect(revoked.allSatisfy { $0.page == nil })
        currentPage.onEvent(event)
        #expect(opened == 3)
        await finishNativeDiff(controller)
        #expect(!controller.rowIdentities.contains { ids.contains($0) })
        #expect(!controller.rowIdentities.contains { $0.period == center && $0.kind == .empty })
    }

    @Test func nativeRowHeightsIgnoreScrollPositionSafeAreaAndUseResizedColumnWidth() async throws {
        let focus = FocusHarness()
        let center = CalendarAdjacentPageID(view: .week, anchor: try #require(CalendarViewportDate(date: "2028-02-29")))
        let controller = CalendarAdjacentViewController()
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        window.rootViewController = root
        // Exercise real public safe-area propagation even on a scene without
        // a notch. Only the outer owner receives this synthetic occlusion.
        root.additionalSafeAreaInsets.top = 59
        root.addChild(controller)
        root.view.addSubview(controller.view)
        controller.didMove(toParent: root)
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 700)
        controller.traitOverrides.preferredContentSizeCategory = .large
        window.makeKeyAndVisible()
        defer { controller.clear(); window.isHidden = true }
        let collection = try #require(controller.view as? UICollectionView)
        // Fixed topology isolates the demonstrated native sizing defect from
        // browse/anchor capture and rolling. Their contracts stay tested above.
        collection.delegate = nil
        let periods = CalendarAdjacentPeriodWindow.starting(at: center)
        let pages = Dictionary(uniqueKeysWithValues: periods.map { period in
            (period, CalendarAdjacentPageData(
                projection: project(period.anchor.date, view: .week, event: true,
                    longTitle: "A longer calendar event title that wraps across several lines beside its time and scope"),
                loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil
            ))
        })
        controller.update(.init(current: center,
            data: .init(isActive: true, generation: "native-safe-area", revision: 1,
                        pages: pages, semanticAnchor: center.anchor),
            locale: locale, openerFocus: focus.binding, onRequest: { _ in }, onBrowse: { _ in },
            onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
        ), rightToLeft: false, bottomOcclusion: 96)
        collection.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let display = AdjacentDisplayFrame()
        // Snapshot drain is not native display. Observe a fixed two callbacks,
        // never repeat layout or wait until a geometry assertion happens to pass.
        await display.next()
        await display.next()
        let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
        let topology = source.snapshot().itemIdentifiers
        let ids = topology.filter {
            guard $0.period == center else { return false }
            if case .event = $0.kind { return true }
            return false
        }
        try #require(ids.count == 2)
        let safeArea = collection.safeAreaInsets
        let outerSafeArea = root.view.safeAreaInsets
        let windowSafeArea = window.safeAreaInsets
        try #require(safeArea.top > 0 && safeArea.top < collection.bounds.height / 2)

        func pairFrames() throws -> [CGRect] {
            try ids.map { id in
                // cellForItem also returns prepared cells. Require a native
                // visible owner intersecting the viewport, including clipped rows.
                let cell = try #require(collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }
                    .first { $0.rowID == id && collection.bounds.intersects($0.frame) })
                #expect(cell.configuredPage?.row.id == id)
                #expect(cell.contentView.alpha == 1 && cell.contentView.isUserInteractionEnabled)
                #expect(!cell.contentView.accessibilityElementsHidden)
                #expect(abs(cell.contentView.bounds.width - cell.bounds.width) < 1)
                #expect(abs(cell.contentView.bounds.height - cell.bounds.height) < 1)
                #expect(cell.frame.height >= CalendarSurfaceLayout.agendaRowHeight)
                return cell.frame
            }
        }
        func assertColumn(sourceLocation: SourceLocation = #_sourceLocation) {
            let visible = collection.visibleCells.filter { collection.bounds.intersects($0.frame) }
                .sorted { $0.frame.minY < $1.frame.minY }
            #expect(!visible.isEmpty, sourceLocation: sourceLocation)
            for cell in visible {
                #expect(abs(cell.frame.minX) < 1, sourceLocation: sourceLocation)
                #expect(abs(cell.frame.width - collection.bounds.width) < 1, sourceLocation: sourceLocation)
            }
            for (previous, next) in zip(visible, visible.dropFirst()) {
                #expect(abs(next.frame.minY - previous.frame.maxY - Space.sm) < 1, sourceLocation: sourceLocation)
            }
            #expect(abs(collection.contentSize.width - collection.bounds.width) < 1, sourceLocation: sourceLocation)
            #expect(source.snapshot().itemIdentifiers == topology, sourceLocation: sourceLocation)
            #expect(collection.safeAreaInsets == safeArea, sourceLocation: sourceLocation)
            #expect(root.view.safeAreaInsets == outerSafeArea, sourceLocation: sourceLocation)
            #expect(window.safeAreaInsets == windowSafeArea, sourceLocation: sourceLocation)
            #expect(collection.verticalScrollIndicatorInsets.bottom == 96, sourceLocation: sourceLocation)
        }
        func moveShortRow(to y: CGFloat) throws {
            let path = try #require(source.indexPath(for: ids[0]))
            let frame = try #require(collection.layoutAttributesForItem(at: path)?.frame)
            collection.setContentOffset(CGPoint(x: 0, y: frame.minY - y), animated: false)
            collection.layoutIfNeeded()
        }
        var original: [CGRect] = []
        for width in [CGFloat(390), 320, 390] {
            controller.view.frame.size.width = width
            collection.layoutIfNeeded()
            assertColumn() // First native resize pass, before controller post-layout work.
            try moveShortRow(to: safeArea.top + Space.sm)
            await display.next()
            await display.next()
            let baseline = try pairFrames()
            #expect(baseline[0].height == CalendarSurfaceLayout.agendaRowHeight)
            #expect(baseline[1].height > baseline[0].height)
            #expect(baseline[0].minY - collection.bounds.minY >= safeArea.top)
            if original.isEmpty {
                original = baseline
            } else if width == 390 {
                for (frame, prior) in zip(baseline, original) {
                    #expect(abs(frame.height - prior.height) < 1)
                }
            } else {
                #expect(baseline[1].height > original[1].height)
            }
            // Cross a partial container inset, then put the short row partly
            // above the viewport, then return. Same IDs/data/width throughout.
            for y in [safeArea.top / 2, -CalendarSurfaceLayout.agendaRowHeight / 2, safeArea.top + Space.sm] {
                try moveShortRow(to: y)
                for _ in 0..<2 {
                    await display.next()
                    assertColumn()
                    let actual = try pairFrames()
                    #expect(abs(actual[0].minY - collection.bounds.minY - y) < 1)
                    for (frame, prior) in zip(actual, baseline) {
                        #expect(abs(frame.height - prior.height) < 1)
                    }
                    #expect(abs(actual[1].minY - actual[0].maxY - Space.sm) < 1)
                }
            }
        }
    }

    @Test func controllerOwnsOneVerticalRecyclerAndFlattensRows() async throws {
        let focusHarness = FocusHarness()
        let focus = focusHarness.binding
        let center = CalendarAdjacentPageID(
            view: .day, anchor: try #require(CalendarViewportDate(date: "2028-02-29"))
        )
        let controller = CalendarAdjacentViewController()
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 600)

        var requests: [CalendarAdjacentViewportRequest] = []
        let page = CalendarAdjacentPageData(
            projection: project(center.anchor.date, view: .day, event: true),
            loading: CalendarLoadingState(phase: .idle), freshness: .fresh, offline: .online, error: nil
        )
        let data = CalendarAdjacentViewportData(
            isActive: true, generation: "vertical", revision: 1, pages: [center: page]
        )
        controller.update(
            CalendarAdjacentViewport(
                current: center, data: data, locale: locale, openerFocus: focus,
                onRequest: { requests.append($0) }, onBrowse: { _ in }, onEvent: { _ in },
                onSelectDate: { _, _ in }, onRetry: {}
            ),
            rightToLeft: false
        )
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)

        let collection = try #require(controller.view as? UICollectionView)
        // Assert the one-column consumer geometry, not a particular layout class.
        let frames = try controller.rowIdentities.indices.map { index in
            try #require(collection.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame)
        }
        for frame in frames {
            #expect(abs(frame.minX) < 1 && abs(frame.width - collection.bounds.width) < 1)
        }
        for (previous, next) in zip(frames, frames.dropFirst()) {
            #expect(abs(next.minY - previous.maxY - Space.sm) < 1)
        }
        #expect(controller.identities.count == 9)
        #expect(controller.rowIdentities.count > controller.identities.count)
        #expect(requests.count == 1)
        #expect(requests[0].periods.first == center.anchor)
        #expect(requests[0].periods.count <= CalendarAdjacentPeriodWindow.maximumPeriods + 1)
        #expect(controller.rowIdentities.contains { row in
            guard row.period == center else { return false }
            if case .event = row.kind { return true }
            return false
        })
        #expect(!controller.rowIdentities.contains { $0.kind == .status })
        #expect(controller.rowIdentities.filter { $0.period != center }.allSatisfy { row in
            if case .dayHeading = row.kind { return true }
            return false
        })
    }

    @Test func sequentialExpansionAndReversalStayBoundedAndPreserveLeadingRow() async throws {
        let focusHarness = FocusHarness()
        let focus = focusHarness.binding
        let center = CalendarAdjacentPageID(
            view: .day, anchor: try #require(CalendarViewportDate(date: "2028-02-29"))
        )
        let controller = CalendarAdjacentViewController()
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 500)
        var requests: [CalendarAdjacentViewportRequest] = []
        controller.update(
            CalendarAdjacentViewport(
                current: center,
                data: .init(isActive: true, generation: "rolling", revision: 1, pages: [:]),
                locale: locale, openerFocus: focus,
                onRequest: { requests.append($0) }, onBrowse: { _ in }, onEvent: { _ in },
                onSelectDate: { _, _ in }, onRetry: {}
            ),
            rightToLeft: false
        )
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        collection.layoutIfNeeded()
        let initialFirst = try #require(controller.identities.first)
        let initialLast = try #require(controller.identities.last)

        for _ in 0..<10 {
            collection.setContentOffset(
                CGPoint(x: 0, y: max(0, collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)),
                animated: false
            )
            controller.scrollViewDidScroll(collection)
            await finishNativeDiff(controller)
            #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
            #expect(controller.rowIdentities.count <= CalendarAdjacentPeriodWindow.maximumPeriods * 2)
            assertContiguous(controller.identities)
        }
        let forward = try #require(controller.identities.last)
        #expect(initialLast.anchor < forward.anchor)

        for _ in 0..<10 {
            collection.setContentOffset(CGPoint(x: 0, y: 0), animated: false)
            controller.scrollViewDidScroll(collection)
            await finishNativeDiff(controller)
            #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
            #expect(controller.identities.first?.anchor.date != nil)
            assertContiguous(controller.identities)
        }
        let reverse = try #require(controller.identities.first)
        #expect(reverse.anchor < initialFirst.anchor)
        #expect(forward.anchor > reverse.anchor)
        let traversalRequestsValid = requests.allSatisfy { request in
            let periodsEligible = request.periods.allSatisfy { period in
                period.isAdjacentViewportEligible
            }
            return request.periods.count <= CalendarAdjacentPeriodWindow.maximumPeriods + 1 &&
                periodsEligible
        }
        #expect(traversalRequestsValid)
    }

    @Test func dayPrefetchPressureRetainsWholeVisiblePeriodAndKeepsRollingAndRevealing() async throws {
        let focus = FocusHarness()
        let center = CalendarAdjacentPageID(view: .day, anchor: try #require(CalendarViewportDate(date: "2028-02-29")))
        let pressure = try #require(center.adding(periods: 5))
        let controller = CalendarAdjacentViewController()
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        window.rootViewController = root
        root.addChild(controller)
        root.view.addSubview(controller.view)
        controller.didMove(toParent: root)
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 665)
        controller.traitOverrides.preferredContentSizeCategory = .large
        window.makeKeyAndVisible()
        defer { controller.clear(); window.isHidden = true }
        var cursor = center
        var revision = 1
        var requests: [CalendarAdjacentViewportRequest] = []
        // A dense leading day followed by compact unknown civil days creates
        // pixel prefetch pressure before that leading PERIOD is safe to evict.
        // Real hosted wrapping, not a fixed-height cell or injected anchor state.
        let title = String(repeating: "Calendar planning with additional preparation. ", count: 48)
        var pages = [pressure: CalendarAdjacentPageData(
            projection: project(pressure.anchor.date, view: .day, event: true, longTitle: title),
            loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil
        )]
        func update() {
            controller.update(.init(current: cursor,
                data: .init(isActive: true, generation: "day-prefetch-pressure", revision: revision,
                            pages: pages, semanticAnchor: center.anchor),
                locale: locale, openerFocus: focus.binding, onRequest: { requests.append($0) },
                onBrowse: { cursor = .init(view: .day, anchor: $0) },
                onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
            ), rightToLeft: false, bottomOcclusion: 96)
        }
        update()
        controller.view.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
        // Two ordinary endpoint traversals construct the full bounded window:
        // nine -> thirteen -> fifteen, without private rolling/state injection.
        for _ in 0..<2 {
            collection.setContentOffset(CGPoint(x: 0, y: max(0,
                collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)), animated: false)
            controller.scrollViewDidScroll(collection)
            await finishNativeDiff(controller)
        }
        try #require(controller.identities.count == CalendarAdjacentPeriodWindow.maximumPeriods)
        try #require(controller.identities.firstIndex(of: pressure) == 3)
        let beforePeriods = controller.identities
        let eventIDs = source.snapshot().itemIdentifiers.filter {
            guard $0.period == pressure else { return false }
            if case .event = $0.kind { return true }
            return false
        }
        try #require(eventIDs.count == 2)
        let ownerID = try #require(eventIDs.last)
        let ownerPath = try #require(source.indexPath(for: ownerID))
        // Setup only: materialize the exact pressure position without triggering
        // prefetch before its preconditions have been measured. The actual roll
        // below uses the unchanged real delegate and native table/offset.
        collection.delegate = nil
        collection.scrollToItem(at: ownerPath, at: .top, animated: false)
        collection.layoutIfNeeded()
        let display = AdjacentDisplayFrame()
        await display.next()
        await display.next()
        let owner = try #require(collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }
            .first { $0.rowID == ownerID && collection.bounds.intersects($0.frame) })
        try #require(owner.frame.height > collection.bounds.height)
        let threshold = max(collection.bounds.height * 0.75, 240)
        // A native browse can also change visible-first priority without any
        // rolling at all; it must not wait for a later diff to renew the lease.
        let interiorY = (collection.contentSize.height - collection.bounds.height) / 2
        try #require(interiorY > owner.frame.minY && interiorY < owner.frame.maxY)
        try #require(interiorY > threshold)
        try #require(collection.contentSize.height - interiorY - collection.bounds.height > threshold)
        collection.setContentOffset(CGPoint(x: 0, y: interiorY), animated: false)
        collection.layoutIfNeeded()
        collection.delegate = controller
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        #expect(controller.identities == beforePeriods)
        #expect(controller.current == pressure && cursor == pressure)
        #expect(requests.last?.periods.first == pressure.anchor)
        collection.delegate = nil
        collection.setContentOffset(CGPoint(x: 0,
            y: owner.frame.maxY - CalendarSurfaceLayout.agendaRowHeight - collection.adjustedContentInset.top), animated: false)
        collection.layoutIfNeeded()
        await display.next()
        await display.next()
        let beforeOffset = try #require(rowOffset(ownerID, in: collection))
        try #require(beforeOffset < 0 && collection.bounds.intersects(owner.frame))
        try #require(collection.contentOffset.y + collection.adjustedContentInset.top > threshold)
        try #require(collection.contentSize.height - collection.bounds.maxY <= threshold)
        #expect(owner.configuredPage?.row.id == ownerID)
        #expect(owner.contentView.alpha == 1 && !owner.contentView.accessibilityElementsHidden)
        collection.delegate = controller

        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        // The old fixed four-period trim removed pressure (index 3) entirely,
        // leaving a permanently failing anchor and hidden known rows. Only the
        // three periods genuinely behind this native owner may leave now.
        #expect(controller.identities.first == pressure)
        #expect(controller.identities.last == beforePeriods.last?.adding(periods: 3))
        #expect(controller.identities.count == CalendarAdjacentPeriodWindow.maximumPeriods)
        assertContiguous(controller.identities)
        #expect(source.snapshot().itemIdentifiers == controller.rowIdentities)
        #expect(abs(try #require(rowOffset(ownerID, in: collection)) - beforeOffset) < 1)
        let retained = try #require(collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }
            .first { $0.rowID == ownerID && collection.bounds.intersects($0.frame) })
        #expect(retained.configuredPage?.row.id == ownerID)
        #expect(retained.contentView.alpha == 1 && retained.contentView.isUserInteractionEnabled)
        #expect(!retained.contentView.accessibilityElementsHidden)
        #expect(controller.current == pressure && cursor == pressure)
        #expect(requests.last?.periods.first == pressure.anchor)

        let heldPeriods = controller.identities
        let heldRequest = requests.last
        controller.scrollViewDidScroll(collection) // Still near the edge, but no safe prefix remains.
        await finishNativeDiff(controller)
        #expect(controller.identities == heldPeriods)
        #expect(requests.last == heldRequest)
        #expect(collection.isScrollEnabled)
        #expect(abs(try #require(rowOffset(ownerID, in: collection)) - beforeOffset) < 1)

        let next = try #require(pressure.next)
        let nextHeading = CalendarAdjacentRowID(period: next, kind: .dayHeading(next.anchor.date))
        collection.scrollToItem(at: try #require(source.indexPath(for: nextHeading)), at: .top, animated: false)
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        // Advancing the visible owner permits another partial roll; the no-op
        // above must not mark a permanent expansion/domain boundary.
        #expect(controller.identities.first == next)
        #expect(controller.identities.last == heldPeriods.last?.next)
        #expect(controller.current == next && cursor == next)
        #expect(requests.last?.periods.first == next.anchor)
        #expect(abs(try #require(rowOffset(nextHeading, in: collection))) < 1)

        let following = try #require(next.next)
        pages[next] = .init(projection: project(next.anchor.date, view: .day, event: false),
                            loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil)
        pages[following] = .init(projection: project(following.anchor.date, view: .day, event: true),
                                 loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil)
        revision += 1
        update()
        await finishNativeDiff(controller)
        let emptyID = CalendarAdjacentRowID(period: next, kind: .empty)
        let arrivalID = try #require(controller.rowIdentities.first {
            guard $0.period == following else { return false }
            if case .event = $0.kind { return true }
            return false
        })
        for id in [emptyID, arrivalID] {
            let cell = try #require(collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }
                .first { $0.rowID == id && collection.bounds.intersects($0.frame) })
            #expect(cell.configuredPage?.row.id == id)
            #expect(cell.contentView.alpha == 1 && cell.contentView.isUserInteractionEnabled)
            #expect(!cell.contentView.accessibilityElementsHidden)
        }
        #expect(controller.current == next && requests.last?.periods.first == next.anchor)

        let forwardFirst = try #require(controller.identities.first)
        collection.setContentOffset(CGPoint(x: 0, y: -Space.sm), animated: false)
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        #expect(try #require(controller.identities.first).anchor < forwardFirst.anchor)
        #expect(controller.identities.contains(next))
        #expect(abs(try #require(rowOffset(nextHeading, in: collection)) - Space.sm) < 1)
        #expect(controller.current == next && cursor == next)
        #expect(requests.last?.periods.first == next.anchor)
        // Actually browse backward into the re-entered period, not merely test
        // that four IDs were prepended while the header remained stationary.
        let pressureHeading = CalendarAdjacentRowID(period: pressure, kind: .dayHeading(pressure.anchor.date))
        collection.scrollToItem(at: try #require(source.indexPath(for: pressureHeading)), at: .top, animated: false)
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        #expect(controller.current == pressure && cursor == pressure)
        #expect(requests.last?.periods.first == pressure.anchor)
        #expect(abs(try #require(rowOffset(pressureHeading, in: collection))) < 1)
        #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
        #expect(requests.allSatisfy { $0.periods.count <= CalendarAdjacentPeriodWindow.maximumPeriods + 1 })
        assertContiguous(controller.identities)
    }

    @Test func backwardDayPrefetchRetainsWholeVisiblePeriodBeforeTrimmingItsTail() async throws {
        let focus = FocusHarness()
        let center = CalendarAdjacentPageID(view: .day, anchor: try #require(CalendarViewportDate(date: "2028-02-29")))
        let pressure = try #require(center.adding(periods: 13))
        let controller = CalendarAdjacentViewController()
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        window.rootViewController = root
        root.addChild(controller)
        root.view.addSubview(controller.view)
        controller.didMove(toParent: root)
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 665)
        controller.traitOverrides.preferredContentSizeCategory = .large
        window.makeKeyAndVisible()
        defer { controller.clear(); window.isHidden = true }
        var cursor = center
        var requests: [CalendarAdjacentViewportRequest] = []
        let page = CalendarAdjacentPageData(
            projection: project(pressure.anchor.date, view: .day, event: true,
                longTitle: String(repeating: "Calendar planning with additional preparation. ", count: 48)),
            loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil)
        controller.update(.init(current: center,
            data: .init(isActive: true, generation: "backward-day-pressure", revision: 1, pages: [pressure: page]),
            locale: locale, openerFocus: focus.binding, onRequest: { requests.append($0) },
            onBrowse: { cursor = .init(view: .day, anchor: $0) }, onEvent: { _ in },
            onSelectDate: { _, _ in }, onRetry: {}
        ), rightToLeft: false, bottomOcclusion: 96)
        controller.view.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
        for _ in 0..<2 {
            collection.setContentOffset(CGPoint(x: 0, y: max(0,
                collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)), animated: false)
            controller.scrollViewDidScroll(collection)
            await finishNativeDiff(controller)
        }
        try #require(controller.identities.count == CalendarAdjacentPeriodWindow.maximumPeriods)
        try #require(controller.identities.firstIndex(of: pressure) == 11)
        let before = controller.identities
        let heading = CalendarAdjacentRowID(period: pressure, kind: .dayHeading(pressure.anchor.date))
        collection.delegate = nil // Measure the symmetric pressure case before allowing its roll.
        collection.scrollToItem(at: try #require(source.indexPath(for: heading)), at: .top, animated: false)
        collection.layoutIfNeeded()
        let display = AdjacentDisplayFrame()
        await display.next()
        await display.next()
        let offset = try #require(rowOffset(heading, in: collection))
        let threshold = max(collection.bounds.height * 0.75, 240)
        try #require(abs(offset) < 1)
        try #require(collection.contentOffset.y + collection.adjustedContentInset.top <= threshold)
        try #require(collection.contentSize.height - collection.bounds.maxY > threshold)
        try #require(collection.visibleCells.contains {
            ($0 as? CalendarAdjacentCell)?.rowID == heading && collection.bounds.intersects($0.frame)
        })
        collection.delegate = controller
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        // A four-period tail trim would remove index 11, including the visible
        // heading/cards. Prepend only the three NEAREST predecessors instead.
        #expect(controller.identities.first == before.first?.adding(periods: -3))
        #expect(controller.identities.last == pressure)
        #expect(controller.identities.count == CalendarAdjacentPeriodWindow.maximumPeriods)
        assertContiguous(controller.identities)
        #expect(abs(try #require(rowOffset(heading, in: collection)) - offset) < 1)
        #expect(controller.current == pressure && cursor == pressure)
        #expect(requests.last?.periods.first == pressure.anchor)
        let visibleEvent = try #require(collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }.first {
            guard $0.rowID?.period == pressure, collection.bounds.intersects($0.frame) else { return false }
            if case .event = $0.rowID?.kind { return true }
            return false
        })
        #expect(visibleEvent.configuredPage?.row.period == pressure)
        #expect(visibleEvent.contentView.alpha == 1 && !visibleEvent.contentView.accessibilityElementsHidden)
        #expect(visibleEvent.contentView.isUserInteractionEnabled)

        // Moving genuinely earlier frees the old trailing card period. It must
        // not remain protected by an offscreen host or a remembered cursor.
        let earlier = try #require(controller.identities.first)
        collection.setContentOffset(.zero, animated: false)
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        #expect(try #require(controller.identities.first).anchor < earlier.anchor)
        #expect(!controller.identities.contains(pressure))
        #expect(controller.current == earlier && cursor == earlier)
        #expect(requests.last?.periods.first == earlier.anchor)
        #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
        assertContiguous(controller.identities)
    }

    @Test func compactFullDayWindowAllowsBackwardPullWithoutLosingNativeOwner() async throws {
        let focus = FocusHarness()
        let center = CalendarAdjacentPageID(view: .day, anchor: try #require(CalendarViewportDate(date: "2028-02-29")))
        let controller = CalendarAdjacentViewController()
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        window.rootViewController = root
        root.addChild(controller)
        root.view.addSubview(controller.view)
        controller.didMove(toParent: root)
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        controller.traitOverrides.preferredContentSizeCategory = .large
        window.makeKeyAndVisible()
        defer { controller.clear(); window.isHidden = true }
        var cursor = center
        var requests: [CalendarAdjacentViewportRequest] = []
        controller.update(.init(current: center,
            data: .init(isActive: true, generation: "compact-full-window", revision: 1, pages: [:]),
            locale: locale, openerFocus: focus.binding, onRequest: { requests.append($0) },
            onBrowse: { cursor = .init(view: .day, anchor: $0) }, onEvent: { _ in },
            onSelectDate: { _, _ in }, onRetry: {}
        ), rightToLeft: false, bottomOcclusion: 96)
        controller.view.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        for _ in 0..<2 {
            collection.setContentOffset(CGPoint(x: 0, y: max(0,
                collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)), animated: false)
            controller.scrollViewDidScroll(collection)
            await finishNativeDiff(controller)
        }
        try #require(controller.identities.count == CalendarAdjacentPeriodWindow.maximumPeriods)
        let first = try #require(controller.identities.first)
        let last = try #require(controller.identities.last)
        let heading = CalendarAdjacentRowID(period: first, kind: .dayHeading(first.anchor.date))
        collection.delegate = nil // Setup the saturated usable viewport before invoking the real owner.
        collection.setContentOffset(.zero, animated: false)
        collection.layoutIfNeeded()
        let display = AdjacentDisplayFrame()
        await display.next()
        await display.next()
        try #require(collection.contentSize.height < collection.bounds.height - 96)
        let usable = CGRect(x: 0, y: 0, width: collection.bounds.width, height: collection.bounds.height - 96)
        let visiblePeriods = Set(collection.visibleCells.compactMap { cell -> CalendarAdjacentPageID? in
            guard cell.frame.intersects(usable) else { return nil }
            return (cell as? CalendarAdjacentCell)?.rowID?.period
        })
        try #require(visiblePeriods.count == CalendarAdjacentPeriodWindow.maximumPeriods)
        collection.delegate = controller
        collection.setContentOffset(CGPoint(x: 0, y: -Space.sm), animated: false)
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        // All fifteen compact periods fit. Retaining every overscan heading
        // would deadlock earlier history. The existing four-period traversal
        // remains possible while its real leading civil owner stays anchored.
        #expect(controller.identities.first == first.adding(periods: -CalendarAdjacentPeriodWindow.expansionCount))
        #expect(controller.identities.last == last.adding(periods: -CalendarAdjacentPeriodWindow.expansionCount))
        #expect(controller.identities.count == CalendarAdjacentPeriodWindow.maximumPeriods)
        #expect(controller.identities.contains(first))
        #expect(abs(try #require(rowOffset(heading, in: collection)) - Space.sm) < 1)
        #expect(controller.current == first && cursor == first)
        #expect(requests.last?.periods.first == first.anchor)
        assertContiguous(controller.identities)

        let earlier = try #require(controller.identities.first)
        collection.setContentOffset(.zero, animated: false)
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        #expect(try #require(controller.identities.first).anchor < earlier.anchor)
        #expect(controller.identities.contains(earlier))
        #expect(controller.current == earlier && cursor == earlier)
        #expect(requests.last?.periods.first == earlier.anchor)
        #expect(collection.isScrollEnabled)
        #expect(controller.rowIdentities.allSatisfy {
            if case .dayHeading = $0.kind { return true }
            return false
        })
    }

    @Test func protectedEventsDoNotPunchGapsAndReleaseAfterFocusReturns() async throws {
        let focusHarness = FocusHarness()
        let focus = focusHarness.binding
        let center = CalendarAdjacentPageID(
            view: .day, anchor: try #require(CalendarViewportDate(date: "2028-02-29"))
        )
        let initial = CalendarAdjacentPeriodWindow.starting(at: center)

        for target in [try #require(initial.first), try #require(initial.last)] {
            let controller = CalendarAdjacentViewController()
            controller.loadViewIfNeeded()
            controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 500)
            var requests: [CalendarAdjacentViewportRequest] = []
            var opened = 0
            let pages = Dictionary(uniqueKeysWithValues: initial.map { period in
                (
                    period,
                    CalendarAdjacentPageData(
                        projection: project(period.anchor.date, view: .day, event: period == target),
                        loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil
                    )
                )
            })
            let input = CalendarAdjacentViewport(
                current: center,
                data: .init(isActive: true, generation: "protected-\(target.anchor.date)", revision: 1, pages: pages),
                locale: locale, openerFocus: focus,
                onRequest: { requests.append($0) }, onBrowse: { _ in },
                onEvent: { _ in opened += 1 }, onSelectDate: { _, _ in }, onRetry: {}
            )
            controller.update(input, rightToLeft: false)
            controller.viewDidLayoutSubviews()
            await finishNativeDiff(controller)

            let collection = try #require(controller.view as? UICollectionView)
            let eventID = try #require(pages[target]?.projection?.visibleEvents.first?.actionIdentity.stableKey)
            let rowID = try #require(controller.rowIdentities.first { row in
                guard row.period == target else { return false }
                if case .event = row.kind { return true }
                return false
            })
            let index = try #require(controller.rowIdentities.firstIndex(of: rowID))
            collection.scrollToItem(at: IndexPath(item: index, section: 0), at: .centeredVertically, animated: false)
            collection.layoutIfNeeded()
            // Moving an edge period into view can synchronously roll the
            // contiguous working set. Resolve the stable row identity again;
            // the old integer index may now identify a different recycled row.
            await finishNativeDiff(controller)
            collection.layoutIfNeeded()
            let renderedIndex = try #require(controller.rowIdentities.firstIndex(of: rowID))
            let cell = try #require(
                collection.cellForItem(at: IndexPath(item: renderedIndex, section: 0)) as? CalendarAdjacentCell
            )
            #expect(cell.rowID == rowID)
            let hostedPage = try #require(cell.configuredPage)
            #expect(hostedPage.row.id == rowID)
            guard case .event(let hostedEvent) = hostedPage.row.content else {
                Issue.record("The recycled event cell must host the requested event row")
                return
            }
            #expect(hostedEvent.actionIdentity.stableKey == eventID)
            // SwiftUI's virtual AX children are not a UIView descendants tree
            // in this detached-controller test. Exercise the actual hosted
            // event's action (also used by its accessible Button), not a VM
            // shortcut or a guessed accessibility element.
            hostedPage.onEvent(hostedEvent)
            #expect(opened == 1)

            let direction: CGFloat = target == initial.first ? 1 : -1
            for _ in 0..<12 {
                let y = direction > 0
                    ? max(0, collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
                    : 0
                collection.setContentOffset(CGPoint(x: 0, y: y), animated: false)
                controller.scrollViewDidScroll(collection)
                await finishNativeDiff(controller)
                #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
                assertContiguous(controller.identities)
            }

            #expect(!controller.identities.contains(target))
            let protectedRequestsValid = requests.allSatisfy { request in
                let periodsEligible = request.periods.allSatisfy { period in
                    period.isAdjacentViewportEligible
                }
                return request.periods.count <= CalendarAdjacentPeriodWindow.maximumPeriods + 1 &&
                    periodsEligible
            }
            #expect(protectedRequestsValid)
            let protectedRequest = try #require(requests.last)
            #expect(protectedRequest.periods.filter { $0 == target.anchor }.count == 1)
            let awayBoundary = try #require(direction > 0 ? controller.identities.last : controller.identities.first)

            for _ in 0..<3 {
                let y = direction > 0 ? 0 : max(0, collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
                collection.setContentOffset(CGPoint(x: 0, y: y), animated: false)
                controller.scrollViewDidScroll(collection)
                await finishNativeDiff(controller)
                #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
                assertContiguous(controller.identities)
            }
            let reversedBoundary = try #require(direction > 0 ? controller.identities.first : controller.identities.last)
            if direction > 0 {
                #expect(reversedBoundary.anchor < awayBoundary.anchor)
            } else {
                #expect(reversedBoundary.anchor > awayBoundary.anchor)
            }
            #expect(!controller.identities.contains(target))

            let awayCurrent = try #require(controller.current)
            #expect(controller.identities.contains(awayCurrent))
            #expect(awayCurrent != target)
            let source = try #require(
                collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>
            )
            #expect(!source.snapshot().itemIdentifiers.contains { $0.period == target })
            let requiredPeriods = Set(controller.identities.map(\.anchor))
            let beforeRelease = try #require(requests.last)
            #expect(Set(beforeRelease.periods) == requiredPeriods.union([target.anchor]))
            #expect(beforeRelease.periods.count == requiredPeriods.count + 1)

            // This fixture has no live AX element for the pruned event. Setting
            // AccessibilityFocusState would request focus, not deliver a return
            // observation. Feed the same typed observation consumed by update.
            controller.accessibilityFocusDidChange(.addControl)
            #expect(requests.last == beforeRelease)
            controller.accessibilityFocusDidChange(.event(eventID))
            await finishNativeDiff(controller)
            #expect(requests.last?.periods.contains(target.anchor) == false)
            let released = try #require(requests.last)
            #expect(Set(released.periods) == requiredPeriods)
            #expect(released.periods.first == awayCurrent.anchor)

            func inputFor(_ current: CalendarAdjacentPageID) -> CalendarAdjacentViewport {
                CalendarAdjacentViewport(
                    current: current, data: input.data, locale: locale, openerFocus: focus,
                    onRequest: { requests.append($0) }, onBrowse: { _ in },
                    onEvent: { _ in opened += 1 }, onSelectDate: { _, _ in }, onRetry: {}
                )
            }
            // Returning to the event makes its period required again, whether
            // or not it also has the one optional protection slot.
            controller.update(inputFor(target), rightToLeft: false)
            await finishNativeDiff(controller)
            let returnedPath = try #require(source.indexPath(for: rowID))
            #expect(collection.indexPathsForVisibleItems.contains(returnedPath))
            let returnedCell = try #require(collection.cellForItem(at: returnedPath) as? CalendarAdjacentCell)
            let returnedPage = try #require(returnedCell.configuredPage)
            #expect(returnedPage.row.id == rowID)
            returnedPage.onEvent(hostedEvent)
            #expect(opened == 2)
            let visiblePeriods = controller.identities
            let visibleOffset = collection.contentOffset.y
            controller.accessibilityFocusDidChange(nil)
            controller.accessibilityFocusDidChange(.event(eventID))
            let visibleRequest = try #require(requests.last)
            #expect(visibleRequest.periods.filter { $0 == target.anchor }.count == 1)
            #expect(Set(visibleRequest.periods) == Set(visiblePeriods.map(\.anchor)))
            #expect(controller.identities == visiblePeriods)
            #expect(collection.contentOffset.y == visibleOffset)

            // Retention above was ordinary window authority, not lingering
            // protection: an explicit departure must now drop the event period.
            controller.update(inputFor(awayCurrent), rightToLeft: false)
            await finishNativeDiff(controller)
            #expect(!controller.identities.contains(target))
            #expect(requests.last?.periods.contains(target.anchor) == false)
            controller.clear()
            await finishNativeDiff(controller)
        }
    }

    @Test func prependKeepsTheSameVisibleRowOffsetWhenRowsArriveAboveIt() async throws {
        let focusHarness = FocusHarness()
        let focus = focusHarness.binding
        let center = CalendarAdjacentPageID(
            view: .day, anchor: try #require(CalendarViewportDate(date: "2028-02-29"))
        )
        let controller = CalendarAdjacentViewController()
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 560)
        controller.update(
            CalendarAdjacentViewport(
                current: center,
                data: .init(isActive: true, generation: "anchor", revision: 1, pages: [:]),
                locale: locale, openerFocus: focus, onRequest: { _ in }, onBrowse: { _ in },
                onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
            ),
            rightToLeft: false
        )
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        collection.layoutIfNeeded()

        #expect(controller.identities == CalendarAdjacentPeriodWindow.starting(at: center))
        let anchorID = try #require(controller.rowIdentities.first)
        let beforeFirstPeriod = try #require(controller.identities.first)
        // Capture the row's offset at the requested y=0 before setContentOffset
        // invokes the real delegate and starts the prepend transaction.
        let before = try #require(rowOffset(anchorID, in: collection)) + collection.contentOffset.y
        collection.setContentOffset(CGPoint(x: 0, y: 0), animated: false)
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        let after = try #require(rowOffset(anchorID, in: collection))

        let afterFirstPeriod = try #require(controller.identities.first)
        #expect(abs(before - after) < 1.0)
        #expect(afterFirstPeriod.anchor < beforeFirstPeriod.anchor)
        #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
        #expect(controller.current == beforeFirstPeriod)

        // The real edge scroll precedes the data arrival. Replace the newly
        // prepended placeholders with differently sized rows above the anchor.
        let pages = Dictionary(uniqueKeysWithValues: controller.identities.filter {
            $0.anchor < beforeFirstPeriod.anchor
        }.map { period in
            (period, CalendarAdjacentPageData(
                projection: project(period.anchor.date, view: .day, event: true),
                loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil
            ))
        })
        #expect(!pages.isEmpty)
        controller.update(
            CalendarAdjacentViewport(
                current: beforeFirstPeriod,
                data: .init(isActive: true, generation: "anchor", revision: 2, pages: pages),
                locale: locale, openerFocus: focus, onRequest: { _ in }, onBrowse: { _ in },
                onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
            ),
            rightToLeft: false
        )
        await finishNativeDiff(controller)
        let loadedOffset = try #require(rowOffset(anchorID, in: collection))
        #expect(abs(before - loadedOffset) < 1.0)
        #expect(controller.current == beforeFirstPeriod)
        assertContiguous(controller.identities)
    }

    @Test func backwardWeekBrowseIgnoresClippedHeadingPaddingThroughArrivalsAndGeometry() async throws {
        let focus = FocusHarness()
        let weekLocale = CalendarLocale(languageTag: "en-US", timeZoneId: "UTC", weekStart: .sunday, hourCycle: .hour12)
        let center = CalendarAdjacentPageID(view: .week, anchor: try #require(CalendarViewportDate(date: "2026-09-08")))
        let target = try #require(center.previous)
        let preceding = try #require(target.previous)
        let controller = CalendarAdjacentViewController()
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        window.rootViewController = root
        root.addChild(controller)
        root.view.addSubview(controller.view)
        controller.didMove(toParent: root)
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
        window.makeKeyAndVisible()
        defer { controller.clear(); window.isHidden = true }
        let collection = try #require(controller.view as? UICollectionView)
        let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
        var cursor = center
        var revision = 1
        func knownEmpty(_ periods: [CalendarAdjacentPageID]) -> [CalendarAdjacentPageID: CalendarAdjacentPageData] {
            Dictionary(uniqueKeysWithValues: periods.map { period in
                let projection = CalendarProjection().project(request: CalendarProjectionRequest(
                    occurrences: [], anchorDate: period.anchor.date, view: .week,
                    selectedDate: center.anchor.date, todayDate: center.anchor.date, locale: weekLocale,
                    filters: CalendarFilters(scope: .all, groups: [], tags: [], importance: nil, text: "")
                ))
                return (period, CalendarAdjacentPageData(projection: projection, loading: .init(phase: .idle),
                                                        freshness: .fresh, offline: .online, error: nil))
            })
        }
        var pages = knownEmpty(CalendarAdjacentPeriodWindow.starting(at: center))
        func makeInput() -> CalendarAdjacentViewport {
            CalendarAdjacentViewport(
                current: cursor,
                data: .init(isActive: true, generation: "week-browse", revision: revision,
                            pages: pages, semanticAnchor: center.anchor),
                locale: weekLocale, openerFocus: focus.binding, onRequest: { _ in },
                onBrowse: { date in
                    cursor = .init(view: .week, anchor: date)
                    // The route uses this same cursor for its heading and
                    // Previous/Next basis, then echoes it to the native owner.
                    controller.update(makeInput(), rightToLeft: false)
                }, onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
            )
        }
        controller.update(makeInput(), rightToLeft: false)
        controller.view.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        // Real backward prepend, followed by data arriving while it is still
        // submitted. Keep latest-pending serialization and the visible anchor.
        let centerRow = CalendarAdjacentRowID(period: center, kind: .weekOverview)
        collection.setContentOffset(CGPoint(x: 0, y: -Space.sm), animated: false)
        controller.scrollViewDidScroll(collection)
        pages = knownEmpty(controller.identities)
        revision += 1
        controller.update(makeInput(), rightToLeft: false)
        await finishNativeDiff(controller)
        #expect(controller.identities.contains(preceding))
        #expect(abs(try #require(rowOffset(centerRow, in: collection)) - Space.sm) < 1)
        let targetRow = CalendarAdjacentRowID(period: target, kind: .weekOverview)
        let lastHeading = try #require(source.snapshot().itemIdentifiers.last {
            if case .dayHeading = $0.kind { return $0.period == preceding }
            return false
        })

        for category in [UIContentSizeCategory.large, .accessibilityExtraLarge] {
            controller.traitOverrides.preferredContentSizeCategory = category
            controller.view.frame.size.height = category == .large ? 600 : 480
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            controller.viewDidLayoutSubviews()
            await finishNativeDiff(controller)
            let geometryCursor = cursor // Observe before issuing another scroll.
            let top = collection.contentOffset.y + collection.adjustedContentInset.top
            let leadingCell = try #require(collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }
                .sorted { $0.frame.minY < $1.frame.minY }
                .first { cell in
                    let padding: CGFloat
                    switch cell.rowID?.kind {
                    case .dayHeading, .status: padding = Space.xs
                    default: padding = 0
                    }
                    return cell.frame.maxY - padding > top + 0.5
                })
            #expect(geometryCursor == leadingCell.configuredPage?.row.period)
            let path = try #require(source.indexPath(for: lastHeading))
            collection.scrollToItem(at: path, at: .top, animated: false)
            collection.layoutIfNeeded()
            controller.scrollViewDidScroll(collection)
            await finishNativeDiff(controller)
            #expect(cursor == preceding) // Real preceding heading, not a majority-period heuristic.
            let frame = try #require(collection.layoutAttributesForItem(at: path)?.frame)
            collection.setContentOffset(CGPoint(x: 0, y: frame.maxY - Space.xs), animated: false)
            controller.scrollViewDidScroll(collection)
            await finishNativeDiff(controller)
            #expect(cursor == target && controller.current == target)
            #expect(abs(try #require(rowOffset(targetRow, in: collection)) - (Space.xs + Space.sm)) < 1)
            let targetPath = try #require(source.indexPath(for: targetRow))
            let cell = try #require(collection.cellForItem(at: targetPath) as? CalendarAdjacentCell)
            let hosted = try #require(cell.configuredPage)
            guard case .weekOverview(let days, _, _, _) = hosted.row.content else {
                Issue.record("Visible owner must be the incoming Week strip")
                return
            }
            #expect(days.first?.date == "2026-08-30" && days.last?.date == "2026-09-05")
            #expect(CalendarCivilDay.days(for: cursor, locale: weekLocale).map(\.date) == days.map(\.date))
            #expect(cell.traitCollection.preferredContentSizeCategory == category)

            // Unknown then known-empty successors change heights above this
            // boundary. The echo must not align the Week strip to zero.
            let loaded = pages
            pages = [:]
            revision += 1
            controller.update(makeInput(), rightToLeft: false)
            pages = loaded
            revision += 1
            controller.update(makeInput(), rightToLeft: false)
            await finishNativeDiff(controller)
            #expect(cursor == target && controller.current == target)
            #expect(abs(try #require(rowOffset(targetRow, in: collection)) - (Space.xs + Space.sm)) < 1)
            let offset = collection.contentOffset
            controller.update(makeInput(), rightToLeft: false)
            await finishNativeDiff(controller)
            #expect(collection.contentOffset == offset)
            #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
        }
    }

    @Test func settledBrowseAfterRemovedAnchorUpdatesConsumerAndLeaseWithoutAnotherScroll() async throws {
        let focus = FocusHarness()
        let center = CalendarAdjacentPageID(view: .day, anchor: try #require(CalendarViewportDate(date: "2026-09-08")))
        let controller = CalendarAdjacentViewController()
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { controller.clear(); window.isHidden = true }
        var cursor = center
        var revision = 1
        var requests: [CalendarAdjacentViewportRequest] = []
        var pages = [center: CalendarAdjacentPageData(
            projection: project(center.anchor.date, view: .day, event: false), loading: .init(phase: .idle),
            freshness: .fresh, offline: .online, error: nil
        )]
        func makeInput() -> CalendarAdjacentViewport {
            CalendarAdjacentViewport(
                current: cursor,
                data: .init(isActive: true, generation: "settled-browse", revision: revision,
                            pages: pages, semanticAnchor: center.anchor),
                locale: locale, openerFocus: focus.binding, onRequest: { requests.append($0) },
                onBrowse: { date in
                    cursor = .init(view: .day, anchor: date)
                    controller.update(makeInput(), rightToLeft: false)
                }, onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
            )
        }
        controller.update(makeInput(), rightToLeft: false)
        controller.view.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
        let empty = CalendarAdjacentRowID(period: center, kind: .empty)
        let path = try #require(source.indexPath(for: empty))
        let frame = try #require(collection.layoutAttributesForItem(at: path)?.frame)
        collection.setContentOffset(CGPoint(x: 0, y: frame.maxY - Space.sm), animated: false)
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        #expect(cursor == center)
        let requestCount = requests.count
        pages = [:] // Revokes known-empty; native restoration uses the surviving civil row.
        revision += 1
        controller.update(makeInput(), rightToLeft: false)
        await finishNativeDiff(controller)
        let settledCursor = cursor // No extra scroll/layout callback to repair a stale consumer.
        let top = collection.contentOffset.y + collection.adjustedContentInset.top
        let first = try #require(collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }
            .sorted { $0.frame.minY < $1.frame.minY }
            .first { $0.frame.maxY - Space.xs > top + 0.5 })
        let actual = try #require(first.configuredPage?.row.period)
        #expect(actual != center) // The removed tall row's offset now exposes later civil dates.
        #expect(settledCursor == actual && controller.current == actual)
        #expect(requests.count == requestCount + 1)
        #expect(requests.last?.periods.first == actual.anchor)
        let offset = collection.contentOffset
        controller.update(makeInput(), rightToLeft: false)
        await finishNativeDiff(controller)
        #expect(collection.contentOffset == offset)
    }

    @Test func leadingBrowseEchoDoesNotRecenterButExplicitCursorDoes() async throws {
        let focusHarness = FocusHarness()
        let focus = focusHarness.binding
        let center = CalendarAdjacentPageID(
            view: .day, anchor: try #require(CalendarViewportDate(date: "2028-02-29"))
        )
        let controller = CalendarAdjacentViewController()
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 560)
        var browsed: [CalendarViewportDate] = []
        func makeInput(
            _ current: CalendarAdjacentPageID,
            semanticAnchor: CalendarViewportDate = center.anchor
        ) -> CalendarAdjacentViewport {
            let inputData = CalendarAdjacentViewportData(
                isActive: true, generation: "cursor", revision: 1, pages: [:], semanticAnchor: semanticAnchor
            )
            return CalendarAdjacentViewport(
                current: current, data: inputData, locale: locale, openerFocus: focus,
                onRequest: { _ in }, onBrowse: { browsed.append($0) }, onEvent: { _ in },
                onSelectDate: { _, _ in }, onRetry: {}
            )
        }
        controller.update(makeInput(center), rightToLeft: false)
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        let target = try #require(center.next)
        let targetIndex = try #require(controller.rowIdentities.firstIndex { $0.period == target })
        let targetPath = IndexPath(item: targetIndex, section: 0)
        collection.layoutIfNeeded()
        let targetFrame = try #require(collection.layoutAttributesForItem(at: targetPath)?.frame)
        collection.setContentOffset(CGPoint(x: 0, y: targetFrame.minY + 8), animated: false)
        controller.scrollViewDidScroll(collection)
        #expect(browsed.last?.date == target.anchor.date)
        await finishNativeDiff(controller)

        let echoOffset = collection.contentOffset.y
        controller.update(makeInput(target), rightToLeft: false)
        await finishNativeDiff(controller)
        #expect(abs(collection.contentOffset.y - echoOffset) < 1.0)

        // Clearing the route-local cursor before the shared navigation result
        // must not jump back to the old semantic anchor.
        controller.update(makeInput(center), rightToLeft: false)
        await finishNativeDiff(controller)
        #expect(abs(collection.contentOffset.y - echoOffset) < 1.0)

        // That same cursor clear is an explicit command only when Today was
        // actually pressed. No changed shared date or revision is required.
        controller.update(makeInput(center), rightToLeft: false, todayRevision: 1)
        await finishNativeDiff(controller)
        let todayRow = try #require(controller.rowIdentities.first { $0.period == center })
        #expect(abs(try #require(rowOffset(todayRow, in: collection))) < 1)
        // This scroll can prepend the bounded window. Capture the expected
        // row-relative offset before the real delegate starts that snapshot;
        // its completion must preserve pixels, not the old table's absolute y.
        let expectedRowOffset = try #require(rowOffset(todayRow, in: collection)) - 8
        collection.contentOffset.y += 8
        controller.scrollViewDidScroll(collection)
        controller.update(makeInput(center), rightToLeft: false, todayRevision: 1)
        await finishNativeDiff(controller)
        #expect(abs(try #require(rowOffset(todayRow, in: collection)) - expectedRowOffset) < 1)
        #expect(controller.current == center)

        // A second echo against the committed table must also preserve the
        // absolute offset. Do not treat the preceding prepend as recentering.
        let withinToday = collection.contentOffset.y
        controller.update(makeInput(center), rightToLeft: false, todayRevision: 1)
        await finishNativeDiff(controller)
        #expect(abs(collection.contentOffset.y - withinToday) < 1)
        #expect(abs(try #require(rowOffset(todayRow, in: collection)) - expectedRowOffset) < 1)
        controller.update(makeInput(center), rightToLeft: false, todayRevision: 2)
        await finishNativeDiff(controller)
        #expect(abs(try #require(rowOffset(todayRow, in: collection))) < 1)

        let explicit = try #require(center.previous)
        controller.update(makeInput(explicit, semanticAnchor: explicit.anchor), rightToLeft: false, todayRevision: 2)
        await finishNativeDiff(controller)
        let explicitIndex = try #require(controller.rowIdentities.firstIndex { $0.period == explicit })
        let explicitFrame = try #require(collection.layoutAttributesForItem(at: IndexPath(item: explicitIndex, section: 0))?.frame)
        #expect(abs(collection.contentOffset.y - explicitFrame.minY) < 1.0)
    }

    @Test func inactiveUpdateClearsVisibleHostsAndRejectsOldCallbacks() async throws {
        let focusHarness = FocusHarness()
        let focus = focusHarness.binding
        let center = CalendarAdjacentPageID(
            view: .day, anchor: try #require(CalendarViewportDate(date: "2028-02-29"))
        )
        let controller = CalendarAdjacentViewController()
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 560)
        var events = 0
        var requests: [String] = []
        let active = CalendarAdjacentViewport(
            current: center,
            data: .init(isActive: true, generation: "auth", revision: 1, pages: [
                center: .init(
                    projection: project(center.anchor.date, view: .day, event: true),
                    loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil
                )
            ]),
            locale: locale, openerFocus: focus, onRequest: { _ in requests.append("auth") }, onBrowse: { _ in },
            onEvent: { _ in events += 1 }, onSelectDate: { _, _ in }, onRetry: {}
        )
        controller.update(active, rightToLeft: false)
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        let source = try #require(
            collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>
        )
        let eventPage = try #require(collection.visibleCells.compactMap { ($0 as? CalendarAdjacentCell)?.configuredPage }.first { page in
            if case .event = page.row.content { return true }
            return false
        })
        let allocated = collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }
        let presentations = allocated.compactMap(\.configuredPresentation)
        #expect(!presentations.isEmpty)
        let event = try #require(active.data.pages[center]?.projection?.visibleEvents.first)
        // Leave an actual owner update pending, then revoke its content and
        // callbacks before UIKit's completion adapter can drain.
        controller.update(active, rightToLeft: true)
        controller.update(
            CalendarAdjacentViewport(
                current: center,
                data: .init(isActive: false, generation: "cleared", revision: 2, pages: [:]),
                locale: locale, openerFocus: focus, onRequest: { _ in }, onBrowse: { _ in },
                onEvent: { _ in events += 100 }, onSelectDate: { _, _ in }, onRetry: {}
            ),
            rightToLeft: false
        )
        #expect(controller.identities.isEmpty)
        #expect(controller.rowIdentities.isEmpty)
        #expect(allocated.allSatisfy { $0.contentConfiguration == nil && $0.configuredPage == nil })
        #expect(presentations.allSatisfy { $0.page == nil })
        eventPage.onEvent(event)
        #expect(events == 0)

        let next = try #require(center.next)
        let successor = CalendarAdjacentViewport(
            current: next,
            // Reuse the same generation, revision and event identity across
            // clear: only the controller epoch can reject the old action.
            data: .init(isActive: true, generation: "auth", revision: 1, pages: active.data.pages),
            locale: locale, openerFocus: focus,
            onRequest: { _ in requests.append("successor") }, onBrowse: { _ in },
            onEvent: { _ in events += 1000 }, onSelectDate: { _, _ in }, onRetry: {}
        )
        controller.update(successor, rightToLeft: false)
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        eventPage.onEvent(event)
        #expect(events == 0)
        #expect(requests == ["auth", "successor"])
        #expect(controller.current == next)
        #expect(source.snapshot().itemIdentifiers == controller.rowIdentities)
        let heading = try #require(controller.rowIdentities.first { $0.period == next })
        let offset = try #require(rowOffset(heading, in: collection))
        #expect(abs(offset) < 1.0)

        controller.update(successor, rightToLeft: true)
        let successorVisible = collection.visibleCells.compactMap { $0 as? CalendarAdjacentCell }
        try #require(!successorVisible.isEmpty)
        for cell in successorVisible {
            let presentation = try #require(cell.configuredPresentation)
            try #require(presentation.page != nil)
        }
        // Include previously retained cells even if now offscreen/reconfigured;
        // capture CURRENT inputs, not only the first lifetime's nilled objects.
        let successorCells = allocated + successorVisible
        let successorPresentations = successorCells.compactMap(\.configuredPresentation)
        controller.clear()
        #expect(successorCells.allSatisfy { $0.contentConfiguration == nil && $0.configuredPage == nil })
        #expect(successorPresentations.allSatisfy { $0.page == nil })
        await finishNativeDiff(controller)
        #expect(source.snapshot().itemIdentifiers.isEmpty)
        #expect(successorCells.allSatisfy { $0.contentConfiguration == nil && $0.configuredPage == nil })
        #expect(successorPresentations.allSatisfy { $0.page == nil })
        #expect(requests == ["auth", "successor"])
    }

    @Test func terminalHostedRowCanScrollAndFocusAboveFloatingControls() async throws {
        let focusHarness = FocusHarness()
        let terminal = CalendarAdjacentPageID(view: .day, anchor: try #require(CalendarViewportDate(date: "9999-11-30")))
        let controller = CalendarAdjacentViewController()
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        window.rootViewController = root
        root.addChild(controller)
        root.view.addSubview(controller.view)
        controller.didMove(toParent: root)
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 400)
        window.makeKeyAndVisible()
        defer { controller.clear(); window.isHidden = true }
        let pages = Dictionary(uniqueKeysWithValues: CalendarAdjacentPeriodWindow.initial(around: terminal).map { id in
            (id, CalendarAdjacentPageData(
                projection: project(id.anchor.date, view: .day, event: true),
                loading: .init(phase: .idle), freshness: .fresh, offline: .online, error: nil
            ))
        })
        let input = CalendarAdjacentViewport(
            current: terminal,
            data: .init(isActive: true, generation: "terminal", revision: 1, pages: pages),
            locale: locale, openerFocus: focusHarness.binding,
            onRequest: { _ in }, onBrowse: { _ in }, onEvent: { _ in },
            onSelectDate: { _, _ in }, onRetry: {}
        )
        controller.update(input, rightToLeft: false, bottomOcclusion: 120)
        controller.view.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
        let stableRows = source.snapshot().itemIdentifiers
        #expect(collection.contentSize.height < collection.bounds.height)
        // The real lower scroll endpoint is inside both prefetch bands for
        // this short table. Reaching it must not request the opposite edge.
        let lowerEndpoint = max(-collection.adjustedContentInset.top,
            collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
        collection.setContentOffset(CGPoint(x: 0, y: lowerEndpoint), animated: false)
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        #expect(source.snapshot().itemIdentifiers == stableRows)
        // Native terminal bounce can leave no capturable row. A rotation/type
        // change here must still refresh occlusion without a data revision or
        // pending anchor. Keep the same input, snapshot, and native hosts.
        collection.contentOffset.y = collection.contentSize.height + Space.sm
        collection.layoutIfNeeded()
        await finishNativeDiff(controller)
        #expect(source.snapshot().itemIdentifiers == stableRows)
        let increasedOcclusion = collection.contentInset.bottom + Space.md
        controller.update(input, rightToLeft: false, bottomOcclusion: increasedOcclusion)
        await finishNativeDiff(controller)
        #expect(collection.contentInset.bottom == increasedOcclusion)
        #expect(collection.verticalScrollIndicatorInsets.bottom == increasedOcclusion)
        #expect(source.snapshot().itemIdentifiers == stableRows)

        controller.update(input, rightToLeft: false, bottomOcclusion: 120)
        await finishNativeDiff(controller)
        #expect(source.snapshot().itemIdentifiers == stableRows)

        let last = try #require(source.snapshot().itemIdentifiers.last)
        let path = try #require(source.indexPath(for: last))
        let frame = try #require(collection.layoutAttributesForItem(at: path)?.frame)
        let terminalAlignmentSpace = max(0, collection.bounds.height - collection.adjustedContentInset.top
                                        - (collection.contentSize.height - frame.minY))
        #expect(collection.contentInset.bottom == max(120, terminalAlignmentSpace))
        #expect(collection.verticalScrollIndicatorInsets.bottom == 120)
        // Place the last hosted row in the overlay's area, still in the real
        // viewport. Deliver a native focus observation for that hosted owner.
        collection.contentOffset.y = frame.maxY - collection.bounds.height + 20
        collection.layoutIfNeeded()
        await finishNativeDiff(controller)
        let visiblePath = try #require(source.indexPath(for: last))
        let cell = try #require(collection.cellForItem(at: visiblePath) as? CalendarAdjacentCell)
        let element = UIAccessibilityElement(accessibilityContainer: cell.contentView)
        element.accessibilityFrameInContainerSpace = cell.contentView.bounds
        NotificationCenter.default.post(name: UIAccessibility.elementFocusedNotification,
                                        object: nil, userInfo: [UIAccessibility.focusedElementUserInfoKey: element])
        await finishNativeDiff(controller)
        #expect(collection.contentInset.bottom >= 120)
        let focused = cell.convert(cell.bounds, to: collection)
        #expect(focused.maxY <= collection.bounds.maxY - 120 + 1)
        #expect(focused.minY >= collection.bounds.minY - 1)
    }

    @Test func zeroExtentTerminalBounceSettlesWithoutPrependingButBackwardPullKeepsAnchor() async throws {
        let focus = FocusHarness()
        let terminal = CalendarAdjacentPageID(view: .day, anchor: try #require(CalendarViewportDate(date: "9999-11-30")))
        let controller = CalendarAdjacentViewController()
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { controller.clear(); window.isHidden = true }
        var requests: [CalendarAdjacentViewportRequest] = []
        controller.update(.init(
            current: terminal,
            data: .init(isActive: true, generation: "zero-extent", revision: 1, pages: [:], semanticAnchor: terminal.anchor),
            locale: locale, openerFocus: focus.binding, onRequest: { requests.append($0) }, onBrowse: { _ in },
            onEvent: { _ in }, onSelectDate: { _, _ in }, onRetry: {}
        ), rightToLeft: false)
        controller.view.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        await finishNativeDiff(controller)
        let collection = try #require(controller.view as? UICollectionView)
        let source = try #require(collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>)
        let stable = source.snapshot().itemIdentifiers
        #expect(stable.count == 1) // Unknown Day: only its real civil heading.
        let minimum = -collection.adjustedContentInset.top
        let maximum = max(minimum, collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom)
        #expect(maximum == minimum)
        let initialRequests = requests
        for y in [maximum + Space.sm, maximum] {
            collection.setContentOffset(CGPoint(x: 0, y: y), animated: false)
            controller.scrollViewDidScroll(collection)
            await finishNativeDiff(controller)
            #expect(source.snapshot().itemIdentifiers == stable)
            #expect(requests == initialRequests)
        }
        let first = try #require(stable.first)
        collection.setContentOffset(CGPoint(x: 0, y: minimum - Space.sm), animated: false)
        controller.scrollViewDidScroll(collection)
        await finishNativeDiff(controller)
        #expect(try #require(controller.identities.first).anchor < terminal.anchor)
        #expect(abs(try #require(rowOffset(first, in: collection)) - Space.sm) < 1)
        #expect(requests.count == initialRequests.count + 1)
        #expect(controller.identities.count <= CalendarAdjacentPeriodWindow.maximumPeriods)
        assertContiguous(controller.identities)
    }

    private func finishNativeDiff(_ controller: CalendarAdjacentViewController) async {
        await controller.waitForPendingSnapshots()
    }

    private func assertContiguous(_ periods: [CalendarAdjacentPageID]) {
        for (left, right) in zip(periods, periods.dropFirst()) {
            #expect(left.next == right)
        }
    }

    private func rowOffset(
        _ id: CalendarAdjacentRowID,
        in collection: UICollectionView
    ) -> CGFloat? {
        guard let source = collection.dataSource as? UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>,
              let path = source.indexPath(for: id),
              let frame = collection.layoutAttributesForItem(at: path)?.frame else { return nil }
        let top = collection.contentOffset.y + collection.adjustedContentInset.top
        return frame.minY - top
    }

    private func project(
        _ anchor: String,
        view: CalendarView,
        event: Bool,
        longTitle: String? = nil
    ) -> CalendarExperienceProjection {
        let occurrence = event ? CalendarProjectionOccurrence(
            eventId: "event-\(anchor)", occurrenceId: "occurrence-\(anchor)", originalStart: "\(anchor)T09:00:00Z",
            recurring: false, recurrence: nil, revision: 1, scope: .household,
            title: "Event", description: "Details", start: "\(anchor)T09:00:00Z",
            end: "\(anchor)T09:30:00Z", visibility: .everyone, importance: .normal,
            group: nil, tags: [], persistedTimeZoneId: "UTC"
        ) : nil
        var occurrences = occurrence.map { [$0] } ?? []
        if event, let longTitle {
            occurrences.append(CalendarProjectionOccurrence(
                eventId: "event-\(anchor)-long", occurrenceId: "occurrence-\(anchor)-long", originalStart: "\(anchor)T10:00:00Z",
                recurring: false, recurrence: nil, revision: 1, scope: .household,
                title: longTitle, description: "Details", start: "\(anchor)T10:00:00Z",
                end: "\(anchor)T11:30:00Z", visibility: .everyone, importance: .important,
                group: "Calendar planning", tags: ["Preparation and coordination", "Additional information"], persistedTimeZoneId: "UTC"
            ))
        }
        return CalendarProjection().project(request: CalendarProjectionRequest(
            occurrences: occurrences, anchorDate: anchor, view: view,
            selectedDate: anchor, todayDate: anchor, locale: locale,
            filters: CalendarFilters(scope: .all, groups: [], tags: [], importance: nil, text: "")
        ))
    }
}

/// A single scheduled native display callback, not physical scanout or a
/// promise of final fitting. Native geometry fixtures use this bounded seam;
/// existing pre-completion and snapshot-drain assertions retain their phases.
@MainActor
private final class AdjacentDisplayFrame: NSObject {
    private var continuation: CheckedContinuation<Void, Never>?

    func next() async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            let link = CADisplayLink(target: self, selector: #selector(didDisplay(_:)))
            link.add(to: .main, forMode: .common)
        }
    }

    @objc private func didDisplay(_ link: CADisplayLink) {
        link.invalidate()
        let waiter = continuation
        continuation = nil
        waiter?.resume()
    }
}

@MainActor
private final class FocusHarness {
    let window: UIWindow
    let binding: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding

    init() {
        var captured: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding?
        let root = UIHostingController(rootView: FocusFixture { captured = $0 })
        let hostWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 600))
        hostWindow.rootViewController = root
        hostWindow.isHidden = false
        root.view.layoutIfNeeded()
        guard let captured else { fatalError("focus fixture did not install") }
        window = hostWindow
        binding = captured
    }

}

private struct FocusFixture: View {
    let receive: (AccessibilityFocusState<CalendarOverlayOrigin?>.Binding) -> Void
    @AccessibilityFocusState private var focus: CalendarOverlayOrigin?

    var body: some View { FocusBridge(focus: $focus, receive: receive) }
}

private struct FocusBridge: UIViewRepresentable {
    let focus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding
    let receive: (AccessibilityFocusState<CalendarOverlayOrigin?>.Binding) -> Void

    func makeUIView(context: Context) -> UIView {
        receive(focus)
        return UIView()
    }

    func updateUIView(_ view: UIView, context: Context) {}
}

// UIKit exposes the configuration type, not the hosted SwiftUI value. Verify
// both the cell configuration and its actual UIContentView, then inspect their
// canonical observable input (no reflection or parallel test-only row mirror).
// Saving configuredPage takes a VALUE snapshot with the exact callback fence.
@MainActor
private extension CalendarAdjacentCell {
    var nativeConfiguration: UIHostingConfiguration<CalendarAdjacentCellContent, EmptyView>? {
        contentConfiguration as? UIHostingConfiguration<CalendarAdjacentCellContent, EmptyView>
    }

    var configuredPresentation: CalendarAdjacentCellPresentation? {
        guard nativeConfiguration != nil,
              (contentView as? UIContentView)?.configuration is UIHostingConfiguration<CalendarAdjacentCellContent, EmptyView>
        else { return nil }
        return presentation
    }

    var configuredPage: CalendarAdjacentPage? { configuredPresentation?.page }
}
