import Observation
import MobileData
import SwiftUI
import UIKit

/// Small display-only values rebuilt from the latest projection. No event
/// objects, occurrence snapshots or callbacks enter the Canvas render graph.
private struct CalendarDateInk: Equatable {
    let count: Int
    let importance: Importance?
    let marks: [Color]
    let overflow: Int
}

private struct CalendarMonthInk {
    let civil: CalendarCivilMonth
    let days: [String: CalendarDateInk]
    let status: String?
    let today: String
    let selected: String
    var progress: CGFloat
    let dateSize: CGFloat
    let rtl: Bool
    let contrast: Bool
    let focused: Int?
    let compactSize: CGSize
    let expandedSize: CGSize

    private var headingSize: CGFloat { CalendarNativeMonthGeometry.headingHeight(dateSize: dateSize) }
    private var compactWeekdaySize: CGFloat {
        CalendarNativeMonthGeometry.compactWeekdayHeight(dateSize: dateSize)
    }
    private var ownedRows: CGFloat { CGFloat(civil.ownedRowCount) }

    func headingRect(size _: CGSize) -> CGRect {
        let compact = CGRect(x: Space.md, y: Space.md,
                             width: max(0, compactSize.width - Space.md * 2), height: headingSize)
        let expanded = CGRect(x: 0, y: 0, width: expandedSize.width, height: headingSize)
        return interpolate(compact, expanded, progress)
    }

    private func compactDateRect(_ index: Int) -> CGRect {
        let width = max(0, compactSize.width - Space.md * 2) / 7
        let top = Space.md + headingSize + compactWeekdaySize
        let height = max(0, compactSize.height - top - Space.md) /
            CGFloat(CalendarNativeMonthGeometry.compactRowCount)
        let column = rtl ? 6 - index % 7 : index % 7
        return CGRect(x: Space.md + CGFloat(column) * width,
                      y: top + CGFloat(index / 7) * height,
                      width: width, height: height)
    }

    private func expandedDateRect(_ index: Int) -> CGRect {
        let width = max(0, expandedSize.width) / 7
        let top = headingSize
        let height = max(0, expandedSize.height - top) / max(CGFloat(1), ownedRows)
        let column = rtl ? 6 - index % 7 : index % 7
        return CGRect(x: CGFloat(column) * width,
                      y: top + CGFloat(index / 7) * height,
                      width: width, height: height)
    }

    func dateRect(_ index: Int, size _: CGSize) -> CGRect {
        // Endpoint sizes remain explicit so interior geometry follows the same
        // morph rather than recomputing a six-row fit from current bounds.
        return interpolate(compactDateRect(index), expandedDateRect(index), progress)
    }

    func dateNumberCenter(for index: Int, size: CGSize) -> CGPoint {
        CalendarNativeMonthGeometry.dateNumberCenter(in: dateRect(index, size: size), dateSize: dateSize)
    }

    func significanceCenter(for index: Int, size: CGSize) -> CGPoint {
        CalendarNativeMonthGeometry.significanceCenter(in: dateRect(index, size: size), dateSize: dateSize)
    }

    private func interpolate(_ a: CGRect, _ b: CGRect, _ p: CGFloat) -> CGRect {
        CGRect(x: a.minX + (b.minX - a.minX) * p,
               y: a.minY + (b.minY - a.minY) * p,
               width: a.width + (b.width - a.width) * p,
               height: a.height + (b.height - a.height) * p)
    }
}

@Observable
private final class CalendarMonthRenderModel {
    var content: CalendarMonthInk?
    // A local drawing scalar, never observable viewport geometry.
    var progress: CGFloat = 1
    var arrivalRevision = 0
    var arrivingDates: Set<String> = []

    var ink: CalendarMonthInk? {
        guard var ink = content else { return nil }
        ink.progress = progress
        return ink
    }
}

private struct CalendarMonthDrawing: View {
    let model: CalendarMonthRenderModel
    var body: some View {
        Color.clear.keyframeAnimator(initialValue: CGFloat(1), trigger: model.arrivalRevision) { _, opacity in
            drawing(arrivalOpacity: opacity)
        } keyframes: { _ in
            MoveKeyframe(CGFloat.zero)
            LinearKeyframe(CGFloat(1), duration: Motion.normal)
        }
    }

