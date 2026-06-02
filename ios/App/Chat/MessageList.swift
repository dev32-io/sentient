// ---------------------------------------------------------------------------
// MessageList — the scrolling chat history, mirroring the Android MessageList
// (android/.../chat/MessageList.kt) and the webui MessageList + ChatView
// (gateway/webui/src/components/chat/message-list.tsx, chat-view.tsx).
//
// A ScrollView of MessageBubbles with gapMsg (32pt) between messages. Auto-
// scrolls to the latest message whenever the list grows OR the last bubble's
// content changes (streaming tokens) — ScrollViewReader.scrollTo keyed on
// count + tail content, mirroring the webui useFollowLatest hook. Empty state
// shows the "Start a conversation…" placeholder. The list owns no state beyond
// its scroll position — it reads SdkState.messages, passed down.
//
// accessibilityIdentifier `chat-message-list` scopes the e2e bubble assertions.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

struct MessageList: View {
    let messages: [ChatMessage]

    private static let placeholder = "Start a conversation…"
    private static let bottomAnchor = "chat-bottom-anchor"

    var body: some View {
        if messages.isEmpty {
            emptyState
        } else {
            list
        }
    }

    private var list: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.gapMsg) {
                    ForEach(Array(messages.enumerated()), id: \.offset) { index, message in
                        MessageBubble(message: message, index: index)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchor)
                }
                .padding(Space.lg)
            }
            .accessibilityIdentifier("chat-message-list")
            .onChange(of: messages.count) { scrollToBottom(proxy) }
            .onChange(of: messages.last?.content) { scrollToBottom(proxy) }
            .onAppear { scrollToBottom(proxy, animated: false) }
        }
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
    return MessageList(messages: [
        ChatMessage(ts: now, role: "user", content: "hello", streaming: false, cutoffKind: nil),
        ChatMessage(ts: now + 1, role: "assistant", content: "Hi! How can I help today?", streaming: false, cutoffKind: nil),
    ])
    .background(DuskColors.bg)
}
