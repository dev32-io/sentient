import XCTest
import UIKit
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
        let cellEnd = view.caretRect(for: R0Position(NSMaxRange(partial)))
        let whitespace = view.closestPosition(to: CGPoint(x: view.tableRect.maxX - 1, y: cellEnd.midY)) as? R0Position
        XCTAssertEqual(whitespace?.index, NSMaxRange(partial))
        view.setTableOffset(0)
        let start = text.range(of: "fé").location
        let end = text.range(of: "partial 👩🏽‍💻 text e\u{301}").location + ("partial 👩🏽‍💻" as NSString).length
        let range = R0Range(NSRange(location: start, length: end - start))
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
            { view.font = UIFont.preferredFont(forTextStyle: .body, compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)) },
            { view.imageHeight = 120 }
        ] {
            mutate()
            XCTAssertEqual((view.selectedTextRange as? R0Range)?.value, range.value)
            XCTAssertEqual(view.tableOffset, 80)
            XCTAssertFalse(view.selectionRects(for: range).isEmpty)
            view.copy(nil)
            XCTAssertEqual(UIPasteboard.general.string.map { Data($0.utf8) }, Data("fé 👩🏽‍💻 — select from here into any cell.\nName\tObservation\tValue\nAlpha café\tpartial 👩🏽‍💻".utf8))
        }
        // Coordinates come from the very CTLines used for drawing, including table translation.
        let cellIndex = text.range(of: "Alpha").location + 2
        view.setTableOffset(0)
        let caret = view.caretRect(for: R0Position(cellIndex))
        let hit = try XCTUnwrap(view.closestPosition(to: CGPoint(x: caret.minX, y: caret.midY)) as? R0Position)
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
        let before = try XCTUnwrap((view.accessibilityElements as? [R0ReadingElement])?.first)
        XCTAssertEqual(before.accessibilityIdentifier, "r0-prose-before")
        XCTAssertFalse(before.accessibilityFrame.isEmpty)
        XCTAssertFalse((view.accessibilityElements as? [R0ReadingElement] ?? []).contains { $0.accessibilityIdentifier == "r0-cell-0-2" })
        view.setTableOffset(.greatestFiniteMagnitude)
        let value = try XCTUnwrap((view.accessibilityElements as? [R0ReadingElement])?.first { $0.accessibilityIdentifier == "r0-cell-0-2" })
        XCTAssertTrue(value.accessibilityLabel?.contains("Value") == true)
        XCTAssertLessThanOrEqual(value.accessibilityFrame.width, view.tableRect.width)
        XCTAssertTrue(value.accessibilityScroll(.right))
        view.setTableOffset(0)

        view.append(String(repeating: "More text for parent scrolling. ", count: 60))
        let edge = view.selectionEdge
        let viewport = try XCTUnwrap(view.selectionViewportInWindow?())
        let point = CGPoint(x: viewport.midX, y: viewport.maxY - 2)
        let old = NSRange(location: 7, length: 100)
        let new = NSRange(location: 7, length: 110)
        view.selectedTextRange = R0Range(old)
        let initialCaret = view.convert(view.caretRect(for: R0Position(NSMaxRange(old))), to: window)
        edge.sample(CGPoint(x: initialCaret.midX, y: initialCaret.midY), handleAnchor: 7)
        let gestureID = ObjectIdentifier(view)
        edge.nativeGestureChanged(.began, id: gestureID)
        edge.sample(point)
        edge.nativeHitTest(view.convert(CGPoint(x: point.x, y: point.y - 40), from: window))
        view.selectedTextRange = R0Range(new)
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
        let caret = view.convert(view.caretRect(for: R0Position(cell.location + 2)), to: window)
        view.selectedTextRange = R0Range(NSRange(location: 7, length: cell.location + 2 - 7))
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
    func testNativeGestureProbe() throws {
        // Same DEBUG app-root bypass contract as the visual capture runner. For
        // R0, line two names an existing scratch directory, not a capture PNG.
        let request = try? String(contentsOfFile: "/tmp/sentient-visual-diff-request", encoding: .utf8)
        let fields = request?.split(separator: "\n").map(String.init) ?? []
        guard fields.count == 3 else { throw XCTSkip("R0 isolated host not requested") }
        let evidence = URL(fileURLWithPath: fields[1], isDirectory: true)
        let flag = evidence.appendingPathComponent("interactive")
        guard FileManager.default.fileExists(atPath: flag.path) else { throw XCTSkip("R0 interactive probe not requested") }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let host = R0FixtureController()
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        try Data("ready".utf8).write(to: evidence.appendingPathComponent("ready"))
        let deadline = Date().addingTimeInterval(600)
        while FileManager.default.fileExists(atPath: flag.path), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: flag.path), "R0 gesture driver timed out")
        let selected = (host.document.selectedTextRange as? R0Range)?.value
        let state: [String: Any] = [
            "selectionStart": selected?.location ?? -1,
            "selectionLength": selected?.length ?? 0,
            "tableOffset": host.document.tableOffset,
            "parentOffset": host.scroll.contentOffset.y,
            "mutations": host.mutationCount,
            "retentionFailures": host.retentionFailures,
            "selectionRangeChanges": host.selectionChanges,
            "accessibleReadingElements": host.document.accessibilityElements?.count ?? 0,
            "edgeFrames": host.document.selectionEdge.frameCount,
            "edgeRunningAfterRelease": host.document.selectionEdge.isRunning,
            "edgeAnchorAfterRelease": host.document.selectionEdge.anchor ?? -1
        ]
        try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys]).write(to: evidence.appendingPathComponent("gesture-state.json"))
        try JSONSerialization.data(withJSONObject: host.motionTrace, options: [.prettyPrinted, .sortedKeys]).write(to: evidence.appendingPathComponent("edge-motion.json"))
        XCTAssertFalse(host.document.selectionEdge.isRunning)
        XCTAssertNil(host.document.selectionEdge.anchor)
        XCTAssertEqual(host.retentionFailures, 0)
        XCTAssertGreaterThan(host.selectionChanges, 0, "Native gesture must produce a range")
        let gestureRange = try XCTUnwrap(selected)
        XCTAssertGreaterThan(gestureRange.length, 0)
        XCTAssertEqual(UIPasteboard.general.string.map { Data($0.utf8) }, Data(host.document.document.plain(in: gestureRange).utf8), "Copy must come from native menu, not a test-set clipboard")
    }
}

