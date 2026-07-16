// ---------------------------------------------------------------------------
// VoiceTextField — the Dusk-styled sans text input used across the Voice cluster
// (search box, name / description form fields). Sibling to the components/ MonoEditor
// but sans-serif and single-line-capable; kept in voice/ since the shared components
// set is owned by another surface. Optional [maxLength] caps input + shows a counter.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private val BORDER_WIDTH = 1.dp

/**
 * A single- or multi-line text field. [maxLength], when set, drops extra keystrokes
 * in [onValueChange] and renders a right-aligned "n / max" counter below the field.
 */
@Composable
fun VoiceTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    maxLength: Int? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    enabled: Boolean = true,
    showCounter: Boolean = false,
    testTag: String = "voice-text-field",
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
            singleLine = singleLine,
            minLines = if (singleLine) 1 else minLines,
            placeholder = { Text(placeholder, color = Color(Colors.ink4), fontSize = tokens.type.base) },
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color(Colors.paper),
                unfocusedContainerColor = Color(Colors.bgElev),
                disabledContainerColor = Color(Colors.bgElev),
                focusedTextColor = Color(Colors.ink),
                unfocusedTextColor = Color(Colors.ink),
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                disabledIndicatorColor = Color.Transparent,
                cursorColor = Color(Colors.accent),
            ),
        )
        if (showCounter && maxLength != null) {
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
private fun VoiceTextFieldPreview() {
    SentientTheme {
        VoiceTextField(value = "Dad", onValueChange = {}, placeholder = "e.g. Dad", maxLength = 64, showCounter = true)
    }
}
