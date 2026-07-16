// ---------------------------------------------------------------------------
// VoiceFishScreen — Voice sub-page "Clone from Fish" (scaffold stub), pushed from
// VoiceScreen only when `fishBrowseEnabled`.
//
// Page-agent target: browse/search the Fish library, play a sample, one-tap clone
// over `settings.voices` (Fish endpoints); FeatureDisabled hides the entry upstream.
// Nav + settings scope already threaded; fill this file only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct VoiceFishScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Clone from Fish",
            screenId: "settings-voice-fish",
            summary: "Browse the Fish library, play a sample, and clone a voice."
        )
    }
}
