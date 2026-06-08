// ---------------------------------------------------------------------------
// ComposerButtons — reusable icon-button primitives used in the Composer dock.
//
// ComposerToggle — a rounded-square on/off button (mic, TTS, attach). When on:
//   accent glyph + tinted fill + accent border. When off: ink-3 glyph + sunk
//   surface + line border.
//
// ComposerAction — an icon-only action button (send). Tint carries meaning:
//   accent when active, ink-4 when disabled.
//
// These are private to the `chat` package; both are referenced only by
// ButtonRow in Composer.kt. The stop button is rendered inline in ButtonRow
// as a custom tinted-square shape (see Composer.kt).
// ---------------------------------------------------------------------------
package io.sentient.android.chat.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import io.sentient.mobilesdk.design.Colors

internal val BUTTON_SIZE = 38.dp
internal val BUTTON_RADIUS = 8.dp
internal val ICON_SIZE = 20.dp

/** Accent-tint fill / border alpha for the "on" state (≈ webui color-mix 14% / 35%). */
internal const val ON_TINT_ALPHA = 0.14f
internal const val ON_BORDER_ALPHA = 0.4f

/**
 * A composer on/off toggle (mic, TTS, attach) — a rounded-square icon button.
 * Off: ink-3 glyph on the sunk surface with a line border. On: accent glyph +
 * border over an accent-tinted fill. Mirrors the webui icon-btn--mic-on/off + tts variants.
 */
@Composable
internal fun ComposerToggle(
    iconRes: Int,
    on: Boolean,
    contentDescription: String,
    testTag: String,
    onClick: () -> Unit,
) {
    val bg = if (on) Color(Colors.accent).copy(alpha = ON_TINT_ALPHA) else Color(Colors.bgSunk)
    val borderColor = if (on) Color(Colors.accent).copy(alpha = ON_BORDER_ALPHA) else Color(Colors.line)
    val tint = if (on) Color(Colors.accent) else Color(Colors.ink3)
    Box(
        modifier = Modifier
            .size(BUTTON_SIZE)
            .clip(RoundedCornerShape(BUTTON_RADIUS))
            .background(bg)
            .border(1.dp, borderColor, RoundedCornerShape(BUTTON_RADIUS))
            .clickable(onClick = onClick)
            .testTag(testTag),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(iconRes),
            contentDescription = contentDescription,
            tint = tint,
            modifier = Modifier.size(ICON_SIZE),
        )
    }
}

/**
 * A composer action button (send) — icon-only, no toggle box. The tint carries
 * meaning: accent when active, ink-4 when disabled.
 */
@Composable
internal fun ComposerAction(
    iconRes: Int,
    tint: Color,
    contentDescription: String,
    testTag: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
) {
    Box(
        modifier = Modifier
            .size(BUTTON_SIZE)
            .clip(RoundedCornerShape(BUTTON_RADIUS))
            .clickable(enabled = enabled, onClick = onClick)
            .testTag(testTag),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(iconRes),
            contentDescription = contentDescription,
            tint = tint,
            modifier = Modifier.size(ICON_SIZE),
        )
    }
}
