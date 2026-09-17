import MobileData
import RiveRuntime
import SwiftUI
import Testing
import UIKit
@testable import SentientApp

struct AssistantAvatarOwnershipTests {
    @Test func ongoingReplyOwnsThinkingStreamingAndCommittedSpeech() {
        let previous = message(turn: "old", reply: "old-reply")
        let thinking = message(turn: "current", reply: nil, streaming: true)
        let streaming = message(turn: "current", reply: "current-reply", streaming: true)
        let committed = message(turn: "current", reply: "current-reply")

        // New cognition must not animate the previous reply before its row lands.
        let starting = activity(.thinking, turn: "current", reply: nil)
        #expect(activeAssistantAvatar(in: [previous], activity: starting) == nil)
        let preToken = activeAssistantAvatar(in: [previous, thinking], activity: starting)
        #expect(preToken?.index == 1)
        #expect(preToken?.state == .thinking)

        let responding = activity(.responding, turn: "current", reply: "current-reply")
        #expect(activeAssistantAvatar(in: [previous, thinking], activity: responding) == nil)
        #expect(activeAssistantAvatar(in: [previous, streaming], activity: responding)?.state == .responding)
        #expect(activeAssistantAvatar(in: [previous, committed], activity: responding)?.state == .responding)
        #expect(activeAssistantAvatar(in: [previous, committed], activity: activity(.idle)) == nil)
    }

    @Test func staleSpeechCutoffAndMissingIdentityNeverAnimateHistoricalRows() {
        let old = message(turn: "old", reply: "old-reply")
        let latest = message(turn: "current", reply: "current-reply")
        #expect(activeAssistantAvatar(
            in: [old, latest], activity: activity(.responding, turn: "old", reply: "old-reply")
        ) == nil)
        #expect(activeAssistantAvatar(
            in: [latest], activity: activity(.thinking, turn: "current", reply: nil)
        ) == nil)
        #expect(activeAssistantAvatar(
            in: [latest], activity: activity(.responding, turn: "other", reply: "current-reply")
        ) == nil)
        #expect(activeAssistantAvatar(in: [latest], activity: activity(.responding)) == nil)
        #expect(activeAssistantAvatar(
            in: [message(turn: "current", reply: "current-reply", cutoff: "interrupt")],
            activity: activity(.responding, turn: "current", reply: "current-reply")
        ) == nil)
    }

    @MainActor @Test func activeAvatarPausesAboveViewportAndResumesWhenScrolledBack() async throws {
        let longReply = Array(repeating: "Long active reply keeps its bubble body in the viewport.", count: 80)
            .joined(separator: "\n\n")
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 733)
        let host = UIHostingController(rootView: ScrollView {
            MessageBubbleShell(
                role: .assistant, name: "Sentient", timestamp: 1_700_000_000_000,
                isStreaming: false, cutoffLabel: nil, index: 0, total: 1,
                continuation: false, avatarMode: .responding
            ) {
                Text(longReply)
            }
            .padding()
        }
        .environment(\.scenePhase, .active))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        func descendants(_ view: UIView) -> [UIView] {
            [view] + view.subviews.flatMap(descendants)
        }
        func verify(_ condition: () -> Bool, _ failure: String) async throws {
            var stableFrames = 0
            for _ in 0..<60 {
                host.view.setNeedsLayout()
                host.view.layoutIfNeeded()
                try await DisplayFrameWaiter.next()
                if condition() {
                    stableFrames += 1
                    if stableFrames == 3 { return }
                } else {
                    stableFrames = 0
                }
            }
            Issue.record(Comment(rawValue: failure))
        }

        try await verify({
            let views = descendants(host.view)
            guard let scroll = views.compactMap({ $0 as? UIScrollView }).first else { return false }
            return views.contains { $0 is RiveView } && scroll.contentSize.height > scroll.bounds.height * 2
        }, "Long active bubble did not mount with scrollable content")

        let scroll = try #require(descendants(host.view).compactMap { $0 as? UIScrollView }.first)
        scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
        try await verify({
            let views = descendants(host.view)
            guard let rive = views.compactMap({ $0 as? RiveView }).first,
                  let player = rive.playerDelegate as? RiveViewModel
            else { return false }
            return rive.convert(rive.bounds, to: scroll).intersects(
                CGRect(origin: scroll.contentOffset, size: scroll.bounds.size)
            ) && player.isPlaying
        }, "Active avatar did not play at top of its visible bubble")

        let rive = try #require(descendants(host.view).compactMap { $0 as? RiveView }.first)
        let avatarFrame = rive.convert(rive.bounds, to: scroll)
        let maximumOffset = scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom
        let offscreenOffset = min(maximumOffset, avatarFrame.maxY + 60)
        #expect(offscreenOffset < maximumOffset)
        scroll.setContentOffset(CGPoint(x: 0, y: offscreenOffset), animated: false)
        try await verify({
            guard let player = rive.playerDelegate as? RiveViewModel else { return false }
            let visibleBounds = CGRect(origin: scroll.contentOffset, size: scroll.bounds.size)
            return avatarFrame.maxY < visibleBounds.minY && !player.isPlaying
        }, "Active avatar did not pause above viewport while its long bubble remained visible")

        scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
        try await verify({
            guard let player = rive.playerDelegate as? RiveViewModel else { return false }
            return rive.convert(rive.bounds, to: scroll).intersects(
                CGRect(origin: scroll.contentOffset, size: scroll.bounds.size)
            ) && player.isPlaying
        }, "Active avatar did not resume after scrolling back into view")
    }

    @MainActor @Test func reducedMotionEntersAuthoredStaticStatesBeforePlaybackStops() throws {
        for (state, expectedAuthoredState) in [
            (SentientIdentityState.thinking, "reduced_thinking"),
            (.responding, "reduced_responding"),
        ] {
            let model = RiveIdentityModel(initialState: .idle, autoPlay: false)
            let viewModel = try #require(model.riveViewModel)
            let view = viewModel.createRiveView()
            let observer = IdentityStateObserver(isPlaying: { viewModel.isPlaying })
            view.stateMachineDelegate = observer

            model.controller.setRenderingActive(true)
            observer.transitions.removeAll()
            model.controller.synchronize(state: state, reducedMotion: true)

            #expect(model.controller.state == state)
            #expect(model.controller.reducedMotion)
            #expect(observer.transitions.contains { $0.state == expectedAuthoredState && $0.wasPlaying })
            #expect(!viewModel.isPlaying)
        }
    }

    @MainActor @Test func nativeChatHasNoIdleRuntimeAndOnlyOneEligibleActiveAvatar() async throws {
        let messages = [message(turn: "old", reply: "old-reply"), message(turn: "current", reply: "current-reply")]
        let idle = activity(.idle)
        let responding = activity(.responding, turn: "current", reply: "current-reply")
        let content = { (activity: AssistantActivityState, covered: Bool) in
            VStack(spacing: 0) {
                ChatTitleBar(onOpenPanel: {}, onOpenInbox: {}, onNewChat: {})
                MessageList(messages: messages, assistantActivity: activity)
            }
            .environment(\.scenePhase, .active)
            .environment(\.sentientIdentityPlaybackEnabled, !covered)
        }
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 733)
        let host = UIHostingController(rootView: content(idle, false))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        func riveViews(_ view: UIView) -> [RiveView] {
            (view as? RiveView).map { [$0] } ?? view.subviews.flatMap(riveViews)
        }
        func verify(_ count: Int, playing: Bool = false) async throws {
            var stableFrames = 0
            for _ in 0..<30 {
                host.view.setNeedsLayout()
                host.view.layoutIfNeeded()
                try await DisplayFrameWaiter.next()
                let views = riveViews(host.view)
                if views.count == count && views.allSatisfy({
                    ($0.playerDelegate as? RiveViewModel)?.isPlaying == playing
                }) {
                    stableFrames += 1
                    if stableFrames == 3 { return }
                } else {
                    stableFrames = 0
                }
            }
            Issue.record("Native chat did not reach expected avatar count/playback state")
        }

        try await verify(0)
        // Consecutive assistant replies group metadata, but must not hide the
        // one ongoing avatar merely because it is a continuation row.
        host.rootView = content(responding, false)
        try await verify(1, playing: true)
        host.rootView = content(responding, true)
        try await verify(1, playing: false)
        host.rootView = content(responding, false)
        try await verify(1, playing: true)
        host.rootView = content(activity(.responding, turn: "old", reply: "old-reply"), false)
        try await verify(0)
        host.rootView = content(idle, false)
        try await verify(0)
    }

    private func activity(
        _ phase: AssistantActivityPhase, turn: String? = nil, reply: String? = nil
    ) -> AssistantActivityState {
        AssistantActivityState(phase: phase, turnId: turn, replyId: reply)
    }

    private func message(
        turn: String, reply: String?, streaming: Bool = false, cutoff: String? = nil,
        content: String = "reply"
    ) -> ChatMessage {
        ChatMessage(
            ts: 1_700_000_000_000, role: "assistant", content: streaming ? "" : content,
            streaming: streaming, cutoffKind: cutoff, turnId: turn, replyId: reply,
            pendingId: nil, entryId: reply ?? "live-\(turn)"
        )
    }
}

