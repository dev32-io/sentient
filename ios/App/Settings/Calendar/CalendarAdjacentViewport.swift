import Foundation
import MobileData
import SwiftUI
import UIKit

struct CalendarAdjacentViewport: UIViewControllerRepresentable {
    let current: CalendarAdjacentPageID
    let data: CalendarAdjacentViewportData
    let locale: CalendarLocale
    let openerFocus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding
    let onRequest: (CalendarAdjacentViewportRequest) -> Void
    let onBrowse: (CalendarViewportDate) -> Void
    let onEvent: (CalendarProjectedEvent) -> Void
    let onSelectDate: (CalendarViewportDate, String) -> Void
    let onRetry: () -> Void
    @Environment(\.layoutDirection) private var direction
    @Environment(\.calendarBottomOcclusion) private var bottomOcclusion
    @Environment(\.calendarTodayRevision) private var todayRevision

    func makeUIViewController(context: Context) -> CalendarAdjacentViewController {
        CalendarAdjacentViewController()
    }

    func updateUIViewController(_ controller: CalendarAdjacentViewController, context: Context) {
        controller.update(self, rightToLeft: direction == .rightToLeft,
                          bottomOcclusion: bottomOcclusion, todayRevision: todayRevision)
    }

    static func dismantleUIViewController(_ controller: CalendarAdjacentViewController, coordinator: ()) {
        controller.clear()
    }
}

/// Stable arithmetic civil topology. Event data and views remain bounded to
/// visible/overscan periods; a flick never replaces collection items or resets
/// its offset to roll a finite window.
struct CalendarAdjacentDomain: Equatable {
    static let lastOrdinal = CalendarViewportDate(date: "9999-11-30")!.ordinal
    static let maximumSlots = 20_001

    let view: CalendarView
    let firstOrdinal: Int
    let step: Int
    let count: Int
    let totalCount: Int

    init(center: CalendarAdjacentPageID) {
        view = center.view
        step = center.stepDays
        let residue = center.view == .week ? center.anchor.ordinal % 7 : 0
        totalCount = (Self.lastOrdinal - residue) / step + 1
        count = min(Self.maximumSlots, totalCount)
        let centerIndex = (center.anchor.ordinal - residue) / step
        let firstIndex = min(max(0, centerIndex - count / 2), totalCount - count)
        firstOrdinal = residue + firstIndex * step
    }

    func index(of period: CalendarAdjacentPageID) -> Int? {
        guard period.view == view else { return nil }
        let distance = period.anchor.ordinal - firstOrdinal
        guard distance >= 0, distance % step == 0 else { return nil }
        let index = distance / step
        return index < count ? index : nil
    }

    func period(at index: Int) -> CalendarAdjacentPageID? {
        guard (0..<count).contains(index),
              let date = CalendarViewportDate(ordinal: firstOrdinal + index * step) else { return nil }
        let period = CalendarAdjacentPageID(view: view, anchor: date)
        return period.isAdjacentViewportEligible ? period : nil
    }
}

@MainActor
final class CalendarAdjacentViewController: UIViewController, UICollectionViewDataSource, UICollectionViewDelegate {
    private let layout = CalendarAdjacentViewportLayout()
    private lazy var collection = CalendarAdjacentCollectionView(frame: .zero, collectionViewLayout: layout)
    private var focusVisibility: CalendarViewportFocusVisibility?
    private var input: CalendarAdjacentViewport?
    private var domain: CalendarAdjacentDomain?
    private var generation: String?
    private var semanticAnchor: CalendarViewportDate?
    private var lastBrowse: CalendarAdjacentPageID?
    private var lastLeadingPeriod: CalendarAdjacentPageID?
    private var lastRequest: CalendarAdjacentViewportRequest?
    private var lastTodayRevision: Int?
    private var lastOpenerFocus: CalendarOverlayOrigin?
    private var protectedPeriod: CalendarAdjacentPageID?
    private var protectedEventKey: String?
    private var rightToLeft = false
    private var bottomOcclusion: CGFloat = 0
    private struct RowAnchor {
        let period: CalendarAdjacentPageID
        let id: CalendarAdjacentRowID
        let screenY: CGFloat
    }

