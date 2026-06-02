/**
 * Dusk design tokens — single source of truth for cross-platform visual parity.
 *
 * Transcribed from gateway/webui/src/styles/tokens/ (colors.css, spacing.css,
 * radius.css, typography.css, motion.css).
 *
 * ## Color representation
 * Colors are `const val Long` holding the packed ARGB value (0xFFRRGGBB).
 * A plain Long hex literal (e.g. 0xFF2B2621L) is a compile-time constant and
 * satisfies `const val` — no function calls needed.  The alternative
 * `0xFF2B2621uL.toLong()` is NOT const-eligible because `.toLong()` is a
 * function call.  Using a signed Long literal keeps SKIE/Swift bridging clean:
 * SKIE exposes Long as Int64, which Swift reads directly.  Compose accepts the
 * same Long in its `Color(value: Long)` constructor.
 *
 * ## Corrections vs plan reference
 * - `accentSoft` (0xFF5A3A28L) was present in colors.css (`--color-accent-soft`)
 *   but absent from the plan reference.  Added.
 * - Motion values: CSS defines ms as part of shorthand (`150ms ease`, `250ms ease`,
 *   `3.4s ease-in-out infinite`, `1s steps(2) infinite`).  Parsed as:
 *   fast=150ms, normal=250ms, wave=3400ms, cursor=1000ms — matching the plan.
 * - Space.xxl=32 / Space.xxxl=40 matches CSS `--space-2xl: 32px` / `--space-3xl: 40px`.
 *   All other values match exactly.
 */
package io.sentient.mobilesdk.design

// ---------------------------------------------------------------------------
// Colors — packed ARGB as const Long (0xFFRRGGBBL)
// ---------------------------------------------------------------------------

/**
 * Dusk palette. Sourced from gateway/webui/src/styles/tokens/colors.css.
 *
 * Usage (Compose): Color(Colors.bg)
 * Usage (Swift via SKIE): Int64 — pass directly to a Color(argb:) helper.
 */
object Colors {
    // Surfaces — layered bg depth
    const val bg: Long        = 0xFF2B2621L
    const val bgElev: Long    = 0xFF332D28L
    const val bgSunk: Long    = 0xFF241F1BL
    const val paper: Long     = 0xFF39322CL

    // Lines
    const val line: Long      = 0xFF4A4138L
    const val lineSoft: Long  = 0xFF3E362FL

    // Ink (text)
    const val ink: Long       = 0xFFF2E8D6L
    const val ink2: Long      = 0xFFD7C6ABL
    const val ink3: Long      = 0xFF9E907EL
    const val ink4: Long      = 0xFF706456L

    // Accents
    const val accent: Long      = 0xFFF2A06AL  // terra — primary
    const val accentSoft: Long  = 0xFF5A3A28L  // --color-accent-soft (absent from plan ref)
    const val accent50: Long    = 0xFF402C22L
    const val amber: Long       = 0xFFE9B168L
    const val sage: Long        = 0xFFB9C8A6L
    const val sageSoft: Long    = 0xFF3A4232L
    const val clay: Long        = 0xFF9A5A3EL

    // Status
    const val ok: Long    = 0xFF5F8A5BL
    const val warn: Long  = 0xFFC2892FL
    const val stop: Long  = 0xFFB8442EL
}

// ---------------------------------------------------------------------------
// Spacing — dp values as Int (source: spacing.css)
// ---------------------------------------------------------------------------

object Space {
    const val xs: Int     = 4
    const val sm: Int     = 8
    const val md: Int     = 12
    const val lg: Int     = 18
    const val xl: Int     = 26
    const val xxl: Int    = 32
    const val xxxl: Int   = 40
    const val padMsg: Int = 18
    const val gapMsg: Int = 32
    const val msgMax: Int = 720
}

// ---------------------------------------------------------------------------
// Radii — dp values as Int (source: radius.css)
// ---------------------------------------------------------------------------

object Radii {
    const val sm: Int   = 8
    const val md: Int   = 12
    const val lg: Int   = 18
    const val xl: Int   = 26
    const val pill: Int = 999
}

// ---------------------------------------------------------------------------
// Type scale — sp / line-height values (source: typography.css)
// ---------------------------------------------------------------------------

object TypeScale {
    const val xs: Double          = 11.0
    const val sm: Double          = 12.5
    const val base: Double        = 15.0
    const val lg: Double          = 18.0
    const val xl: Double          = 22.0
    const val display: Double     = 44.0
    const val lineTight: Double   = 1.25
    const val lineNormal: Double  = 1.55
    const val lineRelaxed: Double = 1.6
}

// ---------------------------------------------------------------------------
// Motion — durations in milliseconds as Int (source: motion.css)
// ---------------------------------------------------------------------------

object Motion {
    const val fastMs: Int   = 150   // --motion-fast: 150ms ease
    const val normalMs: Int = 250   // --motion-normal: 250ms ease
    const val waveMs: Int   = 3400  // --motion-wave: 3.4s ease-in-out infinite
    const val cursorMs: Int = 1000  // --motion-cursor: 1s steps(2) infinite
}

// ---------------------------------------------------------------------------
// Tints — avatar tint map (plan: avatar persona tints)
// ---------------------------------------------------------------------------

/**
 * Persona → ARGB color mapping for avatar tints.
 * Keys match the persona slug strings used by the gateway.
 */
object Tints {
    val map: Map<String, Long> = mapOf(
        "terra" to Colors.accent50,
        "sage"  to Colors.sageSoft,
        "amber" to Colors.amber,
        "clay"  to Colors.clay,
    )
}
