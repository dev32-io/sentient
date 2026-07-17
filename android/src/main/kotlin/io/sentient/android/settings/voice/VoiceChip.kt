// ---------------------------------------------------------------------------
// VoiceChip — a small pill chip for tag filters (Voice list filter bar) and for the
// removable tag list in the create form. Mirrors the webui `.chip` / `.v-tag`
// affordance: filled-accent when active, outlined otherwise; an optional trailing
// "×" turns it into a removable tag.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private val BORDER_WIDTH = 1.dp
private const val REMOVE_GLYPH = "×"

/**
 * A pill chip [label]. [active] fills it with the soft-accent tint; [onClick] toggles
 * (filter chip) or is a no-op. When [onRemove] is set a trailing "×" removes the chip.
 */
@Composable
fun VoiceChip(
    label: String,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    onClick: (() -> Unit)? = null,
    onRemove: (() -> Unit)? = null,
    testTag: String = "voice-chip",
) {
    val tokens = LocalTokens.current
    val bg = if (active) Color(Colors.accentSoft) else Color(Colors.bgElev)
    val fg = if (active) Color(Colors.accent) else Color(Colors.ink2)
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(tokens.radii.pill))
            .background(bg)
            .border(BorderStroke(BORDER_WIDTH, Color(Colors.lineSoft)), RoundedCornerShape(tokens.radii.pill))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = tokens.space.md, vertical = tokens.space.xs)
            .testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.xs),
    ) {
        Text(text = label, color = fg, fontSize = tokens.type.sm)
        if (onRemove != null) {
            Text(
                text = REMOVE_GLYPH,
                color = fg,
                fontSize = tokens.type.base,
                modifier = Modifier
                    .clickable(onClick = onRemove)
                    .testTag("$testTag-remove"),
            )
        }
    }
}

@Preview
@Composable
private fun VoiceChipPreview() {
    SentientTheme {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            VoiceChip(label = "Warm", active = true, onClick = {})
            VoiceChip(label = "Calm", onClick = {})
            VoiceChip(label = "Male", onRemove = {})
        }
    }
}