    private var pendingClampedBrowse: CalendarAdjacentPageID?
    private var pendingRowAnchors: [RowAnchor] = []
    private var epoch = 0
    private var mounted = false
    private var positioning = false
    private var publishingRows = false
    private var restoringRowAnchor = false
    private var pendingPosition: CalendarAdjacentPageID?
    private var requestTask: Task<Void, Never>?
    private let cells = NSHashTable<CalendarAdjacentPeriodCell>.weakObjects()
    #if DEBUG
    var rowPublicationProbe: (() -> Void)?
    private(set) var viewportPublicationPasses = 0
    #endif

    private(set) var current: CalendarAdjacentPageID?
    private(set) var identities: [CalendarAdjacentPageID] = []
    private(set) var rowIdentities: [CalendarAdjacentRowID] = []

    override func loadView() {
        collection.dataSource = self
        collection.delegate = self
        collection.alwaysBounceVertical = true
        collection.showsVerticalScrollIndicator = false
        collection.showsHorizontalScrollIndicator = false
        collection.contentInsetAdjustmentBehavior = .never
        collection.keyboardDismissMode = .interactive
        collection.backgroundColor = UIColor(DuskColors.bg)
        collection.register(CalendarAdjacentPeriodCell.self, forCellWithReuseIdentifier: "calendar-period")
        collection.accessibilityIdentifier = "calendar-adjacent-viewport"
        focusVisibility = CalendarViewportFocusVisibility(scrollView: collection)
        view = collection
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard collection.bounds.width > 0, collection.bounds.height > 0 else { return }
        layout.viewportWidth = collection.bounds.width
        if !mounted {
            mounted = true
            if let target = pendingPosition ?? current { position(target) }
        } else if let target = pendingPosition {
            position(target)
        }
        if publishingRows {
            refreshTerminalInset()
            return
        }
        restoreVisibleRowAnchor()
        refreshTerminalInset()
        publishViewport()
    }

    func update(_ next: CalendarAdjacentViewport, rightToLeft: Bool,
                bottomOcclusion: CGFloat = 0, todayRevision: Int = 0) {
        loadViewIfNeeded()
        let target = next.current.clampedToAdjacentViewportDomain
        let nextDomain = target.map(CalendarAdjacentDomain.init(center:))
        let structural = generation != next.data.generation || domain?.view != nextDomain?.view ||
            target.map { domain?.index(of: $0) == nil } != false
        let explicitToday = lastTodayRevision != nil && lastTodayRevision != todayRevision
        let semanticUnchanged = semanticAnchor == next.data.semanticAnchor
        let directionChanged = self.rightToLeft != rightToLeft
        lastTodayRevision = todayRevision
        self.rightToLeft = rightToLeft
        self.bottomOcclusion = bottomOcclusion
        focusVisibility?.bottomOcclusion = bottomOcclusion + Space.xs
        collection.verticalScrollIndicatorInsets.bottom = bottomOcclusion

        guard next.data.isActive, let target, let nextDomain else {
            clear()
            return
        }

        if let input, input.data.revision != next.data.revision || input.data.generation != next.data.generation {
            captureVisibleRowAnchors()
            cells.allObjects.forEach { $0.retireEventRows() }
        }
        input = next
        semanticAnchor = next.data.semanticAnchor
        accessibilityFocusDidChange(next.openerFocus.wrappedValue)

        if structural {
            epoch &+= 1
            generation = next.data.generation
            domain = nextDomain
            layout.configure(itemCount: nextDomain.count, estimatedHeight: target.view == .week ? 560 : 64)
            current = target
            lastBrowse = nil
            lastLeadingPeriod = target
            lastRequest = nil
            requestTask?.cancel()
            protectedPeriod = nil
            protectedEventKey = nil
            pendingRowAnchors = []
            pendingPosition = target
            pendingClampedBrowse = next.current == target ? nil : target
            collection.reloadData()
            refreshDiagnostics(around: target)
            if mounted { position(target) }
            return
        }

        let isEcho = target == lastBrowse
        let cursorClearBeforeCommand = semanticUnchanged && next.current.anchor == next.data.semanticAnchor &&
            lastBrowse != nil && target != current
        let explicitNavigation = explicitToday || (target != current && !isEcho && !cursorClearBeforeCommand)
        if explicitNavigation {
            epoch &+= 1
            current = target
            lastBrowse = nil
            pendingRowAnchors = []
            pendingPosition = target
            collection.isScrollEnabled = false
            if mounted { position(target) }
            return
        }

        publishingRows = true
        cells.allObjects.forEach { configure($0, force: directionChanged) }
        #if DEBUG
        rowPublicationProbe?()
        #endif
        collection.layoutIfNeeded()
        publishingRows = false
        restoreVisibleRowAnchor()
        refreshTerminalInset()
        refreshDiagnostics(around: current ?? target)
        publishViewport()
    }

