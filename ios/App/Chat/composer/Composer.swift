import MobileData
import SwiftUI
import UIKit

private struct ComposerReduceMotionOverrideKey: EnvironmentKey {
    static let defaultValue: Bool? = nil
}

extension EnvironmentValues {
    var composerReduceMotionOverride: Bool? {
        get { self[ComposerReduceMotionOverrideKey.self] }
        set { self[ComposerReduceMotionOverrideKey.self] = newValue }
    }
}

@propertyWrapper
struct ComposerReduceMotion: DynamicProperty {
    @Environment(\.accessibilityReduceMotion) private var systemValue
    @Environment(\.composerReduceMotionOverride) private var override

    var wrappedValue: Bool { override ?? systemValue }
}

struct ComposerAttachment: Identifiable, Equatable {
    let id: String
    let displayName: String
    let mediaType: String
    let sizeBytes: Int64

    init(_ attachment: NativeDraftAttachment) {
        id = attachment.id
        displayName = attachment.displayName
        mediaType = attachment.mediaType
        sizeBytes = attachment.sizeBytes
    }

    var isImage: Bool {
        mediaType.hasPrefix("image/") || mediaType == "application/vnd.sentient.live-photo+zip"
    }
}

enum ComposerAttachmentDismissAction: Equatable {
    case cancel, remove
}

func composerAttachmentDismissAction(for transfer: AttachmentTransferState?) -> ComposerAttachmentDismissAction {
    transfer?.phase == .uploading ? .cancel : .remove
}

/// Encapsulated native composer. Draft ownership stays here so permission,
/// capture failures, reconnects, and Hold/Auto transitions never erase text.
struct Composer: View {
    let tasks: [TaskListItem]
    let ttsEnabled: Bool
    let talkMode: TalkMode
    let micLevels: [Float]
    let voiceDisabled: Bool
    let canInterrupt: Bool
    let draftText: String?
    let attachments: [ComposerAttachment]
    let pendingAttachmentImportCount: Int
    let attachmentTransfers: [String: AttachmentTransferState]
    let attachmentPreviews: [String: UIImage]
    let attachmentPreviewFailures: Set<String>
    let onDraftChange: (String) -> Void
    let onPickAttachments: ([AttachmentImportItem]) -> Void
    let onPrepareAttachments: (AttachmentImportRequest) -> Void
    let onAttachmentImportFailure: (AttachmentImportSource, Error?) -> Void
    /// False is delivered only after native sheet dismissal completes.
    let onAttachmentPickerPresentationChange: (Bool) -> Void
    let onRemoveAttachment: (String) -> Void
    let onCancelAttachment: (String) -> Void
    let onRetryAttachment: (String) -> Void
    let onEditAttachment: (String) -> Void
    let onSend: (String) -> Void
    let onVoiceIntent: (VoiceCaptureIntent) -> Void
    let onTtsToggle: () -> Void
    let onInterrupt: () -> Void
    let onFocusGained: () -> Void
    private let initiallyExpandedTaskId: String?

    @State private var draft: String
    @State private var localHoldPresentationActive = false
    @State private var showingSourcePicker = false
    @State private var showingFilePicker = false
    @State private var showingPhotosPicker = false
    @State private var showingCameraPicker = false
    @State private var requestingCameraAccess = false
    @State private var queuedSource: AttachmentNativeSource?
    @State private var sourceIssue: AttachmentSourceSheet.CameraIssue?
    @State private var queuedSourceIssue: AttachmentSourceSheet.CameraIssue?
    @State private var queuedImportFailure: QueuedImportFailure?
    @State private var previewedAttachment: ComposerAttachment?
    @State private var inputFocused = false
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    init(
        tasks: [TaskListItem],
        ttsEnabled: Bool,
        talkMode: TalkMode,
        micLevels: [Float],
        voiceDisabled: Bool,
        canInterrupt: Bool,
        initialDraft: String = "",
        draftText: String? = nil,
        attachments: [ComposerAttachment] = [],
        pendingAttachmentImportCount: Int = 0,
        attachmentTransfers: [String: AttachmentTransferState] = [:],
        attachmentPreviews: [String: UIImage] = [:],
        attachmentPreviewFailures: Set<String> = [],
        initiallyExpandedTaskId: String? = nil,
        onDraftChange: @escaping (String) -> Void = { _ in },
        onPickAttachments: @escaping ([AttachmentImportItem]) -> Void = { _ in },
        onPrepareAttachments: @escaping (AttachmentImportRequest) -> Void = { _ in },
        onAttachmentImportFailure: @escaping (AttachmentImportSource, Error?) -> Void = { _, _ in },
        onAttachmentPickerPresentationChange: @escaping (Bool) -> Void = { _ in },
        onRemoveAttachment: @escaping (String) -> Void = { _ in },
        onCancelAttachment: @escaping (String) -> Void = { _ in },
        onRetryAttachment: @escaping (String) -> Void = { _ in },
        onEditAttachment: @escaping (String) -> Void = { _ in },
        onSend: @escaping (String) -> Void,
        onVoiceIntent: @escaping (VoiceCaptureIntent) -> Void,
        onTtsToggle: @escaping () -> Void,
        onInterrupt: @escaping () -> Void,
        onFocusGained: @escaping () -> Void
    ) {
        self.tasks = tasks
        self.ttsEnabled = ttsEnabled
        self.talkMode = talkMode
        self.micLevels = micLevels
        self.voiceDisabled = voiceDisabled
        self.canInterrupt = canInterrupt
        self.draftText = draftText
        self.attachments = attachments
        self.pendingAttachmentImportCount = pendingAttachmentImportCount
        self.attachmentTransfers = attachmentTransfers
        self.attachmentPreviews = attachmentPreviews
        self.attachmentPreviewFailures = attachmentPreviewFailures
        self.onDraftChange = onDraftChange
        self.onPickAttachments = onPickAttachments
        self.onPrepareAttachments = onPrepareAttachments
        self.onAttachmentImportFailure = onAttachmentImportFailure
        self.onAttachmentPickerPresentationChange = onAttachmentPickerPresentationChange
        self.onRemoveAttachment = onRemoveAttachment
        self.onCancelAttachment = onCancelAttachment
        self.onRetryAttachment = onRetryAttachment
        self.onEditAttachment = onEditAttachment
        self.onSend = onSend
        self.onVoiceIntent = onVoiceIntent
        self.onTtsToggle = onTtsToggle
        self.onInterrupt = onInterrupt
        self.onFocusGained = onFocusGained
        self.initiallyExpandedTaskId = initiallyExpandedTaskId
        _draft = State(initialValue: draftText ?? initialDraft)
    }

