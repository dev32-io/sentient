// ---------------------------------------------------------------------------
// PttWave — the recording-takeover waveform overlaid across the WHOLE composer
// card while the corner mic is live (HOLD or LOCKED). Mirrors the webui
// .ptt-bigwave (gateway/webui/src/styles/components.css + PttWave component):
// 32 bars (narrow-viewport count) whose heights follow a fixed sine contour,
// with a staggered scaleY + alpha pulse. Bars are weighted so the row spans the
// full available width edge to edge (webui flex: 1 1 0). Decorative — not
// driven by real mic levels.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.voice

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.dp
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.voice.io.MicLevelEnvelope
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

// Contour + stagger constants — transcribed from the webui PttWave + CSS.
private const val BAR_COUNT = 32                 // webui BAR_COUNT_NARROW (mobile)
private const val BAR_HEIGHT_BASE = 0.20f        // 20% baseline height
private const val BAR_HEIGHT_SPAN = 0.64f        // + up to 64% via the sine contour
private const val BAR_PHASE_STEP = 0.7f          // contour phase step per bar
private const val BAR_DELAY_CYCLE = 13           // stagger repeats every 13 bars
private const val BAR_DELAY_STEP = 0.06f         // stagger step, fraction of the period
private const val PULSE_PERIOD_MS = 1000         // ptt-wave 1s ease-in-out infinite
private const val PULSE_MIN_SCALE = 0.24f        // keyframe scaleY at rest
private const val PULSE_SCALE_RANGE = 0.76f
private const val PULSE_MIN_ALPHA = 0.5f
private const val PULSE_ALPHA_RANGE = 0.5f
private const val BAR_ACCENT_MIX = 0.7f          // color-mix(accent 70%, ink)
private val WAVE_HEIGHT = 40.dp
private val BAR_GAP = 3.dp
private val BAR_RADIUS = 2.dp

@Composable
internal fun PttWave(
    levels: MicLevelEnvelope = MicLevelEnvelope.silence(),
    modifier: Modifier = Modifier,
) {
    val barColor = lerp(Color(Colors.ink), Color(Colors.accent), BAR_ACCENT_MIX)
    Row(
        modifier = modifier.fillMaxWidth().height(WAVE_HEIGHT),
        horizontalArrangement = Arrangement.spacedBy(BAR_GAP),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(BAR_COUNT) { i ->
            val contour = BAR_HEIGHT_BASE + BAR_HEIGHT_SPAN * abs(sin(i * BAR_PHASE_STEP))
            val level = levels.values.getOrElse(i) { 0f }.coerceIn(0f, 1f)
            Box(
                Modifier
                    .weight(1f)
                    .height(WAVE_HEIGHT * (contour * (0.35f + 0.65f * level)))
                    .clip(RoundedCornerShape(BAR_RADIUS))
                    .background(barColor),
            )
        }
    }
}
