// ---------------------------------------------------------------------------
// TranscriptPreview — live STT preview overlay while voiceMode is .active.
// Mirrors the webui .chat-view__transcript and the Android TranscriptPreview:
// an accent left-rule + italic, muted text. Hidden when empty (the host gates
// on `transcriptVisible`).
// ---------------------------------------------------------------------------
import SwiftUI

struct TranscriptPreview: View {
    let text: String

    var body: some View {
        HStack(alignment: .center, spacing: Space.sm) {
            RoundedRectangle(cornerRadius: 1)
                .fill(DuskColors.accent)
                .frame(width: 2, height: TypeScale.base)
            Text(text)
                .font(.system(size: TypeScale.base).italic())
                .foregroundStyle(DuskColors.ink3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .accessibilityIdentifier("voice-transcript")
    }
}
