// ---------------------------------------------------------------------------
// SentientMarkAnim — the animated parameters for the SentientMark avatar,
// porting the webui mark animations (gateway/webui/src/styles/components.css
// .sentient-mark--running / --listening) to Compose.
//
// CRITICAL (event-driven-UX rule): each rememberInfiniteTransition is composed
// ONLY inside its mode's branch and keyed on the mode label, so the animation
// runs solely while that SDK-derived state holds and tears down the instant the
// state leaves. [MarkMode.IDLE] composes NO transition — the mark is dead still
// at rest. "constant by default is a bug."
//
// webui parity (durations transcribed from components.css):
//   listening → halo-breathe 2.4s, nucleus 1.8s, ring 2.4s, orbits 3.8/5.2/4.4s
//   thinking  → halo 6.5s, nucleus 4.5s (the shared "running" engagement pulse)
//   speaking  → pulse only (wave now lives on the bubble via BubbleSpeakingWave)
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable

/**
 * The animated draw parameters the SentientMark Canvas reads each frame. All
 * default to the static idle resting values; only the active mode's animator
 * drives a subset away from rest.
 *
 * @param haloScale Nucleus halo glow scale (breathe).
 * @param haloAlpha Halo opacity (breathe).
 * @param nucleusScale Nucleus core scale (pulse).
 * @param ringAlpha Outer rim ring opacity (listening only).
 * @param orbitSpin Per-orbit rotation offset in degrees (listening only).
 */
data class MarkAnim(
    val haloScale: Float = 1f,
    val haloAlpha: Float = 0.45f,
    val nucleusScale: Float = 1f,
    val ringAlpha: Float = 0.4f,
    val orbitSpin: FloatArray = FloatArray(3),
)

/** Listening durations (ms), transcribed from .sentient-mark--listening. */
private const val LISTEN_HALO_MS = 2400
private const val LISTEN_NUC_MS = 1800
private const val LISTEN_RING_MS = 2400
private val LISTEN_ORBIT_MS = intArrayOf(3800, 5200, 4400)
private val LISTEN_ORBIT_CW = booleanArrayOf(true, false, true)

/** Thinking/speaking shared "running" pulse durations (ms). */
private const val RUN_HALO_MS = 6500
private const val RUN_NUC_MS = 4500

/**
 * Builds the [MarkAnim] for [mode]. Composes an infinite transition only for
 * non-idle modes (keyed on [mode] via remember semantics), so idle is truly
 * static and switching modes restarts cleanly.
 */
@Composable
fun rememberMarkAnim(mode: MarkMode): MarkAnim = when (mode) {
    MarkMode.IDLE -> MarkAnim()
    MarkMode.LISTENING -> listeningAnim()
    // .thinking and .speaking share the engagement pulse; the speaking-specific
    // sweep now lives on the bubble (BubbleSpeakingWave).
    MarkMode.THINKING, MarkMode.SPEAKING -> runningAnim()
}

@Composable
private fun listeningAnim(): MarkAnim {
    val t = rememberInfiniteTransition(label = "mark-listening")
    val halo = t.pulse(LISTEN_HALO_MS, 1f, 1.12f, "halo")
    val haloA = t.pulse(LISTEN_HALO_MS, 0.45f, 0.7f, "haloA")
    val nuc = t.pulse(LISTEN_NUC_MS, 1f, 1.06f, "nuc")
    val ring = t.pulse(LISTEN_RING_MS, 0.4f, 0.85f, "ring")
    val o0 = t.spin(LISTEN_ORBIT_MS[0], LISTEN_ORBIT_CW[0], "o0")
    val o1 = t.spin(LISTEN_ORBIT_MS[1], LISTEN_ORBIT_CW[1], "o1")
    val o2 = t.spin(LISTEN_ORBIT_MS[2], LISTEN_ORBIT_CW[2], "o2")
    return MarkAnim(
        haloScale = halo,
        haloAlpha = haloA,
        nucleusScale = nuc,
        ringAlpha = ring,
        orbitSpin = floatArrayOf(o0, o1, o2),
    )
}

@Composable
private fun runningAnim(): MarkAnim {
    val t = rememberInfiniteTransition(label = "mark-running")
    return MarkAnim(
        haloScale = t.pulse(RUN_HALO_MS, 1f, 1.08f, "halo"),
        haloAlpha = t.pulse(RUN_HALO_MS, 0.45f, 0.6f, "haloA"),
        nucleusScale = t.pulse(RUN_NUC_MS, 1f, 1.06f, "nuc"),
    )
}

/** Ping-pong scale/alpha pulse (ease-in-out, like the CSS 0%/50%/100% pulses). */
@Composable
private fun androidx.compose.animation.core.InfiniteTransition.pulse(
    ms: Int,
    from: Float,
    to: Float,
    label: String,
): Float = animateFloat(
    initialValue = from,
    targetValue = to,
    animationSpec = infiniteRepeatable(tween(ms), RepeatMode.Reverse),
    label = label,
).value

/** Continuous 0→360° (or 0→-360°) rotation, like the linear orbit keyframes. */
@Composable
private fun androidx.compose.animation.core.InfiniteTransition.spin(
    ms: Int,
    clockwise: Boolean,
    label: String,
): Float = animateFloat(
    initialValue = 0f,
    targetValue = if (clockwise) 360f else -360f,
    animationSpec = infiniteRepeatable(tween(ms, easing = LinearEasing), RepeatMode.Restart),
    label = label,
).value

