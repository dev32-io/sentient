// ---------------------------------------------------------------------------
// UpdateBanner — the non-blocking optional-update affordance.
//
// Shown as a top in-screen overlay (NOT a route) when the update status is
// Available && !mandatory. Stateless: it takes the version label + plain
// callbacks; the host (AppNavHost) owns when to show it (status + dismissed).
//
// testTags: update-banner (container), update-banner-action ([Update]),
// update-banner-dismiss (✕). Surfaced as resource-ids via the AppNavHost root.
// ---------------------------------------------------------------------------
package io.sentient.android.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private const val AVAILABLE_PREFIX = "Update available — v"
private const val UPDATE_LABEL = "Update"
private const val DISMISS_GLYPH = "✕"

/**
 * Optional-update banner. [versionName] is the available release's display version;
 * [onInstall] hands off to the installer; [onDismiss] hides it (host tracks dismissal).
 */
@Composable
fun UpdateBanner(
    versionName: String,
    onInstall: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Surface(
        modifier = modifier.fillMaxWidth().testTag("update-banner"),
        color = Color(Colors.bgElev),
        contentColor = Color(Colors.ink),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .safeDrawingPadding()
                .padding(horizontal = tokens.space.md, vertical = tokens.space.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        ) {
            Text(
                text = "$AVAILABLE_PREFIX$versionName",
                modifier = Modifier.weight(1f),
                color = Color(Colors.ink),
                fontSize = tokens.type.sm,
            )
            Button(onClick = onInstall, modifier = Modifier.testTag("update-banner-action")) {
                Text(UPDATE_LABEL)
            }
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("update-banner-dismiss")) {
                Text(DISMISS_GLYPH, color = Color(Colors.ink2))
            }
        }
    }
}

@Preview
@Composable
private fun UpdateBannerPreview() {
    SentientTheme {
        UpdateBanner(versionName = "0.2.0", onInstall = {}, onDismiss = {})
    }
}
