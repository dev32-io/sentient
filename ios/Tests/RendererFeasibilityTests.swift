import XCTest
import UIKit
import SwiftUI
@testable import SentientApp

@MainActor
final class RendererFeasibilityTests: XCTestCase {
    func testUnicodeExportsAndRetainedLayoutState() throws {
        let view = R0DocumentView(frame: CGRect(x: 0, y: 0, width: 360, height: 600))
        view.layoutIfNeeded()
        let text = view.document.plain as NSString
        // Cell whitespace remains in that cell, not the longer neighboring row.
        // This regressed when hit testing used ink width after horizontal scroll.
        let partial = text.range(of: "partial 👩🏽‍💻 text e\u{301}")
        view.setTableOffset(200)
        let cellEnd = view.caretRect(for: MessageTextPosition(NSMaxRange(partial)))
        let whitespace = view.closestPosition(to: CGPoint(x: min(view.tableRect.maxX - 1, cellEnd.maxX + 4), y: cellEnd.midY)) as? MessageTextPosition
        XCTAssertEqual(whitespace?.index, NSMaxRange(partial))
        view.setTableOffset(0)
        let start = text.range(of: "fé").location
        let end = text.range(of: "partial 👩🏽‍💻 text e\u{301}").location + ("partial 👩🏽‍💻" as NSString).length
        let range = MessageTextRange(NSRange(location: start, length: end - start))
        view.selectedTextRange = range
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string.map { Data($0.utf8) }, Data("fé 👩🏽‍💻 — select from here into any cell.\nName\tObservation\tValue\nAlpha café\tpartial 👩🏽‍💻".utf8))
        view.copyTableMarkdown()
        XCTAssertEqual(UIPasteboard.general.string.map { Data($0.utf8) }, Data("| Name | Observation | Value |\n| --- | --- | --- |\n| Alpha café | partial 👩🏽‍💻 text e\u{301} | 42 \\| units |\n| Beta 東京 | Readable wide column with retained horizontal position | 7\\\\8 |".utf8))
        view.setTableOffset(80)
        XCTAssertTrue(view.remainingLeft)
        XCTAssertTrue(view.remainingRight)
        for mutate in [
            { view.append("追加 👨‍👩‍👧‍👦 e\u{301}") },
            { view.frame.size.width = 320; view.layoutIfNeeded() },
            { view.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge; view.rebuild() },
            { view.append("\n\n![Reserved image](file:///blocked)") }
        ] {
            mutate()
            XCTAssertEqual((view.selectedTextRange as? MessageTextRange)?.value, range.value)
            XCTAssertEqual(view.tableOffset, 80)
            XCTAssertFalse(view.selectionRects(for: range).isEmpty)
            view.copy(nil)
            XCTAssertEqual(UIPasteboard.general.string.map { Data($0.utf8) }, Data("fé 👩🏽‍💻 — select from here into any cell.\nName\tObservation\tValue\nAlpha café\tpartial 👩🏽‍💻".utf8))
        }
        // Coordinates come from the very CTLines used for drawing, including table translation.
        let cellIndex = text.range(of: "Alpha").location + 2
        view.setTableOffset(0)
        let caret = view.caretRect(for: MessageTextPosition(cellIndex))
        let hit = try XCTUnwrap(view.closestPosition(to: CGPoint(x: caret.minX, y: caret.midY)) as? MessageTextPosition)
        XCTAssertEqual(hit.index, cellIndex)
        view.setTableOffset(.greatestFiniteMagnitude)
        XCTAssertFalse(view.remainingRight)
        XCTAssertTrue(view.remainingLeft)
    }

    func testEdgeHostContractAndAccessibleCells() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let host = R0FixtureController()
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        let view = host.document
        let before = try XCTUnwrap((view.accessibilityElements?.compactMap { $0 as? MessageReadingElement })?.first)
        XCTAssertEqual(before.accessibilityIdentifier, view.document.blocks.first!.id.uuidString)
        XCTAssertFalse(before.accessibilityFrame.isEmpty)
        XCTAssertFalse((view.accessibilityElements?.compactMap { $0 as? MessageReadingElement } ?? []).contains { $0.accessibilityIdentifier == "\(view.document.blocks.first { $0.kind == .table }!.id)-0-2" })
        view.setTableOffset(.greatestFiniteMagnitude)
        let value = try XCTUnwrap((view.accessibilityElements?.compactMap { $0 as? MessageReadingElement })?.first { $0.accessibilityIdentifier == "\(view.document.blocks.first { $0.kind == .table }!.id)-0-2" })
        XCTAssertEqual(value.accessibilityLabel, "Value")
        XCTAssertLessThanOrEqual(value.accessibilityFrame.width, view.tableRect.width)
        XCTAssertTrue(value.accessibilityScroll(.right))
        view.setTableOffset(0)

        view.append(String(repeating: "More text for parent scrolling. ", count: 60))
        let edge = view.selectionEdge
        let viewport = try XCTUnwrap(view.selectionViewportInWindow?())
        let point = CGPoint(x: viewport.midX, y: viewport.maxY - 2)
        let old = NSRange(location: 7, length: 100)
        let new = NSRange(location: 7, length: 110)
        view.selectedTextRange = MessageTextRange(old)
        let initialCaret = view.convert(view.caretRect(for: MessageTextPosition(NSMaxRange(old))), to: window)
        edge.sample(CGPoint(x: initialCaret.midX, y: initialCaret.midY), handleAnchor: 7)
        let gestureID = ObjectIdentifier(view)
        edge.nativeGestureChanged(.began, id: gestureID)
        edge.sample(point)
        edge.nativeHitTest(view.convert(CGPoint(x: point.x, y: point.y - 40), from: window))
        view.selectedTextRange = MessageTextRange(new)
        XCTAssertEqual(edge.anchor, 7)
        XCTAssertTrue(edge.isRunning)
        edge.advance(at: 1)
        edge.advance(at: 100) // suspension must not create a 99-second jump
        XCTAssertGreaterThan(host.scroll.contentOffset.y, 0)
        XCTAssertLessThanOrEqual(host.scroll.contentOffset.y, 8.01)
        let firstOffset = host.scroll.contentOffset.y
        edge.advance(at: 100.03) // SAME physical pointer, more actual motion
        XCTAssertGreaterThan(host.scroll.contentOffset.y, firstOffset)
        XCTAssertEqual(edge.pointer, point)
        XCTAssertEqual(edge.anchor, 7)
        let scrollRequest = view.requestSelectionScroll
        view.requestSelectionScroll = { _ in 0 } // host may reject scroll intent
        edge.advance(at: 100.04)
        XCTAssertFalse(edge.isRunning, "Denied motion must not leave a busy frame callback")
        view.requestSelectionScroll = scrollRequest
        edge.geometryChanged()
        XCTAssertTrue(edge.isRunning, "Host geometry can resume the same stationary drag")
        let tableOffset = view.tableOffset
        view.append("追加 e\u{301}")
        view.frame.size.width -= 20
        view.layoutIfNeeded()
        XCTAssertEqual(edge.anchor, 7)
        XCTAssertEqual(view.tableOffset, tableOffset)
        edge.sample(CGPoint(x: point.x, y: viewport.minY + 1))
        edge.advance(at: 100.06)
        XCTAssertLessThan(host.scroll.contentOffset.y, firstOffset + 7)
        edge.nativeGestureChanged(.cancelled, id: gestureID)
        XCTAssertFalse(edge.isRunning)
        edge.sample(point, handleAnchor: 7)
        edge.nativeGestureChanged(.changed, id: gestureID)
        XCTAssertFalse(edge.isRunning) // cannot restart before physical release
        edge.sample(nil)
        XCTAssertNil(edge.anchor)
        let stopped = host.scroll.contentOffset
        edge.advance(at: 101)
        XCTAssertEqual(host.scroll.contentOffset, stopped)

        // Horizontal requests use the same pointer, fixed anchor and hit map.
        host.scroll.contentOffset = .zero
        let cell = (view.document.plain as NSString).range(of: "partial")
        let caret = view.convert(view.caretRect(for: MessageTextPosition(cell.location + 2)), to: window)
        view.selectedTextRange = MessageTextRange(NSRange(location: 7, length: cell.location + 2 - 7))
        edge.sample(CGPoint(x: caret.minX, y: caret.midY), handleAnchor: 7)
        edge.nativeGestureChanged(.began, id: gestureID)
        let table = view.convert(view.tableRect, to: window)
        edge.sample(CGPoint(x: table.maxX - 1, y: caret.midY))
        edge.advance(at: 200); edge.advance(at: 200.03); edge.advance(at: 200.06)
        XCTAssertGreaterThan(view.tableOffset, 0)
        let right = view.tableOffset
        edge.sample(CGPoint(x: table.minX + 1, y: caret.midY))
        edge.advance(at: 200.09)
        XCTAssertLessThan(view.tableOffset, right)
        view.removeFromSuperview()
        XCTAssertFalse(edge.isRunning)
        XCTAssertNil(edge.anchor)
        let removedOffset = view.tableOffset
        edge.advance(at: 300)
        XCTAssertEqual(view.tableOffset, removedOffset)
    }

    /// Explicit opt-in only; held open for native Maestro gestures on disposable sim.
    /// No production root, network, user state, or existing simulator involved.

}

