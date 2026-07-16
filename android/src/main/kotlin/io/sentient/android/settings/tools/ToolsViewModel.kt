// ---------------------------------------------------------------------------
// ToolsViewModel — Tools settings page ViewModel (scaffold placeholder, P3a). A
// later page agent adds the mcp-catalog + tools slow-save usecases
// (SettingsComponent / ApplyProfileChangeUseCase) + toggle state. Registered in
// AppModule as `viewModel { ToolsViewModel() }`.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.tools

import androidx.lifecycle.ViewModel
import io.sentient.mobilesdk.log.createLogger

class ToolsViewModel : ViewModel() {
    private val log = createLogger("android", "settings", "tools-vm")

    init {
        log.info("stub")
    }
}
