// ---------------------------------------------------------------------------
// VoiceScreen — Soul-group "Voice" category page (scaffold stub).
//
// Page-agent target: the voice-pack grid (filter / preview / pick active / delete)
// over `settings.voices`, plus entries that PUSH the sub-pages — `onOpen(.settingsVoiceAdd)`
// (record/upload create) and, when `fishBrowseEnabled`, `onOpen(.settingsVoiceFish)`
// (clone from Fish). Both sub-routes are already registered; use `onOpen` to reach
// them — do NOT touch Route.swift or UserSessionHost.swift.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct VoiceScreen: View {
    let settings: SettingsComponent
    /// Push a settings sub-route (Add Voice / Clone from Fish).
    let onOpen: (Route) -> Void
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Voice",
            screenId: "settings-voice",
            summary: "Voice packs — filter, preview, pick active, add or clone a voice."
        )
    }
}
