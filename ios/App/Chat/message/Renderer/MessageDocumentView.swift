import UIKit
import CoreText
import SwiftUI

final class MessageTextPosition: UITextPosition {
    let index: Int
    init(_ index: Int) { self.index = index }
}

final class MessageTextRange: UITextRange {
    let value: NSRange
    init(_ value: NSRange) { self.value = value }
    override var start: UITextPosition { MessageTextPosition(value.location) }
    override var end: UITextPosition { MessageTextPosition(NSMaxRange(value)) }
    override var isEmpty: Bool { value.length == 0 }
}

private final class MessageSelectionRect: UITextSelectionRect {
    let box: CGRect
    let leading: Bool
    let trailing: Bool
    let direction: NSWritingDirection
    init(_ box: CGRect, leading: Bool, trailing: Bool, direction: NSWritingDirection = .leftToRight) {
        self.box = box; self.leading = leading; self.trailing = trailing; self.direction = direction
    }
    override var rect: CGRect { box }
    override var writingDirection: NSWritingDirection { direction }
    override var containsStart: Bool { leading }
    override var containsEnd: Bool { trailing }
    override var isVertical: Bool { false }
}

/// Promoted R0 native input owner. All geometry comes from retained CoreText
/// layout, including measurement. No finalization mode or secondary renderer.
class MessageDocumentView: UIView, UITextInput, UIGestureRecognizerDelegate, UIScrollViewDelegate, UIContextMenuInteractionDelegate, UITextInteractionDelegate {
    var state = MessageDocumentState() { didSet {
        if oldValue !== state { stopTableMotion(); lastDocument = nil; activeTable = nil; selectionEdge.stop() }
        rebuild()
    } }
    var document: MessageDocument { state.document }
    private var layout: MessageDocumentLayout?
    private var lastDocument: MessageDocument?
    private var lines: [MessageDocumentLayout.Line] { layout?.lines ?? [] }
    private var activeTable: UUID?
    var tableRect: CGRect { layout?.tables.first { $0.id == activeTable }?.rect ?? .zero }
    var tableWidth: CGFloat { layout?.tables.first { $0.id == activeTable }?.contentWidth ?? 0 }
    var tableOffset: CGFloat { activeTable.flatMap { state.tableOffsets[$0] } ?? 0 }
    var measuredHeight: CGFloat { layout?.height ?? 0 }
    var imageCache: MarkdownImageCache?
    var measurement = false
    var showsStreamingCaret = false { didSet { updateStreamingCaret() } }
    private let streamingCaret = UIView()
    var openLink: ((URL) -> Void)?
    private var mediaTasks: [URL: Task<Void, Never>] = [:]
    private var images: [URL: UIImage] = [:]
    private var failedImages: Set<URL> = []
    private var tableScrolls: [UUID: UIScrollView] = [:]
    private lazy var tableMenu = UIContextMenuInteraction(delegate: self)
    var onLayoutChange: (() -> Void)?
    var onSelectionChange: (() -> Void)?
    /// Host supplies visible rect in this view's window coordinate space.
    var selectionViewportInWindow: (() -> CGRect)?
    /// Positive request scrolls content upward. Host applies its own policy and
    /// bounds synchronously and returns actual content-offset delta (may be zero).
    var requestSelectionScroll: ((CGFloat) -> CGFloat)?
    lazy var selectionEdge = MessageSelectionEdge(document: self)
    private let pointerObserver = MessagePointerObserver()
    private weak var pointerWindow: UIWindow?
    private var readingElements: [MessageReadingElement] = []
    private var readingByID: [String: MessageReadingElement] = [:]
    private var selection: MessageTextRange? {
        get { state.selection.map(MessageTextRange.init) }
        set { state.selection = newValue?.value }
    }
    private var lastWidth: CGFloat = 0
    private lazy var documentTap = UITapGestureRecognizer(target: self, action: #selector(activateLink(_:)))
    private var retainingSelectionOnDetach = false
    private let interaction = UITextInteraction(for: .nonEditable)
    // UITextInteraction installs its display interaction on both tested OSes.
    // Reuse it: installing another duplicates native highlights and grabbers.
    private var selectionDisplay: UITextSelectionDisplayInteraction? {
        interactions.compactMap { $0 as? UITextSelectionDisplayInteraction }.first
    }
    lazy var tokenizer: UITextInputTokenizer = UITextInputStringTokenizer(textInput: self)
    weak var inputDelegate: UITextInputDelegate?
    var markedTextStyle: [NSAttributedString.Key: Any]?
    var markedTextRange: UITextRange? { nil }
    var beginningOfDocument: UITextPosition { MessageTextPosition(0) }
    var endOfDocument: UITextPosition { MessageTextPosition(length) }
    var hasText: Bool { length > 0 }
    var isEditable: Bool { false }
    var textInputView: UIView { self }
    private var length: Int { (document.plain as NSString).length }
    private var pitch: CGFloat { layout?.bodyFont.lineHeight ?? 20 }
    override var canBecomeFirstResponder: Bool { true }

    override init(frame: CGRect) {
        super.init(frame: frame)
        streamingCaret.backgroundColor = UIColor(DuskColors.accent)
        streamingCaret.isUserInteractionEnabled = false
        streamingCaret.isAccessibilityElement = false
        addSubview(streamingCaret)
        backgroundColor = .clear
        isOpaque = false
        accessibilityIdentifier = "message-document"
        accessibilityTraits = .staticText
        interaction.textInput = self
        interaction.delegate = self
        addInteraction(interaction)
        for gesture in interaction.gesturesForFailureRequirements {
            gesture.addTarget(self, action: #selector(nativeGestureChanged(_:)))
        }
        addInteraction(tableMenu)
        pointerObserver.cancelsTouchesInView = false
        pointerObserver.delaysTouchesBegan = false
        pointerObserver.delaysTouchesEnded = false
        pointerObserver.sample = { [weak self] point in self?.observePointer(point) }
        documentTap.cancelsTouchesInView = false
        documentTap.delegate = self
        addGestureRecognizer(documentTap)
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitDisplayScale.self, UITraitAccessibilityContrast.self]) { (view: MessageDocumentView, _: UITraitCollection) in
            view.rebuild()
        }
    }
    override func willMove(toWindow newWindow: UIWindow?) {
        retainingSelectionOnDetach = newWindow == nil
        super.willMove(toWindow: newWindow)
    }

