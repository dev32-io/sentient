// MessageBubble — the committed/live message content composite.
//
// MessageBubble owns role-specific content only. MessageBubbleShell owns the
// shared row geometry, avatar, material, metadata, grouping, and accessibility
// contract used by both committed and pending user bubbles.
//
// Layout and behavior remain the established chat contract:
//  - assistant content uses the Sentient mark on the leading edge and paper;
//  - user content uses the user avatar on the trailing edge and sage-mixed paper;
//  - streaming assistant content shows the thinking pulse until revealed text
//    arrives, then renders the data-layer substring directly;
//  - committed content remains GFM Markdown with the Dusk theme and cutoff
//    markers.
import Foundation
import SwiftUI
import MarkdownUI
import MobileData

struct MessageBubble: View {
    let message: ChatMessage
    let index: Int
    var total: Int = 1
    var continuation = false
    /// Avatar animation mode — only the live streaming assistant bubble animates;
    /// committed bubbles pass `.idle`, mirroring the Android avatarMode.
    var avatarMode: SentientIdentityState = .idle
    /// Display name shown in the meta row above the bubble.
    var userName: String = "You"
    var attachmentPreviews: [String: UIImage] = [:]
    var attachmentPreviewFailures: Set<String> = []
    var onPreviewAttachment: (String) -> Void = { _ in }
    var imageCache: MarkdownImageCache?
    var onRenderedHeightStateChange: ((Bool) -> Void)?

    @Environment(\.sentientIdentityMeasurement) private var measurement
    @Environment(\.bubbleMaxWidth) private var bubbleMaxWidth

    private var isUser: Bool { message.role == "user" }

    var body: some View {
        MessageBubbleShell(
            role: isUser ? .user : .assistant,
            name: isUser ? userName : "Sentient",
            timestamp: message.ts,
            isStreaming: message.streaming,
            cutoffLabel: messageCutoffLabel(for: message.cutoffKind),
            index: index,
            total: total,
            continuation: continuation,
            avatarMode: avatarMode,
            accessibilityIdentifier: isUser ? "message-bubble-\(index)" : "assistant-bubble"
        ) {
            bubbleContent
        }
    }

    @ViewBuilder
    private var bubbleContent: some View {
        // One layout for all phases: pulse while still thinking → revealed
        // text → committed markdown. Tool rows no longer render here — they
        // moved to the composer's task strip, which has no bubble to anchor to
        // (a mid-turn steer can split one turn's rows across bubbles with no
        // stable owner).
        if message.streaming && message.content.isEmpty {
            PulseDots()
        } else if message.streaming {
            StreamingText(content: message.content)
        } else {
            committedText
        }
    }

    private var committedText: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            if !message.content.isEmpty {
                if measurement {
                    nativeMarkdown
                } else {
                    SelectableMarkdownSurface(
                        markdown: message.content,
                        width: max(1, bubbleMaxWidth - Space.md * 2),
                        imageCache: imageCache,
                        onHeightChange: nil,
                        onLoadStateChange: onRenderedHeightStateChange
                    ) {
                        nativeMarkdown
                    }
                }
            }
            ForEach(message.attachments, id: \.attachmentId) { attachment in
                MessageAttachmentCard(
                    attachment: attachment,
                    preview: attachmentPreviews[attachment.attachmentId],
                    previewFailed: attachmentPreviewFailures.contains(attachment.attachmentId),
                    onPreview: { onPreviewAttachment(attachment.attachmentId) }
                )
            }
            if messageCutoffLabel(for: message.cutoffKind) != nil {
                interruptedMarker
            }
        }
    }

    private var nativeMarkdown: some View {
        Markdown(message.content)
            .markdownTheme(.dusk)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var interruptedMarker: some View {
        Label(messageCutoffLabel(for: message.cutoffKind) ?? "", systemImage: "stop.circle")
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.ink3)
            .accessibilityIdentifier("message-cutoff-\(index)")
    }
}

