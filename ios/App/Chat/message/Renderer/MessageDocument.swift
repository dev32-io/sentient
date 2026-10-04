import Foundation
@_implementationOnly import cmark_gfm
@_implementationOnly import cmark_gfm_extensions

/// One bubble's logical UTF-16 address space. Markdown syntax is never part of
/// logical text; cell separators are tabs, row/block separators are newlines.
/// Clipboard formatting is a separate export projection.
struct MessageDocument {
    struct Style: OptionSet {
        let rawValue: Int
        static let strong = Self(rawValue: 1)
        static let emphasis = Self(rawValue: 2)
        static let code = Self(rawValue: 4)
        static let strike = Self(rawValue: 8)
    }
    struct Run {
        let range: NSRange
        let style: Style
        let link: URL?
    }
    enum Indent: Hashable {
        case list(Int)
        case quote
    }
    struct Block {
        enum Kind: Equatable {
            case paragraph, heading(Int), code, rule, table
        }
        var id: UUID
        let sourceRange: NSRange
        let range: NSRange
        let kind: Kind
        let depth: Int
        var indents: [Indent] = []
        let quoted: Bool
        let marker: String?
        let cells: [[NSRange]]
        let alignments: [UInt8]
    }
    struct Media {
        let range: NSRange
        let url: URL?
        let alternative: String
    }
    let source: String
    let literal: Bool
    private(set) var plain = ""
    private(set) var blocks: [Block] = []
    private(set) var runs: [Run] = []
    private(set) var media: [Media] = []
    /// Each logical UTF-16 boundary maps to a source UTF-16 boundary. Syntax
    /// removal, entity decoding and synthetic separators remain explicit.
    private(set) var logicalToSource: [Int] = [0]
    /// Trailing affinity preserves the other side of removed syntax. A single
    /// boundary value cannot represent both ends of adjacent styled runs.
    private(set) var logicalEndToSource: [Int] = [0]

    init(source: String, literal: Bool = false, previous: MessageDocument? = nil) {
        self.source = source
        self.literal = literal
        if literal {
            plain = source
            logicalToSource = Array(0...source.utf16.count)
            logicalEndToSource = logicalToSource
            blocks = source.isEmpty ? [] : [Block(id: UUID(), sourceRange: NSRange(location: 0, length: source.utf16.count),
                            range: NSRange(location: 0, length: source.utf16.count), kind: .paragraph,
                            depth: 0, quoted: false, marker: nil, cells: [], alignments: [])]
        } else {
            parse()
        }
        if let previous {
            let edit = UTF16BoundaryMap(from: previous.source, to: source)
            var used = Set<UUID>()
            for index in blocks.indices {
                // Identity follows source start through edits, not AST kind or
                // rendered text: a live paragraph may become a heading/table.
                if let old = previous.blocks.first(where: {
                    !used.contains($0.id) && edit.forward($0.sourceRange.location) == blocks[index].sourceRange.location
                }) {
                    blocks[index].id = old.id
                    used.insert(old.id)
                }
            }
        }
    }

    func plain(in range: NSRange) -> String {
        (plain as NSString).substring(with: NSIntersectionRange(range, NSRange(location: 0, length: plain.utf16.count)))
    }

    func logicalPosition(forSource position: Int, trailing: Bool = false) -> Int {
        let boundaries = trailing ? logicalEndToSource : logicalToSource
        // Last logical boundary not beyond source position. At removed syntax,
        // caret stays beside surviving content, never in a UTF-16 surrogate.
        var low = 0, high = boundaries.count
        while low < high {
            let mid = (low + high) / 2
            if boundaries[mid] <= position { low = mid + 1 } else { high = mid }
        }
        return graphemeBoundary(max(0, low - 1))
    }

    func graphemeBoundary(_ offset: Int) -> Int {
        let text = plain as NSString
        let offset = max(0, min(offset, text.length))
        return offset == text.length ? offset : text.rangeOfComposedCharacterSequence(at: offset).location
    }