    func prepareForUnmount() {
        retainingSelectionOnDetach = true
        stopTableMotion()
        selectionEdge.stop()
    }

    func dismissSelection() {
        selectionEdge.stop()
        tableMenu.dismissMenu()
        selectedTextRange = nil
        if isFirstResponder { _ = resignFirstResponder() }
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned && !retainingSelectionOnDetach {
            selectionEdge.stop()
            if selection != nil { selectedTextRange = nil }
        }
        return resigned
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Native grabbers may live in a window overlay rather than the text
        // view's hit-test subtree. Observe that known window, never a discovered
        // scroll ancestor. This observer cannot prevent any native recognizer.
        if pointerWindow !== window {
            pointerWindow?.removeGestureRecognizer(pointerObserver)
            selectionEdge.stop()
            pointerWindow = window
            if !measurement { window?.addGestureRecognizer(pointerObserver) }
        }
        if window == nil {
            stopTableMotion()
            streamingCaret.layer.removeAllAnimations()
            mediaTasks.values.forEach { $0.cancel() }; mediaTasks.removeAll(); images.removeAll(); failedImages.removeAll()
        } else { loadMedia(); updateStreamingCaret() }
    }
    @objc private func nativeGestureChanged(_ gesture: UIGestureRecognizer) {
        selectionEdge.nativeGestureChanged(gesture.state, id: ObjectIdentifier(gesture))
    }
    private func observePointer(_ point: CGPoint?) {
        if let point, selectionEdge.pointer == nil,
           layout?.tables.contains(where: { $0.rect.contains(convert(point, from: window)) }) == true {
            stopTableMotion()
        }
        var anchor: Int?
        if let point, selectionEdge.pointer == nil, let selection {
            // Use public native handle geometry, not gesture/view class names.
            let handles = selectionDisplay?.handleViews.filter {
                !$0.isHidden && $0.alpha > 0 && $0.convert($0.bounds, to: window).insetBy(dx: -12, dy: -12).contains(point)
            } ?? []
            let handle = handles.min { a, b in
                let x = a.convert(a.bounds, to: window), y = b.convert(b.bounds, to: window)
                return hypot(x.midX - point.x, x.midY - point.y) < hypot(y.midX - point.x, y.midY - point.y)
            }
            if let handle {
                stopTableMotion()
                anchor = handle.direction.contains(.leading) ? NSMaxRange(selection.value) : selection.value.location
            }
        }
        selectionEdge.sample(point, handleAnchor: anchor)
    }
    func refreshSelectionGeometry() {
        selectionDisplay?.setNeedsSelectionUpdate()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() {
        super.layoutSubviews()
        if lastWidth != bounds.width { rebuild() }
        selectionDisplay?.setNeedsSelectionUpdate()
        updateStreamingCaret()
    }

    private func updateStreamingCaret() {
        streamingCaret.isHidden = !showsStreamingCaret || measurement || length == 0
        guard !streamingCaret.isHidden else { streamingCaret.layer.removeAllAnimations(); return }
        var rect = caretRect(for: endOfDocument)
        rect.origin.x = min(rect.minX, max(0, bounds.width - 2))
        streamingCaret.frame = rect
        if streamingCaret.layer.animation(forKey: "streaming") == nil {
            let blink = CABasicAnimation(keyPath: "opacity")
            blink.fromValue = 1; blink.toValue = 0; blink.duration = Motion.respondingCadence / 2
            blink.autoreverses = true; blink.repeatCount = .infinity
            streamingCaret.layer.add(blink, forKey: "streaming")
        }
    }

    func update(source: String, literal: Bool) {
        guard source != document.source || literal != document.literal else { return }
        state.update(source: source, literal: literal)
        rebuild()
    }

    func rebuild() {
        guard bounds.width > 0 else { return }
        lastWidth = bounds.width
        if let lastDocument, lastDocument.source != document.source || lastDocument.literal != document.literal {
            selectionEdge.remap(from: lastDocument, to: document)
        }
        lastDocument = document
        let previous = layout
        layout = state.measure(width: bounds.width, traits: traitCollection)
        if activeTable == nil || !(layout?.tables.contains { $0.id == activeTable } ?? false) { activeTable = layout?.tables.first?.id }
        readingElements = (layout?.reading ?? []).map { item in
            let element = readingByID[item.id] ?? MessageReadingElement(document: self, id: item.id)
            element.range = item.range
            element.accessibilityLabel = item.label
            element.imageFrame = item.imageFrame
            element.imageURL = item.imageURL
            element.accessibilityTraits = item.imageFrame != nil ? .image : (item.heading ? [.staticText, .header] : .staticText)
            element.tableID = item.table
            readingByID[item.id] = element
            return element
        }
        let ids = Set(layout?.reading.map(\.id) ?? [])
        readingByID = readingByID.filter { ids.contains($0.key) }
        let tableIDs = Set(layout?.tables.map(\.id) ?? [])
        for (id, scroll) in tableScrolls where !tableIDs.contains(id) {
            scroll.delegate = nil
            removeGestureRecognizer(scroll.panGestureRecognizer)
            scroll.removeFromSuperview()
            tableScrolls[id] = nil
        }
        if !measurement {
            for table in layout?.tables ?? [] {
                let scroll = tableScrolls[table.id] ?? UIScrollView()
                if scroll.superview == nil {
                    scroll.backgroundColor = .clear
                    scroll.isOpaque = false
                    scroll.showsHorizontalScrollIndicator = false
                    scroll.showsVerticalScrollIndicator = false
                    scroll.bounces = false
                    scroll.contentInsetAdjustmentBehavior = .never
                    scroll.isUserInteractionEnabled = false
                    scroll.accessibilityElementsHidden = true
                    scroll.delegate = self
                    tableScrolls[table.id] = scroll
                    insertSubview(scroll, at: 0)
                    // Keep touch hit ownership on the sole UITextInput. A
                    // descendant UIScrollView hit swallows native word selection.
                    // UIKit still owns this recognizer and all deceleration.
                    addGestureRecognizer(scroll.panGestureRecognizer)
                }
                let offset = CGPoint(x: clampedTableOffset(tableOffset(id: table.id), table: table), y: 0)
                if previous !== layout || scroll.frame != table.rect || scroll.contentOffset != offset {
                    scroll.delegate = nil
                    scroll.setContentOffset(scroll.contentOffset, animated: false)
                    scroll.frame = table.rect
                    scroll.contentSize = CGSize(width: scroll.bounds.width + maximumTableOffset(table), height: table.rect.height)
                    scroll.contentOffset = offset
                    scroll.delegate = self
                }
                state.tableOffsets[table.id] = max(0, scroll.contentOffset.x)
            }
        }
        loadMedia()
        invalidateIntrinsicContentSize()
        setNeedsDisplay()
        selectionDisplay?.isActivated = selection?.isEmpty == false
        selectionDisplay?.setNeedsSelectionUpdate()
        updateStreamingCaret()
        if previous !== layout { onLayoutChange?() }
        selectionEdge.geometryChanged()
    }

    private func loadMedia() {
        let urls = Set(layout?.pictures.compactMap { $0.media.url } ?? [])
        for (url, task) in mediaTasks where !urls.contains(url) { task.cancel(); mediaTasks[url] = nil }
        images = images.filter { urls.contains($0.key) }
        failedImages.formIntersection(urls)
        guard !measurement, window != nil, let imageCache else { return }
        for url in urls where images[url] == nil && mediaTasks[url] == nil {
            mediaTasks[url] = Task { @MainActor [weak self] in
                let data = await imageCache.imageData(for: url)
                guard !Task.isCancelled, let self else { return }
                if let data, let image = UIImage(data: data) { images[url] = image }
                else { failedImages.insert(url) }
                // Keep settled task until URL removal/unmount: failed resources
                // do not retry on every streaming token or draw.
                setNeedsDisplay()
            }
        }
    }

    func imageAccessibilityValue(for url: URL?) -> String? {
        guard let url, imageCache != nil, !failedImages.contains(url) else { return "Preview unavailable" }
        return images[url] == nil ? "Loading image" : nil
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard gestureRecognizer === documentTap else { return true }
        guard !selectionEdge.isHandlingSelection else { return false }
        let point = touch.location(in: self)
        if let selection, !selection.isEmpty {
            // A tap on selected text belongs to the native edit menu. Only
            // unselected document content uses this existing local tap path.
            return !selectionRects(for: selection).contains { $0.rect.contains(point) }
        }
        return link(at: point) != nil
    }

    private func link(at point: CGPoint) -> URL? {
        guard lines.contains(where: {
            let p = origin($0)
            return CGRect(x: p.x, y: p.y, width: CGFloat(CTLineGetTypographicBounds($0.text, nil, nil, nil)), height: $0.height).contains(point)
        }), let position = closestPosition(to: point) as? MessageTextPosition else { return nil }
        return document.runs.first { NSLocationInRange(position.index, $0.range) && $0.link != nil }?.link
    }

    @objc private func activateLink(_ gesture: UITapGestureRecognizer) {
        let url = link(at: gesture.location(in: self))
        if selection != nil { dismissSelection() }
        if let url { openLink?(url) }
    }

    func table(at point: CGPoint) -> MessageDocumentLayout.Table? {
        layout?.tables.first { ($0.rect.minY...$0.rect.maxY).contains(point.y) }
    }
    func activateTable(at point: CGPoint) { if let table = table(at: point) { activeTable = table.id } }
    func tableOffset(id: UUID) -> CGFloat { state.tableOffsets[id] ?? 0 }
    private var tableDisplayScale: CGFloat { max(1, traitCollection.displayScale) }
    private func maximumTableOffset(_ table: MessageDocumentLayout.Table) -> CGFloat {
        // Give UIKit a reachable pixel-aligned edge. Round outward, never hide
        // the last fractional pixel of CoreText content behind an early cue cutoff.
        ceil(max(0, table.contentWidth - table.rect.width) * tableDisplayScale) / tableDisplayScale
    }
    private func clampedTableOffset(_ offset: CGFloat, table: MessageDocumentLayout.Table) -> CGFloat {
        // Layout measurement clamps retained offsets to its unquantized extent.
        // Map that terminal value to the same edge used by native scrolling.
        offset >= max(0, table.contentWidth - table.rect.width) ? maximumTableOffset(table) : max(0, offset)
    }
    func tableCanScrollRight(id: UUID) -> Bool {
        guard let table = layout?.tables.first(where: { $0.id == id }) else { return false }
        return (tableOffset(id: id) * tableDisplayScale).rounded() < (maximumTableOffset(table) * tableDisplayScale).rounded()
    }
    func tableRect(id: UUID) -> CGRect { layout?.tables.first { $0.id == id }?.rect ?? .zero }
    func scrollTable(id: UUID, direction: UIAccessibilityScrollDirection) -> Bool {
        activeTable = id
        return accessibilityScroll(direction)
    }
    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: measuredHeight) }

    func setTableOffset(_ offset: CGFloat) {
        guard let activeTable, let table = layout?.tables.first(where: { $0.id == activeTable }) else { return }
        state.tableOffsets[activeTable] = clampedTableOffset(offset, table: table)
        if let scroll = tableScrolls[activeTable] {
            scroll.setContentOffset(CGPoint(x: tableOffset, y: 0), animated: false)
            state.tableOffsets[activeTable] = max(0, scroll.contentOffset.x)
        }
        setNeedsDisplay()
        selectionDisplay?.setNeedsSelectionUpdate()
    }
    var remainingLeft: Bool { tableOffset > 0 }
    var remainingRight: Bool { activeTable.map { tableCanScrollRight(id: $0) } ?? false }
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let scroll = tableScrolls.values.first(where: { $0.panGestureRecognizer === gestureRecognizer }) else {
            return super.gestureRecognizerShouldBegin(gestureRecognizer)
        }
        let velocity = scroll.panGestureRecognizer.velocity(in: self)
        return scroll.frame.contains(gestureRecognizer.location(in: self))
            && scroll.contentSize.width > scroll.bounds.width
            && abs(velocity.x) > abs(velocity.y) && !selectionEdge.isHandlingSelection
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard let id = tableScrolls.first(where: { $0.value === scrollView })?.key else { return }
        activeTable = id
        state.tableOffsets[id] = max(0, scrollView.contentOffset.x)
        setNeedsDisplay()
        refreshSelectionGeometry()
    }

    func stopTableMotion() {
        for (id, scroll) in tableScrolls {
            scroll.delegate = nil
            scroll.setContentOffset(scroll.contentOffset, animated: false)
            state.tableOffsets[id] = max(0, scroll.contentOffset.x)
            scroll.delegate = self
        }
    }

    /// Actual typographic text (including interior spaces), not the broad cell
    /// hit region used by native caret positioning in padding.
    func tableBackground(at point: CGPoint) -> UUID? {
        guard !selectionEdge.isHandlingSelection,
              let table = layout?.tables.first(where: { $0.rect.contains(point) }) else { return nil }
        for line in lines where line.table == table.id {
            let p = origin(line)
            let width = CGFloat(CTLineGetTypographicBounds(line.text, nil, nil, nil))
            if CGRect(x: p.x, y: p.y, width: width, height: line.height).contains(point) { return nil }
        }
        for picture in layout?.pictures ?? [] where picture.table == table.id {
            if picture.rect.offsetBy(dx: -tableOffset(id: table.id), dy: 0).contains(point) { return nil }
        }
        return table.id
    }

    func interactionShouldBegin(_ interaction: UITextInteraction, at point: CGPoint) -> Bool {
        selectionEdge.isHandlingSelection || tableBackground(at: point) == nil
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                               configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard let id = tableBackground(at: location) else { return nil }
        stopTableMotion()
        return UIContextMenuConfiguration(identifier: id as NSUUID, previewProvider: nil) { [weak self] _ in
            UIMenu(children: [UIAction(title: "Copy entire table", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
                self?.copyTableMarkdown(id: id)
            }])
        }
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                               previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
        tablePreview(configuration)
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                               previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
        tablePreview(configuration)
    }

    private func tablePreview(_ configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
        guard let id = configuration.identifier as? UUID, let window else { return nil }
        let viewport = selectionViewportInWindow?() ?? window.bounds
        let rect = tableRect(id: id).intersection(convert(viewport.intersection(window.bounds), from: window))
        guard !rect.isNull, !rect.isEmpty,
              let snapshot = resizableSnapshotView(from: rect, afterScreenUpdates: false, withCapInsets: .zero) else { return nil }
        // A long message must not become the context menu's whole-view preview.
        // Snapshot only this visible table slice, bounded by the host viewport.
        let parameters = UIPreviewParameters()
        parameters.backgroundColor = UIColor(DuskColors.bgSunk)
        parameters.visiblePath = UIBezierPath(roundedRect: CGRect(origin: .zero, size: rect.size), cornerRadius: Radii.sm)
        snapshot.layer.cornerRadius = Radii.sm
        snapshot.clipsToBounds = true
        return UITargetedPreview(view: snapshot, parameters: parameters,
                                 target: UIPreviewTarget(container: self, center: CGPoint(x: rect.midX, y: rect.midY)))
    }

    private func origin(_ line: MessageDocumentLayout.Line) -> CGPoint {
        CGPoint(x: line.origin.x - (line.table.map { state.tableOffsets[$0] ?? 0 } ?? 0), y: line.origin.y)
    }
    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext(), let layout else { return }
        UIColor(DuskColors.bgSunk).setFill()
        for well in layout.wells { UIBezierPath(roundedRect: well, cornerRadius: Radii.sm).fill() }
        for run in document.runs where run.style.contains(.code) && !document.blocks.contains(where: { $0.kind == .code && NSIntersectionRange($0.range, run.range).length > 0 }) {
            context.saveGState()
            if let table = lines.first(where: { NSIntersectionRange($0.range, run.range).length > 0 })?.table {
                UIBezierPath(roundedRect: tableRect(id: table), cornerRadius: Radii.sm).addClip()
            }
            for selection in selectionRects(for: MessageTextRange(run.range)) { context.fill(selection.rect) }
            context.restoreGState()
        }
        UIColor(DuskColors.lineSoft).setFill()
        for rule in layout.rules { context.fill(rule) }
        for marker in layout.markers {
            if let image = marker.image {
                let scale = marker.faceSize / DesignMetrics.checkboxSize
                let overflow = DesignMaterialAdapter.smallControlMaximumOverflow * scale
                image.draw(in: CGRect(x: marker.point.x - overflow, y: marker.point.y - overflow,
                                      width: image.size.width * scale, height: image.size.height * scale))
            } else {
                (marker.label as NSString).draw(at: marker.point, withAttributes: [.font: layout.bodyFont, .foregroundColor: UIColor(DuskColors.ink2)])
            }
        }
        for table in layout.tables {
            let offset = tableOffset(id: table.id)
            context.saveGState()
            UIBezierPath(roundedRect: table.rect, cornerRadius: Radii.sm).addClip()
            UIColor(DuskColors.bgSunk).setFill(); context.fill(table.rect)
            UIColor(DuskColors.lineSoft).setStroke()
            for cell in table.cells { context.stroke(cell.offsetBy(dx: -offset, dy: 0), width: 0.5) }
            context.restoreGState()
        }
        for line in lines {
            context.saveGState()
            if let table = line.table { UIBezierPath(roundedRect: tableRect(id: table), cornerRadius: Radii.sm).addClip() }
            let point = origin(line)
            context.textMatrix = .identity
            context.translateBy(x: point.x, y: point.y + line.baseline)
            context.scaleBy(x: 1, y: -1)
            context.textPosition = .zero
            CTLineDraw(line.text, context)
            context.restoreGState()
        }
        UIColor(DuskColors.ink2).setStroke()
        for run in document.runs where run.style.contains(.strike) {
            context.saveGState()
            if let table = lines.first(where: { NSIntersectionRange($0.range, run.range).length > 0 })?.table {
                UIBezierPath(roundedRect: tableRect(id: table), cornerRadius: Radii.sm).addClip()
            }
            for selection in selectionRects(for: MessageTextRange(run.range)) {
                context.move(to: CGPoint(x: selection.rect.minX, y: selection.rect.midY))
                context.addLine(to: CGPoint(x: selection.rect.maxX, y: selection.rect.midY))
            }
            context.setLineWidth(1); context.strokePath()
            context.restoreGState()
        }
        for picture in layout.pictures {
            context.saveGState()
            let rect = picture.rect.offsetBy(dx: -(picture.table.map { tableOffset(id: $0) } ?? 0), dy: 0)
            if let table = picture.table { UIBezierPath(roundedRect: tableRect(id: table), cornerRadius: Radii.sm).addClip() }
            UIColor(DuskColors.bgSunk).setFill(); context.fill(rect)
            if let url = picture.media.url, let image = images[url] {
                let scale = min(rect.width / image.size.width, rect.height / image.size.height)
                let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
                image.draw(in: CGRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width, height: size.height))
            } else {
                UIImage(systemName: "photo")?.draw(in: CGRect(x: rect.midX - 16, y: rect.midY - 16, width: 32, height: 32))
            }
            context.restoreGState()
        }
        // Fade moving content into its own surface; blank well stays unchanged.
        // Native endpoint predicates own visibility (including pixel tolerance).
        let surface = UIColor(DuskColors.bgSunk)
        let colors = [surface.cgColor, surface.withAlphaComponent(0).cgColor] as CFArray
        if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
            for table in layout.tables {
                let width = min(Space.xxl * layout.bodyFont.pointSize / DesignTextRole.body.baseSize, table.rect.width / 2)
                context.saveGState()
                // Protect only horizontal perimeter decoration, not clipped
                // glyphs/images at the sides. Content is already round-clipped;
                // source-atop keeps its destination alpha/silhouette unchanged.
                let inset = max(0.5, 1 / tableDisplayScale)
                context.clip(to: CGRect(x: bounds.minX, y: table.rect.minY + inset,
                    width: bounds.width, height: max(0, table.rect.height - inset * 2)))
                context.setBlendMode(.sourceAtop)
                if tableOffset(id: table.id) > 0 {
                    context.drawLinearGradient(gradient,
                        start: CGPoint(x: table.rect.minX, y: table.rect.midY),
                        end: CGPoint(x: table.rect.minX + width, y: table.rect.midY), options: [])
                }
                if tableCanScrollRight(id: table.id) {
                    context.drawLinearGradient(gradient,
                        start: CGPoint(x: table.rect.maxX, y: table.rect.midY),
                        end: CGPoint(x: table.rect.maxX - width, y: table.rect.midY), options: [])
                }
                context.restoreGState()
            }
        }
    }

    var selectedTextRange: UITextRange? {
        get { selection }
        set {
            inputDelegate?.selectionWillChange(self)
            if let range = newValue as? MessageTextRange {
                let start = document.graphemeBoundary(range.value.location)
                let end = document.graphemeBoundary(NSMaxRange(range.value))
                selection = MessageTextRange(NSRange(location: min(start, end), length: abs(end - start)))
            } else { selection = nil }
            selectionDisplay?.isActivated = selection?.isEmpty == false
            selectionDisplay?.setNeedsSelectionUpdate()
            inputDelegate?.selectionDidChange(self)
            onSelectionChange?()
        }
    }
    func text(in range: UITextRange) -> String? { document.plain(in: ns(range)) }
    func replace(_ range: UITextRange, withText text: String) {}
    func setMarkedText(_ markedText: String?, selectedRange: NSRange) {}
    func unmarkText() {}
    func insertText(_ text: String) {}
    func deleteBackward() {}
    func textRange(from: UITextPosition, to: UITextPosition) -> UITextRange? {
        let a = idx(from), b = idx(to)
        return MessageTextRange(NSRange(location: min(a, b), length: abs(b - a)))
    }
    func position(from position: UITextPosition, offset: Int) -> UITextPosition? {
        let next = idx(position) + offset
        return (0...length).contains(next) ? MessageTextPosition(next) : nil
    }
    func position(from position: UITextPosition, in direction: UITextLayoutDirection, offset: Int) -> UITextPosition? {
        if direction == .left || direction == .right {
            let positions = visualPositions()
            guard let current = positions.firstIndex(of: idx(position)) else { return nil }
            let next = current + (direction == .left ? -offset : offset)
            return positions.indices.contains(next) ? MessageTextPosition(positions[next]) : nil
        }
        let rect = caretRect(for: position)
        return closestPosition(to: CGPoint(x: rect.midX, y: rect.midY + CGFloat(direction == .up ? -offset : offset) * pitch))
    }
    private func visualPositions() -> [Int] {
        let text = document.plain as NSString
        return lines.flatMap { line -> [Int] in
            var indices = [line.range.location], index = line.range.location
            while index < NSMaxRange(line.range) {
                index = min(NSMaxRange(line.range), NSMaxRange(text.rangeOfComposedCharacterSequence(at: index)))
                indices.append(index)
            }
            return indices.sorted {
                CTLineGetOffsetForStringIndex(line.text, $0, nil) < CTLineGetOffsetForStringIndex(line.text, $1, nil)
            }
        }.reduce(into: [Int]()) { if $0.last != $1 { $0.append($1) } }
    }
    func compare(_ position: UITextPosition, to other: UITextPosition) -> ComparisonResult {
        idx(position) == idx(other) ? .orderedSame : (idx(position) < idx(other) ? .orderedAscending : .orderedDescending)
    }
    func offset(from: UITextPosition, to: UITextPosition) -> Int { idx(to) - idx(from) }
    func position(within range: UITextRange, farthestIn direction: UITextLayoutDirection) -> UITextPosition? {
        if direction == .up { return range.start }
        if direction == .down { return range.end }
        let positions = visualPositions().filter { idx(range.start)...idx(range.end) ~= $0 }
        return (direction == .left ? positions.first : positions.last).map(MessageTextPosition.init)
    }
    func characterRange(byExtending position: UITextPosition, in direction: UITextLayoutDirection) -> UITextRange? {
        let index = idx(position) - (direction == .left || direction == .up ? 1 : 0)
        guard index >= 0, index < length else { return nil }
        return MessageTextRange((document.plain as NSString).rangeOfComposedCharacterSequence(at: index))
    }
    func baseWritingDirection(for position: UITextPosition, in direction: UITextStorageDirection) -> NSWritingDirection {
        guard let line = lines.first(where: { NSLocationInRange(idx(position), $0.range) }),
              let run = (CTLineGetGlyphRuns(line.text) as! [CTRun]).first(where: {
                  let range = CTRunGetStringRange($0)
                  return NSLocationInRange(idx(position), NSRange(location: range.location, length: range.length))
              }) else { return .natural }
        return CTRunGetStatus(run).contains(.rightToLeft) ? .rightToLeft : .leftToRight
    }
    func setBaseWritingDirection(_ writingDirection: NSWritingDirection, for range: UITextRange) {}
    private func idx(_ position: UITextPosition) -> Int { (position as! MessageTextPosition).index }
    private func ns(_ range: UITextRange) -> NSRange { (range as! MessageTextRange).value }
    func firstRect(for range: UITextRange) -> CGRect { selectionRects(for: range).first?.rect ?? caretRect(for: range.start) }
    func caretRect(for position: UITextPosition) -> CGRect {
        let index = idx(position)
        guard let line = lines.first(where: { NSLocationInRange(index, $0.range) }) ?? lines.last(where: { NSMaxRange($0.range) <= index }) else { return .zero }
        let start = CTLineGetStringRange(line.text).location
        let x = CTLineGetOffsetForStringIndex(line.text, start + min(line.range.length, max(0, index - line.range.location)), nil)
        let point = origin(line)
        return CGRect(x: point.x + x, y: point.y, width: 2, height: line.height)
    }
    func selectionRects(for range: UITextRange) -> [UITextSelectionRect] {
        let selected = ns(range)
        return lines.flatMap { line -> [UITextSelectionRect] in
            let intersection = NSIntersectionRange(selected, line.range)
            guard intersection.length > 0 else { return [] }
            let point = origin(line)
            return (CTLineGetGlyphRuns(line.text) as! [CTRun]).flatMap { run -> [UITextSelectionRect] in
                let runRange = CTRunGetStringRange(run)
                let overlap = NSIntersectionRange(intersection, NSRange(location: runRange.location, length: runRange.length))
                guard overlap.length > 0 else { return [] }
                let count = CTRunGetGlyphCount(run)
                var indices = Array(repeating: CFIndex(0), count: count)
                var positions = Array(repeating: CGPoint.zero, count: count)
                var advances = Array(repeating: CGSize.zero, count: count)
                CTRunGetStringIndices(run, CFRange(location: 0, length: 0), &indices)
                CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
                CTRunGetAdvances(run, CFRange(location: 0, length: 0), &advances)
                let runEnd = runRange.location + runRange.length
                let boundaries = Array(Set(indices + [runEnd])).sorted()
                let rtl = CTRunGetStatus(run).contains(.rightToLeft)
                return indices.indices.compactMap { glyph in
                    let start = indices[glyph]
                    let end = boundaries.first { $0 > start } ?? runEnd
                    guard NSIntersectionRange(overlap, NSRange(location: start, length: max(0, end - start))).length > 0 else { return nil }
                    var box = CGRect(x: point.x + positions[glyph].x, y: point.y, width: max(1, advances[glyph].width), height: line.height)
                    if let table = line.table { box = box.intersection(tableRect(id: table)) }
                    guard !box.isNull else { return nil }
                    return MessageSelectionRect(box, leading: selected.location >= start && selected.location < end,
                                                trailing: NSMaxRange(selected) > start && NSMaxRange(selected) <= end,
                                                direction: rtl ? .rightToLeft : .leftToRight)
                }
            }
        }
    }
    func closestPosition(to point: CGPoint) -> UITextPosition? {
        selectionEdge.nativeHitTest(point)
        guard let line = lines.min(by: { distance(point, $0) < distance(point, $1) }) else { return beginningOfDocument }
        let origin = origin(line)
        let local = CTLineGetStringIndexForPosition(line.text, CGPoint(x: point.x - origin.x, y: 0))
        let start = CTLineGetStringRange(line.text).location
        let index = local == kCFNotFound ? line.range.length : max(0, min(line.range.length, local - start))
        let absolute = line.range.location + index
        // Never return a position in the middle of an extended grapheme cluster.
        if absolute == length { return endOfDocument }
        return MessageTextPosition((document.plain as NSString).rangeOfComposedCharacterSequence(at: absolute).location)
    }
    private func distance(_ point: CGPoint, _ line: MessageDocumentLayout.Line) -> CGFloat {
        let p = origin(line)
        let dy = max(0, abs(point.y - (p.y + line.height / 2)) - line.height / 2)
        let dx = max(0, p.x - point.x, point.x - p.x - line.width)
        return dy * dy * 100 + dx * dx
    }
    func closestPosition(to point: CGPoint, within range: UITextRange) -> UITextPosition? {
        guard let position = closestPosition(to: point) else { return nil }
        return MessageTextPosition(max(idx(range.start), min(idx(range.end), idx(position))))
    }
    func characterRange(at point: CGPoint) -> UITextRange? {
        guard let position = closestPosition(to: point) else { return nil }
        return characterRange(byExtending: position, in: .right)
    }
    override var isAccessibilityElement: Bool {
        get { false }
        set {}
    }
    override var accessibilityElements: [Any]? {
        get {
            guard window != nil else { return [] }
            let entries: [(CGFloat, Any)] = readingElements.filter { !$0.accessibilityFrame.isEmpty }.map { ($0.accessibilityFrame.minY, $0) }
            return entries.sorted { $0.0 < $1.0 }.map { $0.1 }
        }
        set {}
    }
    func readingFrame(_ range: NSRange) -> CGRect {
        let rect = selectionRects(for: MessageTextRange(range)).reduce(CGRect.null) { $0.union($1.rect) }
        return accessibleFrame(for: rect)
    }
    func accessibleImageFrame(_ rect: CGRect, table: UUID?) -> CGRect {
        guard let table else { return accessibleFrame(for: rect) }
        return accessibleFrame(for: rect.offsetBy(dx: -tableOffset(id: table), dy: 0).intersection(tableRect(id: table)))
    }
    func accessibleFrame(for rect: CGRect) -> CGRect {
        guard let window, !rect.isNull else { return .zero }
        var visible = convert(rect, to: window).intersection(window.bounds)
        if let viewport = selectionViewportInWindow?() { visible = visible.intersection(viewport) }
        guard !visible.isNull else { return .zero }
        return UIAccessibility.convertToScreenCoordinates(visible, in: window)
    }
    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        let before = tableOffset
        if direction == .left { setTableOffset(before + tableRect.width * 0.8) }
        else if direction == .right { setTableOffset(before - tableRect.width * 0.8) }
        else { return false }
        guard tableOffset != before else { return false }
        UIAccessibility.post(notification: .layoutChanged, argument: readingElements.first { $0.tableID == activeTable && !$0.accessibilityFrame.isEmpty })
        return true
    }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        (action == #selector(copy(_:)) && selection?.isEmpty == false) || action == #selector(selectAll(_:))
    }
    override func copy(_ sender: Any?) {
        guard let selection else { return }
        UIPasteboard.general.string = document.clipboardText(in: selection.value)
    }
    override func selectAll(_ sender: Any?) {
        selectedTextRange = MessageTextRange(NSRange(location: 0, length: length))
    }
    func copyTableMarkdown(id: UUID) {
        guard layout?.tables.contains(where: { $0.id == id }) == true else { return }
        UIPasteboard.general.string = document.tableMarkdown(id: id)
    }
}
