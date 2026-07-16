// ---------------------------------------------------------------------------
// SecretsScreen — Admin-group "Secrets" category page (scaffold stub).
//
// Admin-only route (gated at the root list on me.isAdmin). Page-agent target: per-
// provider masked key rows, update key, set active, custom base-URL row over
// `settings.admin`. NEVER echo a key. Nav + settings scope already threaded; fill
// this file only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct SecretsScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Secrets",
            screenId: "settings-secrets",
            summary: "Provider API keys and base URLs."
        )
    }
}