    func remap(_ range: NSRange, from old: MessageDocument, caretTrailing: Bool = false) -> NSRange {
        let edit = UTF16BoundaryMap(from: old.source, to: source)
        func position(_ index: Int, trailing: Bool) -> Int {
            let boundaries = trailing ? old.logicalEndToSource : old.logicalToSource
            let boundary = boundaries[min(max(0, index), boundaries.count - 1)]
            return logicalPosition(forSource: edit.forward(boundary), trailing: trailing)
        }
        let a = position(range.location, trailing: range.length == 0 && caretTrailing)
        let b = range.length == 0 ? a : position(NSMaxRange(range), trailing: true)
        return NSRange(location: min(a, b), length: abs(b - a))
    }

    func tableMarkdown(id: UUID) -> String {
        guard let table = blocks.first(where: { $0.id == id && $0.kind == .table }), let header = table.cells.first else { return "" }
        let rows = table.cells.map { cells in
            cells.map { plain(in: $0)
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "|", with: "\\|")
                .replacingOccurrences(of: "\n", with: "<br>")
            }
        }
        let widths = header.indices.map { column in
            let alignment = table.alignments.indices.contains(column) ? table.alignments[column] : 0
            let minimum = alignment == 99 ? 5 : (alignment == 108 || alignment == 114 ? 4 : 3)
            return max(minimum, rows.map { $0[column].count }.max() ?? 0)
        }
        func row(_ cells: [String]) -> String {
            "|" + cells.enumerated().map { column, cell in
                cell + String(repeating: " ", count: widths[column] - cell.count)
            }.joined(separator: "|") + "|"
        }
        let separators = header.indices.map { column in
            let alignment = table.alignments.indices.contains(column) ? table.alignments[column] : 0
            let left = alignment == 108 || alignment == 99
            let right = alignment == 114 || alignment == 99
            return (left ? ":" : "") + String(repeating: "-", count: widths[column] - (left ? 1 : 0) - (right ? 1 : 0)) + (right ? ":" : "")
        }
        return ([row(rows[0]), row(separators)] + rows.dropFirst().map(row)).joined(separator: "\n")
    }

    /// Replace only fully covered tables. Tokenization, retained selection and
    /// source offsets continue to use the unchanged logical UTF-16 text.
    func clipboardText(in range: NSRange) -> String {
        let range = NSIntersectionRange(range, NSRange(location: 0, length: plain.utf16.count))
        var cursor = range.location
        var result = ""
        for table in blocks where table.kind == .table && table.range.length > 0
            && table.range.location >= range.location && NSMaxRange(table.range) <= NSMaxRange(range) {
            result += plain(in: NSRange(location: cursor, length: table.range.location - cursor))
            result += tableMarkdown(id: table.id)
            cursor = NSMaxRange(table.range)
        }
        result += plain(in: NSRange(location: cursor, length: NSMaxRange(range) - cursor))
        return result
    }

    static func permittedURL(_ string: String) -> URL? {
        guard let url = URL(string: string), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host != nil else { return nil }
        return url
    }

    private mutating func parse() {
        cmark_gfm_core_extensions_ensure_registered()
        let parser = cmark_parser_new(CMARK_OPT_DEFAULT)
        defer { cmark_parser_free(parser) }
        for name in ["table", "strikethrough", "autolink", "tasklist", "tagfilter"] {
            if let ext = cmark_find_syntax_extension(name) { cmark_parser_attach_syntax_extension(parser, ext) }
        }
        source.withCString { cmark_parser_feed(parser, $0, source.utf8.count) }
        guard let root = cmark_parser_finish(parser) else { return }
        defer { cmark_node_free(root) }
        let coordinates = SourceCoordinates(source)
        func kind(_ node: UnsafeMutablePointer<cmark_node>) -> String { String(cString: cmark_node_get_type_string(node)) }
        func children(_ node: UnsafeMutablePointer<cmark_node>) -> [UnsafeMutablePointer<cmark_node>] {
            var result: [UnsafeMutablePointer<cmark_node>] = []
            var child = cmark_node_first_child(node)
            while let current = child { result.append(current); child = cmark_node_next(current) }
            return result
        }
        func sourceRange(_ node: UnsafeMutablePointer<cmark_node>) -> NSRange {
            let start = coordinates.offset(line: Int(cmark_node_get_start_line(node)), column: Int(cmark_node_get_start_column(node)))
            let end = coordinates.offset(line: Int(cmark_node_get_end_line(node)), column: Int(cmark_node_get_end_column(node)) + 1)
            return NSRange(location: start, length: max(0, end - start))
        }
        func literal(_ node: UnsafeMutablePointer<cmark_node>) -> String { cmark_node_get_literal(node).map(String.init(cString:)) ?? "" }
        func url(_ node: UnsafeMutablePointer<cmark_node>) -> URL? { cmark_node_get_url(node).flatMap { Self.permittedURL(String(cString: $0)) } }
        func append(_ text: String, source range: NSRange, style: Style = [], link: URL? = nil) {
            let start = plain.utf16.count
            let fragment = (source as NSString).substring(with: range)
            let map = UTF16BoundaryMap(from: fragment, to: text)
            // Source ranges supplied by cmark are authoritative. Diff only aligns
            // decoded leaf text within that range, never parses Markdown syntax.
            for offset in 0..<text.utf16.count {
                logicalToSource[logicalToSource.count - 1] = max(logicalToSource.last ?? 0, range.location + map.backward(offset))
                logicalToSource.append(max(logicalToSource.last ?? 0, range.location + map.backward(offset + 1)))
                logicalEndToSource.append(max(logicalEndToSource.last ?? 0, range.location + map.backward(offset + 1)))
            }
            plain += text
            if !text.isEmpty { runs.append(Run(range: NSRange(location: start, length: text.utf16.count), style: style, link: link)) }
        }
        func separator(_ text: String, at sourceOffset: Int) {
            append(text, source: NSRange(location: sourceOffset, length: 0))
        }
        func inline(_ node: UnsafeMutablePointer<cmark_node>, style: Style = [], link: URL? = nil) {
            let range = sourceRange(node)
            switch kind(node) {
            case "text", "code", "html_inline":
                // Raw HTML is inert visible text. No HTML evaluation or resource path.
                append(literal(node), source: range, style: kind(node) == "code" ? style.union(.code) : style, link: link)
            case "softbreak", "linebreak": append("\n", source: range, style: style, link: link)
            case "image":
                let start = plain.utf16.count
                for child in children(node) { inline(child, style: style, link: nil) }
                let imageRange = NSRange(location: start, length: plain.utf16.count - start)
                media.append(Media(range: imageRange, url: url(node), alternative: plain(in: imageRange)))
            default:
                let next: Style
                switch kind(node) {
                case "strong": next = style.union(.strong)
                case "emph": next = style.union(.emphasis)
                case "strikethrough": next = style.union(.strike)
                default: next = style
                }
                for child in children(node) { inline(child, style: next, link: kind(node) == "link" ? url(node) : link) }
            }
        }
        func block(_ node: UnsafeMutablePointer<cmark_node>, depth: Int = 0, marker: String? = nil, quoted: Bool = false, indents: [Indent] = []) {
            let type = kind(node), sourceSpan = sourceRange(node)
            if type == "list" {
                let ordered = cmark_node_get_list_type(node) == CMARK_ORDERED_LIST
                let start = Int(cmark_node_get_list_start(node))
                for (index, child) in children(node).enumerated() {
                    let task = kind(child) == "tasklist"
                    let label = task ? (cmark_gfm_extensions_get_tasklist_item_checked(child) ? "☑" : "☐") : (ordered ? "\(start + index)." : "•")
                    block(child, depth: depth + 1, marker: label, quoted: quoted, indents: indents + [.list(sourceSpan.location)])
                }
                return
            }
            if type == "item" || type == "tasklist" || type == "block_quote" || type == "document" {
                for (index, child) in children(node).enumerated() {
                    block(child, depth: depth + (type == "block_quote" ? 1 : 0), marker: index == 0 ? marker : nil, quoted: quoted || type == "block_quote", indents: indents + (type == "block_quote" ? [.quote] : []))
                }
                return
            }
            if !blocks.isEmpty { separator("\n", at: sourceSpan.location) }
            let start = plain.utf16.count
            var cells: [[NSRange]] = [], alignments: [UInt8] = []
            let blockKind: Block.Kind
            switch type {
            case "table":
                blockKind = .table
                let count = Int(cmark_gfm_extensions_get_table_columns(node))
                if let values = cmark_gfm_extensions_get_table_alignments(node) { alignments = Array(UnsafeBufferPointer(start: values, count: count)) }
                for (rowIndex, row) in children(node).enumerated() {
                    if rowIndex > 0 { separator("\n", at: sourceRange(row).location) }
                    var rowCells: [NSRange] = []
                    for (column, cell) in children(row).enumerated() {
                        if column > 0 { separator("\t", at: sourceRange(cell).location) }
                        let cellStart = plain.utf16.count
                        for child in children(cell) { inline(child, style: rowIndex == 0 ? .strong : []) }
                        rowCells.append(NSRange(location: cellStart, length: plain.utf16.count - cellStart))
                    }
                    cells.append(rowCells)
                }
            case "code_block", "html_block":
                blockKind = type == "code_block" ? .code : .paragraph
                append(literal(node), source: sourceSpan, style: type == "code_block" ? .code : [])
            case "thematic_break": blockKind = .rule
            default:
                blockKind = type == "heading" ? .heading(Int(cmark_node_get_heading_level(node))) : .paragraph
                for child in children(node) { inline(child) }
            }
            blocks.append(Block(id: UUID(), sourceRange: sourceSpan, range: NSRange(location: start, length: plain.utf16.count - start), kind: blockKind, depth: depth, indents: indents, quoted: quoted, marker: marker, cells: cells, alignments: alignments))
        }
        block(root)
    }
}

