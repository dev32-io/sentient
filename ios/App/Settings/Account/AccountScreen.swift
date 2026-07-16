// ---------------------------------------------------------------------------
// AccountScreen — User-group "Account" category page (scaffold stub).
//
// Page-agent target: display-name field + save, change-PIN dialog (current + new
// 4-digit) over `settings.account`. NO sign-out here — logout stays the root danger
// row. Nav + settings scope already threaded; fill this file only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct AccountScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Account",
            screenId: "settings-account",
            summary: "Display name and change PIN."
        )
    }
}
