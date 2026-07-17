// ---------------------------------------------------------------------------
// SettingsCard — card container matching the webui "sc-card" feel (paper surface,
// lineSoft border, md radius, optional bgElev header block for title/subtitle).
// Wraps a stack of CategoryRow / RowToggle / RowSlider / etc.; the card itself
// owns no scroll — callers place it inside their page's scroll container.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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

/**
 * A visual section-group card. [title]/[subtitle] render a bgElev header block above
 * the body (omitted entirely when [title] is null); [content] is the card body, laid
 * out as a [ColumnScope] so callers stack rows directly without an extra wrapper.
 */
@Composable
fun SettingsCard(
    modifier: Modifier = Modifier,
    title: String? = null,
    subtitle: String? = null,
    testTag: String = "settings-card",
    content: @Composable ColumnScope.() -> Unit,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(tokens.radii.md))
            .background(Color(Colors.paper))
            .border(BORDER_WIDTH, Color(Colors.lineSoft), RoundedCornerShape(tokens.radii.md))
            .testTag(testTag),
    ) {
        if (title != null) {
            SettingsCardHeader(title = title, subtitle = subtitle)
        }
        Column(modifier = Modifier.padding(vertical = tokens.space.xs)) {
            content()
        }
    }
}

@Composable
private fun SettingsCardHeader(title: String, subtitle: String?) {
    val tokens = LocalTokens.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(Colors.bgElev))
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
    ) {
        Text(
            text = title,
            color = Color(Colors.ink),
            fontSize = tokens.type.sm,
            fontWeight = FontWeight.SemiBold,
        )
        if (subtitle != null) {
            Text(
                text = subtitle,
                modifier = Modifier.padding(top = tokens.space.xs),
                color = Color(Colors.ink3),
                fontSize = tokens.type.xs,
            )
        }
    }
}

@Preview
@Composable
private fun SettingsCardPreview() {
    SentientTheme {
        SettingsCard(title = "Memory", subtitle = "What the assistant remembers about you.") {
            Text(
                text = "Card body content",
                modifier = Modifier.padding(horizontal = LocalTokens.current.space.lg),
                color = Color(Colors.ink),
            )
        }
    }
}
