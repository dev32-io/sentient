import NetworkImage
import SwiftUI
import UIKit

typealias MessagePositionScheduler = (@escaping () -> Void) -> Void

struct KeyboardAnimationTiming: Equatable {
    let duration: TimeInterval
    let options: UIView.AnimationOptions

    static let fallback = KeyboardAnimationTiming(
        duration: Motion.normal,
        options: .curveEaseInOut
    )
}

func parsedKeyboardAnimationTiming(from notification: Notification) -> KeyboardAnimationTiming? {
    guard let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey]
            as? TimeInterval,
          let curve = notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey]
            as? Int else { return nil }
    return KeyboardAnimationTiming(
        duration: duration,
        options: UIView.AnimationOptions(rawValue: UInt(curve << 16))
    )
}

struct MessageCollectionView: UIViewRepresentable {
    let rows: [MessageLayoutRow]
    let messageCount: Int
    let userName: String
    let historyLoading: Bool
    let initialExistingHistory: Bool?
    let playbackEnabled: Bool
    let bottomOcclusion: CGFloat
    let environmentRevision: String
    let imageLoader: any NetworkImageLoader
    let positionScheduler: MessagePositionScheduler
    let onRetry: (String) -> Void
    let onMeasurementLoadingChange: (Bool) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            imageLoader: imageLoader,
            initialExistingHistory: initialExistingHistory,
            positionScheduler: positionScheduler
        )
    }

    func makeUIView(context: Context) -> MessageUICollectionView {
        let layout = ExactMessageLayout()
        let view = MessageUICollectionView(frame: .zero, collectionViewLayout: layout)
        view.backgroundColor = UIColor(DuskColors.bg)
        view.alwaysBounceVertical = true
        view.keyboardDismissMode = .interactive
        view.accessibilityIdentifier = "chat-message-list"
        view.register(MessageHostingCell.self, forCellWithReuseIdentifier: MessageHostingCell.reuseIdentifier)
        view.dataSource = context.coordinator
        view.delegate = context.coordinator
        view.onBoundsChange = { [weak coordinator = context.coordinator, weak view] in
            guard let coordinator, let view else { return }
            coordinator.receiveViewportChange(view)
        }
        view.onKeyboardOverlapChange = { [weak coordinator = context.coordinator, weak view] in
            guard let coordinator, let view else { return }
            coordinator.receiveKeyboardOverlapChange(view)
        }
        view.onStableLayout = { [weak coordinator = context.coordinator, weak view] in
            guard let coordinator, let view else { return }
            coordinator.receiveStableLayout(view)
        }
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.dismissKeyboard))
        tap.cancelsTouchesInView = false
        view.addGestureRecognizer(tap)
        context.coordinator.attach(view, layout: layout)
        return view
    }

    func updateUIView(_ view: MessageUICollectionView, context: Context) {
        context.coordinator.receive(
            rows: rows,
            messageCount: messageCount,
            userName: userName,
            historyLoading: historyLoading,
            playbackEnabled: playbackEnabled,
            bottomOcclusion: bottomOcclusion,
            reduceMotion: context.environment.accessibilityReduceMotion,
            environmentRevision: environmentRevision,
            onRetry: onRetry,
            onMeasurementLoadingChange: onMeasurementLoadingChange,
            in: view
        )
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegate {
        private weak var collectionView: MessageUICollectionView?
        private weak var layout: ExactMessageLayout?
        private let imageCache: MarkdownImageCache
        private let measurer: MessageRowMeasurer
        private let positionScheduler: MessagePositionScheduler
        private var rows: [MessageLayoutRow] = []
        private var displayedRows: [MessageLayoutRow] = []
        private var messageCount = 0
        private var userName = "You"
        private var playbackEnabled = true
        private var reduceMotion = false
        private var environmentRevision = ""
        private var onRetry: (String) -> Void = { _ in }
        private var onMeasurementLoadingChange: (Bool) -> Void = { _ in }
        private var heightCache: [String: CGFloat] = [:]
        private var pendingRenderedHeights: [String: (key: String, height: CGFloat)] = [:]
        private var heightUpdateScheduled = false
        private var generation = 0
        private var measurementTask: Task<Void, Never>?
        private var signature = ""
        private var publishedSizingContext = ""
        private var boundsSize = CGSize.zero
        private let initialExistingHistory: Bool?
        private var positionedHistory = false
        private var startedEmpty = false
        private var awaitingHistory = false
        private var pendingInitialHistoryPosition: Bool
        private var pendingSendIDsDuringHistory: [String] = []
        private var previousHistoryLoading = false
        private var positionGeneration = 0
        private var sendAnchorState = SendAnchorState()
        private var ownedSendID: String?
        private var ownedSendUsesContextOffset = false
        private var ownedSendPlacement: CGFloat = 0
        private var retainedTail: CGFloat = 0
        private var loading = false
        private var positioningAnimationActive = false
        private var positioningAnimationGeneration = 0
        private var pendingViewportPlacementRefresh = false

        init(
            imageLoader: any NetworkImageLoader,
            initialExistingHistory: Bool?,
            positionScheduler: @escaping MessagePositionScheduler
        ) {
            let imageCache = MarkdownImageCache(loader: imageLoader)
            self.imageCache = imageCache
            self.initialExistingHistory = initialExistingHistory
            self.positionScheduler = positionScheduler
            pendingInitialHistoryPosition = initialExistingHistory == true
            measurer = MessageRowMeasurer(imageCache: imageCache)
        }

        func attach(_ collectionView: MessageUICollectionView, layout: ExactMessageLayout) {
            self.collectionView = collectionView
            self.layout = layout
            measurer.onMeasure = { [weak collectionView] in collectionView?.measuredRowCount += 1 }
            measurer.attach(to: collectionView)
        }

        func receive(
            rows: [MessageLayoutRow],
            messageCount: Int,
            userName: String,
            historyLoading: Bool,
            playbackEnabled: Bool,
            bottomOcclusion: CGFloat,
            reduceMotion: Bool,
            environmentRevision: String,
            onRetry: @escaping (String) -> Void,
            onMeasurementLoadingChange: @escaping (Bool) -> Void,
            in collectionView: MessageUICollectionView
        ) {
            self.rows = rows
            self.messageCount = messageCount
            self.userName = userName
            self.playbackEnabled = playbackEnabled
            self.reduceMotion = reduceMotion
            self.environmentRevision = environmentRevision
            self.onRetry = onRetry
            self.onMeasurementLoadingChange = onMeasurementLoadingChange
            collectionView.setBottomOcclusion(bottomOcclusion)
            let historyFinished = previousHistoryLoading && !historyLoading
            if historyLoading && !previousHistoryLoading { resetForHistoryReload(in: collectionView) }
            previousHistoryLoading = historyLoading
            awaitingHistory = awaitingHistory || historyLoading
            if rows.isEmpty, !historyLoading, !positionedHistory { startedEmpty = true }
            updateAvatarPlayback()

            if boundsSize == .zero { boundsSize = collectionView.bounds.size }
            let nextSignature = measurementSignature(in: collectionView)
            let changed = nextSignature != signature
            signature = nextSignature
            if changed || needsMeasurement(rows, in: collectionView) {
                measureAndPublish(in: collectionView)
            } else if historyFinished || displayedRows.map(\.revision) != rows.map(\.revision) {
                publish(
                    rows,
                    in: collectionView,
                    initialHistory: awaitingHistory,
                    canPosition: !historyLoading
                )
            }
        }

        private func resetForHistoryReload(in collectionView: UICollectionView) {
            generation += 1
            positionGeneration += 1
            measurementTask?.cancel()
            measurementTask = nil
            pendingRenderedHeights.removeAll()
            setLoading(false)
            positionedHistory = false
            startedEmpty = false
            awaitingHistory = true
            pendingInitialHistoryPosition = true
            pendingSendIDsDuringHistory = []
            sendAnchorState = SendAnchorState()
            ownedSendID = nil
            ownedSendUsesContextOffset = false
            ownedSendPlacement = 0
            pendingViewportPlacementRefresh = false
            cancelPositioningAnimation(in: collectionView)
            retainedTail = 0
            layout?.tailHeight = 0
            collectionView.collectionViewLayout.invalidateLayout()
        }

        func receiveViewportChange(_ collectionView: MessageUICollectionView) {
            guard collectionView.bounds.width > 0, collectionView.bounds.size != boundsSize else { return }
            let previousSize = boundsSize
            let widthChanged = collectionView.bounds.width != previousSize.width
            let heightChanged = collectionView.bounds.height != previousSize.height
            boundsSize = collectionView.bounds.size

            if heightChanged {
                refreshOwnedSendPlacement(in: collectionView)
                refreshTail(in: collectionView)
            }
            guard widthChanged else {
                guard !positioningAnimationActive,
                      !collectionView.isDragging, !collectionView.isDecelerating else { return }
                if !alignOwnedSendIfNeeded(in: collectionView) {
                    setOffset(collectionView.contentOffset.y, in: collectionView)
                }
                return
            }
            pendingViewportPlacementRefresh = true
            if positioningAnimationActive {
                positionGeneration += 1
                cancelPositioningAnimation(in: collectionView)
            }
            let next = measurementSignature(in: collectionView)
            if next != signature {
                signature = next
                measureAndPublish(in: collectionView)
            }
        }

        func receiveKeyboardOverlapChange(_ collectionView: MessageUICollectionView) {
            // Keyboard is occlusion, not viewport geometry. Keep current offset and
            // captured send placement; only update tail needed for reachable content.
            refreshTail(in: collectionView)
        }

        func receiveStableLayout(_ collectionView: MessageUICollectionView) {
            guard pendingViewportPlacementRefresh else { return }
            pendingViewportPlacementRefresh = false
            refreshTail(in: collectionView)
            if !positioningAnimationActive,
               !collectionView.isDragging, !collectionView.isDecelerating {
                _ = alignOwnedSendIfNeeded(in: collectionView)
            }
        }

        private func needsMeasurement(_ rows: [MessageLayoutRow], in view: UICollectionView) -> Bool {
            rows.contains { heightCache[cacheKey(for: $0, in: view)] == nil }
        }

        /// A mounted row can lay out its next revision using its current bounds.
        /// This bootstrap is never cached as an exact measurement. Unseen rows and
        /// changed layout environments still require exact sizing before publication.
        private func displayHeight(for row: MessageLayoutRow, in view: UICollectionView) -> CGFloat? {
            if let height = heightCache[cacheKey(for: row, in: view)] { return height }
            guard !previousHistoryLoading, !pendingInitialHistoryPosition,
                  publishedSizingContext == sizingContext(in: view),
                  let index = displayedRows.firstIndex(where: { $0.id == row.id }),
                  view.indexPathsForVisibleItems.contains(IndexPath(item: index, section: 0)),
                  let cell = view.cellForItem(at: IndexPath(item: index, section: 0)) as? MessageHostingCell,
                  cell.configurationKey == configurationKey(for: displayedRows[index], in: view),
                  let layout, layout.rowHeights.indices.contains(index) else { return nil }
            return layout.rowHeights[index]
        }

        private func measureAndPublish(in collectionView: MessageUICollectionView) {
            guard collectionView.bounds.width > 0 else { return }
            generation += 1
            let currentGeneration = generation
            measurementTask?.cancel()
            let pending = rows.filter { displayHeight(for: $0, in: collectionView) == nil }
            guard !pending.isEmpty else {
                publish(
                    rows,
                    in: collectionView,
                    initialHistory: awaitingHistory,
                    canPosition: !previousHistoryLoading
                )
                return
            }
            if displayedRows.isEmpty { setLoading(true) }
            let expectedRows = rows.map(\.revision)
            measurementTask = Task { @MainActor [weak self, weak collectionView] in
                guard let self, let collectionView else { return }
                for (index, row) in pending.enumerated() {
                    guard !Task.isCancelled, currentGeneration == generation,
                          signature == measurementSignature(in: collectionView) else { return }
                    let height = measurer.measure(
                        row: row,
                        messageCount: messageCount,
                        paneWidth: collectionView.bounds.width,
                        userName: userName
                    )
                    heightCache[cacheKey(for: row, in: collectionView)] = height
                    if index.isMultiple(of: 8) { await Task.yield() }
                }
                guard !Task.isCancelled, currentGeneration == generation,
                      rows.map(\.revision) == expectedRows else { return }
                publish(
                    rows,
                    in: collectionView,
                    initialHistory: awaitingHistory,
                    canPosition: !previousHistoryLoading
                )
            }
        }

        private func publish(
            _ nextRows: [MessageLayoutRow],
            in collectionView: MessageUICollectionView,
            initialHistory: Bool,
            canPosition: Bool
        ) {
            // Recheck visibility after asynchronous history measurement: a row that
            // left the viewport must not publish a bootstrap as unseen exact geometry.
            let nextHeights = nextRows.compactMap { displayHeight(for: $0, in: collectionView) }
            guard nextHeights.count == nextRows.count else {
                measureAndPublish(in: collectionView)
                return
            }
            let anchor = visibleAnchor(in: collectionView)
            let previousIDs = displayedRows.map(\.id)
            let previousIDSet = Set(previousIDs)
            let insertedIDs = Set(nextRows.map(\.id)).subtracting(previousIDSet)
            let identities = sendIdentities(in: nextRows)
            let pendingRowIdentities = nextRows.compactMap { row -> String? in
                if case .pending = row.row { return row.id }
                return nil
            }
            if pendingInitialHistoryPosition {
                for identity in pendingRowIdentities where !pendingSendIDsDuringHistory.contains(identity) {
                    pendingSendIDsDuringHistory.append(identity)
                }
            }
            let firstContent = !positionedHistory && !nextRows.isEmpty
            let containsPending = !pendingRowIdentities.isEmpty
            if firstContent, initialExistingHistory == nil,
               initialHistory || !startedEmpty && !containsPending {
                pendingInitialHistoryPosition = true
            }
            let (nextState, reducedNewSend) = reduceSendAnchor(sendAnchorState, identities: identities)
            let explicitNewSend = identities.last {
                pendingSendIDsDuringHistory.contains($0) && !sendAnchorState.observed.contains($0)
            }
            let newSend = pendingInitialHistoryPosition ? explicitNewSend : reducedNewSend
            let shouldPositionHistory = canPosition && firstContent
                && pendingInitialHistoryPosition && newSend == nil
            displayedRows = nextRows
            publishedSizingContext = sizingContext(in: collectionView)
            let liveKeys = Set(nextRows.map { cacheKey(for: $0, in: collectionView) })
            heightCache = heightCache.filter { liveKeys.contains($0.key) }
            if canPosition, !shouldPositionHistory {
                sendAnchorState = nextState
            }
            if let newSend, canPosition, !shouldPositionHistory {
                pendingInitialHistoryPosition = false
                pendingSendIDsDuringHistory = []
                awaitingHistory = false
                ownedSendID = newSend
                if let index = nextRows.firstIndex(where: { $0.id == newSend }) {
                    ownedSendUsesContextOffset = nextRows[..<index].contains { row in
                        switch row.row {
                        case .message, .pending: true
                        case .divider: false
                        }
                    }
                } else {
                    ownedSendUsesContextOffset = false
                }
                refreshOwnedSendPlacement(in: collectionView)
                positionedHistory = true
            }

            let rowGeometryChanged = layout?.rowHeights != nextHeights
                || layout?.rowFrames.first?.width != collectionView.bounds.width
            if rowGeometryChanged {
                layout?.update(
                    rowHeights: nextHeights,
                    width: collectionView.bounds.width,
                    scale: collectionView.traitCollection.displayScale
                )
            }
            let viewportGeometryChanged = pendingViewportPlacementRefresh
            if viewportGeometryChanged {
                refreshOwnedSendPlacement(in: collectionView)
            }
            retainedTail = tailHeight(in: collectionView)
            if ownedSendID == nil, retainedTail > 0,
               !collectionView.isDragging, !collectionView.isDecelerating {
                retainedTail = min(retainedTail, requiredRetainedTail(in: collectionView))
            }
            let tailChanged = layout?.tailHeight != retainedTail
            layout?.tailHeight = retainedTail
            let structureChanged = previousIDs != nextRows.map(\.id)
            if structureChanged { collectionView.reloadData() }
            else { updateAvatarPlayback(refreshContent: true) }
            if structureChanged || rowGeometryChanged || tailChanged {
                collectionView.collectionViewLayout.invalidateLayout()
                collectionView.layoutIfNeeded()
            }

            positionGeneration += 1
            let currentPositionGeneration = positionGeneration
            let publishedRevisions = nextRows.map(\.revision)
            let position = { [weak self, weak collectionView] in
                guard let self, let collectionView,
                      positionGeneration == currentPositionGeneration,
                      displayedRows.map(\.revision) == publishedRevisions else { return }
                if shouldPositionHistory {
                    scrollToBottom(collectionView)
                    pendingInitialHistoryPosition = false
                    pendingSendIDsDuringHistory = []
                    positionedHistory = true
                    awaitingHistory = false
                    sendAnchorState = SendAnchorState(observed: Set(identities))
                } else if let newSend,
                          let index = displayedRows.firstIndex(where: { $0.id == newSend }) {
                    scrollToOwnedSend(index, animated: !reduceMotion, in: collectionView)
                } else if !positioningAnimationActive,
                          !collectionView.isDragging && !collectionView.isDecelerating,
                          !alignOwnedSendIfNeeded(in: collectionView) {
                    restore(anchor, in: collectionView)
                }
                if !insertedIDs.isEmpty && !reduceMotion && !shouldPositionHistory && !(firstContent && newSend == nil) {
                    collectionView.layoutIfNeeded()
                    animateInsertedRows(insertedIDs, in: collectionView)
                }
                updateAvatarPlayback()
                if viewportGeometryChanged {
                    collectionView.requestStableLayoutCallback()
                }
            }
            // UICollectionView applies its own content-size offset adjustment after
            // reload/layout. Position once on the next main turn, fenced to this
            // published geometry; this is not a retry loop.
            positionScheduler(position)
            setLoading(false)
        }

        private func tailHeight(in collectionView: UICollectionView) -> CGFloat {
            guard let ownedSendID,
                  let index = displayedRows.firstIndex(where: { $0.id == ownedSendID }),
                  let layout,
                  index < layout.rowFrames.count else { return retainedTail }
            let usable = collectionView.bounds.height
                - collectionView.adjustedContentInset.top
                - collectionView.adjustedContentInset.bottom
            let extent = layout.contentHeightWithoutTail - layout.rowFrames[index].minY
            return max(0, usable - sendPlacement(in: collectionView) - extent)
        }

        private func sendIdentities(in rows: [MessageLayoutRow]) -> [String] {
            rows.compactMap { row in row.id.hasPrefix("send-") ? row.id : nil }
        }

        private func visibleAnchor(in collectionView: UICollectionView) -> (id: String, delta: CGFloat)? {
            let top = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
            guard let layout,
                  let index = layout.rowFrames.firstIndex(where: { $0.maxY >= top }),
                  displayedRows.indices.contains(index) else { return nil }
            return (displayedRows[index].id, layout.rowFrames[index].minY - top)
        }

        private func restore(_ anchor: (id: String, delta: CGFloat)?, in collectionView: UICollectionView) {
            guard let anchor,
                  let index = displayedRows.firstIndex(where: { $0.id == anchor.id }),
                  let frame = layout?.rowFrames[index] else { return }
            setOffset(frame.minY - anchor.delta - collectionView.adjustedContentInset.top, in: collectionView)
        }

        private func scrollToOwnedSend(
            _ index: Int,
            animated: Bool,
            in collectionView: UICollectionView
        ) {
            guard let frame = layout?.rowFrames[index] else { return }
            let target = clampedOffset(
                frame.minY - collectionView.adjustedContentInset.top
                    - sendPlacement(in: collectionView),
                in: collectionView
            )
            guard animated else {
                collectionView.setContentOffset(CGPoint(x: 0, y: target), animated: false)
                return
            }
            positioningAnimationGeneration += 1
            let animationGeneration = positioningAnimationGeneration
            positioningAnimationActive = true
            let timing = (collectionView as? MessageUICollectionView)?.keyboardAnimationTiming
                ?? .fallback
            UIView.animate(
                withDuration: timing.duration,
                delay: 0,
                options: timing.options.union(
                    UIView.AnimationOptions([.beginFromCurrentState, .allowUserInteraction])
                )
            ) {
                collectionView.contentOffset = CGPoint(x: 0, y: target)
            } completion: { [weak self, weak collectionView] _ in
                guard let self, let collectionView = collectionView as? MessageUICollectionView,
                      animationGeneration == self.positioningAnimationGeneration else { return }
                collectionView.positioningAnimationCompletionCount += 1
                self.positioningAnimationActive = false
                if !collectionView.isDragging && !collectionView.isDecelerating {
                    _ = self.alignOwnedSendIfNeeded(in: collectionView)
                }
            }
        }

        private func cancelPositioningAnimation(in collectionView: UICollectionView) {
            guard positioningAnimationActive else { return }
            positioningAnimationGeneration += 1
            positioningAnimationActive = false
            collectionView.layer.removeAllAnimations()
        }

        private func sendPlacement(in collectionView: UICollectionView) -> CGFloat {
            ownedSendUsesContextOffset ? ownedSendPlacement : 0
        }

        private func refreshOwnedSendPlacement(in collectionView: UICollectionView) {
            guard ownedSendUsesContextOffset else {
                ownedSendPlacement = 0
                return
            }
            let usable = collectionView.bounds.height
                - collectionView.adjustedContentInset.top
                - collectionView.adjustedContentInset.bottom
            ownedSendPlacement = max(0, usable) * 0.20
        }

        private func refreshTail(in collectionView: UICollectionView) {
            retainedTail = tailHeight(in: collectionView)
            if ownedSendID == nil, retainedTail > 0,
               !collectionView.isDragging, !collectionView.isDecelerating {
                retainedTail = min(retainedTail, requiredRetainedTail(in: collectionView))
            }
            layout?.tailHeight = retainedTail
            collectionView.collectionViewLayout.invalidateLayout()
            collectionView.layoutIfNeeded()
        }

        @discardableResult
        private func alignOwnedSendIfNeeded(in collectionView: UICollectionView) -> Bool {
            guard let ownedSendID,
                  let index = displayedRows.firstIndex(where: { $0.id == ownedSendID }),
                  let frame = layout?.rowFrames[index] else { return false }
            let target = frame.minY - collectionView.adjustedContentInset.top
                - sendPlacement(in: collectionView)
            let scale = max(collectionView.traitCollection.displayScale, 1)
            guard abs(collectionView.contentOffset.y - target) > 1 / scale else { return true }
            setOffset(target, in: collectionView)
            return true
        }

        private func scrollToBottom(_ collectionView: UICollectionView) {
            let y = max(
                -collectionView.adjustedContentInset.top,
                collectionView.contentSize.height - collectionView.bounds.height
                    + collectionView.adjustedContentInset.bottom
            )
            collectionView.setContentOffset(CGPoint(x: 0, y: y), animated: false)
        }

        private func setOffset(_ proposed: CGFloat, in collectionView: UICollectionView) {
            collectionView.setContentOffset(
                CGPoint(x: 0, y: clampedOffset(proposed, in: collectionView)), animated: false
            )
        }

        private func clampedOffset(_ proposed: CGFloat, in collectionView: UICollectionView) -> CGFloat {
            let minimum = -collectionView.adjustedContentInset.top
            let publishedHeight = layout?.collectionViewContentSize.height
                ?? collectionView.contentSize.height
            let maximum = max(
                minimum,
                publishedHeight - collectionView.bounds.height
                    + collectionView.adjustedContentInset.bottom
            )
            return min(maximum, max(minimum, proposed))
        }

        private func animateInsertedRows(_ ids: Set<String>, in collectionView: UICollectionView) {
            guard !ids.isEmpty else { return }
            for cell in collectionView.visibleCells {
                guard let index = collectionView.indexPath(for: cell)?.item,
                      displayedRows.indices.contains(index), ids.contains(displayedRows[index].id) else { continue }
                if case .divider = displayedRows[index].row { continue }
                (collectionView as? MessageUICollectionView)?.entranceAnimationCount += 1
                cell.alpha = 0
                cell.transform = CGAffineTransform(translationX: 0, y: 8)
                UIView.animate(
                    withDuration: Motion.fast,
                    delay: 0,
                    options: [.beginFromCurrentState, .allowUserInteraction, .curveEaseOut]
                ) {
                    cell.alpha = 1
                    cell.transform = .identity
                }
            }
        }

        private func sizingContext(in view: UICollectionView) -> String {
            "\(measurementSignature(in: view))|\(userName)"
        }

        private func cacheKey(for row: MessageLayoutRow, in view: UICollectionView) -> String {
            "\(sizingContext(in: view))|\(row.id)|\(row.measurementRevision)"
        }

        private func configurationKey(for row: MessageLayoutRow, in view: UICollectionView) -> String {
            // Total is part of the row's accessibility chronology, not its height.
            "\(sizingContext(in: view))|\(row.id)|\(row.revision)|\(messageCount)"
        }

        private func measurementSignature(in view: UICollectionView) -> String {
            let traits = view.traitCollection
            return [
                String(format: "%.3f", view.bounds.width),
                traits.preferredContentSizeCategory.rawValue,
                String(format: "%.3f", traits.displayScale),
                view.effectiveUserInterfaceLayoutDirection == .rightToLeft ? "rtl" : "ltr",
                Locale.current.identifier,
                environmentRevision,
            ].joined(separator: "|")
        }

        private func setLoading(_ value: Bool) {
            guard loading != value else { return }
            loading = value
            DispatchQueue.main.async { [onMeasurementLoadingChange] in
                onMeasurementLoadingChange(value)
            }
        }

        func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
            displayedRows.count
        }

        func collectionView(
            _ collectionView: UICollectionView,
            cellForItemAt indexPath: IndexPath
        ) -> UICollectionViewCell {
            let cell = collectionView.dequeueReusableCell(
                withReuseIdentifier: MessageHostingCell.reuseIdentifier, for: indexPath
            ) as! MessageHostingCell
            configure(cell, at: indexPath.item)
            return cell
        }

        func collectionView(
            _ collectionView: UICollectionView,
            didEndDisplaying cell: UICollectionViewCell,
            forItemAt indexPath: IndexPath
        ) {
            guard let cell = cell as? MessageHostingCell,
                  let key = cell.measurementKey, heightCache[key] == nil else { return }
            // A rapid drag can recycle a revised cell before its geometry report.
            // Finish exact sizing if it is still unseen after queued reports apply.
            DispatchQueue.main.async { [weak self, weak collectionView] in
                guard let self, let view = collectionView as? MessageUICollectionView,
                      self.needsMeasurement(self.rows, in: view) else { return }
                self.measureAndPublish(in: view)
            }
        }

        private func configure(_ cell: MessageHostingCell, at index: Int) {
            guard displayedRows.indices.contains(index), let collectionView else { return }
            let row = displayedRows[index]
            let key = cacheKey(for: row, in: collectionView)
            let playback = avatarPlaybackEnabled(for: index, in: collectionView)
            cell.accessibilityIdentifier = row.accessibilityIdentifier
            cell.set(rootView: AnyView(MessageRowLayout(
                row: row.row,
                messageCount: messageCount,
                paneWidth: collectionView.bounds.width,
                userName: userName,
                avatarMode: row.avatarMode,
                avatarPlaybackEnabled: playback,
                measurement: false,
                imageCache: imageCache,
                onRetry: { [weak self] id in self?.onRetry(id) },
                heightRevision: key,
                onHeightChange: { [weak self] height in
                    self?.renderedHeightDidChange(height, rowID: row.id, key: key)
                }
            )), avatarPlaybackEnabled: playback,
                configurationKey: configurationKey(for: row, in: collectionView), measurementKey: key)
        }

        private func renderedHeightDidChange(_ height: CGFloat, rowID: String, key: String) {
            guard height.isFinite, height > 0, let collectionView,
                  let row = displayedRows.first(where: { $0.id == rowID }),
                  cacheKey(for: row, in: collectionView) == key else { return }
            pendingRenderedHeights[rowID] = (key, height)
            guard !heightUpdateScheduled else { return }
            heightUpdateScheduled = true
            // Geometry callbacks run during SwiftUI layout. Apply their latest values
            // together next main turn, rather than recursively forcing layout per row.
            DispatchQueue.main.async { [weak self] in self?.applyRenderedHeights() }
        }

        private func applyRenderedHeights() {
            heightUpdateScheduled = false
            let pending = pendingRenderedHeights
            pendingRenderedHeights.removeAll()
            guard let collectionView, let layout else { return }
            let scale = max(collectionView.traitCollection.displayScale, 1)
            var heights = layout.rowHeights
            var changed = false
            for (index, row) in displayedRows.enumerated() {
                guard heights.indices.contains(index), let report = pending[row.id],
                      report.key == cacheKey(for: row, in: collectionView) else { continue }
                // Even an equal-height revision needs an exact cache entry before
                // recycling; the previous revision's height was only a bootstrap.
                heightCache[report.key] = report.height
                if abs(heights[index] - report.height) > 1 / scale {
                    heights[index] = report.height
                    changed = true
                }
            }
            guard changed else { return }
            let anchor = visibleAnchor(in: collectionView)
            layout.update(rowHeights: heights, width: collectionView.bounds.width, scale: scale)
            refreshTail(in: collectionView)
            if !positioningAnimationActive,
               !collectionView.isDragging && !collectionView.isDecelerating,
               !alignOwnedSendIfNeeded(in: collectionView) {
                restore(anchor, in: collectionView)
            }
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            guard !displayedRows.isEmpty else { return }
            positionGeneration += 1
            if let collectionView { cancelPositioningAnimation(in: collectionView) }
            pendingInitialHistoryPosition = false
            pendingSendIDsDuringHistory = []
            awaitingHistory = false
            positionedHistory = true
            sendAnchorState.observed.formUnion(sendIdentities(in: displayedRows))
            ownedSendID = nil
            ownedSendUsesContextOffset = false
            ownedSendPlacement = 0
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) { updateAvatarPlayback() }
        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
            retireTailAtRest(in: scrollView)
            updateAvatarPlayback()
        }
        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate: Bool) {
            if !willDecelerate { retireTailAtRest(in: scrollView) }
            updateAvatarPlayback()
        }

        private func requiredRetainedTail(in scrollView: UIScrollView) -> CGFloat {
            guard let layout else { return 0 }
            return max(
                0,
                scrollView.contentOffset.y + scrollView.bounds.height
                    - scrollView.adjustedContentInset.bottom
                    - layout.contentHeightWithoutTail
            )
        }

        private func retireTailAtRest(in scrollView: UIScrollView) {
            guard ownedSendID == nil, !scrollView.isDragging, !scrollView.isDecelerating else { return }
            let required = requiredRetainedTail(in: scrollView)
            guard required < retainedTail else { return }
            retainedTail = required
            layout?.tailHeight = required
            layout?.invalidateLayout()
            scrollView.layoutIfNeeded()
        }

        private func updateAvatarPlayback(refreshContent: Bool = false) {
            guard let collectionView else { return }
            for case let cell as MessageHostingCell in collectionView.visibleCells {
                guard let index = collectionView.indexPath(for: cell)?.item else { continue }
                // Content publication must refresh rows; scrolling only changes eligibility.
                guard displayedRows.indices.contains(index) else { continue }
                let contentChanged = refreshContent
                    && cell.configurationKey != configurationKey(for: displayedRows[index], in: collectionView)
                guard contentChanged || cell.avatarPlaybackEnabled != avatarPlaybackEnabled(for: index, in: collectionView) else { continue }
                configure(cell, at: index)
            }
        }

        private func avatarPlaybackEnabled(for index: Int, in collectionView: UICollectionView) -> Bool {
            guard playbackEnabled, displayedRows.indices.contains(index),
                  displayedRows[index].avatarMode != .idle,
                  let frame = layout?.rowFrames[index] else { return false }
            let avatarFrame = CGRect(
                x: frame.minX + Space.lg,
                y: frame.minY,
                width: BubbleLayout.avatarSize,
                height: BubbleLayout.avatarSize
            )
            let visible = CGRect(
                x: collectionView.contentOffset.x,
                y: collectionView.contentOffset.y + collectionView.adjustedContentInset.top,
                width: collectionView.bounds.width,
                height: collectionView.bounds.height - collectionView.adjustedContentInset.top
                    - collectionView.adjustedContentInset.bottom
            )
            return avatarFrame.intersects(visible)
        }

        @objc func dismissKeyboard() {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
            )
        }
    }
}

