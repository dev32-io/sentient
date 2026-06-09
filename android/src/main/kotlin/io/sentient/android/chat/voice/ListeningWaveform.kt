// ---------------------------------------------------------------------------
// ListeningWaveform — animated bar-graph overlay shown while the mic is active
// and the draft field is empty. Mirrors the iOS Composer waveform (Task 7.1).
//
// Eleven bars animate with a travelling-wave phase so adjacent bars ripple in
// sequence, giving a "listening" heartbeat effect. The waveform + label are
// rendered inline with the draft field via a Box overlay (see Composer.kt).
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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import kotlin.math.PI
import kotlin.math.cos

// Design-tuned waveform constants — matched to iOS Task 7.1 visual parity.
private val WAVE_BAR_HEIGHTS = listOf(6, 12, 18, 10, 15, 8, 16, 11, 18, 7, 13)
private const val WAVE_PERIOD_MS = 1100
private const val WAVE_PHASE_STEP = 0.08f
private val WAVE_BAR_WIDTH = 2.5.dp
private val WAVE_BAR_GAP = 2.5.dp
private const val WAVE_MIN_SCALE = 0.4f
private const val WAVE_SCALE_RANGE = 0.6f
private const val LABEL_SIZE_SP = 13.5f
private const val LABEL_ALPHA = 0.85f

@Composable
internal fun ListeningWaveform() {
    val tokens = LocalTokens.current
    val transition = rememberInfiniteTransition(label = "lwave")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(WAVE_PERIOD_MS, easing = LinearEasing)),
        label = "p",
    )
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WAVE_BAR_GAP),
        ) {
            WAVE_BAR_HEIGHTS.forEachIndexed { i, h ->
                val local = (phase + i * WAVE_PHASE_STEP) % 1f
                val scale = WAVE_MIN_SCALE + WAVE_SCALE_RANGE *
                    (0.5f - 0.5f * cos(local * 2f * PI.toFloat()))
                Box(
                    Modifier
                        .width(WAVE_BAR_WIDTH)
                        .height((h * scale).dp)
                        .clip(CircleShape)
                        .background(Color(Colors.accent)),
                )
            }
        }
        Text(
            text = "Listening…",
            color = Color(Colors.accent).copy(alpha = LABEL_ALPHA),
            fontSize = LABEL_SIZE_SP.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}
