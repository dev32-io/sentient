import MobileData
import SwiftUI
import Testing
import UIKit
@testable import SentientApp

@MainActor
struct CalendarViewportTests {
    private let locale = CalendarLocale(languageTag: "en-US", timeZoneId: "UTC", weekStart: .sunday, hourCycle: .hour12)

    private func cells(_ anchor: String = "2028-02-14", eventCount: Int = 0) -> [CalendarDateCell] {
        CalendarProjection().project(request: CalendarProjectionRequest(
            occurrences: (0..<eventCount).map { index in
                CalendarProjectionOccurrence(
                    eventId: "event-\(index)", occurrenceId: "occurrence-\(index)", originalStart: "\(anchor)T12:00:00Z",
                    recurring: false, recurrence: nil, revision: 1, scope: .household,
                    title: "Fixture event", description: nil, start: "\(anchor)T12:00:00Z", end: "\(anchor)T13:00:00Z",
                    visibility: .everyone, importance: .important, group: nil, tags: [], persistedTimeZoneId: "UTC"
                )
            }, anchorDate: anchor, view: .month,
            selectedDate: anchor, todayDate: anchor, locale: locale,
            filters: CalendarFilters(scope: .all, groups: [], tags: [], importance: nil, text: "")
        )).month!.cells
    }

    @Test func readyRequiresExactlyTheCivilGridIncludingOutsideDates() {
        let civil = CalendarCivilMonth(id: .init(year: 2028, month: 2), locale: locale)
        let complete = cells()
        let valid = CalendarViewportMonthData(cells: Array(complete.reversed()), availability: .ready).validated(for: civil)
        #expect(valid.availability == .ready)
        #expect(valid.cells.count == 42)

        let missing = Array(complete.dropLast())
        let duplicate = missing + [complete[0]]
        let wrongDate = missing + [cells("2029-02-14")[0]]
        let missingOutside = complete.filter { !$0.isOutsideMonth }
        for malformed in [missing, duplicate, wrongDate, missingOutside] {
            let rejected = CalendarViewportMonthData(cells: malformed, availability: .ready).validated(for: civil)
            #expect(rejected.availability == .unavailable)
            #expect(rejected.cells.isEmpty)
        }
    }

    @Test func nativeCivilEdgesMatchTheShared42CellDomainAndKeyboardBounds() {
        let first = CalendarViewportMonth(year: 1, month: 1)
        let last = CalendarViewportMonth(year: 9999, month: 11)
        #expect(first.index == CalendarViewportMonth.firstSupportedIndex)
        #expect(last.index == CalendarViewportMonth.lastSupportedIndex)
        #expect(CalendarNativeViewportLayout.monthCount == last.index + 1)
        #expect(!CalendarViewportMonth(year: 9999, month: 12).isNativeSupported)

        for id in [first, last] {
            let civil = CalendarCivilMonth(id: id, locale: locale)
            let shared = cells(id.date)
            #expect(Set(civil.slots.map(\.date)) == Set(shared.map(\.date)))
            let validated = CalendarViewportMonthData(cells: shared, availability: .ready).validated(for: civil)
            #expect(validated.availability == .ready)
            #expect(civil.slots.count == 42)
        }

        let firstCivil = CalendarCivilMonth(id: first, locale: locale)
        let firstOwned = firstCivil.slots.firstIndex { !$0.outside }!
        #expect(firstCivil.slots.first?.date == "0000-12-31")
        #expect(firstCivil.slots.first?.outside == true)
        #expect(firstCivil.keyboardDate(from: firstOwned, step: -1) == nil)
        #expect(firstCivil.keyboardDate(from: firstOwned, step: -7) == nil)

        let lastCivil = CalendarCivilMonth(id: last, locale: locale)
        let lastOwned = lastCivil.slots.lastIndex { !$0.outside }!
        #expect(lastCivil.keyboardDate(from: lastOwned, step: 1) == nil)
        #expect(lastCivil.keyboardDate(from: lastOwned, step: 7) == nil)

        let layout = CalendarNativeViewportLayout()
        layout.progress = 1
        layout.viewportSize = CGSize(width: 392, height: 600)
        let frame = layout.frame(last.index, progress: 1)
        let request = layout.periodRequest(in: CGRect(x: 0, y: frame.minY,
                                                       width: 392, height: frame.height))
        #expect(request.months.contains(last))
        #expect(request.months.allSatisfy { $0.isNativeSupported })
    }

    @Test func monthCellProportionsFollowWidthNotViewportHeight() {
        let layout = CalendarNativeViewportLayout()
        let index = CalendarViewportMonth(year: 2026, month: 9).index
        let civil = CalendarCivilMonth(id: .init(index: index), locale: locale)
        for width in [CGFloat(320), 392, 768] {
            layout.viewportSize = CGSize(width: width, height: 450)
            let original = layout.frame(index, progress: 1)
            let rowHeight = (original.height - layout.headingHeight) / CGFloat(civil.ownedRowCount)
            #expect(abs(rowHeight / (original.width / 7) - 1.2) < 0.000001)
            for height in [CGFloat(300), 800, 1800] {
                layout.viewportSize.height = height
                #expect(layout.frame(index, progress: 1) == original)
            }
        }
        // Scaled content may exceed the preferred proportion without altering Year.
        layout.viewportSize = CGSize(width: 392, height: 800)
        let year = layout.frame(index, progress: 0)
        layout.rowHeight = 120
        #expect((layout.frame(index, progress: 1).height - layout.headingHeight) / CGFloat(civil.ownedRowCount) == 120)
        #expect(layout.frame(index, progress: 0) == year)
    }

