// ---------------------------------------------------------------------------
// MicCornerVisuals — ember-colorway visuals for the MicCorner control, mapped
// from the webui CSS (components.css "MicCorner" section, squircle + ember +
// springy variant):
//
//   idle body  → bgSunk fill, lineSoft border, ink3 glyph with a slow breathe
//   live       → accent glyph, accent-mixed border + soft accent glow
//   armed      → accent-50 ring flare; the detent dot lights accent and scales
//   locked     → accent→bgSunk gradient body + glyph scale bounce (spring)
//   drag trail → right-anchored gradient bar growing with drag progress
//   hold entry → an expanding + fading ripple ring
//
// MicCorner.kt owns state + gestures; this file only renders.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.composer

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import io.sentient.android.R
import io.sentient.mobilesdk.design.Colors
import kotlin.math.roundToInt

// Geometry (webui: 34px button / 11px radius, scaled to the 38dp row button).
private val CORNER_RADIUS = 11.dp
private val RING_WIDTH = 4.dp
private val TRAIL_HEIGHT = 4.dp
private val TRAIL_END_INSET = MIC_CORNER_BUTTON / 2
private val DETENT_START_INSET = 6.dp
private val DETENT_RADIUS = 2.5.dp
private val IDLE_ELEVATION = 3.dp
private val LIVE_ELEVATION = 6.dp

// Ember mixes (webui color-mix percentages).
private const val LIVE_BORDER_ACCENT_MIX = 0.45f
private const val LOCKED_GRADIENT_START_MIX = 0.45f
private const val LOCKED_GRADIENT_END_MIX = 0.20f
private const val DETENT_BASE_ALPHA = 0.22f
private const val DETENT_LIT_WHITE_MIX = 0.15f
private const val RIPPLE_BORDER_ALPHA = 0.7f
private const val TRAIL_MAX_ALPHA = 0.9f

// Motion (webui keyframes / transitions).
private const val BODY_TRANSITION_MS = 220
private const val ICON_TINT_MS = 200
private const val RIPPLE_MS = 500
private const val RIPPLE_SCALE_FROM = 0.9f
private const val RIPPLE_SCALE_TO = 1.7f
private const val RIPPLE_ALPHA_FROM = 0.9f
private const val GLYPH_BOUNCE_FROM = 0.62f
private const val ARMED_DETENT_SCALE = 1.7f
private const val BREATHE_MIN_ALPHA = 0.85f
private const val BREATHE_HALF_MS = 1500
private const val RELEASE_DAMPING = 0.55f

private val RIPPLE_EASING = CubicBezierEasing(0.2f, 0.7f, 0.3f, 1f)

/** Springy settle used for every release/reset of the drag offset. */
internal fun <T> micCornerSpring() = spring<T>(
    dampingRatio = RELEASE_DAMPING,
    stiffness = Spring.StiffnessMediumLow,
)

/**
 * Drag trail + lock detent, drawn behind the wrap. [drag] is read lazily so
 * per-frame updates stay in the draw phase (no recomposition while dragging).
 */
@Composable
internal fun micCornerOverlays(
    drag: () -> Float,
    travelPx: Float,
    railShown: Boolean,
    armed: Boolean,
    locked: Boolean,
): Modifier {
    val accent = Color(Colors.accent)
    val detentAlpha by animateFloatAsState(
        targetValue = if (railShown && !locked) 1f else 0f,
        animationSpec = tween(ICON_TINT_MS),
        label = "mic-detent-alpha",
    )
    val detentScale by animateFloatAsState(
        targetValue = if (armed) ARMED_DETENT_SCALE else 1f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy),
        label = "mic-detent-scale",
    )
    val detentColor by animateColorAsState(
        targetValue = if (armed) {
            lerp(accent, Color.White, DETENT_LIT_WHITE_MIX)
        } else {
            Color(Colors.ink).copy(alpha = DETENT_BASE_ALPHA)
        },
        animationSpec = tween(ICON_TINT_MS),
        label = "mic-detent-color",
    )
    return Modifier.drawBehind {
        val progress = (drag() / travelPx).coerceIn(0f, 1f)
        if (progress > 0f) {
            val width = travelPx * progress
            val right = size.width - TRAIL_END_INSET.toPx()
            drawRoundRect(
                brush = Brush.horizontalGradient(
                    0f to accent.copy(alpha = 0f),
                    1f to accent,
                    startX = right - width,
                    endX = right,
                ),
                topLeft = Offset(right - width, center.y - TRAIL_HEIGHT.toPx() / 2f),
                size = Size(width, TRAIL_HEIGHT.toPx()),
                cornerRadius = CornerRadius(TRAIL_HEIGHT.toPx()),
                alpha = progress * TRAIL_MAX_ALPHA,
            )
        }
        if (detentAlpha > 0f) {
            drawCircle(
                color = detentColor,
                radius = DETENT_RADIUS.toPx() * detentScale,
                center = Offset(DETENT_START_INSET.toPx() + DETENT_RADIUS.toPx(), center.y),
                alpha = detentAlpha,
            )
        }
    }
}

