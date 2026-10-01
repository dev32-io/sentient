import Foundation
#if !RENDERER_MODEL_CHECK
import XCTest
@testable import SentientApp

final class MessageDocumentModelTests: XCTestCase {
    func testProjectionAndSourceIdentity() { rendererModelChecks() }
}
#else
@main struct RendererModelCheck {
    static func main() { rendererModelChecks(); print("Renderer model contracts passed") }
}
#endif

private func rendererModelChecks() {
    let source = "Before café 👩🏽‍💻\n\n| Name | Observation | Value |\n| --- | --- | --- |\n| Alpha café | partial 👩🏽‍💻 text e\u{301} | 42 \\| units |\n| Beta 東京 | readable | 7\\\\8 |\n\nAfter **bold** and [safe](https://example.test)."
    let document = MessageDocument(source: source)
    let expected = "Before café 👩🏽‍💻\nName\tObservation\tValue\nAlpha café\tpartial 👩🏽‍💻 text e\u{301}\t42 | units\nBeta 東京\treadable\t7\\8\nAfter bold and safe."
    precondition(Data(document.plain.utf8) == Data(expected.utf8), "Exact Unicode/tab/newline projection")
    precondition(document.logicalToSource.count == document.plain.utf16.count + 1)
    precondition(zip(document.logicalToSource, document.logicalToSource.dropFirst()).allSatisfy { $0 <= $1 })
    let table = document.blocks.first { $0.kind == .table }!
    precondition(document.tableMarkdown(id: table.id) == "| Name | Observation | Value |\n| --- | --- | --- |\n| Alpha café | partial 👩🏽‍💻 text e\u{301} | 42 \\| units |\n| Beta 東京 | readable | 7\\\\8 |")
    let text = document.plain as NSString
    let start = text.range(of: "fé").location
    let end = text.range(of: "partial 👩🏽‍💻").location + "partial 👩🏽‍💻".utf16.count
    precondition(document.plain(in: NSRange(location: start, length: end - start)) == "fé 👩🏽‍💻\nName\tObservation\tValue\nAlpha café\tpartial 👩🏽‍💻")

    let live = MessageDocument(source: "**café 👩🏽‍💻")
    let final = MessageDocument(source: live.source + "**", previous: live)
    let oldRange = (live.plain as NSString).range(of: "café 👩🏽‍💻")
    precondition(final.plain(in: final.remap(oldRange, from: live)) == "café 👩🏽‍💻", "Syntax reinterpretation retains selected content")
    precondition(live.blocks.first?.id == final.blocks.first?.id)
    let appended = MessageDocument(source: final.source + " more", previous: final)
    precondition(appended.plain(in: appended.remap(NSRange(location: 0, length: final.plain.utf16.count), from: final)) == final.plain, "Append must not extend selection at old document end")
    precondition(appended.remap(NSRange(location: final.plain.utf16.count, length: 0), from: final, caretTrailing: true).location == final.plain.utf16.count)
    let trailingSpace = MessageDocument(source: "word ")
    let moreText = MessageDocument(source: "word next", previous: trailingSpace)
    precondition(moreText.plain(in: moreText.remap(NSRange(location: 0, length: trailingSpace.plain.utf16.count), from: trailingSpace)) == trailingSpace.plain, "Revealed trailing whitespace must not extend prior range")
    let entity = MessageDocument(source: "&#128105;")
    let entityAppend = MessageDocument(source: entity.source + " more", previous: entity)
    precondition(entityAppend.plain(in: entityAppend.remap(NSRange(location: 0, length: entity.plain.utf16.count), from: entity)) == entity.plain)
    let heading = MessageDocument(source: "title\n", previous: nil)
    let reinterpreted = MessageDocument(source: "title\n===", previous: heading)
    precondition(reinterpreted.blocks.first?.kind == .heading(1))
    precondition(reinterpreted.blocks.first?.id == heading.blocks.first?.id)
    let deleted = MessageDocument(source: "café 👩🏽‍💻", previous: final)
    precondition(deleted.plain(in: deleted.remap(NSRange(location: 0, length: final.plain.utf16.count), from: final)) == "café 👩🏽‍💻")
    precondition(MessageDocument(source: "", literal: true).blocks.isEmpty)
    let literal = MessageDocument(source: source, literal: true)
    precondition(literal.plain == source && literal.logicalToSource == Array(0...source.utf16.count))

    for source in ["é before https://example.test/a after", "-\t**東京** and 👩🏽‍💻", "é\r\n\r\n**東京** after"] {
        let parsed = MessageDocument(source: source)
        let target = parsed.plain.contains("after") ? "after" : "東京"
        let logical = (parsed.plain as NSString).range(of: target).location
        precondition(parsed.logicalToSource[logical] == (source as NSString).range(of: target).location, "Byte-column to UTF-16 mapping, including tabs/CRLF/autolinks")
    }
    let escapedCellSource = "| A | B |\n| --- | --- |\n| left \\| café 👩🏽‍💻 | after |"
    let escapedCell = MessageDocument(source: escapedCellSource)
    for target in ["café", "👩🏽‍💻", "after"] {
        let logical = (escapedCell.plain as NSString).range(of: target).location
        precondition(escapedCell.logicalToSource[logical] == (escapedCellSource as NSString).range(of: target).location, "Escaped-pipe table cell source identity")
    }
    let multi = MessageDocument(source: source + "\n\n| X | Y |\n| --- | --- |\n| مرحبا | שלום |")
    let tables = multi.blocks.filter { $0.kind == .table }
    precondition(tables.count == 2 && tables[0].id != tables[1].id)
    precondition(multi.plain(in: tables[1].cells[1][0]) == "مرحبا")
    precondition(multi.plain(in: tables[1].cells[1][1]) == "שלום")
    let escaped = MessageDocument(source: "é **e\u{301}** &amp; \\* [unsafe](javascript:alert) ![alt](file:///tmp/private)\n\n<script>alert(1)</script>")
    precondition(escaped.plain.contains("é e\u{301} & * unsafe alt"))
    precondition(escaped.runs.allSatisfy { $0.link == nil })
    precondition(escaped.media.count == 1 && escaped.media[0].url == nil)
    precondition(escaped.plain.contains("<script>alert(1)</script>"), "HTML remains inert visible fallback")
    let entitySelection = (escaped.plain as NSString).range(of: "e\u{301}")
    let sourcePosition = escaped.logicalToSource[entitySelection.location]
    precondition((escaped.source as NSString).substring(from: sourcePosition).hasPrefix("e\u{301}"))
    let fenced = MessageDocument(source: "```\n![not a fetch](https://example.test/private)\n")
    precondition(fenced.media.isEmpty && fenced.blocks.first?.kind == .code)
    let rich = MessageDocument(source: "# Heading\n\n> quoted **bold** and *emphasis*\n\n1. first\n2. second\n\n![safe](https://example.test/picture)")
    precondition(rich.blocks.first?.kind == .heading(1))
    precondition(rich.blocks.contains { $0.quoted })
    precondition(rich.blocks.compactMap(\.marker) == ["1.", "2."])
    precondition(rich.runs.contains { $0.style.contains(.strong) })
    precondition(rich.runs.contains { $0.style.contains(.emphasis) })
    precondition(rich.media.first?.url?.host == "example.test")
    let shifted = MessageDocument(source: "Intro\n\n" + source, previous: document)
    precondition(shifted.blocks.first(where: { $0.kind == .table })?.id == table.id)
    precondition(shifted.plain(in: shifted.remap(NSRange(location: start, length: end - start), from: document)) == document.plain(in: NSRange(location: start, length: end - start)))
}
