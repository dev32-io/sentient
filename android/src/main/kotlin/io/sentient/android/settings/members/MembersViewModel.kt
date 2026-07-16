// ---------------------------------------------------------------------------
// MembersViewModel — Members (admin) page ViewModel (scaffold placeholder, P3a). A
// later page agent adds the admin users list/create/patch/delete usecases
// (SettingsComponent.admin) + list state. Registered in AppModule as
// `viewModel { MembersViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.members

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class MembersViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "members-vm")

    init {
        log.info("stub")
    }
}
