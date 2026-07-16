// ---------------------------------------------------------------------------
// GroupHeader — small-caps/xs semibold ink3 section label (Soul / User / Admin /
// Support on the Settings root list). Matches the existing inline section labels
// in SettingsScreen (VERSION_LABEL / UPDATES_LABEL / DIAGNOSTICS_LABEL styling)
// but split out as a reusable leaf so category pages can reuse the same look for
// their own section dividers.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.sp
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private val LETTER_SPACING = 0.6.sp

/**
 * A section-group label ("SOUL", "USER", "ADMIN", "SUPPORT"). [text] is upper-cased
 * and tracked to read as small-caps at xs/semibold/ink3 — the emphasis level below a
 * pane title, above a row label.
 */
@Composable
fun GroupHeader(text: String, modifier: Modifier = Modifier, testTag: String = "group-header") {
    val tokens = LocalTokens.current
    Text(
        text = text.uppercase(),
        modifier = modifier
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.sm)
            .testTag(testTag),
        color = Color(Colors.ink3),
        fontSize = tokens.type.xs,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = LETTER_SPACING,
    )
}

@Preview
@Composable
private fun GroupHeaderPreview() {
    SentientTheme {
        GroupHeader(text = "Soul")
    }
}
