// ---------------------------------------------------------------------------
// AdvancedViewModel — Advanced settings page ViewModel (scaffold placeholder, P3a).
// A later page agent adds the advanced/compression slow-save usecases
// (SettingsComponent / ApplyProfileChangeUseCase) + slider state. Registered in
// AppModule as `viewModel { AdvancedViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.advanced

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class AdvancedViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "advanced-vm")

    init {
        log.info("stub")
    }
}
