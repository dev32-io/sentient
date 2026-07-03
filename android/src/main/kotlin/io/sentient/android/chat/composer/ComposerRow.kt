// ---------------------------------------------------------------------------
// ComposerRow — the composer's bottom button row: TTS toggle, attach, spacer,
// interrupt (conditional), send. Extracted from Composer.kt to keep that file
// under the clean-code size limit. The mic lives in the MicCorner control on
// the card's top-right edge, not in this row.
//
// While [live] (corner mic HOLD/LOCKED) the toggles + send hide — only the
// interrupt stays reachable (webui .composer--live parity). The row pins its
// min height to BUTTON_SIZE so the card doesn't jump when they unmount.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.sentient.android.R
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

private const val INTERRUPT_TINT_ALPHA = 0.16f
private const val INTERRUPT_BORDER_ALPHA = 0.35f
private val INTERRUPT_SQUARE = 11.dp

@Composable
internal fun ButtonRow(
    sendEnabled: Boolean,
    canSend: Boolean,
    ttsEnabled: Boolean,
    live: Boolean,
    canInterrupt: Boolean,
    onSend: () -> Unit,
    onTtsToggle: () -> Unit,
    onInterrupt: () -> Unit,
) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = BUTTON_SIZE),
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // TTS + attach are toggles: slashed glyph + sunk bg when off, accent glyph +
        // accent-tint bg + accent border when on (webui icon-btn--tts variants).
        if (!live) {
            ComposerToggle(
                iconRes = if (ttsEnabled) R.drawable.ic_volume_2 else R.drawable.ic_volume_x,
                on = ttsEnabled,
                contentDescription = "Toggle speech",
                testTag = "chat-tts-toggle",
                onClick = onTtsToggle,
            )
            ComposerToggle(
                iconRes = R.drawable.ic_attach,
                on = false,
                contentDescription = "Attach",
                testTag = "chat-attach",
                onClick = {},
            )
        }
        Row(modifier = Modifier.weight(1f)) {}
        if (canInterrupt) {
            InterruptButton(onInterrupt = onInterrupt)
        }
        // Tint is accent when the field is non-empty AND the SDK is READY (send goes
        // now). Muted when non-empty but not READY — the tap will queue, not drop.
        if (!live) {
            ComposerAction(
                iconRes = R.drawable.ic_send,
                tint = if (sendEnabled && canSend) Color(Colors.accent) else Color(Colors.ink4),
                contentDescription = "Send",
                testTag = "chat-send",
                enabled = sendEnabled,
                onClick = onSend,
            )
        }
    }
}

/** The stop affordance — a tinted square in a bordered box (webui interrupt-icon-btn). */
@Composable
private fun InterruptButton(onInterrupt: () -> Unit) {
    Box(
        modifier = Modifier
            .size(BUTTON_SIZE)
            .clip(RoundedCornerShape(BUTTON_RADIUS))
            .background(Color(Colors.stop).copy(alpha = INTERRUPT_TINT_ALPHA))
            .border(1.dp, Color(Colors.stop).copy(alpha = INTERRUPT_BORDER_ALPHA), RoundedCornerShape(BUTTON_RADIUS))
            .clickable(onClick = onInterrupt)
            .testTag("chat-interrupt"),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(INTERRUPT_SQUARE)
                .clip(RoundedCornerShape(2.dp))
                .background(Color(Colors.stop)),
        )
    }
}
