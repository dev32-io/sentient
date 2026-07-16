// ---------------------------------------------------------------------------
// DevicesViewModel — Devices settings page ViewModel (scaffold placeholder, P3a). A
// later page agent adds the devices get + signal link/cancel/status/unlink usecases
// (SettingsComponent.devices) + poll-loop state. Registered in AppModule as
// `viewModel { DevicesViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.devices

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class DevicesViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "devices-vm")

    init {
        log.info("stub")
    }
}