    private var voicePresentation: ComposerVoicePresentationState {
        ComposerVoicePresentationState(
            talkMode: talkMode,
            localHoldActive: localHoldPresentationActive
        )
    }
    private var isHolding: Bool { voicePresentation.isHolding }
    private var draftPresent: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !attachments.isEmpty || pendingAttachmentImportCount > 0
    }
    private var remainingAttachmentSlots: Int {
        AttachmentImportPolicy.remaining(
            existing: attachments.count,
            pending: pendingAttachmentImportCount
        )
    }

    var body: some View {
        VStack(spacing: tasks.isEmpty ? 0 : ComposerGeometry.joinOverlap) {
            if !tasks.isEmpty {
                ComposerTaskStrip(
                    items: tasks,
                    initiallyExpandedTaskId: initiallyExpandedTaskId
                )
                    .padding(
                        .horizontal,
                        ComposerGeometry.taskShelfInset(horizontalSizeClass: horizontalSizeClass)
                    )
                    .zIndex(0)
            }

            composerFace
                .zIndex(1)
        }
        .frame(maxWidth: ComposerGeometry.maximumWidth)
        .padding(.horizontal, ComposerGeometry.dockHorizontalInset)
        .padding(.top, Space.sm)
        .padding(.bottom, Space.sm)
        .onChange(of: inputFocused) { _, focused in
            if focused { onFocusGained() }
        }
        .onChange(of: draft) { _, text in onDraftChange(text) }
        .onChange(of: draftText) { _, text in
            if let text, text != draft { draft = text }
        }
        .onChange(of: showingSourcePicker) { _, presented in
            if presented { onAttachmentPickerPresentationChange(true) }
        }
        .onChange(of: showingPhotosPicker) { _, presented in
            if presented { onAttachmentPickerPresentationChange(true) }
        }
        .onChange(of: showingCameraPicker) { _, presented in
            if presented { onAttachmentPickerPresentationChange(true) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-composer")
        .sheet(isPresented: $showingSourcePicker, onDismiss: finishAttachmentPickerDismissal) {
            AttachmentSourceSheet(
                cameraIssue: sourceIssue,
                onCamera: { queue(.camera) },
                onPhotos: { queue(.photos) },
                onFiles: { queue(.files) },
                onOpenSettings: openSettings
            )
        }
        .sheet(isPresented: $showingFilePicker, onDismiss: finishAttachmentPickerDismissal) {
            AttachmentDocumentPicker(
                onSelection: { urls in
                    submitImports(urls.map(AttachmentImportItem.file))
                    showingFilePicker = false
                },
                onCancel: { showingFilePicker = false }
            )
        }
        .onChange(of: showingFilePicker) { _, presented in
            if presented { onAttachmentPickerPresentationChange(true) }
        }
        .sheet(isPresented: $showingPhotosPicker, onDismiss: finishAttachmentPickerDismissal) {
            AttachmentPhotoPicker(
                selectionLimit: max(1, remainingAttachmentSlots),
                onSelection: { selection in
                    showingPhotosPicker = false
                    onPrepareAttachments(AttachmentImportRequest(
                        count: selection.count,
                        source: .photos
                    ) {
                        try await AttachmentPhotoImport.prepare(selection)
                    })
                },
                onCancel: { showingPhotosPicker = false }
            )
            .ignoresSafeArea()
        }
        .sheet(item: $previewedAttachment) { attachment in
            ComposerAttachmentPreview(
                attachment: attachment,
                image: attachmentPreviews[attachment.id]
            )
        }
        .fullScreenCover(isPresented: $showingCameraPicker, onDismiss: finishAttachmentPickerDismissal) {
            AttachmentCameraPicker(
                onCapture: { item in
                    submitImports([item])
                    showingCameraPicker = false
                },
                onCancel: { showingCameraPicker = false },
                onFailure: {
                    queueSourceIssue(.captureFailed)
                    queueImportFailure(source: .camera, error: AttachmentImportPickerIssue.captureFailed)
                    showingCameraPicker = false
                }
            )
            .ignoresSafeArea()
        }
    }

    private var composerFace: some View {
        VStack(spacing: ComposerGeometry.contentGap(horizontalSizeClass: horizontalSizeClass)) {
            if !attachments.isEmpty || pendingAttachmentImportCount > 0 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: Space.sm) {
                        ForEach(attachments) { attachment in
                            ComposerAttachmentCard(
                                attachment: attachment,
                                transfer: attachmentTransfers[attachment.id],
                                preview: attachmentPreviews[attachment.id],
                                previewFailed: attachmentPreviewFailures.contains(attachment.id),
                                onPreview: { previewedAttachment = attachment },
                                onRemove: { onRemoveAttachment(attachment.id) },
                                onCancel: { onCancelAttachment(attachment.id) },
                                onRetry: { onRetryAttachment(attachment.id) },
                                onEdit: { onEditAttachment(attachment.id) }
                            )
                        }
                        ForEach(0..<pendingAttachmentImportCount, id: \.self) { index in
                            ComposerAttachmentPreparationCard(index: index)
                        }
                    }
                }
                .accessibilityIdentifier("composer-attachments")
            }

            DraftEditor(
                text: $draft,
                isFocused: $inputFocused,
                isReceded: isHolding,
                minimumHeight: ComposerGeometry.editorMinimumHeight(
                    horizontalSizeClass: horizontalSizeClass
                ),
                horizontalInset: ComposerGeometry.editorHorizontalInset(
                    horizontalSizeClass: horizontalSizeClass
                ),
                onSubmit: sendDraft,
                onPasteProviders: receivePastedProviders
            )

            ComposerActions(
                draftPresent: draftPresent && !isHolding,
                held: isHolding,
                ttsEnabled: ttsEnabled,
                talkMode: talkMode,
                micLevels: micLevels,
                voiceDisabled: voiceDisabled,
                canInterrupt: canInterrupt,
                onAttach: { showingSourcePicker = true },
                onSend: sendDraft,
                onHoldPresentationChanged: { localHoldPresentationActive = $0 },
                onVoiceIntent: onVoiceIntent,
                onTtsToggle: onTtsToggle,
                onInterrupt: onInterrupt
            )
        }
        .padding(
            .horizontal,
            ComposerGeometry.faceHorizontalPadding(horizontalSizeClass: horizontalSizeClass)
        )
        .padding(
            .top,
            ComposerGeometry.faceTopPadding(horizontalSizeClass: horizontalSizeClass)
        )
        .padding(
            .bottom,
            ComposerGeometry.faceBottomPadding(horizontalSizeClass: horizontalSizeClass)
        )
        .frame(maxWidth: .infinity)
        .contentShape(
            RoundedRectangle(
                cornerRadius: ComposerGeometry.faceRadius(horizontalSizeClass: horizontalSizeClass),
                style: .continuous
            )
        )
        .onTapGesture {
            if !isHolding { inputFocused = true }
        }
        .background {
            ComposerFaceBackground(
                cornerRadius: ComposerGeometry.faceRadius(horizontalSizeClass: horizontalSizeClass),
                isFocused: inputFocused,
                isVoiceActive: talkMode != .idle
            )
        }
    }

    private func queue(_ source: AttachmentNativeSource) {
        let importSource: AttachmentImportSource = switch source {
        case .camera: .camera
        case .photos: .photos
        case .files: .files
        }
        guard remainingAttachmentSlots > 0 else {
            queueSourceIssue(.attachmentLimit)
            queueImportFailure(
                source: importSource,
                error: AttachmentImportPickerIssue.attachmentLimit
            )
            return
        }
        sourceIssue = nil
        queuedSource = source
        showingSourcePicker = false
    }

    private func presentQueuedSource() {
        guard let source = queuedSource else { return }
        queuedSource = nil
        switch source {
        case .files:
            showingFilePicker = true
        case .photos:
            showingPhotosPicker = true
        case .camera:
            requestingCameraAccess = true
            Task {
                defer {
                    requestingCameraAccess = false
                    flushQueuedImportFailure()
                    onAttachmentPickerPresentationChange(attachmentPresentationActive)
                }
                switch await cameraAccessDecision(using: SystemCameraAccess()) {
                case .present: showingCameraPicker = true
                case .denied:
                    queueSourceIssue(.denied)
                    queueImportFailure(source: .camera, error: AttachmentImportPickerIssue.cameraDenied)
                case .restricted:
                    queueSourceIssue(.restricted)
                    queueImportFailure(source: .camera, error: AttachmentImportPickerIssue.cameraRestricted)
                case .unavailable:
                    queueSourceIssue(.unavailable)
                    queueImportFailure(source: .camera, error: AttachmentImportPickerIssue.cameraUnavailable)
                }
            }
        }
    }

    private func receivePastedProviders(_ providers: [NSItemProvider]) {
        let supported = attachmentPasteProviders(from: providers)
        guard !supported.isEmpty else { return }
        guard supported.count <= remainingAttachmentSlots else {
            onAttachmentImportFailure(.mixed, AttachmentImportPickerIssue.attachmentLimit)
            return
        }
        onPrepareAttachments(AttachmentImportRequest(
            count: supported.count,
            source: .mixed
        ) {
            try await AttachmentPasteImport.prepare(supported)
        })
    }

    private func submitImports(_ items: [AttachmentImportItem]) {
        guard items.count <= remainingAttachmentSlots else {
            for url in Set(items.flatMap(\.ownedTemporaryURLs)) {
                try? FileManager.default.removeItem(at: url)
            }
            queueSourceIssue(.attachmentLimit)
            queueImportFailure(
                source: AttachmentImportSource.combined(items),
                error: AttachmentImportPickerIssue.attachmentLimit
            )
            return
        }
        onPickAttachments(items)
    }

    private func queueImportFailure(source: AttachmentImportSource, error: Error) {
        queuedImportFailure = QueuedImportFailure(source: source, error: error)
        flushQueuedImportFailure()
    }

    /// Native sheet boundary; never call from picker binding changes.
    private func finishAttachmentPickerDismissal() {
        showingSourcePicker = false
        showingFilePicker = false
        showingPhotosPicker = false
        showingCameraPicker = false
        presentQueuedSource()
        presentQueuedSourceIssue()
        flushQueuedImportFailure()
        onAttachmentPickerPresentationChange(attachmentPresentationActive)
    }

    private var attachmentPresentationActive: Bool {
        showingSourcePicker || showingFilePicker || showingPhotosPicker || showingCameraPicker || requestingCameraAccess
    }

    private func flushQueuedImportFailure() {
        guard !attachmentPresentationActive, let failure = queuedImportFailure else { return }
        queuedImportFailure = nil
        onAttachmentImportFailure(failure.source, failure.error)
    }

    private func queueSourceIssue(_ issue: AttachmentSourceSheet.CameraIssue) {
        guard !showingFilePicker, !showingPhotosPicker, !showingCameraPicker else {
            queuedSourceIssue = issue
            return
        }
        sourceIssue = issue
        showingSourcePicker = true
    }

    private func presentQueuedSourceIssue() {
        guard !showingSourcePicker,
              !showingFilePicker,
              !showingPhotosPicker,
              !showingCameraPicker,
              let issue = queuedSourceIssue else { return }
        queuedSourceIssue = nil
        sourceIssue = issue
        showingSourcePicker = true
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty || pendingAttachmentImportCount > 0 else { return }
        onSend(text)
        if draftText == nil { draft = "" }
        inputFocused = false
    }
}

