import SwiftUI

/// Static visual inventory only. These previews intentionally construct no screen
/// ViewModel, permission provider, recorder, player, or network service.
private struct VoiceStatePreviewGallery: View {
    var body: some View {
        ScrollView {
            VStack(spacing: Space.lg) {
                DesignGroupHeader(title: "Library states")
                AsyncNotice(kind: .loading, title: "Loading voices")
                AsyncNotice(kind: .empty, title: "No voices match")
                AsyncNotice(kind: .error, title: "Couldn't load voices")
                AsyncNotice(kind: .success, title: "Voice selected")
                VoiceRowView(
                    name: "Active family voice", lang: "en", source: "Yours", tags: ["warm", "calm"],
                    isSelected: true, accessory: .activePill, accessibilityId: "preview-voice-active",
                    onSelect: {}, onPlay: {}, onDelete: {}
                )
                VoiceRowView(
                    name: "Preview loading", isLoading: true, accessibilityId: "preview-voice-loading",
                    onSelect: {}, onPlay: {}
                )
                VoiceRowView(
                    name: "Preview playing", isPlaying: true, accessibilityId: "preview-voice-playing",
                    onSelect: {}, onPlay: {}
                )

                DesignGroupHeader(title: "Add and upload states")
                AsyncNotice(kind: .empty, title: "Choose a voice sample")
                AsyncNotice(kind: .warning, title: VoiceUploadValidation.unsupportedMessage)
                AsyncNotice(kind: .loading, title: "Creating voice")
                AsyncNotice(kind: .success, title: "Voice created")
                AsyncNotice(kind: .error, title: "Couldn't create voice")

                DesignGroupHeader(title: "Fish states")
                AsyncNotice(kind: .loading, title: "Loading the Fish library")
                AsyncNotice(kind: .empty, title: "No Fish voices match")
                AsyncNotice(kind: .warning, title: "Fish cloning isn't available")
                AsyncNotice(kind: .error, title: "Couldn't reach the Fish library")
                AsyncNotice(kind: .loading, title: "Cloning voice")
                AsyncNotice(kind: .success, title: "Voice cloned")
            }
            .padding(Space.lg)
        }
        .background(DuskColors.bg)
    }
}

#Preview("Voice state inventory — no audio") {
    VoiceStatePreviewGallery()
        .transaction { $0.disablesAnimations = true }
        .preferredColorScheme(.dark)
}

#Preview("Voice state inventory — accessibility size") {
    VoiceStatePreviewGallery()
        .environment(\.dynamicTypeSize, .accessibility3)
        .transaction { $0.disablesAnimations = true }
        .preferredColorScheme(.dark)
}
