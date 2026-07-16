// ---------------------------------------------------------------------------
// AudioViewModel — Audio settings page ViewModel (scaffold placeholder, P3a). A
// later page agent adds the audio fast-save usecase (ApplyProfileChangeUseCase +
// live audio patch) + toggle state. Registered in AppModule as
// `viewModel { AudioViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.audio

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class AudioViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "audio-vm")

    init {
        log.info("stub")
    }
}
