// ---------------------------------------------------------------------------
// DevicesScreen — User-group "Devices" category page (scaffold stub).
//
// Page-agent target: the Signal card — linked → account + date + Unlink(confirm);
// unlinked → Link (deep-link button + copy URI + status poll + cancel) over
// `settings.devices`. QR is dropped on-device (same-device linking). Nav + settings
// scope already threaded; fill this file only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct DevicesScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Devices",
            screenId: "settings-devices",
            summary: "Signal linking — link or unlink."
        )
    }
}
