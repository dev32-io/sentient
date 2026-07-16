// ---------------------------------------------------------------------------
// AddVoiceViewModel — Add-Voice sub-page ViewModel (scaffold placeholder, P3a). A
// later page agent adds the record/upload capture + multipart create usecase
// (SettingsComponent.voices) and the form state. Registered in AppModule as
// `viewModel { AddVoiceViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class AddVoiceViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "add-voice-vm")

    init {
        log.info("stub")
    }
}
