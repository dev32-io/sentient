// Standalone fixture targets only. Production leaves, disposable values, no session/audio.
#if C_COMPOSER_FIXTURE || C_COMPOSER_UI_TESTS
import Foundation

private struct ComposerOrderingEvent: Codable {
    let sequence: Int
    let attempt: Int
    let host: String
    let event: String
    let state: String?
    let active: Bool?
    let intent: String?
}
#endif

#if C_COMPOSER_FIXTURE
import SwiftUI
import MobileData

@main
final class ComposerDeliveryApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = UIHostingController(rootView: ComposerDeliveryFixture())
        window?.makeKeyAndVisible()
        return true
    }
}

/// Boundary probe only: snapshots callbacks installed on the real UIKit host.
/// No reducer, clock, capture authority, or per-event SwiftUI publication.
@MainActor
final class ComposerGestureProbe {
    static let shared = ComposerGestureProbe()
    var attempt = 0
    var onFailureApplied: (() -> Void)?
    private var events: [ComposerOrderingEvent] = []
    private var host = "uninstalled"
    private weak var view: UIView?
    private var geometry: VoiceCaptureGestureHostGeometry?
    private var installed: VoiceCaptureGesture?
    private var retained: VoiceCaptureGesture?
    private var beginSample: VoiceCaptureGestureSample?

    func install(_ gesture: VoiceCaptureGesture, in view: UIView, geometry: VoiceCaptureGestureHostGeometry) {
        self.installed = gesture
        self.view = view
        self.geometry = geometry
        let identity = String(describing: ObjectIdentifier(view))
        if host != identity {
            host = identity
            record("installed")
        }
    }

    func record(_ event: String, state: VoiceCaptureState? = nil, active: Bool? = nil, intent: String? = nil) {
        events.append(.init(sequence: events.count + 1, attempt: attempt, host: host,
                            event: event, state: state?.rawValue, active: active, intent: intent))
    }

    var snapshot: String { String(decoding: try! JSONEncoder().encode(events), as: UTF8.self) }

    func begin() {
        guard let installed, let view, let geometry else { preconditionFailure("Gesture not installed") }
        retained = installed
        let sample = VoiceCaptureGestureSample(
            locationInWindow: view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: view.window),
            targetGeometryInWindow: geometry.targetGeometry(in: view))
        beginSample = sample
        installed.onBegin(sample)
    }

    func release() {
        guard let retained, let beginSample else { preconditionFailure("Begin missing") }
        // Existing strict travel bound selects Send without a duration/scheduling premise.
        let sample = VoiceCaptureGestureSample(
            locationInWindow: CGPoint(x: beginSample.locationInWindow.x + VoiceCaptureReducer.quickAutoTravelThreshold,
                                      y: beginSample.locationInWindow.y),
            targetGeometryInWindow: beginSample.targetGeometryInWindow)
        retained.onChange(sample)
        retained.onTerminate(.released, sample)
    }
}

