import MarkdownUI
import MobileData
import SwiftUI
import UIKit

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
    var attachmentPreviews: [String: UIImage] = [:]
    var attachmentPreviewFailures: Set<String> = []
    // Export state remains above recycled rows for revision invalidation; sheet
    // rendering is owned by ChatView.
    var attachmentFiles: [String: URL] = [:]
    var attachmentDownloadFailures: Set<String> = []
    var pendingAttachments: [NativeDraftAttachment] = []
    var pendingAttachmentPreviews: [String: UIImage] = [:]
    var pendingAttachmentTransfers: [String: AttachmentTransferState] = [:]
    let onRetry: (String) -> Void
    var onPreviewAttachment: (String) -> Void = { _ in }
    var onRetryAttachmentUpload: (String) -> Void = { _ in }
    var heightRevision = ""
    var onHeightChange: ((CGFloat) -> Void)?
    var onRenderedHeightChange: ((CGFloat) -> Void)? = nil
    // WebKit readiness is scoped to current content revision; queued old reports stay native.
    @State private var renderedHeightRevision: String?

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
                            .onChange(of: heightRevision, initial: true) { _, _ in
                                renderedHeightRevision = nil
                                onHeightChange(proxy.size.height)
                            }
                            .onChange(of: proxy.size.height) { _, height in
                                guard renderedHeightRevision == heightRevision else {
                                    onHeightChange(height)
                                    return
                                }
                                let revision = heightRevision
                                DispatchQueue.main.async {
                                    guard renderedHeightRevision == revision else { return }
                                    onRenderedHeightChange?(height)
                                }
                            }
                            .onChange(of: renderedHeightRevision) { _, revision in
                                guard let revision, revision == heightRevision else { return }
                                DispatchQueue.main.async {
                                    guard renderedHeightRevision == revision else { return }
                                    onRenderedHeightChange?(proxy.size.height)
                                }
                            }
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
                userName: userName,
                attachmentPreviews: attachmentPreviews,
                attachmentPreviewFailures: attachmentPreviewFailures,
                onPreviewAttachment: onPreviewAttachment,
                imageCache: imageCache,
                onRenderedHeightStateChange: measurement ? nil : { [heightRevision] ready in
                    renderedHeightRevision = ready ? heightRevision : nil
                }
            )
            .padding(.top, continuation ? BubbleLayout.continuationPullup : BubbleLayout.standardOffset)
        case let .pending(message, index):
            PendingBubble(
                msg: message,
                userName: userName,
                attachments: pendingAttachments,
                attachmentPreviews: pendingAttachmentPreviews,
                attachmentTransfers: pendingAttachmentTransfers,
                onPreviewAttachment: onPreviewAttachment,
                onRetryAttachment: onRetryAttachmentUpload,
                onRetry: { onRetry(message.id) },
                measurement: measurement,
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
    let pendingAttachments: [NativeDraftAttachment]
    let pendingAttachmentPreviews: [String: UIImage]
    let pendingAttachmentTransfers: [String: AttachmentTransferState]

    init(
        row: MessageChronologyRow,
        avatarMode: SentientIdentityState,
        attachmentPreviewIds: Set<String> = [],
        attachmentPreviewFailures: Set<String> = [],
        attachmentFiles: [String: URL] = [:],
        attachmentDownloadFailures: Set<String> = [],
        pendingAttachments: [NativeDraftAttachment] = [],
        pendingAttachmentPreviews: [String: UIImage] = [:],
        pendingAttachmentTransfers: [String: AttachmentTransferState] = [:]
    ) {
        self.row = row
        id = row.id
        self.avatarMode = avatarMode
        self.pendingAttachments = pendingAttachments
        self.pendingAttachmentPreviews = pendingAttachmentPreviews
        self.pendingAttachmentTransfers = pendingAttachmentTransfers
        switch row {
        case let .divider(label, id):
            measurementRevision = "divider|\(label)"
            revision = "\(measurementRevision)|\(id)"
            accessibilityIdentifier = nil
        case let .message(message, index, continuation):
            // Attachment availability can change only its owning row's layout and actions.
            let attachmentRevision = message.attachments.map { attachment in
                let id = attachment.attachmentId
                return [
                    "\(id):\(attachment.size)",
                    attachmentPreviewIds.contains(id) ? "preview:available" : "preview:none",
                    attachmentPreviewFailures.contains(id) ? "preview:failed" : "preview:ready",
                    attachmentFiles[id] == nil ? "file:none" : "file:available",
                    attachmentDownloadFailures.contains(id) ? "download:failed" : "download:ready",
                ].joined(separator: ":")
            }.joined(separator: ",")
            // Identity, chronology labels, and avatar playback change presentation,
            // not layout. Streaming/terminal content and cutoff markers can change it.
            measurementRevision = [
                "message", message.role, message.content, String(message.ts),
                String(message.streaming), message.cutoffKind ?? "", String(continuation),
                attachmentRevision,
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
            let pendingAttachmentRevision = pendingAttachments.map { attachment in
                [
                    attachment.id, attachment.displayName, attachment.mediaType, String(attachment.sizeBytes),
                    pendingAttachmentPreviews[attachment.id] == nil ? "preview:none" : "preview:available",
                    String(describing: pendingAttachmentTransfers[attachment.id]?.phase),
                ].joined(separator: ":")
            }.joined(separator: ",")
            measurementRevision = [
                "pending", message.text, String(describing: message.status), pendingAttachmentRevision,
            ].joined(separator: "|")
            revision = [measurementRevision, message.id, String(describing: message.sentAtMs), String(index)]
                .joined(separator: "|")
            accessibilityIdentifier = "chat-user-row-\(message.id)"
        }
    }
}
