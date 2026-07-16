// ---------------------------------------------------------------------------
// MemoryViewModel — Memory settings page ViewModel (scaffold placeholder, P3a). A
// later page agent adds the memory load/save usecases (SettingsComponent /
// ApplyProfileChangeUseCase) + slot/draft state. Registered in AppModule as
// `viewModel { MemoryViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.memory

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class MemoryViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "memory-vm")

    init {
        log.info("stub")
    }
}
