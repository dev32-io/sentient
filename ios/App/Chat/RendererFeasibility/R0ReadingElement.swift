import UIKit

/// Semantic paragraph/cell, not another renderer. Its frame always comes from
/// the document's actual CTLines, current table offset and host-visible viewport.
final class R0ReadingElement: UIAccessibilityElement {
    weak var document: R0DocumentView?
    var range = NSRange(location: 0, length: 0)
    var table = false

    init(document: R0DocumentView, id: String) {
        self.document = document
        super.init(accessibilityContainer: document)
        accessibilityIdentifier = id
        isAccessibilityElement = true
        accessibilityTraits = .staticText
    }
    override var accessibilityFrame: CGRect {
        get { document?.readingFrame(range) ?? .zero }
        set {}
    }
    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        document?.accessibilityScroll(direction) ?? false
    }
    override var accessibilityCustomActions: [UIAccessibilityCustomAction]? {
        get {
            guard table, let document else { return nil }
            var actions: [UIAccessibilityCustomAction] = []
            if document.remainingLeft {
                actions.append(UIAccessibilityCustomAction(name: "Scroll table left") { [weak document] _ in
                    document?.accessibilityScroll(.right) ?? false
                })
            }
            if document.remainingRight {
                actions.append(UIAccessibilityCustomAction(name: "Scroll table right") { [weak document] _ in
                    document?.accessibilityScroll(.left) ?? false
                })
            }
            return actions
        }
        set {}
    }
}
