import UIKit

/// Arithmetic layout: the date domain has identities, not allocated tiles.
/// Queries visit only rows intersecting the viewport. One progress value owns
/// both the outer frame and the date renderer's interior geometry.
final class CalendarNativeViewportLayout: UICollectionViewLayout {
    static let monthCount = CalendarViewportMonth.nativeMonthCount
    var progress: CGFloat = 1
    // Endpoint geometry uses the component bounds, NEVER the interpolating
    // scroll-view height (which would multiply header drift by month index).
    var viewportSize: CGSize = .zero
    var rowHeight: CGFloat = CalendarSurfaceLayout.monthCellHeight
    var dateSize: CGFloat = TypeScale.sm
    var dateWidth: CGFloat = CalendarSurfaceLayout.minimumTarget
    var accessibilitySize = false
    var rightToLeft = false
    var firstWeekday = 1

    var columns: Int {
        guard !accessibilitySize else { return 1 }
        return max(1, min(4, Int((viewportWidth + Space.md) / (CalendarSurfaceLayout.miniMonthWidth + Space.md))))
    }
    private var viewportWidth: CGFloat { viewportSize.width }
    private var monthWidth: CGFloat { max(viewportWidth, 7 * max(dateWidth, CalendarSurfaceLayout.minimumTarget)) }
    var width: CGFloat { mix(viewportWidth, monthWidth, progress) }
    var headingHeight: CGFloat { CalendarNativeMonthGeometry.headingHeight(dateSize: dateSize) }
    private var expandedRowHeight: CGFloat {
        CalendarNativeMonthGeometry.monthRowHeight(width: monthWidth, rowHeight: rowHeight)
    }
    var miniHeight: CGFloat { CalendarNativeMonthGeometry.compactHeight(dateSize: dateSize) }

    func monthHeight(for index: Int) -> CGFloat {
        headingHeight + expandedRowHeight * CGFloat(
            CalendarNativeMonthGeometry.ownedRowCount(index: index, firstWeekday: firstWeekday)
        )
    }

    private func monthStartY(_ index: Int) -> CGFloat {
        let rows = CalendarNativeMonthGeometry.rowsBeforeMonth(index: index, firstWeekday: firstWeekday)
        return CGFloat(index) * headingHeight + CGFloat(rows) * expandedRowHeight
    }

    func frame(_ index: Int, progress p: CGFloat) -> CGRect {
        let tileWidth = max(0, (viewportWidth - Space.md * CGFloat(columns + 1)) / CGFloat(columns))
        let logicalColumn = index % columns
        let column = rightToLeft ? columns - logicalColumn - 1 : logicalColumn
        let small = CGRect(x: Space.md + CGFloat(column) * (tileWidth + Space.md),
                           y: Space.md + CGFloat(index / columns) * (miniHeight + Space.md),
                           width: tileWidth, height: miniHeight)
        let large = CGRect(x: 0, y: monthStartY(index), width: monthWidth, height: monthHeight(for: index))
        return CGRect(x: mix(small.minX, large.minX, p), y: mix(small.minY, large.minY, p),
                      width: mix(small.width, large.width, p), height: mix(small.height, large.height, p))
    }

