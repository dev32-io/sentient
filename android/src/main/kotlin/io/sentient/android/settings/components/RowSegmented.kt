// ---------------------------------------------------------------------------
// RowSegmented — a 2+ option pill segmented control, matching the webui
// Segmented primitive (components/settings/primitives/segmented.tsx / .seg2 CSS):
// an inset pill track (bgElev, lineSoft border) holding evenly-spaced option
// buttons; the active option gets a paper-filled pill.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private val BORDER_WIDTH = 1.dp
private val TRACK_PADDING = 3.dp

/** One segmented option: a stable [value] used for equality + the display [label]. */
data class SegmentOption(val value: String, val label: String)

/**
 * A pill segmented control over [options]; [selected] is the current option's [SegmentOption.value].
 * Tapping an option calls [onSelect] with its value — the caller owns the state, this
 * composable never tracks selection itself.
 */
@Composable
fun RowSegmented(
    options: List<SegmentOption>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    testTag: String = "row-segmented",
) {
    val tokens = LocalTokens.current
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(tokens.radii.sm))
            .background(Color(Colors.bgElev))
            .border(BORDER_WIDTH, Color(Colors.lineSoft), RoundedCornerShape(tokens.radii.sm))
            .padding(TRACK_PADDING)
            .testTag(testTag),
    ) {
        options.forEach { option ->
            SegmentPill(
                option = option,
                isActive = option.value == selected,
                enabled = enabled,
                onClick = { onSelect(option.value) },
            )
        }
    }
}

@Composable
private fun SegmentPill(option: SegmentOption, isActive: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val tokens = LocalTokens.current
    val bg = if (isActive) Color(Colors.paper) else Color.Transparent
    val fg = if (isActive) Color(Colors.ink) else Color(Colors.ink2)
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(tokens.radii.sm))
            .background(bg)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(PaddingValues(horizontal = tokens.space.md, vertical = tokens.space.xs))
            .testTag("segment-${option.value}"),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = option.label,
            color = fg,
            fontSize = tokens.type.sm,
            fontWeight = if (isActive) FontWeight.Medium else FontWeight.Normal,
        )
    }
}

@Preview
@Composable
private fun RowSegmentedPreview() {
    SentientTheme {
        RowSegmented(
            options = listOf(SegmentOption("memory", "MEMORY.md"), SegmentOption("user", "USER.md")),
            selected = "memory",
            onSelect = {},
        )
    }
}