private struct ComposerDeliveryFixture: View {
    @State private var appliedAttempt = 0
    @State private var orderingTrace = "[]"
    @State private var mode: TalkMode = .idle
    @State private var captureFailureId: String?
    @State private var injectedStartFailure = false
    @State private var draft = ""
    @State private var intents: [String] = []
    @State private var tasks = false
    @State private var taskCount = 1
    @State private var loud = false
    @State private var pending: VoiceCaptureIntent?
    @State private var attachmentVisible = false
    @State private var previewReady = false
    @State private var committed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let voiceOnly = ProcessInfo.processInfo.environment["C_SCENARIO"] == "voice"
    var body: some View {
        VStack {
            Text("Motion: \(reduceMotion ? "reduced" : "normal")").accessibilityIdentifier("c-motion")
            Text(intents.joined(separator: ",")).accessibilityIdentifier("c-intents")
            if voiceOnly {
                HStack {
                    Text("Applied: \(appliedAttempt)").accessibilityIdentifier("c-applied")
                    Text("Ordered events").accessibilityValue(orderingTrace).accessibilityIdentifier("c-trace")
                    Button("Trace") { orderingTrace = ComposerGestureProbe.shared.snapshot }
                }
                if ProcessInfo.processInfo.environment["C_ORDERING_DRIVER"] == "1" {
                    HStack {
                        Button("Begin") { ComposerGestureProbe.shared.begin() }
                        Button("Publish failure") { publishFailure() }
                        Button("Old release") { ComposerGestureProbe.shared.release() }
                    }
                }
            }
            HStack {
                Button("Idle") { mode = .idle }
                Button("Hold") { mode = .hold }
                Button("Auto") { mode = .continuous }
                Button("Levels") { loud.toggle() }
                Button("Fail") { mode = .idle; captureFailureId = UUID().uuidString }
                Button("Clear") { captureFailureId = nil }
                Button("ABI") {
                    Task { @MainActor in
                        for await failure in captureStartFailureBridgeProbe() {
                            captureFailureId = failure.captureId
                        }
                    }
                }
                Button("More") { taskCount = taskCount == 1 ? 2 : 1 }
            }
            HStack {
                Button("Tasks") { tasks.toggle() }
                Button("Complete") {
                    if let pending { mode = pending == .enterAuto ? .continuous : .idle }
                    pending = nil
                }
                Button("File") { attachmentVisible.toggle() }
                Button("Poster") { previewReady.toggle() }
                if ProcessInfo.processInfo.environment["C_SCENARIO"] == "timeline" {
                    Button("Commit") { committed.toggle() }
                }
                Button("Draft") { draft = draft.isEmpty ? "First line\nSecond line\nThird line\nFourth line\nFifth line\nSixth line" : "" }
            }
            Spacer()
            if voiceOnly {
                HStack {
                    Spacer()
                    VoiceCaptureControl(talkMode: mode, levels: Array(repeating: loud ? 1 : 0, count: 32), disabled: false,
                        captureFailureId: captureFailureId,
                        permission: .init(status: { ProcessInfo.processInfo.environment["C_PERMISSION"] == "denied" ? .denied : .granted }, request: { _ in fatalError("No permission request allowed") }),
                        onHoldPresentationChanged: { _ in }, onIntent: { intent in
                            ComposerGestureProbe.shared.record("intent", intent: String(describing: intent))
                            intents.append(String(describing: intent))
                            if intent == .holdStart || intent == .enterAuto { captureFailureId = nil }
                            if intent == .holdStart {
                                mode = .hold
                                if ProcessInfo.processInfo.environment["C_FAIL_START"] == "1", !injectedStartFailure {
                                    injectedStartFailure = true
                                    ComposerGestureProbe.shared.record("failure-task-created")
                                    Task { @MainActor in
                                        ComposerGestureProbe.shared.record("failure-task-entered")
                                        try? await Task.sleep(for: .milliseconds(100))
                                        ComposerGestureProbe.shared.record("failure-task-resumed")
                                        mode = .idle
                                        publishFailure()
                                    }
                                }
                            }
                            if intent == .enterAuto || intent == .sendHeld || intent == .cancelHeld || intent == .exitAuto {
                                pending = intent
                            }
                        })
                }.padding(30)
            } else if ProcessInfo.processInfo.environment["C_SCENARIO"] == "timeline" {
                ScrollView {
                    if committed {
                        MessageBubble(message: ChatMessage(ts: 1, role: "user", content: "", streaming: false,
                            cutoffKind: nil, turnId: nil, replyId: nil, pendingId: "fixture-pending", sessionId: "fixture-session",
                            entryId: "fixture-entry", attachments: [AttachmentRef(attachmentId: "fixture-server", displayName: "Disposable image.png",
                                contentType: "image/png", mediaKind: "image", size: 100)]), index: 0,
                            attachmentPreviews: previewReady ? ["fixture-server": UIImage(systemName: "photo")!] : [:],
                            attachmentPreviewFailures: previewReady ? [] : ["fixture-server"],
                            onPreviewAttachment: { _ in intents.append("open") })
                    } else {
                        PendingBubble(msg: PendingMessage(id: "fixture-pending", text: "", status: .queued, sentAtMs: nil),
                            attachments: [NativeDraftAttachment(id: "fixture-image", displayName: "Disposable image.png", mediaType: "image/png", sizeBytes: 100, localPath: "/unused-fixture-path")],
                            attachmentPreviews: previewReady ? ["fixture-image": UIImage(systemName: "photo")!] : [:],
                            onPreviewAttachment: { _ in intents.append("open") }, measurement: true)
                    }
                }.padding(16)
            } else {
                Composer(tasks: tasks ? (1...taskCount).map { index in TaskListItem(id: index == 1 ? "one" : "two", toolName: "Inspect arguments", kind: "background", status: "running",
                    argsPreview: (1...20).map { "Argument \($0): disposable value" }.joined(separator: "\n"), startedAtMs: 1, endedAtMs: nil) } : [],
                    ttsEnabled: true, talkMode: mode, captureFailureId: captureFailureId, micLevels: Array(repeating: loud ? 1 : 0, count: 32),
                    voiceDisabled: false, canInterrupt: true, draftText: draft,
                    attachments: attachmentVisible ? [ComposerAttachment(NativeDraftAttachment(id: "fixture-image", displayName: "Disposable image.png", mediaType: "image/png", sizeBytes: 100, localPath: "/unused-fixture-path"))] : [],
                    attachmentPreviews: previewReady ? ["fixture-image": UIImage(systemName: "photo")!] : [:],
                    attachmentPreviewFailures: previewReady ? [] : ["fixture-image"],
                    onDraftChange: { draft = $0 }, onRemoveAttachment: { _ in attachmentVisible = false }, onSend: { _ in intents.append("send"); draft = "" },
                    onVoiceIntent: { _ in fatalError("Composer fixture never activates live permission boundary") },
                    onTtsToggle: {}, onInterrupt: {}, onFocusGained: {})
            }
        }
        .frame(maxWidth: ProcessInfo.processInfo.environment["C_WIDTH"] == "narrow" ? 320 : .infinity)
        .environment(\.dynamicTypeSize, ProcessInfo.processInfo.environment["C_TEXT"] == "large" ? .accessibility3 : .large)
        .environment(\.layoutDirection, ProcessInfo.processInfo.environment["C_RTL"] == "1" ? .rightToLeft : .leftToRight)
        .duskTheme()
        .onAppear {
            ComposerGestureProbe.shared.onFailureApplied = {
                appliedAttempt = ComposerGestureProbe.shared.attempt
            }
        }
        .onDisappear { ComposerGestureProbe.shared.onFailureApplied = nil }
    }

