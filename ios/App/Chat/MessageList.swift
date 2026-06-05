// ---------------------------------------------------------------------------
// MessageList — the scrolling chat history, mirroring the Android MessageList
// (android/.../chat/MessageList.kt) and the webui MessageList + ChatView
// (gateway/webui/src/components/chat/message-list.tsx, chat-view.tsx).
//
// A ScrollView of MessageBubbles with gapMsg (32pt) between messages.
// Pin-to-bottom autoscroll: while pinned (default, at bottom), the list follows
// new tokens/messages; scrolling up unpins and holds position; re-entering the
// snap zone re-pins. Powered by FollowLatestState + followLatestOnScroll.
//
// iOS 18+: onScrollGeometryChange drives the pin FSM precisely.
// iOS 17:  always-follow fallback (prior behavior) — no geometry API available.
//
// accessibilityIdentifier `chat-message-list` scopes the e2e bubble assertions.
// ---------------------------------------------------------------------------
import SwiftUI
import UIKit
import MobileSdk

/// The scroll dimensions the pin FSM consumes. Projecting the iOS 18
/// `onScrollGeometryChange` to this (rather than the full ScrollGeometry) lets
/// SwiftUI skip frames where none of the three changed.
private struct ScrollProbe: Equatable {
    let top: Double
    let height: Double
    let clientHeight: Double
}

struct MessageList: View {
    let messages: [ChatMessage]
    /// Animation mode for the live (streaming) assistant bubble's avatar.
    /// Committed bubbles stay `.idle` — only the in-flight cycle's mark animates,
    /// mirroring the webui activeCycleMode binding + the Android activeMarkMode.
    var activeMarkMode: MarkMode = .idle
    /// Display name shown in the meta row above user bubbles.
    var userName: String = "You"

    /// Pin-to-bottom FSM state. iOS 18+ only; ignored on iOS 17 (always-follow).
    @State private var follow = FollowLatestState()

    private static let placeholder = "Start a conversation\u{2026}"
    private static let bottomAnchor = "chat-bottom-anchor"

    var body: some View {
        Group {
            if messages.isEmpty {
                emptyState
            } else {
                list
            }
        }
        // Tap anywhere on the conversation dismisses the keyboard (ChatGPT/Claude
        // style); contentShape makes the empty-state whitespace tappable too.
        // simultaneousGesture (not onTapGesture) so a tap on a markdown link still
        // opens the link AND dismisses the keyboard — a container onTapGesture would
        // swallow the link's own tap. Swipe-down dismissal is handled by
        // .scrollDismissesKeyboard on the list.
        .contentShape(Rectangle())
        .simultaneousGesture(TapGesture().onEnded { dismissKeyboard() })
    }

    /// Resign the first responder so the soft keyboard retracts. iOS has no
    /// system "hide keyboard" affordance (Android's IME bar does); we broadcast
    /// resignFirstResponder rather than thread @FocusState out of the Composer.
    private func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
        )
    }

    private var list: some View {
        ScrollViewReader { proxy in
            scrollContent(proxy: proxy)
                .scrollDismissesKeyboard(.interactively)
                .accessibilityIdentifier("chat-message-list")
                .onAppear { scrollToBottom(proxy, animated: false) }
        }
    }

    @ViewBuilder
    private func scrollContent(proxy: ScrollViewProxy) -> some View {
        if #available(iOS 18, *) {
            ios18ScrollView(proxy: proxy)
        } else {
            ios17ScrollView(proxy: proxy)
        }
    }

    /// iOS 18+: geometry-driven pin FSM. Scrolling up unpins; re-entering the
    /// snap zone re-pins. Auto-scroll fires only while pinned.
    @available(iOS 18, *)
    private func ios18ScrollView(proxy: ScrollViewProxy) -> some View {
        ScrollView {
            messageRows()
        }
        // Project to just the dimensions the pin FSM reads, so SwiftUI dedupes
        // frames where these three are unchanged (a bare `{ $0 }` fires the action
        // on every scroll geometry change, churning @State every frame).
        .onScrollGeometryChange(for: ScrollProbe.self, of: { geo in
            ScrollProbe(
                top: geo.contentOffset.y + geo.contentInsets.top,
                height: geo.contentSize.height,
                clientHeight: geo.containerSize.height
            )
        }) { _, probe in
            follow = followLatestOnScroll(
                follow, top: probe.top, height: probe.height, clientHeight: probe.clientHeight
            )
        }
        .onChange(of: messages.count) { _, _ in
            if follow.pinned { scrollToBottom(proxy) }
        }
        .onChange(of: messages.last?.content) { _, _ in
            if follow.pinned { scrollToBottom(proxy) }
        }
    }

    /// iOS 17 fallback: always-follow (original behavior, no geometry API).
    private func ios17ScrollView(proxy: ScrollViewProxy) -> some View {
        ScrollView {
            messageRows()
        }
        .onChange(of: messages.count) { _, _ in scrollToBottom(proxy) }
        .onChange(of: messages.last?.content) { _, _ in scrollToBottom(proxy) }
    }

    private func messageRows() -> some View {
        LazyVStack(alignment: .leading, spacing: Space.gapMsg) {
            // ChatRow is Identifiable; divider ids are day-keyed, message ids are
            // index-keyed. NOTE: do NOT key on message.ts — the streaming bubble's
            // ts is stamped `clock.nowMs()` fresh on every derive, so a ts-based id
            // would churn the bubble's identity each token and reset the typewriter
            // @State (re-revealing from zero every frame). chatRows() preserves
            // index-only identity for .message rows, keeping this invariant safe.
            ForEach(chatRows(messages)) { row in
                switch row {
                case let .divider(label, _): DayDivider(label: label)
                case let .message(m, i):
                    MessageBubble(message: m, index: i, avatarMode: avatarMode(for: m), userName: userName)
                }
            }
            Color.clear
                .frame(height: 1)
                .id(Self.bottomAnchor)
        }
        .padding(Space.lg)
    }

    /// The live (streaming) assistant bubble's avatar animates with the
    /// voice/cognition state; committed bubbles are static (`.idle`).
    private func avatarMode(for message: ChatMessage) -> MarkMode {
        message.streaming && message.role == "assistant" ? activeMarkMode : .idle
    }

    /// Follow-latest: pin the bottom anchor into view on growth or streaming
    /// token changes. Non-animated on first appear so a restored history lands
    /// at the tail without a scroll animation.
    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        if animated {
            withAnimation(.easeOut(duration: Motion.normal)) {
                proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
        }
    }

    private var emptyState: some View {
        VStack {
            Text(Self.placeholder)
                .font(.system(size: TypeScale.base))
                .foregroundStyle(DuskColors.ink3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Space.xl)
    }
}

#Preview {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    // Yesterday messages trigger a day divider before today's messages.
    let yesterday = now - 86_400_000
    MessageList(messages: [
        ChatMessage(ts: yesterday, role: "user", content: "message from yesterday", streaming: false, cutoffKind: nil, cycleId: nil, tools: []),
        ChatMessage(ts: now, role: "user", content: "hello", streaming: false, cutoffKind: nil, cycleId: nil, tools: []),
        ChatMessage(ts: now + 1, role: "assistant", content: "Hi! How can I help today?", streaming: false, cutoffKind: nil, cycleId: nil, tools: []),
    ], userName: "Alice")
    .background(DuskColors.bg)
}