    func clear() {
        epoch &+= 1
        input = nil
        generation = nil
        domain = nil
        current = nil
        identities = []
        rowIdentities = []
        semanticAnchor = nil
        lastBrowse = nil
        lastLeadingPeriod = nil
        lastRequest = nil
        requestTask?.cancel()
        requestTask = nil
        protectedPeriod = nil
        protectedEventKey = nil
        pendingPosition = nil
        pendingClampedBrowse = nil
        pendingRowAnchors = []
        publishingRows = false
        restoringRowAnchor = false
        cells.allObjects.forEach { $0.clear() }
        guard isViewLoaded else { return }
        layout.configure(itemCount: 0, estimatedHeight: 64)
        collection.reloadData()
        collection.isScrollEnabled = false
    }

    func waitForPendingSnapshots() async {
        await requestTask?.value
        await Task.yield()
    }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        domain?.count ?? 0
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "calendar-period", for: indexPath)
            as! CalendarAdjacentPeriodCell
        cells.add(cell)
        configure(cell, at: indexPath)
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell,
                        forItemAt indexPath: IndexPath) {
        if let cell = cell as? CalendarAdjacentPeriodCell { configure(cell, at: indexPath) }
    }

    func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell,
                        forItemAt indexPath: IndexPath) {
        (cell as? CalendarAdjacentPeriodCell)?.clear()
    }

    private func configure(_ cell: CalendarAdjacentPeriodCell, at path: IndexPath? = nil, force: Bool = false) {
        guard let indexPath = path ?? collection.indexPath(for: cell), let domain,
              let period = domain.period(at: indexPath.item), let input, input.data.isActive else {
            cell.clear()
            return
        }
        let rows = CalendarAdjacentRow.rows(
            for: period, data: input.data.pages[period], locale: input.locale,
            selectedDate: input.data.selectedDate, todayDate: input.data.todayDate
        )
        let previousIDs = cell.period == period ? cell.rowIDs : []
        let arrivingRows = Set(rows.compactMap { row -> CalendarAdjacentRowID? in
            guard !previousIDs.isEmpty, !previousIDs.contains(row.id) else { return nil }
            if case .event = row.id.kind { return row.id }
            return nil
        })
        let callbackEpoch = epoch
        let callbackGeneration = input.data.generation
        let callbackRevision = input.data.revision
        cell.bind(
            period: period, rows: rows, arrivingRows: arrivingRows, revision: callbackRevision,
            locale: input.locale, rightToLeft: rightToLeft, openerFocus: input.openerFocus, force: force,
            onEvent: { [weak self] id, event in
                guard let self, self.accepts(id, epoch: callbackEpoch, generation: callbackGeneration,
                                             revision: callbackRevision) else { return }
                self.protectedPeriod = period
                self.protectedEventKey = event.actionIdentity.stableKey
                self.input?.onEvent(event)
            },
            onSelectDate: { [weak self] id, date in
                guard let self, self.accepts(id, epoch: callbackEpoch, generation: callbackGeneration,
                                             revision: nil) else { return }
                self.input?.onSelectDate(period.anchor, date)
            },
            onRetry: { [weak self] id in
                guard let self, self.accepts(id, epoch: callbackEpoch, generation: callbackGeneration,
                                             revision: nil) else { return }
                self.input?.onRetry()
            }
        )
        if let indexPath = path ?? collection.indexPath(for: cell),
           let original = layout.layoutAttributesForItem(at: indexPath) {
            let preferred = cell.preferredLayoutAttributesFitting(original)
            if layout.shouldInvalidateLayout(
                forPreferredLayoutAttributes: preferred, withOriginalAttributes: original
            ) {
                layout.invalidateLayout(with: layout.invalidationContext(
                    forPreferredLayoutAttributes: preferred, withOriginalAttributes: original
                ))
            }
        }
        refreshTerminalInset()
    }

    private func captureVisibleRowAnchors() {
        pendingRowAnchors = cells.allObjects.flatMap { cell in
            guard let period = cell.period else { return [RowAnchor]() }
            return cell.visibleRowAnchors().map { RowAnchor(period: period, id: $0.id, screenY: $0.screenY) }
        }.sorted { $0.screenY < $1.screenY }
    }

    private func restoreVisibleRowAnchor() {
        guard !publishingRows, !restoringRowAnchor, !pendingRowAnchors.isEmpty else { return }
        restoringRowAnchor = true
        defer { restoringRowAnchor = false }
        collection.layoutIfNeeded()
        for anchor in pendingRowAnchors {
            guard let cell = cells.allObjects.first(where: { $0.period == anchor.period }),
                  let frame = cell.rowFrame(for: anchor.id, in: collection) else { continue }
            let delta = frame.minY - collection.bounds.minY - anchor.screenY
            // Consume only after every visible host and preferred height in this
            // publication has committed. Later native movement owns its offset.
            pendingRowAnchors.removeAll(keepingCapacity: true)
            layout.adjustVisibleRow(by: delta)
            return
        }
    }

    private func accepts(_ id: CalendarAdjacentRowID, epoch: Int, generation: String, revision: Int?) -> Bool {
        guard self.epoch == epoch, self.generation == generation, input?.data.isActive == true,
              revision == nil || input?.data.revision == revision else { return false }
        return id.period == domain?.period(at: domain?.index(of: id.period) ?? -1)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === collection, !positioning else { return }
        publishViewport()
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { recenterIfNeeded() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        recenterIfNeeded()
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        recenterIfNeeded()
    }

    /// A 20k-slot plane exceeds any kinetic trip while keeping native geometry
    /// precise. Move that plane only after motion ends, retaining visible anchor.
    private func recenterIfNeeded() {
        guard !positioning, let current, let domain, domain.totalCount > domain.count,
              let index = domain.index(of: current),
              index < 2_000 || index >= domain.count - 2_000 else { return }
        let screenY = layout.frame(at: index).minY -
            (collection.contentOffset.y + collection.adjustedContentInset.top)
        let replacement = CalendarAdjacentDomain(center: current)
        guard replacement.firstOrdinal != domain.firstOrdinal else { return }
        self.domain = replacement
        layout.configure(itemCount: replacement.count,
                         estimatedHeight: current.view == .week ? 560 : 64)
        collection.reloadData()
        position(current, screenOffset: screenY)
    }

    private func publishViewport() {
        guard !publishingRows, !restoringRowAnchor,
              mounted, !positioning, let input, input.data.isActive, let domain,
              collection.bounds.height > 0 else { return }
        #if DEBUG
        viewportPublicationPasses &+= 1
        #endif
        let visible = layout.indices(in: collection.bounds)
        guard !visible.isEmpty else { return }
        let periods = visible.compactMap(domain.period(at:))
        guard let leading = periods.first else { return }
        current = leading
        refreshDiagnostics(around: leading, visible: periods)
        if leading != lastLeadingPeriod {
            lastLeadingPeriod = leading
            if lastBrowse != leading {
                lastBrowse = leading
                input.onBrowse(leading.anchor)
            }
        }
        publishRequest(visible: periods)
    }

    private func publishRequest(visible: [CalendarAdjacentPageID]) {
        guard input != nil, let domain, let current else { return }
        var ordered = visible
        if !ordered.contains(current) { ordered.insert(current, at: 0) }
        if let first = visible.first.flatMap(domain.index(of:)), let last = visible.last.flatMap(domain.index(of:)) {
            var distance = 1
            while ordered.count < CalendarAdjacentPeriodWindow.maximumPeriods {
                var added = false
                if first - distance >= 0, let period = domain.period(at: first - distance), !ordered.contains(period) {
                    ordered.append(period)
                    added = true
                }
                if ordered.count < CalendarAdjacentPeriodWindow.maximumPeriods,
                   last + distance < domain.count, let period = domain.period(at: last + distance), !ordered.contains(period) {
                    ordered.append(period)
                    added = true
                }
                if !added { break }
                distance += 1
            }
        }
        ordered.removeAll { !$0.isAdjacentViewportEligible }
        ordered = Array(ordered.prefix(CalendarAdjacentPeriodWindow.maximumPeriods))
        if let protectedPeriod, !ordered.contains(protectedPeriod) { ordered.append(protectedPeriod) }
        if let currentIndex = ordered.firstIndex(of: current) {
            ordered.remove(at: currentIndex)
            ordered.insert(current, at: 0)
        }
        let request = CalendarAdjacentViewportRequest(view: current.view, periods: ordered.map(\.anchor))
        guard request != lastRequest else { return }
        lastRequest = request
        requestTask?.cancel()
        let requestEpoch = epoch
        requestTask = Task { @MainActor [weak self] in
            await Task.yield()
            guard !Task.isCancelled, let self, self.epoch == requestEpoch,
                  let input = self.input, input.data.isActive else { return }
            input.onRequest(request)
        }
    }

    private func refreshDiagnostics(around center: CalendarAdjacentPageID,
                                    visible: [CalendarAdjacentPageID] = []) {
        let values = visible.isEmpty ? CalendarAdjacentPeriodWindow.initial(around: center) : visible
        identities = Array(values.prefix(CalendarAdjacentPeriodWindow.maximumPeriods))
        guard let input else { rowIdentities = []; return }
        rowIdentities = identities.flatMap {
            CalendarAdjacentRow.rows(for: $0, data: input.data.pages[$0], locale: input.locale,
                                     selectedDate: input.data.selectedDate, todayDate: input.data.todayDate).map(\.id)
        }
    }

    private func position(_ period: CalendarAdjacentPageID, screenOffset: CGFloat = 0) {
        guard let domain, let index = domain.index(of: period), collection.bounds.height > 0 else {
            pendingPosition = period
            return
        }
        positioning = true
        pendingPosition = nil
        collection.isScrollEnabled = false
        layout.viewportWidth = collection.bounds.width
        layout.invalidateLayout()
        collection.layoutIfNeeded()
        let y = layout.frame(at: index).minY - screenOffset - collection.adjustedContentInset.top
        collection.setContentOffset(CGPoint(x: 0, y: y), animated: false)
        layout.invalidateLayout()
        collection.setNeedsLayout()
        current = period
        lastLeadingPeriod = period
        collection.isScrollEnabled = true
        positioning = false
        refreshTerminalInset()
        if pendingClampedBrowse == period {
            pendingClampedBrowse = nil
            lastBrowse = period
            input?.onBrowse(period.anchor)
        }
        publishViewport()
    }

    private func refreshTerminalInset() {
        var inset = bottomOcclusion
        if let domain, domain.count > 0,
           domain.period(at: domain.count - 1)?.anchor.ordinal == CalendarAdjacentDomain.lastOrdinal,
           collection.bounds.height > 0 {
            let last = layout.frame(at: domain.count - 1)
            inset = max(inset, collection.bounds.height - collection.adjustedContentInset.top
                        - (layout.collectionViewContentSize.height - last.minY))
        }
        collection.contentInset.bottom = max(0, inset)
        collection.verticalScrollIndicatorInsets.bottom = bottomOcclusion
    }

    func accessibilityFocusDidChange(_ focus: CalendarOverlayOrigin?) {
        guard lastOpenerFocus != focus else { return }
        lastOpenerFocus = focus
        guard let protectedEventKey, case .event(let key) = focus, key == protectedEventKey else { return }
        protectedPeriod = nil
        self.protectedEventKey = nil
        publishViewport()
    }

    override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
        super.didUpdateFocus(in: context, with: coordinator)
        if let focused = context.nextFocusedView { focusVisibility?.revealFocusedView(focused) }
    }
}