private enum AttachmentNativeSource {
    case camera, photos, files
}

private struct QueuedImportFailure {
    let source: AttachmentImportSource
    let error: Error
}

private struct ComposerAttachmentCard: View {
    let attachment: ComposerAttachment
    let transfer: AttachmentTransferState?
    let preview: UIImage?
    let previewFailed: Bool
    let onPreview: () -> Void
    let onRemove: () -> Void
    let onCancel: () -> Void
    let onRetry: () -> Void
    let onEdit: () -> Void

    @ScaledMetric(relativeTo: .body) private var scaledWidth: CGFloat = 168

    private var width: CGFloat { min(max(scaledWidth, 168), 220) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            ZStack(alignment: .topTrailing) {
                previewControl
                DesignCompactIconButton(
                    systemName: "xmark",
                    label: dismissLabel,
                    accessibilityId: "composer-attachment-dismiss-\(attachment.id)",
                    action: dismiss
                )
                .padding(Space.xs)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.displayName)
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.ink)
                    .lineLimit(2)
                Text("\(attachment.mediaType.split(separator: "/").last?.uppercased() ?? "FILE") · \(ByteCountFormatter.string(fromByteCount: attachment.sizeBytes, countStyle: .file))")
                    .font(Typo.ui(TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
                    .lineLimit(1)
            }

            transferStatus
        }
        .padding(Space.sm)
        .frame(width: width, alignment: .leading)
        .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(DuskColors.line, lineWidth: DesignMetrics.hairline)
        }
    }

    @ViewBuilder
    private var previewControl: some View {
        if attachment.isImage {
            Button(action: onPreview) { previewFace }
                .buttonStyle(.plain)
                .disabled(preview == nil)
                .accessibilityLabel("Preview \(attachment.displayName)")
                .accessibilityIdentifier("composer-attachment-preview-\(attachment.id)")
        } else {
            previewFace
                .accessibilityHidden(true)
        }
    }

    private var previewFace: some View {
        Group {
            if let preview {
                Image(uiImage: preview)
                    .resizable()
                    .scaledToFill()
            } else if attachment.isImage && !previewFailed {
                ProgressView()
                    .tint(DuskColors.accent)
            } else {
                Image(systemName: attachment.isImage ? "photo" : "doc.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(DuskColors.accent)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 104, maxHeight: 104)
        .background(DuskColors.bgSunk)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var transferStatus: some View {
        switch transfer?.phase {
        case .uploading:
            ProgressView(value: transfer?.progress ?? 0) {
                Text("Uploading")
            }
            .font(Typo.ui(TypeScale.xs))
            .tint(DuskColors.accent)
        case .failed:
            failedActions(label: "Upload failed", color: DuskColors.warn)
        case .cancelled:
            failedActions(label: "Cancelled", color: DuskColors.ink3)
        case .ready:
            Text("Uploaded")
                .font(Typo.ui(TypeScale.xs))
                .foregroundStyle(DuskColors.ink3)
        case nil:
            EmptyView()
        }
    }

    private func failedActions(label: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(label)
                .font(Typo.ui(TypeScale.xs, .semibold))
                .foregroundStyle(color)
            HStack(spacing: Space.xs) {
                DesignCompactButton(accessibilityLabel: "Edit \(attachment.displayName)", action: onEdit) {
                    Text("Edit").font(Typo.ui(TypeScale.xs, .semibold))
                }
                DesignCompactButton(accessibilityLabel: "Retry \(attachment.displayName)", action: onRetry) {
                    Text("Retry").font(Typo.ui(TypeScale.xs, .semibold))
                }
            }
            .foregroundStyle(DuskColors.accent)
        }
    }

    private var dismissLabel: String {
        composerAttachmentDismissAction(for: transfer) == .cancel
            ? "Cancel upload \(attachment.displayName)"
            : "Remove \(attachment.displayName)"
    }

    private func dismiss() {
        switch composerAttachmentDismissAction(for: transfer) {
        case .cancel: onCancel()
        case .remove: onRemove()
        }
    }
}

private struct ComposerAttachmentPreparationCard: View {
    let index: Int
    @ScaledMetric(relativeTo: .body) private var scaledWidth: CGFloat = 168

    var body: some View {
        VStack(spacing: Space.sm) {
            ProgressView()
                .tint(DuskColors.accent)
            Text("Preparing attachment")
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(DuskColors.ink2)
                .multilineTextAlignment(.center)
        }
        .frame(width: min(max(scaledWidth, 168), 220), height: 160)
        .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(DuskColors.line, lineWidth: DesignMetrics.hairline)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Preparing attachment \(index + 1)")
    }
}

private struct ComposerAttachmentPreview: View {
    let attachment: ComposerAttachment
    let image: UIImage?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .padding(Space.lg)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(DuskColors.bg)
            .navigationTitle(attachment.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(DuskColors.paper)
        .duskTheme()
    }
}

// MARK: - Draft editor

final class ComposerTextView: UITextView, UITextPasteDelegate {
    var onPasteProviders: ([NSItemProvider]) -> Void = { _ in }

    // Default mixed paste turns file URLs into text; keep only native clipboard text.
    func textPasteConfigurationSupporting(
        _ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
        transform item: UITextPasteItem
    ) {
        if attachmentPasteContainsNativeText(in: [item.itemProvider]) {
            item.setDefaultResult()
        } else {
            item.setNoResult()
        }
    }

    func textPasteConfigurationSupporting(
        _ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
        combineItemAttributedStrings itemStrings: [NSAttributedString],
        for textRange: UITextRange
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for itemString in itemStrings where itemString.length > 0 {
            result.append(itemString)
        }
        return result
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        let inherited = super.canPerformAction(action, withSender: sender)
        guard action == #selector(UIResponderStandardEditActions.paste(_:)) else {
            return inherited
        }
        let providers = UIPasteboard.general.itemProviders
        return isEditable && (
            attachmentPasteContainsNativeText(in: providers) ||
                !attachmentPasteProviders(from: providers).isEmpty
        )
    }

    override func paste(_ sender: Any?) {
        let clipboardProviders = UIPasteboard.general.itemProviders
        let providers = attachmentPasteProviders(from: clipboardProviders)
        guard !providers.isEmpty else {
            super.paste(sender)
            return
        }
        // Paste native text from original providers, not filtered attachments.
        // Named text files remain attachments and never become text implicitly.
        if attachmentPasteContainsNativeText(in: clipboardProviders) {
            super.paste(sender)
        }
        onPasteProviders(providers)
    }
}

private func applyComposerParagraphStyle(_ view: ComposerTextView) {
    guard view.textStorage.length > 0 else { return }
    let paragraphStyle: NSParagraphStyle
    if let configured = view.typingAttributes[.paragraphStyle] as? NSParagraphStyle {
        paragraphStyle = configured
    } else {
        let fallback = NSMutableParagraphStyle()
        fallback.lineSpacing = 2
        fallback.lineBreakMode = .byWordWrapping
        paragraphStyle = fallback
    }
    view.textStorage.addAttribute(
        .paragraphStyle,
        value: paragraphStyle,
        range: NSRange(location: 0, length: view.textStorage.length)
    )
}

/// Applies UIKit settings for bounded native editing and attachment-aware paste.
/// Keep UITextView scrollable; ComposerEditorLayout supplies six-line host height.
func configureComposerTextView(
    _ view: ComposerTextView,
    text: String = "",
    onPasteProviders: @escaping ([NSItemProvider]) -> Void = { _ in }
) {
    view.backgroundColor = .clear
    view.textColor = UIColor(DuskColors.ink)
    view.tintColor = UIColor(DuskColors.accent)
    let baseFont = UIFont(name: DesignTypographyAdapter.uiFamily, size: TypeScale.base)
        ?? UIFont.preferredFont(forTextStyle: .body)
    let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: baseFont)
    view.font = font
    view.adjustsFontForContentSizeCategory = true
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.textContainer.maximumNumberOfLines = 0
    view.textContainer.lineBreakMode = .byWordWrapping
    view.returnKeyType = .send
    view.isEditable = true
    view.isSelectable = true
    view.isScrollEnabled = true
    view.clipsToBounds = true
    let paragraphStyle = NSMutableParagraphStyle()
    paragraphStyle.lineSpacing = 2
    paragraphStyle.lineBreakMode = .byWordWrapping
    view.typingAttributes = [
        .font: font,
        .foregroundColor: UIColor(DuskColors.ink),
        .paragraphStyle: paragraphStyle,
    ]
    view.accessibilityLabel = "Message Sentient"
    view.accessibilityIdentifier = "composer-input"
    view.pasteDelegate = view
    view.text = text
    applyComposerParagraphStyle(view)
    view.onPasteProviders = onPasteProviders
}

