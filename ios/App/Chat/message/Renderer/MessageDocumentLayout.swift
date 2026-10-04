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
        if let layout, layout.width == width, layout.category == traits.preferredContentSizeCategory,
           layout.displayScale == traits.displayScale, layout.contrast == traits.accessibilityContrast { return layout }
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
    let displayScale: CGFloat
    let contrast: UIAccessibilityContrast
    private(set) var height: CGFloat = 0
    private(set) var lines: [Line] = []
    private(set) var tables: [Table] = []
    private(set) var reading: [Reading] = []
    private(set) var pictures: [Picture] = []
    private(set) var wells: [CGRect] = []
    private(set) var rules: [CGRect] = []
    struct Marker {
        let label: String
        let point: CGPoint
        let width: CGFloat
        let image: UIImage?
        let faceSize: CGFloat
    }
    private(set) var markers: [Marker] = []
    let bodyFont: UIFont

    init(document: MessageDocument, width: CGFloat, traits: UITraitCollection) {
        self.width = max(1, width)
        category = traits.preferredContentSizeCategory
        displayScale = traits.displayScale
        contrast = traits.accessibilityContrast
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
        let scale = bodyFont.pointSize / DesignTextRole.body.baseSize
        let taskSize = DesignMetrics.checkboxSize * scale
        var markerWidths: [String: CGFloat] = [:]
        var listWidths: [MessageDocument.Indent: CGFloat] = [:]
        var listGaps: [MessageDocument.Indent: CGFloat] = [:]
        for block in document.blocks {
            guard let marker = block.marker,
                  let list = block.indents.last(where: { if case .list = $0 { return true }; return false }) else { continue }
            let task = marker == "☑" || marker == "☐"
            if markerWidths[marker] == nil {
                let line = CTLineCreateWithAttributedString(NSAttributedString(string: marker, attributes: [.font: bodyFont]))
                let ink = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
                markerWidths[marker] = task ? taskSize : max(CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)), ink.maxX) - min(0, ink.minX)
            }
            listWidths[list] = max(listWidths[list] ?? 0, markerWidths[marker]!)
            listGaps[list] = max(listGaps[list] ?? 0, (task ? DesignMetrics.checkboxGap : Space.sm) * scale)
        }
        func advance(_ indent: MessageDocument.Indent) -> CGFloat {
            if indent == .quote { return Space.md * scale }
            return (listWidths[indent] ?? 0) + (listGaps[indent] ?? Space.sm * scale)
        }
        var taskImages: [Bool: UIImage] = [:]
        // Synthetic separators keep block/cell boundaries disjoint. Media can
        // occupy either endpoint without contributing selectable alt text.
        for block in document.blocks {
            let startY = y
            // ponytail: literal ancestor gutters; extreme depth at narrow AX
            // widths needs an explicit flatten/stack policy, not overlapping markers.
            let inset = block.indents.reduce(CGFloat(0)) { $0 + advance($1) }
            let firstLineIndex = lines.count
            switch block.kind {
            case .table:
                let columns = block.cells.map(\.count).max() ?? 0
                let padding = Space.sm
                let readableWidth = bodyFont.pointSize * 6 + padding * 2
                let preferred: [CGFloat] = (0..<columns).map { column in
                    block.cells.map { row -> CGFloat in
                        guard row.indices.contains(column) else { return padding * 2 + 1 }
                        let range = row[column]
                        // Empty-alt images still need a readable preview well.
                        let mediaWidth = document.media.contains { (range.location...NSMaxRange(range)).contains($0.range.location) } ? bodyFont.pointSize * 6 : 0
                        // CoreText treats a zero-length range as the remaining document.
                        let line = range.length > 0 ? CTTypesetterCreateLine(typesetter, CFRange(location: range.location, length: range.length)) : nil
                        let measured = line.map { CGFloat(CTLineGetTypographicBounds($0, nil, nil, nil)) } ?? 0
                        return ceil(max(1, measured, mediaWidth)) + padding * 2
                    }.max() ?? padding * 2 + 1
                }
                let available = max(1, self.width - inset)
                let naturalWidth = preferred.reduce(0, +)
                // Retain the existing six-em readability budget, not a new
                // min-intrinsic policy. Only flexible excess needs compression.
                let readable = preferred.map { min($0, readableWidth) }
                let budget = readable.reduce(0, +)
                var widths: [CGFloat]
                if naturalWidth <= available {
                    let surplus = (available - naturalWidth) / CGFloat(max(1, columns))
                    widths = preferred.map { $0 + surplus }
                } else if budget <= available {
                    let fraction = (available - budget) / (naturalWidth - budget)
                    widths = zip(readable, preferred).map { $0 + ($1 - $0) * fraction }
                } else {
                    widths = readable
                }
                let fits = budget <= available && columns > 0
                if fits {
                    // Reconcile once, not per-column pixel rounding: fitting
                    // cells and native scroll extent must end at the same edge.
                    widths[columns - 1] = available - widths.dropLast().reduce(0, +)
                }
                var cellBoxes: [CGRect] = []
                for (rowIndex, row) in block.cells.enumerated() {
                    var x: CGFloat = inset, rowHeight: CGFloat = bodyFont.lineHeight + Space.md * 2
                    for (column, cell) in row.enumerated() {
                        let h = add(cell, x: x + padding, y: y + Space.md, width: widths[column] - padding * 2, table: block.id, alignment: block.alignments.indices.contains(column) ? block.alignments[column] : 0)
                        var cellHeight = h + Space.md * 2
                        for (imageIndex, media) in document.media.filter({ (cell.location...NSMaxRange(cell)).contains($0.range.location) }).enumerated() {
                            let rect = CGRect(x: x + padding, y: y + cellHeight, width: widths[column] - padding * 2, height: reservedImageHeight)
                            pictures.append(Picture(media: media, rect: rect, table: block.id))
                            reading.append(Reading(id: "\(block.id)-\(rowIndex)-\(column)-image-\(imageIndex)", range: media.range,
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
                    x = inset
                    for column in row.indices {
                        cellBoxes.append(CGRect(x: x, y: y, width: widths[column], height: rowHeight)); x += widths[column]
                    }
                    y += rowHeight
                }
                tables.append(Table(id: block.id, rect: CGRect(x: inset, y: startY, width: available, height: y - startY), contentWidth: fits ? available : widths.reduce(0, +), cells: cellBoxes))
            case .rule:
                rules.append(CGRect(x: inset, y: y + gap, width: max(1, self.width - inset), height: 1)); y += gap * 2 + 1
            default:
                let padding = block.kind == .code ? Space.md : 0
                y += padding
                y += add(block.range, x: inset + padding, y: y, width: max(1, self.width - inset - padding * 2), table: nil)
                y += padding
                if block.kind == .code { wells.append(CGRect(x: inset, y: startY, width: self.width - inset, height: y - startY)) }
                let isHeading: Bool
                if case .heading = block.kind { isHeading = true } else { isHeading = false }
                if !document.media.contains(where: { $0.range == block.range }) {
                    reading.append(Reading(id: block.id.uuidString, range: block.range, label: (block.marker == "☑" ? "Checked, " : block.marker == "☐" ? "Unchecked, " : "") + document.plain(in: block.range), table: nil, heading: isHeading))
                }
                for (imageIndex, media) in document.media.filter({ (block.range.location...NSMaxRange(block.range)).contains($0.range.location) }).enumerated() {
                    // Reserve stable geometry before fetching. Aspect-fit arrival
                    // never changes row size or moves selection/reading anchors.
                    let rect = CGRect(x: inset, y: y + gap, width: max(1, self.width - inset), height: reservedImageHeight)
                    pictures.append(Picture(media: media, rect: rect)); y = rect.maxY
                    reading.append(Reading(id: "\(block.id)-image-\(imageIndex)", range: media.range,
                                           label: media.alternative.isEmpty ? "Image" : media.alternative, table: nil,
                                           heading: false, imageFrame: rect, imageURL: media.url))
                }
            }
            var quoteX: CGFloat = 0
            for indent in block.indents {
                if indent == .quote { rules.append(CGRect(x: quoteX + 4 * scale, y: startY, width: 2, height: y - startY)) }
                quoteX += advance(indent)
            }
            if let label = block.marker,
               let index = block.indents.lastIndex(where: { if case .list = $0 { return true }; return false }) {
                let list = block.indents[index]
                let slotStart = block.indents.prefix(index).reduce(CGFloat(0)) { $0 + advance($1) }
                let markerWidth = markerWidths[label] ?? 0
                let task = label == "☑" || label == "☐"
                let first = lines.indices.contains(firstLineIndex) ? lines[firstLineIndex] : nil
                let baseline = first.map { $0.origin.y + $0.baseline } ?? (startY + bodyFont.ascender)
                let point = CGPoint(x: slotStart + (listWidths[list] ?? markerWidth) - markerWidth,
                                    y: task ? (first.map { $0.origin.y + $0.height / 2 } ?? (startY + taskSize / 2)) - taskSize / 2
                                            : baseline - bodyFont.ascender)
                if task && taskImages[label == "☑"] == nil {
                    taskImages[label == "☑"] = MessageTaskMark.image(checked: label == "☑", scale: scale, traits: traits)
                }
                markers.append(Marker(label: label, point: point, width: markerWidth,
                                      image: task ? taskImages[label == "☑"] : nil,
                                      faceSize: taskSize))
            }
            y += gap
        }
        height = max(0, y - (document.blocks.isEmpty ? 0 : gap))
    }
}

/// Static native decoration, shared across mounted rows. No hosting views and no
/// rasterization during draw/scroll frames. Layout retains its resolved image.
@MainActor
private enum MessageTaskMark {
    static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 16 * 1024 * 1024
        return cache
    }()

    static func image(checked: Bool, scale: CGFloat, traits: UITraitCollection) -> UIImage? {
        let displayScale = max(1, traits.displayScale)
        let contrast = traits.accessibilityContrast == .high
        let key = "\(checked)-\(scale)-\(displayScale)-\(contrast)" as NSString
        if let image = cache.object(forKey: key) { return image }
        let pixelScale = displayScale * scale
        let overflow = DesignMaterialAdapter.smallControlMaximumOverflow
        let side = DesignMetrics.checkboxSize + overflow * 2
        let pixels = Int(ceil(side * pixelScale))
        guard let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8,
            bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
        context.translateBy(x: 0, y: CGFloat(pixels))
        context.scaleBy(x: pixelScale, y: -pixelScale)
        draw(checked: checked, contrast: contrast, in: context, pixelScale: pixelScale,
             face: CGRect(x: overflow, y: overflow, width: DesignMetrics.checkboxSize, height: DesignMetrics.checkboxSize))
        guard let bitmap = context.makeImage() else { return nil }
        let image = UIImage(cgImage: bitmap, scale: pixelScale, orientation: .up)
        let cost = (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0)
        cache.setObject(image, forKey: key, cost: cost)
        return image
    }

    /// Read-only rest states only. Share native checkbox recipes/contours, not
    /// SwiftUI graph construction on the first incoming task-list layout.
    private static func draw(checked: Bool, contrast: Bool, in context: CGContext, pixelScale: CGFloat, face: CGRect) {
        let shape = DesignCanvasShape.roundedRectangle(cornerRadius: DesignMetrics.checkboxCornerRadius)
        let path = shape.cgPath(in: face)
        func fill(_ path: CGPath, _ color: Color, evenOdd: Bool = false) {
            context.addPath(path); context.setFillColor(UIColor(color).cgColor)
            context.drawPath(using: evenOdd ? .eoFill : .fill)
        }
        func shadow(_ source: CGPath, color: Color, blur: CGFloat, evenOdd: Bool = false) {
            guard !source.isEmpty else { return }
            guard blur > 0 else { fill(source, color, evenOdd: evenOdd); return }
            context.saveGState()
            // Move the opaque source outside the bitmap; paint only its shadow.
            let distance = face.maxX * 4 + blur * 4
            context.setShadow(offset: CGSize(width: distance * pixelScale, height: 0), blur: blur * pixelScale, color: UIColor(color).cgColor)
            context.translateBy(x: -distance, y: 0)
            fill(source, .black, evenOdd: evenOdd)
            context.restoreGState()
        }
        func outer(_ recipe: DesignCanvasShadowRecipe) {
            let source = shape.path(in: face, inset: recipe.geometry.sourceInset)
                .applying(CGAffineTransform(translationX: recipe.geometry.x, y: recipe.geometry.y))
            guard !source.isEmpty else { return }
            if recipe.geometry.radius > 0 {
                // Rest checkbox cast sources sit beneath the opaque face.
                // Face overdraw hides the source; no oversized offscreen layer.
                context.saveGState()
                context.setShadow(offset: .zero, blur: recipe.geometry.radius * pixelScale,
                                  color: UIColor(recipe.color.opacity(recipe.opacity)).cgColor)
                fill(source.cgPath, .black)
                context.restoreGState()
            } else {
                fill(source.cgPath, recipe.color.opacity(recipe.opacity))
            }
        }
        func linear(_ colors: [Color], stops: [CGFloat]) {
            context.saveGState(); context.addPath(path); context.clip()
            let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                                      colors: colors.map { UIColor($0).cgColor } as CFArray, locations: stops)!
            context.drawLinearGradient(gradient, start: CGPoint(x: face.midX, y: face.minY),
                                       end: CGPoint(x: face.midX, y: face.maxY), options: [])
            context.restoreGState()
        }
        func border(_ color: Color, width: CGFloat) {
            context.addPath(shape.cgPath(in: face, inset: width / 2))
            context.setStrokeColor(UIColor(color).cgColor); context.setLineWidth(width); context.strokePath()
        }
        if checked {
            let recipe = DesignCanvasCompactSlateRecipe.make(profile: .checkboxChecked, state: .init(), increasedContrast: contrast, reduceMotion: true)
            if let glow = recipe.glow { outer(glow) }
            outer(recipe.cast); outer(recipe.contact)
            linear([recipe.linearTop, recipe.linearBottom], stops: [0, 1])
            context.saveGState(); context.addPath(path); context.clip()
            let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                colors: [UIColor(recipe.radialCenter).cgColor, UIColor(recipe.radialCenter.opacity(0)).cgColor] as CFArray,
                locations: [0, recipe.radialFadeStop])!
            let center = recipe.radialGeometry.center(in: face)
            context.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center,
                endRadius: recipe.radialGeometry.farthestCornerRadius(in: face), options: [.drawsAfterEndLocation])
            context.restoreGState()
            border(recipe.border, width: recipe.borderLineWidth)
            context.addPath(DesignCheckboxMark.checkmarkPath(in: face))
            context.setStrokeColor(UIColor(DuskColors.bgSunk).cgColor)
            context.setLineWidth(DesignCheckboxMark.checkmarkLineWidth)
            context.setLineCap(.round); context.setLineJoin(.round); context.strokePath()
        } else {
            let recipe = DesignCanvasReceiverRecipe.make(profile: .checkboxReceiver, state: .init(), increasedContrast: contrast, reduceMotion: true)
            outer(DesignCanvasShadowRecipe(color: recipe.contactColor, opacity: recipe.contactOpacity, geometry: recipe.contactGeometry))
            linear([recipe.faceTop, recipe.faceMiddle, recipe.faceBottom], stops: [0, recipe.well.faceMiddleStop, 1])
            context.saveGState(); context.addPath(path); context.clip()
            let geometry = recipe.upperInnerOcclusion
            let source = geometry.sourcePath(shape: shape, in: face)
                .applying(CGAffineTransform(translationX: geometry.x, y: geometry.y))
            let extent = DesignCanvasEffects.overflow(blur: geometry.radius, x: geometry.x, y: geometry.y)
            let exterior = CGMutablePath()
            exterior.addRect(face.union(source.boundingRect).insetBy(dx: -extent, dy: -extent))
            exterior.addPath(source.cgPath)
            shadow(exterior, color: recipe.well.upperInnerOcclusionColor.opacity(recipe.upperInnerOcclusionOpacity),
                   blur: geometry.radius, evenOdd: true)
            fill(DesignCanvasGeometry.directionalInnerEdgePath(shape: shape, faceRect: face,
                inset: recipe.well.lowerInnerReflectionInset, translationY: recipe.well.lowerInnerReflectionY).cgPath,
                recipe.well.lowerInnerReflectionColor.opacity(recipe.lowerInnerReflectionOpacity), evenOdd: true)
            context.restoreGState()
            border(recipe.border, width: recipe.well.borderLineWidth)
        }
    }

}
