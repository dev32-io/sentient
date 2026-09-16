import MobileData
import NetworkImage
import SwiftUI
import UIKit

/// Recycled native chat history. Loaded rows are measured with their real SwiftUI
/// renderer before exact geometry is published to UICollectionView.
struct MessageList: View {
    let messages: [ChatMessage]
    var assistantActivity = AssistantActivityState(phase: .idle, turnId: nil, replyId: nil)
    var userName: String = "You"
    var pending: [PendingMessage] = []
    var onRetry: (String) -> Void = { _ in }
    var historyLoading = false
    /// `true` for a routed existing session, `false` for a new conversation.
    /// `nil` preserves legacy direct-call inference for previews and fixtures.
    var initialExistingHistory: Bool? = nil
    var imageLoader: any NetworkImageLoader = DefaultNetworkImageLoader.shared
    var positionScheduler: MessagePositionScheduler = { DispatchQueue.main.async(execute: $0) }
    var onMeasurementLoadingChange: (Bool) -> Void = { _ in }

    @Environment(\.sentientIdentityPlaybackEnabled) private var playbackEnabled
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale
    @Environment(\.layoutDirection) private var layoutDirection

    private static let placeholder = "Start a conversation\u{2026}"

    var body: some View {
        let chronology = messageChronology(messages: messages, pending: pending)
        return ZStack {
            MessageCollectionView(
                rows: layoutRows(for: chronology),
                messageCount: chronology.messageCount,
                userName: userName,
                historyLoading: historyLoading,
                initialExistingHistory: initialExistingHistory,
                playbackEnabled: playbackEnabled,
                environmentRevision: "\(dynamicTypeSize)|\(locale.identifier)|\(layoutDirection)",
                imageLoader: imageLoader,
                positionScheduler: positionScheduler,
                onRetry: onRetry,
                onMeasurementLoadingChange: onMeasurementLoadingChange
            )
            if messages.isEmpty && pending.isEmpty { emptyState.allowsHitTesting(false) }
        }
    }

    private func layoutRows(for chronology: MessageChronology) -> [MessageLayoutRow] {
        let activeAvatar = activeAssistantAvatar(in: messages, activity: assistantActivity)
        return chronology.rows.map { row in
            let mode: SentientIdentityState
            if case let .message(_, index, _) = row, index == activeAvatar?.index {
                mode = activeAvatar?.state ?? .idle
            } else {
                mode = .idle
            }
            return MessageLayoutRow(row: row, avatarMode: mode)
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
        .contentShape(Rectangle())
        .onTapGesture {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
            )
        }
    }
}

/// Viewport-derived bubble cap shared by displayed and measured rows.
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
    MessageList(messages: [
        ChatMessage(ts: now, role: "user", content: "hello", streaming: false, cutoffKind: nil, turnId: nil, replyId: nil, pendingId: nil, entryId: "preview-u0"),
        ChatMessage(ts: now + 1, role: "assistant", content: "Hi! How can I help today?", streaming: false, cutoffKind: nil, turnId: nil, replyId: "preview-a1", pendingId: nil, entryId: "preview-a1"),
    ], userName: "Alice")
    .background(DuskColors.bg)
}