private struct ComposerTextInput: UIViewRepresentable {
    @Binding var text: String
    var isFocused: Binding<Bool>
    let minimumHeight: CGFloat
    let onSubmit: () -> Void
    let onPasteProviders: ([NSItemProvider]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.delegate = context.coordinator
        configureComposerTextView(
            view,
            text: text,
            onPasteProviders: onPasteProviders
        )
        return view
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: ComposerTextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let content = uiView.sizeThatFits(
            CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        )
        let lineHeight = uiView.font?.lineHeight ?? UIFont.preferredFont(forTextStyle: .body).lineHeight
        let lineSpacing = (uiView.typingAttributes[.paragraphStyle] as? NSParagraphStyle)?.lineSpacing ?? 0
        let maximumHeight = ceil(
            lineHeight * 6 + lineSpacing * 5 +
                uiView.textContainerInset.top + uiView.textContainerInset.bottom
        )
        let desiredHeight = max(minimumHeight, min(content.height, maximumHeight))
        if let proposedHeight = proposal.height, proposedHeight.isFinite {
            return CGSize(width: width, height: min(desiredHeight, proposedHeight))
        }
        return CGSize(width: width, height: desiredHeight)
    }

    func updateUIView(_ view: ComposerTextView, context: Context) {
        context.coordinator.parent = self
        view.onPasteProviders = onPasteProviders
        // Do not replace marked text: doing so breaks IME composition. Preserve
        // selection for external draft updates while the editor remains focused.
        if view.text != text, view.markedTextRange == nil {
            let selectedRange = view.selectedRange
            view.text = text
            applyComposerParagraphStyle(view)
            let textLength = (text as NSString).length
            let location = min(selectedRange.location, textLength)
            let length = min(selectedRange.length, textLength - location)
            view.selectedRange = NSRange(location: location, length: length)
        }
        if isFocused.wrappedValue, !view.isFirstResponder {
            context.coordinator.withResponderFence { view.becomeFirstResponder() }
        } else if !isFocused.wrappedValue, view.isFirstResponder {
            context.coordinator.withResponderFence { view.resignFirstResponder() }
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextInput
        private var applyingResponderState = false

        init(_ parent: ComposerTextInput) { self.parent = parent }

        func withResponderFence(_ action: () -> Void) {
            applyingResponderState = true
            defer { applyingResponderState = false }
            action()
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            DispatchQueue.main.async { [weak textView] in
                guard let textView, textView.isFirstResponder else { return }
                textView.layoutIfNeeded()
                self.scrollCaretIntoView(textView)
            }
        }

        private func scrollCaretIntoView(_ textView: UITextView) {
            guard let position = textView.position(
                from: textView.beginningOfDocument,
                offset: textView.selectedRange.location
            ) else { return }
            let caret = textView.caretRect(for: position)
            let visible = textView.bounds.insetBy(dx: 0, dy: -1)
            var offsetY = textView.contentOffset.y
            if caret.maxY > visible.maxY {
                offsetY += caret.maxY - visible.maxY
            } else if caret.minY < visible.minY {
                offsetY -= visible.minY - caret.minY
            }
            let minimumOffset = -textView.adjustedContentInset.top
            let maximumOffset = max(
                minimumOffset,
                textView.contentSize.height - textView.bounds.height +
                    textView.adjustedContentInset.bottom
            )
            textView.setContentOffset(
                CGPoint(
                    x: textView.contentOffset.x,
                    y: min(max(offsetY, minimumOffset), maximumOffset)
                ),
                animated: false
            )
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            guard !applyingResponderState else { return }
            parent.isFocused.wrappedValue = true
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            guard !applyingResponderState else { return }
            parent.isFocused.wrappedValue = false
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            guard text == "\n", textView.markedTextRange == nil else { return true }
            parent.onSubmit()
            return false
        }
    }
}

private struct ComposerEditorLayout: Layout {
    let minimumHeight: CGFloat
    let text: String

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        guard let input = subviews.first else { return .zero }
        let width = proposal.width ?? input.sizeThatFits(.unspecified).width
        let inputSize = input.sizeThatFits(
            ProposedViewSize(width: width, height: nil)
        )
        let promptSize = text.isEmpty && subviews.count > 1
            ? subviews[1].sizeThatFits(ProposedViewSize(width: width, height: nil))
            : .zero
        return CGSize(
            width: proposal.width ?? max(inputSize.width, promptSize.width),
            height: max(minimumHeight, inputSize.height, promptSize.height)
        )
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let childProposal = ProposedViewSize(width: bounds.width, height: bounds.height)
        for subview in subviews {
            subview.place(
                at: bounds.origin,
                anchor: .topLeading,
                proposal: childProposal
            )
        }
    }
}

