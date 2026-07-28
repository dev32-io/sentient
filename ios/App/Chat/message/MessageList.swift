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
// Pending rows: optimistic outbox entries appended AFTER committed history.
// Each pending message shows a status chip (QUEUED / SENT / FAILED); FAILED
// is tappable → onRetry(pendingId). Mirrors Android MessageList pending param.
//
// iOS 18+: onScrollGeometryChange drives the pin FSM precisely.
// iOS 17:  always-follow fallback (prior behavior) — no geometry API available.
//
// accessibilityIdentifier `chat-message-list` scopes the e2e bubble assertions.
// ---------------------------------------------------------------------------
import SwiftUI
import UIKit
import MobileData

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
    /// Optimistic pending outbox entries appended after committed history.
    /// Each row shows a status chip (QUEUED/SENT/FAILED). FAILED is tappable.
    var pending: [PendingMessage] = []
    /// Called when the user taps the FAILED chip — re-queues by pendingId.
    var onRetry: (String) -> Void = { _ in }
    /// True while an existing-session switch is fetching its snapshot. The falling
    /// edge (snapshot landed) drives a reliable bottom-snap — a batch snapshot into
    /// a LazyVStack otherwise races `scrollTo` and sometimes lands short.
    var historyLoading: Bool = false

    /// Pin-to-bottom FSM state. iOS 18+ only; ignored on iOS 17 (always-follow).
    @State private var follow = FollowLatestState()

    private static let placeholder = "Start a conversation\u{2026}"
    private static let bottomAnchor = "chat-bottom-anchor"

    var body: some View {
        // GeometryReader reads the live pane width so each bubble can be capped at
        // the smaller of the design `msgMax` and the viewport — see bubbleMaxWidth.
        GeometryReader { geo in
            Group {
                if messages.isEmpty && pending.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            // Tap anywhere on the conversation dismisses the keyboard (ChatGPT/Claude
            // style); contentShape makes the empty-state whitespace tappable too.
            // simultaneousGesture (not onTapGesture) so a tap on a markdown link still
            // opens the link AND dismisses the keyboard — a container onTapGesture would
            // swallow the link's own tap. Swipe-down dismissal is handled by
            // .scrollDismissesKeyboard on the list.
            .contentShape(Rectangle())
            .simultaneousGesture(TapGesture().onEnded { dismissKeyboard() })
            .environment(\.bubbleMaxWidth, bubbleMaxWidth(paneWidth: geo.size.width))
        }
    }

    /// Bubble width cap: the smaller of the design `msgMax` and the live pane width
    /// minus the avatar column + row paddings. Capping at the viewport stops a
    /// non-wrapping tool-pill strip from dragging the bubble off the screen edge.
    private func bubbleMaxWidth(paneWidth: CGFloat) -> CGFloat {
        let chrome = Space.lg * 2 + BubbleLayout.avatarSize + Space.md + BubbleLayout.edgeMin
        return min(Space.msgMax, max(0, paneWidth - chrome))
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
                // Snapshot just landed (switch / reconnect-resume) → land at the tail.
                // Deferred a runloop tick so the LazyVStack measures the new rows first.
                .onChange(of: historyLoading) { _, loading in
                    if !loading { DispatchQueue.main.async { scrollToBottom(proxy, animated: false) } }
                }
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
        .onChange(of: pending.count) { _, _ in
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
        .onChange(of: pending.count) { _, _ in scrollToBottom(proxy) }
    }

    private func messageRows() -> some View {
        // The latest assistant bubble carries the live mark animation even after it
        // commits, so the avatar ring persists through the whole thinking+speaking
        // window (the post-commit TTS tail has no streaming bubble).
        let lastAssistant = messages.lastIndex(where: { $0.role == "assistant" })
        return LazyVStack(alignment: .leading, spacing: Space.gapMsg) {
            // ChatRow is Identifiable; divider ids are day-keyed. Message ids are
            // the gateway-owned turnId (assistant) / entryId (committed), so a
            // streaming bubble and its committed twin are the SAME row — the reveal
            // grows in place with no remount. Stable across tokens (turnId never
            // churns), so no ts-based identity flicker. See ChatRow.messageRowId.
            ForEach(chatRows(messages)) { row in
                switch row {
                case let .divider(label, _): DayDivider(label: label)
                case let .message(m, i):
                    MessageBubble(message: m, index: i, avatarMode: avatarMode(for: m, at: i, lastAssistant: lastAssistant), userName: userName)
                }
            }
            // Pending outbox entries: appended AFTER committed history, no day-dividers
            // (they are optimistic/transient). Stable "pending-<id>" identity so
            // SwiftUI doesn't reset local @State on recomposition. Mirrors Android.
            ForEach(pending, id: \.id) { msg in
                PendingBubble(msg: msg, userName: userName, onRetry: { onRetry(msg.id) })
            }
            Color.clear
                .frame(height: 1)
                .id(Self.bottomAnchor)
        }
        .padding(Space.lg)
    }

    /// The assistant avatar animates with the live voice/cognition state while the
    /// bubble is streaming AND — so the ring covers the whole thinking+speaking
    /// window — while it is the LATEST assistant bubble and the active mode is
    /// thinking/speaking (the post-commit TTS tail, which has no streaming bubble).
    /// Mirrors canInterrupt (cognition != idle || isSpeaking). Other committed
    /// bubbles stay static (`.idle`).
    private func avatarMode(for message: ChatMessage, at index: Int, lastAssistant: Int?) -> MarkMode {
        guard message.role == "assistant" else { return .idle }
        if message.streaming { return activeMarkMode }
        if index == lastAssistant, activeMarkMode == .thinking || activeMarkMode == .speaking {
            return activeMarkMode
        }
        return .idle
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

/// Max width for a message bubble, injected by `MessageList` from the live pane
/// width. Defaults to the design `msgMax`; bubbles read it via `@Environment`.
/// This is the iOS analogue of Compose `widthIn(max:)` — SwiftUI's bare
/// `.frame(maxWidth:)` won't clamp a non-wrapping child (the tool-pill strip) to
/// the parent's proposed width, so the cap must be an explicit viewport-derived value.
private struct BubbleMaxWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat = Space.msgMax
}

extension EnvironmentValues {
    var bubbleMaxWidth: CGFloat {
        get { self[BubbleMaxWidthKey.self] }
        set { self[BubbleMaxWidthKey.self] = newValue }
    }
}

#Preview {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    // Yesterday messages trigger a day divider before today's messages.
    let yesterday = now - 86_400_000
    MessageList(messages: [
        ChatMessage(ts: yesterday, role: "user", content: "message from yesterday", streaming: false, cutoffKind: nil, turnId: nil, pendingId: nil, tools: [], entryId: "preview-y0"),
        ChatMessage(ts: now, role: "user", content: "hello", streaming: false, cutoffKind: nil, turnId: nil, pendingId: nil, tools: [], entryId: "preview-u0"),
        ChatMessage(ts: now + 1, role: "assistant", content: "Hi! How can I help today?", streaming: false, cutoffKind: nil, turnId: nil, pendingId: nil, tools: [], entryId: "preview-a1"),
    ], userName: "Alice")
    .background(DuskColors.bg)
}
