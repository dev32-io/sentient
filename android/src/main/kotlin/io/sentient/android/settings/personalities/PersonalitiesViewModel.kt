// ---------------------------------------------------------------------------
// PersonalitiesViewModel — Personalities page ViewModel (scaffold placeholder,
// P3a). A later page agent adds the personalities CRUD + activate usecases
// (SettingsComponent) + list state. Registered in AppModule as
// `viewModel { PersonalitiesViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.personalities

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class PersonalitiesViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "personalities-vm")

    init {
        log.info("stub")
    }
}