@MainActor
private final class IdentityStateObserver: NSObject, @preconcurrency RiveStateMachineDelegate {
    var transitions: [(state: String, wasPlaying: Bool)] = []
    private let isPlaying: () -> Bool

    init(isPlaying: @escaping () -> Bool) {
        self.isPlaying = isPlaying
    }

    func stateMachine(_ stateMachine: RiveStateMachineInstance, didChangeState stateName: String) {
        transitions.append((stateName, isPlaying()))
    }
}

@MainActor
final class DisplayFrameWaiter: NSObject {
    private var continuation: CheckedContinuation<Void, Error>?
    private var displayLink: CADisplayLink?

    static func next() async throws {
        try await withCheckedThrowingContinuation { continuation in
            let waiter = DisplayFrameWaiter()
            waiter.continuation = continuation
            let displayLink = CADisplayLink(target: waiter, selector: #selector(waiter.frameDidRender))
            waiter.displayLink = displayLink
            displayLink.add(to: .main, forMode: .common)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                waiter.finish(error: AvatarFrameWaitError.frameUnavailable)
            }
        }
    }

    @objc private func frameDidRender() { finish(error: nil) }

    private func finish(error: Error?) {
        guard let continuation else { return }
        self.continuation = nil
        displayLink?.invalidate()
        displayLink = nil
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
    }
}

private enum AvatarFrameWaitError: Error { case frameUnavailable }
