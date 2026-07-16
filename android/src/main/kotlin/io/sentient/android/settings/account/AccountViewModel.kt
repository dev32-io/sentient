// ---------------------------------------------------------------------------
// AccountViewModel — Account settings page ViewModel (scaffold placeholder, P3a). A
// later page agent adds the rename / change-PIN usecases (SettingsComponent.account)
// + form state. Registered in AppModule as `viewModel { AccountViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.account

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class AccountViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "account-vm")

    init {
        log.info("stub")
    }
}
