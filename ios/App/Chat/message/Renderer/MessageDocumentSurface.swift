import SwiftUI
import UIKit

/// Shared public consumer surface for chat and later Settings previews. Literal
/// mode uses identical layout/input machinery without Markdown interpretation.
struct MessageDocumentSurface: UIViewRepresentable {
    let source: String
    var literal = false
    var streaming = false
    var state: MessageDocumentState?
    var imageCache: MarkdownImageCache?
    var measurement = false
    var selectionViewportInWindow: (() -> CGRect)?
    var requestSelectionScroll: ((CGFloat) -> CGFloat)?
    var onSelectionBegin: (() -> Void)?
    var onReady: ((Bool) -> Void)?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL

    func makeUIView(context: Context) -> MessageDocumentView {
        let view = MessageDocumentView()
        view.state = state ?? MessageDocumentState(source: source, literal: literal)
        view.setContentHuggingPriority(.required, for: .vertical)
        return view
    }
    func updateUIView(_ view: MessageDocumentView, context: Context) {
        if let state, view.state !== state { view.selectionEdge.stop(); view.state = state }
        view.measurement = measurement
        view.showsStreamingCaret = streaming && !reduceMotion
        view.imageCache = imageCache
        if !measurement { view.state.mountedView = view }
        view.onSelectionChange = { [weak view] in
            if view?.selectedTextRange?.isEmpty == false { onSelectionBegin?() }
        }
        view.selectionViewportInWindow = selectionViewportInWindow
        view.requestSelectionScroll = requestSelectionScroll
        view.openLink = { openURL($0) }
        view.onLayoutChange = {
            guard !measurement else { return }
            DispatchQueue.main.async { onReady?(true) }
        }
        view.update(source: source, literal: literal)
        view.rebuild()
        // Synchronous native content has no WebKit readiness/alpha handoff.
        if !measurement { DispatchQueue.main.async { onReady?(true) } }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MessageDocumentView, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let layout = uiView.state.measure(width: max(1, width), traits: uiView.traitCollection)
        return CGSize(width: width, height: layout.height)
    }
    static func dismantleUIView(_ view: MessageDocumentView, coordinator: ()) {
        view.prepareForUnmount()
        view.showsStreamingCaret = false
        if view.state.mountedView === view { view.state.mountedView = nil }
        view.onSelectionChange = nil
        view.onLayoutChange = nil
        view.requestSelectionScroll = nil
        view.selectionViewportInWindow = nil
    }
}
