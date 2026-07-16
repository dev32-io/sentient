// ---------------------------------------------------------------------------
// RowToggle — label + optional sub + trailing switch. Wraps Material3 [Switch],
// recolored with the Dusk tokens to match the webui ".tg" toggle (accent when on,
// bg-sunk/line when off) rather than Material3's default scheme colors.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

/** The Dusk-tinted switch color set, shared by [RowToggle] wherever a Switch appears. */
@Composable
private fun tokenSwitchColors() = SwitchDefaults.colors(
    checkedThumbColor = Color(Colors.paper),
    checkedTrackColor = Color(Colors.accent),
    checkedBorderColor = Color(Colors.accent),
    uncheckedThumbColor = Color(Colors.paper),
    uncheckedTrackColor = Color(Colors.bgSunk),
    uncheckedBorderColor = Color(Colors.line),
    disabledCheckedThumbColor = Color(Colors.ink4),
    disabledUncheckedThumbColor = Color(Colors.ink4),
)

/**
 * A settings row: [label] (+ optional [sub] hint) on the left, a switch bound to
 * [checked] on the right. Tapping anywhere in the row toggles — matches the webui
 * row's full-row click target for its toggle control.
 */
@Composable
fun RowToggle(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    sub: String? = null,
    enabled: Boolean = true,
    testTag: String = "row-toggle",
) {
    val tokens = LocalTokens.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.md)
            .testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, color = Color(Colors.ink), fontSize = tokens.type.base)
            if (sub != null) {
                Text(
                    text = sub,
                    modifier = Modifier.padding(top = tokens.space.xs),
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.xs,
                )
            }
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            enabled = enabled,
            colors = tokenSwitchColors(),
        )
    }
}

@Preview
@Composable
private fun RowTogglePreview() {
    SentientTheme {
        RowToggle(
            label = "Speak responses",
            sub = "Play assistant replies as speech (TTS)",
            checked = true,
            onCheckedChange = {},
        )
    }
}
