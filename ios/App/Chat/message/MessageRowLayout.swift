import MarkdownUI
import MobileData
import SwiftUI

/// Single row renderer used by both collection cells and exact-height measurement.
struct MessageRowLayout: View {
    let row: MessageChronologyRow
    let messageCount: Int
    let paneWidth: CGFloat
    let userName: String
    let avatarMode: SentientIdentityState
    let avatarPlaybackEnabled: Bool
    let measurement: Bool
    let imageCache: MarkdownImageCache
    let onRetry: (String) -> Void
    var heightRevision = ""
    var onHeightChange: ((CGFloat) -> Void)?

    private var bubbleMaxWidth: CGFloat {
        let margins = Space.lg * 2 + BubbleLayout.edgeMin
        return min(Space.msgMax, max(0, paneWidth - margins))
    }

    var body: some View {
        content
            .environment(\.bubbleMaxWidth, bubbleMaxWidth)
            .environment(\.sentientIdentityPlaybackEnabled, avatarPlaybackEnabled)
            .environment(\.sentientIdentityMeasurement, measurement)
            .markdownImageProvider(CachedMarkdownImageProvider(
                cache: imageCache,
                loadsUnresolved: !measurement
            ))
            .padding(.horizontal, Space.lg)
            .frame(width: paneWidth, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .background {
                if let onHeightChange {
                    GeometryReader { proxy in
                        Color.clear
                            .onChange(of: heightRevision, initial: true) { _, _ in onHeightChange(proxy.size.height) }
                            .onChange(of: proxy.size.height) { _, height in onHeightChange(height) }
                    }
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch row {
        case let .divider(label, _):
            DayDivider(label: label)
        case let .message(message, index, continuation):
            MessageBubble(
                message: message,
                index: index,
                total: messageCount,
                continuation: continuation,
                avatarMode: avatarMode,
                userName: userName
            )
            .padding(.top, continuation ? BubbleLayout.continuationPullup : BubbleLayout.standardOffset)
        case let .pending(message, index):
            PendingBubble(
                msg: message,
                userName: userName,
                onRetry: { onRetry(message.id) },
                index: index,
                total: messageCount
            )
        }
    }
}

struct MessageLayoutRow {
    let row: MessageChronologyRow
    let id: String
    let revision: String
    let measurementRevision: String
    let accessibilityIdentifier: String?
    let avatarMode: SentientIdentityState

    init(row: MessageChronologyRow, avatarMode: SentientIdentityState) {
        self.row = row
        id = row.id
        self.avatarMode = avatarMode
        switch row {
        case let .divider(label, id):
            measurementRevision = "divider|\(label)"
            revision = "\(measurementRevision)|\(id)"
            accessibilityIdentifier = nil
        case let .message(message, index, continuation):
            // Identity, chronology labels, and avatar playback change presentation,
            // not layout. Streaming/terminal content and cutoff markers can change it.
            measurementRevision = [
                "message", message.role, message.content, String(message.ts),
                String(message.streaming), message.cutoffKind ?? "", String(continuation),
            ].joined(separator: "|")
            revision = [
                measurementRevision, message.turnId ?? "", message.replyId ?? "",
                message.pendingId ?? "", message.entryId, String(index), String(describing: avatarMode),
            ].joined(separator: "|")
            if message.role == "user" {
                accessibilityIdentifier = "chat-user-row-\(message.pendingId ?? message.entryId)"
            } else {
                accessibilityIdentifier = nil
            }
        case let .pending(message, index):
            measurementRevision = ["pending", message.text, String(describing: message.status)].joined(separator: "|")
            revision = [measurementRevision, message.id, String(describing: message.sentAtMs), String(index)]
                .joined(separator: "|")
            accessibilityIdentifier = "chat-user-row-\(message.id)"
        }
    }
}
