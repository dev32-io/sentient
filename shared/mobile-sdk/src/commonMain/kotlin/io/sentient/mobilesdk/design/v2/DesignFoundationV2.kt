// GENERATED FILE — DO NOT EDIT.
// Design foundation 2.0.0; contract sha256: f7799ee0711e7d8e4bd944606ab9342607f326ff109a44d905d8a2a7b91c7dc6
// Source: shared/mobile-sdk/design-foundation-v2.json
package io.sentient.mobilesdk.design.v2

object DesignFoundationV2 {
    const val version: String = "2.0.0"
    const val contractSha256: String = "f7799ee0711e7d8e4bd944606ab9342607f326ff109a44d905d8a2a7b91c7dc6"
}

object Colors {
    const val bg: Long = 0xFF2B2621L
    const val elevated: Long = 0xFF332D28L
    const val sunk: Long = 0xFF241F1BL
    const val paper: Long = 0xFF39322CL
    const val line: Long = 0xFF4A4138L
    const val lineSoft: Long = 0xFF3E362FL
    const val ink: Long = 0xFFF2E8D6L
    const val inkSecondary: Long = 0xFFD7C6ABL
    const val inkTertiary: Long = 0xFF9E907EL
    const val inkMuted: Long = 0xFF706456L
    const val ember: Long = 0xFFF2A06AL
    const val emberSoft: Long = 0xFF5A3A28L
    const val emberDeep: Long = 0xFF402C22L
    const val amber: Long = 0xFFE9B168L
    const val sage: Long = 0xFFB9C8A6L
    const val sageSoft: Long = 0xFF3A4232L
    const val clay: Long = 0xFF9A5A3EL
    const val ok: Long = 0xFF5F8A5BL
    const val warn: Long = 0xFFC2892FL
    const val stop: Long = 0xFFB8442EL
}

object Fonts {
    const val display: String = "Fraunces, Cormorant Garamond, Georgia, serif"
    const val ui: String = "DM Sans, Inter, system-ui, -apple-system, sans-serif"
    const val mono: String = "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
}

object TypeSizes {
    const val xs: Double = 11.0
    const val sm: Double = 12.5
    const val base: Double = 15.0
    const val lg: Double = 18.0
    const val xl: Double = 22.0
    const val display: Double = 44.0
}

object LineHeights {
    const val tight: Double = 1.25
    const val normal: Double = 1.55
    const val relaxed: Double = 1.6
}

object Spacing {
    const val xs: Double = 4.0
    const val sm: Double = 8.0
    const val md: Double = 12.0
    const val lg: Double = 18.0
    const val xl: Double = 26.0
    const val xxl: Double = 32.0
    const val xxxl: Double = 40.0
}

object Radii {
    const val sm: Double = 8.0
    const val md: Double = 12.0
    const val lg: Double = 18.0
    const val xl: Double = 26.0
}

object Pill {
    const val isTruePill: Boolean = true
    const val cssValue: String = "9999px"
}

object Motion {
    const val feedbackMs: Int = 150
    const val stateTransitionMs: Int = 250
    const val respondingCadenceMs: Int = 1550
}

