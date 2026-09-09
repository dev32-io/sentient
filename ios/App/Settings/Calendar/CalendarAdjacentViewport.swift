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

/// One vertical UIKit owner for both adjacent modes. Its item identifiers are
/// agenda rows, not whole periods, so headings, statuses, overviews, and event
/// buttons participate in normal collection recycling independently.
@MainActor
final class CalendarAdjacentViewController: UIViewController, UICollectionViewDelegate {
    private let layout: UICollectionViewCompositionalLayout = {
        // Native layout owns the available width in the same transaction as
        // bounds changes; hosting measures only the content-dependent height.
        let size = NSCollectionLayoutSize(
            widthDimension: .fractionalWidth(1),
            heightDimension: .estimated(CalendarSurfaceLayout.agendaRowHeight)
        )
        let item = NSCollectionLayoutItem(layoutSize: size)
        let group = NSCollectionLayoutGroup.vertical(layoutSize: size, subitems: [item])
        let section = NSCollectionLayoutSection(group: group)
        section.interGroupSpacing = Space.sm
        section.contentInsets = .zero
        let configuration = UICollectionViewCompositionalLayoutConfiguration()
        configuration.scrollDirection = .vertical
        // Scaffold constrains the outer viewport; rows add their own visual
        // padding. Do not inset the column again as cells cross safe-area edges.
        configuration.contentInsetsReference = .none
        return UICollectionViewCompositionalLayout(section: section, configuration: configuration)
    }()
    private var collection: CalendarAdjacentCollectionView!
    private var focusVisibility: CalendarViewportFocusVisibility?
    private var bottomOcclusion: CGFloat = 0
    private var source: UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>!
    private let cells = NSHashTable<CalendarAdjacentCell>.weakObjects()
    private var input: CalendarAdjacentViewport?
    private var generation: String?
    private var rightToLeft = false
    private var lastSize = CGSize.zero
    private var lastRequest: CalendarAdjacentViewportRequest?
    private var lastBrowse: CalendarAdjacentPageID?
    private var semanticAnchor: CalendarViewportDate?
    private var lastTodayRevision: Int?
    private var lastOpenerFocus: CalendarOverlayOrigin?
    private var lastLeadingPeriod: CalendarAdjacentPageID?
    private var protectedPeriod: CalendarAdjacentPageID?
    private var protectedEventKey: String?
    private var applyingSnapshot = false
    private var pendingSnapshot = false
    private var snapshotWaiters: [CheckedContinuation<Void, Never>] = []
    private var pendingAnchor: CalendarAdjacentAnchor?
    private var pendingPosition: CalendarAdjacentPageID?
    private var pendingClampedBrowse: CalendarAdjacentPageID?
    private var positioning = false
    private var positionReady = false
    private var snapshotEpoch = 0
    private var expansionMarker: CalendarAdjacentExpansionMarker?
    // Latest desired content/authority may advance while UIKit is applying.
    private var rowMap: [CalendarAdjacentRowID: CalendarAdjacentRow] = [:]
    private var desiredRevision: Int?
    private var civilDays: [CalendarAdjacentPageID: [CalendarCivilDay]] = [:]
    private var eventPresentationReady = true
    private var arrivingEvents: Set<CalendarAdjacentRowID> = []
    // Only new empty rows wait for alignment; retained current empty cards
    // stay exposed. This set lasts one transaction chain, never a visit history.
    private var unalignedEmptyRows: Set<CalendarAdjacentRowID> = []
    // Cell configuration belongs to the submitted snapshot, not desired rows.
    // Native index paths require a coherent submitted table outside apply.
    private var rendering: CalendarAdjacentRendering?
    private var committedRowIDs: [CalendarAdjacentRowID] = []

    private var layoutSizeAvailable: Bool {
        isViewLoaded && collection.bounds.width > 0 && collection.bounds.height > 0
    }

    private(set) var current: CalendarAdjacentPageID?
    /// Chronological working periods, retained for native/controller tests and
    /// diagnostics. This is bounded and is never a history of visited periods.
    private(set) var identities: [CalendarAdjacentPageID] = []
    /// Latest desired rows; not an index table for an in-flight native layout.
    private(set) var rowIdentities: [CalendarAdjacentRowID] = []

    override func loadView() {
        collection = CalendarAdjacentCollectionView(frame: .zero, collectionViewLayout: layout)
        collection.alwaysBounceVertical = true
        collection.showsVerticalScrollIndicator = false
        collection.showsHorizontalScrollIndicator = false
        collection.contentInsetAdjustmentBehavior = .never
        // UIHostingConfiguration publishes intrinsic changes for content/traits.
        collection.selfSizingInvalidation = .enabled
        focusVisibility = CalendarViewportFocusVisibility(scrollView: collection)
        collection.keyboardDismissMode = .interactive
        collection.backgroundColor = UIColor(DuskColors.bg)
        collection.delegate = self
        collection.onDidLayout = { [weak self] in self?.presentOriginCivilIfAligned() }
        collection.register(CalendarAdjacentCell.self, forCellWithReuseIdentifier: "agenda-row")
        view = collection

        source = UICollectionViewDiffableDataSource<Int, CalendarAdjacentRowID>(collectionView: collection) {
            [weak self] collection, indexPath, id in
            guard let self,
                  let cell = collection.dequeueReusableCell(
                    withReuseIdentifier: "agenda-row", for: indexPath
                  ) as? CalendarAdjacentCell else { return nil }
            self.cells.add(cell)
            self.bind(cell, id: id)
            return cell
        }
    }

