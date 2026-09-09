import MobileData
import SwiftUI
import UIKit

struct CalendarNativeViewportInput {
    let state: CalendarUiState
    let data: CalendarViewportData?
    let browsedMonth: CalendarViewportMonth?
    let rightToLeft: Bool
    let increasedContrast: Bool
    let accessibilitySize: Bool
    let reduceMotion: Bool
    let dateSize: CGFloat
    let rowHeight: CGFloat
    let dateWidth: CGFloat
    let onSelectDate: (String) -> Void
    let onSelectMonth: (Int32, Int32) -> Void
    let onRequest: (CalendarViewportRequest) -> Void
    let onBrowse: (CalendarViewportMonth) -> Void
    var bottomOcclusion: CGFloat = 0

    // Foreground projection is only a legacy-preview authority fallback when
    // no viewport data was supplied. An empty active map is still active.
    var isActive: Bool { data?.isActive ?? (state.projection != nil) }
}

struct CalendarNativeViewport: UIViewControllerRepresentable {
    let input: CalendarNativeViewportInput
    let progress: CGFloat
    @Environment(\.calendarTodayRevision) private var todayRevision
    func makeUIViewController(context: Context) -> CalendarViewportController { CalendarViewportController() }
    func updateUIViewController(_ controller: CalendarViewportController, context: Context) {
        UIView.performWithoutAnimation { controller.update(input, progress: progress, todayRevision: todayRevision) }
    }
    static func dismantleUIViewController(_ controller: CalendarViewportController, coordinator: ()) {
        controller.dispose()
    }
}

final class CalendarViewportController: UIViewController, UICollectionViewDataSource, UICollectionViewDelegate {
    private let layout = CalendarNativeViewportLayout()
    private lazy var collection = CalendarMonthCollectionView(frame: .zero, collectionViewLayout: layout)
    private var focusVisibility: CalendarViewportFocusVisibility?
    private var weekdayHeader: (UIView & UIContentView)?
    private var contentVersion = 0
    private var input: CalendarNativeViewportInput?
    private var civil: [CalendarViewportMonth: CalendarCivilMonth] = [:]
    private var civilKey = ""
    private var inputLocaleKey = ""
    private(set) var preparedMonths: Set<CalendarViewportMonth> = []
    private var requestContinuation: AsyncStream<CalendarViewportRequestMailbox.Delivery>.Continuation?
    private var requestTask: Task<Void, Never>?
    private var latest: [CalendarViewportMonth: CalendarViewportMonthData] = [:]
    private var lastProjection: CalendarExperienceProjection?
    private var lastDataRevision: Int?
    private var generation: String?
    // One synchronous owner for both endpoints. Progress samples never choose
    // a focal month or replace endpoints, so reversal cannot commit an older
    // trip's leading row. There are no animation completion writes to fence.
    private struct MorphEndpoints {
        let focal: CalendarViewportMonth
        var year: CGFloat
        var month: CGFloat
    }
    private var morph: MorphEndpoints?
    private var anchor: CalendarViewportMonth? { morph?.focal }
    private var lastSemanticAnchor: String?
    private var lastTodayRevision: Int?
    private var lastMode: CalendarView?
    private var updating = false
    private var userBrowsing = false
    private var mounted = false
    private var requests = CalendarViewportRequestMailbox()
    private var requestBounds: CGRect?
    private var requestProgress: CGFloat?
    private var reported: CalendarViewportMonth?
    private let cells = NSHashTable<CalendarReusableMonthCell>.weakObjects()
    private let displayedCells = NSMapTable<CalendarReusableMonthCell, NSNumber>(
        keyOptions: .weakMemory, valueOptions: .strongMemory
    )

