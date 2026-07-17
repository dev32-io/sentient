// ---------------------------------------------------------------------------
// SettingsRootViewModel — the thin state-holder for the root Settings list.
//
// Its only job is to resolve the access flags (isAdmin, fishBrowseEnabled) so the
// root list can gate the Admin group. It collects the single combine usecase
// (ObserveSettingsAccessUseCase) resolved from the connection scope; the fold /
// degrade rules live in that usecase, not here (thin VM per the architecture rule).
// ---------------------------------------------------------------------------
package io.sentient.android.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.ObserveSettingsAccessUseCase
import io.sentient.mobiledata.usecase.settings.SettingsAccess
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Drives the root Settings list's access gate. [observeAccess] is resolved from the
 * connection-scoped SettingsComponent. [access] is null while loading; a failure
 * leaves it null (the Admin group simply stays hidden — never blocks the list).
 */
class SettingsRootViewModel(
    private val observeAccess: ObserveSettingsAccessUseCase,
) : ViewModel() {
    private val log = createLogger("android", "settings-root-viewmodel")

    private val _access = MutableStateFlow<SettingsAccess?>(null)

    /** Root-page access flags; null until the first resolve (or on failure). */
    val access: StateFlow<SettingsAccess?> = _access.asStateFlow()

    init {
        refresh()
    }

    /** (Re)load the access flags. Never throws — the usecase returns a typed result. */
    fun refresh() {
        viewModelScope.launch {
            when (val r = observeAccess()) {
                is SentientResult.Success -> {
                    _access.value = r.data
                    log.info("access.loaded", mapOf("isAdmin" to r.data.isAdmin))
                }
                is SentientResult.Failure -> log.warn("access.failed", mapOf("kind" to r.error.kind))
                is SentientResult.Loading -> Unit
            }
        }
    }
}