private struct DraftEditor: View {
    @Binding var text: String
    var isFocused: Binding<Bool>
    let isReceded: Bool
    let minimumHeight: CGFloat
    let horizontalInset: CGFloat
    let onSubmit: () -> Void
    let onPasteProviders: ([NSItemProvider]) -> Void

    @ComposerReduceMotion private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var promptText: String {
        horizontalSizeClass == .regular
            ? "Message or speak to Sentient"
            : "Message or speak"
    }

    var body: some View {
        ComposerEditorLayout(minimumHeight: minimumHeight, text: text) {
            ComposerTextInput(
                text: $text,
                isFocused: isFocused,
                minimumHeight: minimumHeight,
                onSubmit: onSubmit,
                onPasteProviders: onPasteProviders
            )

            if text.isEmpty {
                Text(promptText)
                    .font(Typo.ui(TypeScale.base))
                    .foregroundStyle(DuskColors.ink3)
                    .allowsHitTesting(false)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
#if DEBUG
        .background(ComposerFrameProbe(identifier: "composer-editor-viewport"))
#endif
        .padding(.horizontal, horizontalInset)
        .opacity(isReceded ? ComposerGeometry.recededOpacity : 1)
        .offset(y: isReceded ? ComposerGeometry.recededOffset : 0)
        .allowsHitTesting(!isReceded)
        .accessibilityHidden(isReceded)
        .animation(
            reduceMotion ? nil : .easeOut(duration: DesignV2.Motion.feedback),
            value: isReceded
        )
    }
}

// MARK: - Composer actions

struct ComposerActionState: Equatable {
    let draftPresent: Bool
    let talkMode: TalkMode

    var showsSend: Bool { draftPresent }
    var showsVoiceCapture: Bool { !draftPresent || talkMode != .idle }
}

/// The child reports physical Hold presentation synchronously so the composer
/// recedes siblings in the same layout pass. Shared `TalkMode` remains the
/// semantic authority and keeps Hold active once its asynchronous update lands.
struct ComposerVoicePresentationState: Equatable {
    let talkMode: TalkMode
    let localHoldActive: Bool

    var isHolding: Bool { localHoldActive || talkMode == .hold }
}

private struct ComposerActions: View {
    let draftPresent: Bool
    let held: Bool
    let ttsEnabled: Bool
    let talkMode: TalkMode
    let micLevels: [Float]
    let voiceDisabled: Bool
    let canInterrupt: Bool
    let onAttach: () -> Void
    let onSend: () -> Void
    let onHoldPresentationChanged: (Bool) -> Void
    let onVoiceIntent: (VoiceCaptureIntent) -> Void
    let onTtsToggle: () -> Void
    let onInterrupt: () -> Void

    @ComposerReduceMotion private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        let actions = ComposerActionState(draftPresent: draftPresent, talkMode: talkMode)

        ComposerActionLayout(
            spacing: ComposerGeometry.actionGap,
            layoutDirection: layoutDirection
        ) {
            HStack(spacing: ComposerGeometry.actionGap) {
                if !held {
                    Button(action: onAttach) {
                        ComposerGlyphView(.attachment)
                            .frame(width: 19, height: 19)
                    }
                    .buttonStyle(ComposerControlButtonStyle(tone: .quiet, size: ComposerGeometry.smallControlSize))
                    .accessibilityLabel("Attach files")
                    .accessibilityIdentifier("chat-attach")

                    Button(action: onTtsToggle) {
                        ComposerGlyphView(ttsEnabled ? .spokenResponsesOn : .spokenResponsesOff)
                            .frame(width: 19, height: 19)
                    }
                    .buttonStyle(ComposerControlButtonStyle(
                        tone: ttsEnabled ? .toggleOn : .quiet,
                        size: ComposerGeometry.smallControlSize
                    ))
                    .accessibilityLabel(ttsEnabled ? "Spoken responses on; turn off" : "Spoken responses off; turn on")
                    .accessibilityValue(ttsEnabled ? "On" : "Off")
                    .accessibilityAddTraits(ttsEnabled ? .isSelected : [])
                    .accessibilityIdentifier("chat-tts-toggle")
                }
            }

            ComposerTrailingActionLayout(
                spacing: ComposerGeometry.trailingActionGap,
                layoutDirection: layoutDirection
            ) {
                if canInterrupt && !held {
                    Button(action: onInterrupt) {
                        ComposerGlyphView(.stopResponse)
                            .frame(width: 19, height: 19)
                    }
                    .buttonStyle(ComposerControlButtonStyle(
                        tone: .stop,
                        size: ComposerGeometry.smallControlSize
                    ))
                    .accessibilityLabel("Stop Sentient response")
                    .accessibilityIdentifier("chat-interrupt")
                    .transition(.scale(scale: 0.82).combined(with: .opacity))
                }

                if actions.showsSend {
                    Button(action: onSend) {
                        ComposerGlyphView(.send)
                            .frame(width: 19, height: 19)
                    }
                    .buttonStyle(ComposerControlButtonStyle(
                        tone: .send,
                        size: ComposerGeometry.trailingControlSize(
                            horizontalSizeClass: horizontalSizeClass
                        )
                    ))
                    .accessibilityLabel("Send message")
                    .accessibilityIdentifier("chat-send")
                    .transition(.scale(scale: 0.88).combined(with: .opacity))
                }

                if actions.showsVoiceCapture {
                    VoiceCaptureControl(
                        talkMode: talkMode,
                        levels: micLevels,
                        disabled: voiceDisabled,
                        onHoldPresentationChanged: onHoldPresentationChanged,
                        onIntent: onVoiceIntent
                    )
                    .transition(.scale(scale: 0.88).combined(with: .opacity))
                }
            }
        }
        .animation(
            reduceMotion ? nil : .spring(duration: DesignV2.Motion.state, bounce: 0),
            value: actions
        )
        .animation(
            reduceMotion ? nil : .spring(duration: DesignV2.Motion.state, bounce: 0),
            value: held
        )
        .animation(
            reduceMotion ? nil : .spring(duration: DesignV2.Motion.state, bounce: 0),
            value: canInterrupt
        )
#if DEBUG
        .background(ComposerFrameProbe(identifier: "composer-actions-viewport"))
#endif
    }
}

#if DEBUG
private struct ComposerFrameProbe: UIViewRepresentable {
    let identifier: String

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.accessibilityIdentifier = identifier
        view.accessibilityElementsHidden = true
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UIView,
        context: Context
    ) -> CGSize? {
        CGSize(width: proposal.width ?? 0, height: proposal.height ?? 0)
    }
}
#endif

/// Wraps trailing controls into logical trailing-aligned rows without
/// shrinking any target. This covers the widest supported combination: Stop,
/// text Send, and persistent Auto at Accessibility Dynamic Type.
struct ComposerTrailingActionLayout: Layout {
    let spacing: CGFloat
    let layoutDirection: LayoutDirection