private final class CalendarAdjacentLayoutInvalidationContext: UICollectionViewLayoutInvalidationContext {
    var item: Int?
    var height: CGFloat?
}

/// Sparse measured-height corrections over arithmetic civil slots. Layout
/// allocates attributes only near query; controller shifts slot plane at rest.
final class CalendarAdjacentViewportLayout: UICollectionViewLayout {
    override class var invalidationContextClass: AnyClass { CalendarAdjacentLayoutInvalidationContext.self }

    private(set) var itemCount = 0
    private var estimatedHeight: CGFloat = 64
    private var heights: [Int: CGFloat] = [:]
    private var corrections: [(index: Int, prefix: CGFloat)] = []
    private var preparedWidth: CGFloat = 0
    var viewportWidth: CGFloat = 0
    let spacing = Space.sm

    func configure(itemCount: Int, estimatedHeight: CGFloat) {
        self.itemCount = itemCount
        self.estimatedHeight = estimatedHeight
        heights.removeAll(keepingCapacity: true)
        corrections.removeAll(keepingCapacity: true)
        invalidateLayout()
    }

    override func prepare() {
        super.prepare()
        let width = collectionView?.bounds.width ?? viewportWidth
        guard width != preparedWidth else { return }
        preparedWidth = width
        viewportWidth = width
        heights.removeAll(keepingCapacity: true)
        corrections.removeAll(keepingCapacity: true)
    }

