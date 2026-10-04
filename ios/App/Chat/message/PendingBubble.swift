// One outgoing subtree from durable pending snapshot through committed receipt.
// Queue authority stays above this view; only the decorative face fades.
import SwiftUI
import UIKit
import MobileData

struct PendingBubble: View {
    var msg: PendingMessage? = nil
    var committedMessage: ChatMessage? = nil
    var userName: String = "You"
    var attachments: [NativeDraftAttachment] = []
    var attachmentPreviews: [String: UIImage] = [:]
    var attachmentPreviewFailures: Set<String> = []
    var attachmentTransfers: [String: AttachmentTransferState] = [:]
    var onPreviewAttachment: (String) -> Void = { _ in }
    var onRetryAttachment: (String) -> Void = { _ in }
    var onEditAttachment: (String) -> Void = { _ in }
    var onCancelAttachment: (String) -> Void = { _ in }
    var onRetry: () -> Void = {}
    var onRenderedHeightStateChange: ((Bool) -> Void)?
    var measurement = false
    var rendererState: MessageDocumentState?
    var imageCache: MarkdownImageCache?
    var selectionViewportInWindow: (() -> CGRect)?
    var requestSelectionScroll: ((CGFloat) -> CGFloat)?
    var onSelectionBegin: (() -> Void)?
    /// Chronology position is supplied by MessageList; defaults keep direct
    /// previews and existing internal callers source-compatible.
    var index: Int = 0
    var total: Int = 1