    static func rows(
        availableWidth: CGFloat,
        itemWidths: [CGFloat],
        spacing: CGFloat
    ) -> [[Int]] {
        guard !itemWidths.isEmpty else { return [] }
        let limit = max(0, availableWidth)
        var result: [[Int]] = []
        var row: [Int] = []
        var rowWidth: CGFloat = 0

        for (index, width) in itemWidths.enumerated() {
            let nextWidth = rowWidth + (row.isEmpty ? 0 : spacing) + width
            if !row.isEmpty, nextWidth > limit {
                result.append(row)
                row = [index]
                rowWidth = width
            } else {
                row.append(index)
                rowWidth = nextWidth
            }
        }
        if !row.isEmpty { result.append(row) }
        return result
    }

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let availableWidth = proposal.width ?? .greatestFiniteMagnitude
        let rows = Self.rows(
            availableWidth: availableWidth,
            itemWidths: sizes.map(\.width),
            spacing: spacing
        )
        let rowSizes = rows.map { rowSize($0, sizes: sizes) }
        return CGSize(
            width: rowSizes.map(\.width).max() ?? 0,
            height: rowSizes.map(\.height).reduce(0, +)
                + CGFloat(max(0, rowSizes.count - 1)) * spacing
        )
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let rows = Self.rows(
            availableWidth: bounds.width,
            itemWidths: sizes.map(\.width),
            spacing: spacing
        )
        var y = bounds.minY

        for row in rows {
            let rowSize = rowSize(row, sizes: sizes)
            if layoutDirection == .leftToRight {
                var x = bounds.maxX - rowSize.width
                for index in row {
                    place(
                        subviews[index],
                        size: sizes[index],
                        x: x,
                        y: y + (rowSize.height - sizes[index].height) / 2
                    )
                    x += sizes[index].width + spacing
                }
            } else {
                var x = bounds.minX + rowSize.width
                for index in row {
                    x -= sizes[index].width
                    place(
                        subviews[index],
                        size: sizes[index],
                        x: x,
                        y: y + (rowSize.height - sizes[index].height) / 2
                    )
                    x -= spacing
                }
            }
            y += rowSize.height + spacing
        }
    }

    private func rowSize(_ row: [Int], sizes: [CGSize]) -> CGSize {
        CGSize(
            width: row.map { sizes[$0].width }.reduce(0, +)
                + CGFloat(max(0, row.count - 1)) * spacing,
            height: row.map { sizes[$0].height }.max() ?? 0
        )
    }

    private func place(_ subview: LayoutSubview, size: CGSize, x: CGFloat, y: CGFloat) {
        subview.place(
            at: CGPoint(x: x, y: y),
            anchor: .topLeading,
            proposal: ProposedViewSize(width: size.width, height: size.height)
        )
    }
}

/// Lays out the two action groups against the current parent proposal. On a
/// narrow or large-text proposal, the trailing group moves below rather than
/// shrinking controls or measuring against global screen bounds.
struct ComposerActionLayout: Layout {
    let spacing: CGFloat
    let layoutDirection: LayoutDirection

    static func shouldStack(
        availableWidth: CGFloat,
        leadingWidth: CGFloat,
        trailingWidth: CGFloat,
        spacing: CGFloat
    ) -> Bool {
        leadingWidth > 0 && leadingWidth + spacing + trailingWidth > availableWidth
    }

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        guard subviews.count == 2 else { return .zero }
        let leading = subviews[0].sizeThatFits(.unspecified)
        let naturalTrailing = subviews[1].sizeThatFits(.unspecified)
        let naturalWidth = leading.width + (leading.width > 0 ? spacing : 0) + naturalTrailing.width
        let width = proposal.width ?? naturalWidth
        let stacked = Self.shouldStack(
            availableWidth: width,
            leadingWidth: leading.width,
            trailingWidth: naturalTrailing.width,
            spacing: spacing
        )
        let trailingLimit = stacked
            ? width
            : max(0, width - leading.width - (leading.width > 0 ? spacing : 0))
        let trailing = subviews[1].sizeThatFits(
            ProposedViewSize(width: trailingLimit, height: nil)
        )
        let height = stacked
            ? leading.height + spacing + trailing.height
            : max(leading.height, trailing.height)
        return CGSize(width: width, height: height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        guard subviews.count == 2 else { return }
        let leading = subviews[0].sizeThatFits(.unspecified)
        let naturalTrailing = subviews[1].sizeThatFits(.unspecified)
        let stacked = Self.shouldStack(
            availableWidth: bounds.width,
            leadingWidth: leading.width,
            trailingWidth: naturalTrailing.width,
            spacing: spacing
        )
        let trailingLimit = stacked
            ? bounds.width
            : max(0, bounds.width - leading.width - (leading.width > 0 ? spacing : 0))
        let trailing = subviews[1].sizeThatFits(
            ProposedViewSize(width: trailingLimit, height: nil)
        )

        if stacked {
            place(
                subviews[0],
                size: leading,
                x: logicalLeadingX(size: leading, in: bounds),
                y: bounds.minY
            )
            place(
                subviews[1],
                size: trailing,
                x: logicalTrailingX(size: trailing, in: bounds),
                y: bounds.minY + leading.height + spacing
            )
        } else {
            place(
                subviews[0],
                size: leading,
                x: logicalLeadingX(size: leading, in: bounds),
                y: bounds.midY - leading.height / 2
            )
            place(
                subviews[1],
                size: trailing,
                x: logicalTrailingX(size: trailing, in: bounds),
                y: bounds.midY - trailing.height / 2
            )
        }
    }

    private func logicalLeadingX(size: CGSize, in bounds: CGRect) -> CGFloat {
        layoutDirection == .leftToRight ? bounds.minX : bounds.maxX - size.width
    }

    private func logicalTrailingX(size: CGSize, in bounds: CGRect) -> CGFloat {
        layoutDirection == .leftToRight ? bounds.maxX - size.width : bounds.minX
    }

    private func place(_ subview: LayoutSubview, size: CGSize, x: CGFloat, y: CGFloat) {
        subview.place(
            at: CGPoint(x: x, y: y),
            anchor: .topLeading,
            proposal: ProposedViewSize(width: size.width, height: size.height)
        )
    }
}

// MARK: - Purpose-built composer material

enum ComposerGeometry {
    static let maximumWidth: CGFloat = 860
    static let dockHorizontalInset: CGFloat = 8
    static let compactTaskShelfInset: CGFloat = 10
    static let regularTaskShelfInset: CGFloat = 18
    static let joinOverlap: CGFloat = -1
    static let compactFaceRadius: CGFloat = 16
    static let regularFaceRadius: CGFloat = 18
    static let compactFaceHorizontalPadding: CGFloat = 9
    static let regularFaceHorizontalPadding: CGFloat = 12
    static let compactFaceTopPadding: CGFloat = 12
    static let regularFaceTopPadding: CGFloat = 12
    static let compactFaceBottomPadding: CGFloat = 8
    static let regularFaceBottomPadding: CGFloat = 16
    static let compactContentGap: CGFloat = 7
    static let regularContentGap: CGFloat = 10
    static let compactEditorMinimumHeight: CGFloat = 42
    static let regularEditorMinimumHeight: CGFloat = 52
    static let compactEditorHorizontalInset: CGFloat = 4
    static let regularEditorHorizontalInset: CGFloat = 5
    static let actionGap: CGFloat = 5
    static let trailingActionGap: CGFloat = 6
    static let smallControlSize: CGFloat = 44
    static let compactTrailingControlSize: CGFloat = 48
    static let regularTrailingControlSize: CGFloat = 44
    static let recededOpacity = 0.07
    static let recededOffset: CGFloat = 3

    static let frameShadow = DesignDropShadowGeometry(
        radius: 24, y: 22, sourceInset: 0
    )
    static let faceShadow = DesignDropShadowGeometry(
        radius: 32, y: 18, sourceInset: 20
    )
    static let faceAccentShadow = DesignDropShadowGeometry(
        radius: 32, x: 4, y: 19, sourceInset: 25
    )
    static let controlShadow = DesignDropShadowGeometry(
        radius: 14, y: 9, sourceInset: 10
    )
    static let controlGlow = DesignDropShadowGeometry(
        radius: 18, y: 12, sourceInset: 12
    )

    static func taskShelfInset(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular ? regularTaskShelfInset : compactTaskShelfInset
    }