    override var collectionViewContentSize: CGSize {
        guard itemCount > 0 else { return CGSize(width: viewportWidth, height: 0) }
        return CGSize(width: viewportWidth, height: frame(at: itemCount - 1).maxY)
    }

    func frame(at index: Int) -> CGRect {
        let y = CGFloat(index) * (estimatedHeight + spacing) + correction(before: index)
        return CGRect(x: 0, y: y, width: viewportWidth, height: heights[index] ?? estimatedHeight)
    }

    func indices(in rect: CGRect) -> [Int] {
        guard itemCount > 0, !rect.isNull, !rect.isEmpty else { return [] }
        var low = 0
        var high = itemCount
        while low < high {
            let middle = (low + high) / 2
            if frame(at: middle).maxY < rect.minY { low = middle + 1 } else { high = middle }
        }
        var result: [Int] = []
        var index = max(0, low - 1)
        while index < itemCount, frame(at: index).minY <= rect.maxY {
            if frame(at: index).intersects(rect) { result.append(index) }
            index += 1
        }
        return result
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        let overscan = rect.insetBy(dx: 0, dy: -rect.height)
        return indices(in: overscan).compactMap { layoutAttributesForItem(at: IndexPath(item: $0, section: 0)) }
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard indexPath.section == 0, (0..<itemCount).contains(indexPath.item) else { return nil }
        let attributes = UICollectionViewLayoutAttributes(forCellWith: indexPath)
        attributes.frame = frame(at: indexPath.item)
        return attributes
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.size != collectionView?.bounds.size
    }