    @Test func yearMarkerGeometryKeepsCenteredDotsBelowNumerals() {
        let rect = CGRect(x: 0, y: 0, width: 42, height: CalendarNativeMonthGeometry.compactRowHeight(dateSize: 12.5))
        let number = CalendarNativeMonthGeometry.dateNumberCenter(in: rect, dateSize: 12.5)
        let marker = CalendarNativeMonthGeometry.significanceCenter(in: rect, dateSize: 12.5)
        #expect(marker.x == rect.midX)
        #expect(marker.y - CalendarSurfaceLayout.indicatorSize / 2 >= number.y + 12.5 / 2)
        #expect(CalendarNativeMonthGeometry.markerGroupWidth(markCount: 1, diameter: 5, gap: 4) == 5)
        #expect(CalendarNativeMonthGeometry.markerGroupWidth(markCount: 2, diameter: 5, gap: 4) == 14)
        #expect(CalendarNativeMonthGeometry.markerGroupWidth(markCount: 2, diameter: 5, gap: 4,
                                                              overflowWidth: 18, overflowGap: 4) == 36)
        let layout = CalendarNativeViewportLayout()
        layout.viewportSize = CGSize(width: 392, height: 800)
        #expect(layout.miniHeight >= CalendarSurfaceLayout.minimumTarget)
    }

    @Test func phoneMonthViewportShowsFollowingMonthsWithoutStretchingWeeks() {
        let layout = CalendarNativeViewportLayout()
        layout.viewportSize = CGSize(width: 392, height: 800)
        let september = CalendarViewportMonth(year: 2026, month: 9)
        let october = CalendarViewportMonth(year: 2026, month: 10)
        let rect = CGRect(x: 0, y: layout.frame(september.index, progress: 1).minY,
                          width: 392, height: 800 - CalendarSurfaceLayout.weekdayHeaderHeight)
        let visible = layout.indices(in: rect).filter { layout.frame($0, progress: 1).intersects(rect) }
        #expect(visible.contains(september.index))
        #expect(visible.contains(october.index))
        // October's second week must actually be visible, not just a repeated
        // outside placeholder from September's 42-cell input.
        let octoberCivil = CalendarCivilMonth(id: october, locale: locale)
        let octoberRowHeight = (layout.monthHeight(for: october.index) - layout.headingHeight) / CGFloat(octoberCivil.ownedRowCount)
        #expect(layout.frame(october.index, progress: 1).minY + layout.headingHeight + octoberRowHeight < rect.maxY)
        let request = layout.periodRequest(in: rect)
        #expect(Set(visible).isSubset(of: Set(request.months.map(\.index))))
        #expect(request.months.count <= CalendarViewportRequest.maximumPeriods)
    }

    @Test func browseMonthUsesTheLeadingGeometryBoundaryNotViewportCenter() {
        let layout = CalendarNativeViewportLayout()
        layout.viewportSize = CGSize(width: 392, height: 800)
        layout.progress = 1
        let april = CalendarViewportMonth(year: 2026, month: 4)
        let may = CalendarViewportMonth(year: 2026, month: 5)
        let aprilFrame = layout.frame(april.index, progress: 1)
        let mayFrame = layout.frame(may.index, progress: 1)
        let showingBoth = CGRect(x: 0, y: aprilFrame.minY + aprilFrame.height * 0.75,
                                 width: 392, height: 800)
        #expect(layout.leadingVisibleMonth(in: showingBoth) == april)
        let atBoundary = CGRect(x: 0, y: mayFrame.minY + 0.5, width: 392, height: 800)
        #expect(layout.leadingVisibleMonth(in: atBoundary) == may)

        layout.progress = 0
        layout.rightToLeft = true
        let yearTop = layout.frame(0, progress: 0).minY
        let yearRect = CGRect(x: 0, y: yearTop, width: 392, height: layout.miniHeight)
        let leading = layout.leadingVisibleMonth(in: yearRect)
        #expect(leading?.month == Int32(layout.columns))
    }

    @Test func tabletRequestIncludesEveryVisibleMonthAndBothOverscanRows() {
        let layout = CalendarNativeViewportLayout()
        layout.progress = 0
        layout.viewportSize = CGSize(width: 1200, height: 1800)
        let start = CalendarViewportMonth(year: 2028, month: 2).index
        let rect = CGRect(x: 0, y: layout.frame(start, progress: 0).minY, width: 1200, height: 1800)
        let visible = layout.indices(in: rect).filter { layout.frame($0, progress: 0).intersects(rect) }
        let lower = (visible.first! / layout.columns - 1) * layout.columns
        let upper = (visible.last! / layout.columns + 2) * layout.columns
        let request = layout.periodRequest(in: rect)
        #expect(request.months.count > 12)
        #expect(Set(request.months.map(\.index)) == Set(lower..<upper))
        #expect(Set(request.months.prefix(visible.count).map(\.index)) == Set(visible))
    }

    @Test func oversizedViewportPrioritizesVisiblePeriodsBeforeOverscan() {
        let layout = CalendarNativeViewportLayout()
        layout.progress = 0
        layout.viewportSize = CGSize(width: 1200, height: 20000)
        let rect = CGRect(x: 0, y: layout.frame(24000, progress: 0).minY, width: 1200, height: 20000)
        let visible = Set(layout.indices(in: rect).filter { layout.frame($0, progress: 0).intersects(rect) })
        let request = layout.periodRequest(in: rect)
        #expect(request.months.count == CalendarViewportRequest.maximumPeriods)
        #expect(Set(request.months.map(\.index)).isSubset(of: visible))
    }

    @Test func controllerBoundsCivilPreparationForAWideCappedRequest() async throws {
        let controller = CalendarViewportController()
        defer { controller.dispose() }
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 1200, height: 20000)
        let (requests, continuation) = AsyncStream<CalendarViewportRequest>.makeStream()
        defer { continuation.finish() }
        var iterator = requests.makeAsyncIterator()
        let data = CalendarViewportData(generation: "preparation-bound", revision: 1, months: [:], isActive: true)
        controller.update(nativeInput(state("2028-02-14", view: .year), data: data,
                                      onRequest: { continuation.yield($0) }), progress: 0)
        controller.viewDidLayoutSubviews()
        let request = try #require(await iterator.next())
        #expect(request.months.count == CalendarViewportRequest.maximumPeriods)
        #expect(controller.preparedMonths.count <= CalendarViewportRequest.maximumPeriods)
        #expect(Set(request.months).isSubset(of: controller.preparedMonths))
    }

    @Test func resumeAndSemanticNavigationDoNotSuppressReturningToAnEarlierBrowse() throws {
        let a = CalendarViewportMonth(year: 2028, month: 2)
        let b = CalendarViewportMonth(year: 2028, month: 5)
        let c = CalendarViewportMonth(year: 2028, month: 6)
        var browsed: [CalendarViewportMonth] = []
        let controller = CalendarViewportController()
        defer { controller.dispose() }
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 392, height: 500)
        func update(anchor: CalendarViewportMonth, resume: CalendarViewportMonth? = nil) {
            controller.update(CalendarNativeViewportInput(
                state: state(anchor.date), data: nil, browsedMonth: resume,
                rightToLeft: false, increasedContrast: false, accessibilitySize: false,
                reduceMotion: true, dateSize: 12.5, rowHeight: 53, dateWidth: 44,
                onSelectDate: { _ in }, onSelectMonth: { _, _ in }, onRequest: { _ in },
                onBrowse: { browsed.append($0) }
            ), progress: 1)
        }
        update(anchor: a, resume: b)
        controller.viewDidLayoutSubviews()
        let collection = try #require(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
        let layout = try #require(collection.collectionViewLayout as? CalendarNativeViewportLayout)
        // UIKit may snap endpoint offsets to display pixels; civil geometry stays fractional.
        let displayScale = collection.traitCollection.displayScale
        let pixelTolerance: CGFloat = 1 / (displayScale.isFinite && displayScale > 0 ? displayScale : 1)
        #expect(abs(collection.contentOffset.y - layout.frame(b.index, progress: 1).minY) <= pixelTolerance)
        update(anchor: c)
        #expect(abs(collection.contentOffset.y - layout.frame(c.index, progress: 1).minY) <= pixelTolerance)
        controller.scrollViewWillBeginDragging(collection)
        collection.contentOffset.y = layout.frame(b.index, progress: 1).minY
        controller.scrollViewDidScroll(collection)
        #expect(browsed.last == b)
        // A Browse echo must retain the within-month native position.
        let offset = collection.contentOffset.y + 20
        collection.contentOffset.y = offset
        update(anchor: b, resume: b)
        #expect(collection.contentOffset.y == offset)
    }

    @Test func repeatedTodayIsACommandButItsEchoAndLaterGeometryChangesAreNot() throws {
        let controller = CalendarViewportController()
        defer { controller.dispose() }
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 392, height: 600)
        let today = CalendarViewportMonth(year: 2026, month: 9)
        let october = CalendarViewportMonth(year: 2026, month: 10)
        let data = CalendarViewportData(generation: "today", revision: 1, months: [:], isActive: true)
        var browsed: CalendarViewportMonth?
        func update(_ mode: CalendarView = .month, progress: CGFloat = 1, revision: Int = 0,
                    dateWidth: CGFloat = 44) {
            controller.update(nativeInput(state("2026-09-07", view: mode), data: data, browse: browsed,
                                          dateWidth: dateWidth, onBrowse: { browsed = $0 }),
                              progress: progress, todayRevision: revision)
        }
        update()
        controller.viewDidLayoutSubviews()
        let collection = try #require(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
        let layout = try #require(collection.collectionViewLayout as? CalendarNativeViewportLayout)
        func browse(_ month: CalendarViewportMonth, by offset: CGFloat) {
            controller.scrollViewWillBeginDragging(collection)
            collection.contentOffset.y = layout.frame(month.index, progress: 1).minY + offset
            controller.scrollViewDidScroll(collection)
        }
        browse(october, by: 30)
        let before = collection.contentOffset.y
        update() // Ordinary browse echo.
        #expect(collection.contentOffset.y == before)
        browsed = nil
        update(revision: 1)
        #expect(abs(collection.contentOffset.y - layout.frame(today.index, progress: 1).minY) < 1)
        controller.scrollViewDidScroll(collection) // Late old deceleration is no longer browsing.
        #expect(browsed == nil)

        // Repeat within the already-reported Today month: no cursor or date
        // change can be used as a substitute for the explicit command identity.
        browse(today, by: 60)
        let withinMonth = collection.contentOffset.y
        update(revision: 1)
        #expect(collection.contentOffset.y == withinMonth)
        update(revision: 2)
        #expect(abs(collection.contentOffset.y - layout.frame(today.index, progress: 1).minY) < 1)

        // A Today press during a reversed morph retargets the current pair;
        // later samples cannot restore October or force the wrong mode.
        browse(october, by: 20)
        update(.year, progress: 0.4, revision: 2)
        browsed = nil
        update(.month, progress: 0.4, revision: 3)
        update(.month, progress: 1, revision: 3)
        #expect(layout.leadingVisibleMonth(in: collection.bounds) == today)
        browse(october, by: 20)
        update(revision: 3, dateWidth: 70) // AX geometry after the consumed command.
        #expect(layout.leadingVisibleMonth(in: collection.bounds) == october)
        #expect(collection.isScrollEnabled)
    }

    @Test func centeredYearKeepsRequestedFocalMonthThroughSettledAndInterruptedExpansion() throws {
        let september = CalendarViewportMonth(year: 2026, month: 9)
        for rtl in [false, true] {
            for reduced in [false, true] {
                let controller = CalendarViewportController()
                defer { controller.dispose() }
                controller.loadViewIfNeeded()
                controller.view.frame = CGRect(x: 0, y: 0, width: 392, height: 800)
                var browsed: [CalendarViewportMonth] = []
                let data = CalendarViewportData(generation: "focal", revision: 1, months: [:], isActive: true)
                func update(_ mode: CalendarView, _ progress: CGFloat) {
                    controller.update(nativeInput(state(september.date, view: mode), data: data, rtl: rtl,
                                                  reduceMotion: reduced, onBrowse: { browsed.append($0) }), progress: progress)
                }
                update(.year, 0)
                controller.viewDidLayoutSubviews()
                let collection = try #require(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
                let layout = try #require(collection.collectionViewLayout as? CalendarNativeViewportLayout)
                #expect(layout.leadingVisibleMonth(in: collection.bounds) != september)
                #expect(layout.frame(september.index, progress: 0).intersects(collection.bounds))
                // The semantic heading still owns September; positioning must
                // not manufacture an unacknowledged browse of the leading row.
                controller.scrollViewDidScroll(collection) // Delayed positioning/layout, not a drag.
                #expect(browsed.isEmpty)
                update(.month, 0)
                update(.month, 0.45)
                update(.year, 0.45)
                update(.year, 0.1)
                update(.month, 0.1)
                update(.month, 1)
                #expect(layout.leadingVisibleMonth(in: collection.bounds) == september)
                let heading = CalendarSurfaceText.heading(for: state(september.date))
                #expect(heading == CalendarCivilMonth(id: september, locale: locale).title)
                #expect(abs(collection.contentOffset.y - layout.frame(september.index, progress: 1).minY) < 1)
                #expect(browsed.isEmpty)
                #expect(collection.isScrollEnabled)
            }
        }
    }

    @Test func browsedMonthOffsetSurvivesFullYearTripReversalAndExplicitRetarget() throws {
        let september = CalendarViewportMonth(year: 2026, month: 9)
        let november = CalendarViewportMonth(year: 2026, month: 11)
        let controller = CalendarViewportController()
        defer { controller.dispose() }
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 392, height: 800)
        let data = CalendarViewportData(generation: "browse-trip", revision: 1, months: [:], isActive: true)
        var browsed: CalendarViewportMonth?
        func update(_ mode: CalendarView, _ progress: CGFloat, anchor requestedAnchor: CalendarViewportMonth? = nil) {
            let anchor = requestedAnchor ?? september
            controller.update(nativeInput(state(anchor.date, view: mode), data: data, browse: browsed,
                                          onBrowse: { browsed = $0 }), progress: progress)
        }
        update(.month, 1)
        controller.viewDidLayoutSubviews()
        let collection = try #require(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
        let layout = try #require(collection.collectionViewLayout as? CalendarNativeViewportLayout)
        controller.scrollViewWillBeginDragging(collection)
        collection.contentOffset.y = layout.frame(september.index, progress: 1).minY + 93
        controller.scrollViewDidScroll(collection)
        let offset = collection.contentOffset.y
        for sample in [CGFloat(1), 0.6, 0] { update(.year, sample) }
        for sample in [CGFloat(0), 0.3, 1] { update(.month, sample) }
        #expect(abs(collection.contentOffset.y - offset) < 1)
        #expect(layout.leadingVisibleMonth(in: collection.bounds) == september)
        update(.year, 0.6)
        update(.month, 0.6, anchor: november)
        update(.month, 1, anchor: november)
        #expect(layout.leadingVisibleMonth(in: collection.bounds) == november)
        #expect(abs(collection.contentOffset.y - layout.frame(november.index, progress: 1).minY) < 1)
    }

    @Test func realYearBrowseBecomesTheNextExpandedFocalMonth() throws {
        let controller = CalendarViewportController()
        defer { controller.dispose() }
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 392, height: 800)
        let september = CalendarViewportMonth(year: 2026, month: 9)
        let november = CalendarViewportMonth(year: 2026, month: 11)
        let data = CalendarViewportData(generation: "year-browse", revision: 1, months: [:], isActive: true)
        var browses: [CalendarViewportMonth] = []
        controller.update(nativeInput(state(september.date, view: .year), data: data,
                                      onBrowse: { browses.append($0) }), progress: 0)
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        let collection = try #require(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
        let layout = try #require(collection.collectionViewLayout as? CalendarNativeViewportLayout)
        collection.layoutIfNeeded()
        #expect(collection.isScrollEnabled)
        #expect(layout.leadingVisibleMonth(in: collection.bounds) == CalendarViewportMonth(year: 2026, month: 7))
        #expect(browses.isEmpty)

        controller.scrollViewWillBeginDragging(collection)
        collection.contentOffset.y += layout.miniHeight + Space.md
        controller.scrollViewDidScroll(collection)
        // Centering September initially leaves July at the leading edge.
        // One row of scrolling only brings the already-reported September
        // to that edge: this must not manufacture a new browse callback.
        #expect(layout.leadingVisibleMonth(in: collection.bounds) == september)
        #expect(browses.isEmpty)

        // Continue the same drag to a genuinely different civil boundary.
        collection.contentOffset.y = layout.frame(november.index, progress: 0).minY + 1
        controller.scrollViewDidScroll(collection)
        #expect(layout.leadingVisibleMonth(in: collection.bounds) == november)
        #expect(browses == [november])
        let cursor = try #require(browses.last)
        controller.scrollViewDidEndDragging(collection, willDecelerate: false)
        // Shared navigation consumes the browse basis and acknowledges it in
        // the new anchor. This is not a command to return to old September.
        controller.update(nativeInput(state(cursor.date), data: data), progress: 1)
        collection.layoutIfNeeded()
        #expect(layout.leadingVisibleMonth(in: collection.bounds) == cursor)
        #expect(abs(collection.contentOffset.y - layout.frame(november.index, progress: 1).minY) < 1)
    }

    @Test func supersededEndpointRequestCannotCrossContextAndPreparationUsesRealEnvelopes() async throws {
        let controller = CalendarViewportController()
        defer { controller.dispose() }
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 392, height: 800)
        let (stream, continuation) = AsyncStream<(String, CalendarViewportRequest)>.makeStream()
        defer { continuation.finish() }
        var iterator = stream.makeAsyncIterator()
        func update(_ mode: CalendarView, _ progress: CGFloat, _ context: String) {
            let data = CalendarViewportData(generation: context, revision: 1, months: [:], isActive: true)
            controller.update(nativeInput(state("2026-09-01", view: mode), data: data,
                                          onRequest: { continuation.yield((context, $0)) }), progress: progress)
        }
        update(.year, 0, "retired")
        controller.viewDidLayoutSubviews() // Buffers a Year envelope, does not deliver it.
        update(.month, 0.4, "current")
        update(.month, 1, "current")
        let (context, request) = try #require(await iterator.next())
        #expect(context == "current")
        let collection = try #require(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
        let layout = try #require(collection.collectionViewLayout as? CalendarNativeViewportLayout)
        #expect(request == layout.periodRequest(in: collection.bounds))
        #expect(request.months.contains(.init(year: 2026, month: 9)))
        #expect(Set(request.months).isSubset(of: controller.preparedMonths))
        #expect(controller.preparedMonths.count < CalendarViewportRequest.maximumPeriods)
        // Same identity envelope MUST be requested again under a new context.
        update(.month, 1, "replacement")
        let (replacement, repeated) = try #require(await iterator.next())
        #expect(replacement == "replacement")
        #expect(repeated == request)
        controller.viewDidDisappear(false)
        controller.viewDidAppear(false)
        let (_, resumed) = try #require(await iterator.next())
        #expect(resumed == request)
    }

    @Test func requestMailboxDeduplicatesIdentitySetsButNeverAcrossInvalidation() throws {
        var mailbox = CalendarViewportRequestMailbox()
        let a = CalendarViewportMonth(year: 2026, month: 9)
        let b = CalendarViewportMonth(year: 2026, month: 10)
        let request = CalendarViewportRequest(months: [a, b])
        // Mutate before asserting: Swift Testing's member-call expansion
        // captures a value-type receiver immutably.
        let firstDelivery = mailbox.enqueue(request)
        let first = try #require(firstDelivery)
        let consumedFirst = mailbox.consume(first)
        #expect(consumedFirst)
        let publishFirst = mailbox.shouldPublish(request)
        #expect(publishFirst)
        let reordered = CalendarViewportRequest(months: [b, a])
        let secondDelivery = mailbox.enqueue(reordered)
        let second = try #require(secondDelivery)
        let consumedSecond = mailbox.consume(second)
        #expect(consumedSecond)
        let publishReordered = mailbox.shouldPublish(reordered)
        #expect(!publishReordered)
        let staleDelivery = mailbox.enqueue(.init(months: [a]))
        let stale = try #require(staleDelivery)
        mailbox.invalidate(resetDelivered: false) // mode/semantic change
        let consumedStale = mailbox.consume(stale)
        #expect(!consumedStale)
        let publishAfterModeChange = mailbox.shouldPublish(request)
        #expect(!publishAfterModeChange)
        let oldContextDelivery = mailbox.enqueue(request)
        let oldContext = try #require(oldContextDelivery)
        mailbox.invalidate(resetDelivered: true) // auth, locale, filters, disappearance
        let currentDelivery = mailbox.enqueue(request)
        let current = try #require(currentDelivery)
        let consumedOldContext = mailbox.consume(oldContext)
        #expect(!consumedOldContext)
        let consumedCurrent = mailbox.consume(current)
        #expect(consumedCurrent)
        let publishCurrent = mailbox.shouldPublish(request)
        #expect(publishCurrent)
        let oldNonemptyDelivery = mailbox.enqueue(request)
        let oldNonempty = try #require(oldNonemptyDelivery)
        mailbox.invalidate(resetDelivered: true)
        let empty = CalendarViewportRequest(months: [])
        let revokeDelivery = mailbox.enqueue(empty)
        let revoke = try #require(revokeDelivery)
        let consumedOldNonempty = mailbox.consume(oldNonempty)
        #expect(!consumedOldNonempty)
        let consumedRevoke = mailbox.consume(revoke)
        #expect(consumedRevoke)
        let publishEmpty = mailbox.shouldPublish(empty)
        #expect(publishEmpty)
    }

    @Test func rowPrefixesMatchTheCivilRowStreamAcrossGregorianCyclesAndDomainEdges() {
        let checkpoints: Set<Int> = [0, 1, 4799, 4800, 4801, 9600, 24299,
                                      CalendarViewportMonth.lastSupportedIndex,
                                      CalendarViewportMonth.nativeMonthCount]
        for weekday in 1...7 {
            var expected = 0
            for index in 0...CalendarViewportMonth.nativeMonthCount {
                if checkpoints.contains(index) {
                    #expect(CalendarNativeMonthGeometry.rowsBeforeMonth(index: index, firstWeekday: weekday) == expected)
                }
                expected += CalendarNativeMonthGeometry.ownedRowCount(index: index, firstWeekday: weekday)
            }
        }
    }

    @Test func activeViewportStatusDoesNotAdoptForegroundLoadingOrEmptyAuthority() {
        for mode in [CalendarView.month, .year] {
            let pending = state("2026-09-01", hasProjection: false, view: mode, loading: .loading, freshness: .stale)
            let active = CalendarViewportData(generation: "status", revision: 1, months: [:], isActive: true)
            let inactive = CalendarViewportData(generation: "status", revision: 2, months: [:], isActive: false)
            #expect(CalendarScaffold.ownsViewportRequests(state: pending, viewportData: active))
            #expect(!CalendarScaffold.showsForegroundStatus(state: pending, viewportData: active))
            #expect(CalendarScaffold.showsForegroundStatus(state: pending, viewportData: inactive))
            #expect(CalendarScaffold.showsForegroundStatus(state: pending, viewportData: nil))
            let denied = state("2026-09-01", hasProjection: false, view: mode,
                               error: CalendarExperienceError(kind: .authorization, userMessage: "Calendar unavailable", recoverable: false))
            #expect(CalendarScaffold.showsForegroundStatus(state: denied, viewportData: active))
        }
    }

    @Test func monthBoundariesKeepOwnedDatesUniqueAndSeparatedForEveryWeekStart() throws {
        let starts: [Weekday] = [.sunday, .monday, .tuesday, .wednesday, .thursday, .friday, .saturday]
        for start in starts {
            let locale = CalendarLocale(languageTag: "en-US", timeZoneId: "UTC", weekStart: start, hourCycle: .hour12)
            let calendar = CalendarCivilMonth.calendar(locale)
            let layout = CalendarNativeViewportLayout()
            layout.firstWeekday = calendar.firstWeekday
            layout.viewportSize = CGSize(width: 392, height: 450)
            for year in [Int32(2026), Int32(2028)] {
                let first = CalendarViewportMonth(year: year - 1, month: 12).index
                var dates = Set<String>()
                var ownedRowCounts = Set<Int>()
                var priorFrame: CGRect?
                for index in first..<(first + 14) {
                    let civil = CalendarCivilMonth(id: .init(index: index), locale: locale)
                    let owned = civil.slots.enumerated().filter { !$0.element.outside }
                    ownedRowCounts.insert(civil.ownedRowCount)
                    let frame = layout.frame(index, progress: 1)
                    #expect(civil.ownedRowCount == CalendarNativeMonthGeometry.ownedRowCount(
                        index: index, firstWeekday: calendar.firstWeekday))
                    #expect(abs(frame.height - layout.monthHeight(for: index)) < 0.000001)
                    if let priorFrame {
                        #expect(abs(frame.minY - priorFrame.maxY) < 0.000001)
                    }
                    priorFrame = frame
                    for (slotIndex, slot) in owned {
                        #expect(dates.insert(slot.date).inserted)
                        let parts = slot.date.split(separator: "-").map { Int($0)! }
                        let date = try #require(calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])))
                        #expect(slotIndex % 7 == (calendar.component(.weekday, from: date) - calendar.firstWeekday + 7) % 7)
                    }
                }
                #expect(ownedRowCounts.contains(5))
                #expect(ownedRowCounts.contains(6))
                if start == .sunday && year == 2026 { #expect(ownedRowCounts.contains(4)) }
                if year == 2028 { #expect(dates.contains("2028-02-29")) }
            }
        }
    }

    @Test func monthFramesMorphLinearlyAndKeepPartialBoundariesSeparated() {
        let layout = CalendarNativeViewportLayout()
        layout.viewportSize = CGSize(width: 392, height: 450)
        let index = CalendarViewportMonth(year: 2028, month: 2).index
        let small = layout.frame(index, progress: 0)
        let large = layout.frame(index, progress: 1)
        for progress in [CGFloat(1), 0.8, 0.2, 0, 0.4, 0.8, 1] {
            let frame = layout.frame(index, progress: progress)
            #expect(abs(frame.minY - (small.minY + (large.minY - small.minY) * progress)) < 0.000001)
            #expect(abs(frame.height - (small.height + (large.height - small.height) * progress)) < 0.000001)
        }
        #expect(abs(layout.frame(index + 1, progress: 1).minY - large.maxY) < 0.000001)
        let civil = CalendarCivilMonth(id: .init(index: index), locale: locale)
        #expect((large.height - layout.headingHeight) / CGFloat(civil.ownedRowCount) >= 44)
    }

    @Test func monthBoundaryDatesHaveOneDrawHitAndAccessibilityOwnerInBothDirections() throws {
        for rtl in [false, true] {
            let layout = CalendarNativeViewportLayout()
            layout.viewportSize = CGSize(width: 392, height: 450)
            let april = CalendarViewportMonth(year: 2026, month: 4)
            let may = CalendarViewportMonth(year: 2026, month: 5)
            let base = layout.frame(april.index, progress: 1).minY
            let container = UIView(frame: CGRect(x: 0, y: 0, width: 392,
                                                  height: layout.frame(may.index, progress: 1).maxY - base + 44))
            var ids = Set<String>()
            var nativeCells: [CalendarReusableMonthCell] = []
            for id in [april, may] {
                let civil = CalendarCivilMonth(id: id, locale: locale)
                let cell = CalendarReusableMonthCell(frame: layout.frame(id.index, progress: 1).offsetBy(dx: 0, dy: -base))
                cell.configure(month: civil, period: nil, today: "2026-05-01", selected: "2026-05-01",
                               progress: 1, expanded: true, dateSize: 12.5, rightToLeft: rtl,
                               contrast: false, enabled: true, contentVersion: 1, moveMonth: { _ in }, activate: { _ in })
                container.addSubview(cell)
                cell.layoutIfNeeded()
                let control = try #require(cell.contentView.subviews.first as? UIControl)
                control.layoutIfNeeded()
                let elements = try #require(control.accessibilityElements as? [UIAccessibilityElement])
                let dateElements = elements.filter { $0.accessibilityIdentifier?.hasPrefix("calendar-date-") == true }
                #expect(dateElements.count == civil.slots.filter { !$0.outside }.count)
                #expect(elements.first?.accessibilityTraits.contains(.header) == true)
                #expect(elements.first?.accessibilityTraits.contains(.button) == false)
                let heading = try #require(elements.first)
                for element in dateElements {
                    let identifier = try #require(element.accessibilityIdentifier)
                    #expect(ids.insert(identifier).inserted)
                    let rect = element.accessibilityFrameInContainerSpace
                    #expect(rect.width >= 44 && rect.height >= 44)
                    #expect(abs(rect.height / rect.width - 1.2) < 0.000001)
                }
                let firstDate = try #require(dateElements.min { $0.accessibilityFrameInContainerSpace.minY < $1.accessibilityFrameInContainerSpace.minY })
                #expect(heading.accessibilityFrameInContainerSpace.maxY <= firstDate.accessibilityFrameInContainerSpace.minY)
                nativeCells.append(cell)
            }
            let boundaryFrames = try ["2026-04-30", "2026-05-01"].map { date -> CGRect in
                let owner = date.contains("-04-") ? nativeCells[0] : nativeCells[1]
                let control = try #require(owner.contentView.subviews.first as? UIControl)
                let element = try #require((control.accessibilityElements as? [UIAccessibilityElement])?.first {
                    $0.accessibilityIdentifier == "calendar-date-\(date)"
                })
                return control.convert(element.accessibilityFrameInContainerSpace, to: container)
            }
            #expect(boundaryFrames[1].minY >= boundaryFrames[0].maxY)

            for (cell, date) in zip(nativeCells, ["2026-04-30", "2026-05-01"]) {
                let control = try #require(cell.contentView.subviews.first as? UIControl)
                let element = try #require((control.accessibilityElements as? [UIAccessibilityElement])?.first {
                    $0.accessibilityIdentifier == "calendar-date-\(date)"
                })
                let rect = element.accessibilityFrameInContainerSpace
                let point = control.convert(CGPoint(x: rect.midX, y: rect.midY), to: container)
                #expect(container.hitTest(point, with: nil) === control)
                if date == "2026-05-01" {
                    #expect(element.accessibilityTraits.contains(.selected))
                    #expect(element.accessibilityLabel?.contains("Today") == true)
                    #expect(element.accessibilityLabel?.contains("Outside month") == false)
                }
            }
        }
    }

    private func nativeInput(
        _ state: CalendarUiState, data: CalendarViewportData, rtl: Bool = false,
        browse: CalendarViewportMonth? = nil, reduceMotion: Bool = false,
        bottomOcclusion: CGFloat = 0, dateWidth: CGFloat = 44,
        onBrowse: @escaping (CalendarViewportMonth) -> Void = { _ in },
        onSelect: @escaping (String) -> Void = { _ in },
        onRequest: @escaping (CalendarViewportRequest) -> Void = { _ in }
    ) -> CalendarNativeViewportInput {
        CalendarNativeViewportInput(
            state: state, data: data, browsedMonth: browse, rightToLeft: rtl,
            increasedContrast: false, accessibilitySize: false, reduceMotion: reduceMotion,
            dateSize: 12.5, rowHeight: 53, dateWidth: dateWidth,
            onSelectDate: onSelect, onSelectMonth: { _, _ in }, onRequest: onRequest, onBrowse: onBrowse,
            bottomOcclusion: bottomOcclusion
        )
    }

    private func sendKey(_ input: String, to control: UIControl) throws {
        let command = try #require(control.keyCommands?.first { $0.input == input })
        _ = control.perform(command.action, with: command)
    }

    @Test func keyboardCrossesCivilOwnersByExactDateInBothDirectionsAndRTL() async throws {
        for rtl in [false, true] {
            let forward = rtl ? UIKeyCommand.inputLeftArrow : UIKeyCommand.inputRightArrow
            let backward = rtl ? UIKeyCommand.inputRightArrow : UIKeyCommand.inputLeftArrow
            let cases = [
                ("2028-02-29", forward, "2028-03-01"),
                ("2028-03-01", backward, "2028-02-29"),
                ("2028-02-25", UIKeyCommand.inputDownArrow, "2028-03-03"),
                ("2028-03-03", UIKeyCommand.inputUpArrow, "2028-02-25"),
                // Slot zero minus seven and slot 36 plus seven must not clamp
                // to the old 42-slot projection envelope either.
                ("2026-02-01", UIKeyCommand.inputUpArrow, "2026-01-25"),
                ("2021-05-31", UIKeyCommand.inputDownArrow, "2021-06-07")
            ]
            for (source, key, target) in cases {
                let controller = CalendarViewportController()
                let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
                let window = UIWindow(windowScene: scene)
                window.rootViewController = controller
                defer { controller.dispose(); window.isHidden = true }
                let (requests, continuation) = AsyncStream<CalendarViewportRequest>.makeStream()
                defer { continuation.finish() }
                var iterator = requests.makeAsyncIterator()
                var activated: [String] = []
                let data = CalendarViewportData(generation: "keyboard", revision: 1, months: [:], isActive: true)
                controller.update(nativeInput(state(source), data: data, rtl: rtl,
                                              onSelect: { activated.append($0) }, onRequest: { continuation.yield($0) }), progress: 1)
                window.makeKeyAndVisible()
                controller.view.layoutIfNeeded()
                controller.viewDidLayoutSubviews()
                let request = try #require(await iterator.next())
                #expect(!request.months.isEmpty)
                let collection = try #require(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
                collection.layoutIfNeeded()
                let sourcePath = IndexPath(item: CalendarViewportMonth(date: source).index, section: 0)
                let sourceCell = try #require(collection.cellForItem(at: sourcePath) as? CalendarReusableMonthCell)
                #expect(sourceCell.focusForKeyboard(date: source) != nil)
                let sourceControl = try #require(sourceCell.contentView.subviews.first as? UIControl)
                try sendKey(key, to: sourceControl)
                let targetPath = IndexPath(item: CalendarViewportMonth(date: target).index, section: 0)
                let targetCell = try #require(collection.cellForItem(at: targetPath) as? CalendarReusableMonthCell)
                let targetControl = try #require(targetCell.contentView.subviews.first as? UIControl)
                #expect(targetControl.isFirstResponder)
                #expect(!sourceControl.isFirstResponder)
                try sendKey("\r", to: targetControl)
                #expect(activated == [target])
                let targetElement = try #require((targetControl.accessibilityElements as? [UIAccessibilityElement])?.first {
                    $0.accessibilityIdentifier == "calendar-date-\(target)"
                })
                #expect(targetElement.accessibilityFrameInContainerSpace.width >= 44)
                #expect(targetElement.accessibilityFrameInContainerSpace.height >= 44)
                #expect(!(sourceControl.accessibilityElements as? [UIAccessibilityElement] ?? []).contains {
                    $0.accessibilityIdentifier == "calendar-date-\(target)"
                })
            }
        }
    }

    @Test func terminalMonthAndYearContentAndFocusClearFloatingControls() async throws {
        let terminal = CalendarViewportMonth(year: 9999, month: 11)
        for mode in [CalendarView.month, .year] {
            let controller = CalendarViewportController()
            let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = controller
            defer { controller.dispose(); window.isHidden = true }
            let (stream, continuation) = AsyncStream<CalendarViewportRequest>.makeStream()
            defer { continuation.finish() }
            var iterator = stream.makeAsyncIterator()
            let data = CalendarViewportData(generation: "terminal", revision: 1, months: [:], isActive: true)
            // A native Year viewport browses month-unit leases independently
            // of its foreground projection. A whole-year 9999 projection is
            // NOT representable (its exclusive end is 10000-01-01). Keep a
            // valid foreground state and browse the actual final native month;
            // do not narrow the native month domain to avoid the fixture bug.
            controller.update(nativeInput(state("2028-02-14", view: mode), data: data,
                                          browse: terminal, bottomOcclusion: 120,
                                          dateWidth: mode == .month ? 160 : 44,
                                          onRequest: { continuation.yield($0) }),
                              progress: mode == .year ? 0 : 1)
            window.makeKeyAndVisible()
            controller.view.layoutIfNeeded()
            controller.viewDidLayoutSubviews()
            let request = try #require(await iterator.next())
            #expect(request.months.contains(terminal))
            #expect(request.months.allSatisfy { $0.isNativeSupported })
            let collection = try #require(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
            collection.layoutIfNeeded()
            let path = IndexPath(item: terminal.index, section: 0)
            let cell = try #require(collection.cellForItem(at: path) as? CalendarReusableMonthCell)
            let control = try #require(cell.contentView.subviews.first as? UIControl)
            #expect(collection.contentInset.bottom == 120)
            #expect(collection.verticalScrollIndicatorInsets.bottom == 120)
            let maximumOffset = collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom
            collection.contentOffset.y = maximumOffset
            collection.layoutIfNeeded()
            #expect(cell.frame.maxY <= collection.bounds.maxY - 120 + 1)

            if mode == .month {
                let date = try #require((control.accessibilityElements as? [UIAccessibilityElement])?.first {
                    $0.accessibilityIdentifier == "calendar-date-9999-11-30"
                })
                let rect = control.convert(date.accessibilityFrameInContainerSpace, to: collection)
                collection.contentOffset.y = rect.maxY - collection.bounds.height + 20
                #expect(cell.focusForKeyboard(date: "9999-11-29") != nil)
                // Same-month keyboard navigation used to update only drawn
                // focus, leaving the date hidden behind the floating controls.
                try sendKey(UIKeyCommand.inputRightArrow, to: control)
                #expect(rect.maxY <= collection.bounds.maxY - 120 + 1)
                // Wide Dynamic Type columns must still scroll horizontally;
                // adding bottom occlusion must not regress native date focus.
                #expect(rect.minX >= collection.bounds.minX - 1)
                #expect(rect.maxX <= collection.bounds.maxX + 1)
                collection.contentOffset.y = rect.maxY - collection.bounds.height + 20
                NotificationCenter.default.post(name: UIAccessibility.elementFocusedNotification,
                                                object: nil, userInfo: [UIAccessibility.focusedElementUserInfoKey: date])
                #expect(rect.maxY <= collection.bounds.maxY - 120 + 1)
            } else {
                collection.contentOffset.y = cell.frame.maxY - collection.bounds.height + 20
                NotificationCenter.default.post(name: UIAccessibility.elementFocusedNotification,
                                                object: nil, userInfo: [UIAccessibility.focusedElementUserInfoKey: control])
                #expect(cell.frame.maxY <= collection.bounds.maxY - 120 + 1)
            }
        }
    }

    @Test func explicitLeaseAuthoritySurvivesNilForegroundButRevokesCurrentAndRecycledContent() async throws {
        let controller = CalendarViewportController()
        defer { controller.dispose() }
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 392, height: 500)
        let month = CalendarViewportMonth(year: 2028, month: 2)
        let periods = [month: CalendarViewportMonthData(cells: cells(eventCount: 4), availability: .ready)]
        let (requests, continuation) = AsyncStream<CalendarViewportRequest>.makeStream()
        defer { continuation.finish() }
        var iterator = requests.makeAsyncIterator()
        func update(active: Bool, foreground: Bool, revision: Int = 1,
                    supplied: [CalendarViewportMonth: CalendarViewportMonthData]? = nil, progress: CGFloat = 1) {
            let data = CalendarViewportData(generation: "lease", revision: revision, months: supplied ?? periods, isActive: active)
            controller.update(nativeInput(state("2028-02-14", hasProjection: foreground), data: data,
                                          onRequest: { continuation.yield($0) }), progress: progress)
        }
        update(active: true, foreground: false)
        controller.viewDidLayoutSubviews()
        let request = try #require(await iterator.next())
        #expect(request.months.contains(month))
        let collection = try #require(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
        collection.layoutIfNeeded()
        let path = IndexPath(item: month.index, section: 0)
        let cell = try #require(collection.cellForItem(at: path) as? CalendarReusableMonthCell)
        let control = try #require(cell.contentView.subviews.first as? UIControl)
        let host = try #require(control.subviews.first)
        func eventDate() throws -> UIAccessibilityElement {
            try #require((control.accessibilityElements as? [UIAccessibilityElement])?.first {
                $0.accessibilityIdentifier == "calendar-date-2028-02-14"
            })
        }
        let original = try eventDate()
        #expect(original.accessibilityLabel?.contains("4 events") == true)
        update(active: true, foreground: true)
        update(active: true, foreground: false)
        #expect(try eventDate() === original)
        #expect(original.accessibilityLabel?.contains("4 events") == true)
        #expect(control.subviews.first === host && !host.isHidden)
        update(active: true, foreground: false, progress: 0.4)
        let layout = try #require(collection.collectionViewLayout as? CalendarNativeViewportLayout)
        #expect(layout.progress == 0.4) // Foreground loading must not snap the morph.
        update(active: true, foreground: false)
        #expect(try eventDate().accessibilityLabel?.contains("4 events") == true)
        let civilElement = try eventDate()
        let civilFrame = civilElement.accessibilityFrameInContainerSpace
        update(active: true, foreground: false, revision: 2, supplied: [:])
        #expect(try eventDate() === civilElement)
        #expect(civilElement.accessibilityLabel?.contains("Event data not loaded") == true)
        #expect(civilElement.accessibilityLabel?.contains("0 events") == false)
        #expect(civilElement.accessibilityFrameInContainerSpace == civilFrame)
        #expect(control.subviews.first === host && !host.isHidden && collection.alpha == 1)
        update(active: true, foreground: false, revision: 3)
        #expect(try eventDate() === civilElement)
        #expect(civilElement.accessibilityLabel?.contains("4 events") == true)
        #expect(civilElement.accessibilityFrameInContainerSpace == civilFrame)
        #expect(control.subviews.first === host && !host.isHidden && collection.alpha == 1)
        let beforeRevocation = try eventDate()
        update(active: false, foreground: true, progress: 0.4)
        #expect(layout.progress == 1)
        #expect(host.isHidden)
        #expect(control.accessibilityElements == nil && !control.isEnabled)
        #expect(beforeRevocation.accessibilityLabel == nil && !beforeRevocation.accessibilityActivate())
        let cancellation = try #require(await iterator.next())
        #expect(cancellation.months.isEmpty)
        // An active empty CURRENT map cannot resurrect the previously supplied
        // map, even with a loaded foreground or the same generation/revision.
        update(active: true, foreground: true, supplied: [:])
        #expect(try eventDate().accessibilityLabel?.contains("Event data not loaded") == true)
        #expect(try eventDate().accessibilityLabel?.contains("4 events") == false)
        #expect(control.subviews.first === host)
        cell.prepareForReuse()
        update(active: false, foreground: true)
        #expect(host.isHidden && control.accessibilityElements == nil)
    }

    @Test func yearCivilOwnerDistinguishesUnknownFromKnownEmptyAcrossArrivalAndReuse() throws {
        let cell = CalendarReusableMonthCell(frame: CGRect(x: 0, y: 0, width: 196, height: 240))
        let civil = CalendarCivilMonth(id: .init(year: 2028, month: 2), locale: locale)
        func configure(_ period: CalendarViewportMonthData?, revision: Int) {
            cell.configure(month: civil, period: period, today: "2028-02-14", selected: "2028-02-14",
                           progress: 0, expanded: false, dateSize: 12.5, rightToLeft: false,
                           contrast: false, enabled: true, contentVersion: revision,
                           moveMonth: { _ in }, activate: { _ in })
            cell.layoutIfNeeded()
        }
        configure(nil, revision: 1)
        let control = try #require(cell.contentView.subviews.first as? UIControl)
        let host = try #require(control.subviews.first)
        #expect(control.accessibilityValue == "Event data not loaded")
        #expect(control.isEnabled && !host.isHidden)
        let frame = control.frame
        configure(.init(cells: cells(), availability: .ready), revision: 2)
        #expect(control.accessibilityValue == "0 event days")
        #expect(control.frame == frame && control.subviews.first === host && !host.isHidden)
        configure(.init(cells: cells(eventCount: 4), availability: .ready), revision: 3)
        #expect(control.accessibilityValue == "1 event days")
        #expect(control.frame == frame && control.subviews.first === host && !host.isHidden)
        cell.prepareForReuse()
        #expect(host.isHidden && !control.isEnabled)
        configure(nil, revision: 3)
        #expect(control.accessibilityValue == "Event data not loaded")
        #expect(control.frame == frame && control.subviews.first === host && !host.isHidden)
    }

    @Test func staleProjectedRolesNeverLeakIntoCurrentDateAccessibility() throws {
        let cell = CalendarReusableMonthCell(frame: CGRect(x: 0, y: 0, width: 392, height: 420))
        let civil = CalendarCivilMonth(id: .init(year: 2028, month: 2), locale: locale)
        let supplied = cells(eventCount: 4)
        #expect(supplied.first { $0.date == "2028-02-14" }?.isToday == true)
        let period = CalendarViewportMonthData(cells: supplied, availability: .ready)
        func configure(today: String, selected: String) {
            cell.configure(month: civil, period: period, today: today, selected: selected,
                           progress: 1, expanded: true, dateSize: 12.5, rightToLeft: false,
                           contrast: false, enabled: true, contentVersion: 1, moveMonth: { _ in }, activate: { _ in })
        }
        configure(today: "2028-02-14", selected: "2028-02-14")
        let control = try #require(cell.contentView.subviews.first as? UIControl)
        let host = try #require(control.subviews.first)
        let elements = try #require(control.accessibilityElements as? [UIAccessibilityElement])
        let old = try #require(elements.first { $0.accessibilityIdentifier == "calendar-date-2028-02-14" })
        configure(today: "2028-02-15", selected: "2028-02-16")
        #expect(control.subviews.first === host && !host.isHidden)
        #expect((control.accessibilityElements as? [UIAccessibilityElement])?.first === elements.first)
        #expect(old.accessibilityLabel == civil.slots.first { $0.date == "2028-02-14" }!.label + ", 4 events, +2 more")
        #expect(!old.accessibilityTraits.contains(.selected))
        let today = try #require(elements.first { $0.accessibilityIdentifier == "calendar-date-2028-02-15" })
        let selected = try #require(elements.first { $0.accessibilityIdentifier == "calendar-date-2028-02-16" })
        #expect(today.accessibilityLabel == civil.slots.first { $0.date == "2028-02-15" }!.label + ", 0 events, Today")
        #expect(selected.accessibilityLabel == civil.slots.first { $0.date == "2028-02-16" }!.label + ", 0 events, Selected")
        #expect(selected.accessibilityTraits.contains(.selected))
    }

    private func state(_ anchor: String, hasProjection: Bool = true, view: CalendarView = .month,
                       loading: CalendarLoadingPhase = .idle, freshness: CalendarCacheFreshness = .fresh,
                       offline: CalendarOfflineState = .online, error: CalendarExperienceError? = nil) -> CalendarUiState {
        let projection = CalendarProjection().project(request: CalendarProjectionRequest(
            occurrences: [], anchorDate: anchor, view: view,
            selectedDate: anchor, todayDate: anchor, locale: locale,
            filters: CalendarFilters(scope: .all, groups: [], tags: [], importance: nil, text: "")
        ))
        return CalendarUiState(CalendarExperienceState(
            anchorDate: anchor, view: view, selectedDate: anchor, filters: projection.filters,
            locale: locale, todayDate: anchor, visibleInterval: projection.interval, selectedInterval: nil,
            authorizedOccurrences: [], projection: hasProjection ? projection : nil, facets: projection.facets,
            freshness: freshness, loading: CalendarLoadingState(phase: loading), offline: offline,
            error: error, hasCompleteCache: true, cachedWindow: nil, persistedCachePreferences: nil,
            presentationReady: true,
            recovery: CalendarRecoveryState(phase: .idle, generation: 0, failureKind: nil),
            mutationAvailability: CalendarMutationAvailability(canCreate: true, canEdit: true, canDelete: true, reason: nil),
            mutation: CalendarMutationState(phase: .idle, preview: nil, editor: nil, deleteConfirmation: nil,
                                          pendingRequest: nil, error: nil, conflict: nil, outcome: nil,
                                          successorEventId: nil, affectedWindows: [])
        ))
    }

    @Test func interpolationKeepsNativeHostAndRevokesOldAccessibilityOnReuse() throws {
        let cell = CalendarReusableMonthCell(frame: CGRect(x: 0, y: 0, width: 392, height: 420))
        let civil = CalendarCivilMonth(id: .init(year: 2028, month: 2), locale: locale)
        let period = CalendarViewportMonthData(cells: cells(), availability: .ready)
        func configure(_ progress: CGFloat) {
            cell.configure(month: civil, period: period, today: "2028-02-14", selected: "2028-02-14",
                           progress: progress, expanded: true, dateSize: 12.5, rightToLeft: false,
                           contrast: false, enabled: progress == 1, contentVersion: 1,
                           moveMonth: { _ in }, activate: { _ in })
        }
        configure(1)
        let control = try #require(cell.contentView.subviews.first as? UIControl)
        let host = try #require(control.subviews.first)
        let date = try #require(control.accessibilityElements?.first as? UIAccessibilityElement)
        control.layoutIfNeeded()
        let selected = try #require((control.accessibilityElements as? [UIAccessibilityElement])?.first {
            $0.accessibilityIdentifier == "calendar-date-2028-02-14"
        })
        let selectedFrame = selected.accessibilityFrameInContainerSpace
        #expect(selected.accessibilityTraits.contains(.selected))
        #expect(selectedFrame.width >= 44 && selectedFrame.height >= 44)
        configure(1)
        #expect((control.accessibilityElements?.first as? UIAccessibilityElement) === date)
        for progress in [CGFloat(0.9), 0.7, 0.4, 0.2, 0.6, 0.9] {
            configure(progress)
            control.setNeedsLayout()
            control.layoutIfNeeded()
            #expect(control.subviews.first === host)
            #expect(control.accessibilityElements == nil)
        }
        #expect(date.accessibilityLabel == nil)
        #expect(!date.accessibilityActivate())
        configure(1)
        let replacement = try #require(control.accessibilityElements?.first as? UIAccessibilityElement)
        let restored = try #require((control.accessibilityElements as? [UIAccessibilityElement])?.first {
            $0.accessibilityIdentifier == "calendar-date-2028-02-14"
        })
        #expect(restored.accessibilityFrameInContainerSpace == selectedFrame)
        cell.prepareForReuse()
        #expect(control.subviews.first === host)
        #expect(host.isHidden)
        #expect(replacement.accessibilityLabel == nil)
        #expect(!replacement.accessibilityActivate())
        configure(1)
        #expect(control.subviews.first === host)
        #expect(!host.isHidden)
        cell.configure(month: civil, period: period, today: "2028-02-14", selected: "2028-02-14",
                       progress: 0, expanded: false, dateSize: 12.5, rightToLeft: false,
                       contrast: false, enabled: true, contentVersion: 1, moveMonth: { _ in }, activate: { _ in })
        #expect(control.isAccessibilityElement)
        #expect(control.accessibilityElements == nil)
        #expect(cell.hitTest(CGPoint(x: 1, y: 1), with: nil) === control)
        #expect(control.subviews.first === host)
    }
}
