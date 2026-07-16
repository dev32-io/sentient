// ---------------------------------------------------------------------------
// AddVoiceScreen — Add-Voice sub-page (scaffold placeholder, P3a). Reached from
// VoiceScreen; a later page agent fills the record/upload + name/description/tags/
// language form + multipart submit, using [AddVoiceViewModel]. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun AddVoiceScreen(
    vm: AddVoiceViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Add Voice",
        onBack = onBack,
        screenTestTag = "settings-voice-add-screen",
        backTestTag = "settings-voice-add-back",
        modifier = modifier,
    )
}
