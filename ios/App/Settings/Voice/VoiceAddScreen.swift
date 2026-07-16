// ---------------------------------------------------------------------------
// VoiceAddScreen — Voice sub-page "Add Voice" (scaffold stub), pushed from VoiceScreen.
//
// Page-agent target: record (AVAudioRecorder) OR pick an audio file, playback check,
// name/description/tags/language form, multipart create over `settings.voices`. Nav +
// settings scope already threaded; fill this file only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct VoiceAddScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Add Voice",
            screenId: "settings-voice-add",
            summary: "Record or upload a WAV, name it, and create a voice pack."
        )
    }
}
