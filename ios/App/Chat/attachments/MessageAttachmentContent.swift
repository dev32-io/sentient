import SwiftUI
import UIKit

/// Shared pending/committed attachment anatomy. Reserve the existing native
/// image cap before a poster arrives; document rows don't allocate an image well.
/// Preview and transfer authority remain with the enclosing native buttons.
struct MessageAttachmentContent: View {
    let displayName: String
    let detail: String
    let isImage: Bool
    let iconName: String
    let preview: UIImage?
    var uploadProgress: Double? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if isImage {
                Group {
                    if let preview {
                        Image(uiImage: preview).resizable().scaledToFit()
                    } else {
                        Image(systemName: iconName)
                            .font(.system(size: 30))
                            .foregroundStyle(DuskColors.accent)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 260)
                .background(DuskColors.bgSunk, in: RoundedRectangle(cornerRadius: 8))
                .clipped()
                .accessibilityHidden(true)
            }
            HStack(spacing: Space.sm) {
                Image(systemName: iconName)
                    .foregroundStyle(DuskColors.accent)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName)
                        .font(Typo.ui(TypeScale.sm, .semibold))
                        .foregroundStyle(DuskColors.ink)
                        .lineLimit(2)
                    Text(detail)
                        .font(Typo.ui(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink2)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.ink2)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
            if let uploadProgress {
                ProgressView(value: uploadProgress)
                    .tint(DuskColors.accent)
                    .accessibilityHidden(true) // Enclosing action exposes per-file value.
            }
        }
        .padding(Space.sm)
        .background(DuskColors.paper.opacity(0.72), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8).stroke(DuskColors.lineSoft, lineWidth: DesignMetrics.hairline)
        }
        .contentShape(Rectangle())
    }
}
