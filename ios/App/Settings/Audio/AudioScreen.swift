// ---------------------------------------------------------------------------
// AudioScreen — Soul-group "Audio" category page (scaffold stub).
//
// Page-agent target: "Speak responses (TTS)" toggle + "Reply channel" segmented
// (voice/text), FAST save (PUT profile + live `settings.applyProfileChange` WS
// patch, no restart). Nav + settings scope already threaded; fill this file only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct AudioScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Audio",
            screenId: "settings-audio",
            summary: "Speak responses (TTS) toggle + reply channel (voice / text)."
        )
    }
}