    override func loadView() {
        view = UIView()
        view.backgroundColor = UIColor(DuskColors.bgSunk)
        view.clipsToBounds = true
        view.addSubview(collection)
        collection.backgroundColor = UIColor(DuskColors.bgSunk)
        collection.dataSource = self
        collection.delegate = self
        collection.onAccessibilityScroll = { [weak self] beginning in
            self?.userBrowsing = beginning
        }
        collection.isPrefetchingEnabled = false // Explicit bounded period requests below.
        collection.alwaysBounceVertical = true
        collection.showsVerticalScrollIndicator = false
        collection.showsHorizontalScrollIndicator = false
        collection.keyboardDismissMode = .interactive
        collection.contentInsetAdjustmentBehavior = .never
        focusVisibility = CalendarViewportFocusVisibility(scrollView: collection)
        collection.register(CalendarReusableMonthCell.self, forCellWithReuseIdentifier: "month")
        collection.accessibilityIdentifier = "calendar-native-viewport"
        let (stream, continuation) = AsyncStream<CalendarViewportRequestMailbox.Delivery>.makeStream(bufferingPolicy: .bufferingNewest(1))
        requestContinuation = continuation
        requestTask = Task { @MainActor [weak self] in
            for await delivery in stream {
                guard !Task.isCancelled, let self, let input = self.input else { return }
                guard self.requests.consume(delivery) else { continue }
                let request = delivery.request
                if !request.months.isEmpty {
                    guard input.isActive, self.isRequestedEndpoint else { continue }
                    self.prepareCivil(for: self.civilPreparationRequest(request), locale: input.state.locale)
                    self.refreshVisible()
                }
                // Only civil identities are retained for deduplication. An
                // authority/context/disappearance edge resets this set. Ordering
                // changes inside the same bounded envelope need no shared projection.
                guard self.requests.shouldPublish(request) else { continue }
                input.onRequest(request)
            }
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        queueViewportRequest()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Scaffold releases reads on disappearance. A retained native owner
        // must request its real envelope again if navigation is interrupted.
        userBrowsing = false
        invalidateRequests(resetDelivered: true)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let wasUpdating = updating
        updating = true
        defer { updating = wasUpdating }
        placeViewport()
        guard collection.bounds.height > 0, let input else { return }
        if !mounted {
            mounted = true
            // Resume is separate from a later explicit navigation command.
            positionInitially(input.browsedMonth ?? CalendarViewportMonth(date: input.state.anchorDate))
            refreshVisible()
        }
        queueViewportRequest()
    }

    func update(_ next: CalendarNativeViewportInput, progress: CGFloat, todayRevision: Int = 0) {
        loadViewIfNeeded()
        updating = true
        defer { updating = false }
        let previousProgress = layout.progress
        let progress = next.reduceMotion || !next.isActive ? (next.state.view == .year ? CGFloat(0) : CGFloat(1)) : progress
        let nextAnchor = CalendarViewportMonth.clampedToNativeDomain(
            CalendarViewportMonth(date: next.state.anchorDate)
        )
        let semanticChanged = lastSemanticAnchor != next.state.anchorDate
        let explicitToday = lastTodayRevision != nil && lastTodayRevision != todayRevision && next.isActive
        lastTodayRevision = todayRevision // Consume even when inactive; never replay across authority clear.
        let modeChanged = lastMode != next.state.view
        let invalidated = generation != next.data?.generation
        let authorizationChanged = (input?.isActive == true) != next.isActive
        input = next // Callbacks and authorization always replaced before drawing.
        focusVisibility?.bottomOcclusion = next.bottomOcclusion
        if collection.contentInset.bottom != next.bottomOcclusion {
            collection.contentInset.bottom = next.bottomOcclusion
            collection.verticalScrollIndicatorInsets.bottom = next.bottomOcclusion
        }
        view.semanticContentAttribute = next.rightToLeft ? .forceRightToLeft : .forceLeftToRight

        let nextLocaleKey = geometryKey(next.state.locale)
        let localeChanged = inputLocaleKey != nextLocaleKey
        if !next.isActive || invalidated || localeChanged {
            clearContent()
        }
        if invalidated || authorizationChanged || localeChanged {
            invalidateRequests(resetDelivered: true)
        } else if modeChanged || semanticChanged || explicitToday {
            invalidateRequests(resetDelivered: false)
        }
        inputLocaleKey = nextLocaleKey
        generation = next.data?.generation
        if next.isActive {
            let contentChanged = next.data != nil ? lastDataRevision != next.data?.revision :
                lastProjection !== next.state.projection || lastDataRevision != nil
            if contentChanged || invalidated || authorizationChanged {
                latest = next.data?.months ?? foregroundPeriods(next.state)
                contentVersion += 1
                lastProjection = next.data == nil ? next.state.projection : nil
                lastDataRevision = next.data?.revision
            }
        }
        let firstWeekday = CalendarCivilMonth.firstWeekday(next.state.locale)
        let geometryChanged = layout.firstWeekday != firstWeekday || layout.rowHeight != next.rowHeight || layout.dateSize != next.dateSize ||
            layout.dateWidth != next.dateWidth || layout.accessibilitySize != next.accessibilitySize ||
            layout.rightToLeft != next.rightToLeft
        let geometryCursor = anchor.map(CalendarViewportMonth.clampedToNativeDomain) ?? nextAnchor
        let previousRelativeY: CGFloat
        if geometryChanged, mounted {
            let previousFrame = layout.frame(geometryCursor.index, progress: previousProgress)
            previousRelativeY = (collection.contentOffset.y - previousFrame.minY) / max(1, previousFrame.height)
        } else { previousRelativeY = 0 }
        layout.firstWeekday = firstWeekday
        layout.rowHeight = next.rowHeight
        layout.dateSize = next.dateSize
        layout.dateWidth = next.dateWidth
        layout.accessibilitySize = next.accessibilitySize
        layout.rightToLeft = next.rightToLeft

        // An observation echo preserves the native offset. An explicit Today
        // press resets it even when the semantic date/month is already Today.
        let explicitNavigation = explicitToday || (semanticChanged && nextAnchor != reported)
        if modeChanged || explicitNavigation || !next.isActive {
            // Stop an old endpoint's drag/deceleration at the command boundary.
            // A later UIKit layout callback is positioning, not user browsing.
            userBrowsing = false
            collection.isScrollEnabled = false
        }
        if mounted, modeChanged, !explicitNavigation {
            let focal = CalendarViewportMonth.clampedToNativeDomain(next.browsedMonth ?? anchor ?? nextAnchor)
            if morph?.focal != focal {
                morph = endpoints(for: focal)
            } else {
                // Capture a browsed endpoint only at a command boundary. A
                // settled Year trip does NOT discard the paired Month offset.
                if previousProgress == 0 { morph?.year = collection.contentOffset.y }
                if previousProgress == 1 { morph?.month = collection.contentOffset.y }
            }
        }
        layout.progress = min(1, max(0, progress))
        placeViewport(preserveCursor: !explicitNavigation)
        if mounted, explicitNavigation {
            morph = endpoints(for: nextAnchor)
            reported = nextAnchor
        } else if geometryChanged, mounted {
            rebaseCursor(geometryCursor, relativeY: previousRelativeY)
        }
        if geometryChanged || progress != previousProgress {
            layout.invalidateLayout()
            requestBounds = nil
        }
        if mounted, let morph,
           modeChanged || progress != previousProgress || explicitNavigation {
            collection.contentOffset.y = morph.year + (morph.month - morph.year) * layout.progress
        }
        lastSemanticAnchor = next.state.anchorDate
        lastMode = next.state.view
        collection.isScrollEnabled = isRequestedEndpoint
        // UIKit consumes invalidated layout in its normal pass. Existing cells
        // receive the SAME drawing sample now; newly displayed cells configure
        // through the data source. Do not force a full layout per animation sample.
        refreshVisible()
        queueViewportRequest()
    }

    private func geometryKey(_ locale: CalendarLocale) -> String {
        "\(locale.languageTag)|\(locale.timeZoneId)|\(locale.resolvedWeekStart)|\(input?.rightToLeft == true)"
    }

    private var isRequestedEndpoint: Bool {
        layout.progress == (input?.state.view == .year ? 0 : 1)
    }

    private func endpoints(for month: CalendarViewportMonth) -> MorphEndpoints {
        let target = layout.frame(month.index, progress: 0)
        return MorphEndpoints(focal: month,
                              year: max(0, target.midY - view.bounds.height / 2),
                              month: layout.frame(month.index, progress: 1).minY)
    }

    private func civilPreparationRequest(_ request: CalendarViewportRequest) -> CalendarViewportRequest {
        guard let morph else { return request }
        // Prepare the real opposite endpoint envelope, not 48 arbitrary nearby
        // localized months. These are content-free civil values, never extra reads.
        let opposite: CGFloat = layout.progress == 0 ? 1 : 0
        let y = opposite == 0 ? morph.year : morph.month
        let header = max(CalendarSurfaceLayout.weekdayHeaderHeight, layout.dateSize * 1.6) * opposite
        let rect = CGRect(x: 0, y: y, width: view.bounds.width, height: max(0, view.bounds.height - header))
        let other = layout.periodRequest(in: rect, progress: opposite)
        var seen = Set<CalendarViewportMonth>()
        let months = (request.months + other.months).filter { seen.insert($0).inserted }
        return .init(months: Array(months.prefix(CalendarViewportRequest.maximumPeriods)))
    }

    private func prepareCivil(for request: CalendarViewportRequest, locale: CalendarLocale) {
        guard !request.months.isEmpty else { return }
        let key = geometryKey(locale)
        let keep = Set(request.months.prefix(CalendarViewportRequest.maximumPeriods))
        guard civilKey != key || preparedMonths != keep else { return }
        if civilKey != key {
            contentVersion += 1
            civil.removeAll()
            weekdayHeader?.removeFromSuperview()
            let direction: LayoutDirection = input?.rightToLeft == true ? .rightToLeft : .leftToRight
            let header = UIHostingConfiguration {
                CalendarFixedWeekdays(locale: locale).environment(\.layoutDirection, direction)
            }.margins(.all, 0).makeContentView()
            header.isUserInteractionEnabled = false
            header.accessibilityElementsHidden = true
            view.addSubview(header)
            weekdayHeader = header
            header.frame = CGRect(x: -collection.contentOffset.x, y: 0, width: layout.width,
                                  height: max(CalendarSurfaceLayout.weekdayHeaderHeight, layout.dateSize * 1.6) * layout.progress)
            header.alpha = layout.progress
        }
        civilKey = key
        preparedMonths = keep
        civil = civil.filter { keep.contains($0.key) }
        for id in keep where civil[id] == nil { civil[id] = CalendarCivilMonth(id: id, locale: locale) }
    }

    private func placeViewport(preserveCursor: Bool = true) {
        let resized = layout.viewportSize != view.bounds.size
        let cursor = anchor ?? input.map {
            CalendarViewportMonth.clampedToNativeDomain(CalendarViewportMonth(date: $0.state.anchorDate))
        }
        let oldFrame = resized && mounted ? cursor.map { layout.frame($0.index, progress: layout.progress) } : nil
        let relativeY = oldFrame.map { (collection.contentOffset.y - $0.minY) / max(1, $0.height) } ?? 0
        if resized { requestBounds = nil }
        layout.viewportSize = view.bounds.size
        let headerHeight = max(CalendarSurfaceLayout.weekdayHeaderHeight, layout.dateSize * 1.6) * layout.progress
        weekdayHeader?.frame = CGRect(x: -collection.contentOffset.x, y: 0, width: layout.width, height: headerHeight)
        weekdayHeader?.alpha = layout.progress
        collection.frame = CGRect(x: 0, y: headerHeight, width: view.bounds.width,
                                  height: max(0, view.bounds.height - headerHeight))
        if resized, mounted, preserveCursor, let cursor {
            // Rotation/window resizing retains the civil cursor and its local
            // position. No observable geometry, callbacks, or scroll retries.
            rebaseCursor(cursor, relativeY: relativeY)
        }
    }

    private func rebaseCursor(_ cursor: CalendarViewportMonth, relativeY: CGFloat) {
        let frame = layout.frame(cursor.index, progress: layout.progress)
        layout.invalidateLayout()
        collection.contentOffset.y = frame.minY + relativeY * frame.height
        morph = endpoints(for: cursor)
        if layout.progress == 1 { morph?.month = collection.contentOffset.y }
        if layout.progress == 0 { morph?.year = collection.contentOffset.y }
    }

    private func foregroundPeriods(_ state: CalendarUiState) -> [CalendarViewportMonth: CalendarViewportMonthData] {
        // Compatibility input only: NEVER claim a neighboring month is loaded.
        let availability: CalendarViewportMonthData.Availability = state.loading.isInitial ? .loading : .ready
        if let month = state.month {
            return [CalendarViewportMonth(year: month.year, month: month.month): .init(cells: month.cells, availability: availability)]
        }
        if let year = state.year {
            return Dictionary(uniqueKeysWithValues: year.months.map {
                (CalendarViewportMonth(year: year.year, month: $0.month), .init(cells: $0.days, availability: availability))
            })
        }
        return [:]
    }

    private func positionInitially(_ month: CalendarViewportMonth) {
        let month = CalendarViewportMonth.clampedToNativeDomain(month)
        morph = endpoints(for: month)
        guard let morph else { return }
        collection.contentOffset = CGPoint(x: 0, y: morph.year + (morph.month - morph.year) * layout.progress)
        // Centering a requested Year month is positioning, NOT browsing. The
        // leading row still owns the read envelope but cannot silently take
        // ownership of the heading or the paired expanded endpoint.
        reported = month
    }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        CalendarNativeViewportLayout.monthCount
    }
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "month", for: indexPath) as! CalendarReusableMonthCell
        cells.add(cell)
        displayedCells.setObject(NSNumber(value: indexPath.item), forKey: cell)
        configure(cell, id: CalendarViewportMonth(index: indexPath.item))
        return cell
    }
    func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        if let cell = cell as? CalendarReusableMonthCell {
            displayedCells.removeObject(forKey: cell)
            cell.clear()
        }
    }
    func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        if let cell = cell as? CalendarReusableMonthCell {
            displayedCells.setObject(NSNumber(value: indexPath.item), forKey: cell)
            configure(cell, id: CalendarViewportMonth(index: indexPath.item))
        }
    }
    private func refreshVisible() {
        // Do not ask UICollectionView to resolve visible index paths (and
        // potentially consume pending layout) on every animation sample.
        for cell in displayedCells.keyEnumerator().allObjects.compactMap({ $0 as? CalendarReusableMonthCell }) {
            guard let index = displayedCells.object(forKey: cell)?.intValue else { continue }
            configure(cell, id: CalendarViewportMonth(index: index))
        }
    }
    private func configure(_ cell: CalendarReusableMonthCell, id: CalendarViewportMonth) {
        guard let input, input.isActive, civilKey == inputLocaleKey, let month = civil[id] else { cell.clear(); return }
        cell.configure(
            month: month, period: latest[id],
            today: input.state.todayDate, selected: input.state.selectedDate,
            progress: layout.progress, expanded: input.state.view == .month,
            dateSize: input.dateSize, rightToLeft: input.rightToLeft,
            contrast: input.increasedContrast, enabled: isRequestedEndpoint,
            contentVersion: contentVersion,
            moveMonth: { [weak self] step in
                guard let self, self.input?.isActive == true else { return }
                let delta = abs(step) == 7 ? (step < 0 ? -self.layout.columns : self.layout.columns) : step
                let target = min(CalendarNativeViewportLayout.monthCount - 1, max(0, id.index + delta))
                let path = IndexPath(item: target, section: 0)
                // One explicit keyboard action, not a scroll-position retry.
                self.collection.scrollToItem(at: path, at: .centeredVertically, animated: false)
                self.collection.layoutIfNeeded()
                (self.collection.cellForItem(at: path) as? CalendarReusableMonthCell)?.focusForKeyboard()
                if let cell = self.collection.cellForItem(at: path) {
                    self.focusVisibility?.reveal(cell.frame)
                }
                self.publishBrowse()
            },
            moveDate: { [weak self] date in
                self?.focusDate(date)
            },
            activate: { [weak self] date in
                guard let self, let current = self.input, current.isActive else { return }
                if current.state.view == .year { current.onSelectMonth(id.year, id.month) }
                else if let date { current.onSelectDate(date) }
            },
            compactSize: layout.frame(id.index, progress: 0).size,
            expandedSize: layout.frame(id.index, progress: 1).size,
            reduceMotion: input.reduceMotion
        )
    }

    private func focusDate(_ date: String) {
        guard input?.isActive == true, input?.state.view == .month, layout.progress == 1 else { return }
        let id = CalendarViewportMonth(date: date)
        guard id.isNativeSupported else { return }
        let path = IndexPath(item: id.index, section: 0)
        if collection.cellForItem(at: path) == nil {
            // Explicit keyboard navigation only; no deferred position repair.
            collection.scrollToItem(at: path, at: .centeredVertically, animated: false)
            collection.layoutIfNeeded()
        }
        guard let cell = collection.cellForItem(at: path) as? CalendarReusableMonthCell,
              let rect = cell.focusForKeyboard(date: date) else { return }
        focusVisibility?.reveal(cell.convert(rect, to: collection))
        publishBrowse()
    }

    override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
        super.didUpdateFocus(in: context, with: coordinator)
        if let focused = context.nextFocusedView { focusVisibility?.revealFocusedView(focused) }
    }

    func scrollViewWillBeginDragging(_: UIScrollView) { userBrowsing = true }
    func scrollViewDidEndDragging(_: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { userBrowsing = false }
    }
    func scrollViewDidEndDecelerating(_: UIScrollView) { userBrowsing = false }
    func scrollViewDidEndScrollingAnimation(_: UIScrollView) { userBrowsing = false }
    func scrollViewShouldScrollToTop(_: UIScrollView) -> Bool {
        userBrowsing = true
        return true
    }
    func scrollViewDidScrollToTop(_: UIScrollView) { userBrowsing = false }

    func scrollViewDidScroll(_: UIScrollView) {
        guard userBrowsing else { return }
        publishBrowse()
    }

    private func publishBrowse() {
        guard !updating, mounted, let input, input.isActive,
              isRequestedEndpoint else { return }
        guard let month = layout.leadingVisibleMonth(in: collection.bounds) else { return }
        if reported != month {
            reported = month
            morph = endpoints(for: month)
            refreshVisible()
            // A civil boundary change, not an observable scroll-geometry sample.
            input.onBrowse(month)
        }
        if layout.progress == 0 { morph?.year = collection.contentOffset.y }
        if layout.progress == 1 { morph?.month = collection.contentOffset.y }
        queueViewportRequest()
    }

    private func invalidateRequests(resetDelivered: Bool) {
        requests.invalidate(resetDelivered: resetDelivered)
        requestBounds = nil
        requestProgress = nil
    }

    private func queueViewportRequest() {
        guard mounted, let input else { return }
        let request: CalendarViewportRequest
        if !input.isActive {
            request = .init(months: [])
        } else {
            guard isRequestedEndpoint else { return }
            guard requestBounds != collection.bounds || requestProgress != layout.progress else { return }
            requestBounds = collection.bounds
            requestProgress = layout.progress
            request = layout.periodRequest(in: collection.bounds)
        }
        guard let delivery = requests.enqueue(request) else { return }
        requestContinuation?.yield(delivery)
    }

    private func clearContent() {
        latest.removeAll()
        contentVersion += 1
        lastProjection = nil
        lastDataRevision = nil
        for cell in cells.allObjects { cell.clear() }
    }
    func dispose() {
        requestTask?.cancel()
        requestTask = nil
        requestContinuation?.finish()
        requestContinuation = nil
        clearContent()
        input = nil
        focusVisibility = nil
        weekdayHeader?.removeFromSuperview()
        weekdayHeader = nil
        displayedCells.removeAllObjects()
        collection.delegate = nil
        collection.dataSource = nil
        civil.removeAll()
        invalidateRequests(resetDelivered: true)
        morph = nil
    }
}

