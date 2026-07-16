// ---------------------------------------------------------------------------
// AudioScreen — Audio settings page (scaffold placeholder, P3a). A later page agent
// fills the "Speak responses (TTS)" toggle + reply-channel segmented (fast-save via
// the live audio patch) using [AudioViewModel]. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.audio

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun AudioScreen(
    vm: AudioViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Audio",
        onBack = onBack,
        screenTestTag = "settings-audio-screen",
        backTestTag = "settings-audio-back",
        modifier = modifier,
    )
}
