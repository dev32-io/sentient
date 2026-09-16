import MobileData
import SwiftUI
import Testing
import UIKit
@testable import SentientApp

@MainActor
struct CalendarAdjacentViewportTests {
    private let locale = CalendarLocale(
        languageTag: "en-US", timeZoneId: "UTC", weekStart: .monday, hourCycle: .hour12
    )

    @Test func civilDomainAndClampedTerminalCursorKeepEligibleStableSlots() async throws {
        let day = page(.day, "2028-02-29")
        let dayDomain = CalendarAdjacentDomain(center: day)
        #expect(dayDomain.totalCount > 3_000_000)
        #expect(dayDomain.count == CalendarAdjacentDomain.maximumSlots)
        #expect(dayDomain.index(of: day).flatMap(dayDomain.period(at:)) == day)
        let first = page(.day, "0001-01-01")
        let last = page(.day, "9999-11-30")
        #expect(CalendarAdjacentDomain(center: first).period(at: 0) == first)
        let terminalDomain = CalendarAdjacentDomain(center: last)
        #expect(terminalDomain.period(at: terminalDomain.count - 1) == last)

        let week = page(.week, "2028-03-01")
        let weekDomain = CalendarAdjacentDomain(center: week)
        #expect(weekDomain.step == 7)
        #expect(weekDomain.index(of: week).flatMap(weekDomain.period(at:)) == week)

        let focus = FocusHarness()
        let invalid = page(.day, "9999-12-31")
        let controller = makeController(height: 500)
        var browsed: [CalendarViewportDate] = []
        var requests: [CalendarAdjacentViewportRequest] = []
        controller.update(input(
            current: invalid, generation: "clamp", revision: 1, pages: [:], focus: focus.binding,
            onRequest: { requests.append($0) }, onBrowse: { browsed.append($0) }
        ), rightToLeft: false)
        layout(controller)
        await controller.waitForPendingSnapshots()
        #expect(controller.current == last)
        #expect(browsed.map(\.date) == ["9999-11-30"])
        #expect(requests.last?.periods.first == last.anchor)
        #expect(requests.allSatisfy {
            $0.periods.count <= CalendarAdjacentPeriodWindow.maximumPeriods + 1 &&
                $0.periods.allSatisfy(\.isAdjacentViewportEligible)
        })
    }

    @Test func arithmeticLayoutIsSparseAndUsesNativeOffsetAdjustment() throws {
        let layout = CalendarAdjacentViewportLayout()
        layout.viewportWidth = 390
        layout.configure(itemCount: CalendarAdjacentDomain.maximumSlots, estimatedHeight: 64)
        let collection = UICollectionView(
            frame: CGRect(x: 0, y: 1_000_000, width: 390, height: 700), collectionViewLayout: layout
        )
        collection.layoutIfNeeded()
        let attributes = try #require(layout.layoutAttributesForElements(in: collection.bounds))
        #expect(!attributes.isEmpty && attributes.count < 50)
        #expect(layout.collectionViewContentSize.height > 1_000_000)

        collection.contentOffset.y = 700
        let above = try #require(layout.layoutAttributesForItem(at: IndexPath(item: 0, section: 0)))
        let taller = above.copy() as! UICollectionViewLayoutAttributes
        taller.size.height += 40
        let context = layout.invalidationContext(
            forPreferredLayoutAttributes: taller, withOriginalAttributes: above
        )
        #expect(context.contentOffsetAdjustment.y == 40)
    }

    @Test func latestGenerationRevisionWinsSizingAndReentrantRequest() async throws {
        for mode in [CalendarView.day, .week] {
            let focus = FocusHarness()
            let center = page(mode, "2028-02-29")
            let next = try #require(center.next)
            let latest = try #require(next.next)
            let controller = CalendarAdjacentViewController()
            controller.loadViewIfNeeded()
            controller.view.frame = .zero
            var requests: [CalendarAdjacentViewportRequest] = []
            var opened = 0
            var make: ((CalendarAdjacentPageID, Int, [CalendarAdjacentPageID: CalendarAdjacentPageData]) -> CalendarAdjacentViewport)!
            make = { current, revision, pages in
                self.input(
                    current: current, generation: "latest-\(mode)", revision: revision, pages: pages,
                    focus: focus.binding,
                    onRequest: { request in
                        requests.append(request)
                        if requests.count == 1 {
                            controller.update(make(latest, 4, [latest: self.data(latest, ids: ["latest"])]), rightToLeft: false)
                        }
                    },
                    onEvent: { _ in opened += 1 }
                )
            }
            controller.update(make(center, 1, [:]), rightToLeft: false)
            controller.update(make(next, 2, [:]), rightToLeft: false)
            await controller.waitForPendingSnapshots()
            #expect(requests.isEmpty)

            controller.update(make(latest, 3, [:]), rightToLeft: false)
            controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
            layout(controller)
            await controller.waitForPendingSnapshots()
            await controller.waitForPendingSnapshots()
            #expect(controller.current == latest)
            #expect(!requests.isEmpty)
            #expect(requests.last?.periods.first == latest.anchor)
            #expect(requests.allSatisfy { $0.periods.count <= CalendarAdjacentPeriodWindow.maximumPeriods + 1 })
            let cell = try periodCell(latest, controller: controller)
            let eventID = try #require(cell.rowIDs.first { $0.isEvent })
            cell.eventAction(for: eventID)?()
            #expect(opened == 1)

            let previousRequestCount = requests.count
            controller.update(input(
                current: latest, generation: "successor-\(mode)", revision: 1,
                pages: [latest: data(latest, ids: ["successor"])], focus: focus.binding,
                onRequest: { requests.append($0) }, onEvent: { _ in opened += 10 }
            ), rightToLeft: false)
            layout(controller)
            await controller.waitForPendingSnapshots()
            #expect(requests.count > previousRequestCount)
            #expect(requests.last?.periods.first == latest.anchor)
        }
    }

    @Test func revisionAndRevocationRetirePixelsAXInteractionAndCallbacksSynchronously() async throws {
        let focus = FocusHarness()
        let center = page(.day, "2028-02-29")
        let controller = makeController()
        var opened = 0
        controller.update(input(
            current: center, generation: "authority", revision: 1,
            pages: [center: data(center, ids: ["old"])], focus: focus.binding,
            onEvent: { _ in opened += 1 }
        ), rightToLeft: false)
        layout(controller)
        await controller.waitForPendingSnapshots()
        let cell = try periodCell(center, controller: controller)
        let id = try #require(cell.rowIDs.first { $0.isEvent })
        let oldView = try #require(cell.hostedView(for: id))
        let staleAction = try #require(cell.eventAction(for: id))

        controller.update(input(
            current: center, generation: "authority", revision: 2, pages: [:], focus: focus.binding,
            onEvent: { _ in opened += 100 }
        ), rightToLeft: false)
        #expect(oldView.superview == nil)
        #expect(!oldView.isUserInteractionEnabled)
        #expect(oldView.accessibilityElementsHidden)
        #expect(!cell.rowIDs.contains(id))
        staleAction()
        #expect(opened == 0)

        let allocated = try collection(controller).visibleCells.compactMap { $0 as? CalendarAdjacentPeriodCell }
        controller.update(input(
            current: center, generation: "revoked", revision: 3, pages: [:], focus: focus.binding,
            isActive: false, onEvent: { _ in opened += 1_000 }
        ), rightToLeft: false)
        #expect(allocated.allSatisfy {
            $0.period == nil && $0.contentView.alpha == 0 && !$0.contentView.isUserInteractionEnabled &&
                $0.contentView.accessibilityElementsHidden
        })
        staleAction()
        #expect(opened == 0)
    }

    @Test func rowAnchorSurvivesInsertRemoveAndHeightPublicationInsideVisiblePeriod() async throws {
        for mode in [CalendarView.day, .week] {
            let focus = FocusHarness()
            let center = page(mode, "2028-02-29")
            let controller = makeController(height: 520)
            var revision = 1
            var ids = ["base-1", "base-2", "anchor", "base-4", "base-5"]
            func update() {
                controller.update(input(
                    current: center, generation: "row-anchor-\(mode)", revision: revision,
                    pages: [center: data(center, ids: ids, long: true)], focus: focus.binding
                ), rightToLeft: false)
            }
            update()
            layout(controller)
            await controller.waitForPendingSnapshots()
            let collection = try collection(controller)
            let cell = try periodCell(center, controller: controller)
            let anchorID = try #require(cell.rowIDs.first { id in
                if case .event(let key) = id.kind { return key.contains("anchor") }
                return false
            })
            let frame = try #require(cell.rowFrame(for: anchorID, in: collection))
            collection.contentOffset.y += frame.minY - collection.bounds.minY - 80
            controller.scrollViewDidScroll(collection)
            collection.layoutIfNeeded()
            let contentAnchor = try #require(cell.visibleRowAnchors().first?.id)
            #expect(contentAnchor.isEvent)
            let screenY = try #require(cell.rowFrame(for: contentAnchor, in: collection)?.minY) - collection.bounds.minY

            ids.insert(contentsOf: ["insert-1", "insert-2"], at: 0)
            revision += 1
            update()
            layout(controller)
            let insertedY = try #require(cell.rowFrame(for: contentAnchor, in: collection)?.minY) - collection.bounds.minY
            #expect(abs(insertedY - screenY) < 1)
            #expect(collection.isScrollEnabled)

            ids.removeFirst(2)
            revision += 1
            update()
            layout(controller)
            let removedY = try #require(cell.rowFrame(for: contentAnchor, in: collection)?.minY) - collection.bounds.minY
            #expect(abs(removedY - screenY) < 1)
            #expect(collection.numberOfItems(inSection: 0) == CalendarAdjacentDomain.maximumSlots)

            // The publication anchor is consumed: a later layout must not undo
            // movement after the insert/remove correction has settled.
            collection.contentOffset.y += 47
            controller.scrollViewDidScroll(collection)
            let movedOffset = collection.contentOffset.y
            let movedY = try #require(cell.rowFrame(for: contentAnchor, in: collection)?.minY) - movedOffset
            #expect(abs(movedY - (removedY - 47)) < 1)
            layout(controller)
            #expect(abs(collection.contentOffset.y - movedOffset) < 1)
            let settledY = try #require(cell.rowFrame(for: contentAnchor, in: collection)?.minY) - collection.bounds.minY
            #expect(abs(settledY - movedY) < 1)
        }
    }

    @Test func revisionHeightPublicationPublishesOnlyCommittedRowOwnership() async throws {
        let focus = FocusHarness()
        let center = page(.day, "2028-02-29")
        let next = try #require(center.next)
        let controller = makeController(height: 520)
        var revision = 1
        var ids = ["base-1", "base-2", "anchor", "base-4", "base-5"]
        var browses: [(CalendarViewportDate, Set<CalendarAdjacentRowID>)] = []
        var requests: [(CalendarAdjacentViewportRequest, Set<CalendarAdjacentRowID>)] = []
        func update() {
            controller.update(input(
                current: center, generation: "publication-boundary", revision: revision,
                pages: [center: data(center, ids: ids, long: true)], focus: focus.binding,
                onRequest: { requests.append(($0, Set(controller.rowIdentities))) },
                onBrowse: { browses.append(($0, Set(controller.rowIdentities))) }
            ), rightToLeft: false)
        }

        update()
        layout(controller)
        await controller.waitForPendingSnapshots()
        let collection = try collection(controller)
        let nativeLayout = try #require(collection.collectionViewLayout as? CalendarAdjacentViewportLayout)
        let domain = CalendarAdjacentDomain(center: center)
        let centerIndex = try #require(domain.index(of: center))

        // Establish a different published leading period, then move native
        // geometry back without publishing. Height invalidation below must not
        // let its synchronous scroll callback expose old row ownership.
        collection.contentOffset.y = nativeLayout.frame(at: try #require(domain.index(of: next))).minY + 1
        controller.scrollViewDidScroll(collection)
        #expect(browses.last?.0 == next.anchor)
        collection.delegate = nil
        collection.contentOffset.y = nativeLayout.frame(at: try #require(domain.index(of: center))).minY + 80
        collection.layoutIfNeeded()
        collection.delegate = controller
        browses.removeAll()
        requests.removeAll()
        var probed = false
        var probeBrowseCount = 0
        var probePublicationPasses = 0
        controller.rowPublicationProbe = {
            guard !probed else { return }
            probed = true
            collection.delegate = nil
            collection.contentOffset.y = nativeLayout.frame(at: centerIndex).minY + 1
            collection.layoutIfNeeded()
            collection.delegate = controller
            let before = browses.count
            let publicationPasses = controller.viewportPublicationPasses
            controller.scrollViewDidScroll(collection)
            probeBrowseCount = browses.count - before
            probePublicationPasses = controller.viewportPublicationPasses - publicationPasses
        }

        ids.insert(contentsOf: ["insert-1", "insert-2"], at: 0)
        revision += 1
        update()
        layout(controller)
        collection.contentOffset.y = nativeLayout.frame(at: try #require(domain.index(of: center))).minY + 1
        controller.scrollViewDidScroll(collection)
        await controller.waitForPendingSnapshots()

        let committed = Set(controller.rowIdentities)
        #expect(probed)
        #expect(probeBrowseCount == 0)
        #expect(probePublicationPasses == 0)
        #expect(browses.allSatisfy { $0.1 == committed })
        #expect(requests.count == 1)
        #expect(requests.first?.0.periods.first == center.anchor)
        #expect(requests.allSatisfy { $0.1 == committed })
        #expect(committed.contains { id in
            if case .event(let key) = id.kind { return key.contains("insert-1") }
            return false
        })
    }

    @Test func browseEchoCursorClearAndTodayCommandHaveSeparateAuthority() async throws {
        let focus = FocusHarness()
        let center = page(.day, "2028-02-29")
        let target = try #require(center.next)
        let controller = makeController(height: 560)
        var browsed: [CalendarViewportDate] = []
        func update(_ current: CalendarAdjacentPageID, semantic: CalendarViewportDate, today: Int = 0) {
            controller.update(input(
                current: current, generation: "cursor", revision: 1, pages: [:], focus: focus.binding,
                semantic: semantic, onBrowse: { browsed.append($0) }
            ), rightToLeft: false, todayRevision: today)
        }
        update(center, semantic: center.anchor)
        layout(controller)
        await controller.waitForPendingSnapshots()
        let collection = try collection(controller)
        let nativeLayout = try #require(collection.collectionViewLayout as? CalendarAdjacentViewportLayout)
        let domain = CalendarAdjacentDomain(center: center)
        collection.contentOffset.y = nativeLayout.frame(at: try #require(domain.index(of: target))).minY + 8
        controller.scrollViewDidScroll(collection)
        #expect(browsed.last == target.anchor)
        let echoOffset = collection.contentOffset.y

        update(target, semantic: center.anchor)
        await controller.waitForPendingSnapshots()
        #expect(abs(collection.contentOffset.y - echoOffset) < 1)
        update(center, semantic: center.anchor)
        await controller.waitForPendingSnapshots()
        #expect(abs(collection.contentOffset.y - echoOffset) < 1)
        update(center, semantic: center.anchor, today: 1)
        await controller.waitForPendingSnapshots()
        #expect(abs(collection.contentOffset.y - nativeLayout.frame(at: try #require(domain.index(of: center))).minY) < 1)
    }

    @Test func terminalInsetAlignsLastPeriodAndFocusAboveControls() async throws {
        let focus = FocusHarness()
        let terminal = page(.day, "9999-11-30")
        let controller = makeController(height: 400)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 400)
        controller.update(input(
            current: terminal, generation: "terminal", revision: 1,
            pages: [terminal: data(terminal, ids: ["terminal"])], focus: focus.binding
        ), rightToLeft: false, bottomOcclusion: 120)
        layout(controller)
        await controller.waitForPendingSnapshots()
        let collection = try collection(controller)
        let nativeLayout = try #require(collection.collectionViewLayout as? CalendarAdjacentViewportLayout)
        let domain = CalendarAdjacentDomain(center: terminal)
        let lastFrame = nativeLayout.frame(at: domain.count - 1)
        let maximum = collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom
        #expect(maximum + 1 >= lastFrame.minY)
        #expect(collection.contentInset.bottom >= 120)
        #expect(collection.verticalScrollIndicatorInsets.bottom == 120)

        collection.contentOffset.y = max(0, lastFrame.maxY - collection.bounds.height + 30)
        collection.layoutIfNeeded()
        let cell = try periodCell(terminal, controller: controller)
        let row = try #require(cell.rowIDs.first { $0.isEvent })
        let host = try #require(cell.hostedView(for: row))
        let element = UIAccessibilityElement(accessibilityContainer: host)
        element.accessibilityFrameInContainerSpace = host.bounds
        NotificationCenter.default.post(
            name: UIAccessibility.elementFocusedNotification, object: nil,
            userInfo: [UIAccessibility.focusedElementUserInfoKey: element]
        )
        collection.layoutIfNeeded()
        element.accessibilityFrameInContainerSpace = host.bounds
        NotificationCenter.default.post(
            name: UIAccessibility.elementFocusedNotification, object: nil,
            userInfo: [UIAccessibility.focusedElementUserInfoKey: element]
        )
        let focused = host.convert(element.accessibilityFrameInContainerSpace, to: collection)
        #expect(focused.maxY <= collection.bounds.maxY - 120 + 1)
        #expect(focused.minY >= collection.bounds.minY - 1)
    }

    @Test func weekStartRTLTraitsWidthAndRowSpacingRemainNative() async throws {
        let monday = page(.week, "2028-02-29")
        let sundayLocale = CalendarLocale(
            languageTag: "en-US", timeZoneId: "UTC", weekStart: .sunday, hourCycle: .hour12
        )
        let mondayDays = CalendarCivilDay.days(for: monday, locale: locale)
        let sundayDays = CalendarCivilDay.days(for: monday, locale: sundayLocale)
        #expect(mondayDays.count == 7 && sundayDays.count == 7)
        #expect(mondayDays.first?.date != sundayDays.first?.date)

        let focus = FocusHarness()
        let controller = makeController(width: 390, height: 650)
        controller.update(input(
            current: monday, generation: "geometry", revision: 1,
            pages: [monday: data(monday, ids: ["week"])], focus: focus.binding,
            locale: sundayLocale
        ), rightToLeft: false)
        layout(controller)
        await controller.waitForPendingSnapshots()
        let cell = try periodCell(monday, controller: controller)
        #expect(cell.rowIDs.contains { $0.kind == .weekOverview })
        #expect(cell.rowIDs.filter {
            if case .dayHeading = $0.kind { return true }
            return false
        }.count == 7)
        let ordered = cell.rowIDs.compactMap { id in cell.rowFrame(for: id, in: cell).map { (id, $0) } }
            .sorted { $0.1.minY < $1.1.minY }
        for (left, right) in zip(ordered, ordered.dropFirst()) {
            #expect(abs(right.1.minY - left.1.maxY - Space.sm) < 1)
        }

        let overview = try #require(cell.rowIDs.first { $0.kind == .weekOverview })
        let oldHost = try #require(cell.hostedView(for: overview))
        controller.traitOverrides.preferredContentSizeCategory = .accessibilityExtraLarge
        controller.view.frame.size.width = 520
        controller.update(input(
            current: monday, generation: "geometry", revision: 1,
            pages: [monday: data(monday, ids: ["week"])], focus: focus.binding,
            locale: sundayLocale
        ), rightToLeft: true)
        layout(controller)
        await controller.waitForPendingSnapshots()
        let newHost = try #require(cell.hostedView(for: overview))
        #expect(newHost !== oldHost)
        #expect(controller.traitCollection.preferredContentSizeCategory == .accessibilityExtraLarge)
        #expect(abs(cell.bounds.width - 520) < 1)
        #expect(try #require(cell.rowFrame(for: overview, in: cell)).width >= 519)
    }

    @Test func voiceOverEventProtectionReleasesOnlyOnMatchingFocusReturn() async throws {
        let focus = FocusHarness()
        let center = page(.day, "2028-02-29")
        let controller = makeController(height: 500)
        var requests: [CalendarAdjacentViewportRequest] = []
        controller.update(input(
            current: center, generation: "focus", revision: 1,
            pages: [center: data(center, ids: ["focus-event"])], focus: focus.binding,
            onRequest: { requests.append($0) }
        ), rightToLeft: false)
        layout(controller)
        await controller.waitForPendingSnapshots()
        let cell = try periodCell(center, controller: controller)
        let eventID = try #require(cell.rowIDs.first { $0.isEvent })
        let key = try #require(data(center, ids: ["focus-event"]).projection?.visibleEvents.first?.actionIdentity.stableKey)
        cell.eventAction(for: eventID)?()

        let collection = try collection(controller)
        let nativeLayout = try #require(collection.collectionViewLayout as? CalendarAdjacentViewportLayout)
        let domain = CalendarAdjacentDomain(center: center)
        let away = try #require(domain.index(of: center)) + 100
        collection.contentOffset.y = nativeLayout.frame(at: away).minY
        controller.scrollViewDidScroll(collection)
        await controller.waitForPendingSnapshots()
        #expect(requests.last?.periods.contains(center.anchor) == true)
        controller.accessibilityFocusDidChange(.addControl)
        #expect(requests.last?.periods.contains(center.anchor) == true)
        controller.accessibilityFocusDidChange(.event(key))
        await controller.waitForPendingSnapshots()
        #expect(requests.last?.periods.contains(center.anchor) == false)
    }

    @Test func arrivalsAreOnceOnlyAndReducedMotionSuppressesTransition() async throws {
        #expect(CalendarAdjacentPeriodRow.shouldAnimateArrival(true, reduceMotion: false))
        #expect(!CalendarAdjacentPeriodRow.shouldAnimateArrival(true, reduceMotion: true))
        #expect(!CalendarAdjacentPeriodRow.shouldAnimateArrival(false, reduceMotion: false))

        let focus = FocusHarness()
        let center = page(.day, "2028-02-29")
        let controller = makeController()
        let pageData = data(center, ids: ["arrival"])
        let active = input(
            current: center, generation: "arrival", revision: 1, pages: [center: pageData], focus: focus.binding
        )
        controller.update(active, rightToLeft: false)
        layout(controller)
        await controller.waitForPendingSnapshots()
        let cell = try periodCell(center, controller: controller)
        let id = try #require(cell.rowIDs.first { $0.isEvent })
        let firstHost = try #require(cell.hostedView(for: id))
        controller.update(active, rightToLeft: false)
        layout(controller)
        #expect(cell.hostedView(for: id) === firstHost)

        controller.update(input(
            current: center, generation: "arrival", revision: 2, pages: [center: pageData], focus: focus.binding
        ), rightToLeft: false)
        layout(controller)
        let revisionHost = try #require(cell.hostedView(for: id))
        #expect(revisionHost !== firstHost)
        #expect(revisionHost.alpha == 1 && revisionHost.isUserInteractionEnabled)
    }

    @Test func settledRecenteringRetainsScreenPositionAndBoundedTopology() async throws {
        let focus = FocusHarness()
        let center = page(.day, "2028-02-29")
        let controller = makeController(height: 600)
        controller.update(input(
            current: center, generation: "recenter", revision: 1, pages: [:], focus: focus.binding
        ), rightToLeft: false)
        layout(controller)
        await controller.waitForPendingSnapshots()
        let collection = try collection(controller)
        let nativeLayout = try #require(collection.collectionViewLayout as? CalendarAdjacentViewportLayout)
        let edge = CalendarAdjacentDomain.maximumSlots - 100
        collection.contentOffset.y = nativeLayout.frame(at: edge).minY + 13
        controller.scrollViewDidScroll(collection)
        let browsed = try #require(controller.current)
        let old = CalendarAdjacentDomain(center: center)
        let screenY = nativeLayout.frame(at: try #require(old.index(of: browsed))).minY - collection.contentOffset.y
        controller.scrollViewDidEndDecelerating(collection)
        collection.layoutIfNeeded()
        let replacement = CalendarAdjacentDomain(center: browsed)
        let index = try #require(replacement.index(of: browsed))
        #expect((8_000...12_000).contains(index))
        #expect(abs(nativeLayout.frame(at: index).minY - collection.contentOffset.y - screenY) < 1)
        #expect(collection.numberOfItems(inSection: 0) == CalendarAdjacentDomain.maximumSlots)
    }

    private func input(
        current: CalendarAdjacentPageID,
        generation: String,
        revision: Int,
        pages: [CalendarAdjacentPageID: CalendarAdjacentPageData],
        focus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding,
        locale: CalendarLocale? = nil,
        semantic: CalendarViewportDate? = nil,
        isActive: Bool = true,
        onRequest: @escaping (CalendarAdjacentViewportRequest) -> Void = { _ in },
        onBrowse: @escaping (CalendarViewportDate) -> Void = { _ in },
        onEvent: @escaping (CalendarProjectedEvent) -> Void = { _ in }
    ) -> CalendarAdjacentViewport {
        CalendarAdjacentViewport(
            current: current,
            data: .init(
                isActive: isActive, generation: generation, revision: revision, pages: pages,
                semanticAnchor: semantic ?? current.anchor, selectedDate: current.anchor.date,
                todayDate: current.anchor.date
            ),
            locale: locale ?? self.locale, openerFocus: focus, onRequest: onRequest, onBrowse: onBrowse,
            onEvent: onEvent, onSelectDate: { _, _ in }, onRetry: {}
        )
    }

    private func data(_ period: CalendarAdjacentPageID, ids: [String], long: Bool = false) -> CalendarAdjacentPageData {
        .init(
            projection: projection(period, ids: ids, long: long), loading: .init(phase: .idle),
            freshness: .fresh, offline: .online, error: nil
        )
    }

    private func projection(
        _ period: CalendarAdjacentPageID, ids: [String], long: Bool
    ) -> CalendarExperienceProjection {
        let occurrences = ids.enumerated().map { index, id in
            let hour: Int
            switch id {
            case "insert-1": hour = 6
            case "insert-2": hour = 7
            case "base-1": hour = 8
            case "base-2": hour = 9
            case "anchor": hour = 10
            case "base-4": hour = 11
            case "base-5": hour = 12
            default: hour = 8 + index
            }
            return CalendarProjectionOccurrence(
                eventId: "event-\(id)", occurrenceId: "occurrence-\(id)",
                originalStart: String(format: "%@T%02d:00:00Z", period.anchor.date, hour),
                recurring: false, recurrence: nil, revision: 1, scope: .household,
                title: long ? String(repeating: "Variable event \(id) ", count: index % 3 + 3) : "Event \(id)",
                description: "Details", start: String(format: "%@T%02d:00:00Z", period.anchor.date, hour),
                end: String(format: "%@T%02d:30:00Z", period.anchor.date, hour),
                visibility: .everyone, importance: .normal, group: long ? "Long group" : nil,
                tags: long ? ["Planning", "Dynamic"] : [], persistedTimeZoneId: "UTC"
            )
        }
        return CalendarProjection().project(request: .init(
            occurrences: occurrences, anchorDate: period.anchor.date, view: period.view,
            selectedDate: period.anchor.date, todayDate: period.anchor.date, locale: locale,
            filters: .init(scope: .all, groups: [], tags: [], importance: nil, text: "")
        ))
    }

    private func page(_ view: CalendarView, _ date: String) -> CalendarAdjacentPageID {
        CalendarAdjacentPageID(view: view, anchor: CalendarViewportDate(date: date)!)
    }

    private func makeController(width: CGFloat = 390, height: CGFloat = 700) -> CalendarAdjacentViewController {
        let controller = CalendarAdjacentViewController()
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: width, height: height)
        return controller
    }

    private func layout(_ controller: CalendarAdjacentViewController) {
        controller.view.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        controller.view.layoutIfNeeded()
    }

    private func collection(_ controller: CalendarAdjacentViewController) throws -> UICollectionView {
        try #require(controller.view as? UICollectionView)
    }

    private func periodCell(
        _ period: CalendarAdjacentPageID, controller: CalendarAdjacentViewController
    ) throws -> CalendarAdjacentPeriodCell {
        let collection = try collection(controller)
        collection.layoutIfNeeded()
        return try #require(collection.visibleCells.compactMap { $0 as? CalendarAdjacentPeriodCell }
            .first { $0.period == period })
    }
}

private extension CalendarAdjacentRowID {
    var isEvent: Bool {
        if case .event = kind { return true }
        return false
    }
}

@MainActor
private final class FocusHarness {
    let window: UIWindow
    let binding: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding

    init() {
        var captured: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding?
        let root = UIHostingController(rootView: FocusFixture { captured = $0 })
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
        window.rootViewController = root
        window.isHidden = false
        root.view.layoutIfNeeded()
        guard let captured else { fatalError("focus fixture did not install") }
        self.window = window
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
    func makeUIView(context: Context) -> UIView { receive(focus); return UIView() }
    func updateUIView(_ view: UIView, context: Context) {}
}
