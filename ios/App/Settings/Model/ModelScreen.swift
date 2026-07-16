// ---------------------------------------------------------------------------
// ModelScreen — Soul-group "Model" category page (scaffold stub).
//
// Page-agent target: provider segmented + model search + single-select model card
// list, SLOW save (PUT profile + `settings.applyProfileChange` apply-with-restart).
// Nav + settings scope already threaded; fill this file only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct ModelScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Model",
            screenId: "settings-model",
            summary: "Provider and model picker."
        )
    }
}
