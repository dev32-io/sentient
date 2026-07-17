// ---------------------------------------------------------------------------
// ObserveSettingsAccessUseCase — combines the two gate inputs the root settings
// page needs into one access-flags value: `isAdmin` (from account me) drives the
// Admin group; `fishBrowseEnabled` (from services/versions features) drives the
// "Clone from Fish" entry.
//
// Fold rules (this is a real combine, hence a usecase not a repo):
//   - me MUST resolve — without it we can't gate Admin, so its failure propagates.
//   - services/versions is best-effort — if it fails, the Fish entry degrades to
//     hidden (fishBrowseEnabled=false) but access still resolves. Never block the
//     whole settings surface on the optional feature-flag read.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.AccountRepository
import io.sentient.mobiledata.data.settings.VoicesRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.log.createLogger

/** Root-page access flags derived from account identity + gateway feature flags. */
data class SettingsAccess(
    val isAdmin: Boolean,
    val fishBrowseEnabled: Boolean,
)

class ObserveSettingsAccessUseCase(
    private val account: AccountRepository,
    private val voices: VoicesRepository,
) {
    private val log = createLogger("data", "settings", "access")

    suspend operator fun invoke(): SentientResult<SettingsAccess> {
        val me = account.me()
        when (me) {
            is SentientResult.Failure -> {
                log.warn("me.failed", mapOf("kind" to me.error.kind))
                return SentientResult.Failure(me.error)
            }
            is SentientResult.Loading -> return SentientResult.Loading()
            is SentientResult.Success -> Unit
        }
        val isAdmin = me.data.user.isAdmin
        val fishBrowseEnabled = when (val versions = voices.servicesVersions()) {
            is SentientResult.Success -> versions.data.features.fishBrowseEnabled
            else -> {
                log.warn("versions.degraded", mapOf("reason" to "fish-hidden"))
                false
            }
        }
        log.info("access", mapOf("isAdmin" to isAdmin, "fishBrowseEnabled" to fishBrowseEnabled))
        return SentientResult.Success(SettingsAccess(isAdmin, fishBrowseEnabled))
    }
}
