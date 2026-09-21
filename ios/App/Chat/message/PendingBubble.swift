// ---------------------------------------------------------------------------
// PendingBubble — optimistic user-side bubble while the outbox entry is in
// QUEUED or FAILED state. There is NO "sent" state: the bubble is reconciled
// AWAY (cache.remove) on its committed echo, never promoted to a "✓ sent" chip.
//
// MessageBubbleShell owns the shared user-row geometry, avatar, material,
// metadata, width, and accessibility. This view supplies only plain-text
// outbox content and its retry/status footer.
//
// accessibilityIdentifiers: msg-status-queued / msg-status-failed — mirrors
// Android testTags.
// ---------------------------------------------------------------------------
import SwiftUI
import UIKit
import MobileData

struct PendingBubble: View {
    let msg: PendingMessage
    var userName: String = "You"
    var attachments: [NativeDraftAttachment] = []
    var attachmentPreviews: [String: UIImage] = [:]
    var attachmentTransfers: [String: AttachmentTransferState] = [:]
    var onPreviewAttachment: (String) -> Void = { _ in }
    var onRetryAttachment: (String) -> Void = { _ in }
    var onRetry: () -> Void = {}
    var measurement = false
    /// Chronology position is supplied by MessageList; defaults keep direct
    /// previews and existing internal callers source-compatible.
    var index: Int = 0
    var total: Int = 1

    var body: some View {
        MessageBubbleShell(
            role: .user,
            name: userName,
            timestamp: nil,
            isStreaming: false,
            cutoffLabel: nil,
            index: index,
            total: total,
            continuation: false,
            avatarMode: .idle,
            metadataMuted: true
        ) {
            VStack(alignment: .leading, spacing: Space.sm) {
                if measurement {
                    Text(msg.text)
                        .font(Typo.ui(TypeScale.base))
                        .foregroundStyle(DuskColors.ink)
                        .textSelection(.enabled)
                } else {
                    SelectablePlainText(text: msg.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if attachments.isEmpty, !msg.attachmentIds.isEmpty {
                    Text("\(msg.attachmentIds.count) attachment\(msg.attachmentIds.count == 1 ? "" : "s")")
                        .font(Typo.ui(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink3)
                        .textSelection(.enabled)
                }
                ForEach(attachments, id: \.id) { attachment in
                    PendingAttachmentSummary(
                        attachment: attachment,
                        preview: attachmentPreviews[attachment.id],
                        transfer: attachmentTransfers[attachment.id],
                        onPreview: { onPreviewAttachment(attachment.id) },
                        onRetry: { onRetryAttachment(attachment.id) }
                    )
                }
            }
        } footer: {
            statusChip
        }
    }

    // ── Status chip ──────────────────────────────────────────────────────────

    @ViewBuilder
    private var statusChip: some View {
        if msg.status == .queued {
            chipLabel("Sending…", color: DuskColors.ink3)
                .accessibilityIdentifier("msg-status-queued")
        } else {
            // FAILED — tappable retry chip.
            Button(action: onRetry) {
                chipLabel("↺ Retry", color: DuskColors.stop)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("msg-status-failed")
        }
    }

    private func chipLabel(_ text: String, color: Color) -> some View {
        Text(text)
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(color)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 2)
            .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct PendingAttachmentSummary: View {
    let attachment: NativeDraftAttachment
    let preview: UIImage?
    let transfer: AttachmentTransferState?
    let onPreview: () -> Void
    let onRetry: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: Space.sm) {
            Button(action: onPreview) {
                HStack(alignment: .center, spacing: Space.sm) {
                    if let preview {
                        Image(uiImage: preview)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 44, height: 44)
                            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    } else {
                        Image(systemName: attachment.mediaType.hasPrefix("image/") ? "photo" : "doc.text")
                            .foregroundStyle(DuskColors.accent)
                            .frame(width: 44, height: 44)
                            .background(DuskColors.bgSunk, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(attachment.displayName)
                            .font(Typo.ui(TypeScale.sm, .semibold))
                            .foregroundStyle(DuskColors.ink)
                            .lineLimit(2)
                            .textSelection(.enabled)
                        Text("\(attachment.mediaType.uppercased()) · \(ByteCountFormatter.string(fromByteCount: attachment.sizeBytes, countStyle: .file))")
                            .font(Typo.ui(TypeScale.xs))
                            .foregroundStyle(DuskColors.ink3)
                            .lineLimit(1)
                            .textSelection(.enabled)
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open attachment \(attachment.displayName)")
            .accessibilityIdentifier("pending-attachment-\(attachment.id)")
            transferStatus
        }
    }

    @ViewBuilder
    private var transferStatus: some View {
        switch transfer?.phase {
        case .uploading:
            Text("Uploading")
                .font(Typo.ui(TypeScale.xs))
                .foregroundStyle(DuskColors.ink3)
        case .failed:
            Button("Retry upload", action: onRetry)
                .font(Typo.ui(TypeScale.xs, .semibold))
                .foregroundStyle(DuskColors.stop)
                .buttonStyle(.plain)
                .accessibilityIdentifier("pending-attachment-retry-\(attachment.id)")
        case .cancelled:
            Text("Upload cancelled")
                .font(Typo.ui(TypeScale.xs))
                .foregroundStyle(DuskColors.ink3)
        case .ready, nil:
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
