// ---------------------------------------------------------------------------
// FishCloneViewModel — Clone-from-Fish sub-page ViewModel (scaffold placeholder,
// P3a). A later page agent adds the Fish browse/search/clone usecases
// (SettingsComponent.voices) and the browse state. Registered in AppModule as
// `viewModel { FishCloneViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class FishCloneViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "fish-clone-vm")

    init {
        log.info("stub")
    }
}
