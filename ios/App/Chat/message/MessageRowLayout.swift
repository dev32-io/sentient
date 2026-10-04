import MobileData
import SwiftUI
import UIKit

/// Geometry emitted by mounted row content. Revision and width fence reports to
/// the collection coordinator; rendering implementation stays below this boundary.
struct MessageRowGeometry: Equatable {
    enum Quality: Equatable {
        case estimated
        case rendered
    }

    let revision: String
    let width: CGFloat
    let height: CGFloat
    let quality: Quality
}

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
    var onEditPendingAttachment: (String, String) -> Void = { _, _ in }
    var onCancelPendingAttachment: (String, String) -> Void = { _, _ in }
    var heightRevision = ""
    var rendererState: MessageDocumentState?
    var selectionViewportInWindow: (() -> CGRect)?
    var requestSelectionScroll: ((CGFloat) -> CGFloat)?
    var onSelectionBegin: (() -> Void)?
    var onGeometryChange: ((MessageRowGeometry) -> Void)?
    // Render readiness is scoped to current content revision; queued old reports stay estimated.
    @State private var renderedHeightRevision: String?

    private var bubbleMaxWidth: CGFloat {
        let margins = BubbleLayout.rowMargin(width: paneWidth) * 2 + BubbleLayout.edgeMin
        return min(Space.msgMax, max(0, paneWidth - margins))
    }

    var body: some View {
        content
            .environment(\.bubbleMaxWidth, bubbleMaxWidth)
            .environment(\.sentientIdentityPlaybackEnabled, avatarPlaybackEnabled)
            .environment(\.sentientIdentityMeasurement, measurement)
            .padding(.horizontal, BubbleLayout.rowMargin(width: paneWidth))
            .frame(width: paneWidth, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .background {
                if let onGeometryChange {
                    GeometryReader { proxy in
                        Color.clear
                            .onChange(of: heightRevision, initial: true) { _, _ in
                                renderedHeightRevision = nil
                                onGeometryChange(MessageRowGeometry(
                                    revision: heightRevision,
                                    width: proxy.size.width,
                                    height: proxy.size.height,
                                    quality: .estimated
                                ))
                            }
                            .onChange(of: proxy.size.height) { _, height in
                                guard renderedHeightRevision == heightRevision else {
                                    onGeometryChange(MessageRowGeometry(
                                        revision: heightRevision,
                                        width: proxy.size.width,
                                        height: height,
                                        quality: .estimated
                                    ))
                                    return
                                }
                                let revision = heightRevision
                                DispatchQueue.main.async {
                                    guard renderedHeightRevision == revision else { return }
                                    onGeometryChange(MessageRowGeometry(
                                        revision: revision,
                                        width: proxy.size.width,
                                        height: height,
                                        quality: .rendered
                                    ))
                                }
                            }
                            .onChange(of: renderedHeightRevision) { _, revision in
                                guard let revision, revision == heightRevision else { return }
                                DispatchQueue.main.async {
                                    guard renderedHeightRevision == revision else { return }
                                    onGeometryChange(MessageRowGeometry(
                                        revision: revision,
                                        width: proxy.size.width,
                                        height: proxy.size.height,
                                        quality: .rendered
                                    ))
                                }
                            }
                    }
                }
            }
    }

    private var outgoing: (pending: PendingMessage?, committed: ChatMessage?, index: Int, continuation: Bool)? {
        switch row {
        case let .pending(message, index): return (message, nil, index, false)
        case let .message(message, index, continuation) where message.role == "user":
            return (nil, message, index, continuation)
        default: return nil
        }
    }

    @ViewBuilder
    private var content: some View {
        if let outgoing {
            PendingBubble(
                msg: outgoing.pending,
                committedMessage: outgoing.committed,
                userName: userName,
                attachments: pendingAttachments,
                attachmentPreviews: outgoing.committed == nil ? pendingAttachmentPreviews : attachmentPreviews,
                attachmentPreviewFailures: attachmentPreviewFailures,
                attachmentTransfers: pendingAttachmentTransfers,
                onPreviewAttachment: onPreviewAttachment,
                onRetryAttachment: onRetryAttachmentUpload,
                onEditAttachment: { fileId in
                    if let message = outgoing.pending { onEditPendingAttachment(message.id, fileId) }
                },
                onCancelAttachment: { fileId in
                    if let message = outgoing.pending { onCancelPendingAttachment(message.id, fileId) }
                },
                onRetry: { if let message = outgoing.pending { onRetry(message.id) } },
                onRenderedHeightStateChange: measurement ? nil : { [heightRevision] ready in
                    renderedHeightRevision = ready ? heightRevision : nil
                },
                measurement: measurement,
                rendererState: rendererState,
                imageCache: imageCache,
                selectionViewportInWindow: selectionViewportInWindow,
                requestSelectionScroll: requestSelectionScroll,
                onSelectionBegin: onSelectionBegin,
                index: outgoing.index,
                total: messageCount
            )
            .padding(.top, outgoing.continuation ? BubbleLayout.continuationPullup(width: paneWidth) : BubbleLayout.standardOffset)
        } else {
            switch row {
            case let .divider(label, _):
                DayDivider(label: label)
            case let .message(message, index, continuation):
                MessageBubble(
                    message: message,
                    index: index,
                    total: messageCount,
                    avatarMode: avatarMode,
                    userName: userName,
                    attachmentPreviews: attachmentPreviews,
                    attachmentPreviewFailures: attachmentPreviewFailures,
                    onPreviewAttachment: onPreviewAttachment,
                    imageCache: imageCache,
                    rendererState: rendererState,
                    selectionViewportInWindow: selectionViewportInWindow,
                    requestSelectionScroll: requestSelectionScroll,
                    onSelectionBegin: onSelectionBegin,
                    onRenderedHeightStateChange: measurement ? nil : { [heightRevision] ready in
                        renderedHeightRevision = ready ? heightRevision : nil
                    }
                )
                .padding(.top, continuation ? BubbleLayout.continuationPullup(width: paneWidth) : BubbleLayout.standardOffset)
            case .pending:
                EmptyView() // All outgoing rows use the stable subtree above.
            }
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
            let progressRevision = pendingAttachments.map {
                "\($0.id):\(pendingAttachmentTransfers[$0.id]?.progress ?? 0)"
            }.joined(separator: ",")
            revision = [measurementRevision, progressRevision, message.id, String(describing: message.sentAtMs), String(index)]
                .joined(separator: "|")
            accessibilityIdentifier = "chat-user-row-\(message.id)"
        }
    }
}