    override func shouldInvalidateLayout(forPreferredLayoutAttributes preferredAttributes: UICollectionViewLayoutAttributes,
                                         withOriginalAttributes originalAttributes: UICollectionViewLayoutAttributes) -> Bool {
        abs(preferredAttributes.size.height - (heights[preferredAttributes.indexPath.item] ?? estimatedHeight)) > 0.5
    }

    override func invalidationContext(forPreferredLayoutAttributes preferredAttributes: UICollectionViewLayoutAttributes,
                                      withOriginalAttributes originalAttributes: UICollectionViewLayoutAttributes)
        -> UICollectionViewLayoutInvalidationContext {
        let context = CalendarAdjacentLayoutInvalidationContext()
        let index = preferredAttributes.indexPath.item
        let old = heights[index] ?? estimatedHeight
        let new = max(1, preferredAttributes.size.height)
        context.item = index
        context.height = new
        if originalAttributes.frame.maxY <= (collectionView?.bounds.minY ?? 0) + 0.5 {
            context.contentOffsetAdjustment.y = new - old
        }
        return context
    }

    func adjustVisibleRow(by delta: CGFloat) {
        guard abs(delta) > 0.5 else { return }
        let context = CalendarAdjacentLayoutInvalidationContext()
        context.contentOffsetAdjustment.y = delta
        invalidateLayout(with: context)
    }

