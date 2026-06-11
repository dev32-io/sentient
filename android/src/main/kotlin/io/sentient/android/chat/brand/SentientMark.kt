// ---------------------------------------------------------------------------
// SentientMark — the Sentient brand atom. ALWAYS static.
//
// Art is the ONE shared asset (res/drawable-nodpi/sentient_mark.png, rasterized
// from gateway/webui/public/sentient-mark.svg via scripts/gen-brand-assets.sh —
// the same SVG webui renders). No hand-drawn gradients, no animation here.
//
// The "Sentient is active" ripple is NOT part of the mark — it's a separate
// AvatarRipple overlay applied ONLY at the chat assistant avatar (see
// MessageBubble) + the splash. The top bar / any other mark stays static.
//
// [mode] is accepted for call-site compatibility (callers pass the cognition
// mode) but does not affect rendering — the mark is the same image in every mode.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.brand

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.sentient.android.R
import io.sentient.android.chat.voice.MarkMode

/** Default mark diameter for an assistant-bubble avatar (matches the webui size). */
private val DEFAULT_MARK_SIZE: Dp = 28.dp

/** Renders the static Sentient mark at [size]. [mode] is ignored (see file note). */
@Composable
fun SentientMark(
    modifier: Modifier = Modifier,
    size: Dp = DEFAULT_MARK_SIZE,
    @Suppress("UNUSED_PARAMETER") mode: MarkMode = MarkMode.IDLE,
) {
    Image(
        painter = painterResource(R.drawable.sentient_mark),
        contentDescription = null,
        modifier = modifier.size(size),
    )
}
