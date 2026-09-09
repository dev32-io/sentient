import Foundation
import MobileData
import SwiftUI
import Testing
import UIKit
@testable import SentientApp

struct CalendarSurfaceTests {
    @Test func eventIdentifierUsesTheCanonicalContentFreeFixtureDigest() {
        let stableKey = "36:236795b5-94d4-42ac-bc72-b2336c348cf661:236795b5-94d4-42ac-bc72-b2336c348cf6:2026-08-22T07:00:00.000Z24:2026-08-22T07:00:00.000Z9:HOUSEHOLD"

        #expect(calendarEventIdentifier(stableKey) == "calendar-event-b8d13ff64fac82fa8024cd2c")
    }

    @Test func approvedStableGeometryRemainsExplicit() {
        #expect(CalendarSurfaceLayout.topBarHeight == 58)
        #expect(CalendarSurfaceLayout.contentInset == 16)
        #expect(CalendarSurfaceLayout.minimumTarget == 44)
        #expect(CalendarSurfaceLayout.tagVisualHeight == 34)
        #expect(CalendarSurfaceLayout.agendaRowHeight == 64)
        #expect(CalendarSurfaceLayout.viewControlHeight == 46)
        #expect(CalendarSurfaceLayout.floatingBarClearance >= CalendarSurfaceLayout.viewControlHeight)
    }

    @MainActor
    @Test func floatingModesAdvertiseEnoughWidthForEveryEqualSegment() {
        for size in [DynamicTypeSize.large, .xxxLarge] {
            // Measure the real widest native option, including its padding and
            // target, rather than estimating a font run in a different engine.
            let widestOption = idealFooterSize(
                DesignSegmentedPicker(
                    title: "Calendar view", options: [(value: CalendarView.month, label: "Month")],
                    selection: .constant(.month), reflowsToFit: true,
                    segmentHorizontalPadding: Space.sm
                ).environment(\.dynamicTypeSize, size)
            )
            let modes = idealFooterSize(
                FloatingViewBar(selected: .month, onSelect: { _ in })
                    .environment(\.dynamicTypeSize, size)
            )
            let required = (widestOption.width - 2 * DesignMetrics.segmentBedPadding) * 4
                + 3 * DesignMetrics.segmentGap + 2 * DesignMetrics.segmentBedPadding
            #expect(modes.width >= required - 0.01)
        }
    }