    var body: some View {
        MessageBubbleShell(
            role: .user,
            name: userName,
            timestamp: committedMessage?.ts,
            isStreaming: false,
            cutoffLabel: messageCutoffLabel(for: committedMessage?.cutoffKind),
            index: index,
            total: total,
            avatarMode: .idle,
            accessibilityIdentifier: "message-bubble-\(index)",
            pending: committedMessage == nil
        ) {
            VStack(alignment: .leading, spacing: Space.sm) {
                MessageDocumentSurface(
                    source: committedMessage?.content ?? msg?.text ?? "", literal: committedMessage == nil, state: rendererState,
                    imageCache: imageCache,
                    measurement: measurement,
                    selectionViewportInWindow: selectionViewportInWindow,
                    requestSelectionScroll: requestSelectionScroll,
                    onSelectionBegin: onSelectionBegin,
                    onReady: onRenderedHeightStateChange
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                if attachments.isEmpty, committedMessage == nil, let msg, !msg.attachmentIds.isEmpty {
                    Text("\(msg.attachmentIds.count) attachment\(msg.attachmentIds.count == 1 ? "" : "s")")
                        .font(Typo.ui(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink3)
                        .textSelection(.enabled)
                }
                // Frozen order is validated by the upload handoff. Keep preview
                // slots mounted when local ids become authoritative server ids.
                ForEach(0..<(committedMessage?.attachments.count ?? attachments.count), id: \.self) { index in
                    if let file = attachment(at: index) {
                        PendingAttachmentSummary(
                            id: file.id, displayName: file.name, mediaType: file.type, mediaKind: file.kind, sizeBytes: file.size,
                            preview: attachmentPreviews[file.id],
                            previewFailed: attachmentPreviewFailures.contains(file.id),
                            committed: committedMessage != nil,
                            failedMessage: msg?.status == .failed,
                            transfer: committedMessage == nil ? attachmentTransfers[file.id] : nil,
                            onPreview: { onPreviewAttachment(file.id) },
                            onRetry: { onRetryAttachment(file.id) },
                            onEdit: { onEditAttachment(file.id) },
                            onCancel: { onCancelAttachment(file.id) }
                        )
                    }
                }
                if let label = messageCutoffLabel(for: committedMessage?.cutoffKind) {
                    MessageCutoffMarker(label: label, index: index)
                }
            }
        } footer: {
            statusChip
        }
    }

    private func attachment(at index: Int) -> (id: String, name: String, type: String, kind: String?, size: Int64)? {
        if let committedMessage {
            guard committedMessage.attachments.indices.contains(index) else { return nil }
            let file = committedMessage.attachments[index]
            return (file.attachmentId, file.displayName, file.contentType, file.mediaKind, file.size)
        }
        guard attachments.indices.contains(index) else { return nil }
        let file = attachments[index]
        return (file.id, file.displayName, file.mediaType, nil, file.sizeBytes)
    }

    // ── Status chip ──────────────────────────────────────────────────────────

    @ViewBuilder
    private var statusChip: some View {
        if committedMessage != nil {
            EmptyView()
        } else if msg?.status == .queued {
            chipLabel(pendingStatus, color: DuskColors.ink3)
                .accessibilityIdentifier("msg-status-queued")
        } else {
            // FAILED — tappable retry chip.
            Button(action: onRetry) {
                chipLabel("↺ Retry", color: DuskColors.stop, actionable: true)
                    .frame(minHeight: DesignMetrics.minimumTarget)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("msg-status-failed")
        }
    }

    private var pendingStatus: String {
        if attachmentTransfers.values.contains(where: { $0.phase == .uploading }) { return "Uploading attachments…" }
        if attachmentTransfers.values.contains(where: { $0.phase == .queued }) { return "Waiting to upload" }
        return "Sending…"
    }

    private func chipLabel(_ text: String, color: Color, actionable: Bool = false) -> some View {
        Text(text)
            .font(Typo.ui(actionable ? DesignMetrics.controlLabelSize : TypeScale.sm))
            .foregroundStyle(color)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 2)
            .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct PendingAttachmentSummary: View {
    let id: String
    let displayName: String
    let mediaType: String
    let mediaKind: String?
    let sizeBytes: Int64
    let preview: UIImage?
    let previewFailed: Bool
    let committed: Bool
    let failedMessage: Bool
    let transfer: AttachmentTransferState?
    let onPreview: () -> Void
    let onRetry: () -> Void
    let onEdit: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Button(action: onPreview) {
                MessageAttachmentContent(
                    displayName: displayName,
                    detail: "\(mediaKind?.capitalized ?? mediaType.split(separator: "/").last?.capitalized ?? "File") · \(ByteCountFormatter.string(fromByteCount: sizeBytes, countStyle: .file))",
                    isImage: mediaKind == "image" || mediaType.hasPrefix("image/") || mediaType == "application/vnd.sentient.live-photo+zip",
                    iconName: mediaKind == "image" || mediaType.hasPrefix("image/") ? "photo" : mediaKind == "pdf" ? "doc.richtext" : "doc.text",
                    preview: preview,
                    uploadProgress: transfer?.phase == .uploading ? transfer?.progress : nil
                )
                .textSelection(.enabled)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open attachment \(displayName)")
            .accessibilityValue(transfer?.phase == .uploading
                ? "Uploading, \(Int((transfer?.progress ?? 0) * 100)) percent"
                : preview == nil && previewFailed ? "Preview unavailable" : "")
            .accessibilityIdentifier(committed ? "attachment-\(id)" : "pending-attachment-\(id)")
            transferStatus
            if !committed {
                if transfer?.phase == .uploading {
                    DesignTextButton(title: "Cancel upload", accessibilityId: "pending-attachment-cancel-\(id)", action: onCancel)
                        .accessibilityHint("Stops this upload attempt. Does not retract a sent message.")
                } else if failedMessage || transfer?.phase == .failed || transfer?.phase == .cancelled {
                    DesignTextButton(title: "Edit message", accessibilityId: "pending-attachment-edit-\(id)", action: onEdit)
                        .accessibilityHint("Restore queued message only when current draft is empty.")
                }
            }
        }
    }

    @ViewBuilder
    private var transferStatus: some View {
        switch transfer?.phase {
        case .queued:
            Text("Waiting to upload")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
        case .uploading:
            Text("Uploading · \(Int((transfer?.progress ?? 0) * 100))%")
                .font(Typo.ui(TypeScale.sm))
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(DuskColors.ink2)
                .accessibilityIdentifier("pending-attachment-progress-\(id)")
        case .failed:
            DesignTextButton(title: "Retry message upload", accessibilityId: "pending-attachment-retry-\(id)", action: onRetry)
        case .cancelled:
            Text("Upload cancelled")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
        case .ready:
            Text("Uploaded · awaiting message confirmation")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
        case nil:
            EmptyView()
        }
    }
}

#Preview {
    ScrollView {
        VStack(spacing: Space.gapMsg) {
            PendingBubble(msg: PendingMessage(id: "1", text: "Hello, how are you?", status: .queued, sentAtMs: nil), userName: "Alice")
            PendingBubble(msg: PendingMessage(id: "3", text: "This message failed to send.", status: .failed, sentAtMs: nil), userName: "Alice")
        }
        .padding()
    }
    .background(DuskColors.bg)
}
