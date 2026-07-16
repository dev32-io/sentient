// ---------------------------------------------------------------------------
// AudioScreen — Audio settings page: "Speak responses (TTS)" toggle + "Reply
// channel" segmented (voice/text). FAST save (no restart copy) — the VM's PutProfile
// takes the audio-only fast path. Save appears in the header iff dirty; back with a
// dirty draft prompts discard. Copy mirrors webui audio-pane.
//
// The header/apply-notice/discard-dialog helpers are co-located per page: the
// settings pages are built in isolation (concurrent page agents), so each screen
// carries its own compact scaffold rather than sharing a new component file.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.audio

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.RowSegmented
import io.sentient.android.settings.components.RowToggle
import io.sentient.android.settings.components.SegmentOption
import io.sentient.android.settings.components.SettingsCard
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
    AudioEditScaffold(
        dirty = state.dirty,
        saving = state.saving,
        alreadyApplying = state.alreadyApplying,
        applyError = state.applyError,
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
        AudioLoadStatus(loading = state.loading, error = state.loadError)
        return
    }
    val enabled = !state.saving
    PaneSub(HEAD_SUB)
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

// ── Co-located page scaffold (see file header) ──

@Composable
private fun AudioEditScaffold(
    dirty: Boolean,
    saving: Boolean,
    alreadyApplying: Boolean,
    applyError: String?,
    onBack: () -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
    body: @Composable ColumnScope.() -> Unit,
) {
    val tokens = LocalTokens.current
    var confirmDiscard by remember { mutableStateOf(false) }
    val attemptBack: () -> Unit = { if (dirty) confirmDiscard = true else onBack() }
    BackHandler(enabled = true, onBack = attemptBack)
    Column(modifier.fillMaxSize().safeDrawingPadding().testTag("settings-audio-screen")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SettingsTopBar(
                title = "Audio",
                onBack = attemptBack,
                backTestTag = "settings-audio-back",
                modifier = Modifier.weight(1f),
            )
            if (dirty) {
                TextButton(
                    onClick = onSave,
                    enabled = !saving,
                    modifier = Modifier.padding(end = tokens.space.sm).testTag("settings-audio-save"),
                ) {
                    Text("Save", color = Color(Colors.accent), fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            ApplyNotice(saving = saving, restarting = false, alreadyApplying = alreadyApplying, applyError = applyError)
            body()
        }
    }
    if (confirmDiscard) {
        DiscardDialog(
            onConfirm = { confirmDiscard = false; onBack() },
            onDismiss = { confirmDiscard = false },
        )
    }
}

@Composable
private fun PaneSub(text: String) {
    val tokens = LocalTokens.current
    Text(
        text = text,
        modifier = Modifier.padding(bottom = tokens.space.xs),
        color = Color(Colors.ink3),
        fontSize = tokens.type.sm,
    )
}

@Composable
private fun AudioLoadStatus(loading: Boolean, error: String?) {
    val tokens = LocalTokens.current
    val text = when {
        error != null -> error
        loading -> "Loading…"
        else -> return
    }
    Text(
        text = text,
        modifier = Modifier.testTag("settings-load-status"),
        color = if (error != null) Color(Colors.stop) else Color(Colors.ink3),
        fontSize = tokens.type.sm,
    )
}

@Composable
private fun ApplyNotice(saving: Boolean, restarting: Boolean, alreadyApplying: Boolean, applyError: String?) {
    val tokens = LocalTokens.current
    val (msg, tone) = when {
        applyError != null -> applyError to Colors.stop
        alreadyApplying -> "Another change is already applying. Try again in a moment." to Colors.warn
        restarting -> "Applying — assistant restarting…" to Colors.accent
        saving -> "Applying…" to Colors.accent
        else -> return
    }
    Text(
        text = msg,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(tokens.radii.sm))
            .background(Color(Colors.bgElev))
            .border(1.dp, Color(tone), RoundedCornerShape(tokens.radii.sm))
            .padding(horizontal = tokens.space.md, vertical = tokens.space.sm)
            .testTag("settings-apply-notice"),
        color = Color(tone),
        fontSize = tokens.type.sm,
    )
}

@Composable
private fun DiscardDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Discard changes?") },
        text = { Text("Your unsaved edits will be lost.") },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("settings-discard-confirm")) {
                Text("Discard", color = Color(Colors.stop))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Keep editing") } },
    )
}

@Preview
@Composable
private fun AudioScreenPreview() {
    SentientTheme {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            SettingsTopBar(title = "Audio", onBack = {})
            Column(Modifier.padding(16.dp)) {
                PaneSub(HEAD_SUB)
                SettingsCard(title = "Output") {
                    RowToggle(label = "Speak responses (TTS)", checked = true, onCheckedChange = {})
                }
            }
        }
    }
}
