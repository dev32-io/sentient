import Foundation

/// Bounded R0 fixture, not a Markdown parser or production message model.
/// One UTF-16 address space; tabs separate cells, newlines separate rows/blocks.
struct R0Document {
    var before: String
    var rows: [[String]]
    var after: String

    static let fixture = R0Document(
        before: "Before café 👩🏽‍💻 — select from here into any cell.",
        rows: [
            ["Name", "Observation", "Value"],
            ["Alpha café", "partial 👩🏽‍💻 text e\u{301}", "42 | units"],
            ["Beta 東京", "Readable wide column with retained horizontal position", "7\\8"]
        ],
        after: "After table — selection continues here. Stream: "
    )

    var plain: String { before + "\n" + rows.map { $0.joined(separator: "\t") }.joined(separator: "\n") + "\n" + after }
    var tableMarkdown: String {
        func row(_ cells: [String]) -> String {
            "| " + cells.map {
                $0.replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "|", with: "\\|")
                    .replacingOccurrences(of: "\n", with: "<br>")
            }.joined(separator: " | ") + " |"
        }
        guard let header = rows.first else { return "" }
        return ([row(header), row(header.map { _ in "---" })] + rows.dropFirst().map(row)).joined(separator: "\n")
    }
    func plain(in range: NSRange) -> String { (plain as NSString).substring(with: range) }
}
