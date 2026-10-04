import MobileData
import SwiftUI
import XCTest
@testable import SentientApp

@MainActor
private final class ComposerMotionModel: ObservableObject {
    @Published var mode: TalkMode = .idle
    @Published var disabled = false
    @Published var failureId: String?
    @Published var draft = ""
    var sent: [String] = []
    var sendTask: Task<Void, Never>?
    var sendTaskEntered = false
}

private struct ComposerMotionFixture: View {
    @ObservedObject var model: ComposerMotionModel
    var controlled = true
    var body: some View {
        VStack {
            Spacer()
            Composer(tasks: [], ttsEnabled: true, talkMode: model.mode, captureFailureId: model.failureId, micLevels: [0],
                voiceDisabled: model.disabled, canInterrupt: true, initialDraft: model.draft,
                draftText: controlled ? model.draft : nil,
                onDraftChange: { model.draft = $0 },
                onSend: { text in
                    model.sent.append(text)
                    model.sendTask = Task { @MainActor in
                        model.sendTaskEntered = true
                        model.draft = ""
                    }
                }, onVoiceIntent: { _ in XCTFail("No audio intents allowed") },
                onTtsToggle: {}, onInterrupt: {}, onFocusGained: {})
        }.duskTheme()
    }
}

@MainActor
final class ComposerMotionTests: XCTestCase {
    private var link: CADisplayLink?
    private var tick: (() -> Void)?
    @objc private func sample() { tick?() }

    func testFixedWindowGestureAnchorThroughNormalInterruptedAndReversedMorphs() async throws {
        try await probe(width: 390, direction: .leftToRight, type: .large)
    }

    func testNarrowRTLAnchorThroughReversedMorphs() async throws {
        try await probe(width: 320, direction: .rightToLeft, type: .large)
    }

    func testAccessibilityAnchorThroughReversedMorphs() async throws {
        try await probe(width: 390, direction: .leftToRight, type: .accessibility3)
    }