    @MainActor
    @Test func countTransitionsKeepFooterGeometryStableWhileViewportChangesReflow() {
        for size in [DynamicTypeSize.large, .xxxLarge, .accessibility1, .accessibility5] {
            for direction in [LayoutDirection.leftToRight, .rightToLeft] {
                let mode = idealFooterSize(
                    FloatingViewBar(selected: .month, onSelect: { _ in })
                        .environment(\.dynamicTypeSize, size)
                        .environment(\.layoutDirection, direction)
                )
                func filterSize(_ count: Int) -> CGSize {
                    idealFooterSize(
                        DesignBadgedIconButton(
                            systemName: "line.3.horizontal.decrease", label: "Calendar filters",
                            count: count, action: {}
                        )
                        .environment(\.dynamicTypeSize, size)
                        .environment(\.layoutDirection, direction)
                    )
                }
                func footer(_ count: Int) -> some View {
                    FloatingViewBar(
                        selected: .month, onSelect: { _ in }, onFilters: {}, activeFilterCount: count
                    )
                    .environment(\.dynamicTypeSize, size)
                    .environment(\.layoutDirection, direction)
                }
                let filter = filterSize(0)
                #expect(filter.width >= DesignMetrics.minimumTarget)
                #expect(filter.height >= DesignMetrics.minimumTarget)
                let host = UIHostingController(rootView: footer(0))
                // Fix proposals from count zero; recomputing a fitting width
                // per count would conceal the regression we need to prevent.
                let threshold = mode.width + Space.md + filter.width
                // UIKit quantizes hosted sizes to its pixel grid. Use whole
                // points (aligned at both 2x and 3x) rather than fractional
                // proposals derived from summed/halved intrinsic measurements.
                // Round away from the threshold so each case stays strictly
                // on its intended side; keep containment comparisons exact.
                let inlineWidth = (threshold + 1).rounded(.up)
                let wrappedWidth = (threshold - 1).rounded(.down)
                let narrowWidth = (mode.width / 2).rounded(.down)
                // Match the real 393pt phone's parent inset, not an
                // unconstrained picker or the retired shared container.
                let compactPhoneWidth: CGFloat = 393 - 2 * CalendarSurfaceLayout.floatingHorizontalInset
                let widths = [inlineWidth, wrappedWidth, compactPhoneWidth, 361, 320, 240]
                let initialSizes = widths.map {
                    host.sizeThatFits(in: CGSize(width: $0, height: 2000))
                }
                for count in [0, 1, 2, 5, 12, 99, 100, 0] {
                    host.rootView = footer(count)
                    // Stable sibling footprint plus stable footer dimensions
                    // keeps the mode group's allocation and row unchanged.
                    #expect(filterSize(count) == filter)
                    for (width, initial) in zip(widths, initialSizes) {
                        #expect(host.sizeThatFits(in: CGSize(width: width, height: 2000)) == initial)
                    }
                    let inline = host.sizeThatFits(in: CGSize(width: inlineWidth, height: 2000))
                    let wrapped = host.sizeThatFits(in: CGSize(width: wrappedWidth, height: 2000))
                    #expect(abs(inline.height - max(mode.height, filter.height)) < 0.01)
                    #expect(abs(wrapped.height - (mode.height + Space.sm + filter.height)) < 0.01)
                    #expect(inline.width <= inlineWidth)
                    #expect(wrapped.width <= wrappedWidth)

                    if size == .large {
                        // A stable but mostly empty second row is also a
                        // regression at the reviewed normal-phone baseline.
                        // Require both full intrinsic labels to fit and one
                        // native-target row, including the overlapping badge.
                        #expect(threshold <= compactPhoneWidth)
                        let compact = host.sizeThatFits(in: CGSize(width: compactPhoneWidth, height: 2000))
                        #expect(compact.width <= compactPhoneWidth)
                        #expect(compact.height == max(mode.height, filter.height))
                    }

                    if !size.isAccessibilitySize {
                        // A row narrower than the full picker must reflow the
                        // segments too, not split Month inside a 44pt cell.
                        let narrow = host.sizeThatFits(in: CGSize(width: narrowWidth, height: 2000))
                        #expect(narrow.width <= narrowWidth)
                        #expect(narrow.height >= filter.height + Space.sm
                            + 2 * DesignMetrics.minimumTarget + DesignMetrics.segmentGap)
                    }
                }
            }
        }
    }

    @MainActor
    @Test func floatingControlsLeaveTheNativeViewportAndGapOpenToThePhysicalBottom() async throws {
        let projection = projection(view: .month, anchor: "2028-02-14", filters: CalendarFilters(
            scope: .private, groups: [], tags: [], importance: nil, text: ""
        ))
        let state = screenState(projection: projection, occurrences: [])
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        for direction in [LayoutDirection.leftToRight, .rightToLeft] {
            let host = UIHostingController(rootView: CalendarFloatingScaffoldFixture(state: state)
                .environment(\.layoutDirection, direction)
                .environment(\.dynamicTypeSize, .large))
            let window = UIWindow(windowScene: scene)
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            host.view.layoutIfNeeded()
            // Let the native bounded request/geometry publication finish; no
            // timer or synthetic gesture/layout probe is installed in product.
            await Task.yield()
            host.view.layoutIfNeeded()
            let collection = try #require(descendants(host.view).compactMap { $0 as? UICollectionView }.first)
            let viewport = collection.convert(collection.bounds, to: window)
            #expect(abs(viewport.maxY - window.bounds.maxY) < 1)

            let filter = idealFooterSize(DesignBadgedIconButton(
                systemName: "line.3.horizontal.decrease", label: "Calendar filters", count: 1, action: {}
            ).environment(\.dynamicTypeSize, .large))
            let modes = idealFooterSize(FloatingViewBar(selected: .month, onSelect: { _ in })
                .environment(\.dynamicTypeSize, .large))
            let safeBottom = host.view.convert(host.view.safeAreaLayoutGuide.layoutFrame, to: window).maxY
            let bottom = safeBottom - Space.sm
            let inset = CalendarSurfaceLayout.floatingHorizontalInset
            let width = window.bounds.width
            let gapX = (inset + filter.width + width - inset - modes.width) / 2
            let logicalPoints = [
                CGPoint(x: gapX, y: bottom - DesignMetrics.minimumTarget / 2),
                CGPoint(x: width / 2, y: window.bounds.maxY - 1)
            ]
            for point in logicalPoints {
                let point = CGPoint(x: direction == .rightToLeft ? width - point.x : point.x, y: point.y)
                let hit = try #require(window.hitTest(point, with: nil))
                #expect(hit === collection || hit.isDescendant(of: collection),
                        "Open gap/bottom must reach calendar: direction=\(direction), point=\(point)")
            }
            // Face/corner interception in BOTH directions is covered by native
            // coordinate taps in _calendar/verify-floating-hit-routing.yaml.
            // A nil-event UIKit leaf does not determine SwiftUI gesture consumption.
            #expect(collection.contentInset.bottom >= filter.height + Space.sm + host.view.safeAreaInsets.bottom)
        }
    }

    @MainActor
    @Test func mountedFlowMirrorsOrderAndRowAlignmentOnceWhenWrapping() async throws {
        let widths: [CGFloat] = [70, 90, 110, 60, 65]
        let ids = widths.indices.map { "item-\($0)" }
        for width in [CGFloat(360), 200] {
            let rows = width == 360 ? [[0, 1, 2, 3], [4]] : [[0, 1], [2, 3], [4]]
            for alignment in [HorizontalAlignment.leading, .center, .trailing] {
                let content = CenteredFlowLayout(spacing: 8, alignment: alignment) {
                    ForEach(widths.indices, id: \.self) { index in
                        Button("Item \(index)") {}
                            .buttonStyle(.plain)
                            .frame(width: widths[index], height: 44)
                            .background(CalendarLayoutProbe(id: ids[index]))
                    }
                }
                .background(CalendarLayoutProbe(id: "bounds"))
                .frame(width: width)
                let ltr = try await mountedLayoutFrames(content, ids: ids, direction: .leftToRight).frames
                let rtl = try await mountedLayoutFrames(content, ids: ids, direction: .rightToLeft).frames
                try expectHorizontalMirror(ltr: ltr, rtl: rtl, ids: ids)
                for (direction, frames) in [(LayoutDirection.leftToRight, ltr), (.rightToLeft, rtl)] {
                    let bounds = try #require(frames["bounds"])
                    #expect(abs(bounds.width - width) < 1)
                    var previousBottom = bounds.minY - 8
                    for row in rows {
                        let cells = try row.map { try #require(frames[ids[$0]]) }
                        let rowBounds = cells.reduce(CGRect.null) { $0.union($1) }
                        #expect(abs(rowBounds.minY - previousBottom - 8) < 1)
                        #expect(abs(rowBounds.height - 44) < 1)
                        previousBottom = rowBounds.maxY
                        if alignment == .center {
                            #expect(abs(rowBounds.midX - bounds.midX) < 1)
                        } else if (alignment == .leading) == (direction == .leftToRight) {
                            #expect(abs(rowBounds.minX - bounds.minX) < 1)
                        } else {
                            #expect(abs(rowBounds.maxX - bounds.maxX) < 1)
                        }
                        for (index, cell) in zip(row, cells) {
                            #expect(abs(cell.width - widths[index]) < 1)
                            #expect(cell.minX >= bounds.minX - 0.5 && cell.maxX <= bounds.maxX + 0.5)
                        }
                        for (first, next) in zip(cells, cells.dropFirst()) {
                            let gap = direction == .leftToRight ? next.minX - first.maxX : first.minX - next.maxX
                            #expect(abs(gap - 8) < 1)
                        }
                    }
                    #expect(abs(previousBottom - bounds.maxY) < 1)
                }
            }
        }
    }

    @MainActor
    @Test func mountedFittingSegmentsMirrorCalendarModeOrderInSingleAndWrappedRows() async throws {
        let labels = ["Day", "Week", "Month", "Year"]
        for width in [CGFloat(300), 150] {
            // The real mode layout, with flexible native Button labels. A 60pt
            // intrinsic minimum deterministically exercises four then two columns.
            let content = DesignFittingSegmentsLayout {
                ForEach(labels, id: \.self) { label in
                    Button {} label: {
                        Text(label)
                            .font(.system(size: 15))
                            .frame(minWidth: 60, maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .background(CalendarLayoutProbe(id: label))
                }
            }
            .background(CalendarLayoutProbe(id: "bounds"))
            .frame(width: width)
            let ltr = try await mountedLayoutFrames(content, ids: labels, direction: .leftToRight).frames
            let rtl = try await mountedLayoutFrames(content, ids: labels, direction: .rightToLeft).frames
            try expectHorizontalMirror(ltr: ltr, rtl: rtl, ids: labels)
            let columns = width == 300 ? 4 : 2
            let gap = DesignMetrics.segmentGap
            for (direction, frames) in [(LayoutDirection.leftToRight, ltr), (.rightToLeft, rtl)] {
                let bounds = try #require(frames["bounds"])
                #expect(abs(bounds.width - width) < 1)
                let cellWidth = (width - CGFloat(columns - 1) * gap) / CGFloat(columns)
                for index in labels.indices {
                    let cell = try #require(frames[labels[index]])
                    #expect(abs(cell.width - cellWidth) < 1)
                    #expect(abs(cell.height - 44) < 1)
                    #expect(abs(cell.minY - bounds.minY - CGFloat(index / columns) * (44 + gap)) < 1)
                    if index % columns == 0 {
                        let leading = direction == .leftToRight ? cell.minX - bounds.minX : bounds.maxX - cell.maxX
                        #expect(abs(leading) < 1)
                    } else {
                        let previous = try #require(frames[labels[index - 1]])
                        let separation = direction == .leftToRight ? cell.minX - previous.maxX : previous.minX - cell.maxX
                        #expect(abs(separation - gap) < 1)
                    }
                    if index % columns == columns - 1 {
                        let trailing = direction == .leftToRight ? bounds.maxX - cell.maxX : cell.minX - bounds.minX
                        #expect(abs(trailing) < 1)
                    }
                }
                let last = try #require(frames["Year"])
                #expect(abs(last.maxY - bounds.maxY) < 1)
            }
        }
    }

    @MainActor
    @Test func mountedPeriodHeaderMirrorsTitleAndNativeNavigationInBothTextBranches() async throws {
        let ids = ["title", "navigation", "previous", "today", "next"]
        for size in [DynamicTypeSize.large, .accessibility3] {
            let content = CalendarPeriodRow(accessibilitySize: size.isAccessibilitySize) {
                Text("February 2028")
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .background(CalendarLayoutProbe(id: "title"))
                HStack(spacing: 0) {
                    DesignIconButton(systemName: "chevron.backward", label: "Previous period", action: {})
                        .background(CalendarLayoutProbe(id: "previous"))
                    DesignActionButton(title: "Today", role: .quiet, fillsWidth: false, action: {})
                        .background(CalendarLayoutProbe(id: "today"))
                    DesignIconButton(systemName: "chevron.forward", label: "Next period", action: {})
                        .background(CalendarLayoutProbe(id: "next"))
                }
                .background(CalendarLayoutProbe(id: "navigation"))
            }
            .background(CalendarLayoutProbe(id: "bounds"))
            .frame(width: 320)
            let ltr = try await mountedLayoutFrames(content, ids: ids, direction: .leftToRight, size: size)
            let rtl = try await mountedLayoutFrames(content, ids: ids, direction: .rightToLeft, size: size)
            try expectHorizontalMirror(ltr: ltr.frames, rtl: rtl.frames, ids: ids)
            for (direction, frames, localSizes) in [
                (LayoutDirection.leftToRight, ltr.frames, ltr.nativeLocalSizes),
                (.rightToLeft, rtl.frames, rtl.nativeLocalSizes)
            ] {
                let bounds = try #require(frames["bounds"])
                let title = try #require(frames["title"])
                let navigation = try #require(frames["navigation"])
                #expect(abs(bounds.width - 320) < 1)
                let leading = direction == .leftToRight ? title.minX - bounds.minX : bounds.maxX - title.maxX
                #expect(abs(leading) < 1)
                if size.isAccessibilitySize {
                    #expect(abs(title.minY - bounds.minY) < 1)
                    #expect(abs(navigation.midX - bounds.midX) < 1)
                    #expect(abs(navigation.minY - title.maxY - Space.xs) < 1)
                    #expect(abs(navigation.maxY - bounds.maxY) < 1)
                } else {
                    #expect(abs(title.midY - bounds.midY) < 1)
                    #expect(abs(navigation.midY - bounds.midY) < 1)
                    let trailing = direction == .leftToRight ? bounds.maxX - navigation.maxX : navigation.minX - bounds.minX
                    let separation = direction == .leftToRight ? navigation.minX - title.maxX : title.minX - navigation.maxX
                    #expect(abs(trailing) < 1)
                    #expect(separation >= Space.xs - 0.5)
                }
                let previous = try #require(frames["previous"])
                let today = try #require(frames["today"])
                let next = try #require(frames["next"])
                // Conversion can lose an ULP; the exact native target is the
                // local bounds size. Placement checks keep the converted frames.
                let targets = try ["previous", "today", "next"].map { try #require(localSizes[$0]) }
                #expect(targets.allSatisfy { $0.width >= 44 && $0.height >= 44 })
                if direction == .leftToRight {
                    #expect(previous.maxX <= today.minX + 0.5 && today.maxX <= next.minX + 0.5)
                } else {
                    #expect(next.maxX <= today.minX + 0.5 && today.maxX <= previous.minX + 0.5)
                }
            }
        }
    }

    /// Read final UIKit coordinates from inert backgrounds on mounted SwiftUI
    /// consumers, not the Layout's pre-mirror arithmetic or a fitting-size proxy.
    @MainActor
    private func mountedLayoutFrames(
        _ content: some View, ids: [String], direction: LayoutDirection, size: DynamicTypeSize = .large
    ) async throws -> (frames: [String: CGRect], nativeLocalSizes: [String: CGSize]) {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let host = UIHostingController(rootView: content
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.layoutDirection, direction)
            .environment(\.dynamicTypeSize, size)
            .transaction { transaction in
                transaction.animation = nil
                transaction.disablesAnimations = true
            })
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        await Task.yield()
        host.view.layoutIfNeeded()
        var result: [String: CGRect] = [:]
        var nativeLocalSizes: [String: CGSize] = [:]
        let views = descendants(host.view).compactMap { $0 as? CalendarLayoutProbeView }
        for id in ids + ["bounds"] {
            let matches = views.filter { $0.probeID == id }
            try #require(matches.count == 1)
            let probe = try #require(matches.first)
            try #require(probe.window === window)
            let localBounds = probe.bounds
            let frame = probe.convert(localBounds, to: host.view)
            try #require(frame.width > 0 && frame.height > 0)
            result[id] = frame
            nativeLocalSizes[id] = localBounds.size
        }
        return (frames: result, nativeLocalSizes: nativeLocalSizes)
    }

    private func expectHorizontalMirror(ltr: [String: CGRect], rtl: [String: CGRect], ids: [String]) throws {
        let leftBounds = try #require(ltr["bounds"])
        let rightBounds = try #require(rtl["bounds"])
        #expect(abs(leftBounds.width - rightBounds.width) < 1)
        #expect(abs(leftBounds.height - rightBounds.height) < 1)
        for id in ids {
            let left = try #require(ltr[id])
            let right = try #require(rtl[id])
            #expect(abs(left.width - right.width) < 1)
            #expect(abs(left.height - right.height) < 1)
            #expect(abs((right.minY - rightBounds.minY) - (left.minY - leftBounds.minY)) < 1)
            #expect(abs((right.minX - rightBounds.minX) - (leftBounds.maxX - left.maxX)) < 1)
        }
    }

    @MainActor
    private func descendants(_ view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap { descendants($0) }
    }

    @MainActor
    private func idealFooterSize(_ view: some View) -> CGSize {
        UIHostingController(rootView: view.fixedSize())
            .sizeThatFits(in: CGSize(width: 2000, height: 2000))
    }

    @Test func dayIsFocusedAgendaWithoutASeparateCompactCanvas() {
        #expect(!CalendarSurfaceMapping.showsCompactCanvas(.day))
        #expect(CalendarSurfaceMapping.showsCompactCanvas(.week))
        #expect(CalendarSurfaceMapping.showsCompactCanvas(.month))
        #expect(CalendarSurfaceMapping.showsCompactCanvas(.year))
    }

    @Test func sharedProjectionSuppliesCompleteMonthWeekAndLeapYearDates() {
        let month = projection(view: .month, anchor: "2028-02-14").month
        #expect(month?.cells.count == 42)
        #expect(month?.weekdayLabels.count == 7)
        #expect(month?.cells.first?.date == month?.gridStartDate)
        #expect(month?.cells.last?.date == month?.gridEndDate)

        let week = projection(view: .week, anchor: "2028-02-14").week
        #expect(week?.days.count == 7)
        #expect(Set(week?.days.map(\.date) ?? []).count == 7)

        let year = projection(view: .year, anchor: "2028-02-14").year
        #expect(year?.months.count == 12)
        #expect(year?.months.flatMap(\.days).count == 366)
        #expect(year?.months[1].days.count == 29)
        #expect(year?.months.first?.days.first?.date == "2028-01-01")
        #expect(year?.months.last?.days.last?.date == "2028-12-31")
    }

    @Test func monthAgendaUsesTheSharedFourDaySlice() throws {
        let shared = projection(view: .month, anchor: "2028-02-14")
        let state = screenState(projection: shared, occurrences: [screenOccurrence(originalStart: "2028-02-14T15:20:00Z")])
        let agenda = CalendarSurfaceMapping.agenda(for: state)

        #expect(agenda.map(\.date) == shared.month?.agenda.map(\.date))
        #expect(agenda.count == 1)
        #expect(agenda.first?.events.first?.eventId == "event")
    }

    @Test func filterResetAndImportanceTogglePreserveTheSharedSelectionContract() {
        let original = CalendarFilters(
            scope: .private, groups: ["School"], tags: ["pickup"], importance: .pinned, text: "trip"
        )
        let toggled = CalendarFilterMapping.togglingImportance(.pinned, in: original)
        #expect(toggled.importance == nil)
        #expect(toggled.scope == original.scope)
        #expect(toggled.groups == original.groups)
        #expect(toggled.tags == original.tags)
        #expect(toggled.text == original.text)
        #expect(CalendarFilterMapping.togglingImportance(.important, in: toggled).importance == .important)

        let reset = CalendarFilterMapping.resetting(original)
        #expect(reset.scope == .all)
        #expect(reset.groups.isEmpty && reset.tags.isEmpty)
        #expect(reset.importance == nil && reset.text.isEmpty)
        #expect(CalendarFilterMapping.activeCount(in: reset) == 0)
        #expect(CalendarFilterMapping.activeCount(in: original) == 5)
    }

    @Test func deviceProjectionContextIncludesLocaleWeekStartAndTimeZone() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        let zone = try #require(TimeZone(identifier: "Pacific/Auckland"))

        let context = CalendarDeviceProjectionContext.current(
            locale: Locale(identifier: "en_GB"),
            calendar: calendar,
            timeZone: zone
        )

        #expect(context.languageTag == "en-GB")
        #expect(context.weekStart == .monday)
        #expect(context.timeZoneId == "Pacific/Auckland")
    }

    @Test func freshnessRecoveryAnnouncementOnlyFiresOnATransitionToFresh() {
        #expect(CalendarSurfaceText.freshnessRecoveryAnnouncement(from: .refreshing, to: .fresh) == "Calendar is up to date")
        #expect(CalendarSurfaceText.freshnessRecoveryAnnouncement(from: .fresh, to: .fresh) == nil)
        #expect(CalendarSurfaceText.freshnessRecoveryAnnouncement(from: .stale, to: .refreshing) == nil)
    }

    @Test func freshnessIdentifiersExposeBehavioralStates() {
        let projection = projection(view: .month, anchor: "2028-02-14")
        let occurrence = screenOccurrence(originalStart: "2028-02-14T15:20:00Z")
        #expect(CalendarSurfaceMapping.freshnessIdentifier(for: screenState(projection: projection, occurrences: [occurrence])) == "calendar-freshness-up-to-date")
        #expect(CalendarSurfaceMapping.freshnessIdentifier(for: screenState(projection: projection, occurrences: [occurrence], freshness: .refreshing, loading: CalendarLoadingState(phase: .refreshing))) == "calendar-freshness-refreshing")
        #expect(CalendarSurfaceMapping.freshnessIdentifier(for: screenState(projection: projection, occurrences: [occurrence], freshness: .cachedOffline, offline: .offline)) == "calendar-freshness-offline")
    }

    @Test func accessibilityCellLabelIncludesFullSemanticStateAndOverflow() {
        let cell = CalendarDateCell(
            date: "2026-04-18", dayOfMonth: 18, events: [], indicators: [],
            overflow: CalendarOverflow(count: 2, label: "2 more events", accessibilityLabel: "2 additional events"),
            isSelected: true, isToday: true, isOutsideMonth: true,
            accessibilityLabel: "Saturday, April 18, 2026"
        )

        let label = CalendarSurfaceText.dateCellLabel(cell)
        #expect(label.contains("Saturday, April 18, 2026"))
        #expect(label.contains("Today"))
        #expect(label.contains("Selected"))
        #expect(label.contains("Outside month"))
        #expect(label.contains("2 additional events"))
    }

    @Test func nativeScopeTargetsMapBothToSharedAllAndKeepTheLastSelection() {
        let all = CalendarFilters(scope: .all, groups: [], tags: [], importance: nil, text: "")
        #expect(CalendarFilterMapping.visibleScopes == [.private, .household])
        #expect(CalendarFilterMapping.isScopeSelected(.private, in: all))
        #expect(CalendarFilterMapping.isScopeSelected(.household, in: all))

        let privateOnly = CalendarFilterMapping.togglingScope(.household, in: all)
        #expect(privateOnly.scope == .private)
        #expect(CalendarFilterMapping.togglingScope(.private, in: privateOnly).scope == .private)
        #expect(CalendarFilterMapping.togglingScope(.household, in: privateOnly).scope == .all)
    }

    @Test func selectedAbsentFiltersRemainVisibleAndRemovableWithoutChangingOtherFacets() {
        let filters = CalendarFilters(
            scope: .private, groups: Set(["Absent group"]), tags: Set(["absent-tag"]),
            importance: .pinned, text: "pickup"
        )
        let facets = CalendarFacetOptions(
            scopes: [.all, .household], groups: ["Family"], tags: ["school"], importances: [.normal]
        )

        #expect(CalendarFilterMapping.groups(filters: filters, facets: facets) == ["Absent group", "Family"])
        #expect(CalendarFilterMapping.tags(filters: filters, facets: facets) == ["absent-tag", "school"])
        #expect(CalendarFilterMapping.importances(filters: filters, facets: facets) == [.normal, .pinned])

        let changed = CalendarFilterMapping.replacing(
            filters,
            tags: CalendarFilterMapping.toggling("absent-tag", in: filters.tags)
        )
        #expect(changed.tags.isEmpty)
        #expect(changed.scope == .private)
        #expect(changed.groups == Set(["Absent group"]))
        #expect(changed.importance == .pinned)
        #expect(changed.text == "pickup")

        let clearedImportance = CalendarFilterMapping.replacing(filters, importance: .some(nil))
        #expect(clearedImportance.importance == nil)
        #expect(clearedImportance.tags == Set(["absent-tag"]))
    }

    @Test func controlledActionClosuresPreserveSelectionValues() {
        var dates: [String] = []
        var months: [(Int32, Int32)] = []
        var views: [CalendarView] = []
        let actions = CalendarSurfaceActions(
            onBack: {}, onAdd: {}, onToday: {}, onPrevious: {}, onNext: {},
            onSelectDate: { dates.append($0) },
            onSelectMonth: { months.append(($0, $1)) },
            onSelectView: { views.append($0) },
            onFiltersChanged: { _ in }, onSearch: { _ in }, onEvent: { _ in }, onRetry: {}
        )

        actions.onSelectDate("2026-04-18")
        actions.onSelectMonth(2027, 9)
        actions.onSelectView(.week)

        #expect(dates == ["2026-04-18"])
        #expect(months.count == 1)
        #expect(months[0].0 == 2027 && months[0].1 == 9)
        #expect(views == [.week])
    }

    @Test func formattingUsesFullDatesAndSharedDisplayTimes() {
        let locale = CalendarLocale(languageTag: "en-US", timeZoneId: "UTC", weekStart: .sunday, hourCycle: .hour12)
        #expect(CalendarSurfaceText.fullDate("2026-04-18", locale: locale) == "Saturday, April 18, 2026")
        let event = projection(view: .day, anchor: "2028-02-14").day?.events.first
        #expect(event.map(CalendarSurfaceText.eventTime) == "3:20 PM")
    }

    @Test func screenMapsProjectedActionToExactAuthorizedOccurrenceIdentity() throws {
        let projection = projection(view: .day, anchor: "2028-02-14")
        let event = try #require(projection.day?.events.first)
        let wrong = screenOccurrence(originalStart: "2028-02-14T14:20:00Z")
        let exact = screenOccurrence(originalStart: "2028-02-14T15:20:00Z")
        let state = screenState(projection: projection, occurrences: [wrong, exact])

        #expect(CalendarScreenMapping.occurrence(for: event, in: state) === exact)
    }

    @Test func screenNavigationAlwaysDismissesTopMutationStateFirst() {
        let projection = projection(view: .day, anchor: "2028-02-14")
        let occurrence = screenOccurrence(originalStart: "2028-02-14T15:20:00Z")
        let closed = screenState(projection: projection, occurrences: [occurrence])
        #expect(CalendarScreenMapping.navigationDisposition(for: closed) == .perform)

        let openMutation = CalendarMutationState(
            phase: .previewing, preview: occurrence, editor: nil, deleteConfirmation: nil,
            pendingRequest: nil, error: nil, conflict: nil, outcome: nil,
            successorEventId: nil, affectedWindows: []
        )
        let open = screenState(projection: projection, occurrences: [occurrence], mutation: openMutation)
        #expect(CalendarScreenMapping.navigationDisposition(for: open) == .dismissOverlayFirst)
    }

    private func projection(view: CalendarView, anchor: String, filters: CalendarFilters? = nil) -> CalendarExperienceProjection {
        let locale = CalendarLocale(languageTag: "en-US", timeZoneId: "UTC", weekStart: .sunday, hourCycle: .hour12)
        let occurrence = CalendarProjectionOccurrence(
            eventId: "event", occurrenceId: "occurrence", originalStart: "2028-02-14T15:20:00Z",
            recurring: false, recurrence: nil, revision: 1, scope: .household,
            title: "School pickup", description: nil,
            start: "2028-02-14T15:20:00Z", end: "2028-02-14T16:00:00Z",
            visibility: .everyone, importance: .important, group: "Family", tags: ["school"],
            persistedTimeZoneId: "UTC"
        )
        return CalendarProjection().project(request: CalendarProjectionRequest(
            occurrences: [occurrence], anchorDate: anchor, view: view,
            selectedDate: anchor, todayDate: anchor, locale: locale,
            filters: filters ?? CalendarFilters(scope: .all, groups: [], tags: [], importance: nil, text: "")
        ))
    }

    private func screenOccurrence(originalStart: String) -> EffectiveOccurrence {
        EffectiveOccurrence(
            eventId: "event", occurrenceId: "occurrence", originalStart: originalStart,
            recurring: false, revision: 1, scope: .household, title: "School pickup",
            description: nil, start: "2028-02-14T15:20:00Z", end: "2028-02-14T16:00:00Z",
            visibility: .everyone, importance: .important, group: "Family", tags: ["school"], recurrence: nil
        )
    }

    private func screenState(
        projection: CalendarExperienceProjection,
        occurrences: [EffectiveOccurrence],
        mutation: CalendarMutationState = CalendarMutationState(
            phase: .idle, preview: nil, editor: nil, deleteConfirmation: nil,
            pendingRequest: nil, error: nil, conflict: nil, outcome: nil,
            successorEventId: nil, affectedWindows: []
        ),
        freshness: CalendarCacheFreshness = .fresh,
        loading: CalendarLoadingState = CalendarLoadingState(phase: .idle),
        offline: CalendarOfflineState = .online
    ) -> CalendarUiState {
        CalendarUiState(CalendarExperienceState(
            anchorDate: projection.anchorDate, view: projection.view,
            selectedDate: projection.selectedDate, filters: projection.filters,
            locale: projection.locale, todayDate: projection.todayDate,
            visibleInterval: projection.interval, selectedInterval: nil,
            authorizedOccurrences: occurrences, projection: projection, facets: projection.facets,
            freshness: freshness, loading: loading, offline: offline,
            error: nil, hasCompleteCache: true, cachedWindow: nil, persistedCachePreferences: nil,
            presentationReady: true,
            recovery: CalendarRecoveryState(phase: .idle, generation: 0, failureKind: nil),
            mutationAvailability: CalendarMutationAvailability(
                canCreate: true, canEdit: true, canDelete: true, reason: nil
            ),
            mutation: mutation
        ))
    }
}

private struct CalendarFloatingScaffoldFixture: View {
    let state: CalendarUiState
    @AccessibilityFocusState private var focus: CalendarOverlayOrigin?

    var body: some View {
        CalendarScaffold(
            state: state,
            actions: CalendarSurfaceActions(
                onBack: {}, onAdd: {}, onToday: {}, onPrevious: {}, onNext: {},
                onSelectDate: { _ in }, onSelectMonth: { _, _ in }, onSelectView: { _ in },
                onFiltersChanged: { _ in }, onSearch: { _ in }, onEvent: { _ in }, onRetry: {}
            ),
            openerFocus: $focus,
            viewportData: .init(generation: "floating", revision: 1, months: [:], isActive: true)
        )
    }
}

/// An inert background accepts its consumer's resolved size. UIKit conversion
/// includes SwiftUI's actual parent mirroring; no layout callbacks or state writes.
private struct CalendarLayoutProbe: UIViewRepresentable {
    let id: String

    func makeUIView(context: Context) -> CalendarLayoutProbeView {
        let view = CalendarLayoutProbeView()
        view.probeID = id
        view.accessibilityElementsHidden = true
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: CalendarLayoutProbeView, context: Context) {}

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: CalendarLayoutProbeView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 0, height: proposal.height ?? 0)
    }
}

private final class CalendarLayoutProbeView: UIView {
    var probeID = ""
}
