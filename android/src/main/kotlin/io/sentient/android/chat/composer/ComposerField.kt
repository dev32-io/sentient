// ---------------------------------------------------------------------------
// ComposerField — the composer's text input zone: a borderless TextField with a
// context-aware placeholder (idle / "Type to interrupt…" while streaming).
//
// Recording takeover (webui .composer--live parity): while [live] (corner mic
// HOLD or LOCKED) the field is hidden — alpha 0 + disabled, so the DRAFT IS
// PRESERVED and the zone keeps its height — and the PttWave waveform overlays
// it with a short fade/slide entrance.
//
// Extracted from Composer.kt to keep that file under the clean-code size limit.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.composer

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import io.sentient.android.chat.voice.PttWave
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

private const val WAVE_IN_MS = 320
private const val WAVE_OUT_MS = 150
private val WAVE_PADDING = 12.dp

@Composable
internal fun DraftField(
    draft: String,
    live: Boolean,
    streaming: Boolean,
    onChange: (String) -> Unit,
    onFocus: () -> Unit = {},
) {
    val tokens = LocalTokens.current
    Box(modifier = Modifier.fillMaxWidth()) {
        TextField(
            value = draft,
            onValueChange = onChange,
            enabled = !live,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .alpha(if (live) 0f else 1f)
                .testTag("composer-input")
                .onFocusChanged { if (it.isFocused) onFocus() },
            placeholder = {
                if (!live) {
                    Text(
                        if (streaming) "Type to interrupt…" else "Message Sentient",
                        color = Color(Colors.ink3),
                    )
                }
            },
            textStyle = LocalTextStyle.current.copy(color = Color(Colors.ink), fontSize = tokens.type.base),
            maxLines = 6,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent,
                unfocusedContainerColor = Color.Transparent,
                disabledContainerColor = Color.Transparent,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                disabledIndicatorColor = Color.Transparent,
                cursorColor = Color(Colors.accent),
            ),
        )
        AnimatedVisibility(
            visible = live,
            enter = fadeIn(tween(WAVE_IN_MS)) + slideInVertically(tween(WAVE_IN_MS)) { it / 4 },
            exit = fadeOut(tween(WAVE_OUT_MS)),
            modifier = Modifier.matchParentSize(),
        ) {
            Box(
                Modifier.fillMaxSize().padding(horizontal = WAVE_PADDING),
                contentAlignment = Alignment.Center,
            ) { PttWave() }
        }
    }
}
