// ---------------------------------------------------------------------------
// BubbleSpeakingWave — terra gradient sweep across the bubble while speaking
// (webui .bubble-speaking-wave, Motion.wave). AvatarRipple = phased expanding
// rings overlaid on the SentientMark while speaking or listening.
//
// Both are event-driven: active=false composes nothing (event-driven-UX rule).
// ---------------------------------------------------------------------------
package io.sentient.android.chat.voice

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

/**
 * Draws a terra gradient sweep across the bubble surface while the assistant
 * is speaking, mirroring the webui .bubble-speaking-wave keyframe animation.
 *
 * Modifier usage: chain AFTER .background() and BEFORE .border() so the wave
 * sits on top of the fill but under the text content.
 *
 * @param active Wave runs only when true (bound to avatarMode == SPEAKING).
 */
@Composable
fun Modifier.bubbleSpeakingWave(active: Boolean): Modifier {
    if (!active) return this
    val period = LocalTokens.current.motion.waveMs
    val transition = rememberInfiniteTransition(label = "wave")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(period, easing = LinearEasing)),
        label = "phase",
    )
    val accent = Color(Colors.accent)
    return this.drawBehind {
        val w = size.width
        val x = phase * w * 2.2f - w * 0.6f
        drawRect(
            brush = Brush.linearGradient(
                colorStops = arrayOf(
                    0f to Color.Transparent,
                    0.5f to accent.copy(alpha = 0.22f),
                    1f to Color.Transparent,
                ),
                start = Offset(x - w * 0.6f, 0f),
                end = Offset(x + w * 0.6f, 0f),
            ),
        )
    }
}

/**
 * Two phased expanding rings overlaid on the avatar while the assistant is
 * speaking or listening, mirroring the iOS avatar ripple animation.
 *
 * @param active Rings run only when true (bound to avatarMode == SPEAKING || LISTENING).
 */
@Composable
fun AvatarRipple(active: Boolean, modifier: Modifier = Modifier) {
    if (!active) return
    val t = rememberInfiniteTransition(label = "ripple")
    val p by t.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1800, easing = LinearEasing)),
        label = "p",
    )
    // Ripple ring color — mark-`hi` #FFE1BD: brighter than terra, in the rim
    // family but distinct from the static shiny edge so the two read apart.
    val ringColor = Color(0xFFFFE1BD)
    Canvas(modifier = modifier.fillMaxSize()) {
        fun ring(phase: Float) {
            val r = size.minDimension / 2f * (1f + 0.85f * phase)
            drawCircle(
                color = ringColor.copy(alpha = 0.75f * (1f - phase)),
                radius = r,
                style = Stroke(width = 1.5.dp.toPx()),
            )
        }
        ring(p)
        ring((p + 0.5f) % 1f)
    }
}
