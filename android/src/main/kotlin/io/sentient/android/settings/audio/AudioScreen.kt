// ---------------------------------------------------------------------------
// AudioScreen — Audio settings page: "Speak responses (TTS)" toggle + "Reply
// channel" segmented (voice/text). FAST save (no restart copy) — the VM's PutProfile
// takes the audio-only fast path. Save appears iff dirty; back-with-dirty prompts
// discard (shared SettingsEditChrome). Copy mirrors webui audio-pane.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.audio

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.ApplyProgress
import io.sentient.android.settings.components.RowSegmented
import io.sentient.android.settings.components.RowToggle
import io.sentient.android.settings.components.SegmentOption
import io.sentient.android.settings.components.SettingsCard
import io.sentient.android.settings.components.SettingsEditScaffold
import io.sentient.android.settings.components.SettingsLoadStatus
import io.sentient.android.settings.components.SettingsPaneSub
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.settings.ProfileEnums

private const val HEAD_SUB =
    "How Sentient delivers replies. Both settings persist across sessions and devices, " +
        "and take effect on the next reply."

private val CHANNEL_OPTIONS = listOf(
    SegmentOption(ProfileEnums.audioChannels[0], "Voice"),
    SegmentOption(ProfileEnums.audioChannels[1], "Text"),
)

@Composable
fun AudioScreen(
    vm: AudioViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.ui.collectAsStateWithLifecycle()
    SettingsEditScaffold(
        title = "Audio",
        screenTestTag = "settings-audio-screen",
        backTestTag = "settings-audio-back",
        saveTestTag = "settings-audio-save",
        dirty = state.dirty,
        apply = ApplyProgress(saving = state.saving, alreadyApplying = state.alreadyApplying, error = state.applyError),
        onBack = onBack,
        onSave = vm::save,
        modifier = modifier,
    ) {
        AudioBody(state = state, onTts = vm::setTts, onChannel = vm::setChannel)
    }
}

@Composable
private fun ColumnScope.AudioBody(
    state: AudioUiState,
    onTts: (Boolean) -> Unit,
    onChannel: (String) -> Unit,
) {
    val draft = state.draft
    if (draft == null) {
        SettingsLoadStatus(loading = state.loading, error = state.loadError)
        return
    }
    val enabled = !state.saving
    SettingsPaneSub(HEAD_SUB)
    SettingsCard(title = "Output") {
        RowToggle(
            label = "Speak responses (TTS)",
            sub = "When off, replies are silent — text still streams to chat.",
            checked = draft.audio.ttsEnabled,
            onCheckedChange = onTts,
            enabled = enabled,
            testTag = "settings-audio-tts",
        )
        ChannelRow(channel = draft.audio.channel, enabled = enabled, onChannel = onChannel)
    }
}

@Composable
private fun ChannelRow(channel: String, enabled: Boolean, onChannel: (String) -> Unit) {
    val tokens = LocalTokens.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
        verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        Text(text = "Reply channel", color = Color(Colors.ink), fontSize = tokens.type.base)
        Text(
            text = "Voice plays audio alongside chat. Text suppresses audio entirely.",
            color = Color(Colors.ink3),
            fontSize = tokens.type.xs,
        )
        RowSegmented(
            options = CHANNEL_OPTIONS,
            selected = channel,
            onSelect = onChannel,
            enabled = enabled,
            testTag = "settings-audio-channel",
        )
    }
}

@Preview
@Composable
private fun AudioScreenPreview() {
    SentientTheme {
        Column {
            SettingsTopBar(title = "Audio", onBack = {})
            SettingsCard(title = "Output") {
                RowToggle(label = "Speak responses (TTS)", checked = true, onCheckedChange = {})
            }
        }
    }
}