/// Cancellable request lifecycle, not navigation or authority storage. A
/// buffered request cannot cross a newer mode/context/lifecycle edge. Only
/// bounded civil identities survive delivery, never projections or callbacks.
struct CalendarViewportRequestMailbox {
    struct Delivery: Equatable {
        let epoch: Int
        let request: CalendarViewportRequest
    }
    private var epoch = 0
    private var pending: Delivery?
    private var delivered: Set<CalendarViewportMonth>?

    mutating func invalidate(resetDelivered: Bool) {
        epoch += 1
        pending = nil
        if resetDelivered { delivered = nil }
    }

    mutating func enqueue(_ request: CalendarViewportRequest) -> Delivery? {
        let next = Delivery(epoch: epoch, request: request)
        guard pending != next else { return nil }
        pending = next
        return next
    }

    mutating func consume(_ delivery: Delivery) -> Bool {
        guard delivery.epoch == epoch, pending == delivery else { return false }
        pending = nil
        return true
    }

    mutating func shouldPublish(_ request: CalendarViewportRequest) -> Bool {
        let identities = Set(request.months)
        guard delivered != identities else { return false }
        delivered = identities
        return true
    }
}

/// VoiceOver page scrolling is user navigation too, but does not begin a
/// pan gesture. Preserve UIKit's native scroll/announcement behavior while
/// distinguishing it from deferred collection-layout offset adjustments.
private final class CalendarMonthCollectionView: UICollectionView {
    var onAccessibilityScroll: ((Bool) -> Void)?

    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        onAccessibilityScroll?(true)
        let accepted = super.accessibilityScroll(direction)
        if !accepted { onAccessibilityScroll?(false) }
        return accepted
    }
}