    /// Proleptic civil arithmetic: Jan 1, year 1 is Monday. No Calendar,
    /// formatting, cache misses or domain-sized month arrays in layout queries.
    func firstWeek(_ index: Int) -> Int {
        let ordinal = CalendarNativeMonthGeometry.daysBeforeMonth(index: index)
        let offset = (9 - CalendarNativeMonthGeometry.normalizedWeekday(firstWeekday)) % 7
        return (ordinal + offset) / 7
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: width, height: frame(Self.monthCount - 1, progress: progress).maxY + Space.md)
    }
    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.size != collectionView?.bounds.size
    }
    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: indexPath)
        attributes.frame = frame(indexPath.item, progress: progress)
        return attributes
    }
    func indices(in rect: CGRect, progress sample: CGFloat? = nil) -> Range<Int> {
        let progress = sample ?? self.progress
        // Monotonic rows at both endpoints and every interpolated layout.
        var low = 0
        var high = Self.monthCount
        while low < high {
            let middle = (low + high) / 2
            if frame(middle, progress: progress).maxY < rect.minY { low = middle + 1 }
            else { high = middle }
        }
        let start = max(0, low - columns)
        var end = low
        while end < Self.monthCount && frame(end, progress: progress).minY <= rect.maxY { end += 1 }
        return start..<min(Self.monthCount, end + columns)
    }
    /// The month that owns the leading visible boundary. Unlike a center
    /// heuristic, this stays with the current month until its frame has
    /// actually left the leading edge (or the next frame has reached it).
    /// UIKit quantizes a scroll offset to display pixels, while civil month
    /// boundaries can remain fractional. Compare both edges at that same
    /// resolution so a quantized offset at a boundary selects the next month.
    func leadingVisibleMonth(in rect: CGRect) -> CalendarViewportMonth? {
        let leadingY = displayAligned(rect.minY)
        let trailingY = displayAligned(rect.maxY)
        let candidates = indices(in: rect).filter {
            let frame = frame($0, progress: progress)
            return displayAligned(frame.maxY) > leadingY && displayAligned(frame.minY) <= trailingY
        }
        guard let first = candidates.min(by: { lhs, rhs in
            let left = frame(lhs, progress: progress)
            let right = frame(rhs, progress: progress)
            if left.minY == right.minY { return lhs < rhs }
            return left.minY < right.minY
        }) else { return nil }

        guard progress != 1 else { return CalendarViewportMonth(index: first) }
        let row = first / columns
        let rowCandidates = candidates.filter { $0 / columns == row }
        let leading = rightToLeft ? rowCandidates.max() : rowCandidates.min()
        return CalendarViewportMonth(index: leading ?? first)
    }

    /// Geometry, not a preset phone/month count, owns the read envelope.
    func periodRequest(in rect: CGRect, progress sample: CGFloat? = nil) -> CalendarViewportRequest {
        let progress = sample ?? self.progress
        let visible = indices(in: rect, progress: progress).filter { frame($0, progress: progress).intersects(rect) }
        guard let first = visible.min(), let last = visible.max() else { return .init(months: []) }
        let rowColumns = progress == 1 ? 1 : columns
        let lower = max(0, (first / rowColumns - 1) * rowColumns)
        let upper = min(Self.monthCount, (last / rowColumns + 2) * rowColumns)
        let visibleSet = Set(visible)
        func nearest(_ a: Int, _ b: Int) -> Bool {
            let aDistance = abs(frame(a, progress: progress).midY - rect.midY)
            let bDistance = abs(frame(b, progress: progress).midY - rect.midY)
            return aDistance == bDistance ? a < b : aDistance < bDistance
        }
        let overscan = (lower..<upper).filter { !visibleSet.contains($0) }.sorted(by: nearest)
        let ordered = visible.sorted(by: nearest) + overscan
        return .init(months: ordered.prefix(CalendarViewportRequest.maximumPeriods).map(CalendarViewportMonth.init(index:)))
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        indices(in: rect).compactMap { index in
            guard frame(index, progress: progress).intersects(rect) else { return nil }
            return layoutAttributesForItem(at: IndexPath(item: index, section: 0))
        }
    }

    private func displayAligned(_ coordinate: CGFloat) -> CGFloat {
        let scale = collectionView?.traitCollection.displayScale ?? UIScreen.main.scale
        let usableScale = scale.isFinite && scale > 0 ? scale : 1
        return (coordinate * usableScale).rounded() / usableScale
    }

    private func mix(_ a: CGFloat, _ b: CGFloat, _ p: CGFloat) -> CGFloat { a + (b - a) * p }
}

