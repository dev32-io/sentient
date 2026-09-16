import NetworkImage
import SwiftUI
import UIKit

typealias MessagePositionScheduler = (@escaping () -> Void) -> Void

struct MessageCollectionView: UIViewRepresentable {
    let rows: [MessageLayoutRow]
    let messageCount: Int
    let userName: String
    let historyLoading: Bool
    let initialExistingHistory: Bool?
    let playbackEnabled: Bool
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
            coordinator.receiveWidthChange(view)
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
        private var environmentRevision = ""
        private var onRetry: (String) -> Void = { _ in }
        private var onMeasurementLoadingChange: (Bool) -> Void = { _ in }
        private var heightCache: [String: CGFloat] = [:]
        private var generation = 0
        private var measurementTask: Task<Void, Never>?
        private var signature = ""
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
        private var retainedTail: CGFloat = 0
        private var loading = false

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
            environmentRevision: String,
            onRetry: @escaping (String) -> Void,
            onMeasurementLoadingChange: @escaping (Bool) -> Void,
            in collectionView: MessageUICollectionView
        ) {
            self.rows = rows
            self.messageCount = messageCount
            self.userName = userName
            self.playbackEnabled = playbackEnabled
            self.environmentRevision = environmentRevision
            self.onRetry = onRetry
            self.onMeasurementLoadingChange = onMeasurementLoadingChange
            let historyFinished = previousHistoryLoading && !historyLoading
            if historyLoading && !previousHistoryLoading { resetForHistoryReload(in: collectionView) }
            previousHistoryLoading = historyLoading
            awaitingHistory = awaitingHistory || historyLoading
            if rows.isEmpty, !historyLoading, !positionedHistory { startedEmpty = true }
            updateAvatarPlayback()

            boundsSize = collectionView.bounds.size
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
            setLoading(false)
            positionedHistory = false
            startedEmpty = false
            awaitingHistory = true
            pendingInitialHistoryPosition = true
            pendingSendIDsDuringHistory = []
            sendAnchorState = SendAnchorState()
            ownedSendID = nil
            retainedTail = 0
            layout?.tailHeight = 0
            collectionView.collectionViewLayout.invalidateLayout()
        }

        func receiveWidthChange(_ collectionView: MessageUICollectionView) {
            guard collectionView.bounds.width > 0, collectionView.bounds.size != boundsSize else { return }
            boundsSize = collectionView.bounds.size
            let next = measurementSignature(in: collectionView)
            if next != signature {
                signature = next
                measureAndPublish(in: collectionView)
            } else {
                retainedTail = tailHeight(in: collectionView)
                layout?.tailHeight = retainedTail
                collectionView.collectionViewLayout.invalidateLayout()
                collectionView.layoutIfNeeded()
                if !collectionView.isDragging && !collectionView.isDecelerating {
                    _ = alignOwnedSendIfNeeded(in: collectionView)
                }
            }
        }

        private func needsMeasurement(_ rows: [MessageLayoutRow], in view: UICollectionView) -> Bool {
            rows.contains { heightCache[cacheKey(for: $0, in: view)] == nil }
        }

        private func measureAndPublish(in collectionView: MessageUICollectionView) {
            guard collectionView.bounds.width > 0 else { return }
            generation += 1
            let currentGeneration = generation
            measurementTask?.cancel()
            let pending = rows.filter { heightCache[cacheKey(for: $0, in: collectionView)] == nil }
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
            guard nextRows.allSatisfy({ heightCache[cacheKey(for: $0, in: collectionView)] != nil }) else {
                measureAndPublish(in: collectionView)
                return
            }
            let anchor = visibleAnchor(in: collectionView)
            let previousIDs = displayedRows.map(\.id)
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
                positionedHistory = true
            }

            layout?.update(
                rowHeights: nextRows.map { heightCache[cacheKey(for: $0, in: collectionView)] ?? 0 },
                width: collectionView.bounds.width,
                scale: collectionView.traitCollection.displayScale
            )
            retainedTail = tailHeight(in: collectionView)
            if ownedSendID == nil, retainedTail > 0,
               !collectionView.isDragging, !collectionView.isDecelerating {
                retainedTail = min(retainedTail, requiredRetainedTail(in: collectionView))
            }
            layout?.tailHeight = retainedTail
            let structureChanged = previousIDs != nextRows.map(\.id)
            if structureChanged { collectionView.reloadData() }
            else { updateAvatarPlayback() }
            collectionView.collectionViewLayout.invalidateLayout()
            collectionView.layoutIfNeeded()

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
                    scrollRowToTop(index, in: collectionView)
                } else if !collectionView.isDragging && !collectionView.isDecelerating,
                          !alignOwnedSendIfNeeded(in: collectionView) {
                    restore(anchor, in: collectionView)
                }
                updateAvatarPlayback()
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
            return max(0, usable - extent)
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

        private func scrollRowToTop(_ index: Int, in collectionView: UICollectionView) {
            guard let frame = layout?.rowFrames[index] else { return }
            setOffset(frame.minY - collectionView.adjustedContentInset.top, in: collectionView)
        }

        @discardableResult
        private func alignOwnedSendIfNeeded(in collectionView: UICollectionView) -> Bool {
            guard let ownedSendID,
                  let index = displayedRows.firstIndex(where: { $0.id == ownedSendID }),
                  let frame = layout?.rowFrames[index] else { return false }
            let target = frame.minY - collectionView.adjustedContentInset.top
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
            let minimum = -collectionView.adjustedContentInset.top
            let publishedHeight = layout?.collectionViewContentSize.height
                ?? collectionView.contentSize.height
            let maximum = max(
                minimum,
                publishedHeight - collectionView.bounds.height
                    + collectionView.adjustedContentInset.bottom
            )
            collectionView.setContentOffset(
                CGPoint(x: 0, y: min(maximum, max(minimum, proposed))), animated: false
            )
        }

        private func cacheKey(for row: MessageLayoutRow, in view: UICollectionView) -> String {
            "\(measurementSignature(in: view))|\(row.id)|\(row.revision)|\(userName)"
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

        private func configure(_ cell: MessageHostingCell, at index: Int) {
            guard displayedRows.indices.contains(index), let collectionView else { return }
            let row = displayedRows[index]
            let key = cacheKey(for: row, in: collectionView)
            cell.accessibilityIdentifier = row.accessibilityIdentifier
            cell.set(rootView: AnyView(MessageRowLayout(
                row: row.row,
                messageCount: messageCount,
                paneWidth: collectionView.bounds.width,
                userName: userName,
                avatarMode: row.avatarMode,
                avatarPlaybackEnabled: avatarPlaybackEnabled(for: index, in: collectionView),
                measurement: false,
                imageCache: imageCache,
                onRetry: onRetry,
                onHeightChange: { [weak self] height in
                    self?.renderedHeightDidChange(height, rowID: row.id, key: key)
                }
            )))
        }

        private func renderedHeightDidChange(_ height: CGFloat, rowID: String, key: String) {
            guard height > 0, let collectionView,
                  let index = displayedRows.firstIndex(where: { $0.id == rowID }),
                  cacheKey(for: displayedRows[index], in: collectionView) == key else { return }
            let scale = max(collectionView.traitCollection.displayScale, 1)
            guard abs((heightCache[key] ?? 0) - height) > 1 / scale else { return }
            let anchor = visibleAnchor(in: collectionView)
            heightCache[key] = height
            if let layout {
                var heights = layout.rowHeights
                heights[index] = height
                layout.update(
                    rowHeights: heights,
                    width: collectionView.bounds.width,
                    scale: collectionView.traitCollection.displayScale
                )
            }
            retainedTail = tailHeight(in: collectionView)
            if ownedSendID == nil, retainedTail > 0,
               !collectionView.isDragging, !collectionView.isDecelerating {
                retainedTail = min(retainedTail, requiredRetainedTail(in: collectionView))
            }
            layout?.tailHeight = retainedTail
            collectionView.collectionViewLayout.invalidateLayout()
            collectionView.layoutIfNeeded()
            if !collectionView.isDragging && !collectionView.isDecelerating,
               !alignOwnedSendIfNeeded(in: collectionView) {
                restore(anchor, in: collectionView)
            }
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            guard !displayedRows.isEmpty else { return }
            positionGeneration += 1
            pendingInitialHistoryPosition = false
            pendingSendIDsDuringHistory = []
            awaitingHistory = false
            positionedHistory = true
            sendAnchorState.observed.formUnion(sendIdentities(in: displayedRows))
            ownedSendID = nil
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

        private func updateAvatarPlayback() {
            guard let collectionView else { return }
            for case let cell as MessageHostingCell in collectionView.visibleCells {
                guard let index = collectionView.indexPath(for: cell)?.item else { continue }
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
    var measuredRowCount = 0
    private var previousSize = CGSize.zero

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != previousSize else { return }
        previousSize = bounds.size
        onBoundsChange?()
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
        host.rootView = AnyView(EmptyView())
    }

    func set(rootView: AnyView) {
        host.rootView = rootView
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
