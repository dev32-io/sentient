// ---------------------------------------------------------------------------
// VoiceScreen — Voice settings page (scaffold, P3a). Placeholder body plus the two
// sub-route nav affordances (Add Voice → settings/voice/add, Clone from Fish →
// settings/voice/fish) so the Voice page agent reaches those flows WITHOUT touching
// AppNavHost.kt. [vm] is host-resolved; the page agent fills the body + VoiceViewModel.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import io.sentient.android.settings.components.SettingsStubScaffold
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

private const val TITLE = "Voice"
private const val PLACEHOLDER = "Coming in this branch."
private const val ADD_VOICE = "Add Voice"
private const val CLONE_FISH = "Clone from Fish"

/**
 * Voice page scaffold. [onAddVoice] / [onCloneFish] navigate to the record/upload and
 * Fish-clone sub-pages (pre-wired by the host). [vm] is resolved by the host.
 */
@Composable
fun VoiceScreen(
    vm: VoiceViewModel,
    onBack: () -> Unit,
    onAddVoice: () -> Unit,
    onCloneFish: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = TITLE,
        onBack = onBack,
        screenTestTag = "settings-voice-screen",
        backTestTag = "settings-voice-back",
        modifier = modifier,
    ) {
        val tokens = LocalTokens.current
        Text(text = PLACEHOLDER, color = Color(Colors.ink3), fontSize = tokens.type.base)
        OutlinedButton(
            onClick = onAddVoice,
            modifier = Modifier.fillMaxWidth().testTag("settings-voice-add-nav"),
        ) { Text(ADD_VOICE) }
        OutlinedButton(
            onClick = onCloneFish,
            modifier = Modifier.fillMaxWidth().testTag("settings-voice-fish-nav"),
        ) { Text(CLONE_FISH) }
    }
}
