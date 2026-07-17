// ---------------------------------------------------------------------------
// RowToggle — label (+ optional sub) with a trailing Toggle, tinted with the
// Dusk accent token. Transcribed from the webui Row + Toggle primitives
// (components/settings/primitives/row.tsx + toggle.tsx) but rides the native
// SwiftUI `Toggle` control ("trailing Toggle tinted with token colors" per
// the mobile-settings-parity plan) rather than a fully custom pill, matching
// platform-native affordances (VoiceOver, Dynamic Type, hit-testing) for
// free.
//
// Stateless leaf: `isOn` + `onChange` in, no local state, no ViewModel.
// ---------------------------------------------------------------------------
import SwiftUI

struct RowToggle: View {
    let label: String
    var sub: String?
    let isOn: Bool
    let accessibilityId: String
    let onChange: (Bool) -> Void

    var body: some View {
        HStack(alignment: .center, spacing: Space.lg) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(label)
                    .font(Typo.ui(TypeScale.sm, .medium))
                    .foregroundStyle(DuskColors.ink)
                if let sub {
                    Text(sub)
                        .font(Typo.ui(TypeScale.xs))
                        .foregroundStyle(DuskColors.ink3)
                }
            }
            Spacer(minLength: Space.sm)
            Toggle("", isOn: Binding(get: { isOn }, set: onChange))
                .labelsHidden()
                .tint(DuskColors.accent)
        }
        .padding(.vertical, Space.sm)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(accessibilityId)
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