object Materials {
    const val slateFace: String = "radial-gradient( ellipse 82% 105% at 50% 52%, color-mix(in oklab, var(--slate-base, var(--color-paper)) 80%, var(--color-bg-sunk)) 0%, color-mix(in oklab, var(--slate-base, var(--color-paper)) 88%, var(--color-bg-sunk)) 42%, transparent 76% ), linear-gradient( 180deg, color-mix(in oklab, var(--slate-base, var(--color-paper)) 96%, var(--color-ink)) 0%, var(--slate-base, var(--color-paper)) 100% )"
    const val slateFaceHover: String = "radial-gradient( ellipse 82% 105% at 50% 52%, color-mix(in oklab, var(--slate-base, var(--color-paper)) 77%, var(--color-bg-sunk)) 0%, color-mix(in oklab, var(--slate-base, var(--color-paper)) 86%, var(--color-bg-sunk)) 42%, transparent 76% ), linear-gradient( 180deg, color-mix(in oklab, var(--slate-base, var(--color-paper)) 94%, var(--color-ink)) 0%, color-mix(in oklab, var(--slate-base, var(--color-paper)) 97%, var(--color-accent)) 100% )"
    const val slateFaceMuted: String = "radial-gradient( ellipse 82% 105% at 50% 52%, color-mix(in oklab, var(--slate-base, var(--color-bg-elev)) 84%, var(--color-bg-sunk)) 0%, transparent 74% ), linear-gradient(180deg, color-mix(in oklab, var(--slate-base, var(--color-bg-elev)) 97%, var(--color-ink-4)), var(--slate-base, var(--color-bg-elev)))"
    const val slateTopLight: String = "inset 0 1px 0 color-mix(in oklab, var(--color-ink) 7%, transparent)"
    const val slateContact: String = "0 2px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 88%, var(--color-line))"
    const val slateCast: String = "0 9px 15px -10px rgba(0, 0, 0, .9)"
    const val slateEmberCast: String = "0 12px 20px -16px color-mix(in oklab, var(--color-accent) 42%, transparent)"
    const val slateShadow: String = "var(--slate-top-light), var(--slate-contact), var(--slate-cast), var(--slate-ember-cast)"
    const val slateShadowHover: String = "inset 0 1px 0 color-mix(in oklab, var(--color-ink) 13%, transparent), 0 2px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 90%, var(--color-line)), 0 11px 18px -10px rgba(0, 0, 0, .94), 0 14px 22px -14px color-mix(in oklab, var(--color-accent) 48%, transparent)"
    const val slateShadowPressed: String = "inset 0 2px 3px color-mix(in oklab, var(--color-bg-sunk) 42%, transparent), 0 1px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 90%, var(--color-line)), 0 3px 6px -5px rgba(0, 0, 0, .88)"
    const val slateShadowDisabled: String = "inset 0 1px 0 color-mix(in oklab, var(--color-ink) 5%, transparent), 0 1px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 72%, var(--color-line)), 0 5px 9px -8px rgba(0, 0, 0, .7)"
    const val wellFace: String = "linear-gradient( 180deg, color-mix(in oklab, var(--color-bg-sunk) 95%, black) 0%, var(--color-bg-sunk) 56%, color-mix(in oklab, var(--color-bg-sunk) 90%, var(--color-bg-elev)) 100% )"
    const val wellShadow: String = "inset 0 3px 6px -2px rgba(0, 0, 0, .72), inset 0 -1px 0 color-mix(in oklab, var(--color-ink) 7%, transparent), 0 1px 0 color-mix(in oklab, var(--color-line) 45%, transparent)"
    const val wellShadowFocus: String = "inset 0 3px 6px -2px rgba(0, 0, 0, .76), inset 0 -1px 0 color-mix(in oklab, var(--color-ink) 8%, transparent), 0 0 0 3px color-mix(in oklab, var(--color-accent) 18%, transparent), 0 8px 18px -14px color-mix(in oklab, var(--color-accent) 48%, transparent)"
    const val plateShadow: String = "inset 0 1px 0 color-mix(in oklab, var(--color-ink) 5%, transparent), 0 2px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 78%, var(--color-line)), 0 18px 30px -22px rgba(0, 0, 0, .9)"
    const val floatShadow: String = "inset 0 1px 0 color-mix(in oklab, var(--color-ink) 7%, transparent), 0 3px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 86%, var(--color-line)), 0 28px 58px -22px rgba(0, 0, 0, .96), 0 24px 40px -30px color-mix(in oklab, var(--color-accent) 38%, transparent)"
}

object MaterialModel {
    const val actionableFaces: String = "elevated-subtly-concave"
    const val receivingSurfaces: String = "recessed"
    const val broadPlates: String = "quiet"
    const val brightPerimeterRim: Boolean = false
    const val centerHighlight: Boolean = false
    val emberUsage: List<String> = listOf("commitment", "focus", "activity")
}

enum class ComponentState {
    REST,
    HOVER,
    FOCUS,
    PRESSED,
    SELECTED,
    ON,
    DESTRUCTIVE,
    DISABLED
}

enum class SentientAvatarState { IDLE, THINKING, RESPONDING }

object SentientAvatar {
    const val runtimeFile: String = "sentient-avatar.riv"
    const val manifestPath: String = "design/prototype/foundation-components/assets/avatars/sentient-avatar.rive-manifest.json"
    const val manifestSha256: String = "b9a8a732688499510050e023c541667ddb5dacb5bc9d1ab368cca97b23b810ee"
    const val runtimeSha256: String = "bad6f8c82fba6386233cef356adc59fa6017a7c97c0de61a377546405b1e892b"
    const val artboard: String = "SentientAvatar"
    const val stateMachine: String = "Avatar"
    const val reducedMotionInput: String = "reducedMotion"
    const val transitionDurationMs: Int = 250
    val states: List<String> = listOf("idle", "thinking", "responding")
    val triggers: Map<String, String> = mapOf("idle" to "toIdle", "thinking" to "toThinking", "responding" to "toResponding")
}

object UserAvatar {
    val sizesPx: List<Int> = listOf(28, 44, 56)
    val tintRoles: List<String> = listOf("emberDeep", "sageSoft", "amber", "clay")
    val states: List<String> = listOf("fallback", "selected", "disabled")
}
