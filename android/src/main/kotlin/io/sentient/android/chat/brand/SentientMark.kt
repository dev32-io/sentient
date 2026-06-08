// ---------------------------------------------------------------------------
// SentientMark — the Sentient avatar/logo mark, drawn as a Canvas atom.
//
// Geometry mirrors the webui SVG mark (gateway/webui/src/components/common/
// sentient-mark.tsx): a nucleus + halo glow + faint rim ring + three orbital
// ellipses, in the viewBox 0 0 64 64 (nucleus r=6, ring r≈30, orbits rx=23
// ry=9 at rotations 18/-28/78°). We scale that 64-unit space to [size] dp.
//
// E5 adds the animated voice states, porting the webui mark animations
// (components.css .sentient-mark--listening / --running) via [MarkMode].
// The speaking-wave lives on the bubble (BubbleSpeakingWave), not the mark.
// The [mode] is derived from the single SDK surface upstream
// (markModeOf) — listening / thinking / speaking / idle. CRITICAL: each mode's
// animation runs ONLY in that mode (see SentientMarkAnim — event-driven; the
// infinite transition is composed only in the active branch). [MarkMode.IDLE]
// is dead static — no animation at rest (the event-driven-UX rule).
// ---------------------------------------------------------------------------
package io.sentient.android.chat.brand

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.sentient.android.chat.voice.MarkMode
import io.sentient.mobilesdk.design.Colors

/** Default mark diameter for an assistant bubble avatar (webui assistant Avatar size). */
private val DEFAULT_MARK_SIZE: Dp = 28.dp

/** webui viewBox is 64 units square; all geometry below is in that space. */
private const val VIEW = 64f
private const val NUCLEUS_R = 6f
private const val RING_R = 30f
private const val ORBIT_RX = 23f
private const val ORBIT_RY = 9f
private const val ELECTRON_R = 1.4f

/** Orbit rotations (degrees), from the webui ORBITS table. */
private val ORBIT_ROTATIONS = floatArrayOf(18f, -28f, 78f)

/** Electron phase offsets (0..1) along each orbit, from the webui ORBITS table. */
private val ELECTRON_PHASE = floatArrayOf(0.18f, 0.62f, 0.4f)

private val MARK_TERRA = Color(Colors.accent)
private val MARK_EMBER = Color(0xFFFFB87AL)
private val MARK_HI = Color(0xFFFFE1BDL)
private val MARK_RIM = Color(0xFFFFF3DBL)

/**
 * Renders the Sentient mark. [size] sets the diameter; the 64-unit webui
 * geometry scales to fit. [mode] selects the animation (default IDLE = static).
 */
@Composable
fun SentientMark(
    modifier: Modifier = Modifier,
    size: Dp = DEFAULT_MARK_SIZE,
    mode: MarkMode = MarkMode.IDLE,
) {
    val anim = rememberMarkAnim(mode)
    Canvas(modifier = modifier.size(size)) {
        val scale = this.size.minDimension / VIEW
        val center = Offset(this.size.width / 2f, this.size.height / 2f)
        drawHalo(center, scale, anim)
        drawRing(center, scale, anim)
        drawOrbits(center, scale, anim)
        drawNucleus(center, scale, anim)
    }
}

/** Soft ember glow behind the nucleus (breathes in listening/running modes). */
private fun DrawScope.drawHalo(center: Offset, scale: Float, anim: MarkAnim) {
    val r = 14f * scale * anim.haloScale
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(MARK_EMBER.copy(alpha = anim.haloAlpha), MARK_EMBER.copy(alpha = 0f)),
            center = center,
            radius = r,
        ),
        radius = r,
        center = center,
    )
}

/** Faint outer rim ring (brightens in listening mode). */
private fun DrawScope.drawRing(center: Offset, scale: Float, anim: MarkAnim) {
    drawCircle(
        color = MARK_RIM.copy(alpha = anim.ringAlpha),
        radius = RING_R * scale,
        center = center,
        style = Stroke(width = 1.2f * scale),
    )
}

/** The three rotated orbital ellipses, plus electrons that spin in listening mode. */
private fun DrawScope.drawOrbits(center: Offset, scale: Float, anim: MarkAnim) {
    val rx = ORBIT_RX * scale
    val ry = ORBIT_RY * scale
    val topLeft = Offset(center.x - rx, center.y - ry)
    val ellipseSize = Size(rx * 2f, ry * 2f)
    ORBIT_ROTATIONS.forEachIndexed { i, rot ->
        rotate(degrees = rot, pivot = center) {
            drawOval(
                color = MARK_RIM.copy(alpha = 0.5f),
                topLeft = topLeft,
                size = ellipseSize,
                style = Stroke(width = 0.85f * scale),
            )
            drawElectron(center, rx, ry, i, anim, scale)
        }
    }
}

/** One electron dot riding its orbit; spins only when [MarkAnim.orbitSpin] moves it. */
private fun DrawScope.drawElectron(
    center: Offset,
    rx: Float,
    ry: Float,
    i: Int,
    anim: MarkAnim,
    scale: Float,
) {
    val spin = anim.orbitSpin.getOrElse(i) { 0f }
    if (spin == 0f && anim.ringAlpha <= 0.4f) return
    val theta = (ELECTRON_PHASE[i] + spin / 360f) * (2f * kotlin.math.PI).toFloat()
    val pos = Offset(center.x + rx * kotlin.math.cos(theta), center.y + ry * kotlin.math.sin(theta))
    drawCircle(
        brush = Brush.radialGradient(listOf(MARK_RIM, MARK_HI), center = pos, radius = ELECTRON_R * scale * 2f),
        radius = ELECTRON_R * scale,
        center = pos,
    )
}

/** Glowing terra nucleus at the centre (pulses in listening/running modes). */
private fun DrawScope.drawNucleus(center: Offset, scale: Float, anim: MarkAnim) {
    val r = NUCLEUS_R * scale * anim.nucleusScale
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(MARK_HI, MARK_EMBER, MARK_TERRA),
            center = Offset(center.x - r * 0.2f, center.y - r * 0.25f),
            radius = r * 1.3f,
        ),
        radius = r,
        center = center,
    )
}