    override func invalidateLayout(with context: UICollectionViewLayoutInvalidationContext) {
        if let context = context as? CalendarAdjacentLayoutInvalidationContext,
           let item = context.item, let height = context.height {
            heights[item] = height
            rebuildCorrections()
        }
        super.invalidateLayout(with: context)
    }

    private func rebuildCorrections() {
        var total: CGFloat = 0
        corrections = heights.sorted { $0.key < $1.key }.map { entry in
            total += entry.value - estimatedHeight
            return (entry.key, total)
        }
    }

    private func correction(before index: Int) -> CGFloat {
        var low = 0
        var high = corrections.count
        while low < high {
            let middle = (low + high) / 2
            if corrections[middle].index < index { low = middle + 1 } else { high = middle }
        }
        return low == 0 ? 0 : corrections[low - 1].prefix
    }
}

@MainActor
final class CalendarAdjacentPeriodCell: UICollectionViewCell {
    private struct HostedRow {
        let row: CalendarAdjacentRow
        let revision: Int
        let view: UIView
        let eventAction: (() -> Void)?
    }

    override var safeAreaInsets: UIEdgeInsets { .zero }
    private(set) var period: CalendarAdjacentPageID?
    private(set) var rowIDs: Set<CalendarAdjacentRowID> = []
    private var hosted: [CalendarAdjacentRowID: HostedRow] = [:]
    private let stack = UIStackView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        stack.axis = .vertical
        stack.spacing = Space.sm
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func bind(
        period: CalendarAdjacentPageID,
        rows: [CalendarAdjacentRow],
        arrivingRows: Set<CalendarAdjacentRowID>,
        revision: Int,
        locale: CalendarLocale,
        rightToLeft: Bool,
        openerFocus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding,
        force: Bool,
        onEvent: @escaping (CalendarAdjacentRowID, CalendarProjectedEvent) -> Void,
        onSelectDate: @escaping (CalendarAdjacentRowID, String) -> Void,
        onRetry: @escaping (CalendarAdjacentRowID) -> Void
    ) {
        if self.period != period { clear() }
        self.period = period
        let nextIDs = Set(rows.map(\.id))

        for (id, value) in hosted where !nextIDs.contains(id) {
            value.view.removeFromSuperview()
            hosted[id] = nil
        }
        for row in rows {
            let old = hosted[row.id]
            let eventRevisionChanged: Bool
            if case .event = row.content { eventRevisionChanged = old?.revision != revision }
            else { eventRevisionChanged = false }
            if force || eventRevisionChanged || old?.row.matchesPresentation(row) != true {
                old?.view.removeFromSuperview()
                let configuration = UIHostingConfiguration {
                    CalendarAdjacentPeriodRow(
                        row: row, animateArrival: old == nil && arrivingRows.contains(row.id),
                        locale: locale, rightToLeft: rightToLeft, openerFocus: openerFocus,
                        onEvent: { onEvent(row.id, $0) },
                        onSelectDate: { onSelectDate(row.id, $0) },
                        onRetry: { onRetry(row.id) }
                    )
                }
                .margins(.all, 0)
                .minSize(width: 0, height: 0)
                let eventAction: (() -> Void)?
                if case .event(let event) = row.content { eventAction = { onEvent(row.id, event) } }
                else { eventAction = nil }
                hosted[row.id] = HostedRow(
                    row: row, revision: revision, view: configuration.makeContentView(), eventAction: eventAction
                )
            }
        }
        for view in stack.arrangedSubviews { stack.removeArrangedSubview(view) }
        for row in rows { if let view = hosted[row.id]?.view { stack.addArrangedSubview(view) } }
        rowIDs = nextIDs
        contentView.alpha = 1
        contentView.isUserInteractionEnabled = true
        contentView.accessibilityElementsHidden = false
        setNeedsLayout()
        layoutIfNeeded()
    }

