import UIKit
import CoreText
import SwiftUI

/// Retained by transcript row identity, not a recycled cell. Measurement and
/// display ask for this exact object; terminal status is not a layout input.
@MainActor
final class MessageDocumentState {
    private(set) var document: MessageDocument
    private(set) var layout: MessageDocumentLayout?
    weak var mountedView: MessageDocumentView?
    var selection: NSRange?
    var tableOffsets: [UUID: CGFloat] = [:]

    init(source: String = "", literal: Bool = false) {
        document = MessageDocument(source: source, literal: literal)
    }
    func update(source: String, literal: Bool) {
        guard document.source != source || document.literal != literal else { return }
        let next = MessageDocument(source: source, literal: literal, previous: document)
        if let mountedView { mountedView.inputDelegate?.textWillChange(mountedView) }
        if let selection { self.selection = next.remap(selection, from: document, caretTrailing: selection.location == document.plain.utf16.count) }
        document = next
        let ids = Set(next.blocks.filter { $0.kind == .table }.map(\.id))
        tableOffsets = tableOffsets.filter { ids.contains($0.key) }
        layout = nil
        mountedView?.rebuild()
        if let mountedView { mountedView.inputDelegate?.textDidChange(mountedView) }
    }
    func measure(width: CGFloat, traits: UITraitCollection) -> MessageDocumentLayout {
        if let layout, layout.width == width, layout.category == traits.preferredContentSizeCategory { return layout }
        let next = MessageDocumentLayout(document: document, width: width, traits: traits)
        layout = next
        for table in next.tables { tableOffsets[table.id] = min(tableOffsets[table.id] ?? 0, max(0, table.contentWidth - table.rect.width)) }
        return next
    }
}

/// CTLines here are the sole painting, measurement, caret, range and AX geometry.
@MainActor
final class MessageDocumentLayout {
    struct Line {
        let text: CTLine
        let range: NSRange
        let origin: CGPoint
        let baseline: CGFloat
        let height: CGFloat
        let width: CGFloat
        let table: UUID?
    }
    struct Table {
        let id: UUID
        let rect: CGRect
        let contentWidth: CGFloat
        let toolsRect: CGRect
        let cells: [CGRect]
    }
    struct Reading {
        let id: String
        let range: NSRange
        let label: String
        let table: UUID?
        let heading: Bool
        var imageFrame: CGRect? = nil
        var imageURL: URL? = nil
    }
    struct Picture {
        let media: MessageDocument.Media
        let rect: CGRect
        var table: UUID? = nil
    }
    let width: CGFloat
    let category: UIContentSizeCategory
    private(set) var height: CGFloat = 0
    private(set) var lines: [Line] = []
    private(set) var tables: [Table] = []
    private(set) var reading: [Reading] = []
    private(set) var pictures: [Picture] = []
    private(set) var wells: [CGRect] = []
    private(set) var rules: [CGRect] = []
    private(set) var markers: [(String, CGPoint)] = []
    let bodyFont: UIFont

