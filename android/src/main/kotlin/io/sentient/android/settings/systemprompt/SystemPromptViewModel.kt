// ---------------------------------------------------------------------------
// SystemPromptViewModel — System Prompt page ViewModel (scaffold placeholder, P3a).
// A later page agent adds the soul get/put/default + slow-save usecases
// (SettingsComponent / ApplyProfileChangeUseCase) + draft state. Registered in
// AppModule as `viewModel { SystemPromptViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.systemprompt

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class SystemPromptViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "system-prompt-vm")

    init {
        log.info("stub")
    }
}
