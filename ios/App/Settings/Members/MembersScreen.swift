// ---------------------------------------------------------------------------
// MembersScreen — Admin-group "Members" category page (scaffold stub).
//
// Admin-only route (gated at the root list on me.isAdmin). Page-agent target: member
// list, promote/demote, delete(confirm), add user (name+PIN wizard, 3-user cap) over
// `settings.admin`. Nav + settings scope already threaded; fill this file only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct MembersScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Members",
            screenId: "settings-members",
            summary: "Manage members — promote, demote, add, remove."
        )
    }
}
