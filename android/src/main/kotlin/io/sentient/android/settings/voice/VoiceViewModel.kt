// ---------------------------------------------------------------------------
// VoiceViewModel — Voice settings page ViewModel (scaffold placeholder, P3a). A
// later page agent adds the voices list / preview / pick / delete usecases (resolved
// from SettingsComponent.voices in AppModule) and the filter state. Registered in
// AppModule as `viewModel { VoiceViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class VoiceViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "voice-vm")

    init {
        log.info("stub")
    }
}