    private func drawing(arrivalOpacity: CGFloat) -> some View {
        let ink = model.ink
        let arrivingDates = model.arrivingDates
        return Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, size in
            guard let ink else { return }
            let p = ink.progress
            let line = ink.contrast ? DuskColors.ink3 : DuskColors.lineSoft
            let face = RoundedRectangle(cornerRadius: Radii.md * (1 - p)).path(in: CGRect(origin: .zero, size: size))
            var plate = context
            plate.opacity = Double(1 - p)
            plate.fill(face, with: .color(DuskColors.bgSunk))
            plate.fill(face, with: .color(DuskColors.bgElev.opacity(CalendarSurfaceLayout.yearFaceOpacity)))
            plate.stroke(face, with: .color(line), lineWidth: DesignMetrics.hairline)
            if ink.focused != nil && p == 0 {
                context.stroke(face, with: .color(DuskColors.accent), lineWidth: 2)
            }

            let title = Text(ink.civil.title).font(Typo.display(TypeScale.lg, .medium)).foregroundColor(DuskColors.ink)
            let headingRect = ink.headingRect(size: size)
            var heading = context
            heading.draw(title,
                         at: CGPoint(x: ink.rtl ? headingRect.maxX - Space.sm : headingRect.minX + Space.sm,
                                     y: headingRect.midY),
                         anchor: ink.rtl ? .trailing : .leading)
            if p < 1 {
                var labels = context
                labels.opacity = Double(1 - p)
                let labelY = Space.md + CalendarNativeMonthGeometry.headingHeight(dateSize: ink.dateSize) +
                    CalendarNativeMonthGeometry.compactWeekdayHeight(dateSize: ink.dateSize) / 2
                for index in 0..<7 {
                    let rect = ink.dateRect(index, size: size)
                    labels.draw(Text(ink.civil.weekdays[index]).font(Typo.ui(TypeScale.sm)).foregroundColor(DuskColors.ink2),
                                at: CGPoint(x: rect.midX, y: labelY))
                }
            }

            let visibleRows = ink.civil.ownedRowCount
            for (index, slot) in ink.civil.slots.enumerated()
                where index / 7 < visibleRows {
                let rect = ink.dateRect(index, size: size)
                var cell = context
                // Partial boundary cells retain the grid's shape but never
                // render or own a neighboring month's date.
                cell.fill(Path(rect), with: .color(DuskColors.bgElev.opacity(CalendarSurfaceLayout.monthCellFaceOpacity * Double(p))))
                if !slot.outside, slot.date == ink.selected {
                    cell.fill(Path(rect), with: .color(DuskColors.accent50.opacity(CalendarSurfaceLayout.monthSelectionOpacity)))
                    cell.stroke(Path(rect.insetBy(dx: DesignMetrics.hairline, dy: DesignMetrics.hairline)),
                                with: .color(DuskColors.accent.opacity(ink.contrast ? 1 : CalendarSurfaceLayout.monthSelectionLineOpacity)), lineWidth: DesignMetrics.hairline)
                }
                if !slot.outside, ink.focused == index && p > 0 {
                    cell.stroke(Path(rect.insetBy(dx: 2, dy: 2)), with: .color(DuskColors.accent), lineWidth: 2)
                }
                if p > 0 {
                    cell.stroke(Path(rect), with: .color(line.opacity(Double(p))), lineWidth: CalendarSurfaceLayout.monthGridLineWidth)
                }
                guard !slot.outside else { continue }

                let isToday = slot.date == ink.today
                let number = ink.dateNumberCenter(for: index, size: size)
                let numberColor = isToday ? DuskColors.accent : DuskColors.ink2
                // Font size was scaled by the component's environment once;
                // do not apply Dynamic Type a second time in the hosting view.
                cell.draw(Text(slot.number).font(.custom(DesignTypographyAdapter.monoFamily, fixedSize: ink.dateSize)).foregroundColor(numberColor),
                          at: number)
                if let day = ink.days[slot.date], day.count > 0 {
                    if arrivingDates.contains(slot.date) { cell.opacity *= Double(arrivalOpacity) }
                    let significance = ink.significanceCenter(for: index, size: size)
                    let significanceColor = importanceColor(day.importance)
                    let yearDot = CGRect(x: significance.x - CalendarSurfaceLayout.indicatorSize / 2,
                                         y: significance.y - CalendarSurfaceLayout.indicatorSize / 2,
                                         width: CalendarSurfaceLayout.indicatorSize,
                                         height: CalendarSurfaceLayout.indicatorSize)
                    cell.fill(Path(ellipseIn: yearDot),
                              with: .color(significanceColor.opacity(Double(1 - p))))
                    if p > CalendarSurfaceLayout.indicatorRevealStart {
                        var detail = cell
                        detail.opacity *= Double((p - CalendarSurfaceLayout.indicatorRevealStart) /
                                                 (1 - CalendarSurfaceLayout.indicatorRevealStart))
                        let counter = detail.resolve(Text("+\(day.overflow)").font(.custom(DesignTypographyAdapter.monoFamily, fixedSize: ink.dateSize)).foregroundColor(DuskColors.ink2))
                        let counterWidth = day.overflow > 0
                            ? counter.measure(in: CGSize(width: CGFloat.greatestFiniteMagnitude,
                                                         height: CGFloat.greatestFiniteMagnitude)).width : 0
                        let diameter = CalendarSurfaceLayout.indicatorSize
                        let gap = Space.xs
                        let overflowGap = day.overflow > 0 && !day.marks.isEmpty ? gap : 0
                        let marksWidth = CalendarNativeMonthGeometry.markerGroupWidth(
                            markCount: day.marks.count, diameter: diameter, gap: gap)
                        let totalWidth = CalendarNativeMonthGeometry.markerGroupWidth(
                            markCount: day.marks.count, diameter: diameter, gap: gap,
                            overflowWidth: counterWidth, overflowGap: overflowGap)
                        let availableWidth = max(0, rect.width - Space.xs * 2)
                        if totalWidth > availableWidth {
                            detail.draw(Text("\(day.count)").font(.custom(DesignTypographyAdapter.monoFamily, fixedSize: ink.dateSize)).foregroundColor(DuskColors.ink2),
                                        at: significance)
                        } else {
                            let start = rect.midX - totalWidth / 2
                            var dotsStart = start
                            if ink.rtl, day.overflow > 0 {
                                detail.draw(counter, at: CGPoint(x: start, y: significance.y), anchor: .leading)
                                dotsStart += counterWidth + overflowGap
                            }
                            let orderedMarks = ink.rtl ? Array(day.marks.reversed()) : day.marks
                            for (markIndex, color) in orderedMarks.enumerated() {
                                let dot = CGRect(x: dotsStart + CGFloat(markIndex) * (diameter + gap),
                                                 y: significance.y - diameter / 2,
                                                 width: diameter, height: diameter)
                                detail.fill(Path(ellipseIn: dot), with: .color(color))
                            }
                            if !ink.rtl, day.overflow > 0 {
                                detail.draw(counter,
                                            at: CGPoint(x: start + marksWidth + overflowGap, y: significance.y),
                                            anchor: .leading)
                            }
                        }
                    }
                }
            }
            if ink.status == "Unavailable", let status = ink.status {
                // Explicit unknown state, never an empty-event illustration.
                // No separate rail changes the viewport's native geometry.
                // Keep unknown-state ink inside a fully owned week, not a trailing
                // blank row which overlaps the next civil month's dates.
                let lastOwned = ink.civil.slots.lastIndex { !$0.outside }!
                let rowStartIndex = lastOwned / 7 * 7
                let rowStart = ink.dateRect(rowStartIndex, size: size)
                let rowEnd = ink.dateRect(rowStartIndex + 6, size: size)
                let statusRect = rowStart.union(rowEnd)
                var statusContext = context
                statusContext.clip(to: Path(statusRect))
                statusContext.draw(Text(status).font(Typo.ui(TypeScale.sm)).foregroundColor(DuskColors.ink2),
                             at: CGPoint(x: statusRect.midX, y: statusRect.maxY - Space.xs), anchor: .bottom)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private func importanceColor(_ importance: Importance?) -> Color {
    switch importance {
    case .pinned: return DuskColors.accent
    case .important: return DuskColors.amber
    case .normal, nil: return DuskColors.sage
    }
}

final class CalendarReusableMonthCell: UICollectionViewCell {
    private let control = CalendarMonthControl()
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        contentView.addSubview(control)
        control.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        control.frame = contentView.bounds
        isAccessibilityElement = false
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    // The CELL must pass through too: returning nil only from its control
    // would leave contentView swallowing the neighboring owner's date.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        super.point(inside: point, with: event) &&
            control.point(inside: control.convert(point, from: self), with: event)
    }
    override func prepareForReuse() { super.prepareForReuse(); clear() }
    func clear() { control.clear() }
    @discardableResult
    func focusForKeyboard(date: String? = nil) -> CGRect? {
        guard let rect = control.focusForKeyboard(date: date) else { return nil }
        return control.convert(rect, to: self)
    }
    func configure(month: CalendarCivilMonth, period: CalendarViewportMonthData?, today: String, selected: String,
                   progress: CGFloat, expanded: Bool, dateSize: CGFloat, rightToLeft: Bool, contrast: Bool,
                   enabled: Bool, contentVersion: Int, moveMonth: @escaping (Int) -> Void,
                   moveDate: @escaping (String) -> Void = { _ in }, activate: @escaping (String?) -> Void,
                   compactSize: CGSize? = nil, expandedSize: CGSize? = nil, reduceMotion: Bool = false) {
        control.configure(month: month, period: period, today: today, selected: selected, progress: progress,
                          expanded: expanded, dateSize: dateSize, rightToLeft: rightToLeft, contrast: contrast,
                          enabled: enabled, contentVersion: contentVersion, moveMonth: moveMonth, moveDate: moveDate, activate: activate,
                          compactSize: compactSize, expandedSize: expandedSize, reduceMotion: reduceMotion)
    }
}

/// One control per MONTH. Drawn dates are accessibility elements, not views.
/// Its native responder handles touch, keyboard, focus and VoiceOver activation.
private final class CalendarMonthControl: UIControl {
    private let model = CalendarMonthRenderModel()
    private var ink: CalendarMonthInk? { model.ink }
    private var semanticInput: SemanticInput?
    private var lastAccessibilityBounds: CGRect?
    private struct SemanticInput: Equatable {
        let month: CalendarViewportMonth
        let version: Int
        let today: String
        let selected: String
        let expanded: Bool
        let enabled: Bool
        let dateSize: CGFloat
        let rtl: Bool
        let contrast: Bool
        let compactSize: CGSize
        let expandedSize: CGSize
        let reduceMotion: Bool
    }
    private var action: ((String?) -> Void)?
    private var moveMonth: ((Int) -> Void)?
    private var moveDate: ((String) -> Void)?
    private var expanded = false
    private var keyboardIndex: Int?
    private var headingElement: CalendarMonthHeadingAccessibilityElement?
    private var elements: [CalendarDateAccessibilityElement] = []
    private var semanticKey = ""
    private var contentVersion: Int?
    private var preparedDays: [String: CalendarDateInk] = [:]
    private var hosting: (UIView & UIContentView)?
    override var canBecomeFirstResponder: Bool { isEnabled }
    override var canBecomeFocused: Bool { isEnabled }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = false
        isEnabled = false
        addTarget(self, action: #selector(primaryAction), for: .primaryActionTriggered)
        installHosting()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(month: CalendarCivilMonth, period: CalendarViewportMonthData?, today: String, selected: String,
                   progress: CGFloat, expanded: Bool, dateSize: CGFloat, rightToLeft: Bool, contrast: Bool,
                   enabled: Bool, contentVersion: Int, moveMonth: @escaping (Int) -> Void,
                   moveDate: @escaping (String) -> Void = { _ in }, activate: @escaping (String?) -> Void,
                   compactSize: CGSize? = nil, expandedSize: CGSize? = nil, reduceMotion: Bool = false) {
        let compactGeometry = compactSize ?? bounds.size
        let expandedGeometry = expandedSize ?? bounds.size
        let next = SemanticInput(month: month.id, version: contentVersion, today: today, selected: selected,
                                 expanded: expanded, enabled: enabled, dateSize: dateSize,
                                 rtl: rightToLeft, contrast: contrast, compactSize: compactGeometry, expandedSize: expandedGeometry, reduceMotion: reduceMotion)
        model.progress = progress
        // The hot path does not prepare content, assign hosting configuration,
        // replace callbacks, or touch accessibility labels/elements.
        guard semanticInput != next else { return }
        if ink?.civil.id != month.id { clear() }
        semanticInput = next
        model.progress = progress
        self.expanded = expanded
        isEnabled = enabled
        action = activate
        self.moveMonth = moveMonth
        self.moveDate = moveDate
        let period = period?.validated(for: month)
        if self.contentVersion != contentVersion {
            self.contentVersion = contentVersion
            let nextDays = Dictionary((period?.cells ?? []).map { day in
                let importance: Importance? = day.events.contains { $0.importance == .pinned } ? .pinned :
                    day.events.contains { $0.importance == .important } ? .important : day.events.isEmpty ? nil : .normal
                let marks: [Color] = day.indicators.prefix(2).map { indicator in
                    let event = day.events.first { $0.actionIdentity.stableKey == indicator.actionIdentity.stableKey }
                    if event?.importance == .pinned { return DuskColors.accent }
                    if event?.importance == .important { return DuskColors.amber }
                    return event == nil && indicator.kind == .allDay ? DuskColors.amber : DuskColors.sage
                }
                return (day.date, CalendarDateInk(count: day.events.count,
                                                 importance: importance, marks: marks,
                                                 overflow: Int(day.overflow?.count ?? 0) + max(0, day.indicators.count - 2)))
            }, uniquingKeysWith: { _, latest in latest })
            if nextDays != preparedDays {
                let arrivals = Set(nextDays.filter { key, day in
                    day.count > 0 && preparedDays[key] == nil
                }.keys)
                model.arrivingDates = !reduceMotion && model.content != nil ? arrivals : []
                if !model.arrivingDates.isEmpty { model.arrivalRevision &+= 1 }
                preparedDays = nextDays
            }
        }
        if reduceMotion { model.arrivingDates.removeAll() }
        let status: String?
        switch period?.availability {
        case .ready: status = nil
        case .unavailable: status = "Unavailable"
        case .loading, nil: status = "Event data not loaded"
        }
        model.content = CalendarMonthInk(civil: month, days: preparedDays, status: status, today: today, selected: selected,
                               progress: progress, dateSize: dateSize, rtl: rightToLeft, contrast: contrast,
                               focused: keyboardIndex, compactSize: compactGeometry, expandedSize: expandedGeometry)
        hosting?.isHidden = false
        updateAccessibility()
    }

    private func installHosting() {
        let configuration = UIHostingConfiguration {
            CalendarMonthDrawing(model: model)
                .transaction { transaction in
                    transaction.animation = nil
                }
        }.margins(.all, 0)
        let hosted = configuration.makeContentView()
        hosted.backgroundColor = .clear
        hosted.isUserInteractionEnabled = false
        hosted.accessibilityElementsHidden = true
        addSubview(hosted)
        hosting = hosted
        hosted.frame = bounds
        hosted.isHidden = true
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        hosting?.frame = bounds
        // No AX frame loop for fractional layout samples. Endpoint resizing
        // updates frames once; scrolling uses container-relative native frames.
        guard isEnabled, expanded, model.progress == 1,
              lastAccessibilityBounds != bounds else { return }
        updateAccessibilityFrames()
    }
    func clear() {
        guard model.content != nil || semanticInput != nil else { return }
        // Hide synchronously before the next SwiftUI render commit, including
        // mid-transition revocation. The empty model/host is safe to reuse.
        hosting?.isHidden = true
        model.content = nil
        model.arrivingDates.removeAll()
        semanticInput = nil
        lastAccessibilityBounds = nil
        preparedDays.removeAll()
        contentVersion = nil
        action = nil
        moveMonth = nil
        moveDate = nil
        keyboardIndex = nil
        clearElements()
        semanticKey = ""
        accessibilityElements = nil
        accessibilityLabel = nil
        accessibilityValue = nil
        isAccessibilityElement = false
        isEnabled = false
    }
    private func clearElements() {
        headingElement?.accessibilityLabel = nil
        headingElement?.accessibilityValue = nil
        headingElement = nil
        for element in elements {
            element.owner = nil
            element.accessibilityLabel = nil
            element.accessibilityValue = nil
        }
        elements.removeAll()
    }
    private func updateAccessibility() {
        guard isEnabled, let ink else {
            clearElements()
            semanticKey = ""
            accessibilityElements = nil
            accessibilityLabel = nil
            accessibilityValue = nil
            isAccessibilityElement = false
            return
        }
        if !expanded {
            isAccessibilityElement = true
            accessibilityLabel = ink.civil.title
            let eventDays = ink.civil.slots.filter { !$0.outside && (ink.days[$0.date]?.count ?? 0) > 0 }.count
            accessibilityValue = ink.status ?? "\(eventDays) event days"
            accessibilityHint = "Opens month view"
            accessibilityTraits = .button
            accessibilityIdentifier = "calendar-year-month-\(ink.civil.id.month)"
            accessibilityElements = nil
            clearElements()
            semanticKey = ""
            return
        }
        isAccessibilityElement = false
        accessibilityIdentifier = "calendar-month-42-cells"
        let key = "\(ink.civil.id.date)|month"
        if semanticKey != key {
            semanticKey = key
            clearElements()
            let heading = CalendarMonthHeadingAccessibilityElement(accessibilityContainer: self)
            heading.accessibilityIdentifier = "calendar-month-heading-\(ink.civil.id.date)"
            headingElement = heading
            elements = ink.civil.slots.enumerated().filter { !$0.element.outside }.map { index, slot in
                let element = CalendarDateAccessibilityElement(accessibilityContainer: self)
                element.owner = self
                element.date = slot.date
                element.month = ink.civil.id
                element.index = index
                element.accessibilityIdentifier = "calendar-date-\(slot.date)"
                return element
            }
        }
        headingElement?.accessibilityLabel = ink.civil.title
        headingElement?.accessibilityTraits = .header
        for element in elements {
            let slot = ink.civil.slots[element.index]
            // Projected labels/flags may lag current presentation. Keep only
            // event display values; compose roles once from current input.
            var label = slot.label
            if let day = ink.days[slot.date] {
                label += ", \(day.count) \(day.count == 1 ? "event" : "events")"
                if day.overflow > 0 { label += ", +\(day.overflow) more" }
            } else {
                label += ink.status == "Unavailable" ? ", Event data unavailable" : ", Event data not loaded"
            }
            if slot.date == ink.today { label += ", Today" }
            if slot.date == ink.selected { label += ", Selected" }
            element.accessibilityLabel = label
            element.accessibilityHint = "Opens day view"
            element.accessibilityTraits = slot.date == ink.selected ? [.button, .selected] : .button
        }
        var accessible: [UIAccessibilityElement] = []
        if let headingElement { accessible.append(headingElement) }
        accessible.append(contentsOf: elements)
        accessibilityElements = accessible
        updateAccessibilityFrames()
    }
    private func updateAccessibilityFrames() {
        guard isEnabled, expanded, model.progress == 1, let ink else { return }
        lastAccessibilityBounds = bounds
        headingElement?.accessibilityFrameInContainerSpace = ink.headingRect(size: bounds.size)
        for element in elements {
            element.accessibilityFrameInContainerSpace = ink.dateRect(element.index, size: bounds.size)
        }
    }
    fileprivate func activate(date: String?, month: CalendarViewportMonth? = nil) -> Bool {
        guard isEnabled, month == nil || month == ink?.civil.id else { return false }
        if let date, ink?.civil.slots.contains(where: { !$0.outside && $0.date == date }) != true { return false }
        action?(date)
        return true
    }
    override func accessibilityActivate() -> Bool { activate(date: nil) }
    private var firstOwnedIndex: Int { ink?.civil.slots.firstIndex { !$0.outside } ?? 0 }
    private var lastOwnedIndex: Int { ink?.civil.slots.lastIndex { !$0.outside } ?? 0 }
    private func ownedIndex(at point: CGPoint) -> Int? {
        guard let ink else { return nil }
        return ink.civil.slots.indices.first {
            !ink.civil.slots[$0].outside && ink.dateRect($0, size: bounds.size).contains(point)
        }
    }
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard isEnabled, super.point(inside: point, with: event) else { return false }
        return !expanded || ownedIndex(at: point) != nil
    }
    override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
        super.endTracking(touch, with: event)
        guard let touch, bounds.contains(touch.location(in: self)), let ink else { return }
        becomeFirstResponder()
        if !expanded { _ = activate(date: nil); return }
        if let index = ownedIndex(at: touch.location(in: self)) {
            _ = activate(date: ink.civil.slots[index].date)
        }
    }
    @objc private func primaryAction() {
        guard let ink else { return }
        _ = activate(date: expanded ? ink.civil.slots[keyboardIndex ?? firstOwnedIndex].date : nil)
    }
    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand.inputLeftArrow, UIKeyCommand.inputRightArrow, UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow,
         "\r", " "].map { UIKeyCommand(input: $0, modifierFlags: [], action: #selector(key(_:))) }
    }
    @objc private func key(_ command: UIKeyCommand) {
        guard let ink, isEnabled else { return }
        if command.input == "\r" || command.input == " " { primaryAction(); return }
        let step: Int
        switch command.input {
        case UIKeyCommand.inputLeftArrow: step = ink.rtl ? 1 : -1
        case UIKeyCommand.inputRightArrow: step = ink.rtl ? -1 : 1
        case UIKeyCommand.inputUpArrow: step = -7
        default: step = 7
        }
        if !expanded { moveMonth?(step); return }
        let index = keyboardIndex ?? firstOwnedIndex
        let target = index + step
        if !(firstOwnedIndex...lastOwnedIndex).contains(target) {
            if let date = ink.civil.keyboardDate(from: index, step: step) { moveDate?(date) }
            return
        }
        // The same native date navigation path also keeps within-month
        // keyboard focus above floating controls (not just month crossings).
        moveDate?(ink.civil.slots[target].date)
    }
    func focusForKeyboard(date: String?) -> CGRect? {
        guard isEnabled, let ink else { return nil }
        let index: Int?
        if let date {
            guard expanded, let owned = ink.civil.slots.firstIndex(where: { !$0.outside && $0.date == date }) else { return nil }
            index = owned
        } else { index = nil }
        guard becomeFirstResponder() else { return nil }
        if let index { keyboardIndex = index; renderFocus() }
        return expanded ? ink.dateRect(keyboardIndex ?? firstOwnedIndex, size: bounds.size) : bounds
    }
    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        if result {
            keyboardIndex = ink?.civil.slots.firstIndex { !$0.outside && $0.date == ink?.selected } ?? firstOwnedIndex
            renderFocus()
        }
        return result
    }
    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result { keyboardIndex = nil; renderFocus() }
        return result
    }
    override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
        super.didUpdateFocus(in: context, with: coordinator)
        if isFocused { keyboardIndex = keyboardIndex ?? firstOwnedIndex }
        else if !isFirstResponder { keyboardIndex = nil }
        renderFocus()
    }
    private func renderFocus() {
        guard let ink else { return }
        model.content = CalendarMonthInk(civil: ink.civil, days: ink.days, status: ink.status, today: ink.today,
                                   selected: ink.selected, progress: ink.progress, dateSize: ink.dateSize,
                                   rtl: ink.rtl, contrast: ink.contrast, focused: keyboardIndex,
                                   compactSize: ink.compactSize, expandedSize: ink.expandedSize)
    }
}

private final class CalendarMonthHeadingAccessibilityElement: UIAccessibilityElement {}

private final class CalendarDateAccessibilityElement: UIAccessibilityElement {
    weak var owner: CalendarMonthControl?
    var date = ""
    var month: CalendarViewportMonth?
    var index = 0
    override func accessibilityActivate() -> Bool { owner?.activate(date: date, month: month) ?? false }
}
