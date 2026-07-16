// ---------------------------------------------------------------------------
// SecretsViewModel — Secrets (admin) page ViewModel (scaffold placeholder, P3a). A
// later page agent adds the admin secrets get/put/active usecases
// (SettingsComponent.admin) + masked-row state (never echo keys). Registered in
// AppModule as `viewModel { SecretsViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.secrets

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class SecretsViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "secrets-vm")

    init {
        log.info("stub")
    }
}