struct AttachmentPreviewSelection: Identifiable, Equatable {
    let id: String
    let displayName: String
    let contentType: String
    let mediaKind: String
    let size: Int64
    let isLocal: Bool
    let localFile: URL?

    init(_ attachment: AttachmentRef) {
        id = attachment.attachmentId
        displayName = attachment.displayName
        contentType = attachment.contentType
        mediaKind = attachment.mediaKind
        size = attachment.size
        isLocal = false
        localFile = nil
    }

    init(_ attachment: NativeDraftAttachment) {
        id = attachment.id
        displayName = attachment.displayName
        contentType = attachment.mediaType
        mediaKind = attachmentMediaKind(for: attachment.mediaType)
        size = attachment.sizeBytes
        isLocal = true
        localFile = existingOwnedAttachmentURL(attachment.localPath)
    }
}

func attachmentPreviewSelection(
    id: String,
    committed: [AttachmentRef],
    pending: [NativeDraftAttachment]
) -> AttachmentPreviewSelection? {
    if let attachment = pending.first(where: { $0.id == id }) {
        return AttachmentPreviewSelection(attachment)
    }
    return committed.first(where: { $0.attachmentId == id }).map(AttachmentPreviewSelection.init)
}

private func attachmentMediaKind(for mediaType: String) -> String {
    if mediaType.hasPrefix("image/") || mediaType == "application/vnd.sentient.live-photo+zip" {
        return "image"
    }
    if mediaType == "application/pdf" { return "pdf" }
    return "text"
}

private func existingOwnedAttachmentURL(_ path: String) -> URL? {
    guard !path.isEmpty else { return nil }
    let relative = draftAttachmentRelativePath(path)
    let candidate: URL
    if let relative,
       let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
        candidate = support
            .appendingPathComponent("SentientDrafts", isDirectory: true)
            .appendingPathComponent(relative)
    } else {
        candidate = URL(fileURLWithPath: path)
    }
    return validatedOwnedAttachmentURL(candidate)
}

private func validatedOwnedAttachmentURL(_ candidate: URL) -> URL? {
    guard candidate.isFileURL else { return nil }
    let manager = FileManager.default
    let url = candidate.resolvingSymlinksInPath().standardizedFileURL
    var privateRoots = [manager.temporaryDirectory.standardizedFileURL]
    if let support = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
        privateRoots.append(
            support.appendingPathComponent("SentientDrafts", isDirectory: true).standardizedFileURL
        )
    }
    guard privateRoots.contains(where: { url.path.hasPrefix($0.path + "/") }),
          manager.fileExists(atPath: url.path),
          let values = try? url.resourceValues(forKeys: [.isRegularFileKey]),
          values.isRegularFile == true else { return nil }
    return url
}

private func draftAttachmentRelativePath(_ path: String) -> String? {
    let relative: String
    if path.hasPrefix("files/") {
        relative = path
    } else if let range = path.range(of: "/files/", options: .backwards) {
        relative = "files/" + path[range.upperBound...]
    } else {
        return nil
    }
    let components = relative.split(separator: "/")
    guard components.count == 3,
          components[0] == "files",
          UUID(uuidString: String(components[1])) != nil,
          UUID(uuidString: String(components[2])) != nil else { return nil }
    return components.map(String.init).joined(separator: "/")
}

/// Validates one private local file, then prepares filename-preserving ShareLink
/// data off-main. Copied exports own their temporary directory; managed remote
/// downloads may be shared in place when already named correctly.
final class AttachmentExportFile: @unchecked Sendable {
    let url: URL
    private let ownedDirectory: URL?

    private init(url: URL, ownedDirectory: URL?) {
        self.url = url
        self.ownedDirectory = ownedDirectory
    }