/// Explicit edit correspondence, independent of Markdown. Matching UTF-16 units
/// retain their positions; deleted units collapse to the next surviving boundary.
struct UTF16BoundaryMap {
    private let oldToNew: [Int]
    private let newToOld: [Int]
    init(from old: String, to new: String) {
        let a = Array(old.utf16), b = Array(new.utf16)
        var removed = Set<Int>(), inserted = Set<Int>()
        // ponytail: stdlib diff for edited leaves/source; if very large rewrites
        // become a measured bottleneck, move parsing/mapping off the main actor.
        for change in b.difference(from: a) {
            switch change {
            case let .remove(offset, _, _): removed.insert(offset)
            case let .insert(offset, _, _): inserted.insert(offset)
            }
        }
        var forward = Array(repeating: b.count, count: a.count + 1)
        var backward = Array(repeating: a.count, count: b.count + 1)
        var i = 0, j = 0
        while i < a.count || j < b.count {
            if i == a.count { forward[i] = min(forward[i], j) }
            if j < b.count, inserted.contains(j) { backward[j] = i; j += 1 }
            else if i < a.count, removed.contains(i) { forward[i] = j; i += 1 }
            else if i < a.count, j < b.count {
                forward[i] = j; backward[j] = i; i += 1; j += 1
            } else { break }
        }
        oldToNew = forward; newToOld = backward
    }
    func forward(_ position: Int) -> Int { oldToNew[min(max(0, position), oldToNew.count - 1)] }
    func backward(_ position: Int) -> Int { newToOld[min(max(0, position), newToOld.count - 1)] }
}

private struct SourceCoordinates {
    let bytes: [UInt8]
    let starts: [Int]
    let utf16Offsets: [Int]
    init(_ source: String) {
        bytes = Array(source.utf8)
        var starts = [0], offsets = [0], position = 0
        for scalar in source.unicodeScalars {
            let count = scalar.utf8.count
            offsets.append(contentsOf: Array(repeating: position, count: max(0, count - 1)))
            position += scalar.utf16.count
            offsets.append(position)
        }
        for (index, byte) in bytes.enumerated() where byte == 10 { starts.append(index + 1) }
        self.starts = starts; utf16Offsets = offsets
    }
    func offset(line: Int, column: Int) -> Int {
        guard line > 0, line <= starts.count else { return 0 }
        let byte = min(bytes.count, starts[line - 1] + max(0, column - 1))
        return utf16Offsets[byte]
    }
}
