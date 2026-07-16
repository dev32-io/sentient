// ---------------------------------------------------------------------------
// ModelViewModel — Model settings page ViewModel (scaffold placeholder, P3a). A
// later page agent adds the models catalog + model slow-save usecases
// (SettingsComponent / ApplyProfileChangeUseCase) + selection state. Registered in
// AppModule as `viewModel { ModelViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.model

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class ModelViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "model-vm")

    init {
        log.info("stub")
    }
}
