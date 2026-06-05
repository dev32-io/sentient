// ---------------------------------------------------------------------------
// Tokens — Compose-side mapping of the SDK's non-Material design tokens.
//
// Material colors map onto Compose's ColorScheme (see Theme.kt). The remaining
// SDK tokens — Space/Radii/TypeScale/Motion — have no Material slot, so they
// ride a CompositionLocal (LocalTokens) instead. The raw SDK values are plain
// Int (dp) / Double (sp / line-height) / Int (ms); this file converts them to
// the Compose units (Dp / TextUnit) ONCE, here, so composables read typed
// values and never reach back into the SDK constants.
// ---------------------------------------------------------------------------
package io.sentient.android.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.sentient.mobilesdk.design.Motion
import io.sentient.mobilesdk.design.Radii
import io.sentient.mobilesdk.design.Space
import io.sentient.mobilesdk.design.TypeScale

/** Spacing scale in [Dp], mapped from the SDK's [Space] (px → dp 1:1). */
@Immutable
data class SpaceTokens(
    val xs: Dp = Space.xs.dp,
    val sm: Dp = Space.sm.dp,
    val md: Dp = Space.md.dp,
    val lg: Dp = Space.lg.dp,
    val xl: Dp = Space.xl.dp,
    val xxl: Dp = Space.xxl.dp,
    val xxxl: Dp = Space.xxxl.dp,
    val padMsg: Dp = Space.padMsg.dp,
    val gapMsg: Dp = Space.gapMsg.dp,
    val msgMax: Dp = Space.msgMax.dp,
)

/** Corner-radius scale in [Dp], mapped from the SDK's [Radii]. */
@Immutable
data class RadiiTokens(
    val sm: Dp = Radii.sm.dp,
    val md: Dp = Radii.md.dp,
    val lg: Dp = Radii.lg.dp,
    val xl: Dp = Radii.xl.dp,
    val pill: Dp = Radii.pill.dp,
)

/** Font sizes ([TextUnit] sp) + unitless line-height multipliers, from [TypeScale]. */
@Immutable
data class TypeTokens(
    val xs: TextUnit = TypeScale.xs.sp,
    val sm: TextUnit = TypeScale.sm.sp,
    val base: TextUnit = TypeScale.base.sp,
    val lg: TextUnit = TypeScale.lg.sp,
    val xl: TextUnit = TypeScale.xl.sp,
    val display: TextUnit = TypeScale.display.sp,
    val lineTight: Float = TypeScale.lineTight.toFloat(),
    val lineNormal: Float = TypeScale.lineNormal.toFloat(),
    val lineRelaxed: Float = TypeScale.lineRelaxed.toFloat(),
)

/** Motion durations in milliseconds, from [Motion]. */
@Immutable
data class MotionTokens(
    val fastMs: Int = Motion.fastMs,
    val normalMs: Int = Motion.normalMs,
    val waveMs: Int = Motion.waveMs,
    val cursorMs: Int = Motion.cursorMs,
)

/**
 * Composer outer-glow tunables — transcribed from the webui `.composer` /
 * `.composer--listening` box-shadow (+ `--shadow-2` terra halo). Alpha is applied
 * to the brand accent so the glow stays in lockstep with the accent token.
 */
@Immutable
data class ShadowTokens(
    val composerGlowRadius: Dp = 26.dp,
    val composerGlowRadiusListening: Dp = 48.dp,
    val composerGlowYOffset: Dp = 8.dp,
    val composerGlowAlpha: Float = 0.22f,
    val composerGlowAlphaListening: Float = 0.40f,
)

/** The non-Material token bundle carried on [LocalTokens]. */
@Immutable
data class SentientTokens(
    val space: SpaceTokens = SpaceTokens(),
    val radii: RadiiTokens = RadiiTokens(),
    val type: TypeTokens = TypeTokens(),
    val motion: MotionTokens = MotionTokens(),
    val shadow: ShadowTokens = ShadowTokens(),
)

/**
 * Provides the non-Material design tokens to the composition. Read via
 * `LocalTokens.current` inside [SentientTheme]. Static because the token set is
 * fixed for the lifetime of the theme — no recomposition on read.
 */
val LocalTokens = staticCompositionLocalOf { SentientTokens() }