    static func prepare(
        source: URL,
        displayName: String,
        reuseExistingFile: Bool = false
    ) async -> AttachmentExportFile? {
        guard !Task.isCancelled else { return nil }
        let worker = Task.detached(priority: .userInitiated) { () -> AttachmentExportFile? in
            guard !Task.isCancelled else { return nil }
            let prepared = make(
                source: source,
                displayName: displayName,
                reuseExistingFile: reuseExistingFile
            )
            guard !Task.isCancelled else { return nil }
            return prepared
        }
        let prepared = await withTaskCancellationHandler {
            await worker.value
        } onCancel: {
            worker.cancel()
        }
        guard !Task.isCancelled else { return nil }
        return prepared
    }

    private static func make(
        source: URL,
        displayName: String,
        reuseExistingFile: Bool
    ) -> AttachmentExportFile? {
        guard let source = validatedOwnedAttachmentURL(source) else { return nil }
        let name = safeName(displayName, fallback: source.lastPathComponent)
        if reuseExistingFile,
           source.lastPathComponent == name,
           isManagedDownloadURL(source) {
            return AttachmentExportFile(url: source, ownedDirectory: nil)
        }

        let manager = FileManager.default
        let directory = manager.temporaryDirectory
            .appendingPathComponent("sentient-export-\(UUID().uuidString)", isDirectory: true)
        let destination = directory.appendingPathComponent(name)
        do {
            try manager.createDirectory(at: directory, withIntermediateDirectories: false)
            try manager.copyItem(at: source, to: destination)
            return AttachmentExportFile(url: destination, ownedDirectory: directory)
        } catch {
            try? manager.removeItem(at: directory)
            return nil
        }
    }

    private static func isManagedDownloadURL(_ source: URL) -> Bool {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("SentientAttachments", isDirectory: true)
            .standardizedFileURL
        return source.path.hasPrefix(root.path + "/")
    }

    deinit {
        if let ownedDirectory {
            try? FileManager.default.removeItem(at: ownedDirectory)
        }
    }

    private static func safeName(_ displayName: String, fallback: String) -> String {
        let requested = URL(fileURLWithPath: displayName).lastPathComponent
        let name = requested.isEmpty || requested == "." || requested == ".." ? fallback : requested
        return name.isEmpty || name == "." || name == ".." ? "attachment" : name
    }
}

private struct MessageAttachmentCard: View {
    let attachment: AttachmentRef
    let preview: UIImage?
    let previewFailed: Bool
    let onPreview: () -> Void