@MainActor
private final class R0FixtureController: UIViewController {
    let document = R0DocumentView()
    let scroll = UIScrollView()
    private let status = UILabel()
    private let controls = UIStackView()
    private var narrow = false
    private(set) var mutationCount = 0
    private(set) var retentionFailures = 0
    private(set) var selectionChanges = 0
    private(set) var motionTrace: [[String: Any]] = []
    var onCheckpoint: (() -> Void)?
    private enum EdgeProbe { case mutate, cancel, remove }
    private var edgeProbe: EdgeProbe?
    private var probeAtFrame = 0
    private(set) var probeFrame = 0
    private(set) var mutationProbe: [String: Any] = [:]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        status.accessibilityIdentifier = "r0-status"
        controls.axis = .vertical
        controls.distribution = .fillEqually
        let primary = UIStackView(), probes = UIStackView()
        for row in [primary, probes] { row.distribution = .fillEqually; controls.addArrangedSubview(row) }
        for (title, action) in [("Append", #selector(append)), ("Width", #selector(width)), ("Type", #selector(typeSize)), ("Image", #selector(image)), ("Table Copy", #selector(tableCopy)), ("Save", #selector(checkpoint)), ("Arm", #selector(armMutation)), ("Cancel", #selector(armCancel)), ("Remove", #selector(armRemove))] {
            let button = UIButton(type: .system)
            button.setTitle(title, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 12)
            button.accessibilityIdentifier = "r0-" + title.lowercased().replacingOccurrences(of: " ", with: "-")
            button.addTarget(self, action: action, for: .touchUpInside)
            (["Arm", "Cancel", "Remove"].contains(title) ? probes : primary).addArrangedSubview(button)
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
                                    "rangeStart": (document.selectedTextRange as? R0Range)?.value.location ?? -1,
                                    "rangeLength": (document.selectedTextRange as? R0Range)?.value.length ?? 0])
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
                    mutate { self.document.imageHeight = 120 }
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
        let range = (document.selectedTextRange as? R0Range)?.value
        status.text = "Range \(range?.location ?? -1):\(range?.length ?? 0) updates \(mutationCount) failures \(retentionFailures)"
    }
    private func mutate(_ action: () -> Void) {
        let range = (document.selectedTextRange as? R0Range)?.value
        let offset = document.tableOffset
        let reading = scroll.contentOffset
        action()
        document.layoutIfNeeded()
        updateHeight()
        mutationCount += 1
        if range != (document.selectedTextRange as? R0Range)?.value || document.tableOffset != offset || scroll.contentOffset != reading { retentionFailures += 1 }
        updateStatus()
    }
    @objc private func append() { mutate { document.append("Stream 東京 👩🏽‍💻 continues. ") } }
    @objc private func width() { mutate { narrow.toggle(); view.setNeedsLayout(); view.layoutIfNeeded() } }
    @objc private func typeSize() { mutate { document.font = .preferredFont(forTextStyle: .body, compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraLarge)) } }
    @objc private func image() { mutate { document.imageHeight = 120 } }
    private func arm(_ probe: EdgeProbe) { edgeProbe = probe; probeAtFrame = document.selectionEdge.frameCount + 10 }
    @objc private func armMutation() { arm(.mutate) }
    @objc private func armCancel() { arm(.cancel) }
    @objc private func armRemove() { arm(.remove) }
    @objc private func checkpoint() { onCheckpoint?() }
    @objc private func tableCopy() { document.copyTableMarkdown() }
}