final class MessageUICollectionView: UICollectionView {
    var onBoundsChange: (() -> Void)?
    var onKeyboardOverlapChange: (() -> Void)?
    var onStableLayout: (() -> Void)?
    var measuredRowCount = 0
    var entranceAnimationCount = 0
    var positioningAnimationCompletionCount = 0
    private(set) var keyboardAnimationTiming = KeyboardAnimationTiming.fallback
    private(set) var keyboardOverlap: CGFloat = 0
    private var bottomOcclusion: CGFloat = 0
    private var keyboardEndFrameInScreen = CGRect.null
    private var previousSize = CGSize.zero
    private var stableLayoutCallbackRequested = false

    override init(frame: CGRect, collectionViewLayout layout: UICollectionViewLayout) {
        super.init(frame: frame, collectionViewLayout: layout)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(receiveKeyboardAnimation(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func receiveKeyboardAnimation(_ notification: Notification) {
        if let timing = parsedKeyboardAnimationTiming(from: notification) {
            keyboardAnimationTiming = timing
        }
        if let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
            keyboardEndFrameInScreen = frame
            refreshKeyboardOverlap()
        }
    }

    func setBottomOcclusion(_ value: CGFloat) {
        bottomOcclusion = max(0, value)
        applyBottomInset()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        refreshKeyboardOverlap()
        if bounds.size != previousSize {
            previousSize = bounds.size
            onBoundsChange?()
        }
        if stableLayoutCallbackRequested {
            stableLayoutCallbackRequested = false
            DispatchQueue.main.async { [weak self] in self?.onStableLayout?() }
        }
    }

    func requestStableLayoutCallback() {
        stableLayoutCallbackRequested = true
        setNeedsLayout()
    }

    private func refreshKeyboardOverlap() {
        let frame = convert(keyboardEndFrameInScreen, from: nil)
        let overlap = bounds.intersection(frame).height
        guard abs(keyboardOverlap - overlap) > 0.5 else { return }
        keyboardOverlap = overlap
        applyBottomInset()
        onKeyboardOverlapChange?()
    }

    private func applyBottomInset() {
        // Subtract only safe-area clearance UIScrollView actually adds. SwiftUI may
        // already place this view inside safe area even when safeAreaInsets is nonzero.
        let automaticBottom = max(0, adjustedContentInset.bottom - contentInset.bottom)
        let bottom = bottomOcclusion + max(0, keyboardOverlap - automaticBottom)
        guard abs(contentInset.bottom - bottom) > 0.5 else { return }
        let offset = contentOffset
        contentInset.bottom = bottom
        verticalScrollIndicatorInsets.bottom = bottom
        contentOffset = offset
    }
}

final class ExactMessageLayout: UICollectionViewLayout {
    var rowHeights: [CGFloat] = []
    var tailHeight: CGFloat = 0
    private(set) var rowFrames: [CGRect] = []
    private(set) var contentHeightWithoutTail: CGFloat = 0

    override func prepare() {
        guard let collectionView else { return }
        update(
            rowHeights: rowHeights,
            width: collectionView.bounds.width,
            scale: collectionView.traitCollection.displayScale
        )
    }

    func update(rowHeights: [CGFloat], width: CGFloat, scale: CGFloat) {
        self.rowHeights = rowHeights
        let scale = max(scale, 1)
        func snapped(_ value: CGFloat) -> CGFloat { (value * scale).rounded() / scale }
        var y = snapped(Space.lg)
        rowFrames = rowHeights.map { height in
            let bottom = snapped(y + height)
            let frame = CGRect(x: 0, y: y, width: width, height: bottom - y)
            y = snapped(bottom + Space.gapMsg)
            return frame
        }
        if !rowFrames.isEmpty { y = snapped(y - Space.gapMsg) }
        contentHeightWithoutTail = snapped(y + Space.lg)
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: collectionView?.bounds.width ?? 0, height: contentHeightWithoutTail + tailHeight)
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        rowFrames.indices.compactMap { index in
            guard rowFrames[index].intersects(rect) else { return nil }
            return attributes(at: index)
        }
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard rowFrames.indices.contains(indexPath.item) else { return nil }
        return attributes(at: indexPath.item)
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.width != collectionView?.bounds.width
    }

    private func attributes(at index: Int) -> UICollectionViewLayoutAttributes {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
        attributes.frame = rowFrames[index]
        return attributes
    }
}

final class MessageHostingCell: UICollectionViewCell {
    static let reuseIdentifier = "message-host"
    private let host = UIHostingController(rootView: AnyView(EmptyView()))
    private(set) var avatarPlaybackEnabled = false
    private(set) var configurationCount = 0
    private(set) var configurationKey: String?
    private(set) var measurementKey: String?

