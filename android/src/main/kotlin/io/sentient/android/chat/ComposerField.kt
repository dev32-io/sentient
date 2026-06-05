// ---------------------------------------------------------------------------
// ComposerField — the composer's text input zone: a borderless TextField with a
// context-aware placeholder (idle / "Type to interrupt…" while streaming) and the
// listening waveform overlaid on the empty field while the mic is active.
// Extracted from Composer.kt to keep that file under the clean-code size limit.
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

@Composable
internal fun DraftField(
    draft: String,
    micActive: Boolean,
    streaming: Boolean,
    onChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    val tokens = LocalTokens.current
    val showWave = micActive && draft.isEmpty()
    Box(modifier = Modifier.fillMaxWidth()) {
        TextField(
            value = draft,
            onValueChange = onChange,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .testTag("chat-input"),
            placeholder = {
                if (!showWave) {
                    Text(
                        if (streaming) "Type to interrupt…" else "Message Sentient",
                        color = Color(Colors.ink3),
                    )
                }
            },
            textStyle = LocalTextStyle.current.copy(color = Color(Colors.ink), fontSize = tokens.type.base),
            maxLines = 6,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { onSubmit() }),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent,
                unfocusedContainerColor = Color.Transparent,
                disabledContainerColor = Color.Transparent,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                cursorColor = Color(Colors.accent),
            ),
        )
        if (showWave) {
            Box(
                Modifier.matchParentSize().padding(start = 16.dp),
                contentAlignment = Alignment.CenterStart,
            ) { ListeningWaveform() }
        }
    }
}
