// ---------------------------------------------------------------------------
// Theme — the Dusk design tokens projected onto Material3.
//
// SentientTheme wraps the app: it maps the SDK's Dusk [Colors] (const ARGB
// Longs) onto a Material3 darkColorScheme and exposes the non-Material tokens
// (Space/Radii/TypeScale/Motion) via [LocalTokens]. Dusk is a dark-only palette,
// so there is no light scheme and no dynamic color — the brand surface is fixed.
//
// Color mapping notes:
// - bg → background / surface; bgElev → surfaceContainer; bgSunk → surfaceDim;
//   paper → surfaceVariant.
// - accent (terra) → primary; sage → secondary; amber → tertiary; stop → error.
// - ink → onBackground/onSurface; ink2 → onSurfaceVariant.
// - "on<Accent>" roles use the darkest surface (bgSunk) so accent fills read as
//   light-on-dark consistently; the accentSoft/*-50 tints back the containers.
// ---------------------------------------------------------------------------
package io.sentient.android.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import io.sentient.mobilesdk.design.Colors

/** Convert a packed-ARGB SDK token Long (0xFFRRGGBB) into a Compose [Color]. */
private fun token(argb: Long): Color = Color(argb)

/** Dusk dark color scheme — the single brand scheme (no light variant). */
private val DuskColorScheme = darkColorScheme(
    primary = token(Colors.accent),
    onPrimary = token(Colors.bgSunk),
    primaryContainer = token(Colors.accentSoft),
    onPrimaryContainer = token(Colors.ink),
    secondary = token(Colors.sage),
    onSecondary = token(Colors.bgSunk),
    secondaryContainer = token(Colors.sageSoft),
    onSecondaryContainer = token(Colors.ink),
    tertiary = token(Colors.amber),
    onTertiary = token(Colors.bgSunk),
    tertiaryContainer = token(Colors.accent50),
    onTertiaryContainer = token(Colors.ink),
    background = token(Colors.bg),
    onBackground = token(Colors.ink),
    surface = token(Colors.bg),
    onSurface = token(Colors.ink),
    surfaceVariant = token(Colors.paper),
    onSurfaceVariant = token(Colors.ink2),
    surfaceContainer = token(Colors.bgElev),
    surfaceContainerHigh = token(Colors.bgElev),
    surfaceContainerHighest = token(Colors.paper),
    surfaceContainerLow = token(Colors.bgSunk),
    surfaceContainerLowest = token(Colors.bgSunk),
    surfaceDim = token(Colors.bgSunk),
    surfaceBright = token(Colors.paper),
    outline = token(Colors.line),
    outlineVariant = token(Colors.lineSoft),
    error = token(Colors.stop),
    onError = token(Colors.ink),
    errorContainer = token(Colors.clay),
    onErrorContainer = token(Colors.ink),
)

/**
 * Root theme. Applies the Dusk Material3 [DuskColorScheme] and provides the
 * non-Material [SentientTokens] on [LocalTokens]. Dusk is dark-only — there is
 * no light scheme and no dynamic color, so the theme takes no mode parameter.
 */
@Composable
fun SentientTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalTokens provides SentientTokens()) {
        MaterialTheme(
            colorScheme = DuskColorScheme,
            typography = DuskTypography,
            content = content,
        )
    }
}
