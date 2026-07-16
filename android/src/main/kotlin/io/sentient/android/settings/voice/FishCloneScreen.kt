// ---------------------------------------------------------------------------
// FishCloneScreen — Clone-from-Fish sub-page (scaffold placeholder, P3a). Reached
// from VoiceScreen (gated on features.fish_browse_enabled by the page agent). A
// later page agent fills the browse/search → play sample → clone flow using
// [FishCloneViewModel]. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun FishCloneScreen(
    vm: FishCloneViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Clone from Fish",
        onBack = onBack,
        screenTestTag = "settings-voice-fish-screen",
        backTestTag = "settings-voice-fish-back",
        modifier = modifier,
    )
}
