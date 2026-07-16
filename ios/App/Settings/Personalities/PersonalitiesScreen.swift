// ---------------------------------------------------------------------------
// PersonalitiesScreen — Soul-group "Personalities" category page (scaffold stub).
//
// Page-agent target: expandable personality cards (activate / delete / create
// name+instructions) over `settings.applyProfileChange` / profile repo. Nav +
// settings scope already threaded; fill this file only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct PersonalitiesScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Personalities",
            screenId: "settings-personalities",
            summary: "Activate, create, and delete personalities."
        )
    }
}
