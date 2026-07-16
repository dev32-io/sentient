// ---------------------------------------------------------------------------
// CategoryRow — one tappable row on the Settings root list (icon + title + chevron).
//
// Stateless leaf: icon + title + onClick are hoisted; no ViewModel refs. Meant to
// be stacked inside a SettingsCard (which supplies the surrounding card chrome) —
// this row itself carries no background so a stack of rows reads as one card body.
//
// testTag defaults to "category-row" but callers MUST override per-destination
// (e.g. "settings-cat-memory") since a real root list renders many instances.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.settings.icons.Brain
import io.sentient.android.settings.icons.SettingsIcons
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private val ICON_BOX_SIZE = 32.dp
private val ICON_GLYPH_SIZE = 18.dp
private const val CHEVRON = "›" // ›

/**
 * One category row: [icon] in a tinted square, [title], trailing chevron. Full-width
 * tappable via [onClick]. Carries no background/divider of its own — a [SettingsCard]
 * (or a plain Column) supplies the card chrome around a stack of these rows.
 */
@Composable
fun CategoryRow(
    icon: ImageVector,
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    testTag: String = "category-row",
) {
    val tokens = LocalTokens.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.md)
            .testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        Box(
            modifier = Modifier
                .size(ICON_BOX_SIZE)
                .clip(RoundedCornerShape(tokens.radii.sm))
                .background(Color(Colors.bgElev)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = Color(Colors.ink2),
                modifier = Modifier.size(ICON_GLYPH_SIZE),
            )
        }
        Text(
            text = title,
            modifier = Modifier.weight(1f),
            color = Color(Colors.ink),
            fontSize = tokens.type.base,
        )
        Text(text = CHEVRON, color = Color(Colors.ink3), fontSize = tokens.type.lg)
    }
}

@Preview
@Composable
private fun CategoryRowPreview() {
    SentientTheme {
        CategoryRow(icon = SettingsIcons.Brain, title = "Memory", onClick = {})
    }
}