    var body: some View {
        Button(action: onPreview) {
            VStack(alignment: .leading, spacing: Space.sm) {
                if let preview {
                    Image(uiImage: preview)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 260)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .accessibilityHidden(true)
                } else {
                    Image(systemName: iconName)
                        .font(.system(size: 30))
                        .foregroundStyle(DuskColors.accent)
                        .frame(maxWidth: .infinity, minHeight: 92, maxHeight: 92)
                        .background(DuskColors.bgSunk, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .accessibilityHidden(true)
                }
                HStack(alignment: .top, spacing: Space.sm) {
                    Image(systemName: iconName)
                        .foregroundStyle(DuskColors.accent)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(attachment.displayName)
                            .font(Typo.ui(TypeScale.sm, .semibold))
                            .foregroundStyle(DuskColors.ink)
                            .lineLimit(2)
                        Text("\(attachment.mediaKind.uppercased()) · \(ByteCountFormatter.string(fromByteCount: attachment.size, countStyle: .file))")
                            .font(Typo.ui(TypeScale.xs))
                            .foregroundStyle(DuskColors.ink3)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(Typo.ui(TypeScale.xs, .semibold))
                        .foregroundStyle(DuskColors.ink3)
                        .accessibilityHidden(true)
                }
            }
            .padding(Space.sm)
            .background(DuskColors.bg.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Open attachment \(attachment.displayName)")
        .accessibilityValue(preview == nil && previewFailed ? "Preview unavailable" : "")
        .accessibilityIdentifier("attachment-\(attachment.attachmentId)")
    }

    private var iconName: String {
        switch attachment.mediaKind {
        case "image": return "photo"
        case "pdf": return "doc.richtext"
        default: return "doc.text"
        }
    }
}

private struct AttachmentExportRequest: Equatable {
    let attachmentID: String
    let source: URL?
    let displayName: String
    let reuseExistingFile: Bool
}

private struct AttachmentExportTaskID: Equatable {
    let request: AttachmentExportRequest
    let generation: Int
}

struct MessageAttachmentPreviewSheet: View {
    let attachment: AttachmentPreviewSelection
    let preview: UIImage?
    let previewFailed: Bool
    let file: URL?
    let downloadFailed: Bool
    let downloadAvailable: Bool
    let onRetryPreview: () -> Void
    let onDownload: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var exportFile: AttachmentExportFile?
    @State private var exportPreparing = false
    @State private var exportPreparationFailed = false
    @State private var exportGeneration = 0

    private var exportRequest: AttachmentExportRequest {
        AttachmentExportRequest(
            attachmentID: attachment.id,
            source: file,
            displayName: attachment.displayName,
            reuseExistingFile: !attachment.isLocal
        )
    }

    private var exportTaskID: AttachmentExportTaskID {
        AttachmentExportTaskID(request: exportRequest, generation: exportGeneration)
    }

    var body: some View {
        NavigationStack {
            previewContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(DuskColors.bg)
                .navigationTitle(attachment.displayName)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        exportAction
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(DuskColors.paper)
        .duskTheme()
        .accessibilityIdentifier("attachment-preview-\(attachment.id)")
        .onChange(of: exportRequest) { _, _ in invalidateExportPreparation() }
        .task(id: exportTaskID) {
            let request = exportRequest
            let generation = exportGeneration
            exportFile = nil
            exportPreparationFailed = false
            exportPreparing = request.source != nil
            guard let source = request.source else { return }

            let prepared = await AttachmentExportFile.prepare(
                source: source,
                displayName: request.displayName,
                reuseExistingFile: request.reuseExistingFile
            )
            guard !Task.isCancelled,
                  generation == exportGeneration,
                  request == exportRequest else { return }

            exportPreparing = false
            if let prepared {
                exportFile = prepared
            } else {
                exportPreparationFailed = true
            }
        }
    }

    private func invalidateExportPreparation() {
        exportGeneration += 1
        exportFile = nil
        exportPreparing = false
        exportPreparationFailed = false
    }

    private func retryExport() {
        invalidateExportPreparation()
    }

    @ViewBuilder
    private var previewContent: some View {
        if let preview {
            Image(uiImage: preview)
                .resizable()
                .scaledToFit()
                .padding(Space.lg)
                .accessibilityLabel("Preview of \(attachment.displayName)")
        } else if attachment.mediaKind == "text" ||
                    (attachment.isLocal && attachment.mediaKind == "pdf") {
            VStack(spacing: Space.md) {
                Image(systemName: "doc.text")
                    .font(.system(size: 48))
                    .foregroundStyle(DuskColors.accent)
                Text(attachment.displayName)
                    .font(Typo.ui(TypeScale.base, .semibold))
                    .multilineTextAlignment(.center)
                Text("\(attachment.contentType) · \(ByteCountFormatter.string(fromByteCount: attachment.size, countStyle: .file))")
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink3)
                Text("Preview unavailable")
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink3)
            }
            .padding(Space.lg)
        } else {
            VStack(spacing: Space.md) {
                ProgressView()
                    .tint(DuskColors.accent)
                if previewFailed {
                    Button("Retry preview", action: onRetryPreview)
                        .accessibilityIdentifier("attachment-preview-retry-\(attachment.id)")
                }
            }
        }
    }

    @ViewBuilder
    private var exportAction: some View {
        if let exportFile {
            ShareLink(item: exportFile.url) {
                Image(systemName: "square.and.arrow.down")
            }
            .accessibilityLabel("Export \(attachment.displayName)")
            .accessibilityIdentifier("attachment-export-\(attachment.id)")
        } else if exportPreparationFailed, file != nil {
            Button(action: retryExport) {
                Label("Retry export", systemImage: "exclamationmark.triangle")
            }
            .foregroundStyle(DuskColors.stop)
            .accessibilityLabel("Retry export \(attachment.displayName)")
            .accessibilityValue("Export unavailable")
            .accessibilityIdentifier("attachment-export-retry-\(attachment.id)")
        } else if file != nil {
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Preparing export \(attachment.displayName)")
                .accessibilityIdentifier("attachment-export-preparing-\(attachment.id)")
        } else if downloadAvailable {
            Button(action: onDownload) {
                Image(systemName: "square.and.arrow.down")
            }
            .accessibilityLabel(downloadFailed ? "Retry download \(attachment.displayName)" : "Download \(attachment.displayName)")
            .accessibilityIdentifier("attachment-download-\(attachment.id)")
        }
    }
}

/// Cut-short marker copy (nil when not cut short). The two gestures read
/// differently on purpose and match webui's InterruptChip word-for-word:
/// "interrupted" is the Stop button, "barge-in" is the user talking over the
/// reply. Collapsing them told the user their tap stopped a reply their voice
/// had already cut off.
func messageCutoffLabel(for cutoffKind: String?) -> String? {
    switch cutoffKind {
    case "barge-in": return "barge-in"
    case "interrupt": return "interrupted"
    default: return nil
    }
}

#Preview {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    ScrollView {
        VStack(spacing: Space.gapMsg) {
            MessageBubble(
                message: ChatMessage(ts: now, role: "user", content: "hello", streaming: false, cutoffKind: nil, turnId: nil, replyId: nil, pendingId: nil, entryId: "preview-u0"),
                index: 0,
                userName: "Alice"
            )
            MessageBubble(
                message: ChatMessage(ts: now + 1, role: "assistant", content: "Hi there! How can I help?", streaming: false, cutoffKind: nil, turnId: nil, replyId: nil, pendingId: nil, entryId: "preview-a1"),
                index: 1,
                userName: "Alice"
            )
            MessageBubble(
                message: ChatMessage(ts: now + 2, role: "assistant", content: "", streaming: true, cutoffKind: nil, turnId: nil, replyId: nil, pendingId: nil, entryId: "preview-a2"),
                index: 2,
                userName: "Alice"
            )
            // streaming + content → data-layer substring rendered directly, no cursor
            MessageBubble(
                message: ChatMessage(ts: now + 3, role: "assistant", content: "Streaming text reveals progressively...", streaming: true, cutoffKind: nil, turnId: nil, replyId: nil, pendingId: nil, entryId: "preview-a3"),
                index: 3,
                avatarMode: .thinking,
                userName: "Alice"
            )
            MessageBubble(
                message: ChatMessage(ts: now + 4, role: "assistant", content: "Cut off here", streaming: false, cutoffKind: "interrupt", turnId: nil, replyId: nil, pendingId: nil, entryId: "preview-a4"),
                index: 4,
                userName: "Alice"
            )
            // Committed message with a turnId — tool rows for this turn render in
            // the composer's task strip (ComposerTaskStrip), not on the bubble.
            MessageBubble(
                message: ChatMessage(
                    ts: now + 5, role: "assistant",
                    content: "I checked the weather and your calendar.",
                    streaming: false, cutoffKind: nil, turnId: "c1",
                    replyId: nil, pendingId: nil, entryId: "preview-a5"
                ),
                index: 5,
                userName: "Alice"
            )
            // Streaming message with a turnId — same note as above.
            MessageBubble(
                message: ChatMessage(
                    ts: now + 6, role: "assistant",
                    content: "Working on it...",
                    streaming: true, cutoffKind: nil, turnId: "c1",
                    replyId: nil, pendingId: nil, entryId: "preview-a6"
                ),
                index: 6,
                avatarMode: .thinking,
                userName: "Alice"
            )
        }
        .padding(Space.lg)
    }
    .background(DuskColors.bg)
}
