// ---------------------------------------------------------------------------
// MonoEditor — multiline monospace text editor with an optional maxLength cap +
// char counter. Used for Memory (MEMORY.md/USER.md), System Prompt, and
// Personalities instructions — all plain-text server fields with a server-declared
// charLimit. Mirrors the webui ".ta.mono" textarea.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.JetBrainsMono
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private val BORDER_WIDTH = 1.dp

/**
 * A monospace multiline editor. [maxLength] (server `charLimit`), when non-null,
 * both caps input (extra keystrokes are dropped in [onValueChange]) and renders a
 * right-aligned "n / max" counter below the field.
 */
@Composable
fun MonoEditor(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    maxLength: Int? = null,
    minLines: Int = 6,
    placeholder: String = "",
    enabled: Boolean = true,
    testTag: String = "mono-editor",
) {
    val tokens = LocalTokens.current
    Column(modifier = modifier.fillMaxWidth()) {
        TextField(
            value = value,
            onValueChange = { next -> onValueChange(capAt(next, maxLength)) },
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(tokens.radii.sm))
                .border(BORDER_WIDTH, Color(Colors.lineSoft), RoundedCornerShape(tokens.radii.sm))
                .testTag(testTag),
            enabled = enabled,
            minLines = minLines,
            placeholder = { Text(placeholder, color = Color(Colors.ink4)) },
            textStyle = MaterialTheme.typography.bodyMedium.copy(
                fontFamily = JetBrainsMono,
                fontSize = tokens.type.sm,
                color = Color(Colors.ink),
            ),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color(Colors.paper),
                unfocusedContainerColor = Color(Colors.bgElev),
                disabledContainerColor = Color(Colors.bgElev),
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                disabledIndicatorColor = Color.Transparent,
                cursorColor = Color(Colors.accent),
            ),
        )
        if (maxLength != null) {
            Text(
                text = "${value.length} / $maxLength",
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = tokens.space.xs, end = tokens.space.xs)
                    .testTag("$testTag-counter"),
                color = Color(Colors.ink3),
                fontSize = tokens.type.xs,
                textAlign = TextAlign.End,
            )
        }
    }
}

private fun capAt(value: String, maxLength: Int?): String =
    if (maxLength != null && value.length > maxLength) value.take(maxLength) else value

@Preview
@Composable
private fun MonoEditorPreview() {
    SentientTheme {
        MonoEditor(
            value = "# MEMORY.md\n\nThe user prefers concise answers.",
            onValueChange = {},
            maxLength = 4000,
            placeholder = "Nothing remembered yet.",
        )
    }
}