    init(document: MessageDocument, width: CGFloat, traits: UITraitCollection) {
        self.width = max(1, width)
        category = traits.preferredContentSizeCategory
        func font(_ role: DesignTextRole, scale: CGFloat = 1, bold: Bool = false, italic: Bool = false) -> UIFont {
            let descriptor = UIFontDescriptor(fontAttributes: [.family: role.family])
            let base = UIFont(descriptor: descriptor, size: role.baseSize * scale)
            var flags: UIFontDescriptor.SymbolicTraits = []
            if bold { flags.insert(.traitBold) }
            if italic { flags.insert(.traitItalic) }
            let styled = base.fontDescriptor.withSymbolicTraits(flags).map { UIFont(descriptor: $0, size: base.pointSize) } ?? base
            return UIFontMetrics(forTextStyle: .body).scaledFont(for: styled, compatibleWith: traits)
        }
        bodyFont = font(.body)
        let text = NSMutableAttributedString(string: document.plain, attributes: [.font: bodyFont, .foregroundColor: UIColor(DuskColors.ink)])
        for block in document.blocks {
            if block.quoted { text.addAttribute(.foregroundColor, value: UIColor(DuskColors.ink2), range: block.range) }
            if case let .heading(level) = block.kind {
                text.addAttribute(.font, value: font(.body, scale: max(1, 1.6 - CGFloat(level - 1) * 0.12), bold: true), range: block.range)
            }
        }
        for run in document.runs {
            let code = run.style.contains(.code)
            if code || run.style.contains(.strong) || run.style.contains(.emphasis) {
                var runFont = font(code ? .supporting : .body, bold: run.style.contains(.strong), italic: run.style.contains(.emphasis))
                if !code, let existing = text.attribute(.font, at: run.range.location, effectiveRange: nil) as? UIFont {
                    var traits = existing.fontDescriptor.symbolicTraits
                    if run.style.contains(.strong) { traits.insert(.traitBold) }
                    if run.style.contains(.emphasis) { traits.insert(.traitItalic) }
                    if let descriptor = existing.fontDescriptor.withSymbolicTraits(traits) {
                        runFont = UIFont(descriptor: descriptor, size: existing.pointSize)
                    }
                }
                if code {
                    let descriptor = UIFontDescriptor(fontAttributes: [.family: DesignV2.Typography.monoFamily])
                    let base = UIFont(descriptor: descriptor, size: DesignTextRole.supporting.baseSize)
                    runFont = UIFontMetrics(forTextStyle: .body).scaledFont(for: base, compatibleWith: traits)
                }
                text.addAttribute(.font, value: runFont, range: run.range)
            }
            if code { text.addAttribute(.foregroundColor, value: UIColor(DuskColors.ink2), range: run.range) }
            if run.style.contains(.strike) { text.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: run.range) }
            if let link = run.link { text.addAttributes([.link: link, .foregroundColor: UIColor(DuskColors.accent), .underlineStyle: NSUnderlineStyle.single.rawValue], range: run.range) }
        }
        let typesetter = CTTypesetterCreateWithAttributedString(text)
        var y: CGFloat = 0
        let gap = Space.sm
        let reservedImageHeight: CGFloat = 160
        func add(_ range: NSRange, x: CGFloat, y: CGFloat, width: CGFloat, table: UUID?, alignment: UInt8 = 0) -> CGFloat {
            var index = range.location, cursor = y
            while index < NSMaxRange(range) {
                let count = min(NSMaxRange(range) - index, max(1, CTTypesetterSuggestLineBreak(typesetter, index, Double(max(1, width)))))
                let line = CTTypesetterCreateLine(typesetter, CFRange(location: index, length: count))
                var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
                let inkWidth = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
                let font = text.attribute(.font, at: index, effectiveRange: nil) as? UIFont ?? bodyFont
                // Consume shared role's target pitch, not additive SwiftUI leading.
                let pitch = max(ascent + descent + leading, font.pointSize * CGFloat(DesignTextRole.body.lineHeight))
                let slack = max(0, width - inkWidth)
                let shift: CGFloat = alignment == 114 ? slack : (alignment == 99 ? slack / 2 : 0)
                lines.append(Line(text: line, range: NSRange(location: index, length: count), origin: CGPoint(x: x + shift, y: cursor), baseline: ascent + max(0, pitch - ascent - descent) / 2, height: pitch, width: table == nil ? inkWidth : width - shift, table: table))
                cursor += pitch; index += count
            }
            return max(bodyFont.lineHeight, cursor - y)
        }
        for block in document.blocks {
            let startY = y
            let inset = min(self.width / 3, CGFloat(block.depth) * Space.md)
            switch block.kind {
            case .table:
                let columns = block.cells.map(\.count).max() ?? 0
                let widths: [CGFloat] = (0..<columns).map { column in
                    max(bodyFont.pointSize * 6, min(bodyFont.pointSize * 24, block.cells.map { row in
                        guard row.indices.contains(column) else { return CGFloat(0) }
                        let range = row[column]
                        let line = CTTypesetterCreateLine(typesetter, CFRange(location: range.location, length: range.length))
                        return CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)) + Space.md * 2
                    }.max() ?? 0))
                }
                // Fit only the canonical control through SwiftUI's explicit
                // sizing API; document text still uses the retained CTLines.
                let tools = UIHostingController(rootView: MessageDocumentView.tableButtonContent(category: category, action: {}))
                let toolsHeight = max(44, ceil(tools.sizeThatFits(in:
                    CGSize(width: self.width, height: .greatestFiniteMagnitude)
                ).height))
                y += toolsHeight // Native Copy button, outside selectable cell geometry.
                var cellBoxes: [CGRect] = []
                for (rowIndex, row) in block.cells.enumerated() {
                    var x: CGFloat = 0, rowHeight: CGFloat = bodyFont.lineHeight + Space.md * 2
                    for (column, cell) in row.enumerated() {
                        let h = add(cell, x: x + Space.md, y: y + Space.md, width: widths[column] - Space.md * 2, table: block.id, alignment: block.alignments.indices.contains(column) ? block.alignments[column] : 0)
                        var cellHeight = h + Space.md * 2
                        for media in document.media where NSLocationInRange(media.range.location, cell) || media.range == cell {
                            let rect = CGRect(x: x + Space.md, y: y + cellHeight, width: widths[column] - Space.md * 2, height: reservedImageHeight)
                            pictures.append(Picture(media: media, rect: rect, table: block.id))
                            reading.append(Reading(id: "\(block.id)-\(rowIndex)-\(column)-image-\(media.range.location)", range: media.range,
                                                   label: media.alternative.isEmpty ? "Image" : media.alternative, table: block.id,
                                                   heading: false, imageFrame: rect, imageURL: media.url))
                            cellHeight += reservedImageHeight + Space.md
                        }
                        rowHeight = max(rowHeight, cellHeight)
                        let header = block.cells.first.flatMap { $0.indices.contains(column) ? document.plain(in: $0[column]) : nil } ?? ""
                        let label = rowIndex == 0 ? document.plain(in: cell) : "Row \(rowIndex + 1), \(header): \(document.plain(in: cell))"
                        reading.append(Reading(id: "\(block.id)-\(rowIndex)-\(column)", range: cell, label: label, table: block.id, heading: rowIndex == 0))
                        x += widths[column]
                    }
                    x = 0
                    for column in row.indices {
                        cellBoxes.append(CGRect(x: x, y: y, width: widths[column], height: rowHeight)); x += widths[column]
                    }
                    y += rowHeight
                }
                tables.append(Table(id: block.id, rect: CGRect(x: 0, y: startY + toolsHeight, width: self.width, height: y - startY - toolsHeight), contentWidth: widths.reduce(0, +), toolsRect: CGRect(x: 0, y: startY, width: self.width, height: toolsHeight), cells: cellBoxes))
            case .rule:
                rules.append(CGRect(x: 0, y: y + gap, width: self.width, height: 1)); y += gap * 2 + 1
            default:
                let padding = block.kind == .code ? Space.md : 0
                if let marker = block.marker { markers.append((marker, CGPoint(x: max(0, inset - Space.md), y: y))) }
                y += padding
                y += add(block.range, x: inset + padding, y: y, width: max(1, self.width - inset - padding * 2), table: nil)
                y += padding
                if block.quoted { rules.append(CGRect(x: max(0, inset - Space.sm), y: startY, width: 2, height: y - startY)) }
                if block.kind == .code { wells.append(CGRect(x: inset, y: startY, width: self.width - inset, height: y - startY)) }
                let isHeading: Bool
                if case .heading = block.kind { isHeading = true } else { isHeading = false }
                if !document.media.contains(where: { $0.range == block.range }) {
                    reading.append(Reading(id: block.id.uuidString, range: block.range, label: document.plain(in: block.range), table: nil, heading: isHeading))
                }
                for media in document.media where NSLocationInRange(media.range.location, block.range) || (media.range.length == 0 && media.range.location == block.range.location) {
                    // Reserve stable geometry before fetching. Aspect-fit arrival
                    // never changes row size or moves selection/reading anchors.
                    let rect = CGRect(x: inset, y: y + gap, width: max(1, self.width - inset), height: reservedImageHeight)
                    pictures.append(Picture(media: media, rect: rect)); y = rect.maxY
                    reading.append(Reading(id: "\(block.id)-image-\(media.range.location)", range: media.range,
                                           label: media.alternative.isEmpty ? "Image" : media.alternative, table: nil,
                                           heading: false, imageFrame: rect, imageURL: media.url))
                }
            }
            y += gap
        }
        height = max(0, y - (document.blocks.isEmpty ? 0 : gap))
    }
}
