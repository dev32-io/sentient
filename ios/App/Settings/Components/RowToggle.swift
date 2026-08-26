import SwiftUI

/// Compatibility facade for the callback-based toggle row API.
struct RowToggle: View {
    let label: String
    var sub: String?
    let isOn: Bool
    let accessibilityId: String
    let onChange: (Bool) -> Void

    var body: some View {
        DesignToggleRow(
            title: label,
            detail: sub,
            isOn: Binding(get: { isOn }, set: onChange),
            accessibilityId: accessibilityId
        )
    }
}

#Preview {
    VStack(spacing: 0) {
        RowToggle(
            label: "Speak responses (TTS)",
            sub: "Play assistant replies aloud",
            isOn: true,
            accessibilityId: "settings-audio-tts",
            onChange: { _ in }
        )
        RowToggle(
            label: "Prompt-injection scanning",
            isOn: false,
            accessibilityId: "settings-advanced-scan",
            onChange: { _ in }
        )
    }
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
