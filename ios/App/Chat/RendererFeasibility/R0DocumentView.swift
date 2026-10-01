import UIKit
import CoreText

final class R0Position: UITextPosition {
    let index: Int
    init(_ index: Int) { self.index = index }
}

final class R0Range: UITextRange {
    let value: NSRange
    init(_ value: NSRange) { self.value = value }
    override var start: UITextPosition { R0Position(value.location) }
    override var end: UITextPosition { R0Position(NSMaxRange(value)) }
    override var isEmpty: Bool { value.length == 0 }
}

private final class R0SelectionRect: UITextSelectionRect {
    let box: CGRect
    let leading: Bool
    let trailing: Bool
    init(_ box: CGRect, leading: Bool, trailing: Bool) {
        self.box = box; self.leading = leading; self.trailing = trailing
    }
    override var rect: CGRect { box }
    override var writingDirection: NSWritingDirection { .leftToRight }
    override var containsStart: Bool { leading }
    override var containsEnd: Bool { trailing }
    override var isVertical: Bool { false }
}

/// Experimental single display/layout/input owner. No hidden UITextView, attachment
/// text renderer, parser, network, or production call site. LTR fixture only.
/// Feasibility fixture only; no production migration or parser authority.
final class R0DocumentView: UIView, UITextInput, UIGestureRecognizerDelegate {
    private struct Line {
        let text: CTLine
        let range: NSRange
        let origin: CGPoint
        let width: CGFloat
        let table: Bool
    }
    private(set) var document = R0Document.fixture
    private var lines: [Line] = []
    private var cells: [CGRect] = []
    private(set) var tableRect = CGRect.zero
    private(set) var tableWidth: CGFloat = 0
    private(set) var tableOffset: CGFloat = 0
    private(set) var measuredHeight: CGFloat = 0
    var font = UIFont.preferredFont(forTextStyle: .body) { didSet { rebuild() } }
    var imageHeight: CGFloat = 0 { didSet { rebuild() } }
    var onLayoutChange: (() -> Void)?
    var onSelectionChange: (() -> Void)?
    /// Host supplies visible rect in this view's window coordinate space.
    var selectionViewportInWindow: (() -> CGRect)?
    /// Positive request scrolls content upward. Host applies its own policy and
    /// bounds synchronously and returns actual content-offset delta (may be zero).
    var requestSelectionScroll: ((CGFloat) -> CGFloat)?
    lazy var selectionEdge = R0SelectionEdge(document: self)
    private let pointerObserver = R0PointerObserver()
    private weak var pointerWindow: UIWindow?
    private var readingElements: [R0ReadingElement] = []
    private var readingByID: [String: R0ReadingElement] = [:]
    private var selection: R0Range?
    private var lastWidth: CGFloat = 0
    private var panStart: CGFloat = 0
    private lazy var tablePan = UIPanGestureRecognizer(target: self, action: #selector(panTable(_:)))
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
    var beginningOfDocument: UITextPosition { R0Position(0) }
    var endOfDocument: UITextPosition { R0Position(length) }
    var hasText: Bool { length > 0 }
    var isEditable: Bool { false }
    var textInputView: UIView { self }
    private var length: Int { (document.plain as NSString).length }
    private var pitch: CGFloat { ceil(font.lineHeight * 1.15) }
    override var canBecomeFirstResponder: Bool { true }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemBackground
        isOpaque = true
        accessibilityIdentifier = "r0-document"
        accessibilityTraits = .staticText
        interaction.textInput = self
        addInteraction(interaction)
        for gesture in interaction.gesturesForFailureRequirements {
            gesture.addTarget(self, action: #selector(nativeGestureChanged(_:)))
        }
        tablePan.delegate = self
        addGestureRecognizer(tablePan)
        pointerObserver.cancelsTouchesInView = false
        pointerObserver.delaysTouchesBegan = false
        pointerObserver.delaysTouchesEnded = false
        pointerObserver.sample = { [weak self] point in self?.observePointer(point) }
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (view: R0DocumentView, _: UITraitCollection) in
            view.font = .preferredFont(forTextStyle: .body, compatibleWith: view.traitCollection)
        }
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
            window?.addGestureRecognizer(pointerObserver)
        }
    }
    @objc private func nativeGestureChanged(_ gesture: UIGestureRecognizer) {
        selectionEdge.nativeGestureChanged(gesture.state, id: ObjectIdentifier(gesture))
    }
    private func observePointer(_ point: CGPoint?) {
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
            if let handle { anchor = handle.direction.contains(.leading) ? NSMaxRange(selection.value) : selection.value.location }
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
    }

    /// R0 mutation contract: append-only text preserves all existing UTF-16 positions.
    /// Reinterpretation/deletion mapping is deliberately not claimed by this probe.
    func append(_ text: String) {
        inputDelegate?.textWillChange(self)
        document.after += text
        rebuild()
        inputDelegate?.textDidChange(self)
    }

    private func rebuild() {
        guard bounds.width > 0 else { return }
        lastWidth = bounds.width
        lines.removeAll(); cells.removeAll(); readingElements.removeAll()
        var y: CGFloat = 12
        var index = 0
        func add(_ string: String, x: CGFloat, width: CGFloat, table: Bool) -> CGFloat {
            let attributed = NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: UIColor.label])
            let typesetter = CTTypesetterCreateWithAttributedString(attributed)
            var start = 0
            var lineY = y
            while start < attributed.length {
                let count = max(1, CTTypesetterSuggestLineBreak(typesetter, start, Double(width)))
                let line = CTTypesetterCreateLine(typesetter, CFRange(location: start, length: count))
                lines.append(Line(text: line, range: NSRange(location: index + start, length: count), origin: CGPoint(x: x, y: lineY), width: table ? width : CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)), table: table))
                start += count; lineY += pitch
            }
            index += attributed.length
            return max(pitch, lineY - y)
        }
        func reading(_ id: String, _ text: String, table: Bool, label: String? = nil) {
            let element = readingByID[id] ?? R0ReadingElement(document: self, id: id)
            element.range = NSRange(location: index, length: (text as NSString).length)
            element.accessibilityLabel = label ?? text
            element.table = table
            readingByID[id] = element
            readingElements.append(element)
        }
        reading("r0-prose-before", document.before, table: false)
        y += add(document.before, x: 12, width: max(1, bounds.width - 24), table: false) + 16
        index += 1
        let top = y
        // Intrinsic, uncompressed columns. Longest cell determines width in this
        // bounded fixture; production wrapping/large-document layout is not proven.
        let widths = document.rows[0].indices.map { column in
            max(100, document.rows.map { row in
                (row[column] as NSString).size(withAttributes: [.font: font]).width + 24
            }.max() ?? 100)
        }
        tableWidth = widths.reduce(0, +)
        for (rowIndex, row) in document.rows.enumerated() {
            var x: CGFloat = 12
            for (column, cell) in row.enumerated() {
                reading("r0-cell-\(rowIndex)-\(column)", cell, table: true,
                        label: "Row \(rowIndex + 1), \(document.rows[0][column]): \(cell)")
                _ = add(cell, x: x + 12, width: widths[column] - 24, table: true)
                cells.append(CGRect(x: x, y: y - 6, width: widths[column], height: pitch + 12))
                x += widths[column]
                index += 1
            }
            y += pitch + 12
        }
        tableRect = CGRect(x: 12, y: top - 6, width: max(1, bounds.width - 24), height: y - top)
        y += 16
        reading("r0-prose-after", document.after, table: false)
        y += add(document.after, x: 12, width: max(1, bounds.width - 24), table: false)
        measuredHeight = y + imageHeight + 24
        setTableOffset(tableOffset)
        invalidateIntrinsicContentSize()
        setNeedsDisplay()
        selectionDisplay?.setNeedsSelectionUpdate()
        onLayoutChange?()
        selectionEdge.geometryChanged()
    }
    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: measuredHeight) }

    func setTableOffset(_ offset: CGFloat) {
        tableOffset = min(max(0, offset), max(0, tableWidth - tableRect.width))
        setNeedsDisplay()
        selectionDisplay?.setNeedsSelectionUpdate()
    }
    var remainingLeft: Bool { tableOffset > 0 }
    var remainingRight: Bool { tableOffset < tableWidth - tableRect.width }
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === tablePan else { return true }
        let v = tablePan.velocity(in: self)
        return tableRect.contains(tablePan.location(in: self)) && abs(v.x) > abs(v.y)
    }
    @objc private func panTable(_ pan: UIPanGestureRecognizer) {
        if pan.state == .began { panStart = tableOffset }
        setTableOffset(panStart - pan.translation(in: self).x)
    }
    private func origin(_ line: Line) -> CGPoint {
        CGPoint(x: line.origin.x - (line.table ? tableOffset : 0), y: line.origin.y)
    }
    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        context.saveGState()
        context.clip(to: tableRect)
        UIColor.secondarySystemBackground.setFill()
        context.fill(tableRect)
        UIColor.separator.setStroke()
        for cell in cells { context.stroke(cell.offsetBy(dx: -tableOffset, dy: 0), width: 0.5) }
        context.restoreGState()
        for line in lines {
            context.saveGState()
            if line.table { context.clip(to: tableRect) }
            let point = origin(line)
            context.textMatrix = .identity
            context.translateBy(x: point.x, y: point.y + font.ascender)
            context.scaleBy(x: 1, y: -1)
            context.textPosition = .zero
            CTLineDraw(line.text, context)
            context.restoreGState()
        }
        for (show, x, reverse) in [(remainingLeft, tableRect.minX, false), (remainingRight, tableRect.maxX - 12, true)] where show {
            context.saveGState()
            context.clip(to: CGRect(x: x, y: tableRect.minY, width: 12, height: tableRect.height))
            let colors = [UIColor.black.withAlphaComponent(0.25).cgColor, UIColor.clear.cgColor] as CFArray
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
            context.drawLinearGradient(gradient, start: CGPoint(x: reverse ? x + 12 : x, y: 0), end: CGPoint(x: reverse ? x : x + 12, y: 0), options: [])
            context.restoreGState()
        }
        if imageHeight > 0 {
            // Controlled delayed-media geometry; no URL, fetch, or cache bypass.
            let image = UIImage(systemName: "photo")
            image?.draw(in: CGRect(x: 12, y: measuredHeight - imageHeight - 12, width: 100, height: imageHeight))
        }
    }

    var selectedTextRange: UITextRange? {
        get { selection }
        set {
            inputDelegate?.selectionWillChange(self)
            selection = newValue as? R0Range
            selectionDisplay?.isActivated = selection != nil
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
        return R0Range(NSRange(location: min(a, b), length: abs(b - a)))
    }
    func position(from position: UITextPosition, offset: Int) -> UITextPosition? {
        let next = idx(position) + offset
        return (0...length).contains(next) ? R0Position(next) : nil
    }
    func position(from position: UITextPosition, in direction: UITextLayoutDirection, offset: Int) -> UITextPosition? {
        if direction == .left || direction == .right {
            return self.position(from: position, offset: direction == .left ? -offset : offset)
        }
        let rect = caretRect(for: position)
        return closestPosition(to: CGPoint(x: rect.midX, y: rect.midY + CGFloat(direction == .up ? -offset : offset) * pitch))
    }
    func compare(_ position: UITextPosition, to other: UITextPosition) -> ComparisonResult {
        idx(position) == idx(other) ? .orderedSame : (idx(position) < idx(other) ? .orderedAscending : .orderedDescending)
    }
    func offset(from: UITextPosition, to: UITextPosition) -> Int { idx(to) - idx(from) }
    func position(within range: UITextRange, farthestIn direction: UITextLayoutDirection) -> UITextPosition? {
        direction == .left || direction == .up ? range.start : range.end
    }
    func characterRange(byExtending position: UITextPosition, in direction: UITextLayoutDirection) -> UITextRange? {
        let index = idx(position) - (direction == .left || direction == .up ? 1 : 0)
        guard index >= 0, index < length else { return nil }
        return R0Range((document.plain as NSString).rangeOfComposedCharacterSequence(at: index))
    }
    func baseWritingDirection(for position: UITextPosition, in direction: UITextStorageDirection) -> NSWritingDirection { .leftToRight }
    func setBaseWritingDirection(_ writingDirection: NSWritingDirection, for range: UITextRange) {}
    private func idx(_ position: UITextPosition) -> Int { (position as! R0Position).index }
    private func ns(_ range: UITextRange) -> NSRange { (range as! R0Range).value }
    func firstRect(for range: UITextRange) -> CGRect { selectionRects(for: range).first?.rect ?? caretRect(for: range.start) }
    func caretRect(for position: UITextPosition) -> CGRect {
        let index = idx(position)
        guard let line = lines.first(where: { NSLocationInRange(index, $0.range) }) ?? lines.last(where: { NSMaxRange($0.range) <= index }) else { return .zero }
        let start = CTLineGetStringRange(line.text).location
        let x = CTLineGetOffsetForStringIndex(line.text, start + min(line.range.length, max(0, index - line.range.location)), nil)
        let point = origin(line)
        return CGRect(x: point.x + x, y: point.y, width: 2, height: pitch)
    }
    func selectionRects(for range: UITextRange) -> [UITextSelectionRect] {
        let selected = ns(range)
        return lines.compactMap { line in
            let intersection = NSIntersectionRange(selected, line.range)
            guard intersection.length > 0 else { return nil }
            let start = CTLineGetStringRange(line.text).location
            let a = CTLineGetOffsetForStringIndex(line.text, start + intersection.location - line.range.location, nil)
            let b = CTLineGetOffsetForStringIndex(line.text, start + NSMaxRange(intersection) - line.range.location, nil)
            let point = origin(line)
            var box = CGRect(x: point.x + min(a, b), y: point.y, width: abs(b - a), height: pitch)
            if line.table { box = box.intersection(tableRect) }
            guard !box.isNull else { return nil }
            return R0SelectionRect(box, leading: intersection.location == selected.location, trailing: NSMaxRange(intersection) == NSMaxRange(selected))
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
        return R0Position((document.plain as NSString).rangeOfComposedCharacterSequence(at: absolute).location)
    }
    private func distance(_ point: CGPoint, _ line: Line) -> CGFloat {
        let p = origin(line)
        let dy = max(0, abs(point.y - (p.y + pitch / 2)) - pitch / 2)
        let dx = max(0, p.x - point.x, point.x - p.x - line.width)
        return dy * dy * 100 + dx * dx
    }
    func closestPosition(to point: CGPoint, within range: UITextRange) -> UITextPosition? {
        guard let position = closestPosition(to: point) else { return nil }
        return R0Position(max(idx(range.start), min(idx(range.end), idx(position))))
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
        get { readingElements.filter { !$0.accessibilityFrame.isEmpty } }
        set {}
    }
    func readingFrame(_ range: NSRange) -> CGRect {
        guard let window else { return .zero }
        let rect = selectionRects(for: R0Range(range)).reduce(CGRect.null) { $0.union($1.rect) }
        guard !rect.isNull else { return .zero }
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
        UIAccessibility.post(notification: .layoutChanged, argument: readingElements.first { $0.table && !$0.accessibilityFrame.isEmpty })
        return true
    }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        (action == #selector(copy(_:)) && selection?.isEmpty == false) || action == #selector(selectAll(_:))
    }
    override func copy(_ sender: Any?) {
        guard let selection else { return }
        UIPasteboard.general.string = document.plain(in: selection.value)
    }
    override func selectAll(_ sender: Any?) {
        selectedTextRange = R0Range(NSRange(location: 0, length: length))
    }
    func copyTableMarkdown() { UIPasteboard.general.string = document.tableMarkdown }
}
