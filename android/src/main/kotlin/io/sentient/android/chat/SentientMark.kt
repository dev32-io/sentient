// ---------------------------------------------------------------------------
// SentientMark — the Sentient avatar/logo mark, drawn as a Canvas atom.
//
// This is the D-A3 (text-phase) form: a static nucleus + halo ring + three
// orbital ellipses, mirroring the webui SVG mark's idle geometry
// (gateway/webui/src/components/common/sentient-mark.tsx). The webui's
// listening/thinking/speaking electron-orbit animations are Phase-3 (E5); here
// the mark is static — the surrounding chat (pulse dots, streaming text) is
// what conveys cognition, exactly as the webui idle mark does.
//
// Geometry is transcribed from the webui viewBox 0 0 64 64: nucleus r=6 at
// centre, halo ring r≈30, three orbits rx=23 ry=9 at rotations 18/-28/78°. We
// scale that 64-unit space to the requested [size] dp.
// ---------------------------------------------------------------------------
package io.sentient.android.chat

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
import io.sentient.mobilesdk.design.Colors

/** Default mark diameter for an assistant bubble avatar (webui assistant Avatar size). */
private val DEFAULT_MARK_SIZE: Dp = 28.dp

/** webui viewBox is 64 units square; all geometry below is in that space. */
private const val VIEW = 64f
private const val NUCLEUS_R = 6f
private const val RING_R = 30f
private const val ORBIT_RX = 23f
private const val ORBIT_RY = 9f

/** Orbit rotations (degrees), from the webui ORBITS table. */
private val ORBIT_ROTATIONS = floatArrayOf(18f, -28f, 78f)

private val MARK_TERRA = Color(Colors.accent)
private val MARK_EMBER = Color(0xFFFFB87AL)
private val MARK_HI = Color(0xFFFFE1BDL)
private val MARK_RIM = Color(0xFFFFF3DBL)

/**
 * Renders the Sentient mark. [size] sets the diameter; the 64-unit webui
 * geometry scales to fit. Static (idle) for D-A3 — no animation.
 */
@Composable
fun SentientMark(
    modifier: Modifier = Modifier,
    size: Dp = DEFAULT_MARK_SIZE,
) {
    Canvas(modifier = modifier.size(size)) {
        val scale = this.size.minDimension / VIEW
        val center = Offset(this.size.width / 2f, this.size.height / 2f)
        drawHalo(center, scale)
        drawRing(center, scale)
        drawOrbits(center, scale)
        drawNucleus(center, scale)
    }
}

/** Soft ember glow behind the nucleus. */
private fun DrawScope.drawHalo(center: Offset, scale: Float) {
    val r = 14f * scale
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(MARK_EMBER.copy(alpha = 0.45f), MARK_EMBER.copy(alpha = 0f)),
            center = center,
            radius = r,
        ),
        radius = r,
        center = center,
    )
}

/** Faint outer rim ring. */
private fun DrawScope.drawRing(center: Offset, scale: Float) {
    drawCircle(
        color = MARK_RIM.copy(alpha = 0.4f),
        radius = RING_R * scale,
        center = center,
        style = Stroke(width = 1.2f * scale),
    )
}

/** The three rotated orbital ellipses. */
private fun DrawScope.drawOrbits(center: Offset, scale: Float) {
    val rx = ORBIT_RX * scale
    val ry = ORBIT_RY * scale
    val topLeft = Offset(center.x - rx, center.y - ry)
    val ellipseSize = Size(rx * 2f, ry * 2f)
    for (rot in ORBIT_ROTATIONS) {
        rotate(degrees = rot, pivot = center) {
            drawOval(
                color = MARK_RIM.copy(alpha = 0.5f),
                topLeft = topLeft,
                size = ellipseSize,
                style = Stroke(width = 0.85f * scale),
            )
        }
    }
}

/** Glowing terra nucleus at the centre. */
private fun DrawScope.drawNucleus(center: Offset, scale: Float) {
    val r = NUCLEUS_R * scale
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