    /// Event authority changes at revision boundaries. Remove old pixels, AX,
    /// and hit targets before SwiftUI gets a chance to render successor state.
    func retireEventRows() {
        for (id, value) in hosted where id.isEvent {
            value.view.alpha = 0
            value.view.isUserInteractionEnabled = false
            value.view.accessibilityElementsHidden = true
        }
        setNeedsLayout()
        layoutIfNeeded()
    }

    func clear() {
        hosted.values.forEach {
            $0.view.isUserInteractionEnabled = false
            $0.view.accessibilityElementsHidden = true
            $0.view.removeFromSuperview()
        }
        hosted.removeAll(keepingCapacity: true)
        stack.arrangedSubviews.forEach { stack.removeArrangedSubview($0) }
        period = nil
        rowIDs.removeAll(keepingCapacity: true)
        contentConfiguration = nil
        contentView.alpha = 0
        contentView.isUserInteractionEnabled = false
        contentView.accessibilityElementsHidden = true
    }

    func hostedView(for id: CalendarAdjacentRowID) -> UIView? { hosted[id]?.view }
    func eventAction(for id: CalendarAdjacentRowID) -> (() -> Void)? { hosted[id]?.eventAction }
    func rowFrame(for id: CalendarAdjacentRowID, in view: UIView) -> CGRect? {
        hosted[id].map { $0.view.convert($0.view.bounds, to: view) }
    }

    func visibleRowAnchors() -> [(id: CalendarAdjacentRowID, screenY: CGFloat)] {
        guard let collectionView else { return [] }
        layoutIfNeeded()
        let top = collectionView.bounds.minY + collectionView.adjustedContentInset.top
        return stack.arrangedSubviews.compactMap { view in
            guard let item = hosted.first(where: { $0.value.view === view }) else { return nil }
            let frame = view.convert(view.bounds, to: collectionView)
            guard frame.maxY > top + 0.5 else { return nil }
            return (item.key, frame.minY - collectionView.bounds.minY)
        }
    }

    override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes)
        -> UICollectionViewLayoutAttributes {
        let attributes = layoutAttributes.copy() as! UICollectionViewLayoutAttributes
        let size = contentView.systemLayoutSizeFitting(
            CGSize(width: layoutAttributes.size.width, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel
        )
        attributes.size.height = max(1, size.height)
        return attributes
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        clear()
    }

    private var collectionView: UICollectionView? {
        var ancestor = superview
        while let view = ancestor {
            if let collection = view as? UICollectionView { return collection }
            ancestor = view.superview
        }
        return nil
    }

}

private extension CalendarAdjacentRowID {
    var isEvent: Bool {
        if case .event = kind { return true }
        return false
    }
}

private final class CalendarAdjacentCollectionView: UICollectionView {
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        super.gestureRecognizerShouldBegin(gestureRecognizer)
    }
}