    static func faceRadius(horizontalSizeClass: UserInterfaceSizeClass?) -> CGFloat {
        horizontalSizeClass == .regular ? regularFaceRadius : compactFaceRadius
    }

    static func faceHorizontalPadding(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularFaceHorizontalPadding
            : compactFaceHorizontalPadding
    }

    static func faceTopPadding(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularFaceTopPadding
            : compactFaceTopPadding
    }

    static func faceBottomPadding(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularFaceBottomPadding
            : compactFaceBottomPadding
    }

    static func contentGap(horizontalSizeClass: UserInterfaceSizeClass?) -> CGFloat {
        horizontalSizeClass == .regular ? regularContentGap : compactContentGap
    }

    static func editorMinimumHeight(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularEditorMinimumHeight
            : compactEditorMinimumHeight
    }

    static func editorHorizontalInset(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularEditorHorizontalInset
            : compactEditorHorizontalInset
    }

    static func trailingControlSize(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularTrailingControlSize
            : compactTrailingControlSize
    }
}

private struct ComposerFaceBackground: View {
    let cornerRadius: CGFloat
    let isFocused: Bool
    let isVoiceActive: Bool

    @Environment(\.colorSchemeContrast) private var contrast

    private var emphasized: Bool { isFocused || isVoiceActive }

    var body: some View {
        GeometryReader { proxy in
            let overflow = max(
                ComposerCanvasDrawing.overflow(for: [
                    ComposerGeometry.faceShadow,
                    ComposerGeometry.faceAccentShadow,
                ]),
                DesignCanvasEffects.overflow(
                    blur: ComposerGeometry.frameShadow.radius * 2,
                    y: ComposerGeometry.frameShadow.y
                )
            )
            let faceRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height
            )
            let facePath = ComposerCanvasDrawing.roundedPath(
                in: faceRect,
                cornerRadius: cornerRadius
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: true) { context, _ in
                ComposerCanvasDrawing.drawShadow(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: DuskColors.bgSunk.opacity(0.82),
                    geometry: ComposerGeometry.frameShadow,
                    // CSS filter drop-shadow authors sigma directly; the
                    // shared box-shadow helper accepts CSS blur instead.
                    blur: ComposerGeometry.frameShadow.radius * 2
                )
                ComposerCanvasDrawing.drawShadow(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: Color.black.opacity(0.97),
                    geometry: ComposerGeometry.faceShadow
                )
                ComposerCanvasDrawing.drawShadow(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: DuskColors.accent.opacity(emphasized ? 0.64 : 0.48),
                    geometry: DesignDropShadowGeometry(
                        radius: ComposerGeometry.faceAccentShadow.radius,
                        x: ComposerGeometry.faceAccentShadow.x,
                        y: ComposerGeometry.faceAccentShadow.y,
                        sourceInset: emphasized ? 20 : ComposerGeometry.faceAccentShadow.sourceInset
                    )
                )
                ComposerCanvasDrawing.drawContact(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: DuskColors.bgSunk.opacity(0.95),
                    y: 2
                )

                ComposerCanvasDrawing.fillLinear(
                    facePath,
                    in: &context,
                    rect: faceRect,
                    cssDegrees: 118,
                    stops: [
                        .init(color: DuskColors.paper.overlaying(DuskColors.ink4, opacity: 0.06), location: 0),
                        .init(color: DuskColors.paper, location: 0.48),
                        .init(color: DuskColors.paper.overlaying(DuskColors.accentSoft, opacity: 0.04), location: 1),
                    ]
                )
                ComposerCanvasDrawing.fillEllipticalRadial(
                    facePath,
                    in: &context,
                    center: CGPoint(
                        x: faceRect.minX + faceRect.width * 0.84,
                        y: faceRect.minY + faceRect.height * 0.08
                    ),
                    radii: CGSize(
                        width: max(faceRect.width, faceRect.height) * 0.34,
                        height: max(faceRect.width, faceRect.height) * 0.34
                    ),
                    stops: [
                        .init(color: DuskColors.accent.opacity(0.05), location: 0),
                        .init(color: DuskColors.accent.opacity(0), location: 1),
                    ]
                )
                ComposerCanvasDrawing.fillEllipticalRadial(
                    facePath,
                    in: &context,
                    center: CGPoint(x: faceRect.midX, y: faceRect.minY + faceRect.height * 0.52),
                    radii: CGSize(width: faceRect.width * 0.72, height: faceRect.height * 1.15),
                    stops: [
                        .init(color: DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.26), location: 0),
                        .init(color: DuskColors.paper.opacity(0), location: 0.70),
                    ]
                )
                ComposerCanvasDrawing.fillLinear(
                    facePath,
                    in: &context,
                    rect: faceRect,
                    cssDegrees: 108,
                    stops: [
                        .init(color: DuskColors.ink.opacity(0), location: 0.40),
                        .init(color: DuskColors.ink.opacity(0.015), location: 0.49),
                        .init(color: DuskColors.ink.opacity(0), location: 0.58),
                    ]
                )
                ComposerCanvasDrawing.fillEllipticalRadial(
                    facePath,
                    in: &context,
                    center: CGPoint(
                        x: faceRect.minX + faceRect.width * 0.82,
                        y: faceRect.minY + faceRect.height * 1.12
                    ),
                    radii: CGSize(width: faceRect.width * 0.44, height: faceRect.height * 0.56),
                    stops: [
                        .init(color: DuskColors.accent.opacity(0.05), location: 0),
                        .init(color: DuskColors.accent.opacity(0), location: 0.72),
                    ]
                )

                context.stroke(
                    ComposerCanvasDrawing.roundedPath(
                        in: faceRect,
                        cornerRadius: cornerRadius,
                        inset: DesignMetrics.hairline / 2
                    ),
                    with: .color(
                        emphasized
                            ? DuskColors.line.overlaying(DuskColors.accent, opacity: 0.46)
                            : (contrast == .increased ? DuskColors.ink3 : DuskColors.line)
                    ),
                    lineWidth: DesignMetrics.hairline
                )
                ComposerCanvasDrawing.drawTopLight(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: DuskColors.ink.opacity(0.16)
                )
            }
            .frame(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private enum ComposerCanvasDrawing {
    static func overflow(for geometries: [DesignDropShadowGeometry]) -> CGFloat {
        geometries.map {
            $0.sourceInset + $0.radius + max(abs($0.x), abs($0.y))
        }.max() ?? 0
    }

    static func roundedPath(
        in rect: CGRect,
        cornerRadius: CGFloat,
        inset: CGFloat = 0
    ) -> Path {
        guard rect.width - 2 * inset > 0, rect.height - 2 * inset > 0 else {
            return Path()
        }
        return RoundedRectangle(
            cornerRadius: max(0, cornerRadius - inset),
            style: .continuous
        )
        .path(in: rect.insetBy(dx: inset, dy: inset))
    }

    static func drawShadow(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        cornerRadius: CGFloat,
        color: Color,
        geometry: DesignDropShadowGeometry,
        blur: CGFloat? = nil
    ) {
        let source = roundedPath(
            in: faceRect,
            cornerRadius: cornerRadius,
            inset: geometry.sourceInset
        )
        DesignCanvasEffects.outerShadow(
            in: &context,
            sourcePath: source,
            color: color,
            blur: blur ?? geometry.radius,
            x: geometry.x,
            y: geometry.y
        )
    }

    static func drawContact(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        cornerRadius: CGFloat,
        color: Color,
        y: CGFloat
    ) {
        let geometry = DesignDropShadowGeometry(radius: 0, y: y, sourceInset: 1)
        drawShadow(
            in: &context,
            faceRect: faceRect,
            cornerRadius: cornerRadius,
            color: color,
            geometry: geometry
        )
    }

    static func fillLinear(
        _ path: Path,
        in context: inout GraphicsContext,
        rect: CGRect,
        cssDegrees: CGFloat,
        stops: [Gradient.Stop]
    ) {
        let radians = cssDegrees * .pi / 180
        let direction = CGVector(dx: sin(radians), dy: -cos(radians))
        let extent = (abs(direction.dx) * rect.width + abs(direction.dy) * rect.height) / 2
        context.fill(path, with: .linearGradient(
            Gradient(stops: stops),
            startPoint: CGPoint(
                x: rect.midX - direction.dx * extent,
                y: rect.midY - direction.dy * extent
            ),
            endPoint: CGPoint(
                x: rect.midX + direction.dx * extent,
                y: rect.midY + direction.dy * extent
            )
        ))
    }

    static func fillEllipticalRadial(
        _ clipPath: Path,
        in context: inout GraphicsContext,
        center: CGPoint,
        radii: CGSize,
        stops: [Gradient.Stop]
    ) {
        guard radii.width > 0, radii.height > 0 else { return }
        var radial = context
        radial.clip(to: clipPath)
        radial.translateBy(x: center.x, y: center.y)
        radial.scaleBy(x: radii.width, y: radii.height)
        radial.fill(
            Path(CGRect(x: -1, y: -1, width: 2, height: 2)),
            with: .radialGradient(
                Gradient(stops: stops),
                center: .zero,
                startRadius: 0,
                endRadius: 1
            )
        )
    }

    static func drawTopLight(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        cornerRadius: CGFloat,
        color: Color
    ) {
        let inner = roundedPath(
            in: faceRect,
            cornerRadius: cornerRadius,
            inset: DesignMetrics.hairline
        )
        var translated = Path()
        translated.addPath(
            inner,
            transform: CGAffineTransform(translationX: 0, y: DesignMetrics.hairline)
        )
        var difference = inner
        difference.addPath(translated)

        var highlight = context
        highlight.clip(to: inner)
        highlight.fill(difference, with: .color(color), style: FillStyle(eoFill: true))
    }
}

private enum ComposerControlTone {
    case quiet
    case toggleOn
    case send
    case stop
}

private struct ComposerControlButtonStyle: ButtonStyle {
    let tone: ComposerControlTone
    let size: CGFloat

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var isFocused
    @ComposerReduceMotion private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(foregroundColor)
            .frame(width: size, height: size)
            .background { controlFace(pressed: configuration.isPressed) }
            .overlay(alignment: .topTrailing) {
                if tone == .toggleOn, isEnabled {
                    Circle()
                        .fill(DuskColors.ink)
                        .frame(width: 6, height: 6)
                        .overlay {
                            Circle().stroke(DuskColors.accent, lineWidth: 2)
                        }
                        .padding(5)
                }
            }
            .contentShape(shape)
            .offset(y: configuration.isPressed && !reduceMotion ? 1 : 0)
            .animation(
                reduceMotion ? nil : .easeOut(duration: DesignV2.Motion.feedback),
                value: configuration.isPressed
            )
    }

    private var baseColor: Color {
        guard isEnabled else {
            return DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.45)
        }
        switch tone {
        case .quiet:
            return DuskColors.paper.overlaying(DuskColors.ink2, opacity: 0.09)
        case .toggleOn, .send:
            return DuskColors.accent
        case .stop:
            return DuskColors.paper.overlaying(DuskColors.stop, opacity: 0.5)
        }
    }