    private func publishFailure() {
        ComposerGestureProbe.shared.record("failure-write")
        captureFailureId = "fixture-failed-capture"
    }
}
#endif

#if C_COMPOSER_UI_TESTS
import XCTest

@MainActor
final class ComposerDeliveryInteractionTests: XCTestCase {
    private func launch(voice: Bool = false, denied: Bool = false, timeline: Bool = false, failStart: Bool = false, orderingDriver: Bool = false, width: String = "default", largeText: Bool = false, rtl: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["C_SCENARIO"] = timeline ? "timeline" : voice ? "voice" : "composer"
        app.launchEnvironment["C_PERMISSION"] = denied ? "denied" : "granted"
        app.launchEnvironment["C_FAIL_START"] = failStart ? "1" : "0"
        app.launchEnvironment["C_ORDERING_DRIVER"] = orderingDriver ? "1" : "0"
        app.launchEnvironment["C_WIDTH"] = width
        app.launchEnvironment["C_TEXT"] = largeText ? "large" : "default"
        app.launchEnvironment["C_RTL"] = rtl ? "1" : "0"
        app.launch()
        XCTAssertTrue(app.staticTexts["c-motion"].waitForExistence(timeout: 5))
        return app
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    func testComposerTransitionsAndNativeEditing() {
        let app = launch()
        capture(app, "idle")
        app.buttons["Hold"].tap()
        capture(app, "hold")
        app.buttons["Auto"].tap()
        capture(app, "auto")
        app.buttons["Idle"].tap()
        app.buttons["Draft"].tap()
        capture(app, "multiline")
        app.buttons["Draft"].tap()
        let editor = app.textViews["composer-input"]
        editor.tap()
        editor.typeText("Disposable draft\nSecond line")
        XCTAssertEqual(editor.value as? String, "Disposable draft\nSecond line")
        XCTAssertEqual(app.staticTexts["c-intents"].label, "", "Return must not submit")
        capture(app, "keyboard")
        app.buttons["chat-send"].tap()
        XCTAssertEqual(app.staticTexts["c-intents"].label, "send")
        XCTAssertEqual(editor.value as? String, "")
        editor.tap()
        editor.typeText("Next draft")
        XCTAssertEqual(editor.value as? String, "Next draft")
        XCTAssertEqual(app.staticTexts["c-intents"].label, "send")
        app.buttons["Tasks"].tap()
        app.buttons["task-pill-one"].tap()
        capture(app, "arguments")
        let arguments = app.scrollViews["task-arguments-scroll-one"]
        XCTAssertTrue(arguments.exists)
        arguments.swipeUp()
        capture(app, "arguments-last-lines")
        app.buttons["task-pill-one"].tap()
        XCTAssertEqual(app.buttons["task-pill-one"].value as? String, "Collapsed")
        XCTAssertFalse(arguments.isHittable)
        capture(app, "arguments-collapsed")
        app.buttons["task-pill-one"].tap()
        XCTAssertTrue(arguments.exists)
        app.buttons["More"].tap()
        app.buttons["task-pill-two"].tap()
        XCTAssertEqual(app.buttons["task-pill-one"].value as? String, "Collapsed")
        XCTAssertEqual(app.buttons["task-pill-two"].value as? String, "Expanded")
        capture(app, "arguments-second-task")
        app.buttons["More"].tap()
        XCTAssertFalse(app.buttons["task-pill-two"].exists)
        XCTAssertEqual(app.buttons["task-pill-one"].value as? String, "Collapsed")
        app.buttons["Tasks"].tap()
        XCTAssertFalse(app.buttons["task-pill-one"].exists)
    }
    func testAttachmentFailurePreviewAndReservedThumbnail() {
        let app = launch()
        app.buttons["File"].tap()
        let preview = app.buttons["composer-attachment-preview-fixture-image"]
        XCTAssertTrue(preview.exists)
        let reserved = preview.frame
        preview.tap()
        XCTAssertTrue(app.staticTexts["Preview unavailable"].waitForExistence(timeout: 3))
        capture(app, "failed-preview-metadata")
        app.buttons["Close"].tap()
        app.buttons["Poster"].tap()
        XCTAssertEqual(preview.frame, reserved)
        capture(app, "reserved-poster-arrival")
        app.buttons["composer-attachment-dismiss-fixture-image"].tap()
        XCTAssertFalse(preview.exists)
    }

    func testPendingCommittedPosterGeometryAndPreviewActions() {
        let app = launch(timeline: true)
        let pending = app.buttons["pending-attachment-fixture-image"]
        XCTAssertTrue(pending.exists)
        let reservedHeight = pending.frame.height
        pending.tap()
        app.buttons["Poster"].tap()
        XCTAssertEqual(pending.frame.height, reservedHeight, accuracy: 0.001)
        capture(app, "pending-reserved-poster")
        app.buttons["Commit"].tap()
        let committed = app.buttons["attachment-fixture-server"]
        XCTAssertTrue(committed.exists)
        XCTAssertEqual(committed.frame.height, reservedHeight, accuracy: 0.001)
        committed.tap()
        capture(app, "committed-reserved-poster")
        app.buttons["Poster"].tap()
        XCTAssertEqual(committed.frame.height, reservedHeight, accuracy: 0.001)
        XCTAssertEqual(committed.value as? String, "Preview unavailable")
        committed.tap()
        XCTAssertEqual(app.staticTexts["c-intents"].label, "open,open,open")
        capture(app, "committed-failed-poster")
    }

    func testPhysicalHoldSendAndDragCancelEmitOneTerminalEach() {
        let app = launch(voice: true)
        let mic = app.buttons["chat-mic"]
        mic.press(forDuration: 0.45)
        XCTAssertEqual(app.staticTexts["c-intents"].label, "holdStart,sendHeld")
        XCTAssertFalse(mic.isEnabled)
        capture(app, "held-send-terminal")
        app.buttons["Complete"].tap()
        // Compact production crown is 210×58, joined 8pt into a 52pt pod.
        // Target its middle third from the fixed bottom/trailing idle anchor.
        let cancel = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: mic.frame.maxX - 210 / 2, dy: mic.frame.maxY - 52 + 8 - 58 / 2))
        mic.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.45, thenDragTo: cancel)
        XCTAssertEqual(app.staticTexts["c-intents"].label, "holdStart,sendHeld,holdStart,cancelHeld")
        XCTAssertFalse(mic.isEnabled)
        capture(app, "drag-cancel-terminal")
        app.buttons["Complete"].tap()
    }

    private func trace(_ app: XCUIApplication, _ name: String) throws -> [ComposerOrderingEvent] {
        app.buttons["Trace"].tap()
        let json = try XCTUnwrap(app.staticTexts["c-trace"].value as? String)
        let attachment = XCTAttachment(string: json)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        let events = try JSONDecoder().decode([ComposerOrderingEvent].self, from: Data(json.utf8))
        XCTAssertEqual(events.map(\.sequence), Array(1...events.count))
        XCTAssertEqual(Set(events.map(\.host)).count, 1, "Host replacement must not hide stale callback state")
        XCTAssertNotEqual(events.first?.host, "uninstalled")
        return events
    }

    private func awaitFailureApplied(_ app: XCUIApplication) {
        let applied = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Applied: 1'"), object: app.staticTexts["c-applied"])
        XCTAssertEqual(XCTWaiter.wait(for: [applied], timeout: 3), .completed)
    }

    /// Same-attempt output is strict for observed application/callback order.
    /// Neither notice pixels nor parent assignment stand in for application.
    private func assertFirstAttemptOrdering(_ events: [ComposerOrderingEvent], failureFirst: Bool? = nil) throws {
        let first = events.filter { $0.attempt == 1 }
        for event in ["begin", "released", "failure-write", "failure-applied"] {
            XCTAssertEqual(first.filter { $0.event == event }.count, 1, event)
        }
        let release = try XCTUnwrap(first.first { $0.event == "released" })
        let write = try XCTUnwrap(first.first { $0.event == "failure-write" })
        let applied = try XCTUnwrap(first.first { $0.event == "failure-applied" })
        XCTAssertLessThan(write.sequence, applied.sequence)
        let before = applied.sequence < release.sequence
        if let failureFirst { XCTAssertEqual(before, failureFirst) }
        let intents = first.compactMap(\.intent)
        if before {
            XCTAssertEqual(intents, ["holdStart"], "Applied failure must suppress every old terminal")
            XCTAssertEqual(release.state, "failed")
            XCTAssertEqual(release.active, false)
        } else {
            XCTAssertEqual(intents, ["holdStart", "sendHeld"])
            XCTAssertEqual(release.state, "hold")
            XCTAssertEqual(release.active, true)
            let send = try XCTUnwrap(first.first { $0.intent == "sendHeld" })
            XCTAssertLessThan(release.sequence, send.sequence)
            XCTAssertLessThan(send.sequence, applied.sequence, "Never accept Send after same-attempt applied failure")
        }
        XCTAssertEqual(applied.state, "failed")
        XCTAssertEqual(applied.active, false)
    }

    // Actual installed callbacks + real parent SwiftUI failure input; no adapter/PCM.
    func testAppliedFailureBeforeRetainedReleaseSuppressesTerminalAndAllowsRetry() throws {
        let app = launch(voice: true, orderingDriver: true)
        app.buttons["Begin"].tap()
        XCTAssertEqual(app.staticTexts["c-intents"].label, "holdStart")
        app.buttons["Publish failure"].tap()
        awaitFailureApplied(app)
        app.buttons["Old release"].tap()
        try assertFirstAttemptOrdering(trace(app, "deterministic-failure-before-release"), failureFirst: true)
        XCTAssertEqual(app.staticTexts["c-intents"].label, "holdStart")
        XCTAssertTrue(app.staticTexts["mic-denied-notice"].exists)
        XCTAssertTrue(app.buttons["chat-mic"].isEnabled)
        app.buttons["Begin"].tap()
        app.buttons["Old release"].tap()
        app.buttons["Old release"].tap() // Retained duplicate cannot emit another terminal.
        let retry = try trace(app, "deterministic-enabled-retry").filter { $0.attempt == 2 }
        XCTAssertEqual(retry.compactMap(\.intent), ["holdStart", "sendHeld"])
        XCTAssertEqual(app.staticTexts["c-intents"].label, "holdStart,holdStart,sendHeld")
    }

    func testRetainedReleaseBeforeFailureCanSendBeforeNotice() throws {
        let app = launch(voice: true, orderingDriver: true)
        app.buttons["Begin"].tap()
        app.buttons["Old release"].tap()
        XCTAssertEqual(app.staticTexts["c-intents"].label, "holdStart,sendHeld")
        XCTAssertFalse(app.staticTexts["mic-denied-notice"].exists)
        app.buttons["Publish failure"].tap()
        awaitFailureApplied(app)
        try assertFirstAttemptOrdering(trace(app, "deterministic-release-before-failure"), failureFirst: false)
        XCTAssertTrue(app.staticTexts["mic-denied-notice"].exists)
        XCTAssertTrue(app.buttons["chat-mic"].isEnabled)
    }

    // Original26 failure/artifacts retained: holdStart,sendHeld before visible notice.
    // Original100ms task +450ms press never established failure-applied-before-release.
    // Strict left-hand precondition is now enforced independently above, not by sleeps.
    func testPhysicalFailureTraceAndRetry() throws {
        let app = launch(voice: true, failStart: true)
        let mic = app.buttons["chat-mic"]
        mic.press(forDuration: 0.45)
        awaitFailureApplied(app)
        XCTAssertTrue(app.staticTexts["Voice capture could not start. Text messages are still available."].waitForExistence(timeout: 3))
        let first = try trace(app, "physical-first-attempt-ordering")
        try assertFirstAttemptOrdering(first)
        XCTAssertEqual(first.filter { $0.event == "recognizer-3" }.count, 1)
        XCTAssertEqual(first.filter { $0.event == "failure-task-created" }.count, 1)
        XCTAssertEqual(first.filter { $0.event == "failure-task-entered" }.count, 1)
        XCTAssertEqual(first.filter { $0.event == "failure-task-resumed" }.count, 1)
        let prefix = app.staticTexts["c-intents"].label
        XCTAssertTrue(mic.isEnabled)
        capture(app, "capture-failed-after-observed-release-order")
        mic.press(forDuration: 0.45)
        let all = try trace(app, "physical-retry-ordering")
        try assertFirstAttemptOrdering(all)
        XCTAssertEqual(all.filter { $0.attempt == 2 }.compactMap(\.intent), ["holdStart", "sendHeld"])
        XCTAssertEqual(all.filter { $0.event == "recognizer-3" }.count, 2)
        XCTAssertEqual(app.staticTexts["c-intents"].label, prefix + ",holdStart,sendHeld")
        capture(app, "capture-retry-single-terminal")
    }

    func testFailureInputKeepsExistingDraftAndSendAvailable() {
        checkFailureContainment()
    }

    func testNarrowFailureContainment() { checkFailureContainment(width: "narrow") }
    func testLargeTextFailureContainment() { checkFailureContainment(largeText: true) }
    func testNarrowRTLFailureContainment() { checkFailureContainment(width: "narrow", rtl: true) }

    private func checkFailureContainment(width: String = "default", largeText: Bool = false, rtl: Bool = false) {
        let app = launch(width: width, largeText: largeText, rtl: rtl)
        app.buttons["Draft"].tap()
        let editor = app.textViews["composer-input"]
        let original = editor.value as? String
        app.buttons["Fail"].tap()
        XCTAssertTrue(app.staticTexts["Voice capture could not start. Text messages are still available."].waitForExistence(timeout: 3))
        XCTAssertEqual(editor.value as? String, original)
        XCTAssertTrue(app.buttons["chat-send"].isEnabled)
        XCTAssertTrue(app.buttons["chat-mic"].isEnabled)
        XCTAssertEqual(app.staticTexts["c-intents"].label, "")
        capture(app, "capture-failed-draft-send-and-retry")
        let notice = app.staticTexts["Voice capture could not start. Text messages are still available."]
        let face = app.otherElements["composer-face-viewport"]
        XCTAssertTrue(face.exists)
        let geometry = ["face": face.frame, "notice": notice.frame, "draft": editor.frame,
                        "send": app.buttons["chat-send"].frame, "mic": app.buttons["chat-mic"].frame]
        let measurement = XCTAttachment(string: geometry.sorted { $0.key < $1.key }
            .map { "\($0.key): \($0.value)" }.joined(separator: "\n"))
        measurement.name = "capture-failed-draft-geometry"
        measurement.lifetime = .keepAlways
        add(measurement)
        XCTAssertTrue(face.frame.contains(notice.frame), "Notice \(notice.frame) outside face \(face.frame)")
        XCTAssertTrue(face.frame.contains(editor.frame))
        XCTAssertTrue(face.frame.contains(app.buttons["chat-send"].frame))
        XCTAssertTrue(face.frame.contains(app.buttons["chat-mic"].frame))
        XCTAssertFalse(notice.frame.intersects(editor.frame))
        XCTAssertFalse(app.buttons["chat-send"].frame.intersects(app.buttons["chat-mic"].frame))
        app.buttons["chat-send"].tap()
        XCTAssertEqual(app.staticTexts["c-intents"].label, "send")
        XCTAssertTrue(app.buttons["chat-mic"].isEnabled)
        XCTAssertTrue(notice.exists)
    }

    func testClearingTypedFailureRemovesNotice() {
        let app = launch(voice: true)
        app.buttons["ABI"].tap()
        let notice = app.staticTexts["mic-denied-notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 3))
        capture(app, "typed-abi-failure-presentation")
        app.buttons["Clear"].tap()
        XCTAssertTrue(notice.waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.buttons["chat-mic"].isEnabled)
        XCTAssertEqual(app.staticTexts["c-intents"].label, "")
        capture(app, "typed-failure-revoked")
    }

    func testDeniedPermissionEmitsNoCaptureIntent() {
        let app = launch(voice: true, denied: true)
        app.buttons["chat-mic"].tap()
        XCTAssertTrue(app.staticTexts["mic-denied-notice"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts["c-intents"].label, "")
        capture(app, "permission-denied-no-audio")
    }

    func testSystemReducedMotionIgnoresChangingLevels() throws {
        let app = launch(voice: true)
        XCTAssertEqual(app.staticTexts["c-motion"].label, "Motion: reduced")
        app.buttons["Auto"].tap()
        let before = app.screenshot().image
        app.buttons["Levels"].tap()
        let after = app.screenshot().image
        // Fixed viewport region, never follows content. Excludes OS clock and fixture controls.
        let a = try XCTUnwrap(before.cgImage)
        let b = try XCTUnwrap(after.cgImage)
        let region = CGRect(x: 0, y: a.height / 2, width: a.width, height: a.height / 2)
        let first = try XCTUnwrap(a.cropping(to: region))
        let second = try XCTUnwrap(b.cropping(to: region))
        XCTAssertEqual(UIImage(cgImage: first).pngData(), UIImage(cgImage: second).pngData())
        capture(app, "system-reduced-zero-full-levels")
    }

    func testPhysicalQuickTapAndDelayedTerminal() {
        let app = launch(voice: true)
        let mic = app.buttons["chat-mic"]
        XCTAssertTrue(mic.exists)
        XCTAssertFalse(app.buttons["voice-send"].isEnabled, "Folded crown must not retain enabled actions")
        XCTAssertFalse(app.buttons["voice-send"].isHittable)
        mic.tap()
        let entered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'holdStart,enterAuto'"), object: app.staticTexts["c-intents"])
        XCTAssertEqual(XCTWaiter.wait(for: [entered], timeout: 3), .completed)
        XCTAssertFalse(mic.isEnabled)
        XCTAssertGreaterThan(mic.frame.width, 150)
        capture(app, "locked-terminal-pod")
        mic.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        XCTAssertEqual(app.staticTexts["c-intents"].label, "holdStart,enterAuto")
        app.buttons["Complete"].tap()
        let auto = app.buttons.matching(NSPredicate(format: "identifier == 'chat-mic' AND label BEGINSWITH 'Auto listening is on'")).firstMatch
        XCTAssertTrue(auto.waitForExistence(timeout: 3))
        capture(app, "auto-after-delay")
        auto.tap()
        let exited = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'holdStart,enterAuto,exitAuto'"), object: app.staticTexts["c-intents"])
        XCTAssertEqual(XCTWaiter.wait(for: [exited], timeout: 3), .completed)
        XCTAssertFalse(mic.isEnabled)
        XCTAssertGreaterThan(mic.frame.width, 150)
        capture(app, "exit-terminal")
        app.buttons["Complete"].tap()
    }
}
#endif
