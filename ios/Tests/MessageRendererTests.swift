import XCTest
import UIKit
import CoreText
import SwiftUI
@testable import SentientApp

@MainActor
final class MessageRendererTests: XCTestCase {
    private let source = "Before café 👩🏽‍💻.\n\n| Name | Observation | Value |\n| --- | --- | --- |\n| Alpha | partial 👩🏽‍💻 text e\u{301} | 42 \\| units |\n| Beta | A readable long column that must keep its horizontal offset | 7\\\\8 |\n\nBetween שלום مرحبا.\n\n| Left | Right |\n| --- | --- |\n| wide wide wide wide | another independently wide cell |\n\nAfter table."

    func testFitFirstTablesWrapStyledContentWithoutChangingSelectionOrCopy() throws {
        let short = "| A | B | C | D | |\n| --- | --- | --- | --- | --- |\n| 1 | 22 | `333` | | |"
        let description = "A longer description with café 👩🏽‍💻 and enough words to wrap sensibly within the available viewport."
        let mixed = "| ID | Description | |\n| ---: | --- | --- |\n| 7 | \(description) | |"
        let wide = "| Description one | Description two | Description three | Description four |\n| --- | --- | --- | --- |\n| \(description) | \(description) | \(description) | \(description) |"
        let empty = "| | | |\n| --- | --- | --- |\n| | | |"
        let source = [short, mixed, wide, empty].joined(separator: "\n\n")
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 280, height: 3000))
        view.update(source: source, literal: false)
        let document = view.document
        let selected = (document.plain as NSString).range(of: "café 👩🏽‍💻")
        let sourceBoundary = document.logicalToSource[selected.location]
        XCTAssertTrue((source as NSString).substring(from: sourceBoundary).hasPrefix("café 👩🏽‍💻"))
        view.selectedTextRange = MessageTextRange(selected)
        var normalFontSize: CGFloat = 0
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            view.traitOverrides.preferredContentSizeCategory = category
            view.updateTraitsIfNeeded()
            view.rebuild()
            let layout = try XCTUnwrap(view.state.layout)
            let blocks = document.blocks.filter { $0.kind == .table }
            XCTAssertEqual(layout.tables.count, 4)
            guard layout.tables.count == 4, blocks.count == 4 else { return }
            XCTAssertTrue(view.state.measure(width: 280, traits: view.traitCollection) === layout)
            XCTAssertEqual(view.measuredHeight, layout.height)
            if category == .large { normalFontSize = layout.bodyFont.pointSize }
            else { XCTAssertGreaterThan(layout.bodyFont.pointSize, normalFontSize) }
            let natural = blocks[0].cells[0].indices.map { column -> CGFloat in
                let ranges = blocks[0].cells.map { $0[column] }
                let measured = layout.lines.filter { line in ranges.contains { NSIntersectionRange($0, line.range).length > 0 } }
                    .map { CGFloat(CTLineGetTypographicBounds($0.text, nil, nil, nil)) }.max() ?? 0
                return ceil(max(1, measured)) + Space.sm * 2
            }
            let surplus = max(0, 280 - natural.reduce(0, +)) / CGFloat(natural.count)
            for column in natural.indices {
                XCTAssertEqual(layout.tables[0].cells[column].width, natural[column] + surplus, accuracy: 0.01,
                               "Actual bold/monospace natural widths share spare space, not always-compact columns")
            }
            XCTAssertLessThan(layout.tables[0].cells[4].width, layout.tables[0].cells[0].width)
            XCTAssertTrue(layout.tables[3].cells.allSatisfy { abs($0.width - 280 / 3) < 0.000001 })
            XCTAssertEqual(layout.tables[3].contentWidth, 280)
            XCTAssertFalse(layout.lines.contains { $0.table == blocks[3].id }, "Empty ranges must not measure remaining document")
            let longCell = blocks[1].cells[1][1]
            let wrapped = layout.lines.filter { NSIntersectionRange($0.range, longCell).length > 0 }
            XCTAssertGreaterThan(wrapped.count, 1)
            XCTAssertEqual(wrapped.reduce(0) { $0 + $1.range.length }, longCell.length)
            if category == .large {
                XCTAssertEqual(layout.tables[0].contentWidth, 280)
                XCTAssertEqual(layout.tables[1].contentWidth, 280)
            }
            let wideTable = layout.tables[2]
            XCTAssertGreaterThan(wideTable.contentWidth, wideTable.rect.width, "Genuinely wide data keeps native overflow")
            view.activateTable(at: CGPoint(x: 1, y: wideTable.rect.midY))
            view.setTableOffset(.greatestFiniteMagnitude)
            XCTAssertGreaterThan(view.tableOffset, 0)
            XCTAssertFalse(view.remainingRight)
            let scroll = try XCTUnwrap(view.subviews.compactMap { $0 as? UIScrollView }.first { $0.frame == wideTable.rect })
            XCTAssertEqual(view.tableOffset, scroll.contentOffset.x)
            XCTAssertEqual((view.selectedTextRange as? MessageTextRange)?.value, selected)
            XCTAssertFalse(view.selectionRects(for: MessageTextRange(selected)).isEmpty)
            let caret = view.caretRect(for: MessageTextPosition(selected.location))
            let hit = try XCTUnwrap(view.closestPosition(to: CGPoint(x: caret.minX + 0.1, y: caret.midY)) as? MessageTextPosition)
            XCTAssertEqual(hit.index, selected.location, "Wrapped-cell hit mapping uses painted CoreText geometry")
            view.copy(nil)
            XCTAssertEqual(UIPasteboard.general.string, "café 👩🏽‍💻")
            XCTAssertEqual(view.document.logicalToSource[selected.location], sourceBoundary)
            view.selectAll(nil)
            view.copy(nil)
            XCTAssertEqual(UIPasteboard.general.string, blocks.map { document.tableMarkdown(id: $0.id) }.joined(separator: "\n"))
            view.selectedTextRange = MessageTextRange(selected)
        }
        view.frame.size.width = 240
        view.rebuild()
        XCTAssertEqual((view.selectedTextRange as? MessageTextRange)?.value, selected)
        XCTAssertEqual(view.document.logicalToSource, document.logicalToSource)
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, "café 👩🏽‍💻")
    }

    func testTwoColumnTableFillsWellWithoutNativeOverflowAtFractionalWidths() throws {
        let source = "| Thing | Worth it? |\n| --- | --- |\n| Table | Yes |\n| Footnote | Sometimes |\n| Nested tables | Never |"
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 280, height: 1000))
        view.traitOverrides.preferredContentSizeCategory = .large
        view.updateTraitsIfNeeded()
        view.update(source: source, literal: false)
        let selected = (view.document.plain as NSString).range(of: "Footnote")
        view.selectedTextRange = MessageTextRange(selected)
        for scale in [CGFloat(1), 2, 3] {
            view.traitOverrides.displayScale = scale
            view.updateTraitsIfNeeded()
            for width in [CGFloat(280), 280.25, 320.75] {
                view.frame.size.width = width
                view.rebuild()
                let layout = try XCTUnwrap(view.state.layout)
                let table = try XCTUnwrap(layout.tables.first)
                XCTAssertTrue(view.state.measure(width: width, traits: view.traitCollection) === layout)
                XCTAssertEqual(view.measuredHeight, layout.height)
                XCTAssertEqual(table.contentWidth, width)
                XCTAssertEqual(try XCTUnwrap(table.cells.last).maxX, table.rect.maxX, accuracy: 0.000001)
                XCTAssertTrue(layout.lines.allSatisfy { CGFloat(CTLineGetTypographicBounds($0.text, nil, nil, nil)) <= $0.width })
                let block = try XCTUnwrap(view.document.blocks.first)
                for cell in block.cells.flatMap({ $0 }) {
                    XCTAssertEqual(layout.lines.filter { NSIntersectionRange($0.range, cell).length > 0 }.count, 1,
                                   "Natural two-column fit needs no wrapping")
                }
                let scroll = try XCTUnwrap(view.subviews.compactMap { $0 as? UIScrollView }.first)
                XCTAssertEqual(scroll.contentSize.width, scroll.bounds.width, "No fractional phantom scroll")
                view.setTableOffset(.greatestFiniteMagnitude)
                XCTAssertEqual(view.tableOffset, 0)
                XCTAssertFalse(view.remainingLeft)
                XCTAssertFalse(view.remainingRight)
                XCTAssertFalse(view.scrollTable(id: table.id, direction: .left))
                XCTAssertEqual(view.state.selection, selected)
                view.copy(nil)
                XCTAssertEqual(UIPasteboard.general.string, "Footnote")
                if scale == 3 && width == 320.75 {
                    view.selectedTextRange = nil
                    let format = UIGraphicsImageRendererFormat()
                    format.scale = scale
                    let image = UIGraphicsImageRenderer(bounds: table.rect, format: format).image { _ in view.draw(view.bounds) }
                    let evidence = XCTAttachment(image: image)
                    evidence.name = "fitting-Thing-Worth-it-table"
                    evidence.lifetime = .keepAlways
                    add(evidence)
                    view.selectedTextRange = MessageTextRange(selected)
                }
            }
        }
    }

    func testStyledFlexibleExcessCompressesProportionallyAndNaturalFitHasNoCap() throws {
        let first = "**Bold description** with *emphasis* and `mono café 👩🏽‍💻 e\u{301}`"
        let second = String(repeating: "A much longer styled description with **bold** words. ", count: 8)
        let source = "| ID | Description | Details | |\n| ---: | :---: | ---: | --- |\n| 7 | \(first) | \(second) | |"
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 6000, height: 3000))
        view.traitOverrides.preferredContentSizeCategory = .large
        view.updateTraitsIfNeeded()
        view.update(source: source, literal: false)
        let document = view.document
        let block = try XCTUnwrap(document.blocks.first)
        let broad = try XCTUnwrap(view.state.layout)
        let natural = block.cells[0].indices.map { column -> CGFloat in
            let ranges = block.cells.map { $0[column] }
            let ink = broad.lines.filter { line in ranges.contains { NSIntersectionRange($0, line.range).length > 0 } }
                .map { CGFloat(CTLineGetTypographicBounds($0.text, nil, nil, nil)) }.max() ?? 0
            return ceil(max(1, ink)) + Space.sm * 2
        }
        let readable = natural.map { min($0, broad.bodyFont.pointSize * 6 + Space.sm * 2) }
        XCTAssertGreaterThan(natural[2], broad.bodyFont.pointSize * 24)
        XCTAssertEqual(broad.lines.filter { NSIntersectionRange($0.range, block.cells[1][2]).length > 0 }.count, 1,
                       "Naturally fitting columns must not wrap at the rejected 24-em cap")
        let selected = (document.plain as NSString).range(of: "café 👩🏽‍💻 e\u{301}")
        view.selectedTextRange = MessageTextRange(selected)
        view.frame.size.width = 320.25
        view.rebuild()
        let layout = try XCTUnwrap(view.state.layout)
        let table = try XCTUnwrap(layout.tables.first)
        let budget = readable.reduce(0, +)
        XCTAssertLessThan(budget, table.rect.width)
        XCTAssertGreaterThan(natural.reduce(0, +), table.rect.width)
        let fraction = (table.rect.width - budget) / (natural.reduce(0, +) - budget)
        for column in natural.indices {
            XCTAssertEqual(table.cells[column].width, readable[column] + (natural[column] - readable[column]) * fraction, accuracy: 0.000001)
            let range = block.cells[1][column]
            let lines = layout.lines.filter { NSIntersectionRange($0.range, range).length > 0 }
            XCTAssertEqual(lines.reduce(0) { $0 + $1.range.length }, range.length, "Complete UTF-16 coverage after styled wrapping")
            for line in lines {
                let ink = CGFloat(CTLineGetTypographicBounds(line.text, nil, nil, nil))
                let slack = max(0, table.cells[column].width - Space.sm * 2 - ink)
                let alignment = block.alignments[column]
                let shift = alignment == 114 ? slack : (alignment == 99 ? slack / 2 : 0)
                XCTAssertEqual(line.origin.x, table.cells[column].minX + Space.sm + shift, accuracy: 0.000001)
            }
        }
        XCTAssertEqual(table.contentWidth, table.rect.width)
        XCTAssertEqual(try XCTUnwrap(table.cells.last).maxX, table.rect.maxX, accuracy: 0.000001)
        XCTAssertFalse(view.remainingRight)
        XCTAssertGreaterThan(table.rect.height, try XCTUnwrap(broad.tables.first).rect.height)
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, "café 👩🏽‍💻 e\u{301}")
        XCTAssertEqual(view.document.logicalToSource, document.logicalToSource)
        // At a narrow AX viewport, retained readability policy requires real overflow.
        view.frame.size.width = 120
        view.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        view.updateTraitsIfNeeded()
        view.rebuild()
        let large = try XCTUnwrap(view.state.layout)
        XCTAssertGreaterThan(try XCTUnwrap(large.tables.first).contentWidth, 120)
        XCTAssertTrue(view.remainingRight)
        XCTAssertEqual(view.state.selection, selected)
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, "café 👩🏽‍💻 e\u{301}")
    }

    func testReceiptRemapsActiveSelectionHandleWhenLiteralSourceBecomesMarkdown() {
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 280, height: 200))
        let source = "**Bold** tail"
        view.update(source: source, literal: true)
        let range = (view.document.plain as NSString).range(of: "tail")
        view.selectedTextRange = MessageTextRange(range)
        view.selectionEdge.sample(.zero, handleAnchor: range.location)
        view.selectionEdge.nativeGestureChanged(.began, id: ObjectIdentifier(view))
        XCTAssertEqual(view.selectionEdge.anchor, range.location)
        view.update(source: source, literal: false)
        let committedRange = (view.document.plain as NSString).range(of: "tail")
        XCTAssertNotEqual(range.location, committedRange.location)
        XCTAssertEqual(view.state.selection, committedRange)
        XCTAssertEqual(view.selectionEdge.anchor, committedRange.location)
        view.selectionEdge.stop()
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, "tail")
    }

    func testTableContentFadePreservesBlankWellPerimeterAndNativeEndpoints() throws {
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 180, height: 400))
        view.traitOverrides.preferredContentSizeCategory = .large
        view.updateTraitsIfNeeded()
        view.update(source: "| MMMMMMMMMMMMMMMM | MMMMMMMMMMMMMMMM | MMMMMMMMMMMMMMMM |\n| --- | --- | --- |\n| | | |", literal: false)
        func pixels(_ image: UIImage) throws -> [UInt8] {
            let cg = try XCTUnwrap(image.cgImage)
            var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
            let context = try XCTUnwrap(CGContext(data: &bytes, width: cg.width, height: cg.height,
                bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            return bytes
        }
        for scale in [CGFloat(1), 2, 3] {
            view.traitOverrides.displayScale = scale
            view.updateTraitsIfNeeded()
            view.rebuild()
            let layout = try XCTUnwrap(view.state.layout)
            let table = try XCTUnwrap(layout.tables.first)
            XCTAssertGreaterThan(table.contentWidth, table.rect.width, "Fixture must genuinely overflow")
            let format = UIGraphicsImageRendererFormat()
            format.scale = scale
            format.preferredRange = .standard
            let renderer = UIGraphicsImageRenderer(bounds: view.bounds, format: format)
            let well = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1), format: format).image { _ in
                UIColor(DuskColors.bgSunk).setFill(); UIRectFill(CGRect(x: 0, y: 0, width: 1, height: 1))
            }
            let surface = Array(try pixels(well).prefix(4))
            let edge = table.contentWidth - table.rect.width
            for offset in [CGFloat(0), edge / 2, edge] {
                view.setTableOffset(offset)
                let raster = renderer.image { _ in view.draw(view.bounds) }
                // Unfaded content control uses the same styled CTLines/offset,
                // not a second typesetter or a production-only test toggle.
                let control = renderer.image { render in
                    let context = render.cgContext
                    context.saveGState()
                    UIBezierPath(roundedRect: table.rect, cornerRadius: Radii.sm).addClip()
                    UIColor(DuskColors.bgSunk).setFill(); context.fill(table.rect)
                    UIColor(DuskColors.lineSoft).setStroke()
                    for cell in table.cells { context.stroke(cell.offsetBy(dx: -view.tableOffset, dy: 0), width: 0.5) }
                    for line in layout.lines {
                        context.saveGState()
                        context.textMatrix = .identity
                        context.translateBy(x: line.origin.x - view.tableOffset, y: line.origin.y + line.baseline)
                        context.scaleBy(x: 1, y: -1)
                        context.textPosition = .zero
                        CTLineDraw(line.text, context)
                        context.restoreGState()
                    }
                    context.restoreGState()
                }
                let cg = try XCTUnwrap(raster.cgImage)
                func crop(_ image: UIImage, _ rect: CGRect) throws -> [UInt8] {
                    try pixels(UIImage(cgImage: XCTUnwrap(image.cgImage?.cropping(to: rect))))
                }
                XCTAssertEqual(try crop(raster, CGRect(x: 0, y: 0, width: 1, height: 1)).last, 0,
                               "Rounded outer corner stays transparent")
                // The unmodified perimeter and corner clip must match control
                // even while content below it fades. Sample outside the inset.
                for y in [CGFloat(0), ceil(table.rect.maxY * scale) - 1] {
                    let rect = CGRect(x: 0, y: y, width: CGFloat(cg.width), height: 1)
                    XCTAssertEqual(try crop(raster, rect), try crop(control, rect))
                }
                let cornerSize = ceil(Radii.sm * scale)
                for x in [CGFloat(0), CGFloat(cg.width) - cornerSize] {
                    for y in [CGFloat(0), ceil(table.rect.maxY * scale) - cornerSize] {
                        let corner = CGRect(x: x, y: y, width: cornerSize, height: cornerSize)
                        let actual = try crop(raster, corner)
                        let expected = try crop(control, corner)
                        XCTAssertEqual(stride(from: 3, to: actual.count, by: 4).map { actual[$0] },
                                       stride(from: 3, to: expected.count, by: 4).map { expected[$0] },
                                       "Fade cannot alter rounded silhouette/clip")
                    }
                }
                let blank = CGRect(x: 0, y: floor(try XCTUnwrap(table.cells.last).midY * scale),
                                   width: CGFloat(cg.width), height: 1)
                let blankActual = try crop(raster, blank)
                let blankControl = try crop(control, blank)
                for i in stride(from: 0, to: blankControl.count, by: 4) where Array(blankControl[i..<i + 4]) == surface {
                    for channel in 0..<4 {
                        XCTAssertLessThanOrEqual(abs(Int(blankActual[i + channel]) - Int(surface[channel])), 1,
                                                 "Fade cannot lift or darken blank background")
                    }
                }
                // Sample actual glyph contrast, both near edge and beyond the
                // rejected 12pt seam. Reached side must be identical to control.
                let textRow = try XCTUnwrap(table.cells.first)
                let header = CGRect(x: 0, y: Space.md * scale, width: CGFloat(cg.width),
                                    height: floor((textRow.height - Space.md * 2) * scale))
                let center = CGRect(x: floor(table.rect.midX * scale), y: header.minY, width: 1, height: header.height)
                XCTAssertEqual(try crop(raster, center), try crop(control, center), "No whole-table content fade")
                let actual = try crop(raster, header)
                let expected = try crop(control, header)
                let pixelWidth = cg.width
                for (left, faded) in [(true, view.remainingLeft), (false, view.remainingRight)] {
                    var near: [Double] = [], far: [Double] = []
                    var inkSamples = 0
                    for i in stride(from: 0, to: expected.count, by: 4) {
                        let x = CGFloat((i / 4) % pixelWidth) / scale + 0.5 / scale
                        let distance = left ? x : table.rect.width - x
                        guard distance >= 4, distance < 26 else { continue }
                        let contrast = Int(expected[i]) - Int(surface[0])
                        guard contrast > 60 else { continue } // ink, not grid or blank fill
                        inkSamples += 1
                        let ratio = Double(Int(actual[i]) - Int(surface[0])) / Double(contrast)
                        if faded {
                            if distance < 10 { near.append(ratio) }
                            else if distance >= 14 { far.append(ratio) }
                        } else {
                            XCTAssertEqual(Array(actual[i..<i + 4]), Array(expected[i..<i + 4]),
                                           "Reached endpoint has no content fade")
                        }
                    }
                    XCTAssertGreaterThan(inkSamples, 0, "Endpoint and fade checks must witness actual content")
                    if faded {
                        XCTAssertFalse(near.isEmpty, "Near band must contain real glyphs")
                        XCTAssertFalse(far.isEmpty, "Broad band must contain real glyphs")
                        let nearMean = near.reduce(0, +) / Double(max(1, near.count))
                        let farMean = far.reduce(0, +) / Double(max(1, far.count))
                        XCTAssertLessThan(nearMean, 0.4)
                        XCTAssertGreaterThan(farMean, nearMean)
                        XCTAssertLessThan(farMean, 0.9, "Content still fades beyond 12pt, without a bright/dark seam")
                    }
                }
                let reference = XCTAttachment(image: control)
                reference.name = "table-content-reference-scale-\(scale)-offset-\(view.tableOffset)"
                reference.lifetime = .keepAlways
                add(reference)
                let evidence = XCTAttachment(image: raster)
                evidence.name = "table-content-fade-scale-\(scale)-offset-\(view.tableOffset)"
                evidence.lifetime = .keepAlways
                add(evidence)
            }
        }
    }

    func testOverflowFadeIncludesExtremeGlyphPixelsAtFractionalOffsetsAndLargeText() throws {
        let source = "Before café 👩🏽‍💻.\n\n| MMMMMMMMMMMMMMMM | MMMMMMMMMMMMMMMM | MMMMMMMMMMMMMMMM | MMMMMMMMMMMMMMMM |\n| --- | --- | --- | --- |\n| | | | |\n\nAfter table."
        func pixels(_ image: CGImage) throws -> [UInt8] {
            var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
            let context = try XCTUnwrap(CGContext(data: &bytes, width: image.width, height: image.height,
                bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return bytes
        }
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            for scale in [CGFloat(1), 2, 3] {
                let window = UIWindow(windowScene: try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene))
                let host = UIViewController()
                host.view.backgroundColor = UIColor(DuskColors.paper)
                window.rootViewController = host
                window.makeKeyAndVisible()
                defer { window.isHidden = true }
                let view = MessageDocumentView(frame: CGRect(x: 30, y: 80, width: 320, height: 600))
                host.view.addSubview(view)
                view.traitOverrides.preferredContentSizeCategory = category
                view.traitOverrides.displayScale = scale
                view.updateTraitsIfNeeded()
                view.update(source: source, literal: false)
                let layout = try XCTUnwrap(view.state.layout)
                let table = try XCTUnwrap(layout.tables.first)
                let edge = table.contentWidth - table.rect.width
                XCTAssertGreaterThan(edge, layout.bodyFont.pointSize * 2)
                let selected = (view.document.plain as NSString).range(of: "café 👩🏽‍💻")
                view.selectedTextRange = MessageTextRange(selected)
                let mapping = view.document.logicalToSource
                let format = UIGraphicsImageRendererFormat()
                format.scale = scale
                format.preferredRange = .standard
                let renderer = UIGraphicsImageRenderer(bounds: view.bounds, format: format)
                let well = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1), format: format).image { _ in
                    UIColor(DuskColors.bgSunk).setFill(); UIRectFill(CGRect(x: 0, y: 0, width: 1, height: 1))
                }
                let surface = try pixels(XCTUnwrap(well.cgImage))
                func control() -> UIImage {
                    renderer.image { render in
                        let context = render.cgContext
                        context.saveGState()
                        UIBezierPath(roundedRect: table.rect, cornerRadius: Radii.sm).addClip()
                        UIColor(DuskColors.bgSunk).setFill(); context.fill(table.rect)
                        UIColor(DuskColors.lineSoft).setStroke()
                        for cell in table.cells { context.stroke(cell.offsetBy(dx: -view.tableOffset, dy: 0), width: 0.5) }
                        for line in layout.lines where line.table == table.id {
                            context.saveGState()
                            context.textMatrix = .identity
                            context.translateBy(x: line.origin.x - view.tableOffset, y: line.origin.y + line.baseline)
                            context.scaleBy(x: 1, y: -1)
                            context.textPosition = .zero
                            CTLineDraw(line.text, context)
                            context.restoreGState()
                        }
                        context.restoreGState()
                    }
                }
                let firstCell = try XCTUnwrap(table.cells.first)
                let y = ceil((firstCell.minY + Space.md) * scale)
                let height = floor((firstCell.height - Space.md * 2) * scale) - 1
                func strip(_ image: UIImage, x: CGFloat, width: CGFloat = 1) throws -> [UInt8] {
                    try pixels(XCTUnwrap(image.cgImage?.cropping(to: CGRect(x: x, y: y, width: width, height: height))))
                }
                var witnessed: Set<Bool> = []
                var stats: [[String: Any]] = []
                // Bounded glyph-phase sweep makes each assertion witness actual
                // ink in the FIRST physical pixel, not an empty edge or a 4pt inset.
                for phase in 0..<Int(ceil(layout.bodyFont.pointSize * scale)) {
                    let requestedOffset = edge / 2 + (CGFloat(phase) + 0.75) / scale
                    view.setTableOffset(requestedOffset)
                    window.layoutIfNeeded()
                    view.layer.displayIfNeeded()
                    let capturedOffset = view.tableOffset
                    XCTAssertTrue(view.remainingLeft)
                    XCTAssertTrue(view.remainingRight)
                    let expected = control()
                    let actual = renderer.image { _ in view.draw(view.bounds) }
                    for left in [true, false] where !witnessed.contains(left) {
                        let x: CGFloat = left ? 0 : table.rect.width * scale - 1
                        let reference = try strip(expected, x: x)
                        let painted = try strip(actual, x: x)
                        var ratios: [Double] = []
                        for i in stride(from: 0, to: reference.count, by: 4) {
                            let contrast = Int(reference[i]) - Int(surface[0])
                            guard contrast > 60 else { continue }
                            XCTAssertEqual(painted[i + 3], reference[i + 3], "Rounded/opaque destination alpha unchanged")
                            ratios.append(Double(Int(painted[i]) - Int(surface[0])) / Double(contrast))
                        }
                        guard let maximum = ratios.max() else { continue }
                        witnessed.insert(left)
                        if scale > 1 {
                            XCTAssertNotEqual(capturedOffset, capturedOffset.rounded(), "Witness actual fractional-point native offset")
                        }
                        XCTAssertLessThanOrEqual(maximum, 0.06, "Extreme clipped glyph pixel must fade; no bright perimeter shard")
                        let label = "table-extreme-\(category.rawValue)-scale-\(scale)-\(left ? "left" : "right")"
                        for (suffix, image) in [("full-context", actual), ("unfaded-control", expected)] {
                            let attachment = XCTAttachment(image: image)
                            attachment.name = label + "-" + suffix
                            attachment.lifetime = .keepAlways
                            add(attachment)
                        }
                        let fullFrame = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { render in
                            window.layer.render(in: render.cgContext)
                        }
                        let fullFrameAttachment = XCTAttachment(image: fullFrame)
                        fullFrameAttachment.name = label + "-mounted-window"
                        fullFrameAttachment.lifetime = .keepAlways
                        add(fullFrameAttachment)
                        let mounted = try pixels(XCTUnwrap(fullFrame.cgImage?.cropping(to: CGRect(
                            x: view.frame.minX * scale + x, y: view.frame.minY * scale + y, width: 1, height: height))))
                        var mountedRatios: [Double] = []
                        for i in stride(from: 0, to: reference.count, by: 4) {
                            let contrast = Int(reference[i]) - Int(surface[0])
                            guard contrast > 60 else { continue }
                            mountedRatios.append(Double(Int(mounted[i]) - Int(surface[0])) / Double(contrast))
                        }
                        XCTAssertLessThanOrEqual(try XCTUnwrap(mountedRatios.max()), 0.06,
                                                 "Actual mounted layer must also fade extreme glyphs")
                        XCTAssertEqual(view.tableOffset, capturedOffset, "Controls and mounted raster use same native offset")
                        stats.append(["side": left ? "left" : "right", "scale": scale, "fontSize": layout.bodyFont.pointSize,
                                      "category": category.rawValue, "requestedOffset": requestedOffset,
                                      "nativeOffset": capturedOffset, "physicalX": x,
                                      "physicalY": y, "windowPhysicalX": view.frame.minX * scale + x,
                                      "windowPhysicalY": view.frame.minY * scale + y, "inkSamples": ratios.count,
                                      "maxTransmission": maximum, "mountedMaxTransmission": try XCTUnwrap(mountedRatios.max())])
                    }
                    if witnessed.count == 2 { break }
                }
                XCTAssertEqual(witnessed.count, 2, "Both extreme edges must contain real glyph ink")
                let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: stats, options: [.sortedKeys]), uniformTypeIdentifier: "public.json")
                attachment.name = "table-extreme-stats-\(category.rawValue)-scale-\(scale)"
                attachment.lifetime = .keepAlways
                add(attachment)
                // Large text endpoints still clear fully, not just interior bands.
                for (offset, left) in [(CGFloat(0), true), (edge, false)] {
                    view.setTableOffset(offset)
                    let actual = renderer.image { _ in view.draw(view.bounds) }
                    let expected = control()
                    let width = 32 * scale
                    let x = left ? 0 : table.rect.width * scale - width
                    XCTAssertEqual(try strip(actual, x: x, width: width), try strip(expected, x: x, width: width),
                                   "Reached side must have no fade, including extreme physical pixels")
                }
                let scroll = try XCTUnwrap(view.subviews.compactMap { $0 as? UIScrollView }.first)
                XCTAssertEqual(scroll.contentOffset.x, view.tableOffset)
                XCTAssertEqual(view.document.logicalToSource, mapping)
                XCTAssertEqual(view.state.selection, selected)
                view.copy(nil)
                XCTAssertEqual(UIPasteboard.general.string, "café 👩🏽‍💻")
            }
        }
    }

    func testTaskRastersMatchNativeCheckboxRestStates() throws {
        // Compare the face plus 6pt surrounding shadow, not transparent padding.
        func pixels(_ image: UIImage) throws -> [UInt8] {
            let format = UIGraphicsImageRendererFormat()
            format.scale = image.scale
            format.preferredRange = .standard
            let crop = UIGraphicsImageRenderer(size: CGSize(width: 34, height: 34), format: format).image { _ in
                UIColor(DuskColors.paper).setFill()
                UIRectFill(CGRect(x: 0, y: 0, width: 34, height: 34))
                image.draw(at: CGPoint(x: 17 - image.size.width / 2, y: 17 - image.size.height / 2))
            }
            let cg = try XCTUnwrap(crop.cgImage)
            var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
            let context = try XCTUnwrap(CGContext(data: &bytes, width: cg.width, height: cg.height,
                bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            return bytes
        }
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            for contrast in [UIAccessibilityContrast.normal, .high] {
                let traits = UITraitCollection(traitsFrom: [UITraitCollection(preferredContentSizeCategory: category),
                    UITraitCollection(displayScale: 3), UITraitCollection(accessibilityContrast: contrast)])
                let layout = MessageDocumentLayout(document: MessageDocument(source: "- [x] Checked\n- [ ] Unchecked"), width: 320, traits: traits)
                let scale = 3 * layout.bodyFont.pointSize / TypeScale.base
                for marker in layout.markers {
                    let reference = ImageRenderer(content: DesignCheckboxMark(rasterContrast: contrast == .high,
                        isOn: marker.label == "☑", isEnabled: true, hovered: false, focused: false)
                        .padding(DesignMaterialAdapter.smallControlMaximumOverflow).environment(\.displayScale, scale))
                    reference.scale = scale
                    let expected = try pixels(XCTUnwrap(reference.uiImage))
                    let actual = try pixels(XCTUnwrap(marker.image))
                    XCTAssertEqual(actual.count, expected.count)
                    let difference = zip(actual, expected).enumerated().reduce(0) { sum, entry in
                        sum + (entry.offset % 4 == 3 ? 0 : abs(Int(entry.element.0) - Int(entry.element.1)))
                    }
                    // CG and Canvas blur/antialias kernels differ slightly;
                    // allow <2/255 mean RGB error across face and nearby shadow.
                    XCTAssertLessThan(Double(difference) / Double(actual.count / 4 * 3), 2)
                }
            }
        }
    }

    func testMeasuredSiblingGuttersAndTaskRasterRetention() throws {
        for start in [9, 99] {
            let source = "\(start). First item with enough text to wrap over several lines at narrow widths.\n\n    Continuation paragraph stays aligned.\n\n    - [x] Nested checked task with wrapping content.\n    - [ ] Nested unchecked task.\n\n\(start + 1). Second item with enough text to wrap too."
            let document = MessageDocument(source: source)
            for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
                let traits = UITraitCollection(traitsFrom: [UITraitCollection(preferredContentSizeCategory: category), UITraitCollection(displayScale: 3)])
                let layout = MessageDocumentLayout(document: document, width: 320, traits: traits)
                func leading(_ needle: String) throws -> CGFloat {
                    let range = (document.plain as NSString).range(of: needle)
                    return try XCTUnwrap(layout.lines.first { NSLocationInRange(range.location, $0.range) }).origin.x
                }
                let first = try leading("First item")
                XCTAssertEqual(first, try leading("Second item"))
                XCTAssertEqual(first, try leading("Continuation paragraph"))
                let ordered = layout.markers.filter { $0.label.hasSuffix(".") }
                XCTAssertEqual(ordered.map(\.label), ["\(start).", "\(start + 1)."])
                XCTAssertEqual(ordered[0].point.x + ordered[0].width, ordered[1].point.x + ordered[1].width, accuracy: 0.01)
                XCTAssertGreaterThan(first - ordered[1].point.x - ordered[1].width, 0)
                let nested = try leading("Nested checked")
                XCTAssertGreaterThan(nested, first)
                XCTAssertEqual(nested, try leading("Nested unchecked"))
                for block in document.blocks where block.marker == "\(start)." {
                    XCTAssertTrue(layout.lines.filter { NSIntersectionRange($0.range, block.range).length > 0 }.allSatisfy { $0.origin.x == first })
                }
                let tasks = layout.markers.filter { $0.label == "☑" || $0.label == "☐" }
                XCTAssertEqual(tasks.count, 2)
                XCTAssertTrue(tasks.allSatisfy { $0.image != nil && $0.point.x + $0.width < nested })
                XCTAssertTrue(layout.reading.contains { $0.label.hasPrefix("Checked, ") })
                XCTAssertTrue(layout.reading.contains { $0.label.hasPrefix("Unchecked, ") })
                let warm = MessageDocumentLayout(document: document, width: 300, traits: traits)
                let warmTasks = warm.markers.filter { $0.image != nil }
                XCTAssertTrue(zip(tasks, warmTasks).allSatisfy { $0.image === $1.image }, "Reflow reuses native decorative rasters")
                if start == 99 {
                    let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 320, height: min(900, layout.height)))
                    let window = UIWindow(windowScene: try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene))
                    let host = UIViewController()
                    window.rootViewController = host
                    host.view.addSubview(view)
                    window.makeKeyAndVisible()
                    defer { window.isHidden = true }
                    view.traitOverrides.preferredContentSizeCategory = category
                    view.traitOverrides.displayScale = 3
                    view.updateTraitsIfNeeded()
                    view.update(source: source, literal: false)
                    XCTAssertEqual(view.state.layout?.bodyFont.pointSize, layout.bodyFont.pointSize)
                    let raster = UIGraphicsImageRenderer(bounds: view.bounds).image { _ in
                        UIColor(DuskColors.paper).setFill(); UIRectFill(view.bounds)
                        view.draw(view.bounds)
                    }
                    let evidence = XCTAttachment(image: raster)
                    evidence.name = "list-task-gutters-\(category.rawValue)"; evidence.lifetime = .keepAlways; add(evidence)
                }
            }
        }
    }

    func testExplicitDismissalAndResponderTransferDoNotBreakRecycleRetention() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let host = UIViewController()
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 100, width: 280, height: 800))
        view.update(source: source, literal: false)
        host.view.addSubview(view)
        XCTAssertTrue(view.becomeFirstResponder())
        view.selectAll(nil)
        view.setTableOffset(60)
        let range = view.state.selection
        let offsets = view.state.tableOffsets
        view.prepareForUnmount()
        view.removeFromSuperview()
        XCTAssertEqual(view.state.selection, range)
        host.view.addSubview(view)
        XCTAssertTrue(view.becomeFirstResponder())
        view.dismissSelection()
        XCTAssertNil(view.state.selection)
        XCTAssertEqual(view.state.tableOffsets, offsets)
        XCTAssertFalse(view.selectionEdge.isRunning)
        XCTAssertTrue(view.becomeFirstResponder())
        view.selectAll(nil)
        let field = UITextField(frame: CGRect(x: 0, y: 40, width: 100, height: 40))
        host.view.addSubview(field)
        XCTAssertTrue(field.becomeFirstResponder())
        XCTAssertNil(view.state.selection)
        XCTAssertTrue(view.becomeFirstResponder())
        view.selectAll(nil)
        view.update(source: "", literal: false)
        let display = try XCTUnwrap(view.interactions.compactMap { $0 as? UITextSelectionDisplayInteraction }.first)
        XCTAssertFalse(display.isActivated, "Streaming deletion must not leave active handles on a collapsed range")
    }

    func testMixedRendererLayoutWorkload() {
        let mixed = (1...12).map { index in
            "\(index). Wrapped list content with café 👩🏽‍💻 and enough words for continuation.\n\n   Continuation paragraph.\n\n   - [x] Checked nested task\n   - [ ] Unchecked nested task\n\n| Name | Observation | Value |\n| :--- | :---: | ---: |\n| Alpha | Wide mixed content for scrolling \(index) | 42 |\n| Beta | café 👩🏽‍💻 e\u{301} | 7 |"
        }.joined(separator: "\n\n")
        let traits = UITraitCollection(preferredContentSizeCategory: .large)
        let start = CACurrentMediaTime()
        let state = MessageDocumentState(source: mixed)
        let layout = state.measure(width: 300, traits: traits)
        let cold = CACurrentMediaTime() - start
        let warmStart = CACurrentMediaTime()
        for _ in 0..<100 { XCTAssertTrue(state.measure(width: 300, traits: traits) === layout) }
        let warm = CACurrentMediaTime() - warmStart
        let streamStart = CACurrentMediaTime()
        for index in 0..<12 {
            state.update(source: mixed + "\n\nStreaming " + String(repeating: "token ", count: index), literal: false)
            _ = state.measure(width: 300, traits: traits)
        }
        let report = "mixed-layout cold=\(cold) warm100=\(warm) stream12=\(CACurrentMediaTime() - streamStart) lines=\(layout.lines.count) tables=\(layout.tables.count)"
        print(report)
        let attachment = XCTAttachment(string: report)
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testSameLayoutMultiTableCopyAndRecycledState() throws {
        let state = MessageDocumentState(source: source)
        // Narrow viewport keeps both content-aware tables genuinely scrollable.
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 180, height: 1000))
        view.state = state
        view.rebuild()
        let measured = state.measure(width: 180, traits: view.traitCollection)
        XCTAssertTrue(measured.bodyFont.familyName.contains("DM Sans"))
        XCTAssertTrue(state.layout === measured)
        XCTAssertEqual(view.measuredHeight, measured.height)
        let tables = measured.tables
        XCTAssertEqual(tables.count, 2)
        let menu = try XCTUnwrap(view.interactions.compactMap { $0 as? UIContextMenuInteraction }.first)
        for table in tables {
            let configuration = view.contextMenuInteraction(menu, configurationForMenuAtLocation: CGPoint(x: table.rect.minX + 2, y: table.rect.minY + 2))
            XCTAssertEqual(configuration?.identifier as? UUID, table.id, "Background menu targets its own table, not the previously active table")
        }
        view.activateTable(at: CGPoint(x: 10, y: tables[0].rect.midY))
        view.setTableOffset(70)
        let firstOffset = view.tableOffset
        view.activateTable(at: CGPoint(x: 10, y: tables[1].rect.midY))
        view.setTableOffset(30)
        XCTAssertEqual(view.tableOffset(id: tables[0].id), firstOffset)
        XCTAssertEqual(view.tableOffset(id: tables[1].id), 30)
        let plain = view.document.plain as NSString
        let start = plain.range(of: "partial").location
        let end = NSMaxRange(plain.range(of: "Between שלום مرحبا."))
        let selection = NSRange(location: start, length: end - start)
        view.selectedTextRange = MessageTextRange(selection)
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, "partial 👩🏽‍💻 text e\u{301}\t42 | units\nBeta\tA readable long column that must keep its horizontal offset\t7\\8\nBetween שלום مرحبا.")
        view.copyTableMarkdown(id: tables[1].id)
        XCTAssertEqual(UIPasteboard.general.string, "|Left               |Right                          |\n|-------------------|-------------------------------|\n|wide wide wide wide|another independently wide cell|")

        // Source unchanged when terminal status changes: no layout replacement.
        state.update(source: source, literal: false)
        XCTAssertTrue(state.measure(width: 180, traits: view.traitCollection) === measured)
        let recycled = MessageDocumentView(frame: view.frame)
        recycled.state = state
        recycled.rebuild()
        XCTAssertTrue(recycled.state.layout === measured)
        XCTAssertEqual((recycled.selectedTextRange as? MessageTextRange)?.value, selection)
        XCTAssertEqual(recycled.tableOffset(id: tables[0].id), firstOffset)
        XCTAssertEqual(recycled.tableOffset(id: tables[1].id), 30)
        recycled.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, view.document.plain(in: selection))
    }

    func testFractionalTableEdgesShareNativeProgrammaticAXAndSelectionOffsets() throws {
        let window = UIWindow(windowScene: try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene))
        let host = UIViewController()
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        // Readable budgets exceed the initial viewport: derive fractional
        // overflow from real content, never a fitting table's stretched width.
        let tableSource = "| Heading one | Heading two | Heading three |\n| --- | --- | --- |\n| wide wide wide wide | wide wide wide wide | end wide wide wide |"
        for scale in [CGFloat(1), 2, 3] {
            for fraction in [CGFloat(0.25), 0.75] {
                let view = MessageDocumentView(frame: CGRect(x: 12, y: 100, width: 200, height: 600))
                host.view.addSubview(view)
                defer { view.selectionEdge.stop(); view.removeFromSuperview() }
                view.traitOverrides.displayScale = scale
                view.traitOverrides.preferredContentSizeCategory = .large
                view.updateTraitsIfNeeded()
                view.update(source: tableSource + "\n\nbetween\n\n" + tableSource, literal: false)
                let contentWidth = try XCTUnwrap(view.state.layout?.tables.first?.contentWidth)
                view.frame.size.width = contentWidth - 40 - fraction / scale
                view.rebuild()
                let layout = try XCTUnwrap(view.state.layout)
                let scrolls = view.subviews.compactMap { $0 as? UIScrollView }
                XCTAssertEqual(scrolls.count, 2)
                XCTAssertEqual(view.traitCollection.displayScale, scale)
                for table in layout.tables {
                    let scroll = try XCTUnwrap(scrolls.first { $0.frame == table.rect })
                    let rawEdge = table.contentWidth - table.rect.width
                    XCTAssertEqual(rawEdge, 40 + fraction / scale, accuracy: 0.000001)
                    let edge = ceil(rawEdge * scale) / scale
                    XCTAssertGreaterThanOrEqual(edge, rawEdge, "Never drop remaining fractional content")
                    XCTAssertLessThan(edge - rawEdge, 1 / scale)
                    XCTAssertEqual(scroll.contentSize.width - scroll.bounds.width, edge, accuracy: 0.000001)
                    view.activateTable(at: CGPoint(x: table.rect.midX, y: table.rect.midY))
                    let cell = try XCTUnwrap(view.accessibilityElements?.compactMap { $0 as? MessageReadingElement }.first { $0.tableID == table.id })
                    let line = try XCTUnwrap(layout.lines.last { $0.table == table.id })
                    let position = MessageTextPosition(line.range.location)
                    view.setTableOffset(0)
                    let initialCaret = view.caretRect(for: position)
                    func assertOffsetAgreement(right: Bool) {
                        XCTAssertEqual(view.tableOffset(id: table.id), scroll.contentOffset.x)
                        XCTAssertEqual(view.caretRect(for: position).minX, initialCaret.minX - scroll.contentOffset.x, accuracy: 0.000001)
                        XCTAssertEqual(view.remainingRight, right)
                        XCTAssertEqual(view.tableCanScrollRight(id: table.id), right)
                        XCTAssertEqual(cell.accessibilityCustomActions?.contains { $0.name == "Scroll table right" }, right)
                    }
                    XCTAssertFalse(view.remainingLeft)
                    assertOffsetAgreement(right: true)
                    view.setTableOffset(edge / 2)
                    XCTAssertTrue(view.remainingLeft)
                    assertOffsetAgreement(right: true)
                    // A whole native pixel remains: no broad tolerance may hide it.
                    view.setTableOffset(edge - 1 / scale)
                    assertOffsetAgreement(right: true)
                    view.setTableOffset(rawEdge)
                    XCTAssertEqual(view.tableOffset, edge, accuracy: 0.000001)
                    XCTAssertTrue(view.remainingLeft)
                    assertOffsetAgreement(right: false)
                    XCTAssertFalse(cell.accessibilityScroll(.left), "Repeated AX terminal request has no motion")
                    XCTAssertTrue(cell.accessibilityScroll(.right))
                    assertOffsetAgreement(right: true)
                    XCTAssertTrue(cell.accessibilityScroll(.left))
                    assertOffsetAgreement(right: false)
                    // Native delegate path uses the same reached edge as AX/setter.
                    scroll.setContentOffset(.zero, animated: false)
                    assertOffsetAgreement(right: true)
                    scroll.setContentOffset(CGPoint(x: scroll.contentSize.width - scroll.bounds.width, y: 0), animated: false)
                    assertOffsetAgreement(right: false)
                    // The production selection frame step must reach that edge too.
                    view.setTableOffset(edge - 1 / scale)
                    view.selectedTextRange = MessageTextRange(line.range)
                    let caret = view.caretRect(for: MessageTextPosition(NSMaxRange(line.range)))
                    let pointer = view.convert(CGPoint(x: table.rect.maxX - 1, y: caret.midY), to: window)
                    view.selectionEdge.sample(pointer, handleAnchor: line.range.location)
                    view.selectionEdge.nativeGestureChanged(.began, id: ObjectIdentifier(view))
                    view.selectionEdge.advance(at: 1)
                    view.selectionEdge.advance(at: 2)
                    view.selectionEdge.stop()
                    XCTAssertEqual(view.tableOffset, edge, accuracy: 0.000001)
                    assertOffsetAgreement(right: false)
                    view.stopTableMotion()
                    view.update(source: view.document.source + "\n\nappended", literal: false)
                    assertOffsetAgreement(right: false)
                    // A remounted view uses the same retained offset/geometry.
                    let reopened = MessageDocumentView(frame: view.frame)
                    reopened.traitOverrides.displayScale = scale
                    reopened.updateTraitsIfNeeded()
                    reopened.state = view.state
                    reopened.activateTable(at: CGPoint(x: table.rect.midX, y: table.rect.midY))
                    reopened.setTableOffset(.greatestFiniteMagnitude)
                    XCTAssertFalse(reopened.remainingRight)
                    XCTAssertEqual(reopened.tableOffset, view.tableOffset, accuracy: 0.000001)
                }
                view.frame.size.width = contentWidth + 1
                view.rebuild()
                for table in try XCTUnwrap(view.state.layout).tables {
                    view.activateTable(at: CGPoint(x: table.rect.midX, y: table.rect.midY))
                    view.setTableOffset(.greatestFiniteMagnitude)
                    XCTAssertEqual(view.tableOffset, 0)
                    XCTAssertFalse(view.remainingLeft)
                    XCTAssertFalse(view.remainingRight)
                    XCTAssertFalse(view.scrollTable(id: table.id, direction: .left))
                }
            }
        }
    }

    func testTableHasNoReservedControlsAndBackgroundExcludesText() throws {
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 180, height: 2000))
        view.update(source: "| Header | Other |\n| --- | --- |\n| text | |", literal: false)
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            view.traitOverrides.preferredContentSizeCategory = category
            view.updateTraitsIfNeeded()
            view.rebuild()
            XCTAssertEqual(view.traitCollection.preferredContentSizeCategory, category)
            let layout = try XCTUnwrap(view.state.layout)
            let table = try XCTUnwrap(layout.tables.first)
            XCTAssertEqual(table.rect.minY, 0)
            XCTAssertFalse(view.subviews.contains { $0 is any UIContentView })
            XCTAssertEqual(view.tableBackground(at: CGPoint(x: table.rect.minX + 2, y: table.rect.minY + 2)), table.id)
            let first = try XCTUnwrap(layout.lines.first)
            XCTAssertNil(view.tableBackground(at: CGPoint(x: first.origin.x + 2, y: first.origin.y + first.height / 2)))
            view.setTableOffset(max(0, table.contentWidth - table.rect.width))
            let empty = try XCTUnwrap(table.cells.last)
            XCTAssertEqual(view.tableBackground(at: CGPoint(x: empty.midX - view.tableOffset, y: empty.midY)), table.id)
            view.setTableOffset(0)
            view.selectAll(nil)
            view.copy(nil)
            XCTAssertEqual(UIPasteboard.general.string, view.document.tableMarkdown(id: table.id))
        }
    }

    func testDecorativeCheckboxRasterFeasibility() throws {
        let start = CACurrentMediaTime()
        var images: [UIImage] = []
        for checked in [false, true] {
            let renderer = ImageRenderer(content: DesignCheckboxMark(rasterContrast: false, isOn: checked, isEnabled: true, hovered: false, focused: false)
                .padding(48).environment(\.displayScale, 3))
            renderer.scale = 3
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertGreaterThan(image.size.width, 22)
            images.append(image)
        }
        let renderSeconds = CACurrentMediaTime() - start
        XCTAssertNotEqual(images[0].pngData(), images[1].pngData())
        let pixels = try XCTUnwrap(images[0].cgImage?.dataProvider?.data)
        XCTAssertTrue((CFDataGetBytePtr(pixels).map { pointer in (0..<CFDataGetLength(pixels)).contains { pointer[$0] != 0 } }) == true)
        print("checkbox-native-raster pairRenderSeconds=\(renderSeconds) renderAndVerificationSeconds=\(CACurrentMediaTime() - start) bytes=\(images.reduce(0) { $0 + ($1.cgImage?.bytesPerRow ?? 0) * ($1.cgImage?.height ?? 0) })")
    }

    func testSyntaxReinterpretationBidiAndGeometryUseActualCTLines() throws {
        let view = MessageDocumentView(frame: CGRect(x: 0, y: 0, width: 300, height: 500))
        view.update(source: "**café 👩🏽‍💻", literal: false)
        view.selectedTextRange = MessageTextRange((view.document.plain as NSString).range(of: "café 👩🏽‍💻"))
        view.update(source: "**café 👩🏽‍💻**", literal: false)
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, "café 👩🏽‍💻")
        view.update(source: "English שלום مرحبا café e\u{301} 👩🏽‍💻", literal: true)
        view.selectAll(nil)
        let range = try XCTUnwrap(view.selectedTextRange)
        let rectangles = view.selectionRects(for: range)
        XCTAssertTrue(rectangles.contains { $0.writingDirection == .rightToLeft })
        XCTAssertTrue(rectangles.contains { $0.writingDirection == .leftToRight })
        XCTAssertTrue(rectangles.allSatisfy { !$0.rect.isEmpty })
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, view.document.source)
        let emoji = (view.document.plain as NSString).range(of: "👩🏽‍💻")
        let caret = view.caretRect(for: MessageTextPosition(emoji.location))
        let hit = try XCTUnwrap(view.closestPosition(to: CGPoint(x: caret.minX + 0.1, y: caret.midY)) as? MessageTextPosition)
        XCTAssertEqual(view.document.graphemeBoundary(hit.index), hit.index)
        view.frame.size.width = 220
        view.traitOverrides.preferredContentSizeCategory = .accessibilityExtraLarge
        view.rebuild()
        XCTAssertEqual((view.selectedTextRange as? MessageTextRange)?.value, (range as? MessageTextRange)?.value)
        XCTAssertTrue(view.measuredHeight > 0)
    }
    func testAccessibleLinksIndependentTablesAndControlledImageArrival() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        let view = MessageDocumentView(frame: CGRect(x: 12, y: 60, width: 280, height: 700))
        let loader = DelayedImageLoader()
        let url = URL(string: "https://fixture.invalid/accessible.png")!
        view.imageCache = MarkdownImageCache(loader: loader)
        view.update(source: "[Safe link](https://example.invalid/path)\n\n![Controlled photo](\(url.absoluteString))\n\n| Name | Value |\n| --- | --- |\n| café | 42 |\n\n| Other | Value |\n| --- | --- |\n| 東京 | 7 |", literal: false)
        controller.view.addSubview(view)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        defer { window.isHidden = true }
        let layout = try XCTUnwrap(view.state.layout)
        let height = view.measuredHeight
        let elements = try XCTUnwrap(view.accessibilityElements?.compactMap { $0 as? MessageReadingElement })
        let link = try XCTUnwrap(elements.first { $0.accessibilityLabel == "Safe link" })
        let action = try XCTUnwrap(link.accessibilityCustomActions?.first)
        var opened: URL?
        view.openLink = { opened = $0 }
        XCTAssertTrue(action.actionHandler?(action) == true)
        XCTAssertEqual(opened?.absoluteString, "https://example.invalid/path")
        let picture = try XCTUnwrap(elements.first { $0.imageFrame != nil })
        XCTAssertEqual(picture.accessibilityLabel, "Controlled photo")
        XCTAssertEqual(picture.accessibilityValue, "Loading image")
        XCTAssertFalse(picture.accessibilityFrame.isEmpty)
        XCTAssertEqual(Set(elements.compactMap(\.tableID)).count, 2)
        for id in Set(elements.compactMap(\.tableID)) {
            let cell = try XCTUnwrap(elements.first { $0.tableID == id })
            let copy = try XCTUnwrap(cell.accessibilityCustomActions?.first { $0.name == "Copy table as Markdown" })
            XCTAssertTrue(copy.actionHandler?(copy) == true)
            XCTAssertEqual(UIPasteboard.general.string, view.document.tableMarkdown(id: id))
        }
        await loader.resolve(url: url, image: testImage(width: 240, height: 180))
        let deadline = Date().addingTimeInterval(2)
        while picture.accessibilityValue != nil && Date() < deadline { await Task.yield() }
        XCTAssertNil(picture.accessibilityValue)
        XCTAssertTrue(view.state.layout === layout)
        XCTAssertEqual(view.measuredHeight, height)

        let broken = URL(string: "https://fixture.invalid/broken.png")!
        view.update(source: "![Broken photo](\(broken.absoluteString))", literal: false)
        let failureDeadline = Date().addingTimeInterval(2)
        while await loader.requestCount(for: broken) == 0 && Date() < failureDeadline { await Task.yield() }
        await loader.reject(url: broken)
        while view.imageAccessibilityValue(for: broken) == "Loading image" && Date() < failureDeadline { await Task.yield() }
        XCTAssertEqual(view.imageAccessibilityValue(for: broken), "Preview unavailable")
        view.update(source: view.document.source + "\n\nAppended text", literal: false)
        await Task.yield()
        let requests = await loader.requestCount(for: broken)
        XCTAssertEqual(requests, 1, "Settled failures must not retry on streaming updates")
    }

    func testTrailingEmptyAltImagesInNeighboringParagraphs() async throws {
        try await checkEmptyAltImages(
            source: "before ![](https://fixture.invalid/0.png)![](https://fixture.invalid/1.png)\n\n![](https://fixture.invalid/2.png)![](https://fixture.invalid/3.png)\n\nneighbor",
            plain: "before \n\nneighbor", imageCount: 4
        )
    }

    func testTrailingEmptyAltImagesInNeighboringTableCells() async throws {
        try await checkEmptyAltImages(
            source: "before ![](https://fixture.invalid/0.png)\n\n| Head ![](https://fixture.invalid/1.png)![](https://fixture.invalid/2.png) | ![](https://fixture.invalid/3.png) |\n| --- | --- |\n| cell ![](https://fixture.invalid/4.png) | ![](https://fixture.invalid/5.png) |\n| neighbor | last |\n\nafter ![](https://fixture.invalid/6.png)",
            plain: "before \nHead \t\ncell \t\nneighbor\tlast\nafter ", imageCount: 7
        )
    }

    func testConsecutiveEmptyAltImagesHaveDistinctReadingIdentities() async throws {
        try await checkEmptyAltImages(
            source: "![](https://fixture.invalid/0.png)![](https://fixture.invalid/1.png)",
            plain: "", imageCount: 2
        )
    }

    private func checkEmptyAltImages(source: String, plain: String, imageCount: Int) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        window.rootViewController = controller
        let view = MessageDocumentView(frame: CGRect(x: 12, y: 60, width: 180, height: 2400))
        let loader = DelayedImageLoader()
        view.imageCache = MarkdownImageCache(loader: loader)
        view.update(source: source, literal: false)
        controller.view.addSubview(view)
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        defer { window.isHidden = true; view.removeFromSuperview() }
        let layout = try XCTUnwrap(view.state.layout)
        XCTAssertEqual(view.document.plain, plain, "No fake selectable alt text")
        XCTAssertEqual(layout.pictures.count, imageCount)
        let readings = layout.reading.filter { $0.imageFrame != nil }
        XCTAssertEqual(readings.count, imageCount)
        XCTAssertEqual(Set(readings.map(\.id)).count, imageCount)
        guard layout.pictures.count == imageCount, readings.count == imageCount else { return }
        // Read each mounted image while visible, including vertically offscreen
        // rows. Public AX correctly omits pictures outside window/table clips.
        func imageElements() throws -> [MessageReadingElement] {
            try layout.pictures.map { picture in
                view.frame.origin.y = 60 - picture.rect.minY
                return try XCTUnwrap(view.accessibilityElements?.compactMap { $0 as? MessageReadingElement }.first {
                    $0.imageFrame != nil && $0.imageURL == picture.media.url
                })
            }
        }
        let elements = try imageElements()
        XCTAssertEqual(Set(elements.map(ObjectIdentifier.init)).count, imageCount, "Same-position images must not alias AX objects")
        guard Set(elements.map(ObjectIdentifier.init)).count == imageCount else { return }
        for (index, picture) in layout.pictures.enumerated() {
            XCTAssertEqual(picture.media.url?.absoluteString, "https://fixture.invalid/\(index).png", "Source order; no adjacent owner duplication")
            XCTAssertEqual(picture.rect.height, 160)
            XCTAssertEqual(elements[index].accessibilityLabel, "Image")
            XCTAssertTrue(elements[index].accessibilityTraits.contains(.image))
            view.frame.origin.y = 60 - picture.rect.minY
            XCTAssertFalse(elements[index].accessibilityFrame.isEmpty)
            XCTAssertEqual(elements[index].imageFrame, picture.rect)
            XCTAssertEqual(elements[index].tableID, picture.table)
            if let id = picture.table {
                let table = try XCTUnwrap(layout.tables.first { $0.id == id })
                XCTAssertEqual(table.cells.filter { $0.contains(picture.rect) }.count, 1, "Exactly one cell owns reserved picture geometry")
            } else {
                let owner = try XCTUnwrap(view.document.blocks.first { $0.kind != .table && NSMaxRange($0.range) == picture.media.range.location })
                XCTAssertTrue(readings[index].id.hasPrefix(owner.id.uuidString))
            }
        }
        let frames = layout.pictures.map(\.rect)
        let ids = view.document.blocks.map(\.id)
        let height = view.measuredHeight
        view.selectAll(nil)
        let selection = (view.selectedTextRange as? MessageTextRange)?.value
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string ?? "", view.document.clipboardText(in: try XCTUnwrap(selection)))
        for table in layout.tables {
            view.activateTable(at: CGPoint(x: 10, y: table.rect.midY))
            view.setTableOffset(30)
        }
        let offsets = view.state.tableOffsets
        for element in elements {
            let url = try XCTUnwrap(element.imageURL)
            let deadline = Date().addingTimeInterval(2)
            while await loader.requestCount(for: url) == 0 && Date() < deadline { await Task.yield() }
            let requests = await loader.requestCount(for: url)
            XCTAssertEqual(requests, 1, "Controlled loader receives every empty-alt image")
            XCTAssertEqual(element.accessibilityValue, "Loading image")
            await loader.resolve(url: url, image: testImage(width: 32, height: 24))
            while element.accessibilityValue != nil && Date() < deadline { await Task.yield() }
            XCTAssertNil(element.accessibilityValue)
        }
        XCTAssertTrue(view.state.layout === layout, "Arrival cannot introduce alternate measurement")
        XCTAssertEqual(view.measuredHeight, height)
        XCTAssertEqual(layout.pictures.map(\.rect), frames)
        view.rebuild()
        view.update(source: source + "\n\nstreamed neighbor", literal: false)
        XCTAssertEqual(Array(view.document.blocks.map(\.id).prefix(ids.count)), ids)
        XCTAssertEqual((view.selectedTextRange as? MessageTextRange)?.value, selection)
        XCTAssertEqual(view.state.tableOffsets, offsets)
        let updated = try imageElements()
        XCTAssertEqual(updated.map(ObjectIdentifier.init), elements.map(ObjectIdentifier.init), "Streaming retains distinct image AX identities")
        XCTAssertEqual(try XCTUnwrap(view.state.layout).pictures.map(\.rect), frames,
                       "Appending after unchanged blocks must preserve their image geometry")
        for element in elements {
            let requests = await loader.requestCount(for: try XCTUnwrap(element.imageURL))
            XCTAssertEqual(requests, 1)
        }
    }

    func testReduceMotionStopsStreamingDecorationWithoutChangingLayoutOrCopy() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let state = MessageDocumentState(source: "Streaming café 👩🏽‍💻")
        func documents(_ view: UIView) -> [MessageDocumentView] {
            (view as? MessageDocumentView).map { [$0] } ?? view.subviews.flatMap(documents)
        }
        func animations(_ layer: CALayer) -> Int {
            (layer.animationKeys()?.count ?? 0) + (layer.sublayers ?? []).reduce(0) { $0 + animations($1) }
        }
        let reduced = UIAccessibility.isReduceMotionEnabled
        let ready = expectation(description: "native surface ready")
        ready.assertForOverFulfill = false
        let host = UIHostingController(rootView:
            MessageDocumentSurface(source: state.document.source, streaming: true, state: state, onReady: { _ in ready.fulfill() })
                .frame(width: 280)
        )
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        await fulfillment(of: [ready], timeout: 3)
        window.layoutIfNeeded()
        let view = try XCTUnwrap(documents(host.view).first)
        XCTAssertEqual(animations(view.layer) > 0, !reduced)
        let layout = try XCTUnwrap(view.state.layout)
        view.update(source: state.document.source, literal: false)
        XCTAssertTrue(view.state.layout === layout)
        let evidence = XCTAttachment(string: "reduceMotion=\(reduced),activeAnimationCount=\(animations(view.layer))")
        evidence.lifetime = .keepAlways
        add(evidence)
        view.selectAll(nil)
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, state.document.plain)
    }

}
