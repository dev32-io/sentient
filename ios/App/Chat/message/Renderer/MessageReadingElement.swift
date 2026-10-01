import UIKit

/// Semantic paragraph/cell, not another renderer. Its frame always comes from
/// the document's actual CTLines, current table offset and host-visible viewport.
final class MessageReadingElement: UIAccessibilityElement {
    weak var document: MessageDocumentView?
    var range = NSRange(location: 0, length: 0)
    var imageFrame: CGRect?
    var imageURL: URL?
    var tableID: UUID?

    init(document: MessageDocumentView, id: String) {
        self.document = document
        super.init(accessibilityContainer: document)
        accessibilityIdentifier = id
        isAccessibilityElement = true
        accessibilityTraits = .staticText
    }
    override var accessibilityFrame: CGRect {
        get {
            if let imageFrame { return document?.accessibleImageFrame(imageFrame, table: tableID) ?? .zero }
            return document?.readingFrame(range) ?? .zero
        }
        set {}
    }
    override var accessibilityValue: String? {
        get { imageFrame == nil ? nil : document?.imageAccessibilityValue(for: imageURL) }
        set {}
    }
    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        tableID.flatMap { document?.scrollTable(id: $0, direction: direction) } ?? false
    }
    override var accessibilityCustomActions: [UIAccessibilityCustomAction]? {
        get {
            guard let document else { return nil }
            var actions: [UIAccessibilityCustomAction] = document.document.runs.compactMap { run in
                guard let url = run.link, NSIntersectionRange(range, run.range).length > 0 else { return nil }
                return UIAccessibilityCustomAction(name: "Open link: " + document.document.plain(in: run.range)) { [weak document] _ in
                    document?.openLink?(url)
                    return document?.openLink != nil
                }
            }
            guard let tableID else { return actions }
            if document.tableOffset(id: tableID) > 0 {
                actions.append(UIAccessibilityCustomAction(name: "Scroll table left") { [weak document] _ in
                    document?.scrollTable(id: tableID, direction: .right) ?? false
                })
            }
            if document.tableCanScrollRight(id: tableID) {
                actions.append(UIAccessibilityCustomAction(name: "Scroll table right") { [weak document] _ in
                    document?.scrollTable(id: tableID, direction: .left) ?? false
                })
            }
            actions.append(UIAccessibilityCustomAction(name: "Copy table as Markdown") { [weak document] _ in
                document?.copyTableMarkdown(id: tableID)
                return document != nil
            })
            return actions
        }
        set {}
    }
}