    func update(_ input: CalendarAdjacentViewport, rightToLeft: Bool,
                bottomOcclusion: CGFloat = 0, todayRevision: Int = 0) {
        loadViewIfNeeded()
        let explicitToday = lastTodayRevision != nil && lastTodayRevision != todayRevision
        lastTodayRevision = todayRevision
        let occlusionChanged = self.bottomOcclusion != bottomOcclusion
        self.bottomOcclusion = bottomOcclusion
        focusVisibility?.bottomOcclusion = bottomOcclusion
        collection.verticalScrollIndicatorInsets.bottom = bottomOcclusion
        guard input.data.isActive else {
            clear()
            return
        }

        let structuralChange = generation != input.data.generation ||
            current?.view != input.current.view || identities.isEmpty
        let directionChanged = self.rightToLeft != rightToLeft
        let semanticAnchorUnchanged = semanticAnchor == input.data.semanticAnchor
        let openerFocus = input.openerFocus.wrappedValue
        self.input = input
        self.semanticAnchor = input.data.semanticAnchor
        self.rightToLeft = rightToLeft

        if occlusionChanged, layoutSizeAvailable, !applyingSnapshot, !pendingSnapshot, !positioning {
            // Overlay geometry can change without a data diff or a capturable
            // row (for example while bouncing in terminal alignment space).
            // Only touch committed native geometry. An in-flight apply uses
            // the latest occlusion in its existing completion/restore path.
            positioning = true
            updateTrailingInset()
            positioning = false
        }

        if structuralChange {
            reset(for: input)
        } else {
            accessibilityFocusDidChange(openerFocus)
            let isEcho = input.current == lastBrowse
            let isCursorClearBeforeExplicitNavigation =
                semanticAnchorUnchanged && input.current.anchor == input.data.semanticAnchor &&
                lastBrowse != nil && input.current != current
            let requestedCurrent = input.current.clampedToAdjacentViewportDomain
            let shouldPublishClampedCurrent: Bool
            if let requestedCurrent {
                shouldPublishClampedCurrent = requestedCurrent != input.current &&
                    requestedCurrent == current && lastBrowse != requestedCurrent
            } else {
                shouldPublishClampedCurrent = false
            }
            if shouldPublishClampedCurrent, let requestedCurrent {
                pendingClampedBrowse = requestedCurrent
                rebuildRows(preserveAnchor: true, positionCurrent: false)
            } else if explicitToday || (input.current != current && !isEcho && !isCursorClearBeforeExplicitNavigation) {
                // A changed shared cursor is an explicit native command. A
                // cursor just echoed from onBrowse is deliberately not a
                // recenter request. Clearing the local cursor before a shared
                // Previous/Today/Next publication is also not a command.
                // The explicit Today revision is the exception: it must align
                // even if both shared anchor and current period stay equal.
                guard let requestedCurrent else {
                    rebuildRows(preserveAnchor: true, positionCurrent: false)
                    return
                }
                if requestedCurrent != input.current {
                    pendingClampedBrowse = requestedCurrent
                } else if pendingClampedBrowse != requestedCurrent {
                    pendingClampedBrowse = nil
                }
                guard requestedCurrent != current || explicitToday else {
                    rebuildRows(preserveAnchor: true, positionCurrent: false)
                    return
                }
                current = requestedCurrent
                lastBrowse = nil
                expansionMarker = nil
                identities = CalendarAdjacentPeriodWindow.starting(at: requestedCurrent)
                rebuildRows(preserveAnchor: false, positionCurrent: true)
            } else {
                rebuildRows(preserveAnchor: true, positionCurrent: false, force: directionChanged)
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // UIKit owns both old and new layout tables during apply. Do not
        // invalidate them or resolve controller-owned indices in that phase.
        guard !applyingSnapshot, !positioning else { return }
        if pendingSnapshot {
            applyPendingSnapshotIfPossible()
            return
        }
        guard layoutSizeAvailable else { return }
        if collection.bounds.size != lastSize, pendingPosition == nil {
            pendingAnchor = pendingAnchor ?? captureAnchor()
            if pendingAnchor == nil {
                // A captured anchor's restore performs this preparation itself.
                // Only the no-row/bounce case needs a separate geometry pass.
                positioning = true
                prepareNativeLayout()
                updateTrailingInset()
                positioning = false
            }
        }
        completePendingLayoutIfPossible()
    }

    /// Clear every allocated/reuse configuration and callback capture. Lease release is
    /// owned by the route VM; teardown never sends a request that could cancel a
    /// successor component's lease.
    func clear() {
        snapshotEpoch &+= 1
        input = nil
        current = nil
        generation = nil
        identities = []
        rowIdentities = []
        rowMap = [:]
        rendering = nil
        committedRowIDs = []
        desiredRevision = nil
        civilDays.removeAll()
        arrivingEvents.removeAll()
        unalignedEmptyRows.removeAll()
        lastBrowse = nil
        semanticAnchor = nil
        lastOpenerFocus = nil
        lastLeadingPeriod = nil
        protectedPeriod = nil
        protectedEventKey = nil
        lastRequest = nil
        expansionMarker = nil
        pendingPosition = nil
        pendingClampedBrowse = nil
        positionReady = false
        cells.allObjects.forEach { $0.clear() }

        guard isViewLoaded else { return }
        setPresentationReady(false)
        pendingSnapshot = true
        pendingAnchor = nil
        collection.isScrollEnabled = false
        applyPendingSnapshotIfPossible()
    }

    private func reset(for input: CalendarAdjacentViewport) {
        snapshotEpoch &+= 1
        generation = input.data.generation
        current = input.current.clampedToAdjacentViewportDomain
        lastBrowse = nil
        semanticAnchor = input.data.semanticAnchor
        lastOpenerFocus = input.openerFocus.wrappedValue
        lastLeadingPeriod = current
        protectedPeriod = nil
        protectedEventKey = nil
        pendingClampedBrowse = current.flatMap { $0 != input.current ? $0 : nil }
        lastRequest = nil
        expansionMarker = nil
        desiredRevision = nil
        civilDays.removeAll()
        arrivingEvents.removeAll()
        unalignedEmptyRows.removeAll()
        rendering = nil
        committedRowIDs = []
        pendingAnchor = nil
        pendingPosition = nil
        positionReady = false
        identities = current.map { CalendarAdjacentPeriodWindow.starting(at: $0) } ?? []
        cells.allObjects.forEach { $0.clear() }
        rebuildRows(preserveAnchor: false, positionCurrent: true)
        collection.isScrollEnabled = current != nil && positionReady
    }

    private func rebuildRows(
        preserveAnchor: Bool,
        positionCurrent: Bool,
        force: Bool = false
    ) {
        guard let input else { return }
        let periodsChanged = Set(civilDays.keys) != Set(identities)
        let changed = force || input.data.revision != desiredRevision || periodsChanged
        // Browse/geometry/callback echoes need neither projection flattening,
        // host replacement nor self-sizing/anchor work.
        if !changed && !positionCurrent {
            completePendingLayoutIfPossible()
            return
        }
        let anchor = preserveAnchor && pendingPosition == nil ? (pendingAnchor ?? captureAnchor()) : nil
        if changed {
            let previousPeriods = Set(civilDays.keys)
            civilDays = civilDays.filter { identities.contains($0.key) }
            for period in identities where civilDays[period] == nil {
                civilDays[period] = CalendarCivilDay.days(for: period, locale: input.locale)
            }
            let nextRows = identities.flatMap {
                CalendarAdjacentRow.rows(for: $0, data: input.data.pages[$0], locale: input.locale,
                                         civil: civilDays[$0], selectedDate: input.data.selectedDate,
                                         todayDate: input.data.todayDate)
            }
            // Availability belongs to successive desired inputs, not UIKit's
            // table. A known period merely entering the working set is settled;
            // only new event identities in an already represented period arrive.
            if positionReady, !positionCurrent, input.data.revision != desiredRevision {
                arrivingEvents.formUnion(nextRows.compactMap { row -> CalendarAdjacentRowID? in
                    guard case .event = row.id.kind,
                          previousPeriods.contains(row.period), rowMap[row.id] == nil else { return nil }
                    return row.id
                })
            }
            rowIdentities = nextRows.map(\.id)
            arrivingEvents.formIntersection(Set(rowIdentities))
            rowMap = Dictionary(uniqueKeysWithValues: nextRows.map { ($0.id, $0) })
            // A successor can wait behind an older submitted snapshot. Its
            // authority must nevertheless reach every event-derived surface now.
            if !positionCurrent { cells.allObjects.forEach(updateEventPresentation) }
        }
        if positionCurrent, let current {
            pendingPosition = current
            pendingAnchor = nil
            positionReady = false
            if changed {
                // Retire outgoing hosts immediately, including an older flight.
                // Surviving IDs must bind again in the new origin-based table.
                if rendering != nil { cells.allObjects.forEach { $0.clear() } }
                rendering = nil
            }
        } else if pendingPosition == nil {
            pendingAnchor = anchor
        }
        guard changed else {
            completePendingLayoutIfPossible()
            return
        }
        desiredRevision = input.data.revision
        pendingSnapshot = true
        applyPendingSnapshotIfPossible()
    }

    private func applyPendingSnapshotIfPossible() {
        guard pendingSnapshot, !applyingSnapshot, isViewLoaded else { return }
        applyingSnapshot = true
        // Synchronous UIKit application/layout may adjust the native offset.
        // Those writes are geometry, not movement during the deferred flight.
        let wasPositioning = positioning
        positioning = true
        defer { positioning = wasPositioning }
        let previousRendering = rendering
        let existing = Set(source.snapshot().itemIdentifiers)
        let reconfigure = rowIdentities.filter { id in
            guard existing.contains(id), let next = rowMap[id] else { return false }
            guard let old = previousRendering?.rows[id] else { return true }
            if previousRendering?.rightToLeft != rightToLeft { return true }
            if case .event = id.kind, previousRendering?.input.data.revision != input?.data.revision { return true }
            return !next.matchesPresentation(old)
        }
        let topologyChanged = source.snapshot().itemIdentifiers != rowIdentities
        unalignedEmptyRows.formUnion(rowIdentities.filter { $0.kind == .empty && !existing.contains($0) })
        unalignedEmptyRows.formIntersection(Set(rowIdentities))
        if pendingAnchor != nil && (topologyChanged || !reconfigure.isEmpty) {
            // Never hide dates for data publication. Only event/empty rows can
            // otherwise flash at the preceding table's numeric offset.
            setEventPresentationReady(false)
        }
        // Prepare the previous, coherent native snapshot before UIKit begins
        // its batch update (never from layout.prepare).
        prepareNativeLayout()
        if pendingPosition != nil {
            // Every explicit destination owns item zero, with no leading inset
            // or header. Establish that native origin against the coherent old
            // table BEFORE apply. No item lookup, fitted-prefix seek or inline
            // completion positioning is required to present incoming dates.
            collection.isScrollEnabled = false
            collection.setContentOffset(.zero, animated: false)
            setEventPresentationReady(false)
            // Do not close a civil plane already proven at this same origin
            // when another data revision queues behind initial positioning.
            setPresentationReady(originCivilIsAligned)
        }
        pendingSnapshot = false
        let epoch = snapshotEpoch
        rendering = input.map {
            CalendarAdjacentRendering(epoch: epoch, input: $0, rightToLeft: rightToLeft, rows: rowMap)
        }
        // Prepared offscreen cells can survive without another provider call.
        // Renew equal presentations at this submitted authority boundary too;
        // updating their observable value leaves native hosting installed.
        for cell in cells.allObjects {
            guard let id = cell.rowID, let page = cell.page,
                  rowMap[id]?.matchesPresentation(page.row) == true else { continue }
            bind(cell, id: id)
        }

        var snapshot = NSDiffableDataSourceSnapshot<Int, CalendarAdjacentRowID>()
        snapshot.appendSections([0])
        snapshot.appendItems(rowIdentities)
        if !reconfigure.isEmpty {
            snapshot.reconfigureItems(reconfigure)
        }

        source.apply(snapshot, animatingDifferences: false) { [weak self] in
            // UIKit can invoke this inline while its apply queue is still
            // occupied. Actor isolation alone does not unwind that queue.
            // Keep the gate closed until a fresh main-queue turn; neither
            // layout callbacks nor a successor snapshot may reenter apply.
            DispatchQueue.main.async { [weak self] in
                self?.didApplySnapshot(epoch: epoch)
            }
        }
        // After apply RETURNS, its public native table can already contain the
        // insertion even though completion is still pending. Verify that table
        // before fitting/restoring it; callback timing is not table readiness.
        // A mismatched table keeps the original deferred restoration path.
        guard snapshotEpoch == epoch, !collection.isLayingOut,
              pendingPosition == nil, let anchor = pendingAnchor else { return }
        let submittedIDs = snapshot.itemIdentifiers
        guard source.snapshot().itemIdentifiers == submittedIDs,
              collection.numberOfSections == 1,
              collection.numberOfItems(inSection: 0) == submittedIDs.count else { return }
        committedRowIDs = submittedIDs
        _ = restore(anchor)
        // Keep both the apply gate and the original movement-aware anchor.
        // Deferred completion must recheck actual geometry, or carry this same
        // anchor into the latest queued successor; early restore is not drain.
    }

    private func didApplySnapshot(epoch: Int) {
        if snapshotEpoch == epoch {
            committedRowIDs = source.snapshot().itemIdentifiers
            if !pendingSnapshot {
                if let target = pendingPosition {
                    _ = positionCurrent(target)
                } else if let anchor = pendingAnchor {
                    if restore(anchor) != .deferred { pendingAnchor = nil }
                } else {
                    prepareNativeLayout()
                    updateTrailingInset()
                }
            }
        }
        // Keep layout/scroll delegates fenced through positioning as well.
        // A stale completion releases only the apply gate, never successor
        // positioning or publication. Pending rows contain only the latest update.
        applyingSnapshot = false
        if pendingSnapshot {
            applyPendingSnapshotIfPossible()
        } else if snapshotEpoch == epoch {
            finishStableUpdate()
        }
        guard !applyingSnapshot, !pendingSnapshot else { return }
        let waiters = snapshotWaiters
        snapshotWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    /// Observe the owner's drain without submitting a competing UIKit snapshot.
    /// This covers native application, not positioning awaiting a usable size.
    func waitForPendingSnapshots() async {
        guard applyingSnapshot || pendingSnapshot else { return }
        await withCheckedContinuation { snapshotWaiters.append($0) }
    }

    private func bind(_ cell: CalendarAdjacentCell, id: CalendarAdjacentRowID) {
        guard input?.data.isActive == true,
              let rendering, rendering.epoch == snapshotEpoch,
              rendering.input.data.generation == generation,
              let submittedRow = rendering.rows[id], let currentRow = rowMap[id] else {
            cell.clear()
            return
        }
        // UIKit may materialize an old submitted identity while a successor
        // waits. Civil content uses current data before it enters a new host.
        let row = currentCivilPresentation(submittedRow, current: currentRow)
        switch row.content {
        case .event, .empty:
            // An older submitted table may ask for a now-revoked presentation.
            // Do not install it, even temporarily, in a native content view.
            guard currentRow.matchesPresentation(row) else {
                cell.clear()
                return
            }
        default: break
        }
        let callbackEpoch = rendering.epoch
        let callbackGeneration = rendering.input.data.generation
        let callbackRevision = rendering.input.data.revision
        let page = CalendarAdjacentPage(
            row: row,
            locale: rendering.input.locale,
            rightToLeft: rendering.rightToLeft,
            openerFocus: rendering.input.openerFocus,
            onEvent: { [weak self] event in
                self?.performAction(for: id, epoch: callbackEpoch, generation: callbackGeneration, revision: callbackRevision) {
                    self?.protectedPeriod = id.period
                    self?.protectedEventKey = event.actionIdentity.stableKey
                    self?.input?.onEvent(event)
                }
            },
            onSelectDate: { [weak self] date in
                self?.performAction(for: id, epoch: callbackEpoch, generation: callbackGeneration, revision: nil) {
                    self?.input?.onSelectDate(id.period.anchor, date)
                }
            },
            onRetry: { [weak self] in
                self?.performAction(for: id, epoch: callbackEpoch, generation: callbackGeneration, revision: nil) {
                    self?.input?.onRetry()
                }
            }
        )
        cell.bind(id: id, page: page)
        updateEventPresentation(cell)
    }

    /// Consume an observed focus transition from the SwiftUI adapter. A request
    /// to focus a missing/offscreen AX element is not itself a focus observation.
    func accessibilityFocusDidChange(_ focus: CalendarOverlayOrigin?) {
        guard input?.data.isActive == true, lastOpenerFocus != focus else { return }
        lastOpenerFocus = focus
        guard let protectedEventKey, let focus,
              case .event(let focusKey) = focus,
              focusKey == protectedEventKey else { return }
        protectedPeriod = nil
        self.protectedEventKey = nil
        publishRequest()
    }

    private func performAction(
        for id: CalendarAdjacentRowID,
        epoch: Int,
        generation: String,
        revision: Int?,
        action: () -> Void
    ) {
        guard snapshotEpoch == epoch,
              self.generation == generation,
              input?.data.isActive == true,
              (revision == nil || input?.data.revision == revision),
              rowMap[id] != nil else { return }
        action()
    }

    func collectionView(
        _ collectionView: UICollectionView,
        shouldUpdateFocusIn context: UICollectionViewFocusUpdateContext
    ) -> Bool {
        true
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === collection else { return }
        if var anchor = pendingAnchor {
            // Observe native movement even while publication/apply is fenced.
            // Always advance the sample, but exclude fitting, inset changes and
            // our own compensation/explicit positioning from displacement.
            if !collection.isLayingOut, !positioning {
                anchor.displacement += scrollView.contentOffset.y - anchor.observedY
            }
            anchor.observedY = scrollView.contentOffset.y
            pendingAnchor = anchor
        }
        guard !collection.isLayingOut,
              !applyingSnapshot, !pendingSnapshot, !positioning,
              positionReady, pendingPosition == nil, pendingAnchor == nil, input != nil else { return }
        publishLeadingPeriod()
        guard !applyingSnapshot, !pendingSnapshot, positionReady,
              pendingAnchor == nil, input != nil else { return }
        expandIfNeeded()
        // A bounded prefetch can decline growth while the reader still moves.
        // Renew visible-first authority without requiring a snapshot to do it.
        if !applyingSnapshot, !pendingSnapshot, pendingAnchor == nil,
           lastRequest?.periods.first != current?.anchor {
            publishRequest()
        }
    }

    private func completePendingLayoutIfPossible() {
        guard layoutSizeAvailable, !applyingSnapshot, !pendingSnapshot, !positioning else { return }
        if let target = pendingPosition {
            guard positionCurrent(target) else { return }
            finishStableUpdate()
        } else if let anchor = pendingAnchor {
            guard restore(anchor) != .deferred else { return }
            pendingAnchor = nil
            finishStableUpdate()
        }
    }

    private func finishStableUpdate() {
        guard input?.data.isActive == true,
              layoutSizeAvailable,
              !applyingSnapshot,
              !pendingSnapshot,
              pendingPosition == nil,
              pendingAnchor == nil,
              positionReady else { return }
        setPresentationReady(true)
        setEventPresentationReady(true)
        collection.isScrollEnabled = true
        // Animate current arrivals once at the aligned native boundary, not
        // on reuse or every refresh. Offscreen arrivals are consumed too.
        for cell in collection.visibleCells.compactMap({ $0 as? CalendarAdjacentCell }) {
            if let id = cell.rowID, arrivingEvents.contains(id) { cell.revealEventArrival() }
        }
        arrivingEvents.removeAll()
        unalignedEmptyRows.removeAll()
        let epoch = snapshotEpoch
        _ = publishPendingClampedBrowse()
        guard snapshotEpoch == epoch,
              input?.data.isActive == true,
              !applyingSnapshot,
              !pendingSnapshot,
              pendingPosition == nil,
              pendingAnchor == nil else { return }
        // Native scrolling/sizing callbacks were fenced through the transaction.
        // Reconcile the actual settled owner before publishing its lease. A
        // removed anchor or changed geometry can expose a different period.
        publishLeadingPeriod()
        guard snapshotEpoch == epoch,
              input?.data.isActive == true,
              !applyingSnapshot,
              !pendingSnapshot,
              pendingPosition == nil,
              pendingAnchor == nil else { return }
        publishRequest()
    }

    private func setEventPresentationReady(_ ready: Bool) {
        eventPresentationReady = ready
        cells.allObjects.forEach(updateEventPresentation)
    }

    private func currentCivilPresentation(
        _ row: CalendarAdjacentRow, current: CalendarAdjacentRow
    ) -> CalendarAdjacentRow {
        switch row.content {
        case .weekOverview, .dayHeading, .status:
            return current
        case .event, .empty:
            return row // Event callbacks still belong to the submitted revision.
        }
    }

    private func updateEventPresentation(_ cell: CalendarAdjacentCell) {
        guard let id = cell.rowID, let hosted = cell.page?.row else { return }
        guard let currentRow = rowMap[id] else {
            cell.clear()
            return
        }
        if case .event = id.kind, !currentRow.matchesPresentation(hosted) {
            cell.clear()
            return
        }
        let current = currentCivilPresentation(hosted, current: currentRow)
        if !hosted.matchesPresentation(current) {
            // Same native/SwiftUI owner and civil IDs. Replace only current
            // content/roles, not the collection snapshot or its layout tables.
            cell.updateCivilPresentation(current)
        }
        let ready: Bool
        switch id.kind {
        case .event:
            let matches = rowMap[id]?.matchesPresentation(hosted) == true
            ready = matches && pendingPosition == nil && (eventPresentationReady || !arrivingEvents.contains(id))
        case .empty:
            ready = rowMap[id]?.matchesPresentation(hosted) == true && pendingPosition == nil &&
                (eventPresentationReady || !unalignedEmptyRows.contains(id))
        case .status:
            ready = rowMap[id] != nil
        case .weekOverview, .dayHeading:
            ready = true
        }
        cell.setEventPresentationReady(ready)
    }

    private var originCivilIsAligned: Bool {
        guard layoutSizeAvailable,
              input?.data.isActive == true, let target = pendingPosition,
              rendering?.epoch == snapshotEpoch,
              let first = rowIdentities.first, first.period == target,
              collection.contentOffset == .zero else { return false }
        // Read only native cells AFTER their layout, never controller index
        // paths or a layout cache during apply. The requested civil owner
        // must actually occupy the origin before its plane can be exposed.
        return collection.visibleCells.contains { cell in
            guard let cell = cell as? CalendarAdjacentCell else { return false }
            return cell.rowID == first && cell.contentConfiguration != nil && cell.frame.minY == 0 && cell.bounds.height > 0
        }
    }

    private func presentOriginCivilIfAligned() {
        guard collection.alpha == 0, originCivilIsAligned else { return }
        setPresentationReady(true)
    }

    private func setPresentationReady(_ ready: Bool) {
        // Keep native layout alive behind the fence so self-sizing and anchor
        // restoration can finish. No animation, delayed reveal, or old pixels.
        let alpha: CGFloat = ready ? 1 : 0
        guard collection.alpha != alpha || collection.accessibilityElementsHidden == ready else { return }
        UIView.performWithoutAnimation {
            collection.alpha = alpha
            collection.accessibilityElementsHidden = !ready
        }
    }

    override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
        super.didUpdateFocus(in: context, with: coordinator)
        if let focused = context.nextFocusedView { focusVisibility?.revealFocusedView(focused) }
    }

    private func publishPendingClampedBrowse() -> Bool {
        guard let clamped = pendingClampedBrowse,
              let input,
              input.data.isActive,
              current == clamped else { return false }
        pendingClampedBrowse = nil
        lastLeadingPeriod = clamped
        lastBrowse = clamped
        input.onBrowse(clamped.anchor)
        return true
    }

    private func publishLeadingPeriod() {
        guard positionReady, pendingPosition == nil,
              let leading = leadingPeriod(), leading != lastLeadingPeriod else { return }
        lastLeadingPeriod = leading
        current = leading
        guard let input, input.data.isActive, lastBrowse != leading else { return }
        lastBrowse = leading
        input.onBrowse(leading.anchor)
    }

    private func leadingPeriod() -> CalendarAdjacentPageID? {
        captureAnchor()?.id.period
    }

    private func expandIfNeeded() {
        guard !identities.isEmpty, collection.bounds.height > 0 else { return }
        let top = collection.contentOffset.y + collection.adjustedContentInset.top
        let bottom = collection.contentOffset.y + collection.bounds.height
        let threshold = max(collection.bounds.height * 0.75, 240)
        let nearTop = top <= threshold
        // Fill the next window before the viewport enters its terminal
        // alignment space, not after scrolling through that space.
        let nearBottom = collection.contentSize.height - bottom <= threshold
        if nearTop && nearBottom {
            // Short tables can be inside both prefetch bands, even while
            // bouncing past the bottom. Choose the nearest real scroll edge,
            // including terminal/footer insets; never fall back to the opposite
            // edge merely because this edge has reached the civil domain end.
            let minimum = -collection.adjustedContentInset.top
            let maximum = max(minimum, collection.contentSize.height - collection.bounds.height +
                              collection.adjustedContentInset.bottom)
            let y = collection.contentOffset.y
            // With no scroll extent, settling a bottom bounce at the common
            // origin is not a request for earlier periods. A negative pull is.
            guard maximum != minimum || y != minimum else { return }
            _ = roll(y - minimum <= maximum - y ? .top : .bottom)
            return
        }
        if nearTop, roll(.top) { return }
        if nearBottom { _ = roll(.bottom) }
    }

    private func roll(_ edge: CalendarAdjacentExpansionEdge) -> Bool {
        guard let boundary = edge == .top ? identities.first : identities.last else { return false }
        let marker = CalendarAdjacentExpansionMarker(edge: edge, boundary: boundary)
        guard expansionMarker != marker else { return false }

        let candidates: [CalendarAdjacentPageID]
        switch edge {
        case .top:
            candidates = CalendarAdjacentPeriodWindow.before(boundary, count: CalendarAdjacentPeriodWindow.expansionCount)
        case .bottom:
            candidates = CalendarAdjacentPeriodWindow.after(boundary, count: CalendarAdjacentPeriodWindow.expansionCount)
        }
        guard !candidates.isEmpty else {
            expansionMarker = marker
            return false
        }

        // Capture against the coherent OLD native table, before choosing what
        // may leave it. Pixel prefetch proximity does not imply that four whole
        // periods are behind the reader (especially with compact unknown days).
        guard let anchor = captureAnchor(),
              let owner = identities.firstIndex(of: anchor.id.period) else { return false }
        let spare = CalendarAdjacentPeriodWindow.maximumPeriods - identities.count
        let removable: Int
        switch edge {
        case .bottom:
            // Everything at/after the content-bearing leading period survives.
            removable = owner
        case .top:
            let top = collection.contentOffset.y + collection.adjustedContentInset.top
            let usable = CGRect(x: 0, y: top + 0.5, width: collection.bounds.width,
                                height: max(0, collection.bounds.maxY - bottomOcclusion - top - 0.5))
            let trailingVisible = collection.visibleCells.compactMap { cell -> Int? in
                guard let id = (cell as? CalendarAdjacentCell)?.rowID else { return nil }
                let padding: CGFloat
                switch id.kind {
                // Civil-only overscan can fill the entire finite window. The
                // leading civil owner is protected by `owner`; protecting every
                // later heading would prevent backward progress on compact days.
                case .dayHeading: return nil
                case .status: padding = Space.xs
                default: padding = 0
                }
                guard cell.frame.insetBy(dx: 0, dy: padding).intersects(usable) else { return nil }
                return identities.firstIndex(of: id.period)
            }.max() ?? owner
            var protectedEnd = max(owner, trailingVisible)
            // Prefer retaining visible cards/controls as well as the anchor.
            // If they span all 15 periods, only an actual backward pull may turn
            // over one far trailing period; never sacrifice the anchored owner.
            // Prefetch alone remains a no-op until content safely advances.
            if spare == 0, owner == 0, protectedEnd == identities.count - 1, top < 0 {
                protectedEnd -= 1
            }
            removable = identities.count - protectedEnd - 1
        }
        let count = min(candidates.count, spare + removable)
        guard count > 0 else { return false } // Not a domain boundary; retry on later movement.
        pendingAnchor = anchor
        switch edge {
        case .top:
            // Nearest predecessors, not a prefix that would punch a date gap.
            identities = trimAfter(Array(candidates.suffix(count)) + identities)
        case .bottom:
            identities = trimBefore(identities + Array(candidates.prefix(count)))
        }
        expansionMarker = nil
        rebuildRows(preserveAnchor: true, positionCurrent: false)
        return true
    }

    // Protection never changes rendered ordering: the working set is always a
    // contiguous prefix/suffix, while a focused period lives only in authority.
    private func trimAfter(_ values: [CalendarAdjacentPageID]) -> [CalendarAdjacentPageID] {
        Array(values.prefix(CalendarAdjacentPeriodWindow.maximumPeriods))
    }

    private func trimBefore(_ values: [CalendarAdjacentPageID]) -> [CalendarAdjacentPageID] {
        Array(values.suffix(CalendarAdjacentPeriodWindow.maximumPeriods))
    }

    private func publishRequest() {
        guard let input, let current, current.isAdjacentViewportEligible else { return }
        var ordered = [current]
        for period in identities where period != current && period.isAdjacentViewportEligible {
            guard ordered.count < CalendarAdjacentPeriodWindow.maximumPeriods + 1 else { break }
            ordered.append(period)
        }
        if let protectedPeriod,
           protectedPeriod.isAdjacentViewportEligible,
           !ordered.contains(protectedPeriod) {
            if ordered.count < CalendarAdjacentPeriodWindow.maximumPeriods + 1 {
                ordered.append(protectedPeriod)
            } else if let replacement = ordered.indices.last {
                ordered[replacement] = protectedPeriod
            }
        }
        let next = CalendarAdjacentViewportRequest(view: current.view, periods: ordered.map(\.anchor))
        guard next != lastRequest else { return }
        lastRequest = next
        input.onRequest(next)
    }

    private func positionCurrent(_ target: CalendarAdjacentPageID) -> Bool {
        guard layoutSizeAvailable, committedRowIDs.first?.period == target else { return false }
        let wasPositioning = positioning
        positioning = true
        defer { positioning = wasPositioning }
        // Item zero's top is independent of all event heights. UIKit has now
        // committed its table; only normal visible-row fitting/insets remain.
        // Repeat Today uses this same origin without any snapshot if unchanged.
        collection.setContentOffset(.zero, animated: false)
        prepareNativeLayout()
        updateTrailingInset()
        current = target
        pendingPosition = nil
        positionReady = true
        lastLeadingPeriod = target
        return true
    }

    private func captureAnchor() -> CalendarAdjacentAnchor? {
        guard isViewLoaded, !applyingSnapshot, !pendingSnapshot,
              !committedRowIDs.isEmpty, collection.bounds.height > 0 else { return nil }
        let wasPositioning = positioning
        positioning = true
        defer { positioning = wasPositioning }
        collection.layoutIfNeeded()
        let top = collection.contentOffset.y + collection.adjustedContentInset.top
        let rect = CGRect(x: 0, y: top + 0.5, width: collection.bounds.width, height: max(1, collection.bounds.height))
        let attributes = (collection.collectionViewLayout.layoutAttributesForElements(in: rect) ?? [])
            .sorted { lhs, rhs in lhs.frame.minY == rhs.frame.minY ? lhs.indexPath.item < rhs.indexPath.item : lhs.frame.minY < rhs.frame.minY }
        // Browse identity and restoration must use the same content-bearing
        // owner. Anchoring a clipped padding sliver of the preceding heading
        // leaves the visible Week strip unanchored when rows are refitted.
        for attribute in attributes {
            guard let id = source.itemIdentifier(for: attribute.indexPath) else { continue }
            let verticalPadding: CGFloat
            switch id.kind {
            case .dayHeading, .status:
                // Explicit outer padding in CalendarAdjacentPage, not a
                // guessed text height. Cards own their entire native surface.
                verticalPadding = Space.xs
            default:
                verticalPadding = 0
            }
            if attribute.frame.insetBy(dx: 0, dy: verticalPadding).intersects(rect) {
                // Preserve the real row origin, not the inset content origin.
                return CalendarAdjacentAnchor(id: id, offset: attribute.frame.minY - top,
                                              observedY: collection.contentOffset.y)
            }
        }
        return nil
    }

    private func restore(_ anchor: CalendarAdjacentAnchor) -> CalendarAdjacentAnchorResolution {
        guard layoutSizeAvailable else { return .deferred }
        let id = committedRowIDs.contains(anchor.id) ? anchor.id :
            committedRowIDs.first(where: { $0.period == anchor.id.period })
        guard let id else {
            // Callers have verified/committed the native table. No later fit can
            // resurrect an absent whole period. Prepare its current geometry,
            // without seeking a historical offscreen host or inventing an offset.
            let wasPositioning = positioning
            positioning = true
            defer { positioning = wasPositioning }
            prepareNativeLayout()
            updateTrailingInset()
            return .obsolete
        }
        // Preserve the native pan/deceleration across every queued successor.
        // Only the row's layout displacement is compensated; navigation/Today
        // uses positionCurrent and deliberately does not inherit this movement.
        return alignRow(id, offset: anchor.offset - anchor.displacement) ? .restored : .deferred
    }

    /// Called before apply, after its returned native table is verified, or
    /// from deferred completion; never from inline completion or layout hooks.
    private func prepareNativeLayout() {
        guard layoutSizeAvailable else { return }
        lastSize = collection.bounds.size
        collection.layoutIfNeeded()
    }

    private func updateTrailingInset() {
        var bottom = bottomOcclusion
        if layoutSizeAvailable,
           let last = committedRowIDs.last,
           let path = source.indexPath(for: last),
           let attributes = layout.layoutAttributesForItem(at: path) {
            // Ordinary scroll-view inset, derived only from committed layout.
            // No querying new item counts inside a layout cache callback.
            let trailingHeight = collection.contentSize.height - attributes.frame.minY
            bottom = max(bottomOcclusion, collection.bounds.height - collection.adjustedContentInset.top - trailingHeight)
        }
        if collection.contentInset.bottom != bottom {
            collection.contentInset.bottom = bottom
        }
    }

    private func alignRow(_ id: CalendarAdjacentRowID, offset: CGFloat) -> Bool {
        let wasPositioning = positioning
        positioning = true
        defer { positioning = wasPositioning }
        prepareNativeLayout()
        updateTrailingInset()
        guard let indexPath = source.indexPath(for: id) else { return false }
        if collection.cellForItem(at: indexPath) != nil,
           let attributes = layout.layoutAttributesForItem(at: indexPath),
           attributes.frame.minY - (collection.contentOffset.y + collection.adjustedContentInset.top) == offset {
            // Keep the captured transaction anchor even for revision-only
            // updates: a later pending successor may change heights. Once the
            // native table is committed, an actually aligned visible row needs
            // no offset write or second forced layout/inset pass.
            return true
        }
        if collection.cellForItem(at: indexPath) == nil {
            // Materialize the destination through UIKit before aligning it.
            // An offscreen layout attribute still has an estimated size.
            collection.scrollToItem(at: indexPath, at: .top, animated: false)
            collection.layoutIfNeeded()
        }
        updateTrailingInset()
        guard let attributes = layout.layoutAttributesForItem(at: indexPath) else { return false }
        setContentOffset(y: attributes.frame.minY - offset - collection.adjustedContentInset.top)
        collection.layoutIfNeeded()
        updateTrailingInset()
        return true
    }

    private func setContentOffset(y: CGFloat) {
        let minimum = -collection.adjustedContentInset.top
        let maximum = max(
            minimum,
            collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom
        )
        collection.setContentOffset(CGPoint(x: 0, y: min(max(y, minimum), maximum)), animated: false)
    }
}

private struct CalendarAdjacentRendering {
    let epoch: Int
    let input: CalendarAdjacentViewport
    let rightToLeft: Bool
    let rows: [CalendarAdjacentRowID: CalendarAdjacentRow]
}

private struct CalendarAdjacentAnchor {
    let id: CalendarAdjacentRowID
    let offset: CGFloat
    var observedY: CGFloat
    var displacement: CGFloat = 0
}

/// A missing committed identity is terminal; unavailable native geometry is
/// retryable. Only the existing stable completion clears the presentation gate.
private enum CalendarAdjacentAnchorResolution: Equatable {
    case restored
    case obsolete
    case deferred
}

private enum CalendarAdjacentExpansionEdge: Equatable {
    case top
    case bottom
}

private struct CalendarAdjacentExpansionMarker: Equatable {
    let edge: CalendarAdjacentExpansionEdge
    let boundary: CalendarAdjacentPageID
}

private final class CalendarAdjacentCollectionView: UICollectionView {
    private(set) var isLayingOut = false
    var onDidLayout: (() -> Void)?

    override func layoutSubviews() {
        let wasLayingOut = isLayingOut
        isLayingOut = true
        defer { isLayingOut = wasLayingOut }
        super.layoutSubviews()
        onDidLayout?()
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer {
            let velocity = panGestureRecognizer.velocity(in: self)
            guard abs(velocity.y) >= abs(velocity.x) else { return false }
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }
}

/// A cell-scoped observable value keeps the native configuration/content view
/// installed across presentation updates. In particular, renewing revision-bound
/// actions is a SwiftUI update, not host removal or a new sizing configuration.
/// It holds only this cell's current row, never a row/height history.
@MainActor
@Observable
final class CalendarAdjacentCellPresentation {
    var page: CalendarAdjacentPage?

    init(page: CalendarAdjacentPage) { self.page = page }
}

struct CalendarAdjacentCellContent: View {
    let presentation: CalendarAdjacentCellPresentation

    var body: some View {
        if let page = presentation.page { page }
    }
}

@MainActor
final class CalendarAdjacentCell: UICollectionViewCell {
    // A reusable row is content, not a screen safe-area owner. Otherwise
    // UIHostingConfiguration adds position-dependent container insets to its
    // measured height as the row scrolls past a window boundary. Top/side and
    // keyboard avoidance stay with the outer SwiftUI scaffold; the viewport
    // owns measured floating-bar/physical-bottom clearance and focus visibility.
    // This public override is cell-local, not a viewport/keyboard-region ignore.
    override var safeAreaInsets: UIEdgeInsets { .zero }

    private(set) var rowID: CalendarAdjacentRowID?
    private(set) var presentation: CalendarAdjacentCellPresentation?
    var page: CalendarAdjacentPage? { presentation?.page }

    func bind(id: CalendarAdjacentRowID, page: CalendarAdjacentPage) {
        if rowID != id { clear() }
        rowID = id
        contentView.layer.removeAnimation(forKey: "calendar-event-arrival")
        if let presentation {
            // Store the value, including its exact revision-capturing closures.
            // Never forward an externally retained old closure to new authority.
            presentation.page = page
        } else {
            let presentation = CalendarAdjacentCellPresentation(page: page)
            self.presentation = presentation
            let alpha = contentView.alpha
            contentConfiguration = UIHostingConfiguration {
                CalendarAdjacentCellContent(presentation: presentation)
            }
            .margins(.all, 0)
            .minSize(width: 0, height: 0)
            contentView.alpha = alpha
        }
        contentView.isUserInteractionEnabled = true
        contentView.accessibilityElementsHidden = false
    }

    func updateCivilPresentation(_ row: CalendarAdjacentRow) {
        guard var page else { return }
        page.row = row
        presentation?.page = page
    }

    func setEventPresentationReady(_ ready: Bool) {
        let isEventContent: Bool
        switch rowID?.kind {
        case .event, .empty, .status: isEventContent = true
        default: isEventContent = false
        }
        let visible = ready || !isEventContent
        if !visible { contentView.layer.removeAnimation(forKey: "calendar-event-arrival") }
        contentView.alpha = visible ? 1 : 0
        contentView.isUserInteractionEnabled = visible
        contentView.accessibilityElementsHidden = !visible
    }

    func revealEventArrival() {
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = 0
        animation.toValue = 1
        animation.duration = Motion.normal
        contentView.layer.add(animation, forKey: "calendar-event-arrival")
    }

    func clear() {
        contentView.layer.removeAnimation(forKey: "calendar-event-arrival")
        // Also retire the value in any configuration UIKit still holds while
        // removing/reusing this cell. Normal offscreen display does NOT clear it.
        presentation?.page = nil
        presentation = nil
        contentConfiguration = nil
        rowID = nil
        contentView.alpha = 0
        contentView.isUserInteractionEnabled = false
        contentView.accessibilityElementsHidden = true
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        clear()
    }
}
