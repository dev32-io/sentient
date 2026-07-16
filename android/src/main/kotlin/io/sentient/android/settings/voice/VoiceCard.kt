// ---------------------------------------------------------------------------
// VoiceCard — one voice-pack row for the Voice list. Play/stop preview control,
// name + language / source / active badges, a short description, tag chips, and the
// Set-active + Delete actions. Delete is offered ONLY for user-source packs — the
// gateway rejects built-in deletes with a 409, and the webui likewise hides delete
// on built-ins (deleting the *active* pack IS allowed: the server falls back to the
// default voice). Presentational; all state + callbacks hoisted from the VM.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import io.sentient.mobilesdk.settings.VoiceSummary

private val BORDER_WIDTH = 1.dp
private val PLAY_SIZE = 40.dp
private val PROGRESS_SIZE = 18.dp
private const val PLAY_GLYPH = "▶"
private const val STOP_GLYPH = "■"
private const val DESCRIPTION_MAX_LINES = 2
private const val SOURCE_USER = "user"

/** One voice-pack card. [isActive] shows the active badge; delete shows only for user packs. */
@Composable
fun VoiceCard(
    voice: VoiceSummary,
    isActive: Boolean,
    isPlaying: Boolean,
    isLoading: Boolean,
    busy: Boolean,
    onPlay: () -> Unit,
    onPick: () -> Unit,
    onDelete: () -> Unit,
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
            .testTag("voice-card-${voice.voiceId}"),
        verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(tokens.space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PlayControl(voice.voiceId, isPlaying, isLoading, onPlay)
            Column(modifier = Modifier.weight(1f)) {
                Text(text = voice.name, color = Color(Colors.ink), fontSize = tokens.type.lg, fontWeight = FontWeight.SemiBold)
                BadgeRow(voice = voice, isActive = isActive)
            }
        }
        if (voice.description.isNotBlank()) {
            Text(
                text = voice.description,
                color = Color(Colors.ink3),
                fontSize = tokens.type.sm,
                maxLines = DESCRIPTION_MAX_LINES,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (voice.tags.isNotEmpty()) TagRow(voice.tags)
        ActionRow(voice = voice, isActive = isActive, busy = busy, onPick = onPick, onDelete = onDelete)
    }
}

@Composable
private fun PlayControl(voiceId: String, isPlaying: Boolean, isLoading: Boolean, onPlay: () -> Unit) {
    Box(
        modifier = Modifier
            .size(PLAY_SIZE)
            .clip(CircleShape)
            .background(Color(Colors.bgElev))
            .clickable(enabled = !isLoading, onClick = onPlay)
            .testTag("voice-play-$voiceId"),
        contentAlignment = Alignment.Center,
    ) {
        if (isLoading) {
            CircularProgressIndicator(modifier = Modifier.size(PROGRESS_SIZE), color = Color(Colors.accent), strokeWidth = 2.dp)
        } else {
            Text(text = if (isPlaying) STOP_GLYPH else PLAY_GLYPH, color = Color(Colors.accent))
        }
    }
}

@Composable
private fun BadgeRow(voice: VoiceSummary, isActive: Boolean) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.padding(top = tokens.space.xs),
        horizontalArrangement = Arrangement.spacedBy(tokens.space.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (voice.language.isNotEmpty()) VoiceChip(label = voiceLanguageLabel(voice.language))
        VoiceChip(label = if (voice.source == SOURCE_USER) "Yours" else "Built-in")
        if (isActive) VoiceChip(label = "Active", active = true, testTag = "voice-active-${voice.voiceId}")
    }
}

@Composable
private fun TagRow(tags: List<String>) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(tokens.space.xs),
    ) {
        tags.forEach { VoiceChip(label = it) }
    }
}

@Composable
private fun ActionRow(voice: VoiceSummary, isActive: Boolean, busy: Boolean, onPick: () -> Unit, onDelete: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (!isActive) {
            TextButton(onClick = onPick, enabled = !busy, modifier = Modifier.testTag("voice-pick-${voice.voiceId}")) {
                Text("Set active", color = Color(Colors.accent))
            }
        }
        Box(modifier = Modifier.weight(1f))
        if (voice.source == SOURCE_USER) {
            TextButton(onClick = onDelete, enabled = !busy, modifier = Modifier.testTag("voice-delete-${voice.voiceId}")) {
                Text("Delete", color = Color(Colors.stop))
            }
        }
    }
}

@Preview
@Composable
private fun VoiceCardPreview() {
    SentientTheme {
        VoiceCard(
            voice = VoiceSummary(
                voiceId = "abc",
                name = "Dad",
                description = "Warm, calm narration voice for evening stories.",
                tags = listOf("warm", "calm"),
                language = "en",
                source = "user",
            ),
            isActive = true,
            isPlaying = false,
            isLoading = false,
            busy = false,
            onPlay = {},
            onPick = {},
            onDelete = {},
        )
    }
}