    func testFailureAndRevocationPreserveNativeMarkedTextAndFocus() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let model = ComposerMotionModel()
        model.draft = "Disposable draft"
        let host = UIHostingController(rootView: ComposerMotionFixture(model: model))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        host.view.layoutIfNeeded()
        await Task.yield()
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let editor = try XCTUnwrap(descendants(host.view).compactMap { $0 as? ComposerTextView }.first)
        XCTAssertTrue(editor.becomeFirstResponder())
        editor.selectedRange = NSRange(location: 4, length: 0)
        editor.setMarkedText("編輯", selectedRange: NSRange(location: 1, length: 0))
        let text = editor.text
        let selection = editor.selectedRange
        let marked = try XCTUnwrap(editor.markedTextRange)
        let markedText = editor.text(in: marked)
        XCTAssertTrue(editor.delegate?.textView?(
            editor, shouldChangeTextIn: editor.selectedRange, replacementText: "\n") ?? true)
        XCTAssertTrue(model.sent.isEmpty, "IME Return must not submit")
        for failure: String? in ["failed-capture", nil] {
            model.failureId = failure
            await Task.yield()
            host.view.layoutIfNeeded()
            XCTAssertTrue(editor.isFirstResponder)
            XCTAssertEqual(editor.text, text)
            XCTAssertEqual(editor.selectedRange, selection)
            XCTAssertEqual(editor.text(in: try XCTUnwrap(editor.markedTextRange)), markedText)
        }
    }

    // Native consumer boundary: no responder callbacks during reconciliation;
    // latest binding wins, even before another SwiftUI update is delivered.
    func testFocusReconciliationDefersNativeTransitionAndReadsLatestBinding() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        var focused = true
        var focusWrites = 0
        let input = ComposerTextInput(text: .constant("Disposable draft"),
            isFocused: Binding(get: { focused }, set: { focused = $0; focusWrites += 1 }),
            minimumHeight: 40, onPasteProviders: { _ in })
        let coordinator = input.makeCoordinator()
        let editor = ComposerTextView(frame: CGRect(x: 0, y: 0, width: 300, height: 80))
        configureComposerTextView(editor, text: "Disposable draft")
        editor.delegate = coordinator
        window.rootViewController?.view.addSubview(editor)
        XCTAssertTrue(editor.becomeFirstResponder())
        focusWrites = 0
        editor.selectedRange = NSRange(location: 4, length: 3)
        focused = false
        coordinator.reconcileFocus(in: editor)
        XCTAssertTrue(editor.isFirstResponder, "Resignation must not run inside SwiftUI reconciliation")
        focused = true // New user intent, without another representable update.
        coordinator.reconcileFocus(in: editor)
        await drainMainQueue()
        XCTAssertTrue(editor.isFirstResponder)
        XCTAssertEqual(editor.selectedRange, NSRange(location: 4, length: 3))
        XCTAssertEqual(focusWrites, 0, "Programmatic transitions must not echo stale focus through delegates")
        focused = false
        coordinator.reconcileFocus(in: editor)
        XCTAssertTrue(editor.isFirstResponder)
        await drainMainQueue()
        XCTAssertFalse(editor.isFirstResponder)
        XCTAssertEqual(focusWrites, 0)
        focused = true
        coordinator.reconcileFocus(in: editor)
        focused = false // A queued become must not steal focus back.
        await drainMainQueue()
        XCTAssertFalse(editor.isFirstResponder)

        focused = true
        coordinator.reconcileFocus(in: editor)
        ComposerTextInput.dismantleUIView(editor, coordinator: coordinator)
        // Still mounted: dismantle must invalidate queued work before UIKit removes it.
        await drainMainQueue()
        XCTAssertFalse(editor.isFirstResponder)
        XCTAssertNil(editor.delegate)
    }

    func testUnmountedInputReconcilesOnRemountAndCannotRefocusAfterDismantle() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        var focused = false
        let input = ComposerTextInput(text: .constant("Disposable draft"),
            isFocused: Binding(get: { focused }, set: { focused = $0 }),
            minimumHeight: 40, onPasteProviders: { _ in })
        let host = UIHostingController(rootView: input)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        host.view.layoutIfNeeded()
        await drainMainQueue()
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let editor = try XCTUnwrap(descendants(host.view).compactMap { $0 as? ComposerTextView }.first)
        let coordinator = try XCTUnwrap(editor.delegate as? ComposerTextInput.Coordinator)
        let container = try XCTUnwrap(editor.superview)
        editor.removeFromSuperview()
        focused = true
        coordinator.reconcileFocus(in: editor)
        await drainMainQueue()
        XCTAssertNil(editor.window)
        XCTAssertFalse(editor.isFirstResponder)
        container.addSubview(editor)
        try await waitFor { editor.isFirstResponder }
        focused = false
        coordinator.reconcileFocus(in: editor)
        await drainMainQueue()
        XCTAssertFalse(editor.isFirstResponder)
        focused = true
        coordinator.reconcileFocus(in: editor)
        ComposerTextInput.dismantleUIView(editor, coordinator: coordinator)
        editor.removeFromSuperview()
        host.view.addSubview(editor)
        await drainMainQueue()
        XCTAssertFalse(editor.isFirstResponder, "Removed editor must not steal replacement's focus")
    }

    func testReturnInsertsNewlineWithoutSendingOrLosingFocus() async throws {
        for controlled in [true, false] {
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let model = ComposerMotionModel()
            model.draft = "Disposable draft"
            let host = UIHostingController(rootView: ComposerMotionFixture(model: model, controlled: controlled))
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { model.sendTask?.cancel(); window.isHidden = true; window.rootViewController = nil }
            host.view.layoutIfNeeded()
            await drainMainQueue()
            func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
            let editor = try XCTUnwrap(descendants(host.view).compactMap { $0 as? ComposerTextView }.first)
            XCTAssertTrue(editor.becomeFirstResponder())
            await drainMainQueue()
            host.view.layoutIfNeeded()
            XCTAssertEqual(editor.returnKeyType, .default)
            editor.selectedRange = NSRange(location: editor.text.utf16.count, length: 0)
            let shouldInsert = editor.delegate?.textView?(
                editor, shouldChangeTextIn: editor.selectedRange, replacementText: "\n") ?? true
            XCTAssertTrue(shouldInsert)
            editor.insertText("\nSecond line")
            try await waitFor { host.view.layoutIfNeeded(); return model.draft == "Disposable draft\nSecond line" }
            XCTAssertTrue(model.sent.isEmpty)
            XCTAssertFalse(model.sendTaskEntered)
            XCTAssertTrue(editor.isFirstResponder)
            XCTAssertEqual(editor.text, "Disposable draft\nSecond line")
        }
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    private func waitFor(_ condition: () -> Bool) async throws {
        let deadline = CACurrentMediaTime() + 3
        while !condition(), CACurrentMediaTime() < deadline { await drainMainQueue() }
        XCTAssertTrue(condition(), "Native composer did not reach expected state")
    }

    private func probe(width: CGFloat, direction: LayoutDirection, type: DynamicTypeSize) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let model = ComposerMotionModel()
        let host = UIHostingController(rootView: ComposerMotionFixture(model: model)
            .environment(\.horizontalSizeClass, .compact)
            .environment(\.layoutDirection, direction)
            .environment(\.dynamicTypeSize, type))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 844)
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        await Task.yield()
        host.view.layoutIfNeeded()
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let gestureHost = try XCTUnwrap(descendants(host.view).first { $0 is VoiceCaptureGestureHostView })
        let identity = ObjectIdentifier(gestureHost)
        let finished = expectation(description: "Sample real display frames")
        var frames: [[String: Double]] = []
        var count = 0
        let startedAt = CACurrentMediaTime()
        let initial = gestureHost.convert(gestureHost.bounds, to: window)
        tick = {
            count += 1
            let layer = gestureHost.layer.presentation() ?? gestureHost.layer
            let frame = layer.convert(layer.bounds, to: window.layer.presentation() ?? window.layer)
            frames.append(["frame": Double(count), "seconds": CACurrentMediaTime() - startedAt,
                           "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height])
            XCTAssertEqual(descendants(host.view).first { $0 is VoiceCaptureGestureHostView }.map(ObjectIdentifier.init), identity)
            XCTAssertTrue(gestureHost.window === window)
            XCTAssertEqual(direction == .leftToRight ? frame.maxX : frame.minX,
                           direction == .leftToRight ? initial.maxX : initial.minX,
                           accuracy: 1, "Trailing anchor, sample \(count)")
            XCTAssertEqual(frame.maxY, initial.maxY, accuracy: 1, "Bottom anchor, sample \(count)")
            switch count {
            case 5: model.mode = .hold
            case 35: model.mode = .continuous
            case 65: model.mode = .idle
            case 70: model.mode = .hold
            case 75: model.mode = .idle
            case 100: model.disabled = true
            case 125: finished.fulfill()
            default: break
            }
        }
        link = CADisplayLink(target: self, selector: #selector(sample))
        link?.add(to: .main, forMode: .common)
        await fulfillment(of: [finished], timeout: 10)
        link?.invalidate()
        link = nil
        tick = nil
        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: frames, options: [.prettyPrinted, .sortedKeys]), uniformTypeIdentifier: "public.json")
        attachment.name = "fixed-window-anchor-frames"
        attachment.lifetime = .keepAlways
        add(attachment)
        window.isHidden = true
        window.rootViewController = nil
        XCTAssertGreaterThanOrEqual(frames.count, 125)
    }
}