/// Focus visibility for Calendar's two native scrollers. Insets make terminal
/// content reachable; this adapter additionally brings an actual focused date
/// or hosted row above the floating controls, without shrinking the viewport.
@MainActor
final class CalendarViewportFocusVisibility: NSObject {
    weak var scrollView: UIScrollView?
    var bottomOcclusion: CGFloat = 0

    init(scrollView: UIScrollView) {
        self.scrollView = scrollView
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(accessibilityFocusChanged(_:)),
            name: UIAccessibility.elementFocusedNotification, object: nil
        )
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    func reveal(_ rect: CGRect) {
        guard let scrollView, !scrollView.accessibilityElementsHidden,
              scrollView.bounds.height > bottomOcclusion else { return }
        let top = scrollView.contentOffset.y + scrollView.adjustedContentInset.top
        let bottom = scrollView.bounds.maxY - bottomOcclusion
        let y: CGFloat
        if rect.minY < top { y = rect.minY - scrollView.adjustedContentInset.top }
        else if rect.maxY > bottom {
            // Oversized AX rows align their beginning; do not hide the focused
            // label above the viewport trying to fit an impossible whole row.
            y = min(rect.minY - scrollView.adjustedContentInset.top,
                    rect.maxY - scrollView.bounds.height + bottomOcclusion)
        } else { y = scrollView.contentOffset.y }
        let left = scrollView.bounds.minX + scrollView.adjustedContentInset.left
        let right = scrollView.bounds.maxX - scrollView.adjustedContentInset.right
        let x: CGFloat
        if rect.minX < left { x = rect.minX - scrollView.adjustedContentInset.left }
        else if rect.maxX > right {
            x = min(rect.minX - scrollView.adjustedContentInset.left,
                    rect.maxX - scrollView.bounds.width + scrollView.adjustedContentInset.right)
        } else { x = scrollView.contentOffset.x }
        let minimumX = -scrollView.adjustedContentInset.left
        let maximumX = max(minimumX, scrollView.contentSize.width - scrollView.bounds.width
                           + scrollView.adjustedContentInset.right)
        let minimum = -scrollView.adjustedContentInset.top
        let maximum = max(minimum, scrollView.contentSize.height - scrollView.bounds.height
                          + scrollView.adjustedContentInset.bottom)
        scrollView.setContentOffset(CGPoint(x: min(maximumX, max(minimumX, x)),
                                           y: min(maximum, max(minimum, y))), animated: false)
    }

    func revealFocusedView(_ view: UIView) {
        guard let scrollView, view.isDescendant(of: scrollView) else { return }
        reveal(view.convert(view.bounds, to: scrollView))
    }

    @objc private func accessibilityFocusChanged(_ notification: Notification) {
        guard let scrollView, let window = scrollView.window,
              let focused = notification.userInfo?[UIAccessibility.focusedElementUserInfoKey] as? NSObject else { return }
        // Ignore sheets and other Calendar/native controls even if their
        // screen frames happen to overlap the scrolling region.
        var container: Any? = focused
        while let element = container as? UIAccessibilityElement { container = element.accessibilityContainer }
        guard let owner = container as? UIView, owner.isDescendant(of: scrollView) else { return }
        if let view = focused as? UIView {
            revealFocusedView(view)
        } else if let element = focused as? UIAccessibilityElement,
                  let coordinateOwner = element.accessibilityContainer as? UIView,
                  !element.accessibilityFrameInContainerSpace.isEmpty,
                  !element.accessibilityFrameInContainerSpace.isNull {
            // Native drawn dates and hosted-row AX elements publish local
            // frames. Use that authoritative coordinate space directly; the
            // AX screen-frame getter is not the view conversion used by UIKit
            // layout and can include accessibility container adjustments.
            reveal(coordinateOwner.convert(element.accessibilityFrameInContainerSpace, to: scrollView))
        } else {
            // SwiftUI/system elements may publish only a screen-space frame.
            let frame = window.convert(focused.accessibilityFrame, from: window.screen.coordinateSpace)
            reveal(scrollView.convert(frame, from: window))
        }
    }
}