    override init(frame: CGRect) {
        super.init(frame: frame)
        host.safeAreaRegions = []
        host.view.backgroundColor = .clear
        contentView.addSubview(host.view)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        host.view.frame = contentView.bounds
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        accessibilityIdentifier = nil
        alpha = 1
        transform = .identity
        avatarPlaybackEnabled = false
        configurationKey = nil
        measurementKey = nil
        host.rootView = AnyView(EmptyView())
    }

    func set(rootView: AnyView, avatarPlaybackEnabled: Bool, configurationKey: String, measurementKey: String) {
        self.configurationKey = configurationKey
        self.measurementKey = measurementKey
        self.avatarPlaybackEnabled = avatarPlaybackEnabled
        configurationCount += 1
        // SwiftUI otherwise centers a taller intrinsic row in the old cell bounds
        // until its height report resizes the cell, producing a half-growth jump.
        host.rootView = AnyView(rootView.frame(minHeight: 0, maxHeight: .infinity, alignment: .top))
        host.view.frame = contentView.bounds
    }
}

@MainActor
private final class MessageRowMeasurer {
    private let host = UIHostingController(rootView: AnyView(EmptyView()))
    private let imageCache: MarkdownImageCache
    var onMeasure: () -> Void = {}

    init(imageCache: MarkdownImageCache) {
        self.imageCache = imageCache
        host.safeAreaRegions = []
        host.view.alpha = 0.001
        host.view.isUserInteractionEnabled = false
    }

    func attach(to view: UIView) { view.addSubview(host.view) }

    func measure(
        row: MessageLayoutRow,
        messageCount: Int,
        paneWidth: CGFloat,
        userName: String
    ) -> CGFloat {
        onMeasure()
        host.rootView = AnyView(MessageRowLayout(
            row: row.row,
            messageCount: messageCount,
            paneWidth: paneWidth,
            userName: userName,
            avatarMode: row.avatarMode,
            avatarPlaybackEnabled: false,
            measurement: true,
            imageCache: imageCache,
            onRetry: { _ in }
        ))
        host.view.frame = CGRect(x: -10_000, y: 0, width: paneWidth, height: 1)
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        let proposal = CGSize(width: paneWidth, height: .greatestFiniteMagnitude)
        let first = host.sizeThatFits(in: proposal)
        host.view.bounds.size = CGSize(width: paneWidth, height: first.height)
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        return host.sizeThatFits(in: proposal).height
    }
}
