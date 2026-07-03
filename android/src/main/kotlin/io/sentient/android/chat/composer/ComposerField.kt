// ---------------------------------------------------------------------------
// ComposerField — the composer's text input zone: a borderless TextField with a
// context-aware placeholder (idle / "Type to interrupt…" while streaming).
//
// Recording takeover (webui .composer__textarea--hidden parity): while [live]
// (corner mic HOLD or LOCKED) the field is hidden via ALPHA ONLY — it stays
// enabled and fully laid out (placeholder included), so the DRAFT, the focus /
// IME state, and the measured height are all EXACTLY what they were idle. A
// transparent tap-blocker overlays it (pointer-events: none equivalent) so the
// invisible field can't grab focus. The waveform overlay lives at the card
// level in Composer.kt, not here.
//
// Extracted from Composer.kt to keep that file under the clean-code size limit.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.composer

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

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
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .alpha(if (live) 0f else 1f)
                .testTag("composer-input")
                .onFocusChanged { if (it.isFocused) onFocus() },
            placeholder = {
                Text(
                    if (streaming) "Type to interrupt…" else "Message Sentient",
                    color = Color(Colors.ink3),
                )
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
                cursorColor = Color(Colors.accent),
            ),
        )
        // Transparent tap-blocker while live: the invisible-but-enabled field must
        // not gain focus (which would pop the IME and shift the dock). Blocking
        // pointer input instead of disabling the field keeps its layout, focus,
        // and IME state identical between idle and live — the composer's measured
        // size never changes when the mic is held or locked.
        if (live) {
            Box(
                Modifier
                    .matchParentSize()
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = {},
                    ),
            )
        }
    }
}