@MainActor
private final class R0FixtureController: UIViewController {
    let document = R0DocumentView()
    let scroll = UIScrollView()
    private let status = UILabel()
    private let controls = UIStackView()
    private var narrow = false
    private var deniesScroll = false
    private(set) var deniedRequests = 0
    private(set) var mutationCount = 0
    private(set) var retentionFailures = 0
    private(set) var selectionChanges = 0
    private(set) var motionTrace: [[String: Any]] = []
    var onCheckpoint: (() -> Void)?
    var typeCategory: UIContentSizeCategory = .accessibilityExtraLarge
    private enum EdgeProbe { case mutate, cancel, remove }
    private var edgeProbe: EdgeProbe?
    private var probeAtFrame = 0
    private(set) var probeFrame = 0
    private(set) var mutationProbe: [String: Any] = [:]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(DuskColors.paper)
        status.textColor = UIColor(DuskColors.ink)
        status.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        status.accessibilityIdentifier = "r0-status"
        controls.axis = .vertical
        controls.distribution = .fillEqually
        let primary = UIStackView(), probes = UIStackView()
        for row in [primary, probes] { row.distribution = .fillEqually; controls.addArrangedSubview(row) }
        for (title, action) in [("Append", #selector(append)), ("Width", #selector(width)), ("Type", #selector(typeSize)), ("Image", #selector(image)), ("Table Copy", #selector(tableCopy)), ("Save", #selector(checkpoint)), ("Arm", #selector(armMutation)), ("Cancel", #selector(armCancel)), ("Remove", #selector(armRemove)), ("Deny", #selector(denyScroll))] {
            let button = UIButton(type: .system)
            button.setTitle(title, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 12)
            button.accessibilityIdentifier = "r0-" + title.lowercased().replacingOccurrences(of: " ", with: "-")
            button.addTarget(self, action: action, for: .touchUpInside)
            (["Arm", "Cancel", "Remove", "Deny"].contains(title) ? probes : primary).addArrangedSubview(button)
        }
        view.addSubview(controls); view.addSubview(status); view.addSubview(scroll)
        scroll.accessibilityIdentifier = "r0-parent-scroll"
        scroll.alwaysBounceVertical = true
        scroll.addSubview(document)
        document.selectionViewportInWindow = { [weak self] in
            guard let self else { return .null }
            return scroll.convert(scroll.bounds, to: view.window)
        }
        document.requestSelectionScroll = { [weak self] delta in
            guard let self else { return 0 }
            if deniesScroll { deniedRequests += 1; return 0 }
            let old = scroll.contentOffset.y
            let minimum = -scroll.adjustedContentInset.top
            let maximum = max(minimum, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            scroll.contentOffset.y = min(maximum, max(minimum, old + delta))
            return scroll.contentOffset.y - old
        }
        document.selectionEdge.onMotion = { [weak self] point, anchor, dx, dy in
            guard let self else { return }
            if motionTrace.count < 4096 {
                motionTrace.append(["time": CACurrentMediaTime(), "x": point.x, "y": point.y, "anchor": anchor, "dx": dx, "dy": dy,
                                    "tableOffset": document.tableOffset, "parentOffset": scroll.contentOffset.y,
                                    "rangeStart": (document.selectedTextRange as? MessageTextRange)?.value.location ?? -1,
                                    "rangeLength": (document.selectedTextRange as? MessageTextRange)?.value.length ?? 0])
            }
            if let probe = edgeProbe, document.selectionEdge.frameCount >= probeAtFrame {
                edgeProbe = nil
                probeFrame = document.selectionEdge.frameCount
                switch probe {
                case .mutate:
                    let anchor = document.selectionEdge.anchor
                    let offset = document.tableOffset
                    mutate { self.document.append("During drag 東京 👩🏽‍💻. ") }
                    mutate { self.narrow = true; self.view.setNeedsLayout(); self.view.layoutIfNeeded() }
                    image()
                    mutationProbe = ["anchorBefore": anchor ?? -1, "anchorAfter": document.selectionEdge.anchor ?? -1,
                                     "offsetBefore": offset, "offsetAfter": document.tableOffset]
                case .cancel:
                    // Public UIKit cancellation stimulus while the real finger
                    // remains down. Restore enablement for subsequent gestures.
                    for interaction in document.interactions.compactMap({ $0 as? UITextInteraction }) {
                        for gesture in interaction.gesturesForFailureRequirements {
                            gesture.isEnabled = false
                            gesture.isEnabled = true
                        }
                    }
                case .remove:
                    document.removeFromSuperview()
                }
            }
            updateStatus()
        }
        document.onLayoutChange = { [weak self] in self?.updateHeight() }
        document.onSelectionChange = { [weak self] in
            guard let self else { return }
            selectionChanges += 1
            updateStatus()
        }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = view.safeAreaInsets.top
        controls.frame = CGRect(x: 8, y: top, width: view.bounds.width - 16, height: 88)
        status.frame = CGRect(x: 12, y: top + 88, width: view.bounds.width - 24, height: 28)
        scroll.frame = CGRect(x: 0, y: top + 120, width: view.bounds.width, height: view.bounds.height - top - 120 - view.safeAreaInsets.bottom)
        document.frame.size.width = narrow ? 300 : view.bounds.width
        document.layoutIfNeeded()
        updateHeight()
    }
    private func updateHeight() {
        document.frame.size.height = document.measuredHeight
        scroll.contentSize = CGSize(width: scroll.bounds.width, height: max(scroll.bounds.height + 200, document.measuredHeight + 300))
    }
    private func updateStatus() {
        let range = (document.selectedTextRange as? MessageTextRange)?.value
        status.text = "Range \(range?.location ?? -1):\(range?.length ?? 0) updates \(mutationCount) failures \(retentionFailures)"
    }
    private func mutate(_ action: () -> Void) {
        let range = (document.selectedTextRange as? MessageTextRange)?.value
        let offset = document.tableOffset
        let reading = scroll.contentOffset
        action()
        document.layoutIfNeeded()
        updateHeight()
        mutationCount += 1
        if range != (document.selectedTextRange as? MessageTextRange)?.value || document.tableOffset != offset || scroll.contentOffset != reading { retentionFailures += 1 }
        updateStatus()
    }
    @objc private func append() { mutate { document.append("Stream 東京 👩🏽‍💻 continues. ") } }
    @objc private func width() { mutate { narrow.toggle(); view.setNeedsLayout(); view.layoutIfNeeded() } }
    @objc private func typeSize() { mutate { document.traitOverrides.preferredContentSizeCategory = typeCategory; document.rebuild() } }
    @objc private func image() {
        mutate { Task { await document.delayedImageLoader.resolve(url: R0DocumentView.imageURL, image: testImage(width: 240, height: 180)) } }
    }
    @objc private func denyScroll() { deniesScroll = true }
    private func arm(_ probe: EdgeProbe) { edgeProbe = probe; probeAtFrame = document.selectionEdge.frameCount + 10 }
    @objc private func armMutation() { arm(.mutate) }
    @objc private func armCancel() { arm(.cancel) }
    @objc private func armRemove() { arm(.remove) }
    @objc private func checkpoint() { onCheckpoint?() }
    @objc private func tableCopy() { document.copyTableMarkdown() }
}

/// Existing native gesture host now exercises the production renderer. Only
/// fixture setup lives here; no alternate painting/input/selection algorithm.
@MainActor
private final class R0DocumentView: MessageDocumentView {
    static let imageURL = URL(string: "https://fixture.invalid/renderer.png")!
    let delayedImageLoader = DelayedImageLoader()
    var imageReady: Bool { imageAccessibilityValue(for: Self.imageURL) == nil }
    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "r0-document"
        imageCache = MarkdownImageCache(loader: delayedImageLoader)
        let fixture = R0Document.fixture
        state = MessageDocumentState(source: fixture.before + "\n\n" + fixture.tableMarkdown + "\n\n" + fixture.after + "\n\n![Controlled photo](\(Self.imageURL.absoluteString))")
        rebuild()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func append(_ text: String) { update(source: document.source + text, literal: false) }
    func copyTableMarkdown() {
        if let table = document.blocks.first(where: { $0.kind == .table }) { copyTableMarkdown(id: table.id) }
    }
}