    private var foregroundColor: Color {
        guard isEnabled else { return DuskColors.ink4 }
        switch tone {
        case .quiet:
            return DuskColors.ink2
        case .toggleOn, .send:
            return DuskColors.bgSunk
        case .stop:
            return DuskColors.ink
        }
    }

    private func controlFace(pressed: Bool) -> some View {
        ComposerControlCanvas(
            tone: tone,
            baseColor: pressed
                ? baseColor.overlaying(DuskColors.bgSunk, opacity: 0.18)
                : baseColor,
            isEnabled: isEnabled,
            isPressed: pressed,
            isFocused: isFocused,
            increasedContrast: contrast == .increased
        )
    }
}

private struct ComposerControlCanvas: View {
    let tone: ComposerControlTone
    let baseColor: Color
    let isEnabled: Bool
    let isPressed: Bool
    let isFocused: Bool
    let increasedContrast: Bool

    private let cornerRadius: CGFloat = 10

    var body: some View {
        GeometryReader { proxy in
            let overflow = ComposerCanvasDrawing.overflow(for: [
                ComposerGeometry.controlShadow,
                ComposerGeometry.controlGlow,
                DesignMaterialShadowGeometry.slatePressed,
            ])
            let faceRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height
            )
            let facePath = ComposerCanvasDrawing.roundedPath(
                in: faceRect,
                cornerRadius: cornerRadius
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: true) { context, _ in
                if isPressed {
                    ComposerCanvasDrawing.drawShadow(
                        in: &context,
                        faceRect: faceRect,
                        cornerRadius: cornerRadius,
                        color: Color.black.opacity(0.88),
                        geometry: DesignMaterialShadowGeometry.slatePressed
                    )
                } else {
                    ComposerCanvasDrawing.drawShadow(
                        in: &context,
                        faceRect: faceRect,
                        cornerRadius: cornerRadius,
                        color: Color.black.opacity(isEnabled ? 0.72 : 0.42),
                        geometry: ComposerGeometry.controlShadow
                    )
                    if tone != .quiet, isEnabled {
                        ComposerCanvasDrawing.drawShadow(
                            in: &context,
                            faceRect: faceRect,
                            cornerRadius: cornerRadius,
                            color: tone == .stop
                                ? DuskColors.stop.opacity(0.62)
                                : DuskColors.accent.opacity(0.66),
                            geometry: ComposerGeometry.controlGlow
                        )
                    }
                }
                ComposerCanvasDrawing.drawContact(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: DuskColors.bgSunk.opacity(0.92),
                    y: isPressed ? 1 : 2
                )

                context.fill(facePath, with: .color(baseColor))
                ComposerCanvasDrawing.fillEllipticalRadial(
                    facePath,
                    in: &context,
                    center: CGPoint(x: faceRect.midX, y: faceRect.minY + faceRect.height * 0.52),
                    radii: CGSize(width: faceRect.width * 0.82, height: faceRect.height * 1.05),
                    stops: [
                        .init(
                            color: baseColor.overlaying(
                                DuskColors.bgSunk,
                                opacity: isEnabled ? 0.22 : 0.16
                            ),
                            location: 0
                        ),
                        .init(
                            color: baseColor.overlaying(DuskColors.bgSunk, opacity: 0.10),
                            location: 0.50
                        ),
                        .init(color: baseColor, location: 1),
                    ]
                )
                context.stroke(
                    ComposerCanvasDrawing.roundedPath(
                        in: faceRect,
                        cornerRadius: cornerRadius,
                        inset: DesignMetrics.hairline / 2
                    ),
                    with: .color(increasedContrast ? DuskColors.ink3 : DuskColors.lineSoft),
                    lineWidth: DesignMetrics.hairline
                )

                if isPressed {
                    DesignCanvasEffects.insetShadow(
                        in: &context,
                        facePath: facePath,
                        sourcePath: facePath,
                        color: DuskColors.bgSunk.opacity(0.42),
                        blur: 3,
                        y: 2
                    )
                } else {
                    ComposerCanvasDrawing.drawTopLight(
                        in: &context,
                        faceRect: faceRect,
                        cornerRadius: cornerRadius,
                        color: DuskColors.ink.opacity(0.17)
                    )
                }

                if isFocused {
                    context.stroke(
                        ComposerCanvasDrawing.roundedPath(
                            in: faceRect,
                            cornerRadius: cornerRadius,
                            inset: -3
                        ),
                        with: .color(DuskColors.accent),
                        lineWidth: DesignMetrics.focusRing
                    )
                }
            }
            .frame(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
