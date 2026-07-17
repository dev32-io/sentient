// ---------------------------------------------------------------------------
// FishVoiceTile — one Fish Audio library entry in the clone browser. Title, language
// + usage badges, a short description, a "Play sample" control (streams the external
// previewAudioUrl; disabled when the entry carries none), and a Clone action that
// opens the prefill form. Presentational; state + callbacks hoisted from the VM.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.settings.FishVoiceEntry

private val BORDER_WIDTH = 1.dp
private const val DESCRIPTION_MAX_LINES = 2

/** One Fish library entry. [isPlaying] toggles the sample control label; [busy] gates Clone. */
@Composable
fun FishVoiceTile(
    entry: FishVoiceEntry,
    isPlaying: Boolean,
    busy: Boolean,
    onPlay: () -> Unit,
    onClone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(tokens.radii.md))
            .background(Color(Colors.paper))
            .border(BORDER_WIDTH, Color(Colors.lineSoft), RoundedCornerShape(tokens.radii.md))
            .padding(tokens.space.lg)
            .testTag("fish-tile-${entry.id}"),
        verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        Text(text = entry.title, color = Color(Colors.ink), fontSize = tokens.type.lg, fontWeight = FontWeight.SemiBold)
        BadgeRow(entry)
        if (entry.description.isNotBlank()) {
            Text(
                text = entry.description,
                color = Color(Colors.ink3),
                fontSize = tokens.type.sm,
                maxLines = DESCRIPTION_MAX_LINES,
                overflow = TextOverflow.Ellipsis,
            )
        }
        ActionRow(entry = entry, isPlaying = isPlaying, busy = busy, onPlay = onPlay, onClone = onClone)
    }
}

@Composable
private fun BadgeRow(entry: FishVoiceEntry) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(tokens.space.xs),
    ) {
        entry.languages.forEach { VoiceChip(label = voiceLanguageLabel(it)) }
        if (entry.taskCount > 0) VoiceChip(label = "${entry.taskCount} uses")
    }
}

@Composable
private fun ActionRow(entry: FishVoiceEntry, isPlaying: Boolean, busy: Boolean, onPlay: () -> Unit, onClone: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(
            onClick = onPlay,
            enabled = entry.previewAudioUrl != null,
            modifier = Modifier.testTag("fish-play-${entry.id}"),
        ) { Text(if (isPlaying) "Stop" else "Play sample") }
        Box(modifier = Modifier.weight(1f))
        Button(onClick = onClone, enabled = !busy, modifier = Modifier.testTag("fish-clone-${entry.id}")) {
            Text("Clone")
        }
    }
}

@Preview
@Composable
private fun FishVoiceTilePreview() {
    SentientTheme {
        FishVoiceTile(
            entry = FishVoiceEntry(
                id = "fish1",
                title = "Morgan Freeman",
                description = "Deep, calm, authoritative narration.",
                languages = listOf("en"),
                tags = listOf("male", "deep"),
                previewAudioUrl = "https://example.com/sample.mp3",
                taskCount = 1200,
            ),
            isPlaying = false,
            busy = false,
            onPlay = {},
            onClone = {},
        )
    }
}
