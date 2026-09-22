import SwiftUI

struct AttachmentSourceSheet: View {
    enum CameraIssue: Equatable {
        case denied, restricted, unavailable, captureFailed, photoFailed, attachmentLimit
    }

    let cameraIssue: CameraIssue?
    let onCamera: () -> Void
    let onPhotos: () -> Void
    let onFiles: () -> Void
    let onOpenSettings: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    if let cameraIssue {
                        cameraNotice(cameraIssue)
                    }
                    DesignCard {
                        DesignCategoryRow(
                            icon: .sfSymbol("camera"),
                            title: "Camera",
                            accessibilityId: "attachment-camera",
                            onTap: onCamera
                        )
                        .accessibilityHint("Take a new photo")
                        DesignDivider()
                        DesignCategoryRow(
                            icon: .sfSymbol("photo.on.rectangle"),
                            title: "Photos",
                            accessibilityId: "attachment-photos",
                            onTap: onPhotos
                        )
                        .accessibilityHint("Choose one or more images")
                        DesignDivider()
                        DesignCategoryRow(
                            icon: .sfSymbol("folder"),
                            title: "Files",
                            accessibilityId: "attachment-files",
                            onTap: onFiles
                        )
                        .accessibilityHint("Choose images, PDFs, text, or code")
                    }
                }
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.sm)
            }
            .background(DuskColors.bg)
            .navigationTitle("Attach")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(DuskColors.paper)
        .duskTheme()
    }

    @ViewBuilder
    private func cameraNotice(_ issue: CameraIssue) -> some View {
        switch issue {
        case .denied:
            settingsNotice(
                title: "Camera access is off",
                detail: "Allow camera access in Settings, then try again."
            )
        case .restricted:
            settingsNotice(
                title: "Camera access is restricted",
                detail: "Check device restrictions and Camera access in Settings."
            )
        case .unavailable:
            AsyncNotice(
                kind: .warning,
                title: "Camera unavailable",
                detail: "Use Photos or Files on this device."
            )
        case .captureFailed:
            AsyncNotice(
                kind: .error,
                title: "Photo couldn't be prepared",
                detail: "Try taking the photo again."
            )
        case .photoFailed:
            AsyncNotice(
                kind: .error,
                title: "Some photos couldn't be added",
                detail: "Choose compatible images and try again."
            )
        case .attachmentLimit:
            AsyncNotice(
                kind: .warning,
                title: "Attachment limit reached",
                detail: "Attach up to \(AttachmentImportPolicy.maximumPerMessage) files. Remove an attachment before adding more."
            )
        }
    }

    private func settingsNotice(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            AsyncNotice(kind: .warning, title: title, detail: detail)
            DesignActionButton(
                title: "Open Settings",
                role: .quiet,
                accessibilityId: "attachment-camera-settings",
                action: onOpenSettings
            )
        }
    }
}
