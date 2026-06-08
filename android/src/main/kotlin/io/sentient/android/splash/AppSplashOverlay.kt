// ---------------------------------------------------------------------------
// AppSplashOverlay — in-app animated splash overlay, shown after the system
// splash handoff. Plays the SPEAKING Sentient mark with avatar ripple rings
// for a minimum of SPLASH_MIN_MS, then fades out when the backend is ready.
//
// Re-shown whenever the SDK identity changes (backend reconfigure) — the
// shownAtMs clock is reset in AppRoot's LaunchedEffect(sdk).
// ---------------------------------------------------------------------------
package io.sentient.android.splash

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.sentient.android.chat.brand.SentientMark
import io.sentient.android.chat.voice.AvatarRipple
import io.sentient.android.chat.voice.MarkMode
import io.sentient.mobilesdk.design.Colors

/** Diameter of the Sentient mark rendered in the splash overlay. */
private val SPLASH_MARK_SIZE = 96.dp

/**
 * Full-screen animated splash overlay that covers app content while the
 * backend initialises or re-configures. Fades out once [visible] is false.
 *
 * @param visible Drives [AnimatedVisibility]; tied to [splashVisible] in AppRoot.
 * @param modifier Applied to the [AnimatedVisibility] wrapper.
 */
@Composable
fun AppSplashOverlay(visible: Boolean, modifier: Modifier = Modifier) {
    AnimatedVisibility(visible = visible, exit = fadeOut(), modifier = modifier) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(Colors.bg))
                .testTag("app-splash"),
            contentAlignment = Alignment.Center,
        ) {
            Box(contentAlignment = Alignment.Center) {
                AvatarRipple(active = true, modifier = Modifier.size(SPLASH_MARK_SIZE))
                SentientMark(size = SPLASH_MARK_SIZE, mode = MarkMode.SPEAKING)
            }
        }
    }
}