/**
 * The draggable squircle button: ember body + ripple ring + mic glyph.
 * [dragOffset] is applied in the placement lambda so tracking never recomposes.
 */
@Composable
internal fun MicCornerButton(
    mode: MicCornerMode,
    railShown: Boolean,
    armed: Boolean,
    dragOffset: () -> Float,
    modifier: Modifier = Modifier,
) {
    val locked = mode == MicCornerMode.LOCKED
    val shape = RoundedCornerShape(CORNER_RADIUS)
    val accent = Color(Colors.accent)

    val borderColor by animateColorAsState(
        targetValue = if (railShown) lerp(Color(Colors.line), accent, LIVE_BORDER_ACCENT_MIX) else Color(Colors.lineSoft),
        animationSpec = tween(BODY_TRANSITION_MS),
        label = "mic-border",
    )
    val iconTint by animateColorAsState(
        targetValue = if (railShown) accent else Color(Colors.ink3),
        animationSpec = tween(ICON_TINT_MS),
        label = "mic-tint",
    )
    val ringAlpha by animateFloatAsState(
        targetValue = if (armed) 1f else 0f,
        animationSpec = tween(BODY_TRANSITION_MS),
        label = "mic-ring",
    )
    val elevation by animateDpAsState(
        targetValue = if (railShown) LIVE_ELEVATION else IDLE_ELEVATION,
        animationSpec = tween(BODY_TRANSITION_MS),
        label = "mic-elevation",
    )
    val bodyBrush = if (locked) {
        Brush.linearGradient(
            0f to lerp(Color(Colors.bgSunk), accent, LOCKED_GRADIENT_START_MIX),
            1f to lerp(Color(Colors.bgSunk), accent, LOCKED_GRADIENT_END_MIX),
        )
    } else {
        Brush.linearGradient(0f to Color(Colors.bgSunk), 1f to Color(Colors.bgSunk))
    }

    // One-shot mode-entry animations: HOLD → ripple ring, LOCKED → glyph bounce.
    val ripple = remember { Animatable(1f) }
    val glyphScale = remember { Animatable(1f) }
    LaunchedEffect(mode) {
        when (mode) {
            MicCornerMode.HOLD -> {
                ripple.snapTo(0f)
                ripple.animateTo(1f, tween(RIPPLE_MS, easing = RIPPLE_EASING))
            }
            MicCornerMode.LOCKED -> {
                glyphScale.snapTo(GLYPH_BOUNCE_FROM)
                glyphScale.animateTo(1f, spring(dampingRatio = Spring.DampingRatioMediumBouncy))
            }
            MicCornerMode.IDLE -> Unit
        }
    }
    // Rest hint: faint breathing on the idle glyph.
    val breathe by rememberInfiniteTransition(label = "mic-breathe").animateFloat(
        initialValue = BREATHE_MIN_ALPHA,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(BREATHE_HALF_MS, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "mic-breathe-alpha",
    )

    Box(
        modifier = modifier
            .offset { IntOffset(dragOffset().roundToInt(), 0) }
            .size(MIC_CORNER_BUTTON)
            .testTag("chat-mic")
            .semantics {
                role = Role.Switch
                contentDescription = if (locked) {
                    "Hands-free listening on — drag back to stop"
                } else {
                    "Hold to talk; slide to lock hands-free"
                }
            }
            .shadow(elevation, shape, clip = false, ambientColor = if (railShown) accent else Color.Black, spotColor = if (railShown) accent else Color.Black)
            .drawBehind {
                if (ringAlpha > 0f) {
                    val ring = RING_WIDTH.toPx()
                    drawRoundRect(
                        color = Color(Colors.accent50),
                        topLeft = Offset(-ring / 2f, -ring / 2f),
                        size = Size(size.width + ring, size.height + ring),
                        cornerRadius = CornerRadius(CORNER_RADIUS.toPx() + ring / 2f),
                        style = Stroke(ring),
                        alpha = ringAlpha,
                    )
                }
            }
            .background(bodyBrush, shape)
            .border(1.dp, borderColor, shape),
        contentAlignment = Alignment.Center,
    ) {
        if (ripple.value < 1f) {
            Box(
                Modifier
                    .matchParentSize()
                    .graphicsLayer {
                        val t = ripple.value
                        scaleX = RIPPLE_SCALE_FROM + (RIPPLE_SCALE_TO - RIPPLE_SCALE_FROM) * t
                        scaleY = scaleX
                        alpha = RIPPLE_ALPHA_FROM * (1f - t)
                    }
                    .border(2.dp, accent.copy(alpha = RIPPLE_BORDER_ALPHA), shape),
            )
        }
        Icon(
            painter = painterResource(R.drawable.ic_mic),
            contentDescription = null,
            tint = iconTint,
            modifier = Modifier
                .size(ICON_SIZE)
                .graphicsLayer {
                    scaleX = glyphScale.value
                    scaleY = glyphScale.value
                    alpha = if (mode == MicCornerMode.IDLE) breathe else 1f
                },
        )
    }
}
